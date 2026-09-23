# Start watcher in background (no console window)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $env:USERPROFILE "anaconda3\pythonw.exe"
if (-not (Test-Path $py)) { $py = "pythonw.exe" }
Start-Process -FilePath $py -ArgumentList "`"$root\watch.py`"" -WorkingDirectory $root -WindowStyle Hidden
