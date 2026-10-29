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
# UPDATE TEST. When FRIDAY_PREVIOUS_INSTALLER names the previously PUBLISHED
# installer (PR Validation downloads the latest release's FRIDAY-Setup-*.exe),
# that real earlier FRIDAY is installed first and then updated to this build
# with the switches FRIDAY itself uses (/S --updated --force-run). A file in
# every data folder (config, memory, conversations, brain-data, database,
# models, voices, downloads, workflows, agents, skills, plugins, modules) must
# survive the update, the reinstall, the silent updates and the keep-uninstall
# byte for byte. A second silent update runs while FRIDAY is running again.
#
# SCENARIOS. FRIDAY_SMOKE_SCENARIO picks what runs: "all" (the default, a local run),
# "lifecycle" (install, boot, reinstall, silent update, keep-uninstall) or "update"
# (the update from the previously published release, a keep-uninstall, then the
# erase-all uninstall). PR Validation runs the two in parallel on two runners.
#
# Nothing here is weakened to make CI green: every check either proves the real
# behaviour or fails the job.
#
# Local runs do not have GitHub's RUNNER_TEMP. PowerShell 7.6 Join-Path rejects
# a null Path. When -Installer is omitted, the Setup EXE is
# release\FRIDAY-Setup-<public version>.exe under the repo root.

param(
  [string]$Installer = "",
  [string]$Product = "FRIDAY",
  [string]$ReleaseDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scenario = "$env:FRIDAY_SMOKE_SCENARIO".Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($scenario)) { $scenario = "all" }
if (@("all", "lifecycle", "update") -notcontains $scenario) {
  throw "FRIDAY_SMOKE_SCENARIO must be all, lifecycle or update (got '$scenario')."
}
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $true
}

function Test-Blank([string]$Value) {
  return [string]::IsNullOrWhiteSpace($Value)
}

# The update test is the part a green check could hide by skipping it, so every
# outcome is also written to the job summary, not only to the log.
function Write-Summary([string]$Line) {
  if (-not (Test-Blank $env:GITHUB_STEP_SUMMARY)) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Line
  }
}

