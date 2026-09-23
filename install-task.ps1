# Register logon task that starts the watcher
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $env:USERPROFILE "anaconda3\pythonw.exe"
if (-not (Test-Path $py)) { $py = "pythonw.exe" }
$action = New-ScheduledTaskAction -Execute $py -Argument "`"$root\watch.py`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TopHatWatch" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered TopHatWatch"
