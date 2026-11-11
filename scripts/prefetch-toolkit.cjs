#!/usr/bin/env node
/**
 * Build-time toolkit prefetch: the tools, languages and runtimes FRIDAY needs to
 * run, build, test, search, convert, containerise and use the GPU land on this
 * PC before the EXE is built, so a fresh install can use them on first launch
 * instead of finding them missing.
 *
 * It does not carry a second installer. Every tool goes through the Install
 * Manager's own job (electron/toolchain.cjs runJob): winget first, then the
 * vendor's release feed with its SHA-256, managed install marker, PATH entry.
 * The same detection that the app runs decides what is already here.
 *
 * - Present and current: nothing is downloaded (one line, "already installed").
 * - Present and older than the newest release: it is updated, so the build
 *   starts from the latest versions (FRIDAY_PREFETCH_TOOLKIT_UPDATE=0 only reports).
 * - Updates happen in `npm run setup` only. Doctor and the build pass `--no-update`: they install
 *   what is missing and report what is outdated, so a second command never downloads again.
 *   A newer release is tried once: what happened (installed, still shadowed by an older copy
 *   earlier on PATH, or failed) is kept in <FRIDAY>/temporary/toolkit-updates.json, so the same
 *   release is not downloaded on every run (a failed one is tried again after a day).
 * - Missing: installed, with the size and the live progress printed. There is no
 *   size cap: a needed tool is installed however large it is (Docker Desktop,
 *   WSL 2, Windows Sandbox, the CUDA Toolkit).
 * - An entry gated on hardware (`requires`) is skipped on a PC without it: CUDA
 *   only where an NVIDIA GPU driver answers.
 * - What stays for later is a kind, not a size (config/agent-toolkit.json
 *   `onDemand`): big AI models come from the Models section, and runners that
 *   only a model needs (Hugging Face runner with PyTorch, vLLM) from the Install
 *   Manager when that model is used. The last line of the step names them.
 *
 * An `elevated` tool shows a Windows administrator prompt and may ask for a
 * restart; a pending restart is reported (RESTART WINDOWS) and is not a failure.
 * A tool that cannot be installed IS a failure: the step exits 1 and names each
 * tool, so setup and the build stop instead of going on with a hole in the
 * toolkit. What cannot apply to this PC is skipped, not failed: CUDA without an
 * NVIDIA driver, Windows Sandbox on an edition that lacks it.
 * Opt out: FRIDAY_PREFETCH=0 or FRIDAY_PREFETCH_TOOLKIT=0 skips the step,
 * FRIDAY_PREFETCH_TOOLKIT_ELEVATED=0 skips only the administrator ones (a quick
 * build, chosen on purpose), FRIDAY_PREFETCH_TOOLKIT_STRICT=0 reports failures
 * without failing; FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN (default 30, 45 for an
 * administrator tool) ends an install that never answers; FRIDAY_OFFLINE=1 skips.
 * Hosted CI skips it unless FRIDAY_PREFETCH=1.
 */
const fs = require("node:fs");
const path = require("node:path");

const config = require("../config/agent-toolkit.json");
const { tidyLine } = require("../electron/installer-output.cjs");

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

const RETRY_FAILED_MS = 24 * 60 * 60 * 1000;

/** Where the update attempts are remembered, and a stand-in that keeps them in memory (tests). */
function fileLedger(root) {
  const file = path.join(root, "temporary", "toolkit-updates.json");
  return {
    read() {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return data && typeof data === "object" ? data : {};
      } catch {
        return {};
      }
    },
    write(data) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
      } catch {
        /* a ledger that cannot be written only means the next run may try again */
      }
    },
  };
}
function memoryLedger(initial = {}) {
  let data = { ...initial };
  return { read: () => ({ ...data }), write: (next) => (data = { ...next }) };
}

