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
 *   3. runtime         scripts/init-runtime.cjs: the FRIDAY folders and the database
 *   4. main process    scripts/verify-deps.cjs: every module the app requires ships
 *   5. registry        scripts/env-registry.cjs repair: the persistent component list
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

const STEPS = [
  { name: "dependencies", run: dependencies },
  { name: "environment check and repair", run: node("check-environment.cjs", ["--fix"]) },
  { name: "runtime folders and database", run: node("init-runtime.cjs") },
  { name: "main-process dependencies", run: node("verify-deps.cjs") },
  { name: "environment registry", run: node("env-registry.cjs", ["repair"]) },
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
  process.exit(runDoctor().ok ? 0 : 1);
}
