#!/usr/bin/env node
/**
 * Opt in to the repo-owned git hooks. Off until the owner runs this.
 *   node scripts/setup-hooks.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const hooks = path.join("scripts", "git-hooks");

function main() {
  const result = spawnSync("git", ["config", "core.hooksPath", hooks], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr || "git config core.hooksPath failed");
    process.exit(result.status || 1);
  }
  fs.chmodSync(path.join(root, hooks, "pre-push"), 0o755);
  console.log(`git hooks path is ${hooks}`);
  console.log("pre-push runs npm run preflight. Unset core.hooksPath to turn it off.");
}

if (require.main === module) main();
