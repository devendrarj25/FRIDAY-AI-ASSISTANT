#!/usr/bin/env node
// FRIDAY - "you changed code, did you change a test?"
//
// Compares the current branch to the base branch. If product code changed but
// no test file did, it prints a GitHub warning annotation. It is deliberately
// WARN-ONLY (exit 0): a missing test is a prompt to add one, never a red X that
// blocks a fix. Docs-only / config-only changes are ignored.
//
//   node scripts/tests-required.cjs [baseRef]      (default: origin/main)
const { spawnSync } = require("node:child_process");
const base = process.argv[2] || "origin/main";

const git = (args) => spawnSync("git", args, { encoding: "utf8" });
const diff = git(["diff", "--name-only", `${base}...HEAD`]);
if (diff.status !== 0) {
  console.log(`tests-required: cannot diff against ${base} - skipped`);
  process.exit(0);
}
const files = diff.stdout
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);
const isTest = (f) =>
  /(^|\/)(__tests__|tests)\//.test(f) || /\.(test|spec)\.(ts|tsx|cjs|mjs|js|py)$/.test(f);
const isCode = (f) =>
  /^(src|electron|kernel|core|scripts)\//.test(f) &&
  /\.(ts|tsx|cjs|mjs|js|py)$/.test(f) &&
  !isTest(f);

const code = files.filter(isCode);
const tests = files.filter(isTest);
if (code.length && !tests.length) {
  const list = code.slice(0, 5).join(", ") + (code.length > 5 ? ", ..." : "");
  console.log(
    `::warning title=No test changed::Code changed (${list}) but no test file did. ` +
      `Add or update a test for the behaviour you touched.`,
  );
} else {
  console.log(`tests-required: ok (${code.length} code file(s), ${tests.length} test file(s))`);
}
process.exit(0);
