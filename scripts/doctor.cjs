#!/usr/bin/env node
/**
 * FRIDAY Doctor - check everything, repair what can be repaired, check again.
 *
 *   npm run doctor
 *
 * It is the backup for `npm run setup`: when setup stopped halfway (a download
 * dropped, an installer needed a restart, a tool was missing) Doctor picks up
 * where it stopped and fetches what is missing again from every source. Every step
 * is safe to run again and reuses what is healthy.
 *
 * Two tiers. A BLOCKER step (dependencies, the environment check, the runtime folders, the main-process
 * dependencies) is what the build cannot run without: when it cannot finish it fails the run with its reason. A NOTICE
 * step (the EXE packs, the models, the voice files, the voice stack, the registry, the pinned runners) that cannot
 * finish prints a NOTICE row, is recorded in <FRIDAY_ROOT>/runtime/setup-notices.json and does not fail the run: the
 * build still runs (it fetches the packs again and stops there only when that fails too) and FRIDAY > Install Manager /
 * Models finishes the item. FRIDAY_SETUP_STRICT=1 makes every step a blocker again. The run is always steps 1 to 10
 * ("doctor N/10").
 *
 *   1. dependencies    npm ci when node_modules does not match package-lock.json
 *   2. environment     scripts/check-environment.cjs --fix: the toolchain, Electron,
 *                      the Python environment, the local chat engine and the agent
 *                      toolkit are installed or repaired, then checked again
 *   2b. EXE packs      scripts/stage-toolchain.cjs: the packs the EXE carries, from the .cache when already fetched
 *   3. models          scripts/prefetch-models.cjs: the speech, voice and chat weights, fetched again
 *                      (retrying a network drop) when any is missing
 *   4. voice files     scripts/voice-smoke.cjs: silero, the noise suppressor and Smart Turn are run, and
 *                      Supertonic speaks a test line (Windows)
 *   5. voice stack     scripts/voice-stack.cjs --root <FRIDAY folder>: every runner, model, package, router,
 *                      gate and connection of the voice mode, the models on disk, and one row per language
 *                      (Hindi, English, Hinglish: ears, speaking, punctuation, light voice, fallback ear)
 *   6. runtime         scripts/init-runtime.cjs: the FRIDAY folders and the database
 *   7. main process    scripts/verify-deps.cjs: every module the app requires ships
 *   8. registry        scripts/env-registry.cjs repair: the persistent component list
 *   9. pinned runners  scripts/runners-status.cjs: Ollama and llama.cpp against the newest official
 *                      release (information only: it never fails the run and never changes a pin)
 *
 * Every download row (models, runtimes, packages, tools) names all its source hosts in order and which of them answers
 * now (scripts/doctor-probes.cjs: one HEAD request per distinct host, in parallel, cached for this run in the file
 * FRIDAY_REACH_CACHE; "not checked" when offline, never a failure).
 *
 * Exit 0 when every blocker step passed (notices never change the exit code unless strict).
 */
"use strict";
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { spawnNpm } = require("./win-spawn.cjs");
const setupNotices = require("./setup-notices.cjs");
const probes = require("./doctor-probes.cjs");
// Children inherit this process's PATH: pick up what a previous setup installed.
require("./win-path.cjs").refreshWindowsPath();

const ROOT = path.resolve(__dirname, "..");

function node(script, args = []) {
  return () =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      stdio: "inherit",
    });
}

/** npm ci only when node_modules does not match package-lock.json (the pipeline's own check). */
function dependencies() {
  const { nodeModulesCurrent } = require("./build-pipeline.cjs");
  if (nodeModulesCurrent(ROOT)) {
    console.log("[friday] node_modules already matches package-lock.json; npm ci skipped");
    return { status: 0 };
  }
  const { withActivityCommand } = require("./with-activity.cjs");
  const modules = [path.join(ROOT, "node_modules")];
  const ci = (extra = []) =>
    withActivityCommand("npm ci", modules, "npm", ["ci", "--no-audit", "--no-fund", ...extra], {
      cwd: ROOT,
    });
  const first = ci();
  if (first.status === 0) return first;
  console.error(
    "[friday] npm ci failed - npm cache verify, then one retry against registry.npmjs.org",
  );
  spawnNpm(["cache", "verify"], { cwd: ROOT, stdio: "inherit" });
  return ci(["--registry", "https://registry.npmjs.org/"]);
}

/** True when a speech, voice or chat weight is still an open notice. */
function modelNoticesOpen(read = setupNotices.readNotices) {
  return read().some((entry) => entry.kind === "model" || entry.kind === "voice");
}

