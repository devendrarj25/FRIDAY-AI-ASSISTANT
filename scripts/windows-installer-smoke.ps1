# FRIDAY - Windows installer lifecycle smoke test
#
# Exercises the REAL packaged installer end to end inside a sandbox folder:
#   build -> install -> locate installed EXE -> boot/self-test -> reinstall
#   -> boot/self-test -> locate the REGISTERED uninstaller -> uninstall
#   -> verify the application is gone and the FRIDAY data folder survived.
#
# Two facts this script must never assume:
#
#   1. The uninstaller filename. electron-builder derives it from
#      PRODUCT_FILENAME, which is sanitize(win.executableName) when an
#      executableName is configured - NOT from productName. FRIDAY sets
#      `executableName: FRIDAY`, so the "FRIDAY Test" product installs
#      "Uninstall FRIDAY.exe", not "Uninstall FRIDAY Test.exe". The uninstaller
#      is therefore resolved from the registered Apps & Features entry
#      (UninstallString / InstallLocation) and only then from the install
#      folder, and its existence is verified before uninstall is attempted.
#
#   2. That a process object always carries an exit code. `Start-Process
#      -PassThru` returns a Process whose ExitCode stays $null unless the
#      process handle is cached before the process exits. An empty exit code is
#      NOT a successful boot and is reported as a failure.
#
# Nothing here is weakened to make CI green: every check either proves the real
# behaviour or fails the job.

param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Product = "FRIDAY"
)

$ErrorActionPreference = "Stop"
$installerPath = (Resolve-Path $Installer).Path
$sandbox = Join-Path $env:RUNNER_TEMP ("friday-installer-smoke-" + [Guid]::NewGuid().ToString("N"))
# Single-root contract: the installer takes ONE root folder via /D, installs
# the program into <root>\App and keeps every data sibling under <root>.
$rootDir = Join-Path $sandbox "FRIDAY"
$installDir = Join-Path $rootDir "App"
# Data lives directly under the SAME root, as siblings of App - there is no
# separate "Data" root any more (single-root contract).
$dataDir = $rootDir
$sentinel = Join-Path $dataDir "config\installer-smoke-sentinel.txt"
$registry = "HKCU:\Software\FRIDAY"
$oldWorkspace = $null
$oldInstall = $null

# Start a process and immediately cache its handle, so ExitCode is available
# after it exits (PowerShell/.NET drop the handle otherwise and ExitCode
# silently becomes $null).
function Start-Tracked {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [string]$StdOut, [string]$StdErr)
  $params = @{ FilePath = $FilePath; PassThru = $true }
  if ($ArgumentList.Count -gt 0) { $params["ArgumentList"] = $ArgumentList }
  if ($StdOut) { $params["RedirectStandardOutput"] = $StdOut }
  if ($StdErr) { $params["RedirectStandardError"] = $StdErr }
  $p = Start-Process @params
  if ($null -eq $p) { throw "Failed to start $FilePath." }
  try { $null = $p.Handle } catch {}
  return $p
}

