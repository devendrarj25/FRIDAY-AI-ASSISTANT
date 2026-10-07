/**
 * FRIDAY — in-app readiness test (real subsystems, no simulation).
 *
 * Runs inside the actual FRIDAY process — development binary, packaged
 * FRIDAY.exe or an installed copy — and exercises the same code paths the user
 * does:
 *
 *   START → BOOT → KERNEL → DATABASE → CHAT → VOICE → MODEL → BASIC TASK
 *
 * The shutdown/restart stages are owned by scripts/readiness-test.cjs, which
 * launches this twice. Every result comes from a live call; a stage can only
 * pass when the subsystem actually answered.
 */
const fs = require("node:fs");
const path = require("node:path");
const paths = require("./friday-paths.cjs");

const KERNEL_TIMEOUT = 60000;
/** How long the interface may take to mount before BOOT is declared failed. */
const MOUNT_TIMEOUT = 30000;

const stage = (name, ok, detail) => ({ name, ok: Boolean(ok), detail: detail || "" });

/**
 * Chat reached a local engine that is up but has no loaded weights (LM Studio
 * empty, Ollama id missing, connection attempts to a registered local route).
 * The pipeline is wired; Chat is not READY until a model answers.
 */
function isUnloadedLocalChat(error) {
  return /All connection attempts failed|No models loaded|does not expose this model id|model ['"][^'"]+['"] not found|Please load a model|lms load|no local \(offline\) model|no model available/i.test(
    String(error || ""),
  );
}

/** Is `child` inside `parent`? Used to prove nothing escapes the FRIDAY root. */
function inside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The canonical-root contract every other stage depends on: a selected root,
 * a reachable and writable folder, the canonical subfolders, the settings
 * pointer and a database that lives inside that folder.
 */
function verifyRootContract() {
  const root = paths.root();
  if (!root) return { ok: false, detail: "no FRIDAY folder is selected (first run must pick one)" };
  const verified = paths.verifyRoot(root);
  if (!verified.ok) return { ok: false, detail: verified.error };
  const required = [
    "config",
    "database",
    "memory",
    "state",
    "models",
    "logs",
    "cache",
    "runtime",
    "backups",
  ];
  const missing = required.filter((name) => !fs.existsSync(paths.dir(name)));
  if (missing.length)
    return { ok: false, detail: `canonical folders missing: ${missing.join(", ")}` };
  const db = paths.databaseFile();
  if (!inside(root, db)) return { ok: false, detail: `database is outside the root: ${db}` };
  return { ok: true, root, detail: `root ${root} · database ${db}` };
}

/**
 * @param ctx.win               the live BrowserWindow
 * @param ctx.waitForKernel     main-process kernel wait helper
 * @param ctx.kernelUrl         http://host:port
 * @param ctx.bridgeUrl         ws://host:port/bridge
 * @param ctx.getWebSocket      WebSocket implementation resolver used by chat
 * @param ctx.getWorkspaceRoot  workspace root accessor
 */
