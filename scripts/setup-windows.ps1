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

$Root = Split-Path -Parent $PSScriptRoot
$Versions = Get-Content (Join-Path $Root 'config\toolchain-versions.json') -Raw | ConvertFrom-Json

function Write-Step([string]$Message) {
  Write-Host "[FRIDAY] $Message" -ForegroundColor Cyan
}

function Write-MethodFailure([string]$Label, [string]$Reason) {
  Write-Host "[FRIDAY] method failed: $Label - $Reason" -ForegroundColor Yellow
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
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

function Invoke-OfficialDownload([string]$Url, [string]$FileName) {
  $target = Join-Path (Get-DownloadFolder) $FileName
  if (Test-Path $target) { Remove-Item $target -Force }
  # TLS stays fully enabled; proxy settings are honoured from the system.
  # Two official transports: Windows WebRequest, then curl.exe (Win10+).
  $errors = @()
  try {
    Invoke-WebRequest -Uri $Url -OutFile $target -UseBasicParsing -MaximumRedirection 10
    if ((Test-Path $target) -and ((Get-Item $target).Length -gt 0)) { return $target }
    throw "downloaded file is empty: $Url"
  } catch {
    $errors += "Invoke-WebRequest: $($_.Exception.Message)"
    if (Test-Path $target) { Remove-Item $target -Force }
  }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    try {
      & curl.exe --fail --location --silent --show-error --retry 3 --retry-delay 2 --output $target $Url
      if ($LASTEXITCODE -eq 0 -and (Test-Path $target) -and ((Get-Item $target).Length -gt 0)) {
        return $target
      }
      throw "curl.exe exit $LASTEXITCODE"
    } catch {
      $errors += "curl.exe: $($_.Exception.Message)"
      if (Test-Path $target) { Remove-Item $target -Force }
    }
  }
  $joined = $errors -join '; '
  throw "official download failed for $Url - $joined"
}

