@echo off
title CodeCoast website
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Opening https://nodejs.org - install the LTS version, then double-click start.bat again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only, takes a few seconds...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo  CodeCoast is starting at http://localhost:3000
echo  Keep this window open while you use the site. Close it to stop the server.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
