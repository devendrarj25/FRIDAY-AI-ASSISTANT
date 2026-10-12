#!/usr/bin/env node
/**
 * Print the slowest Vitest files from a JSON reporter file.
 * A missing file is not a test failure.
 */
"use strict";

const fs = require("node:fs");

function fileDuration(file) {
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  const summed = assertions.reduce((total, test) => total + (Number(test.duration) || 0), 0);
  if (summed > 0) return summed;
  const start = Number(file.startTime);
  const end = Number(file.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return 0;
}

function slowest(report, limit = 20) {
  const files = Array.isArray(report && report.testResults) ? report.testResults : [];
  return files
    .map((file) => ({
      name: String(file.name || file.displayName || "unknown"),
      duration: fileDuration(file),
    }))
    .filter((row) => row.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, limit);
}

function format(rows) {
  const lines = ["### Slowest test files"];
  if (!rows.length) {
    lines.push("No durations were recorded.");
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push(`- ${row.duration} ms  ${row.name}`);
  }
  return lines.join("\n");
}

function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    process.stdout.write("vitest-slow-report: no report\n");
    return;
  }
  let report = {};
  try {
    report = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    process.stdout.write("vitest-slow-report: report was not JSON\n");
    return;
  }
  const text = format(slowest(report));
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}

module.exports = { slowest, format, fileDuration };

if (require.main === module) main();
