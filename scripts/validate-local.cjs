#!/usr/bin/env node
/**
 * FRIDAY — local PR Validation substitute (no GitHub Actions runner).
 *
 * Runs the same product gates as `.github/workflows/pr-validation.yml`
 * without starting a hosted runner, dispatching a workflow, or publishing
 * a `PR Validation` commit status. GitHub Actions stays the click-to-run
 * Windows proof (`pull_request` + `workflow_dispatch`). This command does
 * not replace that path and never marks a GitHub check green.
 *
 * Usage:
 *   node scripts/validate-local.cjs           run what this OS can run
 *   node scripts/validate-local.cjs --plan    print the plan and exit 0
 *   node scripts/validate-local.cjs --pack    also run NSIS + installer smoke
 *                                             (Windows proof; fails on Linux)
 *
 * On non-Windows, NSIS pack / verify-build / installer smoke are skipped
 * unless `--pack` is passed. A skip is not a pass.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeBin = process.execPath;
const wantPlan = process.argv.includes("--plan");
const wantPack = process.argv.includes("--pack");

const log = (m) => console.log(`[friday] ${m}`);
const fail = (m) => console.error(`[friday] ${m}`);

/**
 * Product gates that PR Validation always runs, in the same order
 * (heal-check before typecheck/tests; no GitHub status publish; no npm ci —
 * the working tree is assumed installed).
 */
const CODE_GATES = [
  {
    id: "heal-check",
    name: "version/documentation heal --check",
    command: nodeBin,
    args: ["scripts/release-engine.cjs", "heal", "--check"],
  },
  {
    id: "typecheck",
    name: "typecheck",
    command: npmBin,
    args: ["run", "typecheck"],
  },
  {
    id: "docs",
    name: "docs check",
    command: npmBin,
    args: ["run", "docs:check"],
  },
  {
    id: "version",
    name: "verify version",
    command: npmBin,
    args: ["run", "verify:version"],
  },
  {
    id: "provenance",
    name: "commit provenance",
    command: nodeBin,
    args: ["scripts/check-provenance.cjs", "origin/main"],
  },
  {
    id: "test",
    name: "npm test",
    command: npmBin,
    args: ["test"],
  },
  {
    id: "kernel",
    name: "kernel tests",
    command: npmBin,
    args: ["run", "test:kernel"],
  },
  {
    id: "arrange",
    name: "layout contract",
    command: nodeBin,
    args: ["scripts/arrange-project.cjs"],
  },
  {
    id: "deps",
    name: "main-process dependencies",
    command: nodeBin,
    args: ["scripts/verify-deps.cjs"],
  },
  {
    id: "audit",
    name: "clean-architecture audit --strict",
    command: nodeBin,
    args: ["scripts/audit-architecture.cjs", "--strict"],
  },
  {
    id: "electron",
    name: "Electron runtime",
    command: nodeBin,
    args: ["scripts/ensure-electron.cjs", "--quiet"],
  },
  {
    id: "renderer",
    name: "build renderer bundle",
    command: npmBin,
    args: ["run", "build:desktop"],
  },
];

const WINDOWS_SKIP =
  "Windows NSIS / installer smoke belong on windows-latest PR Validation or a local Windows CMD run; skipped on " +
  process.platform;

function packEnv() {
  return {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    RUNNER_TEMP: process.env.RUNNER_TEMP || os.tmpdir(),
  };
}

function releaseVersion() {
  const result = spawnSync(
    nodeBin,
    ["scripts/release-engine.cjs", "identity", "--field", "releaseVersion"],
    { encoding: "utf8", cwd: root },
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "identity --field releaseVersion failed")
        .toString()
        .trim(),
    );
  }
  return String(result.stdout || "").trim();
}

function windowsGates(version) {
  const installer = path.join("release", `FRIDAY-Setup-${version}.exe`);
  const ps = process.platform === "win32" ? "powershell.exe" : "powershell";
  return [
    {
      id: "nsis",
      name: "Windows NSIS installer (no release)",
      command: nodeBin,
      args: ["scripts/electron-pack.cjs", "--win", "nsis"],
      env: packEnv(),
      windows: true,
    },
    {
      id: "verify-build",
      name: "verify packaged application",
      command: nodeBin,
      args: ["scripts/verify-build.cjs", "nsis"],
      windows: true,
    },
    {
      id: "smoke",
      name: "installer lifecycle smoke",
      command: ps,
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/windows-installer-smoke.ps1",
        "-Installer",
        installer,
        "-Product",
        "FRIDAY",
      ],
      env: packEnv(),
      windows: true,
    },
  ];
}

function windowsGatesEnabled(opts = {}) {
  const pack = Boolean(opts.pack);
  const platform = String(opts.platform || process.platform);
  return pack || platform === "win32";
}

function buildPlan(opts = {}) {
  const pack = windowsGatesEnabled(opts);
  const version = opts.version || "<releaseVersion>";
  const steps = CODE_GATES.map((step) => ({ ...step, skip: null }));
  for (const step of windowsGates(version)) {
    steps.push({
      ...step,
      skip: pack ? null : WINDOWS_SKIP,
    });
  }
  return steps;
}

function printPlan(steps) {
  log("local validation plan (does not dispatch GitHub Actions)");
  for (const step of steps) {
    if (step.skip) {
      log(`skip  ${step.name}`);
      log(`      ${step.skip}`);
    } else {
      const argv = [step.command, ...(step.args || [])].map((part) => String(part)).join(" ");
      log(`run   ${step.name}`);
      log(`      ${argv}`);
    }
  }
}

function runStep(step) {
  if (step.skip) {
    log(`skip  ${step.name}`);
    log(`      ${step.skip}`);
    return "skipped";
  }
  log(`run   ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: "inherit",
    env: step.env || process.env,
  });
  if (result.error) {
    fail(`${step.name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    fail(`${step.name} failed (exit ${result.status == null ? 1 : result.status}).`);
    if (step.id === "heal-check") {
      fail("Repair locally with `npm run release:heal`, then re-run. This command does not push.");
    }
    process.exit(result.status || 1);
  }
  log(`ok    ${step.name}`);
  return "ok";
}

function run(opts = {}) {
  const pack = windowsGatesEnabled(opts);
  let version = "unresolved";
  if (pack || wantPlan) {
    try {
      version = releaseVersion();
    } catch (error) {
      if (!wantPlan) throw error;
    }
  }
  const steps = buildPlan({ ...opts, pack, version });
  if (wantPlan || opts.plan) {
    printPlan(steps);
    return { steps, skippedWindows: !pack };
  }
  log("local PR Validation substitute — no GitHub runner, no commit status");
  let ran = 0;
  let skipped = 0;
  for (const step of steps) {
    const status = runStep(step);
    if (status === "skipped") skipped += 1;
    else ran += 1;
  }
  log(`done  ${ran} step(s) passed, ${skipped} skipped`);
  if (skipped) {
    log(
      "Windows NSIS / installer smoke were not run. That remains `scripts\\build-windows.cmd` or Actions → PR Validation when minutes exist.",
    );
  }
  return { steps, skippedWindows: skipped > 0 };
}

module.exports = {
  CODE_GATES,
  WINDOWS_SKIP,
  buildPlan,
  windowsGatesEnabled,
  run,
};

if (require.main === module) {
  run({ pack: wantPack, plan: wantPlan, platform: process.platform });
}
