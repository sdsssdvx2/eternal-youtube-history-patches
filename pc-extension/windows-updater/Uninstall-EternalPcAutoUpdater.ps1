[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$TaskName = 'Eternal YouTube History Auto Update'
$UpdaterHome = Join-Path $env:LOCALAPPDATA 'EternalYouTubeHistoryUpdater'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Test-Path -LiteralPath $UpdaterHome) {
    Remove-Item -LiteralPath $UpdaterHome -Recurse -Force
}
Write-Host 'PASS: Eternal PC auto-updater removed. The Chrome extension and its profile/storage were not touched.' -ForegroundColor Green