function Install-Package([string]$File, [string[]]$SilentArgs) {
  $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
  if ($extension -eq '.msi') {
    $arguments = @('/i', "`"$File`"") + $SilentArgs
    $process = Start-Process 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
  } else {
    $process = Start-Process $File -ArgumentList $SilentArgs -Wait -PassThru
  }
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "installer exited with code $($process.ExitCode)"
  }
}

function Install-WingetPackage([string]$PackageId) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget (App Installer) is not available on this PC'
  }
  & winget install --id $PackageId --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  $code = $LASTEXITCODE
  # 0 = installed, -1978335189 = already newer/installed, -1978335212 = no applicable upgrade
  if ($code -ne 0 -and $code -ne -1978335189 -and $code -ne -1978335212) {
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
      Where-Object { [version]$_ -ge [version]$Versions.pythonMinimum }
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

# ---------------------------------------------------------------- generic ensure
function Ensure-Tool(
  [string]$Label,
  [string]$Command,
  [string[]]$VersionArguments,
  [string]$MinimumVersion,
  [System.Collections.IDictionary[]]$Methods
) {
  $found = Get-Version $Command $VersionArguments
  if (Test-SupportedVersion $found $MinimumVersion) {
    Write-Step "$Label $found is supported (minimum $MinimumVersion) - reused, not modified"
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

Push-Location $Root
try {
  Write-Step 'Preparing the supported FRIDAY Windows toolchain (minimums are floors, newer versions are reused)'

  Ensure-Tool 'Node.js' 'node.exe' @('--version') $Versions.nodeMinimum @(
    @{ Label = 'official winget package (OpenJS.NodeJS.LTS)'; Action = { Install-WingetPackage 'OpenJS.NodeJS.LTS' } },
    @{ Label = 'official nodejs.org MSI download'; Action = { Install-NodeDirect } },
    @{ Label = 'official nodejs.org floor MSI (config/toolchain-versions.json)'; Action = { Install-NodeFloor } }
  )

  Ensure-Tool 'Python' 'py.exe' @('-3', '--version') $Versions.pythonMinimum @(
    @{ Label = 'official winget package (Python.Python.3.13)'; Action = { Install-WingetPackage 'Python.Python.3.13' } },
    @{ Label = 'official winget package (Python.Python.3.12)'; Action = { Install-WingetPackage 'Python.Python.3.12' } },
    @{ Label = 'official python.org installer download'; Action = { Install-PythonDirect } }
  )

  Ensure-Tool 'Git' 'git.exe' @('--version') $Versions.gitMinimum @(
    @{ Label = 'official winget package (Git.Git)'; Action = { Install-WingetPackage 'Git.Git' } },
    @{ Label = 'official Git for Windows release download'; Action = { Install-FromGitHubRelease 'git-for-windows/git' '*64-bit.exe' @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-') } }
  )

  Ensure-Tool 'PowerShell' 'pwsh.exe' @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()') $Versions.powershellMinimum @(
    @{ Label = 'official winget package (Microsoft.PowerShell)'; Action = { Install-WingetPackage 'Microsoft.PowerShell' } },
    @{ Label = 'official PowerShell release MSI download'; Action = { Install-FromGitHubRelease 'PowerShell/PowerShell' '*win-x64.msi' @('/qn', '/norestart') } }
  )

  Ensure-Tool 'npm' 'npm.cmd' @('--version') $Versions.npmMinimum @(
    @{ Label = 'npm bundled with the installed Node.js'; Action = { Refresh-Path } },
    @{ Label = 'official npm registry (npm install -g npm@latest)'; Action = {
        & npm.cmd install --global npm@latest --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm exit code $LASTEXITCODE" }
      } }
  )

  function Ensure-OptionalCommand(
    [string]$Label,
    [string]$Command,
    [System.Collections.IDictionary[]]$Methods
  ) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
      Write-Step "$Label already on PATH - reused, not modified"
      return
    }
    if ($Command -eq 'tesseract.exe' -and (Test-TesseractPresent)) {
      Write-Step "$Label present at a well-known install folder - reused, not modified"
      return
    }
    Write-Step "$Label not found - trying official sources (optional, setup continues if it stays missing)"
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
    Write-Step "$Label remains optional - Install Manager can add it later"
  }

  Ensure-OptionalCommand 'FFmpeg' 'ffmpeg.exe' @(
    @{ Label = 'official winget package (Gyan.FFmpeg)'; Action = { Install-WingetPackage 'Gyan.FFmpeg' } },
    @{ Label = 'official winget package (Gyan.FFmpeg.Essentials)'; Action = { Install-WingetPackage 'Gyan.FFmpeg.Essentials' } }
  )

  Ensure-OptionalCommand 'Tesseract OCR' 'tesseract.exe' @(
    @{ Label = 'official winget package (UB-Mannheim.TesseractOCR)'; Action = { Install-WingetPackage 'UB-Mannheim.TesseractOCR' } },
    @{ Label = 'official UB-Mannheim GitHub installer'; Action = { Install-FromGitHubRelease 'UB-Mannheim/tesseract' '*w64-setup*.exe' @('/S') } }
  )

  $vc = Join-Path $env:SystemRoot 'System32\vcruntime140.dll'
  if (Test-Path -LiteralPath $vc) {
    Write-Step "Visual C++ Redistributable present - reused, not modified"
  } else {
    Write-Step 'Visual C++ Redistributable not detected - trying official sources (optional)'
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
    if (-not $vcInstalled) {
      Write-Step 'Visual C++ Redistributable remains optional - some native model runtimes need it'
    }
  }

  Write-Step 'Installing the exact Node dependency lockfile'
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-MethodFailure 'npm ci' "exit code $LASTEXITCODE - retrying with a clean npm cache"
    & npm.cmd cache verify
    & npm.cmd ci --no-audit --no-fund --registry https://registry.npmjs.org/
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See the output above for the failing package.' }
  }

  Write-Step 'Verifying the Electron binary (multi-method repair only if it is missing)'
  & node.exe scripts\ensure-electron.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Electron binary installation failed after every official method.' }

  Write-Step 'Creating the isolated Python environment and runtime storage'
  & node.exe scripts\setup-python.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
  & node.exe scripts\init-runtime.cjs
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY runtime initialization failed.' }

  Write-Step 'Repairing any incomplete Electron or Python component'
  & node.exe scripts\check-environment.cjs --fix
  if ($LASTEXITCODE -ne 0) { throw 'Automatic component repair could not complete every required component.' }

  Write-Step 'Running final readiness verification'
  & npm.cmd run doctor
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY Doctor did not pass.' }
  Write-Host '[FRIDAY] SETUP PASS - FRIDAY is ready to test, build and run.' -ForegroundColor Green
} finally {
  Pop-Location
}
