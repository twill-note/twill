@echo off
rem Windows Electron launcher. Electron owns the backend process lifetime.
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1
call "%CD%\setup.bat"
if errorlevel 1 (
    popd
    exit /b 1
)

pushd frontend
call npm run desktop:prepare
if errorlevel 1 (
    popd
    popd
    exit /b 1
)
call npm run desktop
set "EXIT_CODE=%ERRORLEVEL%"
popd
popd
exit /b %EXIT_CODE%
