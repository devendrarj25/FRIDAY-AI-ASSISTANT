#!/usr/bin/env node
/**
 * FRIDAY Doctor - check everything, repair what can be repaired, check again.
 *
 *   npm run doctor
 *
 * It is the backup for `npm run setup`: when setup stopped halfway (a download
 * dropped, an installer needed a restart, a tool was missing) Doctor picks up
 * where it stopped. Every step is safe to run again and reuses what is healthy;
 * a step that cannot finish fails the run with its reason, so nothing is left as
 * a warning that "can be done later".
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
 *                      gate and connection of the voice mode, and the models on disk
 *   6. runtime         scripts/init-runtime.cjs: the FRIDAY folders and the database
 *   7. main process    scripts/verify-deps.cjs: every module the app requires ships
 *   8. registry        scripts/env-registry.cjs repair: the persistent component list
 *   9. pinned runners  scripts/runners-status.cjs: Ollama and llama.cpp against the newest official
 *                      release (information only: it never fails the run and never changes a pin)
 *
 * Exit 0 only when every step passed.
 */
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { spawnNpm } = require("./win-spawn.cjs");
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
  const first = spawnNpm(["ci", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
  if (first.status === 0) return first;
  console.error(
    "[friday] npm ci failed - npm cache verify, then one retry against registry.npmjs.org",
  );
  spawnNpm(["cache", "verify"], { cwd: ROOT, stdio: "inherit" });
  return spawnNpm(["ci", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

/** The speech, voice and chat weights: Doctor used to pass without ever looking for them. */
function models() {
  let python = require("./explicit-python.cjs").explicitPython(process.env.FRIDAY_PYTHON);
  if (!python) {
    try {
      python = require("./python-runtime.cjs").resolveVenvPython() || "";
    } catch {
      python = "";
    }
  }
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefetch-models.cjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(python ? { FRIDAY_PYTHON: python } : {}) },
  });
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
    [path.join(ROOT, "scripts", "voice-stack.cjs"), ...(root ? ["--root", root] : [])],
    { cwd: ROOT, stdio: "inherit" },
  );
}

const STEPS = [
  { name: "dependencies", run: dependencies },
  {
    name: "environment check and repair",
    // Inside `npm run setup` the table was just printed: the confirming pass shows a count and any failure.
    run: () =>
      node("check-environment.cjs", [
        "--fix",
        ...(process.env.FRIDAY_SETUP_RUN === "1" ? ["--summary"] : []),
      ])(),
  },
  { name: "packs that ship inside the EXE", run: node("stage-toolchain.cjs") },
  { name: "speech, voice and chat models", run: models },
  { name: "voice files load and speak", run: node("voice-smoke.cjs") },
  { name: "voice stack: runners, models, packages and connections", run: voiceStack },
  { name: "runtime folders and database", run: node("init-runtime.cjs") },
  { name: "main-process dependencies", run: node("verify-deps.cjs") },
  { name: "environment registry", run: node("env-registry.cjs", ["repair"]) },
  { name: "pinned local runners against the newest release", run: node("runners-status.cjs") },
];

/** Run every step in order (later steps still run after a failure, so one pass reports everything). */
function runDoctor(steps = STEPS, log = console.log) {
  const rows = [];
  steps.forEach((step, index) => {
    log(`[friday] doctor ${index + 1}/${steps.length}: ${step.name}`);
    let status = 1;
    let error = "";
    try {
      const result = step.run();
      status = result && typeof result.status === "number" ? result.status : 1;
      if (result && result.error) error = String(result.error.message || result.error);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    rows.push({ name: step.name, ok: status === 0, status, error });
  });
  log("");
  log("FRIDAY Doctor");
  log("-".repeat(78));
  for (const row of rows) {
    log(
      `${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.ok ? "" : ` (exit ${row.status}${row.error ? `: ${row.error}` : ""})`}`,
    );
  }
  log("-".repeat(78));
  const failed = rows.filter((row) => !row.ok);
  if (failed.length) {
    log(
      `DOCTOR FAIL - ${failed.length} step(s) did not finish: ${failed.map((r) => r.name).join(", ")}`,
    );
    log(
      "Read the first error above, fix it (network, administrator prompt, restart), then run: npm run doctor",
    );
  } else {
    log("DOCTOR PASS - FRIDAY is ready to test, build and run.");
  }
  return { ok: failed.length === 0, rows };
}

module.exports = { STEPS, runDoctor };

if (require.main === module) {
  // exitCode, not process.exit(): ending the process while child pipes are closing can abort Node on Windows.
  process.exitCode = runDoctor().ok ? 0 : 1;
}
