// FRIDAY · tools/media/ffmpeg-transcode
const path = require("node:path");
const { spawn } = require("node:child_process");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

function whichFfmpeg() {
  const { execFileSync } = require("node:child_process");
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return String(out).trim().split(/\r?\n/).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

function runFfmpeg(args, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { cwd, windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.slice(-4000) });
    });
  });
}

async function run(input = {}) {
  const exe = whichFfmpeg();
  if (!exe) {
    return {
      ok: false,
      error: "ffmpeg is not on PATH. Install FFmpeg from the Install Manager, then retry.",
    };
  }
  if (input.probe) return { ok: true, probe: true, ffmpeg: exe };
  const src = String(input.input || input.path || "").trim();
  const dest = String(input.output || "").trim();
  if (!src || !dest) return { ok: false, error: "input and output paths are required." };
  const extra = Array.isArray(input.args) ? input.args.map(String) : [];
  const cwd = input.root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
  return runFfmpeg(["-y", "-i", src, ...extra, dest], cwd);
}

module.exports = { run };
