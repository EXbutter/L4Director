@echo off
chcp 65001 >nul
cd /d "g:\Work\L4D2 Manager\backend"
"g:\Work\L4D2 Manager\.venv\Scripts\python.exe" test_simple_vpk.py
pause
