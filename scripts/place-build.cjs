#!/usr/bin/env node
/**
 * FRIDAY - place a CMD build in the FRIDAY folder.
 *
 * `scripts\build-windows.cmd` leaves its outputs in `<checkout>\release`, which the next build wipes. After a fully
 * green run, and only for the CMD caller (never CI), this copies them to
 *
 *   <root>\installer\installers\<version>\      Setup, Portable, blockmap, latest.yml, SHA256SUMS.txt,
 *                                               friday-update.json, friday-bundle.json
 *   <root>\installer\manifests\local-build.json {schema:1, version, dir, bundleSha256}
 *
 * so the installed app finds the locally built files (electron/local-sources.cjs). It is not a build phase: `build N/13`
 * and every closing line stay as they are; the FRIDAY BUILD READY table gains one `placed` row (rowFor).
 *
 *   * Every file is copied as `<file>.part`, checked by size and then SHA-256 against friday-bundle.json (or, for the
 *     two files the record cannot hash, against the source), and only then renamed. All `.part` files are verified
 *     before the first rename, so a failure leaves the folder as it was.
 *   * A same-version folder whose files already have equal hashes is left alone. A differing file is replaced only after
 *     its `.part` verified. Other versions, and files this script does not own, are never touched or deleted.
 *   * Placing never fails the build: the result is a SKIP row with the reason, and `release\` still holds the outputs.
 *   * `FRIDAY_PLACE_BUILD=0` turns it off (default on). A CI environment never places.
 *
 * Opt-in `FRIDAY_BUILD_PACKS=1` (default OFF; it duplicates about 28 GB) builds the FRIDAY weight packs with
 * scripts/build-friday-models.cjs into `<root>\installer\packs\<tag>\`, one model at a time, so the disk never holds
 * two models' work files, then once more over every model that is there so SHA256SUMS, NOTICE.md and the pack manifest
 * list them all (the tool writes them for the models of its own run). A pack folder inside the source checkout is
 * refused (that tool needs `--out` outside the repository) and said so (packsNote). Called from
 * scripts/prefetch-models.cjs after the weights step.
 */
const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const bundleLib = require("./electron-module.cjs").load("build-bundle.cjs");

const POINTER_SCHEMA = 1;
const POINTER_FILE = "local-build.json";
const UPDATE_FILE = "friday-update.json";
/** A rename that meets a locked file (a scanner, a running exe) is tried again, with a growing pause. */
const RENAME_TRIES = 5;
const RENAME_BACKOFF_MS = [100, 200, 400, 800];
const BUSY_CODES = new Set(["EBUSY", "EPERM"]);

const isCi = (env) => Boolean(env && (env.CI || env.GITHUB_ACTIONS));

/** Why a build is not placed, or "" when it may be. Pure. */
function skipReason({ caller, env = process.env } = {}) {
  if (caller !== "cmd") return "placing the build in the FRIDAY folder is for the CMD build only";
  if (isCi(env)) return "CI build: nothing is placed in a FRIDAY folder";
  if (String(env.FRIDAY_PLACE_BUILD || "") === "0") return "FRIDAY_PLACE_BUILD=0";
  return "";
}

function sha256OfFile(fs, file) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const fileSize = (fs, file) => {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
};

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `fs.renameSync`, tried up to RENAME_TRIES times while the file is busy or locked (EBUSY, EPERM). */
function renameWithRetry(fs, from, to, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!BUSY_CODES.has(error && error.code) || attempt >= RENAME_TRIES) throw error;
      sleep(RENAME_BACKOFF_MS[Math.min(attempt, RENAME_BACKOFF_MS.length) - 1]);
    }
  }
}

/** Keep the old file as `<file>.old` while `<file>` stays where it is (a hard link, else a copy). */
function parkOld(fs, dest, old) {
  removeQuietly(fs, old);
  try {
    fs.linkSync(dest, old);
  } catch {
    fs.copyFileSync(dest, old);
  }
}