/**
 * The speech, voice and chat weights: Doctor used to pass without ever looking for them. Before giving up it tries once
 * more with the opt-in Hugging Face mirror when the Hugging Face host answers "down" now (a missing weight is a notice,
 * so this is the last source tried, never a stop). `deps` is injectable for a test.
 */
function models(deps = {}) {
  const {
    run = spawnSync,
    env = process.env,
    reach = probes.reachSync,
    readOpen = modelNoticesOpen,
    log = console.log,
  } = deps;
  let python = require("./explicit-python.cjs").explicitPython(env.FRIDAY_PYTHON);
  if (!python) {
    try {
      python = require("./python-runtime.cjs").resolveVenvPython() || "";
    } catch {
      python = "";
    }
  }
  const fetchModels = (extra = {}) =>
    run(process.execPath, [path.join(ROOT, "scripts", "prefetch-models.cjs")], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...env, ...(python ? { FRIDAY_PYTHON: python } : {}), ...extra },
    });
  const first = fetchModels();
  const unfinished = !first || first.status !== 0 || readOpen();
  if (!unfinished || String(env.FRIDAY_HF_MIRROR || "") === "1") return first;
  if (!probes.huggingFaceDown(reach([probes.HUGGING_FACE], { env }))) return first;
  log(
    "[friday] huggingface.co does not answer now: trying the opt-in mirror once (FRIDAY_HF_MIRROR=1)",
  );
  const again = fetchModels({ FRIDAY_HF_MIRROR: "1" });
  // The second pass counts when it finished the work; otherwise the first result (and its notices) stand.
  return again && again.status === 0 ? again : first;
}

/** voice-stack.cjs with the FRIDAY folder, so the models on disk are checked as well as the code. */
function voiceStack() {
  let root = "";
  try {
    root = require("./friday-root.cjs").workspaceRootOrDev().root || "";
  } catch {
    root = "";
  }
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "voice-stack.cjs"),
      ...(root ? ["--root", root] : []),
      // Inside `npm run setup` a full pass is a count; the 74-row table is for a standalone `npm run doctor`.
      ...(process.env.FRIDAY_SETUP_RUN === "1" ? ["--summary"] : []),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
}

const STEPS = [
  { name: "dependencies", run: dependencies, tier: "blocker" },
  {
    name: "environment check and repair",
    // Its own exit is blocker-only now: a missing tool or model is a NOTICE row inside it.
    tier: "blocker",
    // Inside `npm run setup` the table was just printed: the confirming pass shows a count and any failure.
    run: () =>
      node("check-environment.cjs", [
        "--fix",
        ...(process.env.FRIDAY_SETUP_RUN === "1" ? ["--summary"] : []),
      ])(),
  },
  // A failed pack download is a notice here as in `npm run setup` (stage 6): the build fetches the packs again and
  // stops there when that fails too, so Doctor never blocks on it.
  { name: "packs that ship inside the EXE", run: node("stage-toolchain.cjs"), tier: "notice" },
  // `npm run setup` fetched, verified and spoke with these seconds ago (setup-python.cjs), and stops on a failure,
  // so its confirming Doctor pass does not repeat the downloads check, the Qwen test prompt or the speak test.
  { name: "speech, voice and chat models", run: models, setupVerified: true, tier: "notice" },
  {
    name: "voice files load and speak",
    run: node("voice-smoke.cjs"),
    setupVerified: true,
    tier: "notice",
  },
  {
    name: "voice stack: runners, models, packages and connections",
    run: voiceStack,
    tier: "notice",
  },
  { name: "runtime folders and database", run: node("init-runtime.cjs"), tier: "blocker" },
  { name: "main-process dependencies", run: node("verify-deps.cjs"), tier: "blocker" },
  { name: "environment registry", run: node("env-registry.cjs", ["repair"]), tier: "notice" },
  {
    name: "pinned local runners against the newest release",
    run: node("runners-status.cjs"),
    tier: "notice",
  },
];

