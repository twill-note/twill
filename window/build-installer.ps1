[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $projectRoot 'frontend'
$backendRoot = Join-Path $projectRoot 'backend'
$venvPython = Join-Path $backendRoot '.venv\Scripts\python.exe'
$backendOutput = Join-Path $frontendRoot 'build\backend'
$env:ELECTRON_BUILDER_CACHE = Join-Path $projectRoot '.build-cache\electron-builder'

Write-Host '[package] Preparing development dependencies...'
& (Join-Path $PSScriptRoot 'setup.bat')
if ($LASTEXITCODE -ne 0) { throw 'Project setup failed.' }

Write-Host '[package] Installing the backend packager...'
& $venvPython -m pip install 'pyinstaller==6.16.0'
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller installation failed.' }

Write-Host '[package] Building the frontend...'
Push-Location $frontendRoot
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally {
    Pop-Location
}

Write-Host '[package] Building the standalone backend...'
if (Test-Path -LiteralPath $backendOutput) {
    Remove-Item -LiteralPath $backendOutput -Recurse -Force
}
& $venvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --name twill-backend `
    --distpath $backendOutput `
    --workpath (Join-Path $backendRoot 'build\pyinstaller') `
    --specpath (Join-Path $backendRoot 'build') `
    --paths $backendRoot `
    --collect-submodules app `
    --add-data "$(Join-Path $projectRoot 'skillbook');skillbook" `
    --add-data "$(Join-Path $backendRoot 'app\system_manual');backend/app/system_manual" `
    (Join-Path $backendRoot 'desktop_main.py')
if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }

Write-Host '[package] Building the Windows installer...'
Push-Location $frontendRoot
try {
    & npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
} finally {
    Pop-Location
}

$installer = Get-ChildItem -LiteralPath (Join-Path $frontendRoot 'release') -Filter 'Twill-Setup-*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $installer) { throw 'The installer was not created.' }
Write-Host "[package] Complete: $($installer.FullName)"
