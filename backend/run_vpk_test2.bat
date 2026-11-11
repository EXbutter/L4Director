@echo off
chcp 65001 >nul
cd /d "g:\Work\L4D2 Manager\backend"
"g:\Work\L4D2 Manager\.venv\Scripts\python.exe" test_vpk3.py > vpk_debug3.txt 2>&1
type vpk_debug3.txt
pause
