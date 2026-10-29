# FRIDAY - idempotent installed-runtime repair.
#
# Setup calls this after application files have been copied. It is safe on a
# clean install, upgrade, reinstall, or interrupted installation: a healthy
# runtime is reused; only an invalid .venv is rebuilt. Failure is returned to
# NSIS without rolling back the installed app or its uninstaller.

param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [string]$StatusFile = "$env:TEMP\friday-runtime-status.txt"
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$runtimeDir = Join-Path $InstallDir 'runtime'
$venvDir = Join-Path $runtimeDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$requirements = Join-Path $InstallDir 'resources\kernel\requirements.txt'
$pythonHelper = Join-Path $InstallDir 'resources\installer\build\install-python.ps1'
$pythonPathFile = Join-Path $env:TEMP "friday-python-$PID.txt"

function Finish([string]$Status, [int]$Code) {
  Set-Content -LiteralPath $StatusFile -Value $Status -Encoding ASCII
  Remove-Item -LiteralPath $pythonPathFile -Force -ErrorAction SilentlyContinue
  exit $Code
}

function Test-Runtime {
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return $false }
  & $venvPython -c "import sys,sqlite3;assert sys.version_info[:3]>=(3,12,10);import fastapi,uvicorn,httpx,pydantic,yaml;c=sqlite3.connect(':memory:');c.execute('create table t(a)');c.execute('insert into t values(1)');assert c.execute('select a from t').fetchone()[0]==1;c.close()" 2>$null
  return ($LASTEXITCODE -eq 0)
}

# Memory / devices / OCR / Windows control extras. Best-effort: a missing
# wheel must not abort Setup. A healthy core venv is reused, but extras are
# still tried so an upgrade from an older install can fill them.
function Install-CapabilityExtras {
  $capReq = Join-Path $InstallDir 'resources\kernel\requirements-capabilities.txt'
  if (-not (Test-Path -LiteralPath $capReq -PathType Leaf)) { return }
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return }
  $capMethods = @(
    @('--disable-pip-version-check', '--only-binary=:all:', '-r', $capReq),
    @('--disable-pip-version-check', '--prefer-binary', '-r', $capReq),
    @('--disable-pip-version-check', '--prefer-binary', '--no-cache-dir', '-r', $capReq),
    @('--disable-pip-version-check', '--prefer-binary', '--index-url', 'https://pypi.org/simple', '-r', $capReq)
  )
  foreach ($method in $capMethods) {
    & $venvPython -m pip install @method
    if ($LASTEXITCODE -eq 0) { break }
  }
}

if (Test-Runtime) {
  Install-CapabilityExtras
  Finish 'ready' 0
}
if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { Finish 'requirements-missing' 2 }
if (-not (Test-Path -LiteralPath $pythonHelper -PathType Leaf)) { Finish 'python-helper-missing' 3 }

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Remove-Item -LiteralPath $venvDir -Recurse -Force -ErrorAction SilentlyContinue

# The canonical helper first reuses any supported installed CPython and only
# then tries official python.org installers. It returns the verified real path.
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File $pythonHelper -InstallDir $InstallDir -OutFile $pythonPathFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPathFile)) {
  Finish 'python-unavailable' 4
}
$basePython = (Get-Content -LiteralPath $pythonPathFile -Raw).Trim()
if (-not $basePython -or -not (Test-Path -LiteralPath $basePython -PathType Leaf)) {
  Finish 'python-invalid' 5
}

& $basePython -m venv $venvDir
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
  Finish 'venv-failed' 6
}

function Install-Pip {
  & $venvPython -m ensurepip --upgrade
  if ($LASTEXITCODE -eq 0) { return $true }
  $downloads = Join-Path $InstallDir 'temporary\downloads'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $file = Join-Path $downloads 'get-pip.py'
  foreach ($url in @(
      'https://bootstrap.pypa.io/get-pip.py',
      'https://raw.githubusercontent.com/pypa/get-pip/main/public/get-pip.py'
    )) {
    Write-Host "FRIDAY: pip missing - trying $url"
    $got = $false
    try {
      Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing -TimeoutSec 120
      if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 0)) { $got = $true }
    } catch { $got = $false }
    if (-not $got -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
      & curl.exe --fail --location --silent --show-error --retry 3 --output $file $url
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 0)) {
        $got = $true
      }
    }
    if (-not $got) { continue }
    & $venvPython $file
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}

if (-not (Install-Pip)) { Finish 'pip-bootstrap-failed' 7 }

$pipMethods = @(
  @('--disable-pip-version-check', '--only-binary=:all:', '-r', $requirements),
  @('--disable-pip-version-check', '--prefer-binary', '-r', $requirements),
  @('--disable-pip-version-check', '--prefer-binary', '--no-cache-dir', '-r', $requirements),
  @('--disable-pip-version-check', '--prefer-binary', '--index-url', 'https://pypi.org/simple', '-r', $requirements)
)
$installed = $false
foreach ($method in $pipMethods) {
  & $venvPython -m pip install @method
  if ($LASTEXITCODE -eq 0) { $installed = $true; break }
}
if (-not $installed) { Finish 'requirements-failed' 8 }
if (-not (Test-Runtime)) { Finish 'verification-failed' 9 }

Install-CapabilityExtras
Finish 'ready' 0