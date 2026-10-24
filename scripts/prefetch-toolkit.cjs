#!/usr/bin/env node
/**
 * Build-time toolkit prefetch: the portable command-line tools FRIDAY uses to
 * search, convert, fetch and build for the owner land in the FRIDAY folder
 * (<root>\runtime) before the EXE is built, so a fresh install can use them on
 * first launch instead of finding them missing.
 *
 * It does not carry a second installer. Every tool goes through the Install
 * Manager's own job (electron/toolchain.cjs runJob): winget first, then the
 * vendor's release feed with its SHA-256, managed install marker, PATH entry.
 * The same detection that the app runs decides what is already here.
 *
 * - Present and current: nothing is downloaded (one line, "already installed").
 * - Present and older than the newest release: it is updated, so the build
 *   starts from the latest versions (FRIDAY_PREFETCH_TOOLKIT_UPDATE=0 only reports).
 * - Missing: installed, with the size and the live progress printed.
 * - At or above config/agent-toolkit.json maxPrefetchBytes (2 GB), or needing an
 *   administrator or a restart (Docker Desktop, WSL 2, CUDA, PyTorch ...): not
 *   fetched here. The summary names each one so the owner knows it comes from
 *   the Install Manager inside FRIDAY.
 *
 * A failed or offline install never fails the build. Opt out: FRIDAY_PREFETCH=0
 * or FRIDAY_PREFETCH_TOOLKIT=0; FRIDAY_OFFLINE=1 skips. Hosted CI skips it unless
 * FRIDAY_PREFETCH=1.
 */
const path = require("node:path");

const config = require("../config/agent-toolkit.json");

function enabled(env, key) {
  return String(env[key] ?? "1").trim() !== "0";
}

const mb = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** Is `latest` a newer release than `have`? Dotted numbers; anything else is "not newer". */
function newer(latest, have) {
  const parts = (text) =>
    String(text || "")
      .replace(/^v/i, "")
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
  const a = parts(latest);
  const b = parts(have);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return delta > 0;
  }
  return false;
}

/** Why the whole step is skipped, or "" when it runs. Pure. */
function skipReason(env = process.env, platform = process.platform) {
  if (!enabled(env, "FRIDAY_PREFETCH") || !enabled(env, "FRIDAY_PREFETCH_TOOLKIT")) {
    return "turned off (FRIDAY_PREFETCH / FRIDAY_PREFETCH_TOOLKIT)";
  }
  if (platform !== "win32") return "these tools are installed on Windows only";
  if (String(env.FRIDAY_OFFLINE || "") === "1") return "offline build";
  if ((env.CI || env.GITHUB_ACTIONS) && String(env.FRIDAY_PREFETCH || "") !== "1") {
    return "hosted CI does not pull tools on every run";
  }
  return "";
}

/**
 * One row per toolkit entry. `detected` maps id -> {installed, version};
 * `latest` maps id -> newest version string. Pure, so a test can read it.
 */
function toolkitPlan({
  detected = {},
  latest = {},
  update = true,
  cap = config.maxPrefetchBytes,
} = {}) {
  return config.prefetch.map((entry) => {
    const base = { id: entry.id, why: entry.why, bytes: entry.approxBytes };
    if (entry.approxBytes >= cap) {
      return {
        ...base,
        action: "defer",
        note: `${mb(entry.approxBytes)} is over the ${mb(cap)} limit`,
      };
    }
    const have = detected[entry.id];
    if (!have?.installed) return { ...base, action: "install" };
    const next = latest[entry.id];
    if (next && have.version && newer(next, have.version)) {
      return {
        ...base,
        action: update ? "update" : "outdated",
        from: have.version,
        to: next,
      };
    }
    return { ...base, action: "keep", version: have.version || "" };
  });
}

/** Tools the Install Manager keeps: named in the summary so nothing is a surprise. */
function deferredList() {
  return config.deferred.map((entry) => ({
    id: entry.id,
    reason: entry.reason,
    bytes: entry.approxBytes,
  }));
}

/** Print an Install Manager job event as build-log lines. */
function eventPrinter(log, id, progressLine) {
  let last = "";
  return (event) => {
    if (!event) return;
    let line = "";
    if (event.progress != null && progressLine) line = progressLine(id, event, false);
    else if (event.line) line = `[friday] ${id.padEnd(14)} ${String(event.line).slice(0, 160)}`;
    if (line && line !== last) {
      last = line;
      log(line);
    }
  };
}

