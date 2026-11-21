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
 *
 * The same lock holds the Windows CMD chain (`npm run setup`, `doctor`, `build:win`): the files AGENTS.md lists
 * under "The Windows CMD chain is finished and locked", recorded in `config/cmd-chain-lock.json` and checked by
 * `core/__tests__/cmd-chain-lock.test.ts`. They change only on the owner's request or a real log from his PC;
 * then the edit and the new lock are one change:
 *
 *   node scripts/workflow-lock.cjs --cmd-chain            check
 *   node scripts/workflow-lock.cjs --cmd-chain --write    record
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

const CHAIN_LOCK_FILE = path.join(root, "config", "cmd-chain-lock.json");
const CHAIN_NOTE =
  "SHA-256 of every file of the Windows CMD chain (npm run setup, doctor, build:win), line endings normalised. The list is the one AGENTS.md names under 'The Windows CMD chain is finished and locked'. Changed only on the owner's request or a real log from his PC; a new tool, package or model is added through its catalogue, not here (docs/FRIDAY_BUILD_AND_RELEASE.md). Refresh with: node scripts/workflow-lock.cjs --cmd-chain --write";

/** The CMD chain files, exactly as AGENTS.md lists them. */
function chainFiles(base = root) {
  const agents = fs.readFileSync(path.join(base, "AGENTS.md"), "utf8");
  const at = agents.indexOf("### The Windows CMD chain is finished and locked");
  if (at < 0) return [];
  const end = agents.indexOf("### Changing something that already works", at);
  const block = agents.slice(at, end < 0 ? undefined : end);
  const names = [...block.matchAll(/`(scripts\/[a-z0-9-]+\.(?:cjs|ps1|cmd))`/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

function currentChain(base = root) {
  const files = {};
  for (const file of chainFiles(base)) files[file] = digest(file, base);
  return files;
}

function readChainLock(file = CHAIN_LOCK_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8")).files || {};
}

function writeChainLock(base = root, file = CHAIN_LOCK_FILE) {
  fs.writeFileSync(
    file,
    `${JSON.stringify({ note: CHAIN_NOTE, files: currentChain(base) }, null, 2)}\n`,
  );
}

module.exports = {
  lockedFiles,
  digest,
  current,
  compare,
  readLock,
  writeLock,
  LOCK_FILE,
  chainFiles,
  currentChain,
  readChainLock,
  writeChainLock,
  CHAIN_LOCK_FILE,
};

if (require.main === module && process.argv.includes("--cmd-chain")) {
  if (process.argv.includes("--write")) {
    writeChainLock();
    console.log(`CMD chain lock written for ${Object.keys(currentChain()).length} files`);
  } else {
    const problems = compare(readChainLock(), currentChain());
    if (problems.length) {
      console.error("CMD chain files differ from the lock:");
      for (const line of problems) console.error(`  - ${line}`);
      console.error(
        "They change only on the owner's request or a real log from his PC (AGENTS.md). Then record them: node scripts/workflow-lock.cjs --cmd-chain --write",
      );
      process.exit(1);
    }
    console.log(`CMD chain lock holds for ${Object.keys(currentChain()).length} files`);
  }
} else if (require.main === module) {
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