/** What a notice step records when it cannot finish: the kind of item it stands for. */
const NOTICE_KINDS = {
  "packs that ship inside the EXE": "pack",
  "speech, voice and chat models": "model",
  "voice files load and speak": "voice",
  "voice stack: runners, models, packages and connections": "voice",
  "environment registry": "runtime",
};
/** The bare id older runs recorded; a passing step clears it with the current one. */
const legacyNoticeIdOf = (name) =>
  `doctor-${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
/** `<kind>:doctor-<step>`, one id scheme with the download steps (scripts/setup-notices.cjs). */
const noticeIdOf = (name) => `${NOTICE_KINDS[name] || "other"}:${legacyNoticeIdOf(name)}`;

/**
 * Run every step in order (later steps still run after a failure, so one pass reports everything). A step is a
 * `blocker` unless it says `tier: "notice"`; a failed notice step prints NOTICE, is recorded, and does not fail the run
 * (FRIDAY_SETUP_STRICT=1 makes it fail again). `deps.readNotices` / `deps.recordNotice` / `deps.clearNotice` are the
 * one record (scripts/setup-notices.cjs); a caller that passes none keeps the run free of any file.
 */
function runDoctor(steps = STEPS, log = console.log, env = process.env, deps = {}) {
  const { readNotices, recordNotice, clearNotice } = deps;
  const strict = setupNotices.isStrict(env);
  const rows = [];
  steps.forEach((step, index) => {
    log(`[friday] doctor ${index + 1}/${steps.length}: ${step.name}`);
    if (step.setupVerified && env.FRIDAY_SETUP_RUN === "1") {
      log(
        "[friday] ok       verified by npm run setup a moment ago; not repeated (npm run doctor checks it in full)",
      );
      rows.push({ name: step.name, ok: true, status: 0, error: "", reused: true });
      return;
    }
    let status = 1;
    let error = "";
    try {
      const result = step.run();
      status = result && typeof result.status === "number" ? result.status : 1;
      if (result && result.error) error = String(result.error.message || result.error);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const ok = status === 0;
    const notice = !ok && step.tier === "notice" && !strict;
    rows.push({ name: step.name, ok, status, error, ...(notice ? { notice: true } : {}) });
    if (step.tier === "notice") {
      const id = noticeIdOf(step.name);
      if (ok && clearNotice) {
        clearNotice(id);
        clearNotice(legacyNoticeIdOf(step.name));
      }
      if (notice && recordNotice)
        recordNotice(
          {
            id,
            kind: NOTICE_KINDS[step.name] || "other",
            label: step.name,
            reason: `step ended with exit ${status}${error ? `: ${error}` : ""}`,
            repair: "npm run doctor",
          },
          { print: false },
        );
    }
  });
  const failed = rows.filter((row) => !row.ok && !row.notice);
  const noticed = rows.filter((row) => row.notice);
  log("");
  log("FRIDAY Doctor");
  log("-".repeat(78));
  for (const row of rows) {
    const label = row.ok ? "PASS" : row.notice ? "NOTICE" : "FAIL";
    log(
      `${label.padEnd(4)}  ${row.name}${row.ok ? "" : ` (exit ${row.status}${row.error ? `: ${row.error}` : ""})`}`,
    );
  }
  log("-".repeat(78));
  const open = readNotices
    ? readNotices()
    : noticed.map((row) => ({
        id: noticeIdOf(row.name),
        label: row.name,
        reason: `step ended with exit ${row.status}`,
      }));
  for (const line of setupNotices.summaryLines(open)) log(line);
  if (failed.length) {
    log(
      `DOCTOR FAIL - ${failed.length} step(s) did not finish: ${failed.map((r) => r.name).join(", ")}`,
    );
    log(
      "Read the first error above, fix it (network, administrator prompt, restart), then run: npm run doctor",
    );
  } else if (open.length) {
    log(
      `DOCTOR PASS - FRIDAY is ready to build and run. ${open.length} item(s) can be finished later in ${setupNotices.WHERE}.`,
    );
  } else {
    log("DOCTOR PASS - FRIDAY is ready to test, build and run.");
  }
  return { ok: failed.length === 0, rows, notices: open };
}

/** Child steps trust the Windows certificate store (a company proxy CA); an owner's own value is kept. */
function useSystemCa(env = process.env) {
  if (env.NODE_USE_SYSTEM_CA === undefined) env.NODE_USE_SYSTEM_CA = "1";
}

module.exports = { STEPS, runDoctor, models, modelNoticesOpen, useSystemCa };

if (require.main === module) {
  // exitCode, not process.exit(): ending the process while child pipes are closing can abort Node on Windows.
  // A Node.js / npm update left by the last `npm run setup` finishes first.
  require("./running-tools-upgrade.cjs").waitForPending();
  useSystemCa();
  // One reachability cache for the whole run: the steps below are separate processes and probe each host once.
  const reachCache = process.env.FRIDAY_REACH_CACHE
    ? ""
    : path.join(os.tmpdir(), `friday-reach-${process.pid}.json`);
  if (reachCache) process.env.FRIDAY_REACH_CACHE = reachCache;
  try {
    process.exitCode = runDoctor(STEPS, console.log, process.env, setupNotices).ok ? 0 : 1;
  } finally {
    if (reachCache) fs.rmSync(reachCache, { force: true });
  }
}
