@echo off
setlocal
"%~dp0node.exe" "%~dp0router\scripts\configure-qoder.mjs" --secure-key --apply
if errorlevel 1 echo Qoder setup did not complete. See the message above.
pause
