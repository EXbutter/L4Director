@echo off
chcp 65001 >nul
rem Unified launcher: all real logic lives in ld.ps1 (single implementation).
rem Usage:  ld run | ld backend | ld help
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ld.ps1" %*
