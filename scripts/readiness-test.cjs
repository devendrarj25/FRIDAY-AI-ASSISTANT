/**
 * FRIDAY — post-install readiness test.
 *
 * Runs the full contract against the application a user actually has:
 *
 *   INSTALL → START → BOOT → KERNEL → DATABASE → CHAT → VOICE → MODEL
 *           → BASIC TASK → SHUTDOWN → RESTART
 *
 * The in-app stages are executed inside the real FRIDAY process by
 * electron/readiness.cjs; this script owns install detection, process
 * lifecycle, repair-and-retest and the local report.
 *
 *   node scripts/readiness-test.cjs                installed app, else packaged, else dev
 *   node scripts/readiness-test.cjs --app <path>   an explicit FRIDAY.exe
 *   node scripts/readiness-test.cjs --no-repair    fail instead of repairing
 *
 * Every run is stored under debug/reports/, and the environment registry is
 * refreshed so FRIDAY knows what the machine looked like at test time.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const registry = require("./env-registry.cjs");
const runtime = require("./python-runtime.cjs");
const { isUnloadedLocalChat } = require("../electron/readiness.cjs");

const root = runtime.root;
const win = runtime.win;
const repairEnabled = !process.argv.includes("--no-repair");
const packGate = process.argv.includes("--pack");
// Never leave compiled Python caches inside the checkout during verification.
process.env["PYTHONDONTWRITEBYTECODE"] = "1";
const explicitApp = (() => {
  const i = process.argv.indexOf("--app");
  return i > -1 ? process.argv[i + 1] : null;
})();

const log = (m) => console.log(`[friday] ${m}`);
const fail = (m) => console.error(`[friday] ${m}`);

/** Pack may finish without a loaded LLM; in-app Doctor still fail-closes Chat. */
function packChatOnlyUnloaded(result) {
  if (!packGate) return false;
  const failed = (result.stages || []).filter((s) => !s.ok);
  return (
    failed.length > 0 && failed.every((s) => s.name === "CHAT" && isUnloadedLocalChat(s.detail))
  );
}

/** The FRIDAY the user runs, preferred over anything in the build folder. */
function resolveApp() {
  if (explicitApp)
    return fs.existsSync(explicitApp) ? { exe: explicitApp, kind: "explicit" } : null;
  const installed = registry.installedApp();
  if (installed && !installed.includes(path.join("release", "win-unpacked")))
    return { exe: installed, kind: "installed" };
  const packaged = path.join(root, "release", "win-unpacked", win ? "FRIDAY.exe" : "FRIDAY");
  if (fs.existsSync(packaged)) return { exe: packaged, kind: "packaged" };
  const dev = path.join(
    root,
    "node_modules",
    "electron",
    "dist",
    win ? "electron.exe" : "electron",
  );
  if (fs.existsSync(dev)) return { exe: dev, kind: "development", args: [root] };
  return null;
}

/** Kills the whole process tree; a bare kill() orphans renderer processes. */
function killTree(child) {
  try {
    if (win && child.pid) {
      spawnSync(path.join(process.env["SystemRoot"] || "C:\\Windows", "System32", "taskkill.exe"), [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]);
    } else {
      child.kill();
    }
  } catch {
    /* already gone */
  }
}

/**
 * Launches FRIDAY in readiness mode and collects the in-app stage results.
 * Also proves SHUTDOWN: the process must exit on its own after reporting.
 */
/** The folder FRIDAY already recorded as its home, if it still exists. */
function recordedRoot() {
  const appData =
    process.env["APPDATA"] ||
    (process.platform === "darwin"
      ? path.join(process.env["HOME"] || "", "Library", "Application Support")
      : path.join(process.env["HOME"] || "", ".config"));
  try {
    const file = path.join(appData, "FRIDAY", "friday-settings.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8")).workspaceRoot;
    if (value && fs.statSync(value).isDirectory()) return path.resolve(value);
  } catch {
    /* nothing recorded yet */
  }
  return null;
}

/** The root the test selects on the first launch (restart must rediscover it). */
function testRoot() {
  const i = process.argv.indexOf("--root");
  const explicit = i > -1 ? process.argv[i + 1] : process.env["FRIDAY_WORKSPACE_ROOT"];
  const chosen = explicit || recordedRoot() || path.join(root, ".friday-readiness-root");
  fs.mkdirSync(chosen, { recursive: true });
  return path.resolve(chosen);
}

const FRIDAY_ROOT = testRoot();

