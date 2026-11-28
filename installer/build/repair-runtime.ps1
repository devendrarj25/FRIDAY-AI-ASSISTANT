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
# (scripts/wheelhouse.cjs checks every one against its SHA-256 at build and packs a hashed requirements file per
# series). It is unpacked only when something has to be installed, into a per-run random folder inside the install's
# own temporary folder, and that folder is removed when this script ends. Only when that folder cannot be made (a
# per-machine install without rights there) the folder is made under the user's own temp folder instead of going
# online. A run's folder carries run.lock from the moment it can be seen (it is made under another name, given its lock
# and only then renamed), and the lock is refreshed every five minutes while pip runs; another run's folder is removed
# only when it has no lock or its lock was last refreshed more than an hour ago, never while it may still be in use.
# The two pin files of each Python series (requirements-<tag>.txt, constraints-<tag>.txt) are read from the pack itself
# and hashed in memory; the unpacked copies must have the same SHA-256 when the unpack ends and again right before each
# pip run, so a file swapped in between is a hash mismatch. Pip's own log goes to a private folder of its own, and what
# pip printed is read as well, so an edited log hides nothing.
$wheelhousePack = Join-Path $InstallDir 'resources\toolchain\wheelhouse\pack.bin'
$wheelhouseTemp = Join-Path $InstallDir 'temporary'
$wheelhouseDir = Join-Path $wheelhouseTemp ('friday-wheelhouse-' + [guid]::NewGuid().ToString('N'))
$script:wheelhouse = $null
# The SHA-256 of each pin file as it is inside the pack (name -> hex), read before anything is unpacked.
$script:wheelhousePins = $null
# The private folder that holds pip's log, made when the first hashed pip run needs it.
$script:pipLogDir = $null
# Set by Install-FromWheelhouse when pip refused a wheel because its SHA-256 differs from the build's lock.
$script:wheelhouseMismatch = $false

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
  if ($script:pipLogDir) { Remove-Item -LiteralPath $script:pipLogDir -Recurse -Force -ErrorAction SilentlyContinue }
  exit $Code
}

function Test-Runtime {
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return $false }
  & $venvPython -c "import sys,sqlite3;assert sys.version_info[:3]>=(3,12,10);import fastapi,uvicorn,httpx,pydantic,yaml;c=sqlite3.connect(':memory:');c.execute('create table t(a)');c.execute('insert into t values(1)');assert c.execute('select a from t').fetchone()[0]==1;c.close()" 2>$null
  return ($LASTEXITCODE -eq 0)
}

# True when pip's own log (pip --log) or what pip printed ($Output, kept in memory by the caller) records a wheel whose
# SHA-256 differs from the hash pinned for it. That is the one failure that is never retried through the network: a
# wheel that does not match its pin is not installed from anywhere else either. The printed text cannot be edited by
# anyone who can reach the log file, so the two together are not defeated by a changed log.
function Test-PipHashMismatch([string]$Log, [string]$Output = '') {
  if ($Output -match 'DO NOT MATCH THE HASHES') { return $true }
  if (-not (Test-Path -LiteralPath $Log -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $Log -Pattern 'DO NOT MATCH THE HASHES' -Quiet)
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

# The SHA-256 (hex) of each pin file inside the pack, read straight from the pack in memory: name -> hash. The pack is
# opened once here, before anything is unpacked.
function Get-PackPins {
  $pins = @{}
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($wheelhousePack)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -notmatch '^(requirements|constraints)-cp[0-9]+\.txt$') { continue }
      $stream = $entry.Open()
      try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $pins[$entry.FullName] = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
      } finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
  return $pins
}

# True when the pin file at $Path has exactly the SHA-256 that the pack has for a file of that name.
function Test-PinFile([string]$Path) {
  $name = Split-Path -Leaf $Path
  if ($null -eq $script:wheelhousePins -or -not $script:wheelhousePins.ContainsKey($name)) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  return ("$actual".ToLowerInvariant() -eq $script:wheelhousePins[$name])
}

