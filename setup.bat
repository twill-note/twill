@echo off
rem Windows development environment setup: Python venv and Node dependencies.
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1

where py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [error] Python 3 was not found. Install Python 3.11+ from python.org and try again.
        popd
        exit /b 1
    )
    set "PYTHON_CMD=python"
)

where node >nul 2>nul
if errorlevel 1 (
    echo [error] Node.js 20+ was not found. Install it from nodejs.org and try again.
    popd
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [error] npm was not found. Reinstall Node.js 20+ and try again.
    popd
    exit /b 1
)

set "VENV_DIR=backend\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_STAMP=%VENV_DIR%\.note-install-stamp"
set "NODE_STAMP=frontend\node_modules\.note-install-stamp"

for /f "delims=" %%V in ('%PYTHON_CMD% --version 2^>^&1') do set "PYTHON_VERSION=%%V"
for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
for /f "delims=" %%V in ('call npm --version') do set "NPM_VERSION=%%V"
for %%F in (backend\requirements.txt) do set "BACKEND_REQUIREMENTS=%%~zF-%%~tF"
for %%F in (frontend\package-lock.json) do set "FRONTEND_LOCK=%%~zF-%%~tF"

set "BACKEND_STAMP=Windows-%PROCESSOR_ARCHITECTURE%-%PYTHON_VERSION%-%BACKEND_REQUIREMENTS%"
set "FRONTEND_STAMP=Windows-%PROCESSOR_ARCHITECTURE%-%NODE_VERSION%-%NPM_VERSION%-%FRONTEND_LOCK%"
set "NEED_BACKEND_SETUP=1"
set "NEED_FRONTEND_SETUP=1"

if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" -c "import fastapi, uvicorn" >nul 2>nul
    if not errorlevel 1 if exist "%VENV_STAMP%" (
        set /p "INSTALLED_BACKEND=" < "%VENV_STAMP%"
        if "%INSTALLED_BACKEND%"=="%BACKEND_STAMP%" set "NEED_BACKEND_SETUP=0"
    )
)

if exist "%NODE_STAMP%" (
    set /p "INSTALLED_FRONTEND=" < "%NODE_STAMP%"
    if "%INSTALLED_FRONTEND%"=="%FRONTEND_STAMP%" set "NEED_FRONTEND_SETUP=0"
)

if "%NEED_BACKEND_SETUP%"=="1" (
    echo [setup] Creating the backend virtual environment and installing packages...
    if exist "%VENV_DIR%" rmdir /s /q "%VENV_DIR%"
    %PYTHON_CMD% -m venv "%VENV_DIR%"
    if errorlevel 1 goto :error
    "%VENV_PYTHON%" -m pip install --requirement backend\requirements.txt
    if errorlevel 1 goto :error
    > "%VENV_STAMP%" echo %BACKEND_STAMP%
) else (
    echo [setup] Backend dependencies are current.
)

if "%NEED_FRONTEND_SETUP%"=="1" (
    echo [setup] Installing frontend packages...
    pushd frontend || goto :error
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
        popd
        goto :error
    )
    popd
    > "%NODE_STAMP%" echo %FRONTEND_STAMP%
) else (
    echo [setup] Frontend dependencies are current.
)

echo [setup] Complete.
popd
exit /b 0

:error
echo [error] Setup failed.
popd
exit /b 1
