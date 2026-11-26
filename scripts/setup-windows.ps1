param(
  # Only the PC-level toolchain (Node.js, Python, Git, PowerShell, npm, FFmpeg,
  # Tesseract, the Visual C++ runtime). `npm run doctor` and the build use this to
  # repair the toolchain without repeating the whole setup.
  [switch]$ToolchainOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 on an older .NET offers only TLS 1.0/1.1 by default, which nodejs.org, python.org and
# GitHub refuse. TLS 1.2 (and 1.3 where this .NET has it) is added; nothing the system already allows is removed.
try {
  $tls12 = [Net.ServicePointManager]::SecurityProtocol -bor 3072
  try { [Net.ServicePointManager]::SecurityProtocol = $tls12 -bor 12288 } catch { [Net.ServicePointManager]::SecurityProtocol = $tls12 }
} catch { }
# npm redraws a spinner on a console, which blinks; pip prints one summary line instead of a line per package.
if (-not $env:npm_config_progress) { $env:npm_config_progress = 'false' }
if (-not $env:PIP_PROGRESS_BAR) { $env:PIP_PROGRESS_BAR = 'off' }
# Only npm's errors are printed: its deprecation notices name packages inside electron-builder that FRIDAY cannot change.
if (-not $env:npm_config_loglevel) { $env:npm_config_loglevel = 'error' }

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

# A real console gets colour, solid bars and the live line of scripts\live-console.cjs; a log file, CI or NO_COLOR gets
# the same words in plain text.
function Test-LiveConsole {
  if ([Console]::IsOutputRedirected) { return $false }
  if ($env:NO_COLOR -or $env:FRIDAY_ACTIVITY -eq '0' -or $env:TERM -eq 'dumb') { return $false }
  return $true
}

# The head of one of the nine stages of setup: its number, a solid bar of how far setup is, and its name.
$script:StageTotal = 9
function Write-Stage([int]$Number, [string]$Name) {
  # The build runs the toolchain step alone (-ToolchainOnly) and numbers its own phases: no "Step 1 of 9" there.
  if ($ToolchainOnly) { return }
  $cells = 24
  $lit = [int][math]::Round($cells * $Number / $script:StageTotal)
  $percent = [int][math]::Round(100 * $Number / $script:StageTotal)
  Write-Host ''
  if (Test-LiveConsole) {
    # A small rectangle (U+25AC): thicker than a line, far thinner than a full block, which merged two bars into one slab.
    $block = [string][char]0x25AC
    Write-Host ('[FRIDAY] Step {0} of {1} ' -f $Number, $script:StageTotal) -NoNewline -ForegroundColor White
    Write-Host ($block * $lit) -NoNewline -ForegroundColor Green
    Write-Host ($block * ($cells - $lit)) -NoNewline -ForegroundColor DarkGray
    Write-Host (' {0,3}%  ' -f $percent) -NoNewline -ForegroundColor White
    Write-Host $Name -ForegroundColor Cyan
  } else {
    Write-Host ('[FRIDAY] Step {0} of {1} [{2}{3}] {4}%  {5}' -f $Number, $script:StageTotal, ('#' * $lit), ('-' * ($cells - $lit)), $percent, $Name)
  }
}

function Write-MethodFailure([string]$Label, [string]$Reason) {
  Write-Host "[FRIDAY] method failed: $Label - $Reason" -ForegroundColor Yellow
}

# Things setup could not finish by itself (a newer Node.js that is running this very setup, a tool whose update
# did not take effect). They are collected and repeated in one block at the very end, where they are not lost
# in the middle of a long log.
$script:FollowUps = New-Object System.Collections.Generic.List[string]
function Add-FollowUp([string]$Text) { $script:FollowUps.Add($Text) | Out-Null }
function Write-FollowUps {
  if ($script:FollowUps.Count -eq 0) { return }
  Write-Host ''
  Write-Host '[FRIDAY] Still to do by hand (setup passed; these only make a tool newer):' -ForegroundColor Yellow
  foreach ($line in $script:FollowUps) { Write-Host "[FRIDAY]   - $line" -ForegroundColor Yellow }
}

# A FRIDAY_PYTHON left from an older install that points at a file that is gone is removed from the user's own
# environment (and from this session), so it stops being reported on every run. A machine-wide one needs
# administrator rights and is only named.
function Clear-StaleFridayPython {
  $value = [Environment]::GetEnvironmentVariable('FRIDAY_PYTHON', 'User')
  if ($value -and -not (Test-Path -LiteralPath $value)) {
    try {
      [Environment]::SetEnvironmentVariable('FRIDAY_PYTHON', $null, 'User')
      Remove-Item Env:FRIDAY_PYTHON -ErrorAction SilentlyContinue
      Write-Step "FRIDAY_PYTHON pointed at $value, which does not exist: removed it from your user environment"
    } catch {
      Add-FollowUp "FRIDAY_PYTHON points at $value, which does not exist. Remove it: Settings, System, About, Advanced system settings, Environment Variables."
    }
  }
  $machine = [Environment]::GetEnvironmentVariable('FRIDAY_PYTHON', 'Machine')
  if ($machine -and -not (Test-Path -LiteralPath $machine)) {
    Add-FollowUp "A machine-wide FRIDAY_PYTHON points at $machine, which does not exist. Remove it from the system environment variables (administrator)."
  }
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
      # -C - resumes the partial file after a dropped connection instead of starting over.
      & curl.exe --fail --location --progress-bar --show-error --connect-timeout 30 --retry 5 --retry-delay 2 -C - --output $target $Url
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

# A directly downloaded installer runs with the owner's rights, so it must prove itself first, and the check fails
# closed (winget verifies its own manifests and never comes here). The file runs only when one of these holds: its
# SHA-256 is the pinned value in config\toolchain-versions.json (installerPins), or it carries a Valid Authenticode
# signature whose signer is the expected publisher, or its SHA-256 was just matched to the list or sidecar the
# vendor published beside it ($ChecksumVerified). A corrupt or altered file (HashMismatch, a pin that does not
# match) is deleted; anything else is deleted and refused, so the next method runs.
function Get-InstallerPin([string]$FileName) {
  $pins = $Versions.installerPins
  if (-not $pins) { return '' }
  $entry = $pins.PSObject.Properties | Where-Object { $_.Name -eq $FileName } | Select-Object -First 1
  if (-not $entry) { return '' }
  return "$($entry.Value)".Trim().ToLowerInvariant()
}

function Assert-InstallerSignature([string]$File, [string[]]$Publishers = @(), [bool]$ChecksumVerified = $false) {
  $name = Split-Path -Leaf $File
  $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
  if ($extension -ne '.exe' -and $extension -ne '.msi') { return }
  $pin = Get-InstallerPin $name
  if ($pin) {
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $pin) {
      Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
      throw "SHA-256 mismatch for $name against the pinned value in config\toolchain-versions.json: expected $pin, got $actual (file deleted)"
    }
    Write-Step "SHA-256 matches the pinned value for $name"
    $ChecksumVerified = $true
  }
  $status = 'Unknown'
  $subject = ''
  if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
    try {
      $signature = Get-AuthenticodeSignature -LiteralPath $File
      $status = "$($signature.Status)"
      if ($signature.SignerCertificate) { $subject = $signature.SignerCertificate.GetNameInfo('SimpleName', $false) }
    } catch { $status = 'Unknown' }
  }
  if ($status -eq 'HashMismatch') {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    throw "the downloaded file failed its signature check (HashMismatch: corrupt or altered) and was deleted: $name"
  }
  if ($status -eq 'Valid') {
    foreach ($publisher in $Publishers) {
      if ($publisher -and $subject -like "*$publisher*") {
        Write-Step "publisher signature verified for ${name}: $subject"
        return
      }
    }
  }
  if ($ChecksumVerified) {
    Write-Step "SHA-256 verified for $name (signature status $status, signer '$subject') - accepted"
    return
  }
  Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
  throw "$name has no pinned or published SHA-256 and no valid signature from the expected publisher ($($Publishers -join ', ')); signature status $status, signer '$subject'. It was deleted and not run"
}

