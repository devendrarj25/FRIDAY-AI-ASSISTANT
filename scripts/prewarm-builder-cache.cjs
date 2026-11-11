#!/usr/bin/env node
/**
 * Fetch the tools electron-builder downloads on its first package (the NSIS compiler, its plugins
 * and elevation helper, and the resource editor that writes FRIDAY.exe's name and version) during
 * `npm run setup` and `npm run doctor`, so `npm run build:win` finds them in electron-builder's own
 * cache instead of downloading them in the middle of packaging.
 *
 * It does not carry a downloader or know a cache layout: it calls the same functions
 * app-builder-lib calls while packaging (`toolsets/windows.js`), so the version, the SHA-256 check,
 * the source and the cache folder are electron-builder's own and follow it when it is updated. A
 * tool that is cached already is not downloaded again (the call returns the cached folder).
 *
 * A tool that cannot be fetched is reported and retried (three tries, longer waits), but does not
 * fail the step: the build asks for the same tools and is the check that matters. Windows only;
 * FRIDAY_OFFLINE=1, FRIDAY_PREFETCH=0 and hosted CI (unless FRIDAY_PREFETCH=1) skip it.
 */
"use strict";

const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function skipReason(env = process.env, platform = process.platform) {
  if (String(env.FRIDAY_PREFETCH ?? "1").trim() === "0") return "turned off (FRIDAY_PREFETCH=0)";
  if (platform !== "win32") return "the installer tools are fetched on Windows only";
  if (String(env.FRIDAY_OFFLINE || "") === "1") return "offline build";
  if ((env.CI || env.GITHUB_ACTIONS) && String(env.FRIDAY_PREFETCH || "") !== "1") {
    return "hosted CI keeps its own cache";
  }
  return "";
}

/** The calls packaging makes, in the order it makes them. `lib` is app-builder-lib's windows toolset. */
function steps(lib) {
  return [
    ["NSIS compiler", () => lib.getMakeNsisPath()],
    ["NSIS plugins", () => lib.getNsisPluginsPath()],
    ["NSIS elevation helper", () => lib.getNsisElevatePath()],
    ["resource editor", () => lib.getRceditBundle()],
  ];
}

async function prewarm(deps = {}) {
  const log = deps.log || console.log;
  const env = deps.env || process.env;
  const reason = skipReason(env, deps.platform || process.platform);
  if (reason) {
    log(`[friday] installer tools prefetch skipped: ${reason}`);
    return [];
  }
  let lib = deps.lib;
  if (!lib) {
    try {
      lib = require(
        path.join(ROOT, "node_modules", "app-builder-lib", "out", "toolsets", "windows.js"),
      );
    } catch (err) {
      log(
        `[friday] INFO     installer tools: electron-builder is not installed yet (${String((err && err.message) || err).slice(0, 120)}); the build fetches them`,
      );
      return [];
    }
  }
  const wait = deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rows = [];
  for (const [name, call] of steps(lib)) {
    let error = "";
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        await call();
        ok = true;
      } catch (err) {
        error = String((err && err.message) || err)
          .split("\n")[0]
          .slice(0, 160);
        if (attempt < 3) await wait(attempt * 3000);
      }
    }
    log(
      ok
        ? `[friday] ok       ${name} ready in electron-builder's cache`
        : `[friday] INFO     ${name} could not be fetched (${error}); the build tries again`,
    );
    rows.push({ name, ok, ...(ok ? {} : { error }) });
  }
  return rows;
}

module.exports = { prewarm, skipReason, steps };

if (require.main === module) {
  prewarm().then(
    () => {
      process.exitCode = 0;
    },
    (err) => {
      console.log(`[friday] INFO     installer tools: ${String((err && err.message) || err)}`);
      process.exitCode = 0;
    },
  );
}
