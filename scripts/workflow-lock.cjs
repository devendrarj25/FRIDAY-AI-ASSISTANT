#!/usr/bin/env node
/**
 * FRIDAY - the optional content lock on the GitHub workflow files and the Windows CMD chain.
 *
 * The lock records the SHA-256 of each file (line endings normalised). It is DORMANT by owner policy:
 * `config/workflow-lock.json` and `config/cmd-chain-lock.json` both carry `"enforced": false`, so editing a
 * workflow, a composite action or a CMD chain file fails nothing while it is off. The mechanism stays
 * available. To switch it on later, refresh the hashes and then set `enforced` to true:
 *
 *   node scripts/workflow-lock.cjs --write                  record the workflow files
 *   node scripts/workflow-lock.cjs --cmd-chain --write      record the CMD chain files
 *
 * --write never changes `enforced`; the switch is one edit in the lock JSON. While it is on:
 *
 *   node scripts/workflow-lock.cjs                          check the workflows (exit 1 on any difference)
 *   node scripts/workflow-lock.cjs --cmd-chain              check the CMD chain (exit 1 on any difference)
 *
 * The CMD chain list is the one AGENTS.md names in its "The Windows CMD chain" section. Every command takes an
 * optional `--root <dir>` to work on another checkout (the tests use a temporary copy).
 *
 * The third lock is NOT dormant: `config/agents-lock.json` records AGENTS.md and is always on (no switch). The hash
 * ignores line endings and the two version numbers the release engine rewrites ("current public line **FRIDAY x**"
 * and "Next public revision is **x**"), so a release never trips it. Only the owner asks for a change to AGENTS.md:
 *
 *   node scripts/workflow-lock.cjs --agents                 check AGENTS.md (exit 1 when it differs)
 *   node scripts/workflow-lock.cjs --agents --write         record AGENTS.md after the owner's change
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const LOCK_FILE = path.join(root, "config", "workflow-lock.json");
const CHAIN_LOCK_FILE = path.join(root, "config", "cmd-chain-lock.json");
const AGENTS_LOCK_FILE = path.join(root, "config", "agents-lock.json");

const KINDS = {
  workflows: { name: "workflow-lock.json", label: "workflow lock", flag: "" },
  "cmd-chain": { name: "cmd-chain-lock.json", label: "CMD chain lock", flag: " --cmd-chain" },
  agents: { name: "agents-lock.json", label: "AGENTS.md lock", flag: " --agents" },
};

const NOTES = {
  workflows:
    "SHA-256 of every workflow and composite action, line endings normalised. Dormant by owner policy: enforced is false, so nothing is checked. To re-lock, run: node scripts/workflow-lock.cjs --write, then set enforced to true.",
  "cmd-chain":
    "SHA-256 of every file of the Windows CMD chain (npm run setup, doctor, build:win), line endings normalised. The list is the one AGENTS.md names in its Windows CMD chain section. Dormant by owner policy: enforced is false, so nothing is checked. To re-lock, run: node scripts/workflow-lock.cjs --cmd-chain --write, then set enforced to true.",
  agents:
    "SHA-256 of AGENTS.md, line endings normalised and the two version numbers the release engine rewrites ignored. Always on: there is no switch. Only the owner asks for a change to AGENTS.md; after it, record the file with: node scripts/workflow-lock.cjs --agents --write.",
};

function lockPath(kind, base = root) {
  return path.join(base, "config", KINDS[kind].name);
}

function readBody(kind, base = root) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(kind, base), "utf8"));
  } catch {
    return null;
  }
}

/** On only when the lock file says the literal boolean true; missing, unreadable or any other value is off. */
function isEnforced(kind, base = root) {
  if (kind === "agents") return true;
  const body = readBody(kind, base);
  return Boolean(body) && body.enforced === true;
}

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

function readLock(base = root) {
  return (readBody("workflows", base) || {}).files || {};
}