# A folder of this run's own for pip's log, away from the unpacked pins and wheels. Only the current user gets access
# where Windows ACLs apply; when the folder cannot be made the log goes next to the pins as before ($Fallback).
function Get-PipLogDir([string]$Fallback = '') {
  if ($script:pipLogDir) { return $script:pipLogDir }
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('friday-piplog-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
  } catch { return $Fallback }
  try {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $dir -AclObject $acl -ErrorAction Stop
  } catch { }
  $script:pipLogDir = $dir
  return $dir
}

# Marks the run's folder as in use now: the sweep of another run keeps a folder whose lock was refreshed in the last hour.
function Update-RunLock([string]$Dir) {
  $lock = Join-Path $Dir 'run.lock'
  try { Set-Content -LiteralPath $lock -Value "$PID" -Encoding ASCII -ErrorAction Stop } catch { }
  try { (Get-Item -LiteralPath $lock -ErrorAction Stop).LastWriteTime = [DateTime]::Now } catch { }
}

# Refreshes run.lock every five minutes in a runspace of its own while a native pip call blocks this one. Returns the
# handle for Stop-LockHeartbeat, or $null when it cannot be started (the lock is then only as fresh as the run's start).
function Start-LockHeartbeat([string]$Lock) {
  try {
    $shell = [powershell]::Create()
    [void]$shell.AddScript({
        param($file)
        while ($true) {
          Start-Sleep -Seconds 300
          try { (Get-Item -LiteralPath $file -ErrorAction Stop).LastWriteTime = [DateTime]::Now } catch { }
        }
      }).AddArgument($Lock)
    $handle = $shell.BeginInvoke()
    return @{ Shell = $shell; Handle = $handle }
  } catch { return $null }
}

function Stop-LockHeartbeat($Beat) {
  if ($null -eq $Beat) { return }
  try { [void]$Beat.Shell.BeginStop($null, $null) } catch { }
}

