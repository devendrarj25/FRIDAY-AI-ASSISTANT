#!/usr/bin/env node
/**
 * Combine the parallel PR Validation jobs into the one commit status.
 *
 *   node scripts/pr-validation-aggregate.cjs --static success --kernel failure \
 *     --tests success --package success --sha <sha> --healed <sha>
 *   node scripts/pr-validation-aggregate.cjs --summary decision.json
 */
"use strict";

const fs = require("node:fs");

const REPRODUCE = {
  static: "npm run preflight",
  kernel: "npm run test:kernel",
  "tests-windows": "npm test",
  "package-windows": "npm run build:win",
};

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return process.argv[index + 1];
}

function aggregate(input) {
  const rows = [
    ["static", String(input.static || "")],
    ["kernel", String(input.kernel || "")],
    ["tests-windows", String(input.tests || "")],
    ["package-windows", String(input.package || "")],
  ];
  const bad = rows.filter(([, status]) => status !== "success");
  let state = "success";
  if (bad.some(([, status]) => status === "failure" || status === "skipped" || status === "")) {
    state = "failure";
  } else if (bad.some(([, status]) => status === "cancelled")) {
    state = "error";
  } else if (bad.length) {
    state = "failure";
  }
  const names = bad.map(([name]) => name);
  const description =
    state === "success"
      ? "FRIDAY PR validation: success"
      : `FRIDAY PR validation: ${state} (${names.join(", ")})`;
  return {
    state,
    description: description.slice(0, 140),
    failed: bad.map(([name, status]) => ({
      name,
      status: status || "missing",
      reproduce: REPRODUCE[name] || "npm run preflight",
    })),
    sha: input.sha || "",
    healed: input.healed || "",
  };
}

function summaryText(decision) {
  const lines = ["### PR Validation", `Result: ${decision.state}`, decision.description];
  for (const row of decision.failed || []) {
    lines.push(`- ${row.name}: ${row.status}. Reproduce: \`${row.reproduce}\``);
  }
  if (!decision.failed || !decision.failed.length) {
    lines.push("Every parallel gate succeeded.");
  }
  return lines.join("\n");
}

function writeSummary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${text}\n`);
  else process.stdout.write(`${text}\n`);
}

function main() {
  const summary = readFlag("--summary");
  if (summary) {
    const decision = JSON.parse(fs.readFileSync(summary, "utf8"));
    writeSummary(summaryText(decision));
    return;
  }
  const decision = aggregate({
    static: readFlag("--static"),
    kernel: readFlag("--kernel"),
    tests: readFlag("--tests"),
    package: readFlag("--package"),
    sha: readFlag("--sha"),
    healed: readFlag("--healed"),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

module.exports = { aggregate, summaryText, REPRODUCE };

if (require.main === module) main();
