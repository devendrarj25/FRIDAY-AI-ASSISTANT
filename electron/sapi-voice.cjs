/**
 * Windows speech through the system voice. This builds the command.
 * It does not launch a process. A non-Windows host reports the voice absent.
 */

function sapiCommand(text) {
  const clean = String(text || "")
    .replace(/[\r\n"]/g, " ")
    .slice(0, 400);
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak("${clean}")`,
  ];
}

function sapiAvailable(platform = process.platform) {
  return platform === "win32";
}

module.exports = { sapiCommand, sapiAvailable };
