param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [int]$GraceSeconds = 10,
  [int]$ForceSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'
$installRoot = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$fridayExe = Join-Path $installRoot 'FRIDAY.exe'

function Get-FridayProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    ([string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $fridayExe, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith("$installRoot\", [StringComparison]::OrdinalIgnoreCase))
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

# Only trees rooted at the installed FRIDAY.exe are forced; unrelated Electron,
# Python, Node and browser processes are never selected by this script.
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