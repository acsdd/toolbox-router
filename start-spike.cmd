@echo off
setlocal
cd /d "%~dp0"

echo Starting Toolbox Router spike...
call npm run spike -- %*
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo Toolbox Router stopped with exit code %exitCode%.
  pause
)

exit /b %exitCode%