/** Put back what phase 2 changed, newest first. Returns the names that could not be restored. */
function rollbackPlaced(fs, undo, sleep) {
  const lost = [];
  for (const step of [...undo].reverse()) {
    if (!step.placed) continue;
    try {
      if (step.old) renameWithRetry(fs, step.old, step.dest, sleep);
      else fs.rmSync(step.dest, { force: true });
    } catch {
      lost.push(path.basename(step.dest));
    }
  }
  return lost;
}

function removeQuietly(fs, file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a leftover .part is overwritten by the next run */
  }
}

/** What to place: every file the bundle record names, the record itself and the update manifest. */
function plannedFiles(bundle) {
  const files = bundle.app.map((a) => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 }));
  files.push({ name: bundleLib.FILE_NAME, bytes: null, sha256: null });
  files.push({ name: UPDATE_FILE, bytes: null, sha256: null });
  return files;
}

/**
 * Copy the release outputs of a CMD build into `<root>/installer/installers/<version>/`.
 * Returns `{status: "placed" | "skipped" | "failed", dir, version, files, unchanged, reason}`; never throws.
 */
function placeBuild({
  root,
  releaseDir,
  caller = "cmd",
  env = process.env,
  fs = nodeFs,
  log = () => {},
  sleep = sleepSync,
}) {
  const skip = skipReason({ caller, env });
  if (skip) return { status: "skipped", reason: skip };
  const staged = [];
  try {
    const bundleFile = path.join(releaseDir, bundleLib.FILE_NAME);
    const bundle = bundleLib.read(bundleFile, { fs });
    if (!bundle) return { status: "skipped", reason: `no valid ${bundleLib.FILE_NAME} in release` };
    const planned = plannedFiles(bundle);
    const missing = planned.filter((f) => fileSize(fs, path.join(releaseDir, f.name)) < 0);
    if (missing.length)
      return {
        status: "skipped",
        reason: `release is missing ${missing.map((f) => f.name).join(", ")}`,
      };

    // The sources must still be what the record says: a stale or half-written release is never copied.
    const sums = new Map();
    for (const file of planned) {
      const source = path.join(releaseDir, file.name);
      const bytes = fileSize(fs, source);
      if (file.bytes !== null && bytes !== file.bytes)
        return {
          status: "failed",
          reason: `${file.name} differs from ${bundleLib.FILE_NAME} (size)`,
        };
      const digest = sha256OfFile(fs, source);
      if (file.sha256 !== null && digest !== file.sha256.toLowerCase())
        return {
          status: "failed",
          reason: `${file.name} differs from ${bundleLib.FILE_NAME} (sha256)`,
        };
      sums.set(file.name, { bytes, sha256: digest });
    }
    try {
      const update = JSON.parse(fs.readFileSync(path.join(releaseDir, UPDATE_FILE), "utf8"));
      const named = update && update.bundle;
      if (
        named &&
        String(named.sha256 || "").toLowerCase() !== sums.get(bundleLib.FILE_NAME).sha256
      )
        return {
          status: "failed",
          reason: `${UPDATE_FILE} names a different ${bundleLib.FILE_NAME}`,
        };
    } catch {
      return { status: "failed", reason: `${UPDATE_FILE} is not readable JSON` };
    }

    const dir = path.join(root, "installer", "installers", bundle.version);
    fs.mkdirSync(dir, { recursive: true });
    const results = [];
    // Phase 1: every differing file goes to <file>.part and is verified. Nothing is renamed yet.
    for (const file of planned) {
      const want = sums.get(file.name);
      const dest = path.join(dir, file.name);
      const existed = fileSize(fs, dest) >= 0;
      if (existed && fileSize(fs, dest) === want.bytes && sha256OfFile(fs, dest) === want.sha256) {
        results.push({ name: file.name, result: "same" });
        continue;
      }
      const part = `${dest}.part`;
      staged.push(part);
      fs.copyFileSync(path.join(releaseDir, file.name), part);
      if (fileSize(fs, part) !== want.bytes)
        throw new Error(`${file.name}: the copy has the wrong size`);
      if (sha256OfFile(fs, part) !== want.sha256)
        throw new Error(`${file.name}: the copy has the wrong sha256`);
      results.push({ name: file.name, result: existed ? "replaced" : "copied", dest, part });
    }
    // Phase 2: rename the verified parts into place. A replaced file is first kept as <file>.old, so a rename that
    // still fails after its retries puts every earlier file back and the folder stays as it was.
    const undo = [];
    try {
      for (const row of results) {
        if (!row.part) continue;
        const step = { dest: row.dest, old: null, placed: false };
        if (row.result === "replaced") {
          step.old = `${row.dest}.old`;
          parkOld(fs, row.dest, step.old);
        }
        undo.push(step);
        renameWithRetry(fs, row.part, row.dest, sleep);
        step.placed = true;
        staged.splice(staged.indexOf(row.part), 1);
        log(`[friday] placed   ${row.name}`);
      }
      writePointer({ fs, root, bundle, dir });
    } catch (error) {
      const lost = rollbackPlaced(fs, undo, sleep);
      if (lost.length) {
        error.message = `${error.message} (could not restore ${lost.join(", ")}; the old copy is kept as .old)`;
        for (const step of undo) if (lost.includes(path.basename(step.dest))) step.old = null;
      }
      for (const step of undo) if (step.old) removeQuietly(fs, step.old);
      throw error;
    }
    for (const step of undo) if (step.old) removeQuietly(fs, step.old);
    const unchanged = results.every((row) => row.result === "same");
    return {
      status: "placed",
      dir,
      version: bundle.version,
      unchanged,
      files: results.map(({ name, result }) => ({ name, result })),
    };
  } catch (error) {
    return { status: "failed", reason: error && error.message ? error.message : String(error) };
  } finally {
    for (const part of staged) removeQuietly(fs, part);
  }
}

