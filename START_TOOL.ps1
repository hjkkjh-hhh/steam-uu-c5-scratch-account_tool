$host.UI.RawUI.WindowTitle = "Steam_Tracker_Launcher"

# 1. 清理旧实例 (通过 PID 访问 CMD 窗口层级)
$pidPath = "$PSScriptRoot\.tracker.pid"

# 跳过 WMI 查询（避免卡死），直接使用当前 PID 作为标记
$currentCmdPid = $PID

# 读取并清理旧 PID
if (Test-Path $pidPath) {
    $oldPid = Get-Content $pidPath -Raw
    if ($oldPid -match '^\d+$' -and $oldPid -ne $currentCmdPid) {
        try {
            # 使用 taskkill /T /F 彻底清理进程树 (包括 Node/Watchdog/CMD 窗口)
            taskkill /F /PID $oldPid /T 2>$null | Out-Null
            Write-Host "- 已关闭旧的监控窗口及子进程 (PID: $oldPid)。"
            Start-Sleep -Seconds 1
        } catch { }
    }
}

# 写入当前 PID 供下次清理
if ($currentCmdPid) {
    $currentCmdPid | Out-File -FilePath $pidPath -Encoding ASCII -NoNewline
}

# [兜底方案]：通过窗口标题清理
$ErrorActionPreference = 'SilentlyContinue'
Get-Process msedge, chrome, firefox | Where-Object { $_.MainWindowTitle -match 'Steam|localhost:3001|localhost:5173|127.0.0.1:5173' } | Stop-Process -Force
Get-Process | Where-Object { $_.MainWindowTitle -eq "Steam_Tracker_Console" } | Stop-Process -Force
Get-Process node, natapp | Stop-Process -Force
Start-Sleep -Seconds 1

# 2. 辅助服务启动
Start-Process "natapp.exe" -WindowStyle Hidden
Set-Location -Path "$PSScriptRoot\client"
Start-Process "cmd.exe" -ArgumentList "/c npx vite --open --host" -WindowStyle Hidden

# 3. 后端守护进程启动
Set-Location -Path $PSScriptRoot
# Launch the watchdog in the SAME window or a new one?
# The user usually wants a persistent console they can see.
./server_watchdog.ps1
