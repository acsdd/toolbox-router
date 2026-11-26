@echo off
setlocal
set "TOOLBOX_ROUTER_MODE=bridge"
set "TOOLBOX_ROUTER_HOST=127.0.0.1"
set "TOOLBOX_ROUTER_MCP_SOURCE_ROOT=%~dp0mcp"
set "TOOLBOX_ROUTER_DATA_DIR=%~dp0data"
"%~dp0node.exe" "%~dp0router\scripts\launch-spike.mjs" %*
if errorlevel 1 pause
