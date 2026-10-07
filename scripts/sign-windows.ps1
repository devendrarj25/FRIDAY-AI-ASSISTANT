# FRIDAY - Windows code-signing helper
#
# Gives the FRIDAY executables a real Authenticode signature so Windows shows
# "Devendra Singh Meena (devendrarj25)" as the publisher instead of
# "Unknown publisher".
#
# Production mode requires a CA-issued PFX. Self-signing is available only
# when a developer explicitly passes -AllowSelfSigned for local testing.
# GitHub Actions and scripts/build-windows.cmd never pass -AllowSelfSigned.
#
# Usage (PowerShell as Administrator, from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -PfxPath C:\certs\friday.pfx -PfxPassword "secret"
#   powershell -ExecutionPolicy Bypass -File scripts/sign-windows.ps1 -AllowSelfSigned

param(
  [string]$Subject   = "CN=Devendra Singh Meena (devendrarj25), O=FRIDAY, C=IN",
  [string]$PfxPath   = $env:CSC_LINK,
  [string]$PfxPassword = $env:CSC_KEY_PASSWORD,
  [string]$TargetDir = "release",
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [string]$ExpectedPublisher = "",
  [switch]$AllowSelfSigned
)

$ErrorActionPreference = "Stop"

function Get-SignTool {
  $candidates = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "x64" } | Sort-Object FullName -Descending
  if (-not $candidates) {
    throw "signtool.exe not found. Install the Windows 10/11 SDK (Signing Tools component)."
  }
  return $candidates[0].FullName
}

$signtool = Get-SignTool
Write-Host "signtool: $signtool"

if (-not $PfxPath) {
  if (-not $AllowSelfSigned) {
    throw "A CA-issued PFX is required. Pass -PfxPath, or use -AllowSelfSigned only for local development."
  }
  # --- Self-signed certificate -------------------------------------------
  $cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1

  if (-not $cert) {
    Write-Host "Creating self-signed code-signing certificate..."
    $cert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $Subject `
      -KeyUsage DigitalSignature `
      -KeyAlgorithm RSA -KeyLength 4096 `
      -CertStoreLocation Cert:\CurrentUser\My `
      -NotAfter (Get-Date).AddYears(5)
  }

  # Trust it on this machine so Windows stops calling the app "Unknown publisher".
  $tmp = Join-Path $env:TEMP "friday-codesign.cer"
  Export-Certificate -Cert $cert -FilePath $tmp | Out-Null
  Import-Certificate -FilePath $tmp -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $tmp -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
  Remove-Item $tmp -Force

  $thumb = $cert.Thumbprint
  $signArgs = @("sign", "/sha1", $thumb, "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
} else {
  if (-not (Test-Path $PfxPath)) { throw "PFX not found: $PfxPath" }
  $signArgs = @("sign", "/f", $PfxPath, "/p", $PfxPassword, "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
}

$targets = Get-ChildItem $TargetDir -Recurse -Include *.exe -ErrorAction SilentlyContinue
if (-not $targets) { throw "No .exe found under '$TargetDir'. Build first: npm run desktop:build" }

foreach ($exe in $targets) {
  Write-Host "signing $($exe.FullName)"
  & $signtool @signArgs $exe.FullName
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $($exe.FullName)" }
  & $signtool verify /pa /v $exe.FullName | Out-Null
  $signature = Get-AuthenticodeSignature $exe.FullName
  if ($signature.Status -ne "Valid") { throw "Invalid Authenticode signature on $($exe.FullName): $($signature.Status)" }
  if ($ExpectedPublisher -and $signature.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") {
    throw "Unexpected publisher on $($exe.FullName): $($signature.SignerCertificate.Subject)"
  }
}

Write-Host "All FRIDAY executables signed."
