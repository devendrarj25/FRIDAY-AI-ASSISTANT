/**
 * Locate the pinned whisper.cpp binary and ggml base file.
 * This module does not download and does not spawn the binary.
 */
const fs = require("fs");
const path = require("path");

function locateFrom(roots) {
  const list = Array.isArray(roots) ? roots.filter(Boolean) : [];
  let cli = null;
  let model = null;
  for (const root of list) {
    const cliCandidates = [
      path.join(root, "runtime", "whisper.cpp", "Release", "whisper-cli.exe"),
      path.join(root, "Release", "whisper-cli.exe"),
      path.join(root, "whisper-cli.exe"),
      path.join(root, "runtime", "whisper.cpp", "whisper-cli"),
    ];
    const modelCandidates = [
      path.join(root, "runtime", "ggml-base", "ggml-base.bin"),
      path.join(root, "ggml-base.bin"),
    ];
    if (!cli) cli = cliCandidates.find((file) => fs.existsSync(file)) || null;
    if (!model) model = modelCandidates.find((file) => fs.existsSync(file)) || null;
  }
  if (!cli || !model) return null;
  return { cli, model };
}

function transcribeArgv(cli, model, wav) {
  return [cli, "-m", model, "-f", wav, "--no-prints"];
}

function parseWhisperText(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => line && !/^whisper_/i.test(line))
    .join(" ")
    .trim();
}

module.exports = { locateFrom, transcribeArgv, parseWhisperText };
