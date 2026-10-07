# FRIDAY - Python provisioning helper used by the Windows installer.
#
# Contract:
#   1. Detect any already installed, REAL, runnable CPython >= the floor
#      (PATH, py launcher, registry, per-user/machine install folders, every
#      user profile). If one exists, print its path and exit 0 WITHOUT
#      downloading or installing anything.
#   2. Only when none exists, install a compatible stable CPython from the
#      official python.org Windows installer, with retry and version fallback,
#      then re-validate by executing python.exe and reading its version.
#
# The resolved interpreter path is written to -OutFile so the installer can
# use it directly even when PATH has not been refreshed in the running session.

param(
  [string]$Floor = "3.12.10",
  [string]$OutFile = "$env:TEMP\friday-python-path.txt",
  [string]$InstallDir = ""
)

$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Test-Floor([string]$version) {
  if (-not $version) { return $false }
  try { return ([version]$version) -ge ([version]$Floor) } catch { return $false }
}

# Runs the candidate and requires a real on-disk sys.executable, so Windows
# App Execution Alias stubs and broken shims can never pass.
function Probe([string]$exe, [string[]]$prefix) {
  if (-not $exe) { return $null }
  $code = "import os,sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))"
  $probeArgs = @()
  if ($prefix) { $probeArgs += $prefix }
  $probeArgs += @("-c", $code)
  try { $out = & $exe @probeArgs 2>$null } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $lines = @($out)
  if ($lines.Count -lt 2) { return $null }
  $executable = $lines[0].Trim()
  $version = $lines[1].Trim()
  if (-not (Test-Path -LiteralPath $executable)) { return $null }
  if (-not (Test-Floor $version)) { return $null }
  return $executable
}

function Registry-Pythons {
  $found = @()
  foreach ($key in @(
      "HKCU:\Software\Python\PythonCore",
      "HKLM:\Software\Python\PythonCore",
      "HKLM:\Software\Wow6432Node\Python\PythonCore")) {
    foreach ($child in (Get-ChildItem -Path $key -ErrorAction SilentlyContinue)) {
      $path = (Get-ItemProperty -Path "$($child.PSPath)\InstallPath" -ErrorAction SilentlyContinue)."(default)"
      if ($path) { $found += (Join-Path $path "python.exe") }
    }
  }
  return $found
}

function Folder-Pythons {
  $roots = @()
  if ($InstallDir) {
    $roots += (Join-Path $InstallDir "runtime\.venv\Scripts")
    $roots += (Join-Path $InstallDir "resources\.venv\Scripts")
  }
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}, "C:\")) {
    if (-not $base) { continue }
    $roots += $base
    $roots += (Join-Path $base "Programs\Python")
  }
  # Other user profiles: an installer running elevated sees a different HKCU.
  $users = Split-Path -Parent $env:USERPROFILE
  foreach ($userDir in (Get-ChildItem -Directory -Path $users -ErrorAction SilentlyContinue)) {
    $roots += (Join-Path $userDir.FullName "AppData\Local\Programs\Python")
  }

  $found = @()
  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $direct = Join-Path $root "python.exe"
    if (Test-Path -LiteralPath $direct) { $found += $direct }
    foreach ($dir in (Get-ChildItem -Directory -Path $root -Filter "Python3*" -ErrorAction SilentlyContinue)) {
      $found += (Join-Path $dir.FullName "python.exe")
    }
  }
  # Newest-looking folders first.
  return ($found | Select-Object -Unique | Sort-Object -Descending)
}

function Find-Python {
  if ($InstallDir) {
    foreach ($venv in @(
        (Join-Path $InstallDir "runtime\.venv\Scripts\python.exe"),
        (Join-Path $InstallDir "resources\.venv\Scripts\python.exe"))) {
      $hit = Probe $venv @()
      if ($hit) { return $hit }
    }
  }
  foreach ($minor in @("-3", "-3.16", "-3.15", "-3.14", "-3.13", "-3.12")) {
    $hit = Probe "py" @($minor)
    if ($hit) { return $hit }
  }
  foreach ($cmd in @("python", "python3")) {
    $hit = Probe $cmd @()
    if ($hit) { return $hit }
  }
  foreach ($exe in (Registry-Pythons)) {
    $hit = Probe $exe @()
    if ($hit) { return $hit }
  }
  foreach ($exe in (Folder-Pythons)) {
    $hit = Probe $exe @()
    if ($hit) { return $hit }
  }
  return $null
}

