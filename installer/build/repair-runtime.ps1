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
# The Setup EXE carries the pinned Windows wheels of kernel\requirements.txt for each Python series it supports
# (scripts/wheelhouse.cjs checks every one against its SHA-256 at build). It is unpacked to a temporary folder only
# when something has to be installed, and that folder is removed when this script ends.
$wheelhousePack = Join-Path $InstallDir 'resources\toolchain\wheelhouse\pack.bin'
$wheelhouseDir = Join-Path $env:TEMP "friday-wheelhouse-$PID"
$script:wheelhouse = $null

# The FRIDAY folder's own environment is the one this script repairs, reuses and, when nothing exists, builds:
# <root>\runtime\.venv, the home the storage contract names. An update and a normal uninstall never touch it, so a
# new version finds a healthy environment and installs in seconds. The program folder <root>\App is replaced by every
# update and its runtime\ folder is removed with it, so an environment built there would be downloaded again, package
# by package, at every update. The program-folder environment is only the fallback when Setup was given a folder
# that is not named App.
if ((Split-Path -Leaf $InstallDir) -ieq 'App') {
  $rootRuntime = Join-Path (Split-Path -Parent $InstallDir) 'runtime'
  $rootVenv = Join-Path $rootRuntime '.venv'
  $runtimeDir = $rootRuntime
  $venvDir = $rootVenv
  $venvPython = Join-Path $rootVenv 'Scripts\python.exe'
}

function Finish([string]$Status, [int]$Code) {
  Set-Content -LiteralPath $StatusFile -Value $Status -Encoding ASCII
  Remove-Item -LiteralPath $pythonPathFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $wheelhouseDir -Recurse -Force -ErrorAction SilentlyContinue
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

# faster-whisper (speech), PyAV (decodes the audio for it) and edge-tts (the online voice) are in requirements.txt.
# Test-Runtime looks at the kernel only, so a healthy runtime from an older install, or one whose voice install
# was cut short, would be called ready without them. They are checked and installed here, once, for that case.
function Test-VoiceCore {
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return $false }
  & $venvPython -c "import faster_whisper, av, edge_tts" 2>$null
  return ($LASTEXITCODE -eq 0)
}

# The unpacked wheelhouse folder, or '' when this EXE carries none or it cannot be read. Never an error.
function Get-Wheelhouse {
  if ($null -ne $script:wheelhouse) { return $script:wheelhouse }
  $script:wheelhouse = ''
  if (-not (Test-Path -LiteralPath $wheelhousePack -PathType Leaf)) { return '' }
  try {
    Remove-Item -LiteralPath $wheelhouseDir -Recurse -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wheelhousePack, $wheelhouseDir)
    if (Test-Path -LiteralPath (Join-Path $wheelhouseDir 'wheelhouse.json') -PathType Leaf) {
      $script:wheelhouse = $wheelhouseDir
    }
  } catch {
    $script:wheelhouse = ''
  }
  return $script:wheelhouse
}

# Offline first: every package from the wheelhouse, with no network at all. When that cannot finish (a wheel this
# EXE does not carry), the wheelhouse is kept and the network fills only what is missing, at the same pinned
# versions. Returns $true or $false and never ends Setup: on $false the caller's network methods run as before.
function Install-FromWheelhouse([string]$Requirements) {
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return $false }
  $tag = & $venvPython -c "import sys;print('cp%d%d' % sys.version_info[:2])" 2>$null | Select-Object -First 1
  $tag = "$tag".Trim()
  if ($tag -notmatch '^cp[0-9]+$') { return $false }
  $house = Get-Wheelhouse
  if (-not $house) { return $false }
  $constraints = Join-Path $house "constraints-$tag.txt"
  if (-not (Test-Path -LiteralPath $constraints -PathType Leaf)) { return $false }
  & $venvPython -m pip install --disable-pip-version-check --no-index --find-links $house -r $Requirements | Out-Host
  if ($LASTEXITCODE -eq 0) { return $true }
  & $venvPython -m pip install --disable-pip-version-check --only-binary=:all: --find-links $house -c $constraints -r $Requirements | Out-Host
  return ($LASTEXITCODE -eq 0)
}

function Install-VoiceCore {
  if (Test-VoiceCore) { return }
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { return }
  if (Install-FromWheelhouse $requirements) { return }
  $voiceMethods = @(
    @('--disable-pip-version-check', '--only-binary=:all:', '-r', $requirements),
    @('--disable-pip-version-check', '--prefer-binary', '-r', $requirements),
    @('--disable-pip-version-check', '--prefer-binary', '--no-cache-dir', '-r', $requirements),
    @('--disable-pip-version-check', '--prefer-binary', '--index-url', 'https://pypi.org/simple', '-r', $requirements)
  )
  foreach ($method in $voiceMethods) {
    & $venvPython -m pip install @method
    if ($LASTEXITCODE -eq 0) { break }
  }
}

# One failed import is not proof that the environment is broken: a virus scanner or the indexer can hold a file for
# a moment. The environment is deleted and downloaded again only when the check fails twice.
function Test-RuntimeTwice {
  if (Test-Runtime) { return $true }
  Start-Sleep -Seconds 3
  return (Test-Runtime)
}

if (Test-RuntimeTwice) {
  Install-VoiceCore
  Install-CapabilityExtras
  if (-not (Test-VoiceCore)) { Finish 'voice-packages-failed' 10 }
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
  & $venvPython -m ensurepip --upgrade | Out-Host
  if ($LASTEXITCODE -eq 0) { return $true }
  $downloads = Join-Path $InstallDir 'temporary\downloads'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $file = Join-Path $downloads 'get-pip.py'
  foreach ($url in @(
      'https://raw.githubusercontent.com/pypa/get-pip/fa4e90301bf000c36309f3ad79c3ac720b55d6df/public/get-pip.py',
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
    & $venvPython $file | Out-Host
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
$installed = Install-FromWheelhouse $requirements
if (-not $installed) {
  foreach ($method in $pipMethods) {
    & $venvPython -m pip install @method
    if ($LASTEXITCODE -eq 0) { $installed = $true; break }
  }
}
if (-not $installed) { Finish 'requirements-failed' 8 }
if (-not (Test-Runtime)) { Finish 'verification-failed' 9 }

Install-CapabilityExtras
if (-not (Test-VoiceCore)) { Finish 'voice-packages-failed' 10 }
Finish 'ready' 0