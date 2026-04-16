$env:NODE_NO_WARNINGS = "1"
while ($true) {
    # Keep the title consistent so it can be managed
    $host.UI.RawUI.WindowTitle = "Steam_Tracker_Console"
    Write-Host "[守护进程] 正在启动 Node 服务器..." -ForegroundColor Cyan
    
    Set-Location -Path $PSScriptRoot
    node server/index.js
    
    Write-Host ""
    Write-Host "[守护进程] 服务器已退出 (崩溃或重启)。5 秒后尝试重新拉起..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
