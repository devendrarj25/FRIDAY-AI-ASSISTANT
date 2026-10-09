#!/usr/bin/env node
// FRIDAY - "I am coming back after a gap" check.
//
//   npm run resume
//
// One command that says whether the project is healthy right now. The weekly
// Health workflow runs the very same script, so "green here" and "green in CI"
// mean the same thing. It changes nothing; it only reports.
//
//   --ci             skip the local-only branch check, add the dependency audit
//   --report <file>  also write the result as a Markdown table (used for the
//                    single "health" issue the workflow opens and closes)
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const win = process.platform === "win32";
const argv = process.argv.slice(2);
const CI = argv.includes("--ci");
const reportIdx = argv.indexOf("--report");
const REPORT = reportIdx >= 0 ? argv[reportIdx + 1] : "";

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: win, ...opts });

const results = [];
function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  let out;
  try {
    out = fn();
  } catch (e) {
    out = { status: "FAIL", note: String(e.message || e) };
  }
  console.log(out.status + (out.note ? `  (${out.note})` : ""));
  results.push({ name, ...out });
}
const cmd = (cmdName, args, note) => () => {
  const r = run(cmdName, args);
  return r.status === 0 ? { status: "PASS" } : { status: "FAIL", note: note || `exit ${r.status}` };
};

console.log("FRIDAY resume check\n");

if (!CI)
  step("git branch", () => {
    const r = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (r.status !== 0) return { status: "SKIP", note: "not a git checkout" };
    const branch = r.stdout.trim();
    return branch === "main"
      ? { status: "WARN", note: "you are on main - create a work branch before changing anything" }
      : { status: "PASS", note: branch };
  });
step("dependencies installed", () =>
  fs.existsSync(path.join(ROOT, "node_modules"))
    ? { status: "PASS" }
    : { status: "FAIL", note: "run: npm ci" },
);
step("pricing knowledge fresh", () => {
  const r = run("node", ["scripts/pricing-status.cjs", "--warn", "4"]);
  return r.status === 0
    ? { status: "PASS" }
    : { status: "WARN", note: (r.stdout || "").split("\n")[0].trim() };
});
step("typecheck", cmd("npm", ["run", "typecheck", "--silent"]));
step("docs in sync", cmd("npm", ["run", "docs:check", "--silent"], "run: npm run docs:sync"));
step(
  "version in sync",
  cmd("npm", ["run", "verify:version", "--silent"], "run: npm run release:heal"),
);
function kernelPython() {
  const venv =
    process.platform === "win32"
      ? path.join(ROOT, ".venv", "Scripts", "python.exe")
      : path.join(ROOT, ".venv", "bin", "python3");
  const fallback = process.platform === "win32" ? "python" : "python3";
  if (fs.existsSync(venv) && run(venv, ["-c", "import pytest"]).status === 0) return venv;
  return fallback;
}

step("kernel tests", () => {
  const bin = kernelPython();
  const py = run(bin, ["--version"]);
  if (py.status !== 0) return { status: "SKIP", note: "python not found" };
  const r = run(bin, ["-m", "pytest", "kernel/tests", "-q"]);
  return r.status === 0
    ? { status: "PASS" }
    : { status: "FAIL", note: "run: npm run setup:python:test" };
});
step("full test suite", cmd("npm", ["test", "--silent"]));
if (CI) {
  // The weekly health run stays green. The same advisory script warns here.
  // PR Validation and Security Scan fail on a blocking advisory.
  step("dependency audit (info)", () => {
    const r = run(process.execPath, ["scripts/advisory-audit.cjs", "--report-only"]);
    const line =
      String(r.stdout || "")
        .split("\n")
        .find((row) => row.startsWith("advisory audit:")) || "";
    const blocking = Number((line.match(/(\d+) blocking/) || [])[1] || 0);
    if (!line) return { status: "WARN", note: "advisory audit could not run" };
    return blocking ? { status: "WARN", note: line } : { status: "PASS" };
  });
}

const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
console.log(
  `\n${failed.length ? "NOT HEALTHY" : "HEALTHY"} - ${failed.length} failed, ${warned.length} warning(s).`,
);
if (REPORT) {
  const rows = results
    .map((r) => `| ${r.name} | ${r.status} | ${(r.note || "").replace(/\|/g, "/")} |`)
    .join("\n");
  fs.writeFileSync(
    REPORT,
    `| Check | Result | Note |\n| --- | --- | --- |\n${rows}\n\n` +
      `${failed.length ? "**NOT HEALTHY**" : "**HEALTHY**"} - ${failed.length} failed, ${warned.length} warning(s).\n`,
  );
}
process.exit(failed.length ? 1 : 0);