/**
 * Was this release already tried? An installed or shadowed one never again (the same release
 * would be downloaded for nothing); a failed or "winget has nothing newer" one after a day.
 * Pure. Returns the earlier attempt, or null when the release should be tried.
 */
function alreadyTried(ledger, id, to, now = Date.now()) {
  const hit = ledger?.[id];
  if (!hit || String(hit.to) !== String(to)) return null;
  if (hit.outcome === "installed" || hit.outcome === "shadowed") return hit;
  return now - Number(hit.at || 0) < RETRY_FAILED_MS ? hit : null;
}

/**
 * An update that landed beside an older PC-wide copy (winget's CMake 4.1 first on PATH, the vendor's 4.2
 * unpacked under runtime\\): when the managed copy is verifiably the newer one, its folder goes in front
 * of PATH for this process and for FRIDAY from now on (managed-path.json `first`). Returns the
 * managed version that now wins, or "" when there is no newer managed copy. Never throws.
 */
function preferNewerManaged(root, tool, seen, deps = {}) {
  try {
    const installed = (
      deps.installedBin || require("../electron/managed-install.cjs").installedBin
    )(root, tool);
    if (!installed?.bin || !installed.version || !newer(installed.version, seen)) return "";
    const dir = path.dirname(installed.bin);
    const managed = deps.managedPath || require("../electron/managed-path.cjs");
    if (!managed.preferManaged(root, dir)) return "";
    const env = deps.env || process.env;
    env.PATH = managed.withFirstPath(env.PATH, [dir]);
    return String(installed.version);
  } catch {
    return "";
  }
}

/** What a finished update turned out to be, from the job result and the version seen afterwards. Pure. */
function updateOutcome(result, to, seen) {
  if (!result?.ok) return "failed";
  if (result.vendorUpdateFailed) return "failed";
  if (result.upToDate || result.outsideWinget) return "current";
  if (seen && !newer(to, seen)) return "installed";
  return seen ? "shadowed" : "installed";
}

/** How long one install may run before the build moves on (minutes in FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN). */
function jobLimitMs(env = process.env, elevated = false) {
  const minutes = Number(env.FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN);
  const base = Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  return Math.round(base * (elevated ? 1.5 : 1) * 60 * 1000);
}

/** Does a tool that cannot be installed fail the step? On by default. */
function strict(env = process.env) {
  return enabled(env, "FRIDAY_PREFETCH_TOOLKIT_STRICT");
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
  elevated = true,
  entries = config.prefetch,
} = {}) {
  return entries.map((entry) => {
    const base = {
      id: entry.id,
      why: entry.why,
      bytes: entry.approxBytes,
      elevated: Boolean(entry.elevated),
    };
    const have = detected[entry.id];
    if (
      entry.requires === "nvidia-gpu" &&
      !detected["NVIDIA Driver"]?.installed &&
      !have?.installed
    ) {
      return { ...base, action: "skip", note: "no NVIDIA GPU driver on this PC" };
    }
    if (have?.unsupported && !have.installed) {
      return {
        ...base,
        action: "skip",
        note: String(have.manual || "not available on this PC"),
      };
    }
    if (entry.elevated && !elevated && !have?.installed) {
      return {
        ...base,
        action: "skip",
        note: "administrator tools are switched off for this build",
      };
    }
    if (!have?.installed) return { ...base, action: "install" };
    const next = latest[entry.id];
    if (next && have.version && newer(next, have.version)) {
      return { ...base, action: update ? "update" : "outdated", from: have.version, to: next };
    }
    return { ...base, action: "keep", version: have.version || "" };
  });
}

