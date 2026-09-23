# Toggle watcher on/off
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$running = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*tophat-watch*watch.py*" }
if ($running) {
    & "$root\stop.ps1"
    $msg = "Top Hat watcher OFF"
} else {
    & "$root\start.ps1"
    $msg = "Top Hat watcher ON (auto stop in 3 h)"
}
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(3000, "Top Hat", $msg, "Info")
Start-Sleep 4
$n.Dispose()
