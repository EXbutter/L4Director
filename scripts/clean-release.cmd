@echo off
rem Remove electron-builder leftovers, keep the installers in out\.
rem MUST run while WorkBuddy / the dev window is closed: WorkBuddy keeps an
rem exclusive handle on app.asar, and while that handle lives the folder can
rem neither be deleted nor renamed (it is left with a single app.asar inside).
setlocal
set "BASE=%~dp0..\frontend"

for %%D in (.cache .tmp_extract out-dist out-next out-verify out-131 release release-1.1 release-1.1.0 release-v1) do (
  if exist "%BASE%\%%D" (
    echo removing %%D
    rmdir /s /q "%BASE%\%%D" 2>nul
  )
)

if exist "%BASE%\out\win-unpacked" (
  echo removing out\win-unpacked
  rmdir /s /q "%BASE%\out\win-unpacked" 2>nul
)

echo.
echo === installers kept in out ===
dir /b "%BASE%\out\*.exe" 2>nul
echo.
echo If a folder is still listed above as non-empty, quit WorkBuddy completely
echo (tray icon too) and run this script again.
pause
