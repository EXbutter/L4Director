@echo off
chcp 65001 >nul
rem Unified launcher: all real logic lives in ld.ps1 (single implementation).
rem Usage:  ld run | ld backend | ld help
rem 清除宿主注入的 ELECTRON_RUN_AS_NODE，否则 electron 会以 Node 模式运行、前端打不开
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ld.ps1" %*
