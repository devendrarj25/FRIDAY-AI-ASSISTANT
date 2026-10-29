#!/usr/bin/env node
/**
 * One failed-gate line for a job summary: name, first error, reproduce command.
 *   node scripts/ci-gate-summary.cjs --gate typecheck --status failure --reproduce "npm run typecheck"
 */
"use strict";

const fs = require("node:fs");

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return process.argv[index + 1];
}

function firstError(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hit =
    lines.find((line) => /error TS|error:|AssertionError|expected|FAILED|::error/.test(line)) ||
    lines[0] ||
    "";
  return hit.slice(0, 400);
}

function summarize({ gate, status, reproduce, logText }) {
  const lines = [
    `### ${gate || "gate"}`,
    `Result: ${status || "failure"}`,
    `Reproduce: \`${reproduce || "npm run preflight"}\``,
  ];
  const error = firstError(logText);
  if (error) lines.push(`First error: ${error}`);
  return lines.join("\n");
}

function main() {
  const log = readFlag("--log");
  let logText = "";
  if (log && fs.existsSync(log)) logText = fs.readFileSync(log, "utf8");
  const text = summarize({
    gate: readFlag("--gate"),
    status: readFlag("--status") || "failure",
    reproduce: readFlag("--reproduce"),
    logText,
  });
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}

module.exports = { summarize, firstError };

if (require.main === module) main();