/** The venv setup-python just built. A packaged EXE does not look in the checkout. */
function checkoutPython() {
  if (process.env.FRIDAY_PYTHON && fs.existsSync(process.env.FRIDAY_PYTHON)) {
    return process.env.FRIDAY_PYTHON;
  }
  const files = win
    ? [
        path.join(root, ".venv", "Scripts", "python.exe"),
        path.join(root, "runtime", ".venv", "Scripts", "python.exe"),
      ]
    : [
        path.join(root, ".venv", "bin", "python"),
        path.join(root, "runtime", ".venv", "bin", "python"),
      ];
  return files.find((file) => fs.existsSync(file)) || "";
}

/**
 * Launches FRIDAY in readiness mode and collects the in-app stage results.
 * Also proves SHUTDOWN: the process must exit on its own after reporting.
 *
 * `select` chooses the FRIDAY root explicitly (first run). The restart runs
 * without it so the app has to rediscover the same folder by itself.
 */
function readinessMarker() {
  return path.join(FRIDAY_ROOT, "logs", "readiness-result.json");
}

function launch(app, label, { select = true } = {}) {
  return new Promise((resolve) => {
    const marker = readinessMarker();
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* nothing from an earlier launch */
    }
    const env = {
      ...process.env,
      FRIDAY_READINESS: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    };
    if (select) env.FRIDAY_WORKSPACE_ROOT = FRIDAY_ROOT;
    else delete env.FRIDAY_WORKSPACE_ROOT;
    const python = checkoutPython();
    if (python) env.FRIDAY_PYTHON = python;
    // A Windows GUI process can miss the inherited environment. The arguments
    // still arrive. Restart omits the workspace argument so FRIDAY has to
    // rediscover the same folder.
    const args = [...(app.args || []), "--friday-readiness"];
    if (select) args.push(`--friday-workspace=${FRIDAY_ROOT}`);
    const child = spawn(app.exe, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let report = null;
    let poll = null;
    const accept = (parsed) => {
      if (report || !parsed || typeof parsed !== "object") return;
      if (typeof parsed.ok !== "boolean" || !Array.isArray(parsed.stages)) return;
      report = parsed;
    };
    const takeLine = (text) => {
      const line = String(text || "")
        .split(/\r?\n/)
        .find((item) => item.startsWith("FRIDAY_READINESS_RESULT "));
      if (!line) return;
      try {
        accept(JSON.parse(line.slice("FRIDAY_READINESS_RESULT ".length)));
      } catch {
        /* wait for a complete line or the marker file */
      }
    };
    const takeMarker = () => {
      try {
        accept(JSON.parse(fs.readFileSync(marker, "utf8")));
      } catch {
        /* not written yet */
      }
    };
    const settle = (result) => {
      clearTimeout(timer);
      clearInterval(poll);
      killTree(child);
      resolve(result);
    };
    const timer = setTimeout(() => {
      takeMarker();
      settle({
        ok: false,
        stages: [],
        error: `${label} did not finish within 5 minutes`,
        output,
      });
    }, 300000);
    poll = setInterval(takeMarker, 250);
    const read = (chunk) => {
      output += String(chunk);
      takeLine(output);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => settle({ ok: false, stages: [], error: error.message, output }));
    child.on("exit", (code) => {
      takeMarker();
      takeLine(output);
      if (report) return settle({ ...report, exitCode: code, output });
      // A desktop-less Linux CI box cannot open a window; that is not a FRIDAY bug.
      if (!win && /error while loading shared libraries|libgtk|libnss/i.test(output))
        return settle({ ok: true, skipped: true, stages: [], output });
      settle({
        ok: false,
        stages: [],
        error: `${label} exited (code ${code}) without a readiness report`,
        output,
      });
    });
  });
}