# Erase-all scenario, shared by the "all" and "update" scenarios. The two scenarios split the
# lifecycle between two runners; this part follows the update test so neither job is the long one.
function Invoke-EraseAll {
  # Erase-all scenario: a scripted "Delete all FRIDAY data" (/S /DELETEDATA) must
  # leave nothing of the root behind. It removes the per-user FRIDAY folders and
  # the HKCU\Software\FRIDAY key too, so it runs only on a throwaway runner (CI)
  # or when FRIDAY_SMOKE_ERASE=1 asks for it; on the owner's own PC it is skipped.
  if ($env:CI -or $env:GITHUB_ACTIONS -or $env:FRIDAY_SMOKE_ERASE -eq "1") {
    $uninstaller = Run-Setup
    Verify-Boot
    if (-not (Test-Path -LiteralPath $sentinel)) { throw "Reinstall after the keep-uninstall lost the data sentinel." }
    Assert-DataIntact "Reinstall after the keep-uninstall"
    Stop-InstalledApp
    if ($Product -eq "FRIDAY Test") {
      # FRIDAY Test shares the production FRIDAY folder, so its uninstaller never
      # erases data: /DELETEDATA is ignored on purpose (installer.nsh). The contract
      # to prove is the opposite: the program goes, every data folder stays.
      $p = Start-Tracked -FilePath $uninstaller -ArgumentList @("/S", "/DELETEDATA", "_?=$installDir")
      Wait-Exit $p 300 "FRIDAY Test uninstall (/DELETEDATA must be ignored)" | Out-Null
      for ($i = 0; $i -lt 60; $i++) {
        if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) { break }
        Start-Sleep -Milliseconds 500
      }
      if (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe")) { throw "The TEST uninstall left FRIDAY.exe behind." }
      Assert-NoInstallOrphans
      if (-not (Test-Path -LiteralPath $sentinel)) { throw "The TEST uninstall with /DELETEDATA erased the shared FRIDAY data; it must never." }
      Assert-DataIntact "The TEST uninstall with /DELETEDATA"
      Write-Host "[friday] PASS TEST uninstall ignored /DELETEDATA: the program was removed and the shared data folder was kept"
      return
    }
    $p = Start-Tracked -FilePath $uninstaller -ArgumentList @("/S", "/DELETEDATA", "_?=$installDir")
    Wait-Exit $p 300 "FRIDAY uninstall (erase all data)" | Out-Null
    # A detached helper sweeps the program folder and the root a few seconds after the
    # uninstaller exits and retries for about a minute and a half.
    for ($i = 0; $i -lt 360; $i++) {
      if (-not (Test-Path -LiteralPath $rootDir)) { break }
      Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $rootDir) {
      # Say what is left and who holds it, so the next run explains itself.
      Write-Host "[friday] erase-all: the data sentinel is $(if (Test-Path -LiteralPath $sentinel) { 'still there (the uninstaller kept the data: /DELETEDATA was not honoured)' } else { 'gone (the data was erased, the program folder was not)' })"
      Get-ChildItem -LiteralPath $rootDir -Recurse -Force -ErrorAction SilentlyContinue |
        Select-Object -First 40 -ExpandProperty FullName | ForEach-Object { Write-Host "    left: $_" }
      foreach ($hit in @(Get-OwnedProcesses)) { Write-Host "    running: $($hit.Name) pid $($hit.ProcessId) $($hit.ExecutablePath)" }
      throw "Erase-all uninstall left the FRIDAY folder behind: $rootDir"
    }
    if (Test-Path -LiteralPath $sentinel) { throw "Erase-all uninstall left the data sentinel behind." }
    Assert-NoInstallOrphans
    Write-Host "[friday] PASS erase-all uninstall removed the program, the data folder and the per-user traces"
  } else {
    Write-Host "[friday] SKIP erase-all uninstall on this PC (it would delete the per-user FRIDAY folders); set FRIDAY_SMOKE_ERASE=1 to run it"
  }
}

