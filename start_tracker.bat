@echo off
echo.
echo [1/3] Killing old Node.exe processes...
taskkill /F /IM node.exe /T 2>nul
timeout /t 2 /nobreak >nul

echo [2/3] Starting Backend with auto-restart watchdog (Port 3001)...
start /B "" cmd /c "%~dp0server_watchdog.bat > %~dp0server_current.log 2>&1"

echo [3/3] Starting Frontend (Port 5173) in background...
start /B "" cmd /c "cd /d %~dp0client && npx vite --port 5173 --host 127.0.0.1 > nul 2>&1"

echo.
echo Waiting for services to start...
timeout /t 4 /nobreak >nul

echo Opening browser...
start "" "http://127.0.0.1:5173"
