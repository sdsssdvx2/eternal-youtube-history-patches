[CmdletBinding()]
param(
    [string]$ExtensionDir = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$TaskName = 'Eternal YouTube History Auto Update'
$UpdaterHome = Join-Path $env:LOCALAPPDATA 'EternalYouTubeHistoryUpdater'

if ([string]::IsNullOrWhiteSpace($ExtensionDir)) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\extension'))
    if (Test-Path -LiteralPath (Join-Path $candidate 'manifest.json')) {
        $ExtensionDir = $candidate
    } else {
        throw 'ExtensionDir is required unless this installer is beside the packaged extension directory.'
    }
}
$ExtensionDir = [System.IO.Path]::GetFullPath($ExtensionDir)
$manifestPath = Join-Path $ExtensionDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "manifest.json not found: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.name -ne 'Eternal YouTube History') { throw 'The selected directory is not Eternal YouTube History.' }

New-Item -ItemType Directory -Path $UpdaterHome -Force | Out-Null
foreach ($name in @('Update-EternalPcExtension.ps1','Install-EternalPcAutoUpdater.ps1','Uninstall-EternalPcAutoUpdater.ps1')) {
    $source = Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $UpdaterHome $name) -Force
    }
}
$updateScript = Join-Path $UpdaterHome 'Update-EternalPcExtension.ps1'
if (-not (Test-Path -LiteralPath $updateScript)) { throw 'Installed updater script is missing.' }

$configPath = Join-Path $UpdaterHome 'config.json'
[pscustomobject]@{
    schema = 1
    extensionDir = $ExtensionDir
    repository = 'sdsssdvx2/eternal-youtube-history-patches'
    installedAt = (Get-Date).ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8

$vbsPath = Join-Path $UpdaterHome 'Run-EternalPcUpdateHidden.vbs'
$escapedScript = $updateScript.Replace('"','""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedScript""", 0, True
"@
Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding ASCII

$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('"{0}"' -f $vbsPath)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$userId = if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) { $env:USERNAME } else { "$env:USERDOMAIN\$env:USERNAME" }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger,$repeatTrigger) -Settings $settings -Principal $principal -Description 'Checks signed GitHub PC releases and updates the existing unpacked Eternal extension directory without touching Chrome profile/storage.' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "PASS: Eternal PC auto-updater installed." -ForegroundColor Green
Write-Host "Extension directory: $ExtensionDir"
Write-Host "Task: $TaskName (at logon + every 6 hours; missed runs start when available)"
Write-Host 'If Chrome is running when an update is found, replacement is safely deferred until a later Chrome-closed check.'