# An installer run silently prints nothing for a minute or two. On a console a moving line (a spinner, the name and
# the time) shows the window is alive; in a log file the wait is plain. The exit code stays in $Process.ExitCode.
function Wait-InstallerProcess($Process, [string]$Label) {
  $null = $Process.Handle
  if (-not (Test-LiveConsole)) { $Process.WaitForExit(); return }
  $braille = [bool]($env:WT_SESSION -or $env:TERM_PROGRAM -or ($env:ConEmuANSI -eq 'ON'))
  $frames = if ($braille) { [char[]](0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F) } else { [char[]]'|/-\' }
  $started = Get-Date
  $tick = 0
  while (-not $Process.HasExited) {
    $seconds = [int][math]::Floor(((Get-Date) - $started).TotalSeconds)
    $clock = if ($seconds -ge 60) { '{0}m{1:00}s' -f [math]::Floor($seconds / 60), ($seconds % 60) } else { "${seconds}s" }
    Write-Host ("`r{0} {1} - {2}   " -f $frames[$tick % $frames.Count], $Label, $clock) -NoNewline -ForegroundColor Cyan
    $tick++
    Start-Sleep -Milliseconds 120
  }
  $Process.WaitForExit()
  Write-Host ("`r" + (' ' * 78) + "`r") -NoNewline
}

function Install-Package([string]$File, [string[]]$SilentArgs, [string[]]$Publishers = @(), [bool]$ChecksumVerified = $false) {
  $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
  Assert-InstallerSignature $File $Publishers $ChecksumVerified
  Write-Step "installing $(Split-Path -Leaf $File) silently - this can take a minute or two, a Windows prompt may appear"
  $installStarted = Get-Date
  if ($extension -eq '.msi') {
    $arguments = @('/i', "`"$File`"") + $SilentArgs
    $process = Start-Process 'msiexec.exe' -ArgumentList $arguments -PassThru
  } else {
    $process = Start-Process $File -ArgumentList $SilentArgs -PassThru
  }
  Wait-InstallerProcess $process "installing $(Split-Path -Leaf $File)"
  $installSeconds = [int][math]::Round(((Get-Date) - $installStarted).TotalSeconds)
  Write-Step "installer finished with exit code $($process.ExitCode) after ${installSeconds}s (0 = done, 3010 = done, restart wanted)"
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "installer exited with code $($process.ExitCode)"
  }
}

# winget redraws one progress line with a carriage return and prints spinner frames; read live in a console
# that is a blinking bar, in a pipe it is dozens of lines. This keeps the readable lines (what it found,
# downloads, installs, the result), drops the frames, prints a repeat once, and leaves the exit code in
# $LASTEXITCODE. (Pattern is ASCII: \u2588-\u2591 are the block characters of the bar.)
$script:WingetNoise = '^[\s\-\\|/]*$|[\u2588\u2592\u2593\u2591]|^\s*[\d.]+\s*[KMG]?i?B\s*/\s*[\d.]+\s*[KMG]?i?B\s*$|^\s*\d{1,3}%\s*$|^(No available upgrade found\.|No newer package versions are available from the configured sources\.|This application is licensed to you by its owner\.|Microsoft is not responsible for, nor does it grant any licenses to, third-party packages\.)$'
function Invoke-WingetQuiet([string[]]$WingetArgs, [string]$Label = 'winget') {
  $script:WingetLast = ''
  # On a real console winget runs under the live line (a spinner, the time and the share it reports), so a long
  # "Starting package install..." never looks like a stuck window. Node.js is not there yet on a fresh PC: then, and
  # in a log file, the filter below prints the same lines without it.
  $hostScript = Join-Path $PSScriptRoot 'live-console.cjs'
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand -and (Test-Path -LiteralPath $hostScript) -and (Test-LiveConsole)) {
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $nodeCommand.Source $hostScript --label $Label --tidy --ok '-1978335189' -- winget.exe @WingetArgs
    } finally { $ErrorActionPreference = $before }
    return
  }
  # Windows PowerShell 5.1 turns a line on stderr into a terminating error under 'Stop'; winget's text is not one.
  $before = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & winget @WingetArgs 2>&1 | ForEach-Object {
      $text = ("$_" -replace '\x1b\[[0-9;?]*[A-Za-z]', '').Trim()
      if ($text -and ($text -notmatch $script:WingetNoise) -and ($text -ne $script:WingetLast)) {
        Write-Host $text
        $script:WingetLast = $text
      }
    }
  } finally { $ErrorActionPreference = $before }
}

function Install-WingetPackage([string]$PackageId) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget (App Installer) is not available on this PC'
  }
  Write-Step "winget install $PackageId (its readable lines below; progress frames are dropped)"
  Invoke-WingetQuiet @('install', '--id', $PackageId, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') "winget install $PackageId"
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
# nodejs.org publishes SHASUMS256.txt beside every release. The MSI is checked against it; a file that does not
# match is deleted and the method fails (the next method runs). It returns $true when the file matched the list; when
# the list cannot be read or has no line for the file it returns $false, and Install-Package then needs a Valid
# signature from the OpenJS Foundation (fail closed).
function Assert-NodeChecksum([string]$Version, [string]$File) {
  $name = Split-Path -Leaf $File
  try {
    $text = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$Version/SHASUMS256.txt" -UseBasicParsing).Content
    if ($text -is [byte[]]) { $text = [Text.Encoding]::ASCII.GetString($text) }
  } catch {
    Write-Step "Node.js checksum list could not be read ($($_.Exception.Message)) - the publisher signature must then be valid"
    return $false
  }
  $match = [regex]::Match("$text", "(?im)^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))\s*$")
  if (-not $match.Success) { return $false }
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $match.Groups[1].Value.ToLowerInvariant()) {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    throw "SHA-256 mismatch for $name (file deleted)"
  }
  Write-Step "SHA-256 verified for $name"
  return $true
}

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
  $verified = Assert-NodeChecksum $version $file
  Install-Package $file @('/qn', '/norestart') @('OpenJS Foundation') $verified
}

function Install-NodeFloor {
  $version = $Versions.nodeMinimum
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $file = Invoke-OfficialDownload "https://nodejs.org/dist/v$version/node-v$version-$arch.msi" "node-v$version-$arch.msi"
  $verified = Assert-NodeChecksum "v$version" $file
  Install-Package $file @('/qn', '/norestart') @('OpenJS Foundation') $verified
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
    Install-Package $file @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0') @('Python Software Foundation')
    return
  }
  $floor = $Versions.pythonMinimum
  $url = "https://www.python.org/ftp/python/$floor/python-$floor-amd64.exe"
  $file = Invoke-OfficialDownload $url "python-$floor-amd64.exe"
  Install-Package $file @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0') @('Python Software Foundation')
}

# The unauthenticated GitHub API allows 60 requests an hour per address, which a shared office network can
# spend; a GITHUB_TOKEN in the environment lifts that, and a transient failure is retried before giving up.
function Get-GitHubLatestRelease([string]$Repository) {
  $headers = @{ 'User-Agent' = 'FRIDAY-Setup'; 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
  $last = $null
  foreach ($attempt in 1..3) {
    try {
      return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -UseBasicParsing -Headers $headers
    } catch {
      $last = $_
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  throw "GitHub release lookup for $Repository failed: $($last.Exception.Message)"
}

# A checksum a vendor publishes at a URL (a '.sha256' sidecar or a checksum page) is read over TLS and compared with
# the file. $true = the file matched; a mismatch deletes the file and throws; $false = nothing usable was published
# (not found, unreadable, no 64-digit value), which Install-Package and the archive paths treat as unverified.
function Assert-PublishedChecksum([string]$File, [string]$Url, [string]$Label) {
  try {
    $text = (Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers @{ 'User-Agent' = 'FRIDAY-Setup' }).Content
    if ($text -is [byte[]]) { $text = [Text.Encoding]::ASCII.GetString($text) }
    $expected = ([regex]::Match("$text", '(?i)\b[0-9a-f]{64}\b')).Value.ToLowerInvariant()
  } catch {
    Write-Step "checksum file for $Label could not be read ($($_.Exception.Message))"
    return $false
  }
  if (-not $expected) { return $false }
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    throw "SHA-256 mismatch for ${Label}: expected $expected, got $actual (file deleted)"
  }
  Write-Step "SHA-256 verified for $Label"
  return $true
}

function Assert-AssetChecksum($Release, $Asset, [string]$File) {
  $sidecar = $Release.assets | Where-Object { $_.name -eq "$($Asset.name).sha256" } | Select-Object -First 1
  if (-not $sidecar) { return $false }
  return (Assert-PublishedChecksum $File $sidecar.browser_download_url $Asset.name)
}

function Install-FromGitHubRelease([string]$Repository, [string]$AssetPattern, [string[]]$SilentArgs, [string[]]$Publishers = @()) {
  $release = Get-GitHubLatestRelease $Repository
  $asset = $release.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
  if (-not $asset) { throw "no official asset matching $AssetPattern in $Repository" }
  $file = Invoke-OfficialDownload $asset.browser_download_url $asset.name
  $verified = Assert-AssetChecksum $release $asset $file
  Install-Package $file $SilentArgs $Publishers $verified
}

# FFmpeg ships as a ZIP, not an installer: it is unpacked into a per-user folder (no administrator rights,
# nothing system-wide changes) and that folder's bin is added to this session and to the user PATH.
function Install-FfmpegArchive {
  $release = Get-GitHubLatestRelease 'GyanD/codexffmpeg'
  $asset = $release.assets | Where-Object { $_.name -like 'ffmpeg-*-essentials_build.zip' } | Select-Object -First 1
  if (-not $asset) { throw 'no official FFmpeg essentials archive in GyanD/codexffmpeg' }
  $file = Invoke-OfficialDownload $asset.browser_download_url $asset.name
  # A ZIP carries no Authenticode signature: it is unpacked only when a published SHA-256 matched it, the release's
  # own sidecar first, then gyan.dev's checksum for its current essentials build (a second host).
  $verified = Assert-AssetChecksum $release $asset $file
  if (-not $verified) {
    $verified = Assert-PublishedChecksum $file 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' $asset.name
  }
  if (-not $verified) {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    throw "no published SHA-256 was found for $($asset.name), so the archive was deleted and not unpacked"
  }
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Local' }
  $destination = Join-Path $base 'FRIDAY\tools\ffmpeg'
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Expand-Archive -LiteralPath $file -DestinationPath $destination -Force
  $exe = Get-ChildItem -LiteralPath $destination -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { throw 'the FFmpeg archive did not contain ffmpeg.exe' }
  $bin = $exe.DirectoryName
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath -or (($userPath -split ';') -notcontains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath, $bin | Where-Object { $_ }) -join ';'), 'User')
  }
  Write-Step "FFmpeg unpacked to $bin and added to your user PATH"
}

# ---------------------------------------------------------------- Tesseract Hindi data
# The Tesseract installer carries English and OSD only, and FRIDAY reads Hindi, English and Hinglish screens, so
# hin.traineddata (tessdata_fast at the pinned commit and SHA-256 in config\toolchain-versions.json, tessdataHin)
# is added when `tesseract --list-langs` does not list it. Detect first; skipped offline; never fails the setup.
function Get-TesseractExe {
  $command = Get-Command 'tesseract.exe' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $base) { continue }
    $exe = Join-Path $base 'Tesseract-OCR\tesseract.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
  }
  return $null
}

function Test-TesseractHindi([string]$Exe) {
  try {
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $text = (& $Exe --list-langs 2>&1 | Out-String) } finally { $ErrorActionPreference = $before }
    return [bool]($text -match '(?m)^\s*hin\s*$')
  } catch { return $false }
}

function Test-FolderWritable([string]$Folder) {
  try {
    $probe = Join-Path $Folder ('.friday-write-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType File -Path $probe -ErrorAction Stop | Out-Null
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch { return $false }
}

function Install-TesseractHindi {
  $exe = Get-TesseractExe
  if (-not $exe) { return }
  if (Test-TesseractHindi $exe) {
    Write-Step 'Tesseract Hindi data (hin) present - detected, kept'
    return
  }
  if ("$env:FRIDAY_OFFLINE".Trim() -eq '1') {
    Write-Step 'Tesseract Hindi data (hin) is missing - skipped offline; screens are read in English until it is added'
    return
  }
  $pin = $Versions.tessdataHin
  if (-not $pin -or -not $pin.url -or -not $pin.sha256) {
    Write-Step 'Tesseract Hindi data (hin) is missing and no pinned source is configured - skipped'
    return
  }
  try {
    $file = Invoke-OfficialDownload $pin.url 'hin.traineddata'
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne "$($pin.sha256)".ToLowerInvariant()) {
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      throw "SHA-256 mismatch for hin.traineddata: expected $($pin.sha256), got $actual (file deleted)"
    }
    Write-Step 'SHA-256 verified for hin.traineddata'
    $shipped = Join-Path (Split-Path -Parent $exe) 'tessdata'
    if ($env:TESSDATA_PREFIX -and (Test-Path -LiteralPath $env:TESSDATA_PREFIX)) { $shipped = $env:TESSDATA_PREFIX }
    if ((Test-Path -LiteralPath $shipped) -and (Test-FolderWritable $shipped)) {
      Copy-Item -LiteralPath $file -Destination (Join-Path $shipped 'hin.traineddata') -Force
      Write-Step "Tesseract Hindi data added to $shipped"
    } else {
      # Program Files is not writable without administrator rights: a per-user copy of the data folder is used and
      # TESSDATA_PREFIX points the engine at it (eng, osd and the configs folders are copied along, because the variable replaces the folder).
      $base = $env:LOCALAPPDATA
      if (-not $base) { $base = Join-Path $env:USERPROFILE 'AppData\Local' }
      $folder = Join-Path $base 'FRIDAY\tools\tessdata'
      New-Item -ItemType Directory -Force -Path $folder | Out-Null
      foreach ($keep in @('eng.traineddata', 'osd.traineddata')) {
        $source = Join-Path (Join-Path (Split-Path -Parent $exe) 'tessdata') $keep
        if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath (Join-Path $folder $keep))) {
          Copy-Item -LiteralPath $source -Destination (Join-Path $folder $keep) -Force
        }
      }
      # The tsv and other output configs live in tessdata\configs: without them `tesseract ... tsv` fails.
      foreach ($sub in @('configs', 'tessconfigs')) {
        $source = Join-Path (Join-Path (Split-Path -Parent $exe) 'tessdata') $sub
        if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath (Join-Path $folder $sub))) {
          Copy-Item -LiteralPath $source -Destination (Join-Path $folder $sub) -Recurse -Force
        }
      }
      Copy-Item -LiteralPath $file -Destination (Join-Path $folder 'hin.traineddata') -Force
      [Environment]::SetEnvironmentVariable('TESSDATA_PREFIX', $folder, 'User')
      $env:TESSDATA_PREFIX = $folder
      Write-Step "Tesseract Hindi data added to $folder (TESSDATA_PREFIX set for your user)"
    }
    if (Test-TesseractHindi $exe) {
      Write-Step 'Tesseract reads Hindi and English now (hin and eng listed)'
    } else {
      Add-FollowUp 'Tesseract still does not list the Hindi data (hin): open a new terminal and run npm run setup again'
    }
  } catch {
    Write-MethodFailure 'Tesseract Hindi data' $_.Exception.Message
    Add-FollowUp 'Tesseract Hindi data (hin.traineddata) could not be added: screens are read in English until setup is run again online'
  }
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

function Update-IfNewer([string]$Label, [string[]]$Ids, [string]$Command = '', [string[]]$VersionArguments = @()) {
  if (-not $script:UpdateWanted) { return }
  if (-not $Ids -or $Ids.Count -eq 0) { return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Step "$Label - winget is not available, so the check for a newer release is skipped; the installed version stays"
    return
  }
  foreach ($id in $Ids) {
    Write-Step "$Label - asking the official winget source for a newer release ($id)"
    $code = -1
    $before = if ($Command) { Get-Version $Command $VersionArguments } else { $null }
    try {
      Invoke-WingetQuiet @('upgrade', '--id', $id, '--exact', '--source', 'winget', '--include-unknown', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') "winget $Label"
      $code = $LASTEXITCODE
    } catch { $code = -1 }
    if ($code -eq 0) {
      Refresh-Path
      $after = if ($Command) { Get-Version $Command $VersionArguments } else { $null }
      if ($before -and $after -and $before -eq $after) {
        # winget said it installed a release, but the program that answers on PATH is the same version as before.
        Write-MethodFailure "winget upgrade $id" "reported success, but $Command still answers $after"
        Add-FollowUp "${Label}: winget installed a newer release, but $Command still reports $after. Another copy is first on PATH, or Windows needs a restart; open a new terminal and run $Command $($VersionArguments -join ' ')."
      } elseif ($before -and $after) {
        Write-Step "$Label updated from $before to $after ($id)"
      } else {
        Write-Step "$Label updated to the latest release ($id)"
      }
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

# Node.js and npm run this very setup, so a running copy is never replaced from here. A newer release is
# collected and installed by a hidden helper that starts when this window's npm command has exited (see
# Start-RunningToolUpgrades); when that cannot start, the one command that installs it is named at the end.
$script:RunningUpgrades = New-Object System.Collections.Generic.List[object]
$script:UpgradeLock = Join-Path $env:TEMP 'friday-running-tools-upgrade.lock'
$script:UpgradeLog = Join-Path $env:TEMP 'friday-running-tools-upgrade.log'
# One line per tool (label|from|to|winget or npm exit code|version that answers afterwards); the next setup, doctor
# or build reads it through scripts/running-tools-upgrade.cjs, says whether the update took effect, and removes it.
$script:UpgradeResult = Join-Path $env:TEMP 'friday-running-tools-upgrade.result'

function Write-RunningToolNote([string]$Label, [string]$Installed, [string]$Latest, [string]$Command) {
  if (-not $Installed -or -not $Latest) { return }
  try {
    if ([version]$Latest -gt [version]$Installed) {
      if ($ToolchainOnly) {
        # The build runs on this Node.js and starts no background helper, so nothing is installed after it ends.
        Write-Step "$Label $Installed is supported; the newest release is $Latest. It is running this build, so it is left as it is; npm run setup installs the newer one when it ends"
        return
      }
      Write-Step "$Label $Installed is supported; the newest release is $Latest. It is running now, so it is installed right after this setup ends"
      $script:RunningUpgrades.Add(@{ Label = $Label; Installed = $Installed; Latest = $Latest; Command = $Command }) | Out-Null
    } else {
      Write-Step "$Label $Installed is the latest release"
    }
  } catch { }
}

# The helper from the last setup may still be replacing Node.js or npm: starting another run underneath it would
# use half-replaced files, so this run waits for it (at most 15 minutes).
function Wait-RunningToolsUpgrade {
  if (Test-Path -LiteralPath $script:UpgradeLock) { Wait-RunningToolsHelper }
  # Whether the last helper's update took effect is said once, from its result file.
  try { & node.exe (Join-Path $Root 'scripts\running-tools-upgrade.cjs') --report } catch { }
}

function Wait-RunningToolsHelper {
  $pending = 0
  try { $pending = [int]((Get-Content -LiteralPath $script:UpgradeLock -Raw).Trim()) } catch { }
  $process = $null
  if ($pending -gt 0) { $process = Get-Process -Id $pending -ErrorAction SilentlyContinue }
  if ($process -and $process.ProcessName -match 'powershell') {
    Write-Step "a Node.js / npm update started by the last setup is still running - waiting for it (up to 15 minutes; log: $($script:UpgradeLog))"
    try { Wait-Process -Id $pending -Timeout 900 -ErrorAction SilentlyContinue } catch { }
  }
  Remove-Item -LiteralPath $script:UpgradeLock -Force -ErrorAction SilentlyContinue
}

# This process and the processes that started it and only wait for it (npm, the cmd.exe that runs the script).
function Get-WaitIds {
  $ids = @($PID)
  try {
    $current = $PID
    for ($depth = 0; $depth -lt 6; $depth++) {
      $row = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
      $parent = [int]$row.ParentProcessId
      if ($parent -le 0) { break }
      $up = Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction Stop
      if (-not $up) { break }
      $line = "$($up.CommandLine)"
      $waits = ($up.Name -ieq 'node.exe') -or (($up.Name -ieq 'cmd.exe') -and ($line -match '\s/c\s'))
      if (-not $waits) { break }
      $ids += $parent
      $current = $parent
    }
  } catch { }
  return $ids
}

function Start-RunningToolUpgrades {
  if ($script:RunningUpgrades.Count -eq 0) { return }
  $started = $false
  if ($env:FRIDAY_SETUP_UPDATE_RUNNING_TOOLS -ne '0') {
    try {
      $ids = (Get-WaitIds) -join ','
      $body = New-Object System.Collections.Generic.List[string]
      $body.Add("`$ErrorActionPreference = 'Continue'")
      $body.Add("`$log = '$($script:UpgradeLog)'")
      $body.Add("`$result = '$($script:UpgradeResult)'")
      $body.Add('function Log([string]$Text) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + '' '' + $Text) }')
      $body.Add('function Answer([string]$Exe) { try { $env:Path = [Environment]::GetEnvironmentVariable(''Path'', ''Machine'') + '';'' + [Environment]::GetEnvironmentVariable(''Path'', ''User''); return ((& $Exe --version 2>$null | Out-String).Trim() -replace ''^v'', '''') } catch { return '''' } }')
      $body.Add('function Result([string]$Label, [string]$From, [string]$To, [string]$Code, [string]$Now) { Add-Content -LiteralPath $result -Value ($Label + ''|'' + $From + ''|'' + $To + ''|'' + $Code + ''|'' + $Now) }')
      $body.Add("foreach (`$id in @($ids)) { try { Wait-Process -Id `$id -Timeout 900 -ErrorAction SilentlyContinue } catch { } }")
      $body.Add('Start-Sleep -Seconds 2')
      $body.Add("Log 'update of the running tools started'")
      foreach ($item in $script:RunningUpgrades) {
        if ($item.Label -eq 'Node.js') {
          # Node.js is registered in winget as the LTS or the Current package, so both ids are tried, exactly, and
          # a copy winget did not install is included; -1978335212 means this id is not installed, so the next runs.
          $body.Add('$code = -1')
          $body.Add("foreach (`$wid in @('OpenJS.NodeJS.LTS', 'OpenJS.NodeJS')) {")
          $body.Add('  Log (''winget upgrade --id '' + $wid)')
          $body.Add('  & winget upgrade --id $wid --exact --include-unknown --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --source winget *>> $log')
          $body.Add('  $code = $LASTEXITCODE')
          $body.Add('  Log (''exit code '' + $code)')
          $body.Add('  if ($code -ne -1978335212) { break }')
          $body.Add('}')
          $body.Add("Result 'Node.js' '$($item.Installed)' '$($item.Latest)' `$code (Answer 'node.exe')")
        } elseif ($item.Label -eq 'npm') {
          $body.Add("Log 'npm install --global npm@latest'")
          $body.Add('& npm.cmd install --global npm@latest --no-audit --no-fund *>> $log')
          $body.Add('$code = $LASTEXITCODE')
          $body.Add('Log (''exit code '' + $code)')
          $body.Add("Result 'npm' '$($item.Installed)' '$($item.Latest)' `$code (Answer 'npm.cmd')")
        }
      }
      $body.Add("Log 'done'")
      $body.Add("Remove-Item -LiteralPath '$($script:UpgradeLock)' -Force -ErrorAction SilentlyContinue")
      Remove-Item -LiteralPath $script:UpgradeResult -Force -ErrorAction SilentlyContinue
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($body -join "`r`n")))
      $helper = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
      if ($helper) {
        Set-Content -LiteralPath $script:UpgradeLock -Value $helper.Id
        $started = $true
        $names = ($script:RunningUpgrades | ForEach-Object { "$($_.Label) $($_.Latest)" }) -join ' and '
        Write-Step "$names will be installed in the background as soon as this window's npm command ends. A Windows prompt may appear. Wait about a minute before the next npm command (it waits for the update by itself). Log: $($script:UpgradeLog)"
      }
    } catch {
      Write-MethodFailure 'background update of Node.js / npm' $_.Exception.Message
    }
  }
  if (-not $started) {
    foreach ($item in $script:RunningUpgrades) {
      Add-FollowUp "$($item.Label) $($item.Latest) is out (you have $($item.Installed)). Close this window, open a new terminal and run: $($item.Command)"
    }
  }
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
    Update-IfNewer $Label $UpdateIds $Command $VersionArguments
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
  Wait-RunningToolsUpgrade
  Refresh-Path
  Write-Stage 1 'The PC toolchain'
  Write-Step 'Preparing the FRIDAY Windows toolchain: each tool is detected first, kept when supported, and updated when its official source has a newer release'
  if ($script:UpdateWanted) {
    Write-Step 'latest-release check: on (once a day; FRIDAY_SETUP_UPDATE=0 turns it off, FRIDAY_SETUP_UPDATE=1 asks now)'
  } else {
    Write-Step 'latest-release check: off for this run (done within the last day, or FRIDAY_SETUP_UPDATE=0, hosted CI or offline)'
  }

  Clear-StaleFridayPython
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
    @{ Label = 'official Git for Windows release download'; Action = { Install-FromGitHubRelease 'git-for-windows/git' 'Git-*-64-bit.exe' @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-') @('Johannes Schindelin') } }
  ) @('Git.Git')

  Ensure-Tool 'PowerShell' 'pwsh.exe' @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()') $Versions.powershellMinimum @(
    @{ Label = 'official winget package (Microsoft.PowerShell)'; Action = { Install-WingetPackage 'Microsoft.PowerShell' } },
    @{ Label = 'official PowerShell release MSI download'; Action = { Install-FromGitHubRelease 'PowerShell/PowerShell' '*win-x64.msi' @('/qn', '/norestart') @('Microsoft Corporation') } }
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
    @{ Label = 'official winget package (Gyan.FFmpeg.Essentials)'; Action = { Install-WingetPackage 'Gyan.FFmpeg.Essentials' } },
    @{ Label = 'official Gyan.dev FFmpeg release archive (GitHub, per-user)'; Action = { Install-FfmpegArchive } }
  ) @('Gyan.FFmpeg', 'Gyan.FFmpeg.Essentials')

  Ensure-RequiredCommand 'Tesseract OCR' 'tesseract.exe' @(
    @{ Label = 'official winget package (UB-Mannheim.TesseractOCR)'; Action = { Install-WingetPackage 'UB-Mannheim.TesseractOCR' } },
    @{ Label = 'official UB-Mannheim GitHub installer'; Action = { Install-FromGitHubRelease 'UB-Mannheim/tesseract' '*w64-setup*.exe' @('/S') @('Mannheim') } }
  ) @('UB-Mannheim.TesseractOCR')
  Install-TesseractHindi

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
        Install-Package $vcFile @('/install', '/quiet', '/norestart') @('Microsoft Corporation')
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

  Write-Stage 2 'Node dependencies'
  Write-Step 'Installing the exact Node dependency lockfile'
  # A folder whose node_modules already matches package-lock.json is not wiped and installed again (the same check
  # Doctor and the build use); FRIDAY_FORCE_NPM_CI=1 installs anyway.
  & node.exe scripts\node-modules-current.cjs
  if ($LASTEXITCODE -eq 0) {
    Write-Step 'node_modules already matches package-lock.json; npm ci skipped'
  } else {
    # with-activity.cjs runs the same npm command and prints a "still working" line every few seconds, because npm
    # shows no progress when its output is piped and a quiet minute looks like a hung window.
    & node.exe scripts\with-activity.cjs --label 'npm ci' --watch node_modules -- npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Write-MethodFailure 'npm ci' "exit code $LASTEXITCODE - npm cache verify, then one retry"
      & npm.cmd cache verify
      & node.exe scripts\with-activity.cjs --label 'npm ci' --watch node_modules -- npm.cmd ci --no-audit --no-fund --registry https://registry.npmjs.org/
      if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. See the output above for the failing package.' }
    }
  }

  Write-Stage 3 'Electron'
  Write-Step 'Installing the Electron binary when npm ci did not download it'
  & node.exe scripts\ensure-electron.cjs
  if ($LASTEXITCODE -ne 0) { throw 'Electron binary installation failed after every official method.' }

  Write-Stage 4 'Python environment and voice models'
  # Hardware first: this PC's plan (chat model, speech sizes, llama.cpp, CUDA libraries) is printed before anything
  # downloads, and the model step reads the same plan. It only measures and prints; a failure here changes nothing.
  Write-Step 'Measuring this PC: the plan below decides every model and GPU package setup downloads'
  & node.exe scripts\prefetch-models.cjs --plan
  if ($LASTEXITCODE -eq 0) { $env:FRIDAY_PLAN_PRINTED = '1' }
  Write-Step 'Creating the isolated Python environment and runtime storage'
  & node.exe scripts\setup-python.cjs
  Remove-Item Env:FRIDAY_PLAN_PRINTED -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }

  Write-Stage 5 'Agent tools'
  Write-Step 'Installing the agent tools FRIDAY needs (search, Git, build tools, Go, Rust, Java, C++, Ruby, PHP, .NET, WSL 2, Docker, Windows Sandbox, CUDA on an NVIDIA PC); big models and model-only runners come later'
  & node.exe scripts\prefetch-toolkit.cjs
  if ($LASTEXITCODE -ne 0) { throw 'The agent toolkit is not complete (see ACTION REQUIRED above). Fix it, then run npm run doctor.' }

  Write-Stage 6 'Packs for the EXE'
  Write-Step 'Fetching the packs that ship inside the EXE (kept in .cache, so the build downloads nothing)'
  & node.exe scripts\stage-toolchain.cjs
  if ($LASTEXITCODE -ne 0) { throw 'The packs for the EXE could not be downloaded. Check the network, then run npm run doctor.' }

  Write-Stage 7 'Runtime folders and database'
  & node.exe scripts\init-runtime.cjs
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY runtime initialization failed.' }

  Write-Stage 8 'Repair'
  Write-Step 'Repairing any incomplete Electron or Python component'
  & node.exe scripts\check-environment.cjs --fix --summary
  if ($LASTEXITCODE -ne 0) { throw 'Automatic component repair could not complete every required component.' }

  Write-Stage 9 'Final readiness verification'
  Write-Step 'Running final readiness verification'
  # Doctor repeats the environment check only to confirm it: from here it prints the failures and a count, not the
  # same 80-line table a second time.
  $env:FRIDAY_SETUP_RUN = '1'
  & npm.cmd run doctor
  Remove-Item Env:FRIDAY_SETUP_RUN -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw 'FRIDAY Doctor did not pass.' }
  Write-Step ("resolved versions - node {0}, npm {1}, python {2}, git {3}, pwsh {4} (floors in config\toolchain-versions.json; newer versions are reused)" -f `
    (Get-Version 'node.exe' @('--version')), `
    (Get-Version 'npm.cmd' @('--version')), `
    (Get-Version 'py.exe' @('-3', '--version')), `
    (Get-Version 'git.exe' @('--version')), `
    (Get-Version 'pwsh.exe' @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()')))
  Write-Host '[FRIDAY] SETUP PASS - FRIDAY is ready to test, build and run.' -ForegroundColor Green
  Start-RunningToolUpgrades
  Write-FollowUps
} catch {
  Write-Host "[FRIDAY] SETUP FAIL - $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Restore-ConsoleQuickEdit $script:ConsoleModeBefore
  Pop-Location
}