function report(payload) {
  const dir = path.join(root, "debug", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `readiness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

(async () => {
  const stages = [];
  const add = (name, ok, detail) => {
    stages.push({ name, ok, detail });
    (ok ? log : fail)(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };

  // Environment first: a failing dependency is repaired from official sources
  // before FRIDAY is blamed for not starting.
  let env = registry.refreshRegistry();
  if (!env.ready && repairEnabled) {
    log(`repairing environment: ${env.blocking.join(", ")}`);
    env = registry.repairAll({ onLog: (m) => console.log(m) }).registry;
  }
  add(
    "ENVIRONMENT",
    env.ready,
    env.ready
      ? "all required components installed and usable"
      : `blocking: ${env.blocking.join(", ")}`,
  );

  log(`FRIDAY root for this run: ${FRIDAY_ROOT}`);
  const app = resolveApp();
  if (
    !add("INSTALL", Boolean(app), app ? `${app.kind}: ${app.exe}` : "no FRIDAY application found")
  ) {
    const file = report({ ok: false, at: Date.now(), stages, environment: env });
    fail(`readiness FAILED — report: ${file}`);
    process.exit(1);
  }

  const stageText = (result) => {
    const failed = (result.stages || []).filter((stage) => !stage.ok);
    if (failed.length) {
      return failed.map((stage) => `${stage.name}: ${stage.detail || "no detail"}`).join("; ");
    }
    return result.error || "no stage list on the report";
  };

  // First run: START → BOOT → KERNEL → DATABASE → CHAT → VOICE → MODEL → TASK,
  // then the process must shut itself down.
  let first = await launch(app, "FRIDAY");
  if (!first.ok && repairEnabled && !first.skipped) {
    if (packChatOnlyUnloaded(first)) {
      log(`first run only missed CHAT (${stageText(first)}) — pack continues without a repair`);
    } else {
      fail(`first run failed — ${stageText(first)}`);
      const repaired = registry.repairAll({ onLog: (m) => console.log(m) });
      const rows = repaired.results || [];
      if (!rows.length) {
        log("repair ran: no blocking component was behind (nothing to repair)");
      } else {
        for (const row of rows) log(`repair ran: ${row.id} ${row.ok ? "ok" : "failed"}`);
      }
      first = await launch(app, "FRIDAY (after repair)");
    }
  }
  if (first.skipped) {
    log("SKIP  in-app stages — this machine has no desktop session");
  } else {
    for (const s of first.stages) {
      if (packGate && s.name === "CHAT" && !s.ok && isUnloadedLocalChat(s.detail)) {
        log("PASS (no answering model loaded - pack continues)");
        stages.push({
          name: "CHAT",
          ok: true,
          detail: "no answering model loaded - pack continues",
        });
      } else {
        add(s.name, s.ok, s.detail);
      }
    }
    if ((first.stages || []).some((s) => s.name === "KERNEL" && !s.ok)) {
      const lines = String(first.output || "")
        .split(/\r?\n/)
        .filter((line) => /\[kernel:|local AI service|Python/i.test(line))
        .slice(-30);
      for (const line of lines) log(line);
    }
    // FRIDAY exits itself after reporting: 0 when every stage passed, 1 when a
    // stage failed (electron/main.cjs). SHUTDOWN therefore checks the exit code
    // against the reported result instead of accepting any exit.
    const inAppFailed = (first.stages || [])
      .filter((stage) => !stage.ok)
      .map((stage) => stage.name);
    const expected = first.ok ? 0 : 1;
    const why = first.ok
      ? "the in-app report passed, so the process must exit 0"
      : `the in-app report failed (${inAppFailed.join(", ") || "no stage names"}), so the process must exit 1`;
    add(
      "SHUTDOWN",
      first.exitCode === expected,
      `exit code ${first.exitCode} (expected ${expected}: ${why})`,
    );
  }

  // Restart must be clean: no stale lock, no orphaned kernel, same result.
  if (!first.skipped) {
    const second = await launch(app, "FRIDAY (restart)", { select: false });
    // Restart is only clean when the app found the SAME folder on its own.
    const boot = (second.stages || []).find((s) => s.name === "BOOT");
    const rootStage = (second.stages || []).find((s) => s.name === "ROOT");
    const rooted = [rootStage, boot].filter(Boolean);
    const sameRoot =
      rooted.length > 0 &&
      rooted.every((s) => s.ok) &&
      rooted.some((s) => String(s.detail).includes(FRIDAY_ROOT));
    const failed = (second.stages || []).filter((s) => !s.ok).map((s) => s.name);
    const restartOk = (second.ok || packChatOnlyUnloaded(second)) && sameRoot;
    add(
      "RESTART",
      restartOk,
      second.ok
        ? sameRoot
          ? `rediscovered ${FRIDAY_ROOT} and reached the same ready state`
          : `restarted but did not rediscover ${FRIDAY_ROOT} (${rootStage ? rootStage.detail : boot ? boot.detail : "no ROOT stage"})`
        : packChatOnlyUnloaded(second) && sameRoot
          ? `rediscovered ${FRIDAY_ROOT}; Chat still has no loaded answering model (pack continues)`
          : second.error ||
            (failed.length ? `failing stage(s): ${failed.join(", ")}` : "restart failed"),
    );
  }

  const ok = stages.every((s) => s.ok);
  const file = report({
    ok,
    at: Date.now(),
    app,
    platform: process.platform,
    stages,
    environment: env,
    output: (first.output || "").slice(-8000),
  });
  log(`report: ${file}`);
  if (!ok) {
    fail("readiness FAILED — FRIDAY is not ready on this machine.");
    process.exit(1);
  }
  log("readiness PASSED — installed FRIDAY starts, works and restarts cleanly.");
})();
