@echo off
rem Double-click to run agent-overlay. Installs and builds on first use.
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies, this happens once...
  call npm install || goto :fail
)
if not exist "dist\overlay\main.js" (
  echo Building...
  call npm run build || goto :fail
)

start "" ".\node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:fail
echo.
echo Setup failed. Make sure Node 20 or newer is installed and on PATH.
pause
exit /b 1
