/**
 * Locate the pinned whisper.cpp files and keep one local server warm.
 * Nothing here downloads. A process starts only when the caller passes spawn.
 */
const fs = require("fs");
const path = require("path");

const WHISPER_PORT = 8177;

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
  const serverName = process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
  const serverCandidate = path.join(path.dirname(cli), serverName);
  const server = fs.existsSync(serverCandidate) ? serverCandidate : null;
  return { cli, model, server };
}

function serverArgv(server, model, port = WHISPER_PORT) {
  return [server, "-m", model, "--host", "127.0.0.1", "--port", String(port)];
}

function createWhisperSession({ binary, cli, model, spawn, clock, health, port } = {}) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  const listenPort = port || WHISPER_PORT;
  let child = null;
  let mode = "cli";
  let startedAt = 0;
  let chain = Promise.resolve();
  return {
    mode: () => mode,
    async start() {
      startedAt = now();
      if (!binary || typeof spawn !== "function") return { ok: false, mode: "cli" };
      try {
        child = spawn(serverArgv(binary, model, listenPort));
      } catch {
        child = null;
        mode = "cli";
        return { ok: false, mode: "cli" };
      }
      const ok = typeof health === "function" ? await health() : false;
      if (!ok) {
        this.stop();
        return { ok: false, mode: "cli", latencyMs: Math.max(0, now() - startedAt) };
      }
      mode = "server";
      return {
        ok: true,
        mode: "server",
        argv: serverArgv(binary, model, listenPort),
        latencyMs: Math.max(0, now() - startedAt),
      };
    },
    submit(wav) {
      const run = () => {
        const at = now();
        if (mode !== "server") {
          return {
            mode: "cli",
            argv: transcribeArgv(cli, model, wav),
            latencyMs: Math.max(0, at - startedAt),
          };
        }
        return {
          mode: "server",
          url: `http://127.0.0.1:${listenPort}/inference`,
          latencyMs: Math.max(0, at - startedAt),
          queued: true,
        };
      };
      const job = chain.then(run, run);
      chain = job.then(
        () => undefined,
        () => undefined,
      );
      return job;
    },
    stop() {
      if (child && typeof child.kill === "function") child.kill();
      child = null;
      mode = "cli";
      return { stopped: true, mode };
    },
  };
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

module.exports = {
  locateFrom,
  transcribeArgv,
  parseWhisperText,
  serverArgv,
  createWhisperSession,
  WHISPER_PORT,
};
