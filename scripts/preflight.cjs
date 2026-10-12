#!/usr/bin/env node
/**
 * FRIDAY — one local gate.
 *
 * The same product checks PR Validation runs, in an order that puts the
 * cheap static checks first. A failure does not stop the rest: every gate
 * runs, then the process exits non-zero and prints one table. This command
 * does not dispatch GitHub Actions and does not publish a commit status.
 *
 *   node scripts/preflight.cjs
 *   node scripts/preflight.cjs --plan
 *   node scripts/preflight.cjs --full
 *   node scripts/preflight.cjs --changed
 *   node scripts/preflight.cjs --pack
 */
"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { spawnDirect, spawnNpm } = require("./win-spawn.cjs");

const root = path.resolve(__dirname, "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeBin = process.execPath;

const WINDOWS_SKIP =
  "Windows NSIS / installer smoke belong on windows-latest PR Validation or a local Windows CMD run; skipped on " +
  process.platform;

function gate(row) {
  return row;
}

const GATES = [
  gate({
    id: "heal-check",
    name: "version/documentation heal --check",
    tier: "static",
    command: nodeBin,
    args: ["scripts/release-engine.cjs", "heal", "--check"],
    reproduce: "node scripts/release-engine.cjs heal --check",
  }),
  gate({
    id: "typecheck",
    name: "typecheck",
    tier: "static",
    command: npmBin,
    args: ["run", "typecheck"],
    reproduce: "npm run typecheck",
  }),
  gate({
    id: "docs",
    name: "docs check",
    tier: "static",
    command: npmBin,
    args: ["run", "docs:check"],
    reproduce: "npm run docs:check",
  }),
  gate({
    id: "version",
    name: "verify version",
    tier: "static",
    command: npmBin,
    args: ["run", "verify:version"],
    reproduce: "npm run verify:version",
  }),
  gate({
    id: "tests-required",
    name: "tests changed with the code (warn only)",
    tier: "static",
    warn: true,
    command: nodeBin,
    args: ["scripts/tests-required.cjs", "origin/main"],
    reproduce: "node scripts/tests-required.cjs origin/main",
  }),
  gate({
    id: "provenance",
    name: "commit provenance",
    tier: "static",
    command: nodeBin,
    args: ["scripts/check-provenance.cjs", "origin/main"],
    reproduce: "node scripts/check-provenance.cjs origin/main",
  }),
  gate({
    id: "lint",
    name: "eslint and kernel ruff",
    tier: "static",
    command: npmBin,
    args: ["run", "lint"],
    reproduce: "npm run lint",
  }),
  gate({
    id: "actionlint",
    name: "workflow lint",
    tier: "static",
    command: nodeBin,
    args: ["scripts/run-actionlint.cjs"],
    reproduce: "node scripts/run-actionlint.cjs",
  }),
  gate({
    id: "arrange",
    name: "layout contract",
    tier: "static",
    command: nodeBin,
    args: ["scripts/arrange-project.cjs"],
    reproduce: "node scripts/arrange-project.cjs",
  }),
  gate({
    id: "deps",
    name: "main-process dependencies",
    tier: "static",
    command: nodeBin,
    args: ["scripts/verify-deps.cjs"],
    reproduce: "node scripts/verify-deps.cjs",
  }),
  gate({
    id: "audit",
    name: "clean-architecture audit --strict",
    tier: "static",
    command: nodeBin,
    args: ["scripts/audit-architecture.cjs", "--strict"],
    reproduce: "node scripts/audit-architecture.cjs --strict",
  }),
  gate({
    id: "kernel",
    name: "kernel tests",
    tier: "kernel",
    command: npmBin,
    args: ["run", "test:kernel"],
    reproduce: "npm run test:kernel",
  }),
  gate({
    id: "pyright",
    name: "kernel pyright baseline",
    tier: "kernel",
    command: npmBin,
    args: ["run", "typecheck:py"],
    reproduce: "npm run typecheck:py",
  }),
  gate({
    id: "test-fast",
    name: "fast hermetic tests",
    tier: "fast",
    command: npmBin,
    args: ["run", "test:fast"],
    reproduce: "npm run test:fast",
  }),
  gate({
    id: "test",
    name: "npm test",
    tier: "full",
    command: npmBin,
    args: ["test"],
    reproduce: "npm test",
  }),
  gate({
    id: "electron",
    name: "Electron runtime",
    tier: "full",
    command: nodeBin,
    args: ["scripts/ensure-electron.cjs", "--quiet"],
    reproduce: "node scripts/ensure-electron.cjs --quiet",
  }),
  gate({
    id: "renderer",
    name: "build renderer bundle",
    tier: "full",
    command: npmBin,
    args: ["run", "build:desktop"],
    reproduce: "npm run build:desktop",
  }),
];

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
    gate({
      id: "nsis",
      name: "Windows NSIS installer (no release)",
      tier: "windows",
      command: nodeBin,
      args: ["scripts/electron-pack.cjs", "--win", "nsis"],
      env: packEnv(),
      reproduce: "node scripts/electron-pack.cjs --win nsis",
    }),
    gate({
      id: "verify-build",
      name: "verify packaged application",
      tier: "windows",
      command: nodeBin,
      args: ["scripts/verify-build.cjs", "nsis"],
      reproduce: "node scripts/verify-build.cjs nsis",
    }),
    gate({
      id: "smoke",
      name: "installer lifecycle smoke",
      tier: "windows",
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
      reproduce:
        "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-installer-smoke.ps1",
    }),
  ];
}

