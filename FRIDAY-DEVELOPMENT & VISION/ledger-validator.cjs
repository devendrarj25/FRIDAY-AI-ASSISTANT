#!/usr/bin/env node
/**
 * Adoption-ledger validator.
 * Lives in the working layer and is deleted with that folder.
 *
 * Fails when a DONE or SUPERSEDED row has no evidence test that exists,
 * when a MISSING or PARTIAL row's source file or heading is gone, or when
 * a removed source still has an open row.
 *
 * Usage from the repo root:
 *   node "FRIDAY-DEVELOPMENT & VISION/ledger-validator.cjs"
 *   node "FRIDAY-DEVELOPMENT & VISION/ledger-validator.cjs" --pass
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const LAYER = __dirname;
const LEDGER = path.join(LAYER, "ADOPTION_LEDGER.json");
const CLOSED = new Set(["DONE", "SUPERSEDED", "REJECT", "BACKLOG"]);
const OPEN = new Set(["MISSING", "PARTIAL"]);
const EVIDENCE_STATUS = new Set(["DONE", "SUPERSEDED"]);

function norm(value) {
  return String(value ?? "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSource(source) {
  const full = path.join(LAYER, source);
  return fs.existsSync(full) ? full : null;
}

function headingsOf(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".md")) {
    const heads = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) heads.push(norm(line.replace(/^#+\s*/, "")));
    }
    return { text, heads };
  }
  return { text, heads: [] };
}

function headingPresent(filePath, heading) {
  const wanted = norm(heading);
  const base = path.basename(filePath);
  const stem = base.replace(/\.[^.]+$/, "");
  if (wanted === norm(base) || wanted === norm(stem)) return true;
  const { text, heads } = headingsOf(filePath);
  if (heads.some((head) => head === wanted)) return true;
  if (!filePath.endsWith(".md") && norm(text).includes(wanted) && wanted.length > 0) return true;
  return false;
}

function namePresent(testFile, name) {
  const text = fs.readFileSync(path.join(ROOT, testFile), "utf8");
  if (testFile.endsWith(".py")) return text.includes(`def ${name}`);
  const patterns = [`it(${JSON.stringify(name)}`, `test(${JSON.stringify(name)}`, `it('${name}'`, `test('${name}'`];
  return patterns.some((pattern) => text.includes(pattern));
}

function load() {
  return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
}

function validate(ledger) {
  const errors = [];
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const totals = { DONE: 0, SUPERSEDED: 0, REJECT: 0, MISSING: 0, PARTIAL: 0, BACKLOG: 0 };
  const seen = new Map();

  for (const row of rows) {
    const status = row.status;
    if (!Object.prototype.hasOwnProperty.call(totals, status)) {
      errors.push(`${row.source || "?"} unknown status ${status}`);
      continue;
    }
    totals[status] += 1;
    const key = `${row.source}::${norm(row.heading)}`;
    seen.set(key, (seen.get(key) || 0) + 1);

    const filePath = resolveSource(row.source || "");
    if (OPEN.has(status)) {
      if (!filePath) {
        errors.push(`open row has no source file: ${row.source} :: ${row.heading}`);
        continue;
      }
      if (!headingPresent(filePath, row.heading)) {
        errors.push(`open row heading is gone: ${row.source} :: ${row.heading}`);
      }
      continue;
    }

    if (!CLOSED.has(status)) continue;
    if (status === "REJECT" || status === "BACKLOG") {
      if (!row.notes || String(row.notes).trim().length < 12) {
        errors.push(`${status} row has no reason: ${row.source} :: ${row.heading}`);
      }
      const target = Array.isArray(row.target) ? row.target[0] : "";
      if (!target || !fs.existsSync(path.join(ROOT, target))) {
        errors.push(`${status} row reason doc is missing: ${row.source} :: ${target}`);
      }
    }
    if (!EVIDENCE_STATUS.has(status)) continue;

    const evidence = row.evidence;
    if (!evidence || typeof evidence !== "object") {
      errors.push(`${status} row lacks evidence: ${row.source} :: ${row.heading}`);
      continue;
    }
    const testFile = evidence.test;
    const testName = evidence.name;
    const caller = evidence.caller;
    if (!testFile || !fs.existsSync(path.join(ROOT, testFile))) {
      errors.push(`${status} evidence test file is missing: ${testFile} (${row.source})`);
      continue;
    }
    if (!testName || !namePresent(testFile, testName)) {
      errors.push(`${status} evidence test name is missing: ${testName} in ${testFile}`);
    }
    if (!caller || !fs.existsSync(path.join(ROOT, caller))) {
      errors.push(`${status} evidence caller is missing: ${caller} (${row.source})`);
    }
  }

  for (const [key, count] of seen) {
    if (count < 2) continue;
    const split = key.indexOf("::");
    const source = key.slice(0, split);
    const heading = key.slice(split + 2);
    const filePath = resolveSource(source);
    if (!filePath) {
      errors.push(`duplicate closed row ${key}`);
      continue;
    }
    const { text, heads } = headingsOf(filePath);
    const copies = filePath.endsWith(".md")
      ? heads.filter((head) => head === heading).length
      : text.split(heading).length - 1;
    if (copies < count) errors.push(`duplicate row ${key} appears ${count} times but the file has ${copies}`);
  }

  for (const key of ["DONE", "SUPERSEDED", "REJECT", "MISSING"]) {
    if ((ledger.totals || {})[key] !== totals[key]) {
      errors.push(`totals.${key} is ${ledger.totals?.[key]} but rows sum to ${totals[key]}`);
    }
  }

  const cited = new Map();
  for (const row of rows) {
    if (!EVIDENCE_STATUS.has(row.status) || !row.evidence) continue;
    const bucket = cited.get(row.evidence.test) || new Set();
    bucket.add(row.evidence.name);
    cited.set(row.evidence.test, bucket);
  }
  return { errors, totals, cited };
}

function runPass(cited) {
  const errors = [];
  for (const [testFile, names] of cited) {
    if (testFile.endsWith(".py")) {
      const python = fs.existsSync(path.join(ROOT, ".venv/bin/python"))
        ? path.join(ROOT, ".venv/bin/python")
        : "python3";
      const args = ["-m", "pytest", testFile, "-q", "--tb=line"];
      const run = spawnSync(python, args, { cwd: ROOT, stdio: "inherit" });
      if (run.status !== 0) errors.push(`pytest failed: ${testFile}`);
      continue;
    }
    const vitest = path.join(ROOT, "node_modules/vitest/vitest.mjs");
    const run = spawnSync(process.execPath, [vitest, "run", "--testTimeout=60000", testFile], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (run.status !== 0) errors.push(`vitest failed: ${testFile}`);
    if (names.size === 0) errors.push(`no test names cited for ${testFile}`);
  }
  return errors;
}

function main() {
  const ledger = load();
  const { errors, totals, cited } = validate(ledger);
  if (process.argv.includes("--pass")) errors.push(...runPass(cited));
  if (errors.length) {
    for (const error of errors) console.error(`ledger: ${error}`);
    console.error(`ledger: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `ledger ok  DONE ${totals.DONE}  SUPERSEDED ${totals.SUPERSEDED}  REJECT ${totals.REJECT}  MISSING ${totals.MISSING}  PARTIAL ${totals.PARTIAL}  BACKLOG ${totals.BACKLOG}`,
  );
}

main();