/** `<root>/installer/manifests/local-build.json`, written whole or not at all. */
function writePointer({ fs, root, bundle, dir }) {
  const folder = path.join(root, "installer", "manifests");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, POINTER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const record = {
    schema: POINTER_SCHEMA,
    version: bundle.version,
    dir: path.relative(root, dir).split(path.sep).join("/"),
    bundleSha256: bundleLib.hashOf(bundle),
  };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    removeQuietly(fs, tmp);
    throw error;
  }
}

/** The `placed` row of the FRIDAY BUILD READY table, in the shape of a phase. A failure is a SKIP: the build is green. */
function rowFor(result) {
  if (result && result.status === "placed") {
    return {
      name: "placed",
      status: "ok",
      detail: `${result.dir}${result.unchanged ? " (already there, unchanged)" : ""}`,
    };
  }
  const reason = result && result.reason ? result.reason : "nothing was placed";
  const text = result && result.status === "failed" ? `not placed (${reason})` : reason;
  return { name: "placed", status: "skipped", detail: `skipped: ${text}` };
}

// ------------------------------------------------------------------------------------------------ the packs (opt-in)

const packsRequested = (env = process.env) => String(env.FRIDAY_BUILD_PACKS || "") === "1";

/** Every pack of config/friday-models.json with its tag and models: `[{pack, tag, models, partBytes, assets}]`. */
function planPacks({ tool = require("./build-friday-models.cjs") } = {}) {
  const whole = tool.readManifest();
  const sources = {
    helperJobs: require("./electron-module.cjs").load("voice-weights.cjs").pinnedJobs(),
    core: tool.readCore(),
  };
  return tool.packsOf(whole).map((row) => {
    const manifest = tool.packManifest(whole, row.id, sources);
    const models = tool.modelsOf(manifest);
    return {
      pack: row.id,
      tag: row.tag,
      models: models.map((m) => m.fridayId),
      partBytes: manifest.partBytes,
      assets: Object.fromEntries(
        models.map((m) => [m.fridayId, m.assets.map((a) => ({ file: a.file, bytes: a.bytes }))]),
      ),
    };
  });
}

