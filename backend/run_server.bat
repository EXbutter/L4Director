@echo off
chcp 65001 >nul
echo ===== Starting L4D2 Manager Backend =====
cd /d "g:\Work\L4D2 Manager\backend"
"g:\Work\L4D2 Manager\.venv\Scripts\python.exe" main.py --port 8288
echo.
pause