# The unpacked wheelhouse folder, or '' when this EXE carries none or it cannot be read. Never an error.
function Get-Wheelhouse {
  if ($null -ne $script:wheelhouse) { return $script:wheelhouse }
  $script:wheelhouse = ''
  if (-not (Test-Path -LiteralPath $wheelhousePack -PathType Leaf)) { return '' }
  $stale = (Get-Date).AddHours(-1)
  # The install's own temporary folder first; when it cannot be made, a random folder under the user's temp folder.
  $userTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('friday-wheelhouse-' + [guid]::NewGuid().ToString('N'))
  foreach ($dir in @($wheelhouseDir, $userTemp)) {
    $stage = $null
    try {
      $parent = Split-Path -Parent $dir
      New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop | Out-Null
      # Leftovers of a run that was killed. Another run's folder is left alone while it may still be in use: only a
      # folder without run.lock, or with a lock last refreshed more than an hour ago, is removed.
      Get-ChildItem -LiteralPath $parent -Directory -Filter 'friday-wheelhouse-*' -ErrorAction SilentlyContinue |
        Where-Object {
          $lock = Join-Path $_.FullName 'run.lock'
          -not (Test-Path -LiteralPath $lock -PathType Leaf) -or ((Get-Item -LiteralPath $lock).LastWriteTime -lt $stale)
        } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      # The folder is made under a name the sweep above never matches, given its lock, and renamed to its final name
      # only then: no other run can see it without a lock.
      $stage = Join-Path $parent ('friday-stage-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
      Set-Content -LiteralPath (Join-Path $stage 'run.lock') -Value "$PID" -Encoding ASCII -ErrorAction Stop
      Rename-Item -LiteralPath $stage -NewName (Split-Path -Leaf $dir) -ErrorAction Stop
      $stage = $null
      # Finish removes the folder this run really used.
      $script:wheelhouseDir = $dir
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      # What the pin files must be, taken from the pack itself before it is unpacked.
      $script:wheelhousePins = Get-PackPins
      [System.IO.Compression.ZipFile]::ExtractToDirectory($wheelhousePack, $dir)
      $pinsOk = $true
      foreach ($name in @($script:wheelhousePins.Keys)) {
        if (-not (Test-PinFile (Join-Path $dir $name))) { $pinsOk = $false }
      }
      if ($pinsOk -and (Test-Path -LiteralPath (Join-Path $dir 'wheelhouse.json') -PathType Leaf)) {
        $script:wheelhouse = $dir
        break
      }
      Write-Host "FRIDAY: the unpacked wheelhouse does not match its pack in $dir"
    } catch {
      Write-Host "FRIDAY: the wheelhouse could not be unpacked into $dir"
    }
    if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
  return $script:wheelhouse
}

# Offline first: every package from the wheelhouse, with no network at all. When that cannot finish (a wheel this
# EXE does not carry), the wheelhouse is kept and the network fills only what is missing, at the same pinned
# versions. Both passes install from requirements-<tag>.txt with --require-hashes, so pip refuses a package that is
# not pinned there and any wheel whose SHA-256 differs from the build's lock. A pack without that file is not used.
#
# NETWORK PASS: the second pass can add only what requirements-<tag>.txt lists: wheels only (--only-binary=:all:),
# each at its pinned name==version, each accepted only when its SHA-256 is one of the pinned digests, from pip's default
# index. It can add no other package, no source build and no other version.
# A SHA-256 mismatch, in either pass, ends this path: $script:wheelhouseMismatch is set, nothing else is tried here
# and the caller stops with a status that Setup records as PythonSetupPending. The older unhashed network methods
# stay only for a Setup EXE with no usable pack for this Python (no pack, no files for this series), and for a plain
# failure such as a missing wheel or no network; they are never reached after a mismatch.
# Returns $true or $false and never ends Setup: on $false the caller decides, as above.
function Install-FromWheelhouse([string]$Requirements) {
  $script:wheelhouseMismatch = $false
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { return $false }
  $tag = & $venvPython -c "import sys;print('cp%d%d' % sys.version_info[:2])" 2>$null | Select-Object -First 1
  $tag = "$tag".Trim()
  if ($tag -notmatch '^cp[0-9]+$') { return $false }
  $house = Get-Wheelhouse
  if (-not $house) { return $false }
  $constraints = Join-Path $house "constraints-$tag.txt"
  $hashed = Join-Path $house "requirements-$tag.txt"
  $log = Join-Path (Get-PipLogDir $house) 'pip-wheelhouse.log'
  if (-not (Test-Path -LiteralPath $Requirements -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $constraints -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $hashed -PathType Leaf)) { return $false }
  $beat = Start-LockHeartbeat (Join-Path $house 'run.lock')
  try {
    Update-RunLock $house
    # Both pin files must still be the ones the pack holds, checked right before each pip run: a pin file that was
    # swapped after the unpack is a hash mismatch and ends this path, like a wheel that does not match.
    if (-not ((Test-PinFile $hashed) -and (Test-PinFile $constraints))) {
      $script:wheelhouseMismatch = $true
      return $false
    }
    $pipOut = $null
    & $venvPython -m pip install --disable-pip-version-check --no-index --find-links $house --require-hashes --log $log -r $hashed 2>&1 | Tee-Object -Variable pipOut | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    if (Test-PipHashMismatch $log "$pipOut") { $script:wheelhouseMismatch = $true; return $false }
    if (-not ((Test-PinFile $hashed) -and (Test-PinFile $constraints))) {
      $script:wheelhouseMismatch = $true
      return $false
    }
    $pipOut = $null
    & $venvPython -m pip install --disable-pip-version-check --only-binary=:all: --find-links $house -c $constraints --require-hashes --log $log -r $hashed 2>&1 | Tee-Object -Variable pipOut | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    if (Test-PipHashMismatch $log "$pipOut") { $script:wheelhouseMismatch = $true }
    return $false
  } finally {
    Stop-LockHeartbeat $beat
  }
}

function Install-VoiceCore {
  if (Test-VoiceCore) { return }
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { return }
  if (Install-FromWheelhouse $requirements) { return }
  if ($script:wheelhouseMismatch) { return }
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
  if ($script:wheelhouseMismatch) { Finish 'wheelhouse-hash-mismatch' 11 }
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
if ($script:wheelhouseMismatch) { Finish 'wheelhouse-hash-mismatch' 11 }
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