@echo off
rem Windows Electron launcher. Electron owns the backend process lifetime.
setlocal EnableExtensions

rem This launcher lives in window\. Always run setup and Electron from the
rem project root so relative backend/frontend paths remain valid.
for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"
pushd "%ROOT_DIR%" || exit /b 1
call "%ROOT_DIR%\window\setup.bat"
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
