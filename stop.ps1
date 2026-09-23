# Stop watcher and its Chrome
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*tophat-watch*" -and $_.Name -notlike "powershell*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
