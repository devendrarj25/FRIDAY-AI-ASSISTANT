#!/usr/bin/env node
/**
 * Repair version and documentation in this workspace. Never commits or pushes.
 * Each parallel PR Validation job runs this so a docs drift is repaired
 * before that job's checks, without a second commit.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function nodeScript(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function main() {
  const check = spawnSync(process.execPath, ["scripts/release-engine.cjs", "heal", "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  if (check.status === 0) {
    console.log("documentation already in sync");
    return;
  }
  const version = nodeScript([
    "scripts/release-engine.cjs",
    "identity",
    "--field",
    "releaseVersion",
  ]);
  const text = String(version.stdout || "").trim();
  if (version.status !== 0 || !/^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(text)) {
    console.error(`auto-heal cannot repair version "${text}"`);
    process.exit(1);
  }
  run(["scripts/release-engine.cjs", "heal", "--version", text]);
  run(["scripts/arrange-project.cjs", "--fix"]);
  run(["scripts/release-engine.cjs", "verify"]);
}

if (require.main === module) main();
