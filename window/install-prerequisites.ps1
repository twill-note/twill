[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $PSScriptRoot '.bootstrap-env.cmd'

function Write-Step([string]$Message) {
    Write-Host "[prerequisites] $Message"
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Test-Python([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ($Path -like '*\Microsoft\WindowsApps\*') { return $false }
    try {
        $version = & $Path -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $parts = $version.Trim().Split('.')
        return ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)
    } catch { return $false }
}

function Find-Python {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $localPrograms = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $localPrograms) {
        Get-ChildItem -LiteralPath $localPrograms -Filter python.exe -File -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates.Add($_.FullName) }
    }
    Get-Command python.exe -All -ErrorAction SilentlyContinue |
        ForEach-Object { $candidates.Add($_.Source) }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Python $candidate) { return $candidate }
    }
    return $null
}

function Get-NodeInfo {
    try {
        $command = Get-Command node.exe -ErrorAction Stop
        $version = (& $command.Source --version).Trim().TrimStart('v').Split('.')[0]
        if ($LASTEXITCODE -eq 0 -and [int]$version -ge 20) {
            return $command.Source
        }
    } catch {}
    return $null
}

function Require-Winget {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'winget is required to install missing components. Install or update "App Installer" from Microsoft Store, then run this script again.'
    }
}

Refresh-ProcessPath
$python = Find-Python
if (-not $python) {
    Require-Winget
    Write-Step 'Installing Python 3.12 for the current user...'
    & winget.exe install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "Python installation failed (winget exit code $LASTEXITCODE)." }
    Refresh-ProcessPath
    $python = Find-Python
    if (-not $python) { throw 'Python was installed but could not be located. Open a new terminal and run the script again.' }
}
Write-Step "Python: $(& $python --version 2>&1) ($python)"

$node = Get-NodeInfo
if (-not $node) {
    Require-Winget
    Write-Step 'Installing Node.js LTS for the current user...'
    & winget.exe install --exact --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "Node.js installation failed (winget exit code $LASTEXITCODE)." }
    Refresh-ProcessPath
    $node = Get-NodeInfo
    if (-not $node) { throw 'Node.js was installed but could not be located. Open a new terminal and run the script again.' }
}
Write-Step "Node.js: $(& $node --version) ($node)"

$nodeDirectory = Split-Path -Parent $node
$pythonDirectory = Split-Path -Parent $python
$pythonScripts = Join-Path $pythonDirectory 'Scripts'
@(
    '@echo off'
    "set `"TWILL_PYTHON=$python`""
    "set `"PATH=$pythonDirectory;$pythonScripts;$nodeDirectory;%PATH%`""
) | Set-Content -LiteralPath $environmentFile -Encoding Ascii

Write-Step 'All required runtimes are available.'
