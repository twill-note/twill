@echo off
rem Builds a self-contained Windows installer. Run this on a Windows build PC.
setlocal EnableExtensions
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [error] Installer build failed.
exit /b %EXIT_CODE%