async function runReadiness(ctx) {
  const stages = [];
  const { win, waitForKernel, kernelUrl, kernelRequest, getWorkspaceRoot } = ctx;

  // ---------------------------------------------------------------- START
  const alive = Boolean(win && !win.isDestroyed());
  stages.push(stage("START", alive, alive ? "main window created" : "no window"));

  // ----------------------------------------------------------------- ROOT
  // Everything below depends on one selected FRIDAY folder. It is checked
  // first so a failure blocks the rest instead of letting a fallback pass.
  const rootContract = verifyRootContract();
  stages.push(stage("ROOT", rootContract.ok, rootContract.detail));

  // ----------------------------------------------------------------- BOOT
  let mounted = { mounted: false, reason: "window unavailable" };
  if (alive) {
    // React mounts a frame or two after the window reports "loaded", and the
    // boot screen itself renders progressively. A single snapshot therefore
    // used to fail with "app root is empty" even though the interface came up
    // milliseconds later — so poll until it mounts or the budget runs out.
    const deadline = Date.now() + MOUNT_TIMEOUT;
    for (;;) {
      try {
        if (win.webContents.isLoading()) {
          await new Promise((resolve) => {
            const done = () => resolve();
            win.webContents.once("did-finish-load", done);
            setTimeout(done, 2_000);
          });
        }
        mounted = await win.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('#root');
        if (!root || !root.childElementCount) return { mounted: false, reason: 'app root is empty' };
        const painted = root.querySelectorAll('*').length;
        const chars = (document.body.innerText || '').trim().length;
        if (painted < 5 || chars < 3) return { mounted: false, reason: 'interface rendered no content' };
        return { mounted: true, painted, chars };
      })()`);
      } catch (error) {
        mounted = { mounted: false, reason: String(error.message || error) };
      }
      if (mounted.mounted || Date.now() >= deadline || win.isDestroyed()) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!mounted.mounted && mounted.reason) {
      mounted.reason = `${mounted.reason} after ${Math.round(MOUNT_TIMEOUT / 1000)}s`;
    }
  }
  // BOOT is only true when the interface mounted AND the single-root contract
  // holds. A ready-looking window on top of a missing root is not a boot.
  const bootOk = mounted.mounted && rootContract.ok;
  stages.push(
    stage(
      "BOOT",
      bootOk,
      mounted.mounted
        ? rootContract.ok
          ? `interface mounted (${mounted.painted} nodes) · ${rootContract.detail}`
          : `interface mounted but the FRIDAY root is not usable: ${rootContract.detail}`
        : mounted.reason,
    ),
  );

  // Without a usable root every downstream subsystem is blocked, not passing:
  // reporting them from a fallback folder would hide a second data store.
  if (!rootContract.ok) {
    for (const name of ["KERNEL", "DATABASE", "MODEL", "CHAT", "VOICE", "BASIC TASK"]) {
      stages.push(stage(name, false, `BLOCKED — ${rootContract.detail}`));
    }
    return { ok: false, stages, at: Date.now() };
  }
  // --------------------------------------------------------------- KERNEL
  // Without a verified root the kernel must not be running at all; reporting
  // PASS here would hide a second data store outside the FRIDAY folder.
  const kernelOk = rootContract.ok ? await waitForKernel(KERNEL_TIMEOUT) : false;
  let kernelDetail = rootContract.ok
    ? kernelOk
      ? "kernel responding"
      : "kernel did not answer /health"
    : "kernel not started — no usable FRIDAY root";
  let models = [];
  let kernelRooted = kernelOk;
  if (kernelOk) {
    try {
      const health = await (await fetch(`${kernelUrl}/health`)).json();
      models = health.models || [];
      kernelRooted = inside(rootContract.root, health.data_dir || "");
      kernelDetail = kernelRooted
        ? `kernel ${health.version || "?"} · data ${health.data_dir || "?"}`
        : `kernel stores data outside the FRIDAY root: ${health.data_dir || "?"}`;
    } catch (error) {
      kernelRooted = false;
      kernelDetail = `health payload unreadable: ${error.message}`;
    }
  }
  stages.push(stage("KERNEL", kernelOk && kernelRooted, kernelDetail));

  // Every subsystem below is exercised through the same bridge the UI uses.
  const call = async (method, params = {}, timeout) => {
    if (!kernelOk) return { ok: false, error: "kernel is not running" };
    try {
      return { ok: true, result: await kernelRequest(method, params, timeout) };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  };

  // ------------------------------------------------------------- DATABASE
  // A real write/read round-trip through the kernel's SQLite storage.
  const token = `readiness-${Date.now()}`;
  const wrote = await call("settings.set", { key: "friday.readiness", value: token });
  const readBack = wrote.ok ? await call("settings.get", {}) : { ok: false };
  const settings = readBack.ok ? readBack.result?.settings || readBack.result || {} : {};
  const dbOk = wrote.ok && settings["friday.readiness"] === token;
  stages.push(
    stage(
      "DATABASE",
      dbOk,
      dbOk ? "settings write/read verified" : wrote.error || "round-trip failed",
    ),
  );

  // ---------------------------------------------------------------- MODEL
  const modelList = await call("model.list", {});
  const available = modelList.ok ? modelList.result?.models || [] : models;
  // A registry that answers with an empty catalogue is NOT a usable model
  // route — MODEL only passes when at least one model is actually registered.
  stages.push(
    stage(
      "MODEL",
      modelList.ok && available.length > 0,
      modelList.ok
        ? `${available.length} model(s) registered${available.length ? "" : " — add one in Models"}`
        : modelList.error,
    ),
  );

  // ----------------------------------------------------------------- CHAT
  // Chat is verified as a real pipeline call and nothing else. A pipeline that
  // replies "no model available" is a reachable pipeline with no usable
  // inference route, which is DEGRADED — never READY.
  //
  // The readiness test does NOT require the internet. It only requires ONE
  // working route. A local model (Ollama/llama.cpp) passes this stage with the
  // network cable unplugged; the internet is only involved when the sole ready
  // model is a cloud provider. So the failure must say which of the two it is:
  // a DNS/transport problem is an environment issue, an inference failure is a
  // model/pipeline issue, and they need opposite fixes.
  const chat = await call(
    "chat.stream",
    { sessionId: "readiness", prompt: "FRIDAY readiness check: reply with OK." },
    90000,
  );
  const chatError = String(chat.error || "chat produced no answer");
  const networkFailure =
    /getaddrinfo|name resolution|nodename nor servname|dns|connection refused|connection reset|network is unreachable|no route to host|proxy|certificate|ssl|timed out|timeout/i.test(
      chatError,
    );
  const noLocalRoute = /no local \(offline\) model/i.test(chatError);
  const unloadedLocal = isUnloadedLocalChat(chatError);
  stages.push(
    stage(
      "CHAT",
      chat.ok,
      chat.ok
        ? "chat pipeline answered"
        : unloadedLocal
          ? `no loaded answering model — Chat is wired; load a local model or add a free-tier key: ${chatError}`
          : networkFailure
            ? `network problem reaching the model provider${
                noLocalRoute ? " and no local model to fall back to" : ""
              } — chat itself is wired correctly. Check the connection, or install a local model in Models so chat works offline: ${chatError}`
            : `inference failed on a reachable route — the request got to a model and it did not answer: ${chatError}`,
    ),
  );

  // ---------------------------------------------------------------- VOICE
  let voice = { ok: false, detail: "renderer unavailable" };
  if (alive) {
    try {
      voice = await win.webContents.executeJavaScript(`(() => {
        const synth = typeof window.speechSynthesis !== 'undefined';
        const recog = typeof window.SpeechRecognition !== 'undefined' || typeof window.webkitSpeechRecognition !== 'undefined';
        return { ok: synth, detail: 'speech synthesis ' + (synth ? 'available' : 'missing') + ', recognition ' + (recog ? 'available' : 'missing') };
      })()`);
    } catch (error) {
      voice = { ok: false, detail: String(error.message || error) };
    }
  }
  stages.push(stage("VOICE", voice.ok, voice.detail));

  // ----------------------------------------------------------- BASIC TASK
  // The smallest real end-to-end unit of work: list the kernel's tools and run
  // a workspace read through the same tool path the assistant uses.
  const tools = await call("tool.list", {});
  const workspace = await call("workspace.get", {});
  const taskOk = tools.ok && workspace.ok;
  stages.push(
    stage(
      "BASIC TASK",
      taskOk,
      taskOk
        ? `${(tools.result?.tools || []).length} tool(s) · workspace ${workspace.result?.root || getWorkspaceRoot() || "unset"}`
        : tools.error || workspace.error,
    ),
  );

  return { ok: stages.every((s) => s.ok), stages, at: Date.now() };
}

module.exports = { runReadiness, isUnloadedLocalChat };