function Official-Versions {
  # Newest stable python.org releases that satisfy the floor, newest first.
  $versions = @()
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $index = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "https://www.python.org/ftp/python/"
    $versions = ([regex]::Matches($index.Content, 'href="(\d+\.\d+\.\d+)/"') |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { Test-Floor $_ } |
        Sort-Object { [version]$_ } -Descending |
        Select-Object -First 3)
  } catch { $versions = @() }
  # Known-good official builds as a last resort when the index is unreachable.
  foreach ($fallback in @("3.13.7", "3.12.10")) {
    if ((Test-Floor $fallback) -and ($versions -notcontains $fallback)) { $versions += $fallback }
  }
  return $versions
}

function Install-Official([string]$version) {
  $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "win32" }
  $url = "https://www.python.org/ftp/python/$version/python-$version-$arch.exe"
  $file = Join-Path $env:TEMP "friday-python-$version-$arch.exe"
  Write-Host "FRIDAY: downloading official Python $version installer..."
  $downloaded = $false
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri $url -OutFile $file
    if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 0)) {
      $downloaded = $true
    }
  } catch {
    Write-Host "FRIDAY: Invoke-WebRequest failed for $version"
  }
  if (-not $downloaded -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    & curl.exe --fail --location --silent --show-error --retry 3 --retry-delay 2 --output $file $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 0)) {
      $downloaded = $true
    } else {
      Write-Host "FRIDAY: curl.exe failed for $version"
    }
  }
  if (-not $downloaded) {
    Write-Host "FRIDAY: download failed for $version"
    return $false
  }
  Write-Host "FRIDAY: installing Python $version silently..."
  # Per-user install keeps Setup unattended and needs no extra elevation.
  $process = Start-Process -FilePath $file -Wait -PassThru -ArgumentList @(
    "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1",
    "Include_launcher=1", "Include_test=0", "SimpleInstall=1"
  )
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  return ($process -and ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010 -or $process.ExitCode -eq 1638))
}

function Install-WingetPython {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { return $false }
  foreach ($id in @("Python.Python.3.13", "Python.Python.3.12")) {
    Write-Host "FRIDAY: trying winget $id"
    & winget.exe install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    $code = $LASTEXITCODE
    if ($code -eq 0 -or $code -eq -1978335189 -or $code -eq -1978335212 -or $code -eq -1978335135) {
      if (Find-Python) { return $true }
    }
  }
  return $false
}

# ----------------------------------------------------------------- main flow
$existing = Find-Python
if ($existing) {
  Write-Host "FRIDAY: reusing installed Python at $existing"
  Set-Content -LiteralPath $OutFile -Value $existing -Encoding ASCII
  exit 0
}

foreach ($version in (Official-Versions)) {
  foreach ($attempt in 1..2) {
    if (Install-Official $version) {
      $found = Find-Python
      if ($found) {
        Write-Host "FRIDAY: installed Python at $found"
        Set-Content -LiteralPath $OutFile -Value $found -Encoding ASCII
        exit 0
      }
    }
    Start-Sleep -Seconds 2
  }
  # A partially successful install may still have registered an interpreter.
  $found = Find-Python
  if ($found) {
    Set-Content -LiteralPath $OutFile -Value $found -Encoding ASCII
    exit 0
  }
}

Write-Host "FRIDAY: no supported Python could be installed from python.org"
if (Install-WingetPython) {
  $found = Find-Python
  if ($found) {
    Write-Host "FRIDAY: installed Python at $found"
    Set-Content -LiteralPath $OutFile -Value $found -Encoding ASCII
    exit 0
  }
}

Write-Host "FRIDAY: no supported Python could be installed"
exit 1
