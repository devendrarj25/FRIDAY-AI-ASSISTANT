param(
  # Only the PC-level toolchain (Node.js, Python, Git, PowerShell, npm, FFmpeg,
  # Tesseract, the Visual C++ runtime). `npm run doctor` and the build use this to
  # repair the toolchain without repeating the whole setup.
  [switch]$ToolchainOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# FRIDAY - idempotent Windows setup.
#
# Policy: the versions in config/toolchain-versions.json are compatibility
# FLOORS, not installation targets.
#   * installed >= minimum  -> reuse it, never downgrade, never reinstall
#   * missing / too old     -> install the LATEST stable release from the
#                              official source, using multiple official
#                              methods with automatic fallback
# Every method is verified against the real executable and its version, and
# the actual failure reason of each method is printed.
#
# Nothing here is optional. Everything the setup installs is needed, so a tool
# that cannot be installed by any official method stops the setup with the
# reason, instead of leaving a hole that fails later. Run `npm run doctor` to
# repair and check again.

$Root = Split-Path -Parent $PSScriptRoot
$Versions = Get-Content (Join-Path $Root 'config\toolchain-versions.json') -Raw | ConvertFrom-Json

function Write-Step([string]$Message) {
  Write-Host "[FRIDAY] $Message" -ForegroundColor Cyan
}

function Write-MethodFailure([string]$Label, [string]$Reason) {
  Write-Host "[FRIDAY] method failed: $Label - $Reason" -ForegroundColor Yellow
}

function Refresh-Path {
  # Entries already in this session stay (a venv or npm shim put them there); the registry
  # PATH is added, so a tool winget just installed or upgraded is found.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $seen = @{}
  $merged = New-Object System.Collections.Generic.List[string]
  foreach ($part in (("$env:Path;$machine;$user") -split ';')) {
    $dir = $part.Trim().TrimEnd('\', '/')
    if (-not $dir) { continue }
    $key = $dir.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $merged.Add($dir)
  }
  $env:Path = ($merged -join ';')
}

function Test-TesseractPresent {
  if (Get-Command 'tesseract.exe' -ErrorAction SilentlyContinue) { return $true }
  $dirs = @(
    (Join-Path $env:ProgramFiles 'Tesseract-OCR\tesseract.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tesseract-OCR\tesseract.exe')
  )
  foreach ($exe in $dirs) {
    if ($exe -and (Test-Path -LiteralPath $exe)) { return $true }
  }
  return $false
}

function Get-Version([string]$Command, [string[]]$Arguments) {
  try {
    $text = (& $Command @Arguments 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { return $null }
    $match = [regex]::Match($text, '\d+\.\d+\.\d+')
    if ($match.Success) { return $match.Value }
  } catch { return $null }
  return $null
}

function Test-SupportedVersion([string]$Found, [string]$Minimum) {
  if (-not $Found) { return $false }
  try { return ([version]$Found) -ge ([version]$Minimum) } catch { return $false }
}

function Get-DownloadFolder {
  $folder = Join-Path $Root 'temporary\downloads'
  if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
  return $folder
}

function Format-Size([double]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  return ('{0:N0} KB' -f ($Bytes / 1KB))
}

function Write-DownloadDone([string]$Target, [datetime]$Started, [string]$Method) {
  $elapsed = (Get-Date) - $Started
  $seconds = [int][math]::Round($elapsed.TotalSeconds)
  $size = Format-Size ((Get-Item -LiteralPath $Target).Length)
  Write-Step "downloaded $(Split-Path -Leaf $Target) - $size in ${seconds}s via $Method"
}

function Invoke-OfficialDownload([string]$Url, [string]$FileName) {
  $target = Join-Path (Get-DownloadFolder) $FileName
  if (Test-Path $target) { Remove-Item $target -Force }
  Write-Step "downloading $FileName from $Url"
  $started = Get-Date
  # TLS stays fully enabled; proxy settings are honoured from the system.
  # Two official transports: curl.exe (Win10+, draws a live progress bar), then Windows WebRequest.
  $errors = @()
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    try {
      & curl.exe --fail --location --progress-bar --show-error --retry 3 --retry-delay 2 --output $target $Url
      if ($LASTEXITCODE -eq 0 -and (Test-Path $target) -and ((Get-Item $target).Length -gt 0)) {
        Write-DownloadDone $target $started 'curl.exe'
        return $target
      }
      throw "curl.exe exit $LASTEXITCODE"
    } catch {
      $errors += "curl.exe: $($_.Exception.Message)"
      if (Test-Path $target) { Remove-Item $target -Force }
    }
  }
  try {
    Write-Step "downloading $FileName with Invoke-WebRequest (no progress bar, please wait)"
    Invoke-WebRequest -Uri $Url -OutFile $target -UseBasicParsing -MaximumRedirection 10
    if ((Test-Path $target) -and ((Get-Item $target).Length -gt 0)) {
      Write-DownloadDone $target $started 'Invoke-WebRequest'
      return $target
    }
    throw "downloaded file is empty: $Url"
  } catch {
    $errors += "Invoke-WebRequest: $($_.Exception.Message)"
    if (Test-Path $target) { Remove-Item $target -Force }
  }
  $joined = $errors -join '; '
  throw "official download failed for $Url - $joined"
}

function Install-Package([string]$File, [string[]]$SilentArgs) {
  $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
  Write-Step "installing $(Split-Path -Leaf $File) silently - this can take a minute or two, a Windows prompt may appear"
  $installStarted = Get-Date
  if ($extension -eq '.msi') {
    $arguments = @('/i', "`"$File`"") + $SilentArgs
    $process = Start-Process 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
  } else {
    $process = Start-Process $File -ArgumentList $SilentArgs -Wait -PassThru
  }
  $installSeconds = [int][math]::Round(((Get-Date) - $installStarted).TotalSeconds)
  Write-Step "installer finished with exit code $($process.ExitCode) after ${installSeconds}s (0 = done, 3010 = done, restart wanted)"
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "installer exited with code $($process.ExitCode)"
  }
}

function Install-WingetPackage([string]$PackageId) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget (App Installer) is not available on this PC'
  }
  Write-Step "winget install $PackageId (winget prints its own live progress below)"
  & winget install --id $PackageId --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  $code = $LASTEXITCODE
  Write-Step "winget finished for $PackageId with exit code $code (0 = installed, -1978335189 = already installed)"
  # 0 = installed, -1978335189 (0x8A15002B) = already installed, no newer version.
  # -1978335212 (0x8A150014) means winget has no package with this ID: that is a failure, so the next method runs.
  if ($code -eq -1978335212) {
    throw "winget does not know the package '$PackageId' (exit code $code)"
  }
  if ($code -ne 0 -and $code -ne -1978335189) {
    throw "winget exit code $code"
  }
}

# ---------------------------------------------------------------- direct downloads
function Install-NodeDirect {
  $index = $null
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  } catch {
    $listing = Invoke-OfficialDownload 'https://nodejs.org/dist/index.json' 'node-dist-index.json'
    $index = Get-Content -LiteralPath $listing -Raw | ConvertFrom-Json
  }
  $release = $index | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $release) { throw 'nodejs.org did not publish an LTS release entry' }
  $version = $release.version
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $file = Invoke-OfficialDownload "https://nodejs.org/dist/$version/node-$version-$arch.msi" "node-$version-$arch.msi"
  Install-Package $file @('/qn', '/norestart')
}

function Install-NodeFloor {
  $version = $Versions.nodeMinimum
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $file = Invoke-OfficialDownload "https://nodejs.org/dist/v$version/node-v$version-$arch.msi" "node-v$version-$arch.msi"
  Install-Package $file @('/qn', '/norestart')
}

function Install-PythonDirect {
  $candidates = @()
  try {
    $listing = Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/' -UseBasicParsing
    $candidates = [regex]::Matches($listing.Content, 'href="(\d+\.\d+\.\d+)/"') |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object { [version]$_ } -Descending |
      Where-Object { [version]$_ -ge [version]$Versions.pythonMinimum } |
      Where-Object { $v = [version]$_; ([version]('{0}.{1}' -f $v.Major, $v.Minor)) -le [version]$Versions.pythonWheelProven }
  } catch {
    Write-MethodFailure 'python.org FTP listing' $_.Exception.Message
  }
  foreach ($candidate in $candidates) {
    $url = "https://www.python.org/ftp/python/$candidate/python-$candidate-amd64.exe"
    try {
      $file = Invoke-OfficialDownload $url "python-$candidate-amd64.exe"
    } catch { continue }
    Install-Package $file @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0')
    return
  }
  $floor = $Versions.pythonMinimum
  $url = "https://www.python.org/ftp/python/$floor/python-$floor-amd64.exe"
  $file = Invoke-OfficialDownload $url "python-$floor-amd64.exe"
  Install-Package $file @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0')
}

function Install-FromGitHubRelease([string]$Repository, [string]$AssetPattern, [string[]]$SilentArgs) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -UseBasicParsing -Headers @{ 'User-Agent' = 'FRIDAY-Setup' }
  $asset = $release.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
  if (-not $asset) { throw "no official asset matching $AssetPattern in $Repository" }
  $file = Invoke-OfficialDownload $asset.browser_download_url $asset.name
  Install-Package $file $SilentArgs
}

# ---------------------------------------------------------------- newest official release
# A tool that is installed and supported is kept. When its official source has a newer release, it is
# updated: winget's own source for the PC toolchain. The question is asked at most once a day (a stamp in
# .cache), is skipped on hosted CI and offline, and FRIDAY_SETUP_UPDATE=0 turns it off, =1 asks now.
# A newer release that cannot be installed never fails the setup: the installed, supported one stays.
$UpdateStamp = Join-Path $Root '.cache\setup-update-toolchain.stamp'

function Test-UpdateDue {
  if ($env:CI -or $env:GITHUB_ACTIONS) { return $false }
  if ("$env:FRIDAY_OFFLINE".Trim() -eq '1') { return $false }
  $mode = "$env:FRIDAY_SETUP_UPDATE".Trim().ToLowerInvariant()
  if ($mode -eq '0' -or $mode -eq 'off' -or $mode -eq 'false') { return $false }
  if ($mode -eq '1' -or $mode -eq 'force' -or $mode -eq 'true') { return $true }
  if (-not (Test-Path -LiteralPath $UpdateStamp)) { return $true }
  try {
    $age = (Get-Date) - (Get-Item -LiteralPath $UpdateStamp).LastWriteTime
    return (($age.TotalHours -ge 24) -or ($age.TotalHours -lt 0))
  } catch { return $true }
}

function Set-UpdateChecked {
  try {
    $dir = Split-Path -Parent $UpdateStamp
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -LiteralPath $UpdateStamp -Value (Get-Date).ToString('o')
  } catch { }
}

$script:UpdateWanted = Test-UpdateDue

function Update-IfNewer([string]$Label, [string[]]$Ids) {
  if (-not $script:UpdateWanted) { return }
  if (-not $Ids -or $Ids.Count -eq 0) { return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Step "$Label - winget is not available, so the check for a newer release is skipped; the installed version stays"
    return
  }
  foreach ($id in $Ids) {
    Write-Step "$Label - asking the official winget source for a newer release ($id)"
    $code = -1
    try {
      & winget upgrade --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
      $code = $LASTEXITCODE
    } catch { $code = -1 }
    if ($code -eq 0) {
      Refresh-Path
      Write-Step "$Label updated to the latest release ($id)"
      return
    }
    # -1978335189 (0x8A15002B): no applicable update, so this is already the newest release.
    if ($code -eq -1978335189) {
      Write-Step "$Label is already the latest release ($id)"
      return
    }
    # -1978335212 (0x8A150014): winget holds no installed package of this id; the next id is tried.
    if ($code -eq -1978335212) { continue }
    Write-MethodFailure "winget upgrade $id" "exit code $code"
    Write-Step "$Label - the installed version stays"
    return
  }
  Write-Step "$Label - winget does not manage this copy, so it is kept as it is"
}

# Node.js and npm run this very setup, so a running copy is never replaced from here: a newer release is
# named, with the one command that installs it from a new terminal.
function Write-RunningToolNote([string]$Label, [string]$Installed, [string]$Latest, [string]$Command) {
  if (-not $Installed -or -not $Latest) { return }
  try {
    if ([version]$Latest -gt [version]$Installed) {
      Write-Step "$Label $Installed is supported; the newest release is $Latest. It is running now, so it is not replaced from here - in a new terminal run: $Command"
    } else {
      Write-Step "$Label $Installed is the latest release"
    }
  } catch { }
}

function Show-NodeAndNpmLatest {
  if (-not $script:UpdateWanted) { return }
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 20
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    if ($lts) {
      Write-RunningToolNote 'Node.js' (Get-Version 'node.exe' @('--version')) ($lts.version -replace '^v', '') 'winget upgrade OpenJS.NodeJS.LTS'
    }
  } catch { }
  try {
    $newest = ((& npm.cmd view npm version 2>$null | Out-String).Trim())
    if ($newest -match '^\d+\.\d+\.\d+$') {
      Write-RunningToolNote 'npm' (Get-Version 'npm.cmd' @('--version')) $newest 'npm install --global npm@latest'
    }
  } catch { }
}

# ---------------------------------------------------------------- generic ensure
function Ensure-Tool(
  [string]$Label,
  [string]$Command,
  [string[]]$VersionArguments,
  [string]$MinimumVersion,
  [System.Collections.IDictionary[]]$Methods,
  [string[]]$UpdateIds = @()
) {
  $found = Get-Version $Command $VersionArguments
  if (Test-SupportedVersion $found $MinimumVersion) {
    Write-Step "$Label $found is supported (minimum $MinimumVersion) - detected, kept"
    Update-IfNewer $Label $UpdateIds
    return
  }
  if ($found) {
    Write-Step "$Label $found is below the supported minimum $MinimumVersion - installing the latest stable release"
  } else {
    Write-Step "$Label not found - installing the latest stable release from the official source"
  }
  foreach ($method in $Methods) {
    Write-Step "$Label - trying $($method.Label)"
    try {
      & $method.Action
      Refresh-Path
      $verified = Get-Version $Command $VersionArguments
      if (Test-SupportedVersion $verified $MinimumVersion) {
        Write-Step "$Label $verified installed and verified via $($method.Label)"
        return
      }
      Write-MethodFailure $method.Label "verification failed (found '$verified', minimum $MinimumVersion)"
    } catch {
      Write-MethodFailure $method.Label $_.Exception.Message
    }
  }
  throw "$Label could not be installed by any official method. Install it manually from the official source (see INSTALL.md) and run setup again."
}

# A click inside a Windows console turns on text selection (QuickEdit) and freezes the program that is printing
# until a key is pressed, so a setup that downloads for minutes looks stuck. QuickEdit is switched off for the
# length of the setup and the previous console mode is put back at the end. Best effort: no console, no change.
function Disable-ConsoleQuickEdit {
  try {
    if (-not ('FridayConsoleMode' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FridayConsoleMode {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  public static long DisableQuickEdit() {
    IntPtr handle = GetStdHandle(-10);
    uint mode;
    if (!GetConsoleMode(handle, out mode)) return -1;
    uint next = (mode | 0x80u) & ~0x40u;
    if (next == mode) return -1;
    return SetConsoleMode(handle, next) ? (long)mode : -1;
  }
  public static void Restore(long mode) {
    if (mode < 0) return;
    SetConsoleMode(GetStdHandle(-10), (uint)mode);
  }
}
'@
    }
    return [FridayConsoleMode]::DisableQuickEdit()
  } catch {
    return -1
  }
}

function Restore-ConsoleQuickEdit([long]$Mode) {
  try {
    if ($Mode -ge 0 -and ('FridayConsoleMode' -as [type])) { [FridayConsoleMode]::Restore($Mode) }
  } catch {
    # The console mode is a convenience; a failure here changes nothing for the setup.
  }
}

$script:ConsoleModeBefore = Disable-ConsoleQuickEdit
Push-Location $Root
try {
  Refresh-Path
  Write-Step 'Preparing the FRIDAY Windows toolchain: each tool is detected first, kept when supported, and updated when its official source has a newer release'
  if ($script:UpdateWanted) {
    Write-Step 'latest-release check: on (once a day; FRIDAY_SETUP_UPDATE=0 turns it off, FRIDAY_SETUP_UPDATE=1 asks now)'
  } else {
    Write-Step 'latest-release check: off for this run (done within the last day, or FRIDAY_SETUP_UPDATE=0, hosted CI or offline)'
  }

  Ensure-Tool 'Node.js' 'node.exe' @('--version') $Versions.nodeMinimum @(
    @{ Label = 'official winget package (OpenJS.NodeJS.LTS)'; Action = { Install-WingetPackage 'OpenJS.NodeJS.LTS' } },
    @{ Label = 'official nodejs.org MSI download'; Action = { Install-NodeDirect } },
    @{ Label = 'official nodejs.org floor MSI (config/toolchain-versions.json)'; Action = { Install-NodeFloor } }
  )

  # winget names each Python series on its own (Python.Python.3.14), so the installed series decides the id.
  $pythonIds = @()
  $pythonNow = Get-Version 'py.exe' @('-3', '--version')
  if ($pythonNow) {
    $series = $pythonNow.Split('.')
    $pythonIds = @("Python.Python.$($series[0]).$($series[1])")
  }
  Ensure-Tool 'Python' 'py.exe' @('-3', '--version') $Versions.pythonMinimum @(
    @{ Label = 'official winget package (Python.Python.3.13)'; Action = { Install-WingetPackage 'Python.Python.3.13' } },
    @{ Label = 'official winget package (Python.Python.3.12)'; Action = { Install-WingetPackage 'Python.Python.3.12' } },
    @{ Label = 'official python.org installer download'; Action = { Install-PythonDirect } }
  ) $pythonIds

  Ensure-Tool 'Git' 'git.exe' @('--version') $Versions.gitMinimum @(
    @{ Label = 'official winget package (Git.Git)'; Action = { Install-WingetPackage 'Git.Git' } },
    @{ Label = 'official Git for Windows release download'; Action = { Install-FromGitHubRelease 'git-for-windows/git' 'Git-*-64-bit.exe' @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-') } }
  ) @('Git.Git')

  Ensure-Tool 'PowerShell' 'pwsh.exe' @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()') $Versions.powershellMinimum @(
    @{ Label = 'official winget package (Microsoft.PowerShell)'; Action = { Install-WingetPackage 'Microsoft.PowerShell' } },
    @{ Label = 'official PowerShell release MSI download'; Action = { Install-FromGitHubRelease 'PowerShell/PowerShell' '*win-x64.msi' @('/qn', '/norestart') } }
  ) @('Microsoft.PowerShell')

  Ensure-Tool 'npm' 'npm.cmd' @('--version') $Versions.npmMinimum @(
    @{ Label = 'npm bundled with the installed Node.js'; Action = { Refresh-Path } },
    @{ Label = 'official npm registry (npm install -g npm@latest)'; Action = {
        & npm.cmd install --global npm@latest --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm exit code $LASTEXITCODE" }
      } }
  )

  function Ensure-RequiredCommand(
    [string]$Label,
    [string]$Command,
    [System.Collections.IDictionary[]]$Methods,
    [string[]]$UpdateIds = @()
  ) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
      Write-Step "$Label already on PATH - detected, kept"
      Update-IfNewer $Label $UpdateIds
      return
    }
    if ($Command -eq 'tesseract.exe' -and (Test-TesseractPresent)) {
      Write-Step "$Label present at a well-known install folder - detected, kept"
      Update-IfNewer $Label $UpdateIds
      return
    }
    Write-Step "$Label not found - installing the latest stable release from the official source"
    foreach ($method in $Methods) {
      Write-Step "$Label - trying $($method.Label)"
      try {
        & $method.Action
        Refresh-Path
        if (Get-Command $Command -ErrorAction SilentlyContinue) {
          Write-Step "$Label installed and verified via $($method.Label)"
          return
        }
        if ($Command -eq 'tesseract.exe' -and (Test-TesseractPresent)) {
          Write-Step "$Label present at a well-known install folder after $($method.Label)"
          return
        }
        Write-MethodFailure $method.Label 'command still not on PATH'
      } catch {
        Write-MethodFailure $method.Label $_.Exception.Message
      }
    }
    throw "$Label could not be installed by any official method. Install it manually from the official source (see INSTALL.md) and run setup again."
  }

  Ensure-RequiredCommand 'FFmpeg' 'ffmpeg.exe' @(
    @{ Label = 'official winget package (Gyan.FFmpeg)'; Action = { Install-WingetPackage 'Gyan.FFmpeg' } },
    @{ Label = 'official winget package (Gyan.FFmpeg.Essentials)'; Action = { Install-WingetPackage 'Gyan.FFmpeg.Essentials' } }
  ) @('Gyan.FFmpeg', 'Gyan.FFmpeg.Essentials')

  Ensure-RequiredCommand 'Tesseract OCR' 'tesseract.exe' @(
    @{ Label = 'official winget package (UB-Mannheim.TesseractOCR)'; Action = { Install-WingetPackage 'UB-Mannheim.TesseractOCR' } },
    @{ Label = 'official UB-Mannheim GitHub installer'; Action = { Install-FromGitHubRelease 'UB-Mannheim/tesseract' '*w64-setup*.exe' @('/S') } }
  ) @('UB-Mannheim.TesseractOCR')

  $vc = Join-Path $env:SystemRoot 'System32\vcruntime140.dll'
  if (Test-Path -LiteralPath $vc) {
    Write-Step "Visual C++ Redistributable present - reused, not modified"
  } else {
    Write-Step 'Visual C++ Redistributable not detected - installing the latest from the official source'
    $vcInstalled = $false
    try {
      Install-WingetPackage 'Microsoft.VCRedist.2015+.x64'
      $vcInstalled = $true
      Write-Step 'Visual C++ Redistributable winget install finished'
    } catch {
      Write-MethodFailure 'official winget package (Microsoft.VCRedist.2015+.x64)' $_.Exception.Message
    }
    if (-not $vcInstalled) {
      try {
        $vcFile = Invoke-OfficialDownload 'https://aka.ms/vs/17/release/vc_redist.x64.exe' 'vc_redist.x64.exe'
        Install-Package $vcFile @('/install', '/quiet', '/norestart')
        Write-Step 'Visual C++ Redistributable installed from aka.ms/vs/17/release/vc_redist.x64.exe'
        $vcInstalled = $true
      } catch {
        Write-MethodFailure 'official Microsoft VC++ redistributable (aka.ms)' $_.Exception.Message
      }
    }
    if (-not $vcInstalled -or -not (Test-Path -LiteralPath $vc)) {
      throw 'The Visual C++ Redistributable could not be installed by any official method. Native Python wheels and model runtimes need it; install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and run setup again.'
    }
  }

  # Node.js and npm are running this setup: a newer release is named, not swapped under it.
  Show-NodeAndNpmLatest
  if ($script:UpdateWanted) { Set-UpdateChecked }

  if ($ToolchainOnly) {
    Write-Host '[FRIDAY] TOOLCHAIN PASS - Node.js, npm, Python, Git, PowerShell, FFmpeg, Tesseract and the Visual C++ runtime are ready.' -ForegroundColor Green
    return
  }

  Write-Step 'Installing the exact Node dependency lockfile'
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-MethodFailure 'npm ci' "exit code $LASTEXITCODE - npm cache verify, then one retry"
    & npm.cmd cache verify
    & npm.cmd ci --no-audit --no-fund --registry https://registry.npmjs.org/
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See the output above for the failing package.' }
  }

  Write-Step 'Installing the Electron binary when npm ci did not download it'
  & node.exe scripts\ensure-electron.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Electron binary installation failed after every official method.' }

  Write-Step 'Creating the isolated Python environment and runtime storage'
  & node.exe scripts\setup-python.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }

  Write-Step 'Installing the agent tools FRIDAY needs (search, Git, build tools, Go, Rust, Java, WSL 2, Docker, Windows Sandbox, CUDA on an NVIDIA PC); big models and model-only runners come later'
  & node.exe scripts\prefetch-toolkit.cjs
  if ($LASTEXITCODE -ne 0) { throw 'The agent toolkit is not complete (see ACTION REQUIRED above). Fix it, then run npm run doctor.' }
  & node.exe scripts\init-runtime.cjs
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY runtime initialization failed.' }

  Write-Step 'Repairing any incomplete Electron or Python component'
  & node.exe scripts\check-environment.cjs --fix
  if ($LASTEXITCODE -ne 0) { throw 'Automatic component repair could not complete every required component.' }

  Write-Step 'Running final readiness verification'
  & npm.cmd run doctor
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY Doctor did not pass.' }
  Write-Step ("resolved versions - node {0}, npm {1}, python {2}, git {3}, pwsh {4} (floors in config\toolchain-versions.json; newer versions are reused)" -f `
    (Get-Version 'node.exe' @('--version')), `
    (Get-Version 'npm.cmd' @('--version')), `
    (Get-Version 'py.exe' @('-3', '--version')), `
    (Get-Version 'git.exe' @('--version')), `
    (Get-Version 'pwsh.exe' @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()')))
  Write-Host '[FRIDAY] SETUP PASS - FRIDAY is ready to test, build and run.' -ForegroundColor Green
} catch {
  Write-Host "[FRIDAY] SETUP FAIL - $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Restore-ConsoleQuickEdit $script:ConsoleModeBefore
  Pop-Location
}
