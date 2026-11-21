#!/usr/bin/env node
/**
 * FRIDAY - are the tools the workflows pin still current?
 *
 * The workflows pin the tools they run inside a `run:` line, because a new release must never turn a green branch red:
 * the secret scanner (gitleaks), the workflow linter (actionlint), the workflow security audit (zizmor) and the
 * dependency advisory tool (pip-audit). Dependabot cannot see a version pinned inside a script or a `docker run` line,
 * so nothing would ever say that one of them fell behind. This reads each pin from the file that holds it, asks the
 * official source (GitHub releases, PyPI) for the newest release, and reports a pin as behind when a newer release has
 * been out for at least a grace period (a release that was pulled or fixed within days is never proposed, the same
 * rule as Dependabot's `cooldown`).
 *
 * Report only: it never fails a run and never changes a file; a bump is a pull request the owner reviews (the
 * pinned image digest is looked up, pulled and hashed by hand). `npm run resume` and Health Weekly print it.
 *
 *   node scripts/pin-freshness.cjs            one line per tool
 *   node scripts/pin-freshness.cjs --json     the same as JSON
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const GRACE_DAYS = 14;

/** Where each pin lives and where its newest release is announced. A tool may be pinned in several files. */
const PINS = [
  {
    name: "gitleaks",
    files: [".github/workflows/pr-validation.yml", ".github/workflows/security.yml"],
    pattern: /zricethezav\/gitleaks:v(\d+\.\d+\.\d+)@sha256/g,
    source: { github: "gitleaks/gitleaks" },
  },
  {
    name: "actionlint",
    files: ["scripts/run-actionlint.cjs"],
    pattern: /actionlint\/releases\/download\/v(\d+\.\d+\.\d+)\//g,
    source: { github: "rhysd/actionlint" },
  },
  {
    name: "zizmor",
    files: [".github/workflows/pr-validation.yml"],
    pattern: /zizmor==(\d+\.\d+\.\d+)/g,
    source: { pypi: "zizmor" },
  },
  {
    name: "pip-audit",
    files: [
      ".github/workflows/pr-validation.yml",
      ".github/workflows/security.yml",
      ".github/workflows/health-weekly.yml",
    ],
    pattern: /pip-audit==(\d+\.\d+\.\d+)/g,
    source: { pypi: "pip-audit" },
  },
];

/** -1, 0 or 1 for two dotted numeric versions. */
function compareVersions(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Every version a tool is pinned to across its files: { versions: Set, where: [file] }. */
function readPin(pin, root = ROOT, readFile = (file) => fs.readFileSync(file, "utf8")) {
  const versions = new Set();
  const where = [];
  for (const file of pin.files) {
    let text = "";
    try {
      text = readFile(path.join(root, file));
    } catch {
      continue;
    }
    for (const match of text.matchAll(pin.pattern)) {
      versions.add(match[1]);
      where.push(file);
    }
  }
  return { versions, where };
}

/** The newest release of a tool: { version, publishedAt } or null when it cannot be read. */
async function fetchLatest(source, fetchJson) {
  try {
    if (source.github) {
      const body = await fetchJson(`https://api.github.com/repos/${source.github}/releases/latest`);
      const version = String(body.tag_name || "").replace(/^v/, "");
      return /^\d+\.\d+\.\d+$/.test(version) ? { version, publishedAt: body.published_at } : null;
    }
    if (source.pypi) {
      const body = await fetchJson(`https://pypi.org/pypi/${source.pypi}/json`);
      const version = String(body.info && body.info.version);
      const files = (body.releases && body.releases[version]) || [];
      const first = files[0] || {};
      return /^\d+\.\d+\.\d+$/.test(version)
        ? { version, publishedAt: first.upload_time_iso_8601 || first.upload_time }
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * One verdict per tool.
 *   current    the pin is the newest release (or newer)
 *   fresh      a newer release exists but is younger than the grace period: wait
 *   behind     a newer release has been out for the grace period or longer
 *   mismatch   the files that pin the same tool disagree
 *   missing    no pin was found where it should be (the pattern or the file moved)
 *   unknown    the official source could not be read
 */
function judge(pin, found, latest, now, graceDays = GRACE_DAYS) {
  const versions = [...found.versions];
  if (versions.length === 0) {
    return { name: pin.name, status: "missing", note: `no pin found in ${pin.files.join(", ")}` };
  }
  if (versions.length > 1) {
    return {
      name: pin.name,
      status: "mismatch",
      pinned: versions.sort(compareVersions).join(" and "),
      note: `the files pin different versions (${versions.join(", ")})`,
    };
  }
  const pinned = versions[0];
  if (!latest)
    return { name: pin.name, status: "unknown", pinned, note: "newest release not readable" };
  if (compareVersions(latest.version, pinned) <= 0) {
    return { name: pin.name, status: "current", pinned, latest: latest.version };
  }
  const published = Date.parse(latest.publishedAt || "");
  const ageDays = Number.isFinite(published) ? (now - published) / 86_400_000 : Infinity;
  if (ageDays < graceDays) {
    return {
      name: pin.name,
      status: "fresh",
      pinned,
      latest: latest.version,
      note: `${latest.version} is ${Math.floor(ageDays)} day(s) old; waiting ${graceDays}`,
    };
  }
  return {
    name: pin.name,
    status: "behind",
    pinned,
    latest: latest.version,
    note: `${latest.version} is available${Number.isFinite(ageDays) ? ` (${Math.floor(ageDays)} days old)` : ""}`,
  };
}

async function check({ root = ROOT, fetchJson, now = Date.now(), pins = PINS, readFile } = {}) {
  const out = [];
  for (const pin of pins) {
    const found = readPin(pin, root, readFile);
    const latest = found.versions.size === 1 ? await fetchLatest(pin.source, fetchJson) : null;
    out.push(judge(pin, found, latest, now));
  }
  return out;
}

/** The real thing: a GET with a time limit that never throws on a slow or blocked network. */
async function httpJson(url) {
  const headers = { accept: "application/json", "user-agent": "friday-pin-freshness" };
  // The weekly run has a token: it lifts GitHub's anonymous rate limit. The token goes to api.github.com only.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token && new URL(url).hostname === "api.github.com")
    headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function summarize(results) {
  const needs = results.filter(
    (r) => r.status === "behind" || r.status === "mismatch" || r.status === "missing",
  );
  return {
    needs,
    line: `pinned tools: ${needs.length} need attention, ${results.filter((r) => r.status === "unknown").length} could not be read, ${results.length} checked`,
  };
}

module.exports = {
  PINS,
  GRACE_DAYS,
  compareVersions,
  readPin,
  fetchLatest,
  judge,
  check,
  summarize,
};

if (require.main === module) {
  check({ fetchJson: httpJson })
    .then((results) => {
      if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
        return;
      }
      for (const r of results) {
        console.log(
          `${r.name}: ${r.status}${r.pinned ? ` (pinned ${r.pinned}${r.latest ? `, newest ${r.latest}` : ""})` : ""}${r.note ? ` - ${r.note}` : ""}`,
        );
      }
      console.log(summarize(results).line);
    })
    .catch((error) => {
      console.log(
        `pinned tools: could not be checked (${error && error.message ? error.message : error})`,
      );
    });
}