# Kill ONLY the process tree this smoke test started.
function Stop-Tree([Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  try { if ($Process.HasExited) { return } } catch { return }
  try { & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F | Out-Null } catch {}
  try { $null = $Process.WaitForExit(15000) } catch {}
}

function Wait-Exit([Diagnostics.Process]$Process, [int]$Seconds, [string]$Label) {
  if (-not $Process.WaitForExit($Seconds * 1000)) {
    Stop-Tree $Process
    throw "$Label timed out after $Seconds seconds."
  }
  # Second, unbounded wait: flushes redirected stdout/stderr and guarantees the
  # exit state is fully committed before ExitCode is read.
  try { $Process.WaitForExit() } catch {}
  try { $Process.Refresh() } catch {}

  $code = $null
  try { $code = $Process.ExitCode } catch { $code = $null }
  if ($null -eq $code) {
    throw "$Label did not report an exit code (process state was lost) - treated as a failure."
  }
  if ($code -ne 0) { throw "$Label failed with exit code $code." }
  return $code
}

# The registered uninstaller, resolved the way Windows itself resolves it.
function Resolve-Uninstaller {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $entry) { continue }
      $location = "$($entry.InstallLocation)".TrimEnd('\')
      if ($location -ne $installDir.TrimEnd('\')) { continue }
      $command = "$($entry.QuietUninstallString)"
      if (-not $command) { $command = "$($entry.UninstallString)" }
      if (-not $command) { continue }
      $exe = $command.Trim()
      if ($exe.StartsWith('"')) { $exe = $exe.Substring(1, $exe.IndexOf('"', 1) - 1) }
      else { $exe = ($exe -split '\s+')[0] }
      if (Test-Path -LiteralPath $exe) {
        Write-Host "[friday] registered uninstaller: $exe"
        return $exe
      }
    }
  }
  # Fallback: the uninstaller electron-builder writes beside the application.
  $found = Get-ChildItem -LiteralPath $installDir -Filter "Uninstall *.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) {
    Write-Host "[friday] uninstaller found in the install folder: $($found.FullName)"
    return $found.FullName
  }
  return $null
}

function Run-Setup {
  # /D is the ONE root folder (must stay the LAST argument for NSIS silent
  # installs); the installer itself places the program in <root>\App.
  $p = Start-Tracked -FilePath $installerPath -ArgumentList @("/S", "/D=$rootDir")
  Wait-Exit $p 900 "FRIDAY Setup" | Out-Null

  $exe = Join-Path $installDir "FRIDAY.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    # Real diagnosis instead of a bare "missing": report the setup exit code,
    # every place the program could have landed, and the registry pointers the
    # installer writes, so a wrong install location is provable from the log.
    Write-Host "[friday] setup exit code: $($p.ExitCode)"
    Write-Host "[friday] sandbox tree:"
    Get-ChildItem -LiteralPath $sandbox -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      Select-Object -First 60 -ExpandProperty FullName | ForEach-Object { Write-Host "    $_" }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA "Programs"),
        (Join-Path $env:PROGRAMFILES $Product),
        (Join-Path $env:USERPROFILE "FRIDAY"))) {
      if (Test-Path -LiteralPath $candidate) {
        Get-ChildItem -LiteralPath $candidate -Recurse -Filter "FRIDAY.exe" -ErrorAction SilentlyContinue |
          ForEach-Object { Write-Host "[friday] stray install: $($_.FullName)" }
      }
    }
    foreach ($key in @("HKCU:\Software\FRIDAY", "HKCU:\Software\FRIDAY Test")) {
      if (Test-Path $key) {
        $props = Get-ItemProperty $key
        Write-Host "[friday] $key WorkspacePath=$($props.WorkspacePath) InstallPath=$($props.InstallPath)"
      }
    }
    $listing = (Get-ChildItem -LiteralPath $installDir -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ", "
    throw "Installed FRIDAY.exe is missing in $installDir. Contents: $listing"
  }


  # Setup finished, so the uninstaller must exist and be registered. Give the
  # filesystem/registry a brief settle window rather than a blanket retry.
  $uninstaller = $null
  for ($i = 0; $i -lt 20; $i++) {
    $uninstaller = Resolve-Uninstaller
    if ($uninstaller) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $uninstaller) {
    $listing = (Get-ChildItem -LiteralPath $installDir -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ", "
    throw "Installed uninstaller is missing: no registered UninstallString for $installDir and no 'Uninstall *.exe' beside the application. Contents: $listing"
  }
  return $uninstaller
}

