#!/usr/bin/env node
/**
 * FRIDAY - the lock on the GitHub workflow files.
 *
 * The eleven workflows and the three composite actions were run on hosted
 * runners and are green. `config/workflow-lock.json` records the SHA-256 of
 * each file (line endings normalised), and `core/__tests__/workflow-lock.test.ts`
 * fails when any of them differs. A change there needs the owner's request and
 * second yes (AGENTS.md, GitHub workflows stay locked); after he agrees, the
 * edit and the new lock are one change:
 *
 *   node scripts/workflow-lock.cjs            check (exit 1 on any difference)
 *   node scripts/workflow-lock.cjs --write    record the current files
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const LOCK_FILE = path.join(root, "config", "workflow-lock.json");

function lockedFiles(base = root) {
  const out = [];
  const workflows = path.join(base, ".github", "workflows");
  for (const name of fs.readdirSync(workflows).sort()) {
    if (/\.ya?ml$/.test(name)) out.push(`.github/workflows/${name}`);
  }
  const actions = path.join(base, ".github", "actions");
  for (const name of fs.readdirSync(actions).sort()) {
    const file = path.join(actions, name, "action.yml");
    if (fs.existsSync(file)) out.push(`.github/actions/${name}/action.yml`);
  }
  return out;
}

function digest(file, base = root) {
  const text = fs.readFileSync(path.join(base, file), "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function current(base = root) {
  const files = {};
  for (const file of lockedFiles(base)) files[file] = digest(file, base);
  return files;
}

/** Differences between the recorded lock and the files on disk. */
function compare(recorded, actual) {
  const problems = [];
  for (const file of Object.keys(actual)) {
    if (!(file in recorded)) problems.push(`${file}: added, not in the lock`);
    else if (recorded[file] !== actual[file]) problems.push(`${file}: changed since it was locked`);
  }
  for (const file of Object.keys(recorded)) {
    if (!(file in actual)) problems.push(`${file}: removed, still in the lock`);
  }
  return problems;
}

function readLock() {
  return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")).files || {};
}

function writeLock(base = root) {
  const body = {
    note: "SHA-256 of every workflow and composite action, line endings normalised. Changed only with the owner's request and second yes; see AGENTS.md, GitHub workflows stay locked. Refresh with: node scripts/workflow-lock.cjs --write",
    files: current(base),
  };
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

module.exports = { lockedFiles, digest, current, compare, readLock, writeLock, LOCK_FILE };

if (require.main === module) {
  if (process.argv.includes("--write")) {
    writeLock();
    console.log(`workflow lock written for ${Object.keys(current()).length} files`);
  } else {
    const problems = compare(readLock(), current());
    if (problems.length) {
      console.error("workflow files differ from the lock:");
      for (const line of problems) console.error(`  - ${line}`);
      console.error(
        "They change only when the owner asks and confirms a second time (AGENTS.md). Then record them: node scripts/workflow-lock.cjs --write",
      );
      process.exit(1);
    }
    console.log(`workflow lock holds for ${Object.keys(current()).length} files`);
  }
}
