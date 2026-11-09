#!/usr/bin/env node
// FRIDAY - are the pinned local runners (Ollama, llama.cpp, ...) behind the newest official release?
//
// config/local-runners.json pins each downloadable runner to one release with a SHA-256, because setup downloads
// that exact file and checks it. A pin cannot follow "latest" by itself: the file must be downloaded once and its
// hash recorded. This reports how far each pin is behind, so a bump is a decision made on facts, not a surprise.
// It only reads; it changes nothing and an unreachable GitHub is "unknown", never a failure.
//
//   node scripts/runners-status.cjs            -> print the table (exit 0)
//   node scripts/runners-status.cjs --strict   -> exit 1 when any pin is behind
//   node scripts/runners-status.cjs --json     -> machine readable
"use strict";

const path = require("node:path");

/** "b12230" -> [12230], "v0.40.15" -> [0, 40, 15]. Anything else (an rc, a date) has no comparable number. */
function tagNumbers(tag) {
  const match = /^[vb]?(\d+(?:\.\d+)*)$/i.exec(String(tag || "").trim());
  return match ? match[1].split(".").map(Number) : null;
}

/** -1 older, 0 same, 1 newer, null when either tag cannot be compared. */
function compareTags(a, b) {
  const left = tagNumbers(a);
  const right = tagNumbers(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** current, behind, unknown (offline or an uncomparable tag). */
function classify(pinned, newest) {
  if (!newest) return "unknown";
  const order = compareTags(pinned, newest);
  if (order === null) return "unknown";
  return order < 0 ? "behind" : "current";
}

/** The newest published (not draft, not pre-release) release tag of a repository, or null. */
async function newestTag(repo, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "friday-runners-status" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.tag_name === "string" ? body.tag_name : null;
  } catch {
    return null;
  }
}

/** The pinned runners that have a release to compare. */
function pinnedRunners(config) {
  return (config?.runners || [])
    .filter((row) => row?.release?.repo && row.release.tag)
    .map((row) => ({
      id: row.id,
      name: row.name,
      repo: row.release.repo,
      pinned: row.release.tag,
    }));
}

async function report(config, options = {}) {
  const rows = [];
  for (const runner of pinnedRunners(config)) {
    const newest = await newestTag(runner.repo, options);
    rows.push({ ...runner, newest, state: classify(runner.pinned, newest) });
  }
  return rows;
}

function format(rows, checked) {
  const lines = [
    `Pinned local runners (config/local-runners.json, pins checked ${checked || "unknown"})`,
  ];
  for (const row of rows) {
    const note =
      row.state === "behind"
        ? `newer release ${row.newest} exists - download it once, record its SHA-256 in config/local-runners.json`
        : row.state === "current"
          ? "the newest release"
          : "newest release could not be read (offline, rate limit or an uncomparable tag)";
    lines.push(
      `  ${row.state.toUpperCase().padEnd(8)} ${row.name.padEnd(12)} pinned ${row.pinned.padEnd(10)} ${note}`,
    );
  }
  return lines.join("\n");
}

module.exports = { tagNumbers, compareTags, classify, newestTag, pinnedRunners, report, format };

if (require.main === module) {
  const config = require(path.resolve(__dirname, "..", "config", "local-runners.json"));
  const args = process.argv.slice(2);
  report(config).then((rows) => {
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else console.log(format(rows, config.checked));
    process.exitCode =
      args.includes("--strict") && rows.some((row) => row.state === "behind") ? 1 : 0;
  });
}
