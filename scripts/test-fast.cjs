#!/usr/bin/env node
// FRIDAY - quick feedback while you work.
// Inside a git checkout: run only the tests related to files you changed.
// Anywhere else (zip export, no git): run the whole suite, so it never
// silently tests nothing.
const { spawnDirect } = require("./win-spawn.cjs");
const gitOk = (args) => spawnDirect("git", args, { stdio: "ignore" }).status === 0;
const isGit = gitOk(["rev-parse", "--is-inside-work-tree"]);
const hasHead = isGit && gitOk(["rev-parse", "--verify", "-q", "HEAD"]);
const args = ["vitest", "run", "--testTimeout=60000"];
if (hasHead) args.push("--changed");
else console.log("test:fast - no git history here, running the full suite");
const bin = process.platform === "win32" ? "npx.cmd" : "npx";
const r = spawnDirect(bin, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
