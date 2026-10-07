#!/usr/bin/env node
/**
 * FRIDAY · toolchain gate.
 *
 * The local Windows build must satisfy exactly the same `engines` block that
 * package.json declares and GitHub CI enforces. This runs BEFORE `npm ci` so a
 * wrong Node/npm fails immediately with a clear message instead of producing a
 * half-installed tree or a broken EXE.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnNpm } = require("./win-spawn.cjs");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const engines = pkg.engines || {};

/** ">=22.19.0" -> "22.19.0" */
const minimum = (range) => String(range || "").replace(/[^0-9.]/g, "");

/** Semantic compare: -1 / 0 / 1 */
function compare(a, b) {
  const left = String(a)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const right = String(b)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return 1;
    if ((left[i] || 0) < (right[i] || 0)) return -1;
  }
  return 0;
}

function npmVersion() {
  const r = spawnNpm(["--version"], { cwd: root, timeout: 15000 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "npm --version failed").toString());
  return String(r.stdout || "").trim();
}

function check() {
  const problems = [];
  const nodeMin = minimum(engines.node);
  const npmMin = minimum(engines.npm);
  const nodeNow = process.versions.node;

  if (nodeMin && compare(nodeNow, nodeMin) < 0)
    problems.push(
      `Node.js ${nodeNow} is too old — FRIDAY requires >=${nodeMin} (https://nodejs.org)`,
    );

  if (npmMin) {
    let npmNow = "";
    try {
      npmNow = npmVersion();
    } catch {
      problems.push("npm was not found on PATH — install Node.js 22.19.0+ which bundles npm.");
    }
    if (npmNow && compare(npmNow, npmMin) < 0)
      problems.push(
        `npm ${npmNow} is too old — FRIDAY requires >=${npmMin} (run: npm i -g npm@latest)`,
      );
  }
  return problems;
}

if (require.main === module) {
  const problems = check();
  if (problems.length) {
    for (const line of problems) console.error(`[FRIDAY] ${line}`);
    console.error("[FRIDAY] build stopped before npm ci — fix the toolchain and run it again.");
    process.exit(1);
  }
  console.log(
    `[FRIDAY] toolchain OK — node ${process.versions.node} (needs ${engines.node}), npm (needs ${engines.npm})`,
  );
}

module.exports = { compare, minimum, check };
