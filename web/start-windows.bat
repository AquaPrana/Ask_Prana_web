@echo off
REM Ask Prana website - double-click to run locally (needs Node.js 20.19+ or 22.12+)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing packages, first run only...
  call npm install || (pause & exit /b 1)
)
echo Starting Ask Prana at http://localhost:8081 ...
call npm run dev
pause