function writeKind(kind, files, base) {
  const file = lockPath(kind, base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { note: NOTES[kind], enforced: isEnforced(kind, base), files };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Records the workflow files. Keeps the existing `enforced` value (false when there is none). */
function writeLock(base = root) {
  writeKind("workflows", current(base), base);
}

/**
 * The CMD chain files, exactly as AGENTS.md lists them: the section whose heading starts
 * "### The Windows CMD chain" (the earlier "... is finished and locked" heading matches too), up to the next
 * heading of level 2 or 3.
 */
function chainFiles(base = root) {
  const agents = fs.readFileSync(path.join(base, "AGENTS.md"), "utf8");
  const start = /^### The Windows CMD chain[^\n]*\n/m.exec(agents);
  if (!start) return [];
  const rest = agents.slice(start.index + start[0].length);
  const next = /^#{2,3} /m.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  const names = [...block.matchAll(/`(scripts\/[a-z0-9-]+\.(?:cjs|ps1|cmd))`/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

function currentChain(base = root) {
  const files = {};
  for (const file of chainFiles(base)) files[file] = digest(file, base);
  return files;
}

function readChainLock(base = root) {
  return (readBody("cmd-chain", base) || {}).files || {};
}

/** Records the CMD chain files. Throws when AGENTS.md yields none, so a renamed heading never writes an empty lock. */
function writeChainLock(base = root) {
  const files = currentChain(base);
  if (Object.keys(files).length === 0) {
    throw new Error(
      "AGENTS.md lists no CMD chain files (the section 'The Windows CMD chain' is missing or empty); lock not written",
    );
  }
  writeKind("cmd-chain", files, base);
}

const AGENTS_VERSION_SENTENCES = [
  /(current public line\s*\*\*FRIDAY\s+)\d+\.\d+\.\d+(?:\.\d+)?(\*\*)/g,
  /(Next public revision is\s*\*\*)\d+\.\d+\.\d+(?:\.\d+)?(\*\*)/g,
];

/** SHA-256 of AGENTS.md without the two version numbers the release engine rewrites, line endings normalised. */
function agentsDigest(base = root) {
  let text = fs.readFileSync(path.join(base, "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
  for (const pattern of AGENTS_VERSION_SENTENCES) text = text.replace(pattern, "$1VERSION$2");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function currentAgents(base = root) {
  return { "AGENTS.md": agentsDigest(base) };
}

function readAgentsLock(base = root) {
  return (readBody("agents", base) || {}).files || {};
}

/** Records AGENTS.md. Only for a change the owner asked for in his own message. */
function writeAgentsLock(base = root) {
  const file = lockPath("agents", base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { note: NOTES.agents, files: currentAgents(base) };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** `{ enforced, problems }`: problems is always empty while the lock is off. */
function verify(kind, base = root) {
  if (!isEnforced(kind, base)) return { enforced: false, problems: [] };
  if (kind === "agents") {
    if (!readBody("agents", base)) {
      return {
        enforced: true,
        problems: ["config/agents-lock.json is missing or unreadable: AGENTS.md is not locked"],
      };
    }
    return { enforced: true, problems: compare(readAgentsLock(base), currentAgents(base)) };
  }
  const recorded = kind === "cmd-chain" ? readChainLock(base) : readLock(base);
  const actual = kind === "cmd-chain" ? currentChain(base) : current(base);
  return { enforced: true, problems: compare(recorded, actual) };
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
  isEnforced,
  verify,
  agentsDigest,
  currentAgents,
  readAgentsLock,
  writeAgentsLock,
  AGENTS_LOCK_FILE,
};

function main(argv) {
  const at = argv.indexOf("--root");
  const base = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : root;
  const kind = argv.includes("--agents")
    ? "agents"
    : argv.includes("--cmd-chain")
      ? "cmd-chain"
      : "workflows";
  const { label, flag } = KINDS[kind];
  const lockName = `config/${KINDS[kind].name}`;
  const count = () =>
    Object.keys(
      kind === "agents"
        ? currentAgents(base)
        : kind === "cmd-chain"
          ? currentChain(base)
          : current(base),
    ).length;
  try {
    if (argv.includes("--write")) {
      if (kind === "agents") writeAgentsLock(base);
      else if (kind === "cmd-chain") writeChainLock(base);
      else writeLock(base);
      console.log(`${label} written for ${count()} files (enforced: ${isEnforced(kind, base)})`);
      return 0;
    }
    if (!isEnforced(kind, base)) {
      console.log(`${label} is off (enforced: false in ${lockName}); nothing checked`);
      return 0;
    }
    const { problems } = verify(kind, base);
    if (problems.length) {
      console.error(
        `${kind === "agents" ? "AGENTS.md" : kind === "cmd-chain" ? "CMD chain" : "workflow"} files differ from the lock:`,
      );
      for (const line of problems) console.error(`  - ${line}`);
      console.error(
        kind === "agents"
          ? `AGENTS.md is locked. Only the owner asks for a change to it; after his change, record it with: node scripts/workflow-lock.cjs${flag} --write`
          : `The lock is on (enforced: true in ${lockName}). Record the new files with: node scripts/workflow-lock.cjs${flag} --write`,
      );
      return 1;
    }
    console.log(`${label} holds for ${count()} files`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
