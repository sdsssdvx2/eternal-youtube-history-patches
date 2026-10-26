[CmdletBinding()]
param(
    [string]$ExtensionDir = '',
    [string]$ConfigPath = '',
    [string]$ReleaseMetadataFile = '',
    [string]$AssetOverridePath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Repo = 'sdsssdvx2/eternal-youtube-history-patches'
$UpdaterHome = Join-Path $env:LOCALAPPDATA 'EternalYouTubeHistoryUpdater'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $UpdaterHome 'config.json'
} else {
    $UpdaterHome = Split-Path -Parent $ConfigPath
}
if (-not (Test-Path -LiteralPath $UpdaterHome)) {
    New-Item -ItemType Directory -Path $UpdaterHome -Force | Out-Null
}

$LogPath = Join-Path $UpdaterHome 'update.log'
$StatePath = Join-Path $UpdaterHome 'state.json'
$LockPath = Join-Path $UpdaterHome 'update.lock'

function Write-UpdateLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Read-ManifestVersion {
    param([string]$Dir)
    $manifest = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw "Eternal extension manifest not found: $manifest"
    }
    $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $name = [string]$json.name
    if ($name -ne 'Eternal YouTube History') {
        throw "Unexpected extension manifest name: $name"
    }
    $text = [string]$json.version
    try { return [version]$text } catch { throw "Invalid extension version: $text" }
}

function Mirror-Directory {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }
    & robocopy.exe $Source $Destination /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -gt 7) {
        throw "robocopy failed with exit code $code"
    }
}

function Get-PcRelease {
    param([object[]]$Releases)
    $candidates = @()
    foreach ($release in @($Releases)) {
        if ($null -eq $release) { continue }
        if ([bool]$release.draft -or [bool]$release.prerelease) { continue }
        $tag = [string]$release.tag_name
        if ($tag -notmatch '^pc-v([0-9]+\.[0-9]+\.[0-9]+)$') { continue }
        $candidates += [pscustomobject]@{
            Version = [version]$Matches[1]
            Release = $release
        }
    }
    $selected = $candidates | Sort-Object -Property Version -Descending | Select-Object -First 1
    if ($null -eq $selected) { throw 'No stable pc-vX.Y.Z release was found.' }
    return $selected
}

