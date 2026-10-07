#!/usr/bin/env node
/**
 * FRIDAY — reuse a green PR Validation instead of paying for it twice.
 *
 * Test EXE Build and Official Publish call this before they repeat validation.
 * Reuse only when THIS commit already has a successful "PR Validation" result
 * that is at most seven days old. A different commit, a failure, a missing
 * timestamp, or an older result means run validation again.
 *
 *   node scripts/validation-freshness.cjs --sha <sha> --evidence <file.json>
 *
 * Evidence is the combined commit-status and check-run list for that sha:
 *   [{ name|context, state|conclusion, updated_at|completed_at, sha|head_sha }]
 */
"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isPrValidation(name) {
  if (typeof name !== "string" || !name) return false;
  if (name === "PR Validation") return true;
  return /^PR Validation \/ [\w.-]+$/.test(name);
}

function decideReuse({ sha, evidence, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const rows = Array.isArray(evidence) ? evidence : [];
  const hits = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = row.name || row.context;
    if (!isPrValidation(name)) continue;
    const rowSha = row.sha || row.head_sha || sha;
    if (rowSha && sha && rowSha !== sha) continue;
    const when = Date.parse(row.updated_at || row.completed_at || "");
    const state = String(row.state || row.conclusion || row.status || "").toLowerCase();
    hits.push({ when, state });
  }
  if (!hits.length) {
    return { action: "run", reuse: false, reason: "no PR Validation evidence on this commit" };
  }
  hits.sort(
    (a, b) => (Number.isFinite(b.when) ? b.when : 0) - (Number.isFinite(a.when) ? a.when : 0),
  );
  const latest = hits[0];
  if (latest.state === "pending" || latest.state === "queued" || latest.state === "in_progress") {
    return {
      action: "wait",
      reuse: false,
      reason: "PR Validation is already running on this commit",
    };
  }
  if (latest.state !== "success") {
    return {
      action: "run",
      reuse: false,
      reason: `latest PR Validation is ${latest.state || "unfinished"}`,
    };
  }
  if (!Number.isFinite(latest.when)) {
    return { action: "run", reuse: false, reason: "PR Validation success has no timestamp" };
  }
  if (latest.when > now) {
    return { action: "run", reuse: false, reason: "PR Validation timestamp is in the future" };
  }
  if (now - latest.when > maxAgeMs) {
    return { action: "run", reuse: false, reason: "PR Validation is older than 7 days" };
  }
  return {
    action: "reuse",
    reuse: true,
    reason: "fresh green PR Validation on this commit; a second run is skipped",
  };
}

function fetchEvidence(sha) {
  const repo = process.env.GITHUB_REPOSITORY || "";
  if (!repo || !sha || !process.env.GH_TOKEN) return [];
  const evidence = [];
  const pull = (path, expression) => {
    const result = spawnSync("gh", ["api", "--paginate", path, "--jq", expression], {
      encoding: "utf8",
    });
    if (result.status !== 0) return;
    for (const line of String(result.stdout || "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        evidence.push(JSON.parse(trimmed));
      } catch {
        /* a non-JSON line is ignored; a missing result means "run again" */
      }
    }
  };
  pull(
    `repos/${repo}/commits/${sha}/check-runs`,
    ".check_runs[] | {name, conclusion, status, completed_at, sha: .head_sha}",
  );
  pull(
    `repos/${repo}/commits/${sha}/status`,
    `.statuses[] | {name: .context, state, updated_at, sha: "${sha}"}`,
  );
  const runs = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "pr-validation.yml",
      "--commit",
      sha,
      "--limit",
      "20",
      "--json",
      "conclusion,status,headSha,name,updatedAt",
    ],
    { encoding: "utf8" },
  );
  if (runs.status === 0) {
    try {
      const rows = JSON.parse(runs.stdout || "[]");
      for (const row of Array.isArray(rows) ? rows : []) {
        const running = row.status && row.status !== "completed";
        evidence.push({
          name: row.name || "PR Validation",
          conclusion: running ? row.status : row.conclusion,
          completed_at: row.updatedAt,
          sha: row.headSha || sha,
        });
      }
    } catch {
      /* a bad payload means "run again", which is the safe direction */
    }
  }
  return evidence;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return process.argv[index + 1];
}

function main() {
  const sha = readFlag("--sha");
  const file = readFlag("--evidence");
  const nowFlag = readFlag("--now");
  let evidence = [];
  if (file) {
    try {
      evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      evidence = [];
    }
  } else {
    evidence = fetchEvidence(sha);
  }
  const now = nowFlag ? Date.parse(nowFlag) : Date.now();
  const decision = decideReuse({
    sha,
    evidence,
    now: Number.isFinite(now) ? now : Date.now(),
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

module.exports = { MAX_AGE_MS, isPrValidation, decideReuse };

if (require.main === module) main();
