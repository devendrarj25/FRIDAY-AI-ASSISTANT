/**
 * Windows speech through the system voice. This builds the command.
 * It does not launch a process. A non-Windows host reports the voice absent.
 * A wave path makes the synthesizer write a file instead of speaking, so the
 * page can play that file once and the capture graph can cancel the echo.
 */

const NO_INDIAN_VOICE =
  "No Indian voice is installed. Windows Settings, Time and language, Speech, Add voices, Hindi (India).";

function sapiScript(text, options = {}) {
  // Single-quoted in PowerShell: `$`, backticks and `$(...)` in a reply stay text.
  const clean = String(text || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 400)
    .replace(/'/g, "''");
  const wav = String(options.wav || "").replace(/'/g, "''");
  const rate = Number(options.rate);
  const volume = Number(options.volume);
  const lines = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$pick = $null",
    "$indian = $false",
    "foreach ($v in $s.GetInstalledVoices()) {",
    "  $info = $v.VoiceInfo",
    "  $n = $info.Name",
    "  $g = [string]$info.Gender",
    "  if ($g -eq 'Female' -and $n -match 'Swara|Heera|Kalpana|Neerja') { $pick = $n; $indian = $true; break }",
    "}",
    "if (-not $pick) {",
    "  foreach ($v in $s.GetInstalledVoices()) {",
    "    $info = $v.VoiceInfo",
    "    $n = $info.Name",
    "    $c = [string]$info.Culture",
    "    $g = [string]$info.Gender",
    "    if ($g -eq 'Female' -and ($c -like 'hi*' -or $c -like 'en-IN*')) { $pick = $n; $indian = $true; break }",
    "  }",
    "}",
    "if (-not $pick) {",
    "  foreach ($v in $s.GetInstalledVoices()) {",
    "    $info = $v.VoiceInfo",
    "    if ([string]$info.Gender -eq 'Female') { $pick = $info.Name; break }",
    "  }",
    "}",
    "if ($pick) { try { $s.SelectVoice($pick) } catch { $pick = $null; $indian = $false } }",
    "if ($indian -and $pick) { Write-Output ('VOICE ' + $pick) } elseif ($pick) { Write-Output ('VOICE other ' + $pick) } else { Write-Output 'VOICE none-indian' }",
  ];
  if (Number.isFinite(rate)) {
    const sapiRate = Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)));
    lines.push(`$s.Rate = ${sapiRate}`);
  }
  if (Number.isFinite(volume)) {
    const vol = Math.max(0, Math.min(100, Math.round(volume * 100)));
    lines.push(`$s.Volume = ${vol}`);
  }
  if (wav) lines.push(`$s.SetOutputToWaveFile('${wav}')`);
  lines.push(`$s.Speak('${clean}')`);
  lines.push("$s.Dispose()");
  return lines.join("; ");
}

function sapiCommand(text, options) {
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    sapiScript(text, options || {}),
  ];
}

function sapiAvailable(platform = process.platform) {
  return platform === "win32";
}

module.exports = { sapiCommand, sapiAvailable, sapiScript, NO_INDIAN_VOICE };
