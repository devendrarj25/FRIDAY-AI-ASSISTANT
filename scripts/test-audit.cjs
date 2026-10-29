#!/usr/bin/env node
/**
 * Classify the suite. Default verdict is KEEP.
 * Prints one row per file that is not a plain KEEP, then the totals.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "helpers")
        continue;
      walk(full, out);
    } else if (
      /\.(test|spec)\.(ts|tsx|js|py)$/.test(entry.name) ||
      /^test_.*\.py$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function classify(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  const needs = [];
  if (/isOnline\(|skipIf\(\s*!ONLINE|await fetch\(/.test(text)) needs.push("network");
  if (/HAS_COMMITTED_IDENTITY|readCanonicalIdentityAtRef\(/.test(text)) needs.push("git-history");
  if (/canBranch\(/.test(text)) needs.push("git-branch");
  if (/skipif\(sys\.platform\.startswith\("win"\)/.test(text)) needs.push("posix-desktop");
  if (/\bit\.skip\b|\bdescribe\.skip\b|\bpytest\.mark\.skip\b|\bpytest\.skip\(/.test(text)) {
    needs.push("skipped");
  }
  if (/microphone|wake word|SmartScreen/i.test(text) && /it\.skip|describe\.skip/.test(text)) {
    needs.push("hardware");
  }
  let verdict = "KEEP";
  let reason = "Protects a behaviour the suite still runs on a GitHub runner.";
  if (rel === "core/__tests__/full-spectrum-upgrade.test.ts") {
    verdict = "FIX";
    reason =
      "The chart case used a live fetch. It now charts a fixture page. The live web.read cases stay skipIf(ONLINE) with a visible reason.";
  } else if (rel === "core/__tests__/actionlint-pin.test.ts") {
    verdict = "FIX";
    reason = "scripts[0] is narrowed before use so strict noUncheckedIndexedAccess typechecks.";
  }
  return { rel, needs: needs.join(", ") || "hermetic", verdict, reason };
}

function main() {
  const files = [
    ...walk(path.join(root, "core", "__tests__")),
    ...walk(path.join(root, "kernel", "tests")),
  ].sort();
  const rows = files.map(classify);
  const totals = { KEEP: 0, FIX: 0, MERGE: 0, QUARANTINE: 0, REMOVE: 0 };
  for (const row of rows) totals[row.verdict] = (totals[row.verdict] || 0) + 1;
  const interesting = rows.filter((row) => row.verdict !== "KEEP" || row.needs !== "hermetic");
  console.log(`files ${rows.length}`);
  console.log(
    `KEEP ${totals.KEEP} FIX ${totals.FIX} MERGE ${totals.MERGE} QUARANTINE ${totals.QUARANTINE} REMOVE ${totals.REMOVE}`,
  );
  for (const row of interesting) {
    console.log(`${row.verdict}\t${row.needs}\t${row.rel}\t${row.reason}`);
  }
}

module.exports = { classify, walk };

if (require.main === module) main();