/** Status words in colour on a terminal (NO_COLOR turns it off), plain text in a log file. */
function colourLog(stream = process.stdout, env = process.env) {
  const { colourWanted } = require("./download-board.cjs");
  if (!colourWanted(stream, env)) return (line) => console.log(line);
  const colours = [
    [/^\[friday\] (ok) /, "32"],
    [/^\[friday\] (FAIL|ACTION REQUIRED|RESTART WINDOWS) ?/, "31;1"],
    [/^\[friday\] (INFO) /, "33"],
    [/^\[friday\] (fetching|updating) /, "36"],
  ];
  return (line) => {
    for (const [pattern, code] of colours) {
      if (pattern.test(line)) {
        console.log(
          line.replace(pattern, (all, word) => all.replace(word, `\x1b[${code}m${word}\x1b[0m`)),
        );
        return;
      }
    }
    console.log(line);
  };
}

/** Kinds the Install Manager and the Models section keep: named in the summary so nothing is a surprise. */
function deferredList() {
  return config.onDemand.map((entry) => ({ id: entry.id, reason: entry.reason }));
}

/** Print an Install Manager job event as build-log lines (noise dropped, a repeat printed once). */
function eventPrinter(log, id, progressLine) {
  let last = "";
  let bucket = -1;
  const seen = new Set();
  return (event) => {
    if (!event) return;
    let line = "";
    if (event.progress != null && progressLine) {
      line = progressLine(id, event, false);
      // One line per ten percent, not one per update (the speed and ETA change every second).
      const step = Math.floor(Math.max(0, Math.min(100, Number(event.progress))) / 10);
      if (step <= bucket) return;
      if (line) bucket = step;
    } else if (event.line) {
      const text = tidyLine(event.line);
      if (!text || seen.has(text)) return;
      seen.add(text);
      line = `[friday] ${id.padEnd(14)} ${text.slice(0, 160)}`;
    }
    if (line && line !== last) {
      last = line;
      log(line);
    }
  };
}

