# FRIDAY - remove FRIDAY's own data from a source checkout that is also the FRIDAY folder.
#
# "Delete all FRIDAY data" normally removes the whole FRIDAY folder. When that folder is the Git checkout FRIDAY
# was built from, the folder also holds the owner's source code, Git history and build output, which are not FRIDAY
# data and must never be deleted by an uninstall. This keeps every source and shared folder and removes only what
# FRIDAY itself created: the data folders, downloaded model weights, the owner's settings and keys in config, and the
# index files at the root. A .gitkeep file is left in place so the checkout still has the folder layout it tracks.
#
# The folder lists below are pinned to electron/friday-contract.cjs (OWNERSHIP.data) and the config state files by
# core/__tests__/uninstall-source-root.test.ts.
param(
  [Parameter(Mandatory = $true)]
  [string]$Root
)

$ErrorActionPreference = 'SilentlyContinue'
$full = [IO.Path]::GetFullPath($Root).TrimEnd('\')

# Only a folder that is clearly a source checkout is handled here; anything else, and a drive root, is refused.
$isSource = (Test-Path -LiteralPath (Join-Path $full '.git')) -or (Test-Path -LiteralPath (Join-Path $full 'scripts\build-windows.cmd'))
if ($full.Length -le 3 -or -not $isSource) { exit 2 }

$dataFolders = @(
  'memory', 'conversations', 'brain-data', 'database', 'security', 'voices', 'downloads', 'logs', 'backup',
  'backups', 'temporary', 'library', 'knowledge', 'data', 'state', 'preferences', 'tasks', 'projects',
  'workspace', 'sandbox', 'browser', 'cache', 'runtime', 'updates', '.friday-dev'
)
$configState = @(
  'build-root.json', 'capabilities.json', 'connectors.json', 'dev-changesets.json', 'first-run.json',
  'friday-camera.json', 'friday-preferences.json', 'friday-screen-vision.json', 'friday-settings.json',
  'friday-storage.json', 'github.json', 'install-extensions.user.json', 'provider-access.json',
  'provider-endpoints.json', 'provider-keys.json'
)
$configFolders = @('user', 'security')
$rootFiles = @('inventory.json', 'integrity.json')
$weightPatterns = @('*.gguf', '*.bin', '*.onnx', '*.safetensors')

function Remove-Contents([string]$Folder) {
  if (-not (Test-Path -LiteralPath $Folder)) { return }
  Get-ChildItem -LiteralPath $Folder -Recurse -Force -File |
    Where-Object { $_.Name -ne '.gitkeep' } |
    Remove-Item -Force
  # Empty folders go, deepest first; a folder that still holds a .gitkeep stays.
  Get-ChildItem -LiteralPath $Folder -Recurse -Force -Directory |
    Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
    Remove-Item -Force
  if (-not (Get-ChildItem -LiteralPath $Folder -Force)) { Remove-Item -LiteralPath $Folder -Force }
}

foreach ($name in $dataFolders) { Remove-Contents (Join-Path $full $name) }
foreach ($name in $configFolders) { Remove-Contents (Join-Path $full "config\$name") }
foreach ($name in $configState) { Remove-Item -LiteralPath (Join-Path $full "config\$name") -Force }
foreach ($name in $rootFiles) { Remove-Item -LiteralPath (Join-Path $full $name) -Force }

$models = Join-Path $full 'models'
if (Test-Path -LiteralPath $models) {
  Get-ChildItem -LiteralPath $models -Recurse -Force -File -Include $weightPatterns | Remove-Item -Force
}
exit 0
