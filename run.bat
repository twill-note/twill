@echo off
rem Windows launcher for the note app. Stops both services when either one exits.
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1
call "%CD%\setup.bat"
if errorlevel 1 (
    popd
    exit /b 1
)

if not defined NOTE_APP_HOST set "NOTE_APP_HOST=127.0.0.1"
if not defined NOTE_APP_BACKEND_PORT set "NOTE_APP_BACKEND_PORT=8000"
if not defined NOTE_APP_FRONTEND_PORT set "NOTE_APP_FRONTEND_PORT=5173"
set "NOTE_APP_ROOT=%CD%"

echo.
echo   Twill: http://%NOTE_APP_HOST%:%NOTE_APP_FRONTEND_PORT%
echo   Press Ctrl+C to stop both services.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root = $env:NOTE_APP_ROOT; $backend = Start-Process -FilePath (Join-Path $root 'backend\.venv\Scripts\python.exe') -ArgumentList @('-m','uvicorn','app.main:app','--host',$env:NOTE_APP_HOST,'--port',$env:NOTE_APP_BACKEND_PORT) -WorkingDirectory (Join-Path $root 'backend') -PassThru -NoNewWindow; $frontend = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',('npm run dev -- --host ' + $env:NOTE_APP_HOST + ' --port ' + $env:NOTE_APP_FRONTEND_PORT + ' --strictPort')) -WorkingDirectory (Join-Path $root 'frontend') -PassThru -NoNewWindow; try { while (-not $backend.HasExited -and -not $frontend.HasExited) { Start-Sleep -Milliseconds 250; $backend.Refresh(); $frontend.Refresh() }; if ($backend.HasExited) { exit $backend.ExitCode } else { exit $frontend.ExitCode } } finally { if (-not $backend.HasExited) { Stop-Process -Id $backend.Id -ErrorAction SilentlyContinue }; if (-not $frontend.HasExited) { Stop-Process -Id $frontend.Id -ErrorAction SilentlyContinue } }"
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