/** Plan and run. Returns one row per tool. Never throws. */
async function prefetchToolkit(root, deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console.log;
  const reason = skipReason(env, deps.platform || process.platform);
  if (reason) {
    log(`[friday] tool prefetch skipped: ${reason}`);
    return [];
  }
  if (!root) {
    log("[friday] tool prefetch skipped: no FRIDAY folder");
    return [];
  }
  const toolchain = deps.toolchain || require("../electron/toolchain.cjs");
  const progressLine = deps.progressLine || require("./stage-toolchain.cjs").progressLine;
  const update = enabled(env, "FRIDAY_PREFETCH_TOOLKIT_UPDATE");
  const detected = {};
  const latest = {};
  try {
    const scan = await toolchain.detectTools({ force: true, root });
    for (const row of scan.tools || []) detected[row.id] = row;
  } catch (err) {
    log(
      `[friday] INFO     tool scan failed (${String((err && err.message) || err)}); tool prefetch skipped`,
    );
    return [];
  }
  try {
    const table = await toolchain.wingetUpgrades().catch(() => ({}));
    for (const entry of config.prefetch) {
      const tool = toolchain.toolById(entry.id);
      if (!tool || !detected[entry.id]?.installed) continue;
      const next = await toolchain.latestFor(tool, { wingetTable: table });
      if (next) latest[entry.id] = next;
    }
  } catch {
    /* an unknown latest version only means "no update is claimed" */
  }
  const plan = toolkitPlan({ detected, latest, update });
  const rows = [];
  const total = plan.filter((row) => row.action === "install" || row.action === "update");
  log(
    `[friday] agent toolkit: ${plan.length} tools, ${total.length} to fetch (${mb(total.reduce((sum, row) => sum + row.bytes, 0))} at most), limit ${mb(config.maxPrefetchBytes)}`,
  );
  for (const row of plan) {
    if (row.action === "keep") {
      log(
        `[friday] ok       ${row.id} ${row.version || "installed"} already installed; not downloaded again`,
      );
      rows.push({ id: row.id, ok: true, downloaded: false });
      continue;
    }
    if (row.action === "outdated") {
      log(
        `[friday] INFO     ${row.id} ${row.from} is installed; ${row.to} is available (update from Install Manager)`,
      );
      rows.push({ id: row.id, ok: true, downloaded: false, outdated: true });
      continue;
    }
    if (row.action === "defer") {
      log(`[friday] INFO     ${row.id} left for the Install Manager (${row.note})`);
      rows.push({ id: row.id, ok: true, downloaded: false, deferred: true });
      continue;
    }
    log(
      row.action === "update"
        ? `[friday] updating ${row.id} ${row.from} -> ${row.to}`
        : `[friday] fetching ${row.id} (about ${mb(row.bytes)}): ${row.why}`,
    );
    let result;
    try {
      result = await toolchain.runJob(
        { id: row.id, action: row.action === "update" ? "update" : "install", root },
        eventPrinter(log, row.id, progressLine),
      );
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    if (result?.ok) {
      log(`[friday] ok       ${row.id} ${row.action === "update" ? "updated" : "installed"}`);
      rows.push({ id: row.id, ok: true, downloaded: true });
    } else {
      log(`[friday] INFO     ${row.id} not installed; FRIDAY offers it in the Install Manager`);
      rows.push({ id: row.id, ok: false, error: result?.error || "install failed" });
    }
  }
  const left = deferredList();
  log(
    `[friday] left for the Install Manager inside FRIDAY (over ${mb(config.maxPrefetchBytes)}, or an administrator / restart): ${left.map((row) => row.id).join(", ")}`,
  );
  const failed = rows.filter((row) => !row.ok).length;
  log(
    `[friday] agent toolkit done: ${rows.filter((row) => row.downloaded).length} fetched, ${rows.filter((row) => row.ok && !row.downloaded).length} reused or deferred, ${failed} not installed`,
  );
  return rows;
}

module.exports = { prefetchToolkit, toolkitPlan, skipReason, deferredList, newer, mb, config };

if (require.main === module) {
  const fridayRoot = require("./friday-root.cjs");
  const picked = fridayRoot.workspaceRootOrDev();
  process.env.FRIDAY_ROOT = process.env.FRIDAY_ROOT || picked.root;
  prefetchToolkit(path.resolve(picked.root)).then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
