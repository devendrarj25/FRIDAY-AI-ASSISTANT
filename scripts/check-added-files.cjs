#!/usr/bin/env node
/**
 * FRIDAY — files a pull request adds or changes.
 *
 * Fails when the range adds a file that does not belong in the repository:
 * build output, caches, virtual environments, logs and scratch files, or a
 * single file larger than the limit (an installer, a model, a recording).
 * Only added and modified paths are read, so history that is already in the
 * tree is never judged again.
 *
 *   node scripts/check-added-files.cjs origin/main
 *   node scripts/check-added-files.cjs <base>..<head>
 *
 * A missing base ref exits 2. An empty range exits 0.
 */
"use strict";

const { execFileSync } = require("node:child_process");

const MAX_BYTES = 5 * 1024 * 1024;

const STRAY_PATH = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist-desktop|\.output|\.vite|\.turbo|\.cache|coverage)\//,
  /^release\//,
  /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv)\//,
  /\.(log|tmp|bak|orig|rej|swp|pyc)$/i,
  /(^|\/)(\.DS_Store|Thumbs\.db)$/,
  /\.(exe|msi|nupkg|blockmap)$/i,
];

/** Folders and files an AI tool or editor agent leaves behind. They never belong in the repository. */
const AGENT_PATH = [
  /(^|\/)\.(claude|claude-plugin|cursor|windsurf|codex|gemini|continue|aider[^/]*|roo|kiro|trae|junie|augment)(\/|$)/,
  /(^|\/)\.(cursorrules|windsurfrules|clinerules|cursorignore)$/,
  /^\.github\/(copilot-instructions\.md|instructions\/)/,
  /^GEMINI\.md$/,
];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Problems with one path of a given size; an empty list means the path is fine. */
function problemsFor(file, size, limit = MAX_BYTES) {
  const problems = [];
  const normal = String(file).replace(/\\/g, "/");
  if (STRAY_PATH.some((pattern) => pattern.test(normal))) {
    problems.push(`${normal} is build output, a cache, a log or a scratch file`);
  }
  if (AGENT_PATH.some((pattern) => pattern.test(normal))) {
    problems.push(
      `${normal} is an AI tool or agent file; the rulebook is AGENTS.md and nothing else is kept`,
    );
  }
  if (Number.isFinite(size) && size > limit) {
    problems.push(
      `${normal} is ${(size / 1048576).toFixed(1)} MiB, over the ${limit / 1048576} MiB limit`,
    );
  }
  return problems;
}

function checkRange(base, cwd = process.cwd(), limit = MAX_BYTES) {
  const text = String(base || "");
  const spec = text.includes("..") ? text : `${text}...HEAD`;
  const head = text.includes("..") ? text.split("..").pop() || "HEAD" : "HEAD";
  let names = "";
  try {
    names = git(["diff", "--name-only", "--diff-filter=AMR", "-z", spec], cwd);
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim();
    return { ok: false, missing: true, problems: [detail || `cannot read ${spec}`] };
  }
  const problems = [];
  for (const file of names.split("\0").filter(Boolean)) {
    let size = NaN;
    try {
      size = Number(git(["cat-file", "-s", `${head}:${file}`], cwd).trim());
    } catch {
      // a submodule or a path that is not a blob: only the name is judged
    }
    problems.push(...problemsFor(file, size, limit));
  }
  return { ok: problems.length === 0, missing: false, problems };
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node scripts/check-added-files.cjs <base-ref-or-range>");
    process.exit(2);
  }
  const result = checkRange(base, process.cwd());
  if (result.missing) {
    console.error(result.problems.join("\n"));
    process.exit(2);
  }
  if (!result.ok) {
    for (const line of result.problems) console.error(`::error title=Unwanted file::${line}`);
    process.exit(1);
  }
  console.log(`added files ok (${base})`);
}

module.exports = { MAX_BYTES, problemsFor, checkRange };

if (require.main === module) main();
