@echo off
rem Clean electron-builder leftovers. Must be run while WorkBuddy / the dev window
rem is NOT running, because WorkBuddy keeps an exclusive handle on app.asar.
setlocal
set "BASE=%~dp0..\frontend"

for %%D in (release-build release-tmp release-v1) do (
  if exist "%BASE%\%%D" (
    echo removing %%D
    rmdir /s /q "%BASE%\%%D"
  )
)

if exist "%BASE%\release\win-unpacked" (
  echo removing release\win-unpacked
  rmdir /s /q "%BASE%\release\win-unpacked"
)

echo.
echo === release folder now contains ===
dir /b "%BASE%\release"
echo.
echo If app.asar is still locked, quit WorkBuddy completely (tray icon too) and run again.
pause
