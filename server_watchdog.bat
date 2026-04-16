@echo off
set NODE_NO_WARNINGS=1
chcp 65001 > nul
:loop
:: Keep the title consistent so START_TOOL.bat can find and kill this window.
title Steam_Tracker_Console
echo [守护进程] 正在启动 Node 服务器...
cd /d %~dp0
node server/index.js
echo.
echo [守护进程] 服务器已退出 (崩溃或重启)。5 秒后尝试重新拉起...
timeout /t 5 /nobreak > nul
goto loop