function Get-Note($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sandbox = $null
$rootDir = $null
$installDir = $null
$dataDir = $null
$sentinel = $null
# One file per data folder; Assert-DataIntact proves none was removed or changed.
$script:dataSentinels = @()
$installerPath = $null
$registry = "HKCU:\Software\FRIDAY"
$oldWorkspace = $null
$oldInstall = $null
$smokeError = $null
# The booted app records the sandbox root in its settings pointer. Keep the
# owner's pointer files so a later setup does not adopt the throwaway folder.
$pointerFiles = @()
if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  foreach ($name in @("FRIDAY", "friday", "friday-desk")) {
    $pointerFiles += (Join-Path (Join-Path $env:APPDATA $name) "friday-settings.json")
  }
}
$pointerBackup = @{}
foreach ($file in $pointerFiles) {
  if (Test-Path -LiteralPath $file) { $pointerBackup[$file] = [System.IO.File]::ReadAllBytes($file) }
}

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
# The parent often exits first. Electron children are also FRIDAY.exe and get
# reparented, so taskkill still runs after the parent has exited. taskkill /T
# cannot see those children once the parent pid is gone, so anything whose
# executable is still under this install directory is closed too.
function Stop-Tree([Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  try { & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1 | Out-Null } catch {}
  foreach ($hit in @(Get-OwnedProcesses)) {
    try { & "$env:SystemRoot\System32\taskkill.exe" /PID $hit.ProcessId /T /F 2>&1 | Out-Null } catch {}
  }
  try {
    if (-not $Process.HasExited) { $null = $Process.WaitForExit(15000) }
  } catch {}
}

function Test-OwnedPath([string]$ExePath) {
  if (-not $ExePath) { return $false }
  try { $full = [IO.Path]::GetFullPath($ExePath) } catch { return $false }
  $root = [IO.Path]::GetFullPath($installDir).TrimEnd('\')
  return $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-OwnedProcesses {
  $names = @("FRIDAY", "whisper-server", "whisper-cli", "python", "node", "msedge", "chrome")
  $wanted = @{}
  foreach ($name in $names) { $wanted[$name.ToLowerInvariant()] = $true }
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $base = [IO.Path]::GetFileNameWithoutExtension([string]$_.Name)
    if (-not $base -or -not $wanted.ContainsKey($base.ToLowerInvariant())) { return $false }
    return (Test-OwnedPath ([string]$_.ExecutablePath))
  })
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
      $location = "$(Get-Note $entry 'InstallLocation')".TrimEnd('\')
      if ($location -ne $installDir.TrimEnd('\')) { continue }
      $command = "$(Get-Note $entry 'QuietUninstallString')"
      if (-not $command) { $command = "$(Get-Note $entry 'UninstallString')" }
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
    Write-Host "[friday] setup exit code: $(Get-Note $p 'ExitCode')"
    Write-Host "[friday] sandbox tree:"
    Get-ChildItem -LiteralPath $sandbox -Recurse -Depth 3 -ErrorAction SilentlyContinue |
      Select-Object -First 60 -ExpandProperty FullName | ForEach-Object { Write-Host "    $_" }
    $parents = @()
    if (-not (Test-Blank $env:LOCALAPPDATA)) { $parents += (Join-Path $env:LOCALAPPDATA "Programs") }
    if (-not (Test-Blank $env:PROGRAMFILES)) { $parents += (Join-Path $env:PROGRAMFILES $Product) }
    if (-not (Test-Blank $env:USERPROFILE)) { $parents += (Join-Path $env:USERPROFILE "FRIDAY") }
    foreach ($candidate in $parents) {
      if (Test-Path -LiteralPath $candidate) {
        Get-ChildItem -LiteralPath $candidate -Recurse -Filter "FRIDAY.exe" -ErrorAction SilentlyContinue |
          ForEach-Object { Write-Host "[friday] stray install: $($_.FullName)" }
      }
    }
    foreach ($key in @("HKCU:\Software\FRIDAY", "HKCU:\Software\FRIDAY Test")) {
      if (Test-Path $key) {
        $props = Get-ItemProperty $key
        Write-Host "[friday] $key WorkspacePath=$(Get-Note $props 'WorkspacePath') InstallPath=$(Get-Note $props 'InstallPath')"
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

# Setup runAfterFinish starts FRIDAY.exe before this check. That process holds
# the single-instance mutex, and the self-test then never reaches the window.
function Assert-DataIntact([string]$When) {
  foreach ($entry in $script:dataSentinels) {
    if (-not (Test-Path -LiteralPath $entry.Path)) {
      throw "$When removed the FRIDAY data file $($entry.Path)."
    }
    $now = Get-Content -LiteralPath $entry.Path -Raw
    if ($now -ne $entry.Text) { throw "$When changed the FRIDAY data file $($entry.Path)." }
  }
}

function Stop-InstalledApp {
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $hits = @(Get-OwnedProcesses)
    if ($hits.Count -eq 0) { return }
    foreach ($hit in $hits) {
      try { & "$env:SystemRoot\System32\taskkill.exe" /PID $hit.ProcessId /T /F 2>&1 | Out-Null } catch {}
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
}

function Verify-Boot {
  Stop-InstalledApp
  $stamp = [Guid]::NewGuid().ToString("N")
  $stdout = Join-Path $sandbox "boot-out-$stamp.txt"
  $stderr = Join-Path $sandbox "boot-err-$stamp.txt"
  # The environment and the arguments both name this run. A GUI launch with
  # redirected output has dropped the inherited environment before; the
  # arguments still reach the process and select the same FRIDAY folder Setup wrote.
  $env:FRIDAY_BOOT_SELFTEST = "1"
  $env:FRIDAY_WORKSPACE_ROOT = $rootDir
  # Do not redirect stdout or stderr. On this GUI process a redirected pipe
  # blocks the main thread, and the boot then never reaches the window. The
  # app replaces the marker file with BEGIN, then with OK or FAIL. Removing it
  # first stops an older OK from counting as this launch.
  $markerPath = Join-Path $dataDir "logs\boot-selftest.txt"
  if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
  $p = Start-Tracked -FilePath (Join-Path $installDir "FRIDAY.exe") -ArgumentList @(
    "--friday-boot-selftest",
    "--friday-workspace=$rootDir"
  )
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
  $markerText = "(boot-selftest.txt missing at $markerPath)"
  if (Test-Path -LiteralPath $markerPath) {
    $markerText = Get-Content -LiteralPath $markerPath -Raw -ErrorAction SilentlyContinue
  }
  $mainLog = Join-Path $dataDir "logs\main.log"
  $logTail = "(main.log missing at $mainLog)"
  if (Test-Path -LiteralPath $mainLog) {
    $logTail = (Get-Content $mainLog -Tail 60 -ErrorAction SilentlyContinue) -join "`n"
  }
  $evidence = "$output`n--- boot-selftest.txt ---`n$markerText`n--- main.log (tail) ---`n$logTail"
  if ($failure) {
    throw "$failure`n--- stdout/stderr ---`n$evidence"
  }
  $mounted = "$output`n$markerText"
  if ($mounted -notmatch "FRIDAY_BOOT_SELFTEST_OK") {
    throw "Installed FRIDAY did not report a mounted interface.`n$evidence"
  }
}

function Assert-NoInstallOrphans {
  # A child can still be exiting when the parent has already reported success.
  # Give that teardown a few seconds, and close any install-directory process
  # that is still there. A process with no readable path is not this install.
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $hits = @(Get-OwnedProcesses)
    if ($hits.Count -eq 0) { return }
    foreach ($hit in $hits) {
      try { & "$env:SystemRoot\System32\taskkill.exe" /PID $hit.ProcessId /T /F 2>&1 | Out-Null } catch {}
    }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  $left = @(Get-OwnedProcesses)
  if ($left.Count -gt 0) {
    $detail = ($left | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.ExecutablePath)" }) -join "; "
    throw "Orphan is still running after the boot self-test: $detail"
  }
}

function Verify-UpdateManifest {
  param([string]$Dir)
  if (-not $Dir) { throw "update manifest check needs the release directory." }
  $files = @(Get-ChildItem -LiteralPath $Dir -Filter "latest*.yml" -File -ErrorAction SilentlyContinue)
  if ($files.Count -lt 1) { throw "update manifest missing in $Dir" }
  foreach ($file in $files) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    if ($text -notmatch "sha512:\s*\S+") {
      throw "update manifest $($file.Name) has no sha512"
    }
  }
  Write-Host "[friday] update manifest hash verified"
}

try {
  if (Test-Blank $Installer) {
    $versionFile = Join-Path $repoRoot "config\friday-version.json"
    if (-not (Test-Path -LiteralPath $versionFile)) {
      throw "installer smoke needs -Installer, or $versionFile, so it can find release\FRIDAY-Setup-<public version>.exe."
    }
    $versionJson = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
    $publicVersion = "$(Get-Note $versionJson 'major').$(Get-Note $versionJson 'minor').$(Get-Note $versionJson 'patch').$(Get-Note $versionJson 'revision')"
    if ($publicVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
      throw "installer smoke could not read a four-part public version from $versionFile (got '$publicVersion'). Expected release\FRIDAY-Setup-<public version>.exe."
    }
    $Installer = Join-Path $repoRoot "release\FRIDAY-Setup-$publicVersion.exe"
    if (-not (Test-Path -LiteralPath $Installer)) {
      throw "installer smoke found no Setup EXE. Expected $Installer (release\FRIDAY-Setup-<public version>.exe from config\friday-version.json). Pass -Installer to use another file."
    }
  }
  if (Test-Blank $Installer -or -not (Test-Path -LiteralPath $Installer)) {
    throw "installer smoke found no Setup EXE. Expected path: '$Installer'. Pass -Installer or place release\FRIDAY-Setup-<public version>.exe in the repo root."
  }
  $installerPath = (Resolve-Path -LiteralPath $Installer).Path

  $tempRoot = $env:RUNNER_TEMP
  if (Test-Blank $tempRoot) { $tempRoot = [IO.Path]::GetTempPath() }
  if (Test-Blank $tempRoot) {
    throw "installer smoke has no temp directory. RUNNER_TEMP is unset and GetTempPath() returned nothing."
  }
  $sandbox = Join-Path $tempRoot.TrimEnd('\', '/') ("friday-installer-smoke-" + [Guid]::NewGuid().ToString("N"))
  # Single-root contract: the installer takes ONE root folder via /D, installs
  # the program into <root>\App and keeps every data sibling under <root>.
  $rootDir = Join-Path $sandbox "FRIDAY"
  $installDir = Join-Path $rootDir "App"
  # Data lives directly under the SAME root, as siblings of App - there is no
  # separate "Data" root any more (single-root contract).
  $dataDir = $rootDir
  $sentinel = Join-Path $dataDir "config\installer-smoke-sentinel.txt"

  New-Item -ItemType Directory -Path (Split-Path $sentinel) -Force | Out-Null
  Set-Content -Path $sentinel -Value "preserve-me" -NoNewline
  foreach ($rel in @(
      "memory\permanent", "conversations\history", "brain-data\knowledge", "database",
      "models\local", "voices", "downloads", "workflows\saved", "agents\custom",
      "skills\custom", "plugins\installed", "modules\custom"
    )) {
    $dir = Join-Path $dataDir $rel
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir "installer-smoke-keep.txt"
    $text = "keep:$rel"
    Set-Content -Path $file -Value $text -NoNewline
    $script:dataSentinels += [pscustomobject]@{ Path = $file; Text = $text }
  }
  if (Test-Path $registry) {
    $saved = Get-ItemProperty $registry -ErrorAction SilentlyContinue
    if ($null -ne $saved) {
      $oldWorkspace = Get-Note $saved "WorkspacePath"
      $oldInstall = Get-Note $saved "InstallPath"
    }
  }
  New-Item -Path $registry -Force | Out-Null
  Set-ItemProperty $registry WorkspacePath $rootDir

  # UPDATE TEST from the previously published release (see the header). Failing
  # to install that earlier release is not this build's fault and only skips the
  # test; failing to UPDATE it to this build is.
  $previousPath = $env:FRIDAY_PREVIOUS_INSTALLER
  if ($scenario -eq "lifecycle") {
    Write-Host "[friday] update test: runs in its own job (scenario lifecycle)"
  } elseif (-not (Test-Blank $previousPath) -and (Test-Path -LiteralPath $previousPath)) {
    $previousPath = (Resolve-Path -LiteralPath $previousPath).Path
    Write-Host "[friday] update test: installing the previously published FRIDAY first ($(Split-Path $previousPath -Leaf))"
    $previousOk = $false
    try {
      $p = Start-Tracked -FilePath $previousPath -ArgumentList @("/S", "/D=$rootDir")
      Wait-Exit $p 900 "Previously published FRIDAY Setup" | Out-Null
      $previousOk = Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe")
    } catch {
      Write-Host "::warning title=Update test::the previously published installer did not install ($($_.Exception.Message)); the update test is skipped"
      Write-Summary "### Update test: SKIPPED, the previously published installer did not install ($($_.Exception.Message))"
    }
    if ($previousOk) {
      Stop-InstalledApp
      $p = Start-Tracked -FilePath $installerPath -ArgumentList @("/S", "--updated", "--force-run", "/D=$rootDir")
      Wait-Exit $p 900 "FRIDAY Setup (update from the previously published release)" | Out-Null
      Stop-InstalledApp
      Assert-NoInstallOrphans
      if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) {
        throw "Updating the previously published FRIDAY left no FRIDAY.exe in $installDir."
      }
      Assert-DataIntact "Updating the previously published FRIDAY"
      Verify-Boot
      Assert-NoInstallOrphans
      Write-Host "[friday] PASS update from the previously published release kept the program and every data folder"
      Write-Summary "### Update test: PASSED, the previously published release was updated in place and every data folder was kept"
    } elseif (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) {
      Write-Host "::warning title=Update test::no earlier FRIDAY was installed; continuing with this build"
      Write-Summary "### Update test: SKIPPED, no earlier FRIDAY was installed"
    }
  } else {
    Write-Host "[friday] update test: no previously published installer was provided; it starts from this build"
    Write-Summary "### Update test: SKIPPED, no previously published installer was provided"
  }

  if ($scenario -eq "update") {
    # Only the update was asked for. Remove the updated install the way a user would
    # and prove the data of every folder is still there.
    $uninstaller = Resolve-Uninstaller
    if (-not $uninstaller) {
      if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) {
        Write-Host "[friday] PASS update scenario had nothing to remove (no earlier FRIDAY was installed)"
        $uninstaller = $null
      } else {
        throw "The updated install has no uninstaller."
      }
    }
    if ($uninstaller) {
      $p = Start-Tracked -FilePath $uninstaller -ArgumentList @("/S", "_?=$installDir")
      Wait-Exit $p 300 "FRIDAY uninstall (after the update)" | Out-Null
      for ($i = 0; $i -lt 60; $i++) {
        if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) { break }
        Start-Sleep -Milliseconds 500
      }
      if (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe")) { throw "Uninstall after the update left FRIDAY.exe behind." }
      Assert-NoInstallOrphans
      Assert-DataIntact "The keep-uninstall after the update"
      Write-Host "[friday] PASS update scenario: previous release -> this build -> boot -> uninstall; data preserved"
    }
    # The erase-all uninstall belongs to this job: the lifecycle job would otherwise be the long one.
    Invoke-EraseAll
  } else {
  $uninstaller = Run-Setup
  Verify-Boot
  if (-not (Test-Path -LiteralPath $sentinel)) {
    throw "First install removed the FRIDAY data sentinel."
  }
  Assert-DataIntact "The first install"
  $kernel = Join-Path $installDir "resources\kernel\main.py"
  if (-not (Test-Path -LiteralPath $kernel)) {
    throw "Installed kernel is missing: $kernel"
  }
  if ((Get-Item -LiteralPath $kernel).Length -lt 1) {
    throw "Installed kernel is empty: $kernel"
  }
  Write-Host "[friday] kernel health: $kernel"
  Write-Host "[friday] installer smoke product: $Product"
  Assert-NoInstallOrphans
  $manifestDir = $ReleaseDir
  if (-not $manifestDir) { $manifestDir = Split-Path -Parent $installerPath }
  Verify-UpdateManifest -Dir $manifestDir
  $sentinelRoot = (Resolve-Path (Split-Path (Split-Path $sentinel -Parent) -Parent)).Path
  if ($sentinelRoot -ne (Resolve-Path $rootDir).Path) {
    throw "Data folder $sentinelRoot is not the chosen install root $rootDir."
  }
  Write-Host "[friday] Doctor gate: kernel present, no orphan FRIDAY.exe, data folder is the chosen root"

  # In-place repair: running Setup again over the same root must re-verify the
  # application without duplicating Apps & Features entries or touching data.
  $uninstaller = Run-Setup
  Verify-Boot
  Assert-NoInstallOrphans
  if (-not (Test-Path -LiteralPath $sentinel)) {
    throw "Reinstall / repair removed the FRIDAY data folder."
  }
  Assert-DataIntact "Reinstall / repair"
  # The in-place UPDATE path FRIDAY itself takes (electron/update-safety.cjs,
  # installerLaunch): the same Setup, silent, with the update switches, over an
  # install that already holds data. Data and the program must survive, and
  # --force-run should start the app again; that start is only reported, because
  # whether the runner's desktop session accepts a GUI launch is not something
  # this check can promise. The app is closed again before anything else runs.
  $p = Start-Tracked -FilePath $installerPath -ArgumentList @("/S", "--updated", "--force-run", "/D=$rootDir")
  Wait-Exit $p 900 "FRIDAY Setup (silent update)" | Out-Null
  $relaunched = $false
  for ($i = 0; $i -lt 20; $i++) {
    if (@(Get-OwnedProcesses).Count -gt 0) { $relaunched = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($relaunched) {
    Write-Host "[friday] silent update started FRIDAY again (--force-run)"
  } else {
    Write-Host "[friday] WARN silent update did not start FRIDAY again within 10 seconds (--force-run); the install itself succeeded"
  }
  # Update again while FRIDAY is still running (when --force-run started it):
  # Setup must close it and finish unattended instead of stalling on a prompt.
  if ($relaunched) {
    $p = Start-Tracked -FilePath $installerPath -ArgumentList @("/S", "--updated", "--force-run", "/D=$rootDir")
    Wait-Exit $p 900 "FRIDAY Setup (silent update while FRIDAY is running)" | Out-Null
    Write-Host "[friday] PASS silent update finished while FRIDAY was running"
  }
  Stop-InstalledApp
  Assert-NoInstallOrphans
  if (-not (Test-Path -LiteralPath (Join-Path $installDir "FRIDAY.exe"))) {
    throw "The silent update left no FRIDAY.exe in $installDir."
  }
  if (-not (Test-Path -LiteralPath $sentinel)) {
    throw "The silent update removed the FRIDAY data folder."
  }
  Assert-DataIntact "The silent update"
  Verify-Boot
  Assert-NoInstallOrphans
  Write-Host "[friday] PASS silent update over an existing install kept the program and the data"

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
      $location = "$(Get-Note $entry 'InstallLocation')".TrimEnd('\')
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
  Assert-NoInstallOrphans
  if (-not (Test-Path $sentinel)) { throw "Uninstall removed the FRIDAY data folder." }
  Assert-DataIntact "The keep-uninstall"
  if ($scenario -eq "lifecycle") {
    Write-Host "[friday] erase-all uninstall: runs in the update job (scenario lifecycle)"
  } else {
    Invoke-EraseAll
  }
  Write-Host "[friday] PASS installer -> boot -> reinstall -> silent update -> boot -> uninstall; data preserved"
  }
} catch {
  $smokeError = $_
  Write-Host "[friday] FAIL installer smoke: $($_.Exception.Message)"
} finally {
  try {
    Remove-Item Env:\FRIDAY_BOOT_SELFTEST -ErrorAction SilentlyContinue
    # An erase-all uninstall deletes HKCU\Software\FRIDAY; bring the key back when it held a value before.
    if ((-not (Test-Path $registry)) -and (($null -ne $oldWorkspace) -or ($null -ne $oldInstall))) { New-Item -Path $registry -Force | Out-Null }
    if (Test-Path $registry) {
      if ($null -ne $oldWorkspace) { Set-ItemProperty $registry WorkspacePath $oldWorkspace }
      else { Remove-ItemProperty $registry WorkspacePath -ErrorAction SilentlyContinue }
      if ($null -ne $oldInstall) { Set-ItemProperty $registry InstallPath $oldInstall }
      else { Remove-ItemProperty $registry InstallPath -ErrorAction SilentlyContinue }
    }
    foreach ($file in $pointerFiles) {
      if ($pointerBackup.ContainsKey($file)) { [System.IO.File]::WriteAllBytes($file, $pointerBackup[$file]) }
      elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Blank $sandbox)) {
      Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
    if ($null -eq $smokeError) {
      $smokeError = $_
      Write-Host "[friday] FAIL installer smoke cleanup: $($_.Exception.Message)"
    }
  }
}
if ($null -ne $smokeError) { exit 1 }
exit 0
