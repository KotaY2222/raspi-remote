@echo off
rem === Demo launcher (Windows) ===
rem Double-click to start the app and open it in the browser.
rem It runs on this PC only (127.0.0.1), so no network or firewall setup is needed.
rem Keep this file ASCII-only: cmd.exe misreads Japanese text in batch files.
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3 and run this file again.
  pause
  exit /b 1
)

echo Starting the app. Closing this window stops it.
echo.
python server.py --host 127.0.0.1 --port 8090 --reset --open
echo.
echo The app has stopped.
pause