/** Plan and run. Returns one row per tool. Never throws. */
async function prefetchToolkit(root, deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || colourLog();
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
  const elevated = enabled(env, "FRIDAY_PREFETCH_TOOLKIT_ELEVATED");
  const detected = {};
  const latest = {};
  try {
    // Probe only the tools of this list (and the NVIDIA driver the CUDA row waits on),
    // not the whole 197-row catalog, so the step stays fast on every build.
    const wanted = [...config.prefetch.map((entry) => entry.id), "NVIDIA Driver"];
    const scan = await toolchain.detectTools({ force: true, root, only: wanted });
    for (const row of scan.tools || []) detected[row.id] = row;
  } catch (err) {
    const reason = String((err && err.message) || err);
    log(`[friday] FAIL     tool scan failed (${reason}); the toolkit cannot be verified`);
    return [{ id: "tool scan", ok: false, error: reason }];
  }
  // A folder that is not there (a test's stand-in path) keeps the record in memory and writes nothing.
  const ledger = deps.ledger || (fs.existsSync(root) ? fileLedger(root) : memoryLedger());
  const history = ledger.read();
  try {
    // Only setup looks for newer releases (`winget upgrade` alone takes up to a minute); Doctor and the
    // build install what is missing and leave the rest, so they never download an update again.
    const table = update ? await toolchain.wingetUpgrades().catch(() => ({})) : {};
    for (const entry of update ? config.prefetch : []) {
      const tool = toolchain.toolById(entry.id);
      if (!tool || !detected[entry.id]?.installed) continue;
      const next = await toolchain.latestFor(tool, { wingetTable: table });
      if (next) latest[entry.id] = next;
    }
  } catch {
    /* an unknown latest version only means "no update is claimed" */
  }
  const plan = toolkitPlan({ detected, latest, update, elevated }).map((row) => {
    if (row.action !== "update") return row;
    const earlier = alreadyTried(history, row.id, row.to);
    return earlier ? { ...row, action: "tried", outcome: earlier.outcome } : row;
  });
  const rows = [];
  const total = plan.filter((row) => row.action === "install" || row.action === "update");
  log(
    `[friday] agent toolkit: ${plan.length} tools, ${total.length} to fetch (${mb(total.reduce((sum, row) => sum + row.bytes, 0))} at most), no size limit`,
  );
  for (const row of plan) {
    if (row.action === "keep") {
      log(
        `[friday] ok       ${row.id}${row.version ? ` ${row.version}` : ""} already installed; not downloaded again`,
      );
      rows.push({ id: row.id, ok: true, downloaded: false });
      continue;
    }
    if (row.action === "tried") {
      const why =
        row.outcome === "shadowed"
          ? "it is installed, but the older copy is found first on PATH"
          : row.outcome === "installed"
            ? "it was installed already"
            : "its installer did not finish last time; tried again tomorrow";
      log(
        `[friday] ok       ${row.id} ${row.from} works; ${row.to} was tried before (${why}), so it is not downloaded again`,
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
    if (row.action === "skip") {
      log(`[friday] INFO     ${row.id} skipped: ${row.note}`);
      rows.push({ id: row.id, ok: true, downloaded: false, skipped: true });
      continue;
    }
    log(
      row.action === "update"
        ? `[friday] updating ${row.id} ${row.from} -> ${row.to} (winget first, then the official installer when winget has nothing newer)`
        : `[friday] fetching ${row.id} (about ${mb(row.bytes)}): ${row.why}`,
    );
    if (row.elevated) {
      log(
        `[friday] ${row.id} needs administrator rights: accept the Windows prompt when it appears`,
      );
    }
    let result;
    const job = {
      id: row.id,
      action: row.action === "update" ? "update" : "install",
      root,
    };
    const limit = jobLimitMs(env, row.elevated);
    let timer;
    try {
      result = await Promise.race([
        toolchain.runJob(job, eventPrinter(log, row.id, progressLine)),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            // An unanswered administrator prompt or a stuck installer must not hold the build for ever.
            try {
              toolchain.cancelJob?.(job);
            } catch {
              /* the job is abandoned either way */
            }
            resolve({ ok: false, error: `no answer after ${Math.round(limit / 60000)} minutes` });
          }, limit);
        }),
      ]);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
    if (!result?.ok && result?.error)
      log(`[friday] FAIL     ${row.id}: ${String(result.error).slice(0, 200)}`);
    if (row.action === "update") {
      // Look again, so a release that is installed but hidden behind an older copy is remembered as such.
      let seen = "";
      try {
        const again = await toolchain.detectTools({ force: true, root, only: [row.id] });
        seen = String((again.tools || []).find((tool) => tool.id === row.id)?.version || "");
      } catch {
        seen = "";
      }
      if (result?.ok && seen && newer(row.to, seen)) {
        const front = preferNewerManaged(root, toolchain.toolById?.(row.id), seen, deps);
        if (front) {
          try {
            const again = await toolchain.detectTools({ force: true, root, only: [row.id] });
            seen = String(again.tools?.find((tool) => tool.id === row.id)?.version || seen);
          } catch {
            /* the earlier version stays the one seen */
          }
          log(
            `[friday] ok       ${row.id} ${front} is used first from now on (the older copy stays installed)`,
          );
        }
      }
      const outcome = updateOutcome(result, row.to, seen);
      history[row.id] = { to: row.to, outcome, at: Date.now(), seen };
      ledger.write(history);
      if (outcome === "shadowed") {
        log(
          `[friday] INFO     ${row.id} ${row.to} is installed, but ${seen} is found first on PATH; it is not downloaded again`,
        );
      }
    }
    if (result?.ok) {
      if (row.action === "update" && result.vendorUpdateFailed) {
        // The vendor lists a newer release than winget; its installer could not finish, so the
        // working copy stays and the step is not a failure.
        log(
          `[friday] ok       ${row.id} ${row.from} stays installed; ${row.to} is out but its official installer did not finish (${String(result.vendorUpdateFailed).slice(0, 120)}); run npm run doctor to try again`,
        );
      } else if (row.action === "update" && result.upToDate) {
        // winget carries the newest release it knows; a vendor release can be ahead of it.
        log(
          `[friday] ok       ${row.id} ${row.from} is the newest version winget offers; ${row.to} is not in winget yet, so nothing was changed`,
        );
      } else if (row.action !== "update" && result.upToDate) {
        // winget answered "nothing to do": the tool was already here and current.
        log(`[friday] ok       ${row.id} already installed and current; nothing to change`);
      } else if (row.action === "update" && result.outsideWinget) {
        log(
          `[friday] ok       ${row.id} ${row.from} was not installed by winget; left as it is (${row.to} is out; update it from its own installer)`,
        );
      } else {
        log(`[friday] ok       ${row.id} ${row.action === "update" ? "updated" : "installed"}`);
      }
      if (result.restartRequired) {
        log(
          `[friday] RESTART WINDOWS  ${row.id} asks for a restart; restart once the build is done`,
        );
      }
      rows.push({
        id: row.id,
        ok: true,
        downloaded: true,
        ...(result.restartRequired ? { restartRequired: true } : {}),
      });
    } else {
      log(`[friday] FAIL     ${row.id} was not installed`);
      rows.push({ id: row.id, ok: false, error: result?.error || "install failed" });
    }
  }
  const left = deferredList();
  log(
    `[friday] left for the Install Manager inside FRIDAY (big models are chosen in the Models section; runners only a model needs install when it is used): ${left.map((row) => row.id).join(", ")}`,
  );
  const failed = rows.filter((row) => !row.ok);
  log(
    `[friday] agent toolkit done: ${rows.filter((row) => row.downloaded).length} fetched, ${rows.filter((row) => row.ok && !row.downloaded).length} reused or skipped, ${failed.length} not installed`,
  );
  const restart = rows.filter((row) => row.restartRequired).map((row) => row.id);
  if (restart.length) {
    log(`[friday] RESTART WINDOWS once to finish: ${restart.join(", ")}`);
  }
  return rows;
}