const insideOf = (base, target) => {
  const norm = (v) => {
    const full = path.resolve(v);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  const rel = path.relative(norm(base), norm(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** True when every part file of the model is in `dir` and the sizes add up (a build finished earlier). */
function modelPresent({ dir, plan, id, fs = nodeFs }) {
  const assets = plan.assets && plan.assets[id];
  if (!Array.isArray(assets) || !assets.length) return false;
  const limit = plan.partBytes > 0 ? plan.partBytes : 1_900_000_000;
  return assets.every((asset) => {
    const count = Math.max(1, Math.ceil(asset.bytes / limit));
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const name = count <= 1 ? asset.file : `${asset.file}.part${String(i + 1).padStart(3, "0")}`;
      const size = fileSize(fs, path.join(dir, name));
      if (size < 0) return false;
      total += size;
    }
    return total === asset.bytes;
  });
}

/**
 * Build the FRIDAY packs into `<root>/installer/packs/<tag>/`, one model per run of build-friday-models.cjs. Off unless
 * FRIDAY_BUILD_PACKS=1. A failed model is reported and the next one still runs; it never fails the build.
 * Returns `{status: "built" | "failed" | "skipped", reason, notes}`.
 */
function buildPacks({
  root,
  projectRoot = path.resolve(__dirname, ".."),
  env = process.env,
  plan = null,
  spawn = childProcess.spawnSync,
  fs = nodeFs,
  log = (line) => console.log(line),
} = {}) {
  if (!packsRequested(env))
    return { status: "skipped", reason: "FRIDAY_BUILD_PACKS is not 1", notes: [] };
  if (isCi(env)) return { status: "skipped", reason: "CI build: no packs are built", notes: [] };
  const base = path.join(root, "installer", "packs");
  if (insideOf(projectRoot, base))
    return {
      status: "skipped",
      reason:
        "the FRIDAY folder is inside the source checkout; the pack tool needs --out outside the repository",
      notes: [],
    };
  const notes = [];
  let failed = false;
  let rows;
  try {
    rows = plan || planPacks();
  } catch (error) {
    return { status: "failed", reason: `the pack plan is unreadable: ${error.message}`, notes };
  }
  const tool = path.join(__dirname, "build-friday-models.cjs");
  const runTool = (row, out, only) => {
    const run = spawn(process.execPath, [tool, "--pack", row.pack, "--out", out, "--only", only], {
      stdio: "inherit",
      windowsHide: true,
    });
    return Boolean(run) && !run.error && run.status === 0;
  };
  for (const row of rows) {
    const out = path.join(base, row.tag);
    const present = [];
    let builtNow = false;
    for (const id of row.models) {
      if (modelPresent({ dir: out, plan: row, id, fs })) {
        notes.push(`${row.tag}: ${id} is already there`);
        present.push(id);
        continue;
      }
      log(`[friday] packs    ${row.tag}: ${id}`);
      if (runTool(row, out, id)) {
        present.push(id);
        builtNow = true;
      } else {
        failed = true;
        notes.push(`${row.tag}: ${id} was not built`);
        log(`[friday] packs    ${row.tag}: ${id} was not built; the next model still runs`);
      }
    }
    // Every run of the tool rewrites SHA256SUMS, NOTICE.md and the pack manifest for the models it was given, so after
    // the one-model runs they describe only the last model. One more run over every model that is there (its files
    // are checked and kept, nothing is fetched again) makes the metadata list them all.
    if (builtNow && !runTool(row, out, present.join(","))) {
      failed = true;
      notes.push(`${row.tag}: the pack metadata (SHA256SUMS, NOTICE.md, manifest) was not rebuilt`);
      log(`[friday] packs    ${row.tag}: the pack metadata was not rebuilt`);
    }
  }
  return failed
    ? { status: "failed", reason: "a pack model was not built", notes }
    : { status: "built", notes };
}

/**
 * The console lines for a requested pack build that did not complete: a SKIP line with the reason (for example the FRIDAY
 * folder inside the checkout) or a note for a failure. Silent unless FRIDAY_BUILD_PACKS=1 and for a clean build.
 */
function packsNote(result, env = process.env) {
  if (!packsRequested(env) || !result) return [];
  if (result.status === "skipped") return [`[friday] SKIP     packs: ${result.reason}`];
  if (result.status !== "failed") return [];
  return [
    `[friday] note     packs: ${result.reason}`,
    ...(result.notes || []).map((line) => `[friday] note     packs: ${line}`),
  ];
}

module.exports = {
  skipReason,
  plannedFiles,
  placeBuild,
  rowFor,
  packsRequested,
  planPacks,
  modelPresent,
  buildPacks,
  packsNote,
  POINTER_FILE,
};
