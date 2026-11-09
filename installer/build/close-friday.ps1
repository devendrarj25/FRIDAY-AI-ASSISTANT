param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [int]$GraceSeconds = 10,
  [int]$ForceSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'
$installRoot = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$fridayExe = Join-Path $installRoot 'FRIDAY.exe'

# Setup or the uninstaller started this script, so it and every process above it are never selected.
function Get-AncestorIds {
  $ids = @{}
  $id = $PID
  for ($i = 0; $i -lt 8 -and $id; $i++) {
    $ids[[int]$id] = $true
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$id" | Select-Object -First 1
    if (-not $row) { break }
    $id = [int]$row.ParentProcessId
    if ($ids.ContainsKey($id)) { break }
  }
  return $ids
}
$ancestors = Get-AncestorIds
$programPrefix = "$installRoot\"
# Interpreters FRIDAY starts on its own files. Their executable can live outside the program folder (a system
# Python or Node), but their command line names a file inside it, and they start with the program folder as their
# current directory, which keeps an empty "<root>\App" alive after an uninstall.
$workerNames = @('python', 'pythonw', 'node')

function Test-FridayWorker($Process) {
  if (-not $Process.CommandLine) { return $false }
  if ($ancestors.ContainsKey([int]$Process.ProcessId)) { return $false }
  $base = [IO.Path]::GetFileNameWithoutExtension([string]$Process.Name).ToLowerInvariant()
  if ($workerNames -notcontains $base) { return $false }
  return $Process.CommandLine.IndexOf($programPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-FridayProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and
    ([string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $fridayExe, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith("$installRoot\", [StringComparison]::OrdinalIgnoreCase))) -or
    (Test-FridayWorker $_)
  })
}

function Stop-FridayTrees([bool]$Force) {
  foreach ($process in Get-FridayProcesses) {
    $arguments = @('/PID', [string]$process.ProcessId, '/T')
    if ($Force) { $arguments += '/F' }
    Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList $arguments -WindowStyle Hidden -Wait | Out-Null
  }
}

function Test-ExclusiveFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Test-FridayReleased {
  if ((Get-FridayProcesses).Count -gt 0) { return $false }
  $lockTargets = @(
    $fridayExe,
    (Join-Path $installRoot 'resources\app.asar'),
    (Join-Path $installRoot 'resources\electron.asar')
  )
  foreach ($target in $lockTargets) {
    if (-not (Test-ExclusiveFile $target)) { return $false }
  }
  return $true
}

Stop-FridayTrees $false
$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-FridayReleased) { exit 0 }
  Start-Sleep -Milliseconds 250
}

# Only trees rooted at the installed FRIDAY.exe, and Python or Node started on a file inside the program folder,
# are forced; unrelated Electron, Python, Node and browser processes are never selected by this script.
Stop-FridayTrees $true
$deadline = (Get-Date).AddSeconds($ForceSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-FridayReleased) { exit 0 }
  Start-Sleep -Milliseconds 250
}

# Final verdict is based on processes only. A lingering exclusive-open failure
# (antivirus / indexer scanning the folder) must not block Setup or Uninstall
# once every FRIDAY process is gone.
if ((Get-FridayProcesses).Count -eq 0) { exit 0 }
exit 1