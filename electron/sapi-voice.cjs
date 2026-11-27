/**
 * Windows speech through the system voice. This builds the command.
 * It does not launch a process. A non-Windows host reports the voice absent.
 * A wave path makes the synthesizer write a file instead of speaking, so the
 * page can play that file once and the capture graph can cancel the echo.
 */

const NO_INDIAN_VOICE =
  "No Indian voice is installed. Windows Settings, Time and language, Speech, Add voices, Hindi (India).";

// PowerShell ends a single-quoted string on any of these, not only the ASCII one
// (about_Quoting_Rules). Each becomes an ASCII quote, then every quote is doubled.
const PS_SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
// C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// A surrogate half with no partner cannot be passed on a Windows command line intact.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One PowerShell single-quoted literal body: `$`, backticks and `$(...)` stay text. */
function psLiteral(value, maxChars) {
  let clean = String(value || "")
    .replace(LONE_SURROGATE, "")
    .replace(CONTROL_CHARS, " ");
  if (maxChars) clean = Array.from(clean).slice(0, maxChars).join("");
  return clean.replace(PS_SINGLE_QUOTES, "'").replace(/'/g, "''");
}

function sapiScript(text, options = {}) {
  const clean = psLiteral(text, 400);
  const wav = psLiteral(options.wav);
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
