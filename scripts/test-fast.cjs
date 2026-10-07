#!/usr/bin/env node
// FRIDAY - quick feedback while you work.
// Inside a git checkout: run only the tests related to files you changed.
// Anywhere else (zip export, no git): run the whole suite, so it never
// silently tests nothing.
const { spawnSync } = require("node:child_process");
const isGit =
  spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0;
const hasHead =
  isGit &&
  spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { stdio: "ignore" }).status === 0;
const args = ["vitest", "run", "--testTimeout=60000"];
if (hasHead) args.push("--changed");
else console.log("test:fast - no git history here, running the full suite");
const r = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
