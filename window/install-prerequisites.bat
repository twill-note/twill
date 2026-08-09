@echo off
rem Installs Python and Node.js when they are missing, then records their paths.
setlocal EnableExtensions

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prerequisites.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [error] Prerequisite installation failed. See the message above.
)
exit /b %EXIT_CODE%
