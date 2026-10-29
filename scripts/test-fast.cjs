#!/usr/bin/env node
// FRIDAY - quick feedback while you work.
// Changed files are compared with origin/main. When that range has no
// related tests, or the tree is clean, a fast core subset still runs.
// `npm test` stays the full suite.
const { spawnDirect } = require("./win-spawn.cjs");

const FAST_CORE = [
  "core/__tests__/electron-security.test.ts",
  "core/__tests__/navigation-registry.test.ts",
  "core/__tests__/project-independence.test.ts",
  "core/__tests__/lifecycle-contracts.test.ts",
];

const gitOk = (args) => spawnDirect("git", args, { stdio: "ignore" }).status === 0;
const gitText = (args) => {
  const result = spawnDirect("git", args, { encoding: "utf8" });
  if (result.status !== 0) return "";
  return String(result.stdout || "");
};

const isGit = gitOk(["rev-parse", "--is-inside-work-tree"]);
const hasHead = isGit && gitOk(["rev-parse", "--verify", "-q", "HEAD"]);
const bin = process.platform === "win32" ? "npx.cmd" : "npx";

function changedNames() {
  if (!hasHead) return [];
  const base = gitOk(["rev-parse", "--verify", "-q", "origin/main"]) ? "origin/main" : "HEAD";
  const committed = base === "HEAD" ? "" : gitText(["diff", "--name-only", `${base}...HEAD`]);
  const work = gitText(["diff", "--name-only", "HEAD"]);
  const staged = gitText(["diff", "--name-only", "--cached"]);
  const untracked = gitText(["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(`${committed}\n${work}\n${staged}\n${untracked}`.split(/\r?\n/).filter(Boolean)),
  ];
}

function runVitest(args) {
  const result = spawnDirect(bin, args, { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return { status: result.status ?? 1, text };
}

function runCore() {
  console.log("test:fast - running the fast core subset");
  const result = runVitest(["vitest", "run", "--testTimeout=60000", ...FAST_CORE]);
  process.exit(result.status);
}

if (!hasHead) {
  console.log("test:fast - no git history here, running the full suite");
  const result = runVitest(["vitest", "run", "--testTimeout=60000"]);
  process.exit(result.status);
}

const names = changedNames().slice(0, 80);
if (!names.length) runCore();

const related = runVitest(["vitest", "related", "--run", "--testTimeout=60000", ...names]);
if (/No test files found/i.test(related.text)) runCore();
process.exit(related.status);
