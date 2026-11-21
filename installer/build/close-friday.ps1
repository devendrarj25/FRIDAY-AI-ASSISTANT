param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  # Delete-everything uninstall: the whole FRIDAY folder. Anything that runs from it, or has it as its current
  # directory, is stopped too, so the folder can really be removed afterwards.
  [string]$ReleaseRoot = '',
  [int]$GraceSeconds = 10,
  [int]$ForceSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'

# Setup is a 32-bit program, so the PowerShell it starts from System32 is the 32-bit one, which cannot read the
# current directory of a 64-bit process. Run this same script again in the 64-bit PowerShell and return its result.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  $native = Join-Path $env:SystemRoot 'sysnative\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $native -PathType Leaf) {
    $again = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
      '-InstallDir', $InstallDir, '-GraceSeconds', [string]$GraceSeconds, '-ForceSeconds', [string]$ForceSeconds)
    if ($ReleaseRoot) { $again += @('-ReleaseRoot', $ReleaseRoot) }
    & $native @again
    exit $LASTEXITCODE
  }
}

$installRoot = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$fridayExe = Join-Path $installRoot 'FRIDAY.exe'
$roots = @($installRoot)
if ($ReleaseRoot) {
  $extra = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
  if ($extra -and ($roots -notcontains $extra)) { $roots += $extra }
}

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

# A program FRIDAY started and left running (Ollama, a runner, a terminal tool) inherits FRIDAY's current directory,
# which is the program folder, and keeps that folder (and the FRIDAY folder around it) from being deleted: Windows
# answers "try again" even when every file inside is gone. Its current directory is read from the process itself.
# Shells, file managers and editors are never stopped for that: they belong to the owner.
$ownerNames = @(
  'cmd', 'powershell', 'pwsh', 'conhost', 'openconsole', 'windowsterminal', 'wt', 'explorer', 'code', 'devenv',
  'notepad', 'notepad++', 'sublime_text', 'bash', 'mintty', 'wsl', 'wslhost', 'git-bash', 'rider64', 'idea64',
  'pycharm64', 'taskmgr', 'procexp', 'procexp64', 'searchindexer', 'msedge', 'chrome', 'firefox'
)
$cwdReader = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FridayCwd {
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation {
    public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask;
    public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref ProcessBasicInformation info, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  // x64 layout: PEB.ProcessParameters at 0x20, RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath at 0x38.
  public static string Get(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      ProcessBasicInformation info = new ProcessBasicInformation();
      int returned;
      if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) != 0) return null;
      if (info.PebBaseAddress == IntPtr.Zero) return null;
      byte[] pointer = new byte[8];
      IntPtr read;
      if (!ReadProcessMemory(handle, IntPtr.Add(info.PebBaseAddress, 0x20), pointer, (IntPtr)8, out read)) return null;
      IntPtr parameters = (IntPtr)BitConverter.ToInt64(pointer, 0);
      if (parameters == IntPtr.Zero) return null;
      byte[] unicode = new byte[16];
      if (!ReadProcessMemory(handle, IntPtr.Add(parameters, 0x38), unicode, (IntPtr)16, out read)) return null;
      int length = BitConverter.ToUInt16(unicode, 0);
      IntPtr buffer = (IntPtr)BitConverter.ToInt64(unicode, 8);
      if (length <= 0 || length > 8192 || buffer == IntPtr.Zero) return null;
      byte[] text = new byte[length];
      if (!ReadProcessMemory(handle, buffer, text, (IntPtr)length, out read)) return null;
      return System.Text.Encoding.Unicode.GetString(text);
    } catch { return null; } finally { CloseHandle(handle); }
  }
}
'@
  $cwdReader = $true
} catch {
  $cwdReader = $false
}
$cwdCache = @{}

function Test-UnderRoots([string]$Path) {
  if (-not $Path) { return $false }
  try { $full = [IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $false }
  foreach ($root in $roots) {
    if ([string]::Equals($full, $root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Test-CwdHolder($Process) {
  if (-not $cwdReader) { return $false }
  $id = [int]$Process.ProcessId
  if ($id -le 4 -or $ancestors.ContainsKey($id)) { return $false }
  $base = [IO.Path]::GetFileNameWithoutExtension([string]$Process.Name).ToLowerInvariant()
  if ($ownerNames -contains $base) { return $false }
  if (-not $cwdCache.ContainsKey($id)) { $cwdCache[$id] = [FridayCwd]::Get($id) }
  return (Test-UnderRoots $cwdCache[$id])
}

function Test-FridayWorker($Process) {
  if (-not $Process.CommandLine) { return $false }
  if ($ancestors.ContainsKey([int]$Process.ProcessId)) { return $false }
  $base = [IO.Path]::GetFileNameWithoutExtension([string]$Process.Name).ToLowerInvariant()
  if ($workerNames -notcontains $base) { return $false }
  return $Process.CommandLine.IndexOf($programPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-FridayProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    if ($ancestors.ContainsKey([int]$_.ProcessId)) { return $false }
    ($_.ExecutablePath -and
    ([string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $fridayExe, [StringComparison]::OrdinalIgnoreCase) -or
      (Test-UnderRoots $_.ExecutablePath))) -or
    (Test-FridayWorker $_) -or
    (Test-CwdHolder $_)
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

# Only trees rooted at the installed FRIDAY.exe, Python or Node started on a file inside the program folder, programs
# that run from the folders being released and programs that stand in them are forced; unrelated Electron, Python,
# Node and browser processes, and the owner's shells and editors, are never selected by this script.
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