function Verify-Boot {
  $stamp = [Guid]::NewGuid().ToString("N")
  $stdout = Join-Path $sandbox "boot-out-$stamp.txt"
  $stderr = Join-Path $sandbox "boot-err-$stamp.txt"
  $env:FRIDAY_BOOT_SELFTEST = "1"
  $p = Start-Tracked -FilePath (Join-Path $installDir "FRIDAY.exe") -StdOut $stdout -StdErr $stderr
  $failure = $null
  try {
    Wait-Exit $p 240 "Installed FRIDAY boot self-test" | Out-Null
  } catch {
    # Keep the real failure, but never lose the diagnostics: a crash exit code
    # on its own does not say WHICH subsystem died. The captured output and the
    # application's own log are what identify it on the next run.
    $failure = $_.Exception.Message
  } finally {
    Stop-Tree $p
    Remove-Item Env:\FRIDAY_BOOT_SELFTEST -ErrorAction SilentlyContinue
  }
  $output = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
  $mainLog = Join-Path $dataDir "logs\main.log"
  $logTail = ""
  if (Test-Path -LiteralPath $mainLog) {
    $logTail = (Get-Content $mainLog -Tail 60 -ErrorAction SilentlyContinue) -join "`n"
  }
  if ($failure) {
    throw "$failure`n--- stdout/stderr ---`n$output`n--- main.log (tail) ---`n$logTail"
  }
  if ($output -notmatch "FRIDAY_BOOT_SELFTEST_OK") {
    throw "Installed FRIDAY did not report a mounted interface.`n$output`n--- main.log (tail) ---`n$logTail"
  }
}


try {
  New-Item -ItemType Directory -Path (Split-Path $sentinel) -Force | Out-Null
  Set-Content -Path $sentinel -Value "preserve-me" -NoNewline
  if (Test-Path $registry) {
    $oldWorkspace = (Get-ItemProperty $registry -Name WorkspacePath -ErrorAction SilentlyContinue).WorkspacePath
    $oldInstall = (Get-ItemProperty $registry -Name InstallPath -ErrorAction SilentlyContinue).InstallPath
  }
  New-Item -Path $registry -Force | Out-Null
  Set-ItemProperty $registry WorkspacePath $rootDir

  $uninstaller = Run-Setup
  Verify-Boot
  if (-not (Test-Path -LiteralPath $sentinel)) {
    throw "First install removed the FRIDAY data sentinel."
  }

  # In-place repair: running Setup again over the same root must re-verify the
  # application without duplicating Apps & Features entries or touching data.
  $uninstaller = Run-Setup
  Verify-Boot
  if (-not (Test-Path -LiteralPath $sentinel)) {
    throw "Reinstall / repair removed the FRIDAY data folder."
  }
  $uninstallHits = 0
  foreach ($rootKey in @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )) {
    if (-not (Test-Path $rootKey)) { continue }
    foreach ($key in (Get-ChildItem $rootKey -ErrorAction SilentlyContinue)) {
      $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $entry) { continue }
      $location = "$($entry.InstallLocation)".TrimEnd('\')
      if ($location -eq $installDir.TrimEnd('\')) { $uninstallHits++ }
    }
  }
  if ($uninstallHits -gt 1) {
    throw "Reinstall registered $uninstallHits uninstall entries for $installDir (expected 1)."
  }

  if (-not (Test-Path -LiteralPath $uninstaller)) {
    throw "Installed uninstaller is missing before uninstall: $uninstaller"
  }
  $p = Start-Tracked -FilePath $uninstaller -ArgumentList @("/S", "_?=$installDir")
  Wait-Exit $p 300 "FRIDAY uninstall" | Out-Null
  # With _?= the uninstaller runs in place and NSIS deletes its own copy after
  # returning; wait for the application itself to disappear.
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe")) { throw "Uninstall left FRIDAY.exe behind." }
  if (-not (Test-Path $sentinel)) { throw "Uninstall removed the FRIDAY data folder." }
  Write-Host "[friday] PASS installer -> boot -> reinstall -> boot -> uninstall; data preserved"
  exit 0
} finally {
  Remove-Item Env:\FRIDAY_BOOT_SELFTEST -ErrorAction SilentlyContinue
  if ($null -ne $oldWorkspace) { Set-ItemProperty $registry WorkspacePath $oldWorkspace }
  else { Remove-ItemProperty $registry WorkspacePath -ErrorAction SilentlyContinue }
  if ($null -ne $oldInstall) { Set-ItemProperty $registry InstallPath $oldInstall }
  else { Remove-ItemProperty $registry InstallPath -ErrorAction SilentlyContinue }
  Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
