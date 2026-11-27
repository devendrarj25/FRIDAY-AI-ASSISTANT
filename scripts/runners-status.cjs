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
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();

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

/** A Response-like for the chain from a fetch answer that only offers `json()`. */
function chainResponse(response) {
  if (typeof response?.text === "function") return response;
  return {
    status: Number(response?.status) || (response?.ok ? 200 : 0),
    ok: response?.ok !== false && Boolean(response),
    headers: response?.headers || { get: () => null },
    text: async () => JSON.stringify(await response.json()),
  };
}

/**
 * The newest release tag of a repository, or null. It asks the one source chain (the API, then the public feed, then
 * the last stored answer under FRIDAY_ROOT), so a rate limit or a blocked host does not hide it.
 */
async function newestTag(repo, { fetchImpl = fetch, timeoutMs = 8000, store = null, root } = {}) {
  try {
    const vendor = require("../electron/vendor-sources.cjs");
    const dir = root || process.env.FRIDAY_ROOT;
    const got = await vendor.resolveLatest(
      `release:${repo}`,
      vendor.chainFor({ latest: { kind: "github", ref: repo } }),
      {
        fetchImpl: async (url, init) =>
          chainResponse(
            await fetchImpl(url, {
              ...init,
              headers: { ...init?.headers, "user-agent": "friday-runners-status" },
            }),
          ),
        store: store || (dir ? vendor.storeFor(dir) : null),
        timeoutMs,
      },
    );
    return got.ok && typeof got.tag === "string" && got.tag ? got.tag : null;
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