function windowsGatesEnabled(opts = {}) {
  const pack = Boolean(opts.pack);
  const platform = String(opts.platform || process.platform);
  return pack || platform === "win32";
}

function gitNames(args) {
  const result = spawnDirect("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFiles(opts = {}) {
  if (Array.isArray(opts.files)) return opts.files.map(String);
  const base = gitNames(["rev-parse", "--verify", "origin/main"]).length ? "origin/main" : "";
  if (base) {
    const diff = gitNames(["diff", "--name-only", `${base}...HEAD`]);
    if (diff.length) return diff;
  }
  return gitNames(["diff", "--name-only", "HEAD"]);
}

function changedGateIds(files) {
  const ids = new Set(["heal-check"]);
  const blob = files.join("\n");
  if (/\.(ts|tsx|js|cjs|mjs|jsx)$/.test(blob)) {
    ids.add("typecheck");
    ids.add("lint");
    ids.add("test-fast");
  }
  if (/\.py$/.test(blob)) {
    ids.add("kernel");
    ids.add("pyright");
    ids.add("lint");
  }
  if (/\.(md|json)$/.test(blob) || /(^|\/)docs\//.test(blob)) {
    ids.add("docs");
    ids.add("version");
  }
  if (/\.(yml|yaml)$/.test(blob)) ids.add("actionlint");
  if (/(^|\/)scripts\//.test(blob) || /\.ps1$/.test(blob)) {
    ids.add("arrange");
    ids.add("deps");
    ids.add("audit");
    ids.add("actionlint");
  }
  if (ids.size === 1) {
    for (const id of [
      "typecheck",
      "docs",
      "version",
      "lint",
      "actionlint",
      "arrange",
      "deps",
      "audit",
    ]) {
      ids.add(id);
    }
  }
  return ids;
}

function provenanceSkip() {
  const result = spawnDirect("git", ["rev-parse", "--verify", "origin/main"], {
    cwd: root,
    stdio: "ignore",
  });
  if (result.status === 0) return null;
  return "origin/main is not in this clone; provenance skipped";
}

function buildPlan(opts = {}) {
  const full = Boolean(opts.full);
  const changed = Boolean(opts.changed);
  const wantWindows = full || Boolean(opts.pack);
  const runWindows = windowsGatesEnabled(opts);
  const version = opts.version || "<releaseVersion>";
  const selected = changed && !full ? changedGateIds(changedFiles(opts)) : null;
  const steps = [];
  for (const row of GATES) {
    if (row.id === "test-fast" && full) continue;
    if (row.tier === "full" && !full) continue;
    if (row.tier === "windows" && !wantWindows) continue;
    if (selected && !selected.has(row.id)) continue;
    let skip = null;
    if (row.id === "provenance") skip = provenanceSkip();
    if (row.tier === "windows" && !runWindows) skip = WINDOWS_SKIP;
    steps.push({ ...row, skip });
  }
  if (wantWindows) {
    for (const row of windowsGates(version)) {
      steps.push({ ...row, skip: runWindows ? null : WINDOWS_SKIP });
    }
  }
  return steps;
}

function printTable(rows) {
  const gateWidth = Math.max(4, ...rows.map((row) => row.id.length));
  console.log(`[friday] ${"gate".padEnd(gateWidth)}  result  reproduce`);
  for (const row of rows) {
    console.log(`[friday] ${row.id.padEnd(gateWidth)}  ${row.status.padEnd(6)}  ${row.reproduce}`);
    if (row.detail) console.log(`[friday] ${"".padEnd(gateWidth)}          ${row.detail}`);
  }
}

function runStep(step) {
  if (step.skip) return { status: "skip", detail: step.skip };
  const extra = {
    cwd: root,
    stdio: "inherit",
    env: step.env || process.env,
  };
  const base = path.basename(String(step.command)).toLowerCase();
  const result =
    base === "npm" || base === "npm.cmd"
      ? spawnNpm(step.args, extra)
      : spawnDirect(step.command, step.args, extra);
  if (result.error) return { status: "fail", detail: result.error.message };
  if (result.status !== 0) {
    if (step.warn) return { status: "warn", detail: `exit ${result.status}` };
    return { status: "fail", detail: `exit ${result.status == null ? 1 : result.status}` };
  }
  return { status: "pass", detail: "" };
}

function run(opts = {}) {
  const planOnly = Boolean(opts.plan);
  const pack = windowsGatesEnabled({ ...opts, pack: Boolean(opts.pack) || Boolean(opts.full) });
  let version = opts.version || "<releaseVersion>";
  if (!planOnly && (pack || opts.full)) {
    try {
      version = releaseVersion();
    } catch (error) {
      version = "<releaseVersion>";
    }
  }
  const steps = buildPlan({ ...opts, version });
  if (planOnly) {
    console.log("[friday] local validation plan (does not dispatch GitHub Actions)");
    for (const step of steps) {
      if (step.skip) {
        console.log(`[friday] skip  ${step.name}`);
        console.log(`[friday]       ${step.skip}`);
      } else {
        console.log(`[friday] run   ${step.name}`);
        console.log(`[friday]       ${step.reproduce}`);
      }
    }
    return { steps, rows: [], ok: true };
  }
  console.log("[friday] preflight — no GitHub runner, no commit status");
  const rows = [];
  for (const step of steps) {
    console.log(`[friday] run   ${step.name}`);
    const outcome = runStep(step);
    rows.push({
      id: step.id,
      name: step.name,
      status: outcome.status,
      reproduce: step.reproduce,
      detail: outcome.detail,
    });
    console.log(`[friday] ${outcome.status.padEnd(4)}  ${step.name}`);
  }
  printTable(rows);
  const failed = rows.filter((row) => row.status === "fail");
  return { steps, rows, ok: failed.length === 0, failed };
}

function parseArgs(argv) {
  return {
    plan: argv.includes("--plan"),
    full: argv.includes("--full"),
    changed: argv.includes("--changed"),
    pack: argv.includes("--pack"),
    platform: process.platform,
  };
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = run(opts);
  if (!result.ok) process.exit(1);
}

module.exports = {
  GATES,
  WINDOWS_SKIP,
  buildPlan,
  windowsGatesEnabled,
  changedGateIds,
  run,
  parseArgs,
  main,
};

if (require.main === module) main();