$lockStream = $null
$tempRoot = $null
try {
    try {
        $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        return
    }

    if ([string]::IsNullOrWhiteSpace($ExtensionDir)) {
        if (-not (Test-Path -LiteralPath $ConfigPath)) {
            throw "Updater config not found: $ConfigPath"
        }
        $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $ExtensionDir = [string]$config.extensionDir
    }
    if ([string]::IsNullOrWhiteSpace($ExtensionDir)) { throw 'Extension directory is not configured.' }
    $ExtensionDir = [System.IO.Path]::GetFullPath($ExtensionDir)
    $currentVersion = Read-ManifestVersion -Dir $ExtensionDir

    if (-not [string]::IsNullOrWhiteSpace($ReleaseMetadataFile)) {
        $releases = @(Get-Content -LiteralPath $ReleaseMetadataFile -Raw -Encoding UTF8 | ConvertFrom-Json)
    } else {
        $uri = "https://api.github.com/repos/$Repo/releases?per_page=30"
        $headers = @{
            'Accept' = 'application/vnd.github+json'
            'User-Agent' = 'eternal-youtube-history-pc-updater/1.0'
            'X-GitHub-Api-Version' = '2022-11-28'
        }
        $releases = @(Invoke-RestMethod -UseBasicParsing -Uri $uri -Headers $headers -Method Get)
    }

    $selected = Get-PcRelease -Releases $releases
    $remoteVersion = [version]$selected.Version
    if ($remoteVersion -le $currentVersion) {
        Write-UpdateLog "No update: installed=$currentVersion latest=$remoteVersion"
        return
    }

    # Never live-replace unpacked extension files while Chrome is using them. This avoids
    # a mixed runtime where old background code and new content scripts coexist. The task
    # retries at logon and every six hours, so the update is applied during a Chrome-closed window.
    if (@(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count -gt 0) {
        [pscustomobject]@{
            installedVersion = $currentVersion.ToString()
            pendingVersion = $remoteVersion.ToString()
            deferredAt = (Get-Date).ToString('o')
            reason = 'chrome-running'
            extensionDir = $ExtensionDir
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8
        Write-UpdateLog "Update $currentVersion -> $remoteVersion deferred because Chrome is running."
        return
    }

    $assetName = 'eternal-youtube-history-pc-v{0}.zip' -f $remoteVersion.ToString()
    $asset = @($selected.Release.assets | Where-Object { [string]$_.name -eq $assetName }) | Select-Object -First 1
    if ($null -eq $asset) { throw "Release asset missing: $assetName" }
    $digest = [string]$asset.digest
    if ($digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
        throw "Release asset has no trusted SHA-256 digest: $assetName"
    }
    $expectedSha = $Matches[1].ToLowerInvariant()

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('eternal-pc-update-' + [guid]::NewGuid().ToString('N'))
    $extractDir = Join-Path $tempRoot 'extract'
    $zipPath = Join-Path $tempRoot $assetName
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    if (-not [string]::IsNullOrWhiteSpace($AssetOverridePath)) {
        Copy-Item -LiteralPath $AssetOverridePath -Destination $zipPath -Force
    } else {
        $downloadUrl = [string]$asset.browser_download_url
        if ($downloadUrl -notmatch '^https://github\.com/') {
            throw 'Release asset URL is not a trusted GitHub HTTPS URL.'
        }
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath -Headers @{ 'User-Agent' = 'eternal-youtube-history-pc-updater/1.0' }
    }

    $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $expectedSha) {
        throw "Release ZIP SHA-256 mismatch. expected=$expectedSha actual=$actualSha"
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $releaseRoot = Join-Path $extractDir ('eternal-youtube-history-v' + $remoteVersion.ToString())
    $sourceExtension = Join-Path $releaseRoot 'extension'
    if (-not (Test-Path -LiteralPath $sourceExtension)) {
        throw "Release ZIP does not contain the expected extension directory: $sourceExtension"
    }
    $stagedVersion = Read-ManifestVersion -Dir $sourceExtension
    if ($stagedVersion -ne $remoteVersion) {
        throw "Release tag/manifest mismatch: tag=$remoteVersion manifest=$stagedVersion"
    }

    $backupRoot = Join-Path $UpdaterHome 'backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backupDir = Join-Path $backupRoot ('v{0}-{1}' -f $currentVersion.ToString(), (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Mirror-Directory -Source $ExtensionDir -Destination $backupDir

    $updated = $false
    try {
        Mirror-Directory -Source $sourceExtension -Destination $ExtensionDir
        $installedVersion = Read-ManifestVersion -Dir $ExtensionDir
        if ($installedVersion -ne $remoteVersion) {
            throw "Post-copy manifest verification failed: expected=$remoteVersion actual=$installedVersion"
        }
        $updated = $true
    } finally {
        if (-not $updated) {
            Write-UpdateLog "Update failed; restoring backup $backupDir"
            Mirror-Directory -Source $backupDir -Destination $ExtensionDir
        }
    }

    $sourceUpdater = Join-Path $releaseRoot 'windows-updater'
    if (Test-Path -LiteralPath $sourceUpdater) {
        foreach ($name in @('Update-EternalPcExtension.ps1','Install-EternalPcAutoUpdater.ps1','Uninstall-EternalPcAutoUpdater.ps1')) {
            $source = Join-Path $sourceUpdater $name
            if (Test-Path -LiteralPath $source) {
                Copy-Item -LiteralPath $source -Destination (Join-Path $UpdaterHome $name) -Force
            }
        }
    }

    $oldBackups = @(Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object LastWriteTime -Descending)
    if ($oldBackups.Count -gt 3) {
        $oldBackups | Select-Object -Skip 3 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }

    $chromeRunning = $false
    [pscustomobject]@{
        installedVersion = $remoteVersion.ToString()
        previousVersion = $currentVersion.ToString()
        updatedAt = (Get-Date).ToString('o')
        extensionDir = $ExtensionDir
        chromeRunningAtUpdate = $chromeRunning
        appliesOnNextChromeRestart = $chromeRunning
        sha256 = $actualSha
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8

    Write-UpdateLog "Updated extension $currentVersion -> $remoteVersion; chromeRunning=$chromeRunning; sha256=$actualSha"
} catch {
    try { Write-UpdateLog ('ERROR ' + $_.Exception.Message) } catch { }
    throw
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    if ($null -ne $tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
