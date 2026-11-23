#!/usr/bin/env node
/**
 * Training readiness of FRIDAY's own speech recognition, levels 1 to 3, reported honestly. It reads the
 * spec (config/voice/training-readiness.json), a manifest and the owner's training records, and prints PASS,
 * PARTIAL or UNVERIFIED per level. It trains nothing, loads nothing and reads no recording.
 *
 *   node scripts/voice-readiness.cjs [--manifest FILE] [--records FILE] [--json] [--require N]
 *
 * The default manifest is the catalogue in config/voice/eval-manifest.json (no items, so level 1 is
 * UNVERIFIED). The owner's real manifest and records (runs, releases) stay on his PC outside the repository:
 * pass them with --manifest and --records, or set FRIDAY_VOICE_TRAINING_RECORDS. Exit: 0 report printed,
 * 1 bad usage, 3 with --require N when a level up to N is not PASS.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadTs, sha256 } = require("./voice-eval.cjs");

const ROOT = path.resolve(__dirname, "..");
const readJson = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
};

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[(i += 1)];
  }
  return flags;
}

async function main(argv, env = process.env, out = console.log) {
  const flags = parseArgs(argv);
  const lib = await loadTs("src/lib/friday/voice-engine/voice-training-readiness.ts");
  const spec = readJson(path.join(ROOT, "config", "voice", "training-readiness.json"));
  const manifestFile = path.resolve(
    flags.manifest || path.join(ROOT, "config", "voice", "eval-manifest.json"),
  );
  const recordsFile = flags.records || env.FRIDAY_VOICE_TRAINING_RECORDS || "";
  for (const [label, file] of [
    ["manifest", manifestFile],
    ["records", recordsFile],
  ]) {
    if (file && !fs.existsSync(file)) {
      out(`${label} not found: ${file}`);
      return 1;
    }
  }
  const report = lib.assessReadiness({
    spec,
    sha256,
    exists: (relative) => fs.existsSync(path.join(ROOT, relative)),
    manifest: readJson(manifestFile),
    ...(recordsFile ? { records: readJson(recordsFile) } : {}),
  });

  if (flags.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(report.summary);
    for (const level of report.levels) {
      out(`\nLevel ${level.level}  ${level.status.padEnd(10)}  ${level.title}`);
      for (const check of level.checks) {
        const mark = check.status === "pass" ? "ok  " : check.status === "fail" ? "FAIL" : "----";
        out(`  ${mark} ${check.id.padEnd(24)} ${check.detail}`);
      }
      for (const gap of level.notBuilt) out(`  not built here: ${gap}`);
    }
  }
  const need = Number(flags.require || 0);
  return report.levels.some((l) => l.level <= need && l.status !== "PASS") ? 3 : 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