/** One line per tool that could not be installed, and the way forward. Empty when all is well. */
function failureReport(rows) {
  const failed = (rows || []).filter((row) => !row.ok);
  if (!failed.length) return [];
  return [
    `[friday] ACTION REQUIRED  ${failed.length} tool(s) could not be installed:`,
    ...failed.map(
      (row) => `[friday]   - ${row.id}: ${String(row.error || "install failed").slice(0, 160)}`,
    ),
    "[friday] Accept the Windows administrator prompt when it appears, check the network, then run: npm run setup:toolkit",
    "[friday] (or npm run doctor, which repairs and checks again)",
  ];
}

module.exports = {
  prefetchToolkit,
  fileLedger,
  memoryLedger,
  alreadyTried,
  updateOutcome,
  preferNewerManaged,
  tidyLine,
  failureReport,
  strict,
  jobLimitMs,
  toolkitPlan,
  skipReason,
  deferredList,
  newer,
  mb,
  config,
};

if (require.main === module) {
  const fridayRoot = require("./friday-root.cjs");
  const picked = fridayRoot.workspaceRootOrDev();
  process.env.FRIDAY_ROOT = process.env.FRIDAY_ROOT || picked.root;
  if (picked.development) require("../electron/staged-assets.cjs").recordStaging(picked.root);
  // Doctor and the build install what is missing only; npm run setup is where updates happen.
  if (process.argv.includes("--no-update")) process.env.FRIDAY_PREFETCH_TOOLKIT_UPDATE = "0";
  prefetchToolkit(path.resolve(picked.root)).then(
    (rows) => {
      const lines = failureReport(rows);
      for (const line of lines) console.error(line);
      process.exit(lines.length && strict() ? 1 : 0);
    },
    (err) => {
      console.error(
        `[friday] FAIL     toolkit step crashed: ${String((err && err.message) || err)}`,
      );
      process.exit(strict() ? 1 : 0);
    },
  );
}
