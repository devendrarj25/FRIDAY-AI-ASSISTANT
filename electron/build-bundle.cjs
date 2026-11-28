/**
 * FRIDAY · friday-bundle.json, schema 1: the one reader and writer.
 *
 * A build (CMD, FRIDAY Test Build, FRIDAY Release) writes this record next to the installer. It lists the app
 * files, what the EXE carries, the weight packs and, for a CMD build only, the model files placed on this PC,
 * each with its size and SHA-256. The installed app reads it to find locally built assets and use them before it
 * downloads anything.
 *
 * Rules this module keeps for every caller:
 *   - Deterministic: sorted keys and lists, no timestamps, LF only. Two runs give the same bytes and the same hash.
 *   - Strict: an unknown key, a bad hash, a negative size, a case-insensitive duplicate or a path that is absolute,
 *     contains `..`, a drive, a backslash or a Windows-reserved name is refused. Nothing is "fixed up" on read.
 *   - Fail closed: `read` returns null for anything missing, oversized, damaged or invalid.
 *   - The config pins (`config/friday-models.json`, `config/friday-core.json`) always win over a hash in a bundle:
 *     `pinWins` is false on any difference, and a model that fails it is not adoptable.
 *   - Pure Node: no electron, no network, no child process, no clock. Safe to require from scripts and from the app.
 */
"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const nodePath = require("node:path");

const SCHEMA = 1;
/** A bundle is a few KB; anything near this is damage or an attack, not a bundle. */
const MAX_BYTES = 4 * 1024 * 1024;
const FILE_NAME = "friday-bundle.json";
const CHANNELS = ["stable", "test"];
const CALLERS = ["cmd", "test", "release"];
const APP_KINDS = ["installer", "portable", "blockmap", "update-manifest", "sums", "latest"];
const LOCATIONS = ["release", "local"];

const HEX64 = /^[0-9a-f]{64}$/i;
const VERSION = /^\d+\.\d+\.\d+(\.\d+)?$/;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const PRODUCT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BAD_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isSize = (v) => Number.isSafeInteger(v) && v >= 0;
const lower = (s) => String(s).toLowerCase();

function onlyKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
  }
}

/** One path segment a Windows or POSIX disk can hold without surprise. */
function badSegment(seg) {
  if (seg === "" || seg === "." || seg === "..") return true;
  if (BAD_SEGMENT_CHARS.test(seg)) return true;
  if (/[. ]$/.test(seg)) return true;
  return RESERVED.test(seg.split(".")[0]);
}

/** A relative path with forward slashes only, no `..`, no drive, no absolute or UNC form. */
function relPathProblem(value, { single = false } = {}) {
  if (typeof value !== "string" || value === "" || value.length > 400)
    return "must be a non-empty relative path";
  if (value.includes("\\")) return "must use forward slashes";
  if (value.startsWith("/")) return "must not be absolute";
  const segs = value.split("/");
  if (single && segs.length !== 1) return "must be a single file name";
  for (const seg of segs) {
    if (badSegment(seg)) return "has an invalid segment";
  }
  return "";
}

function hexAndBytes(obj, where, errors) {
  if (typeof obj.sha256 !== "string" || !HEX64.test(obj.sha256))
    errors.push(`${where}.sha256 must be 64 hex characters`);
  if (!isSize(obj.bytes)) errors.push(`${where}.bytes must be a non-negative integer`);
}

function noDuplicates(values, where, errors) {
  const seen = new Set();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const key = lower(v);
    if (seen.has(key)) errors.push(`${where}: duplicate "${v}" (names compare case-insensitively)`);
    seen.add(key);
  }
}

function checkApp(list, errors) {
  if (!Array.isArray(list)) return errors.push("app must be a list");
  list.forEach((a, i) => {
    const where = `app[${i}]`;
    if (!isObject(a)) return errors.push(`${where} must be an object`);
    onlyKeys(a, ["name", "kind", "bytes", "sha256"], where, errors);
    const bad = relPathProblem(a.name, { single: true });
    if (bad) errors.push(`${where}.name ${bad}`);
    if (!APP_KINDS.includes(a.kind))
      errors.push(`${where}.kind must be one of ${APP_KINDS.join(", ")}`);
    hexAndBytes(a, where, errors);
  });
  noDuplicates(
    list.map((a) => (isObject(a) ? a.name : null)),
    "app",
    errors,
  );
}

function checkInExe(inExe, errors) {
  if (!isObject(inExe)) return errors.push("inExe must be an object");
  onlyKeys(inExe, ["builtins", "wheelhouse"], "inExe", errors);
  const b = inExe.builtins;
  if (!isObject(b)) errors.push("inExe.builtins must be an object");
  else {
    onlyKeys(b, ["sha256"], "inExe.builtins", errors);
    if (typeof b.sha256 !== "string" || !HEX64.test(b.sha256))
      errors.push("inExe.builtins.sha256 must be 64 hex characters");
  }
  const w = inExe.wheelhouse;
  if (w !== null) {
    if (!isObject(w)) errors.push("inExe.wheelhouse must be an object or null");
    else {
      onlyKeys(w, ["bytes", "sha256"], "inExe.wheelhouse", errors);
      hexAndBytes(w, "inExe.wheelhouse", errors);
    }
  }
}

function checkPacks(list, errors) {
  if (!Array.isArray(list)) return errors.push("packs must be a list");
  list.forEach((p, i) => {
    const where = `packs[${i}]`;
    if (!isObject(p)) return errors.push(`${where} must be an object`);
    onlyKeys(p, ["id", "tag", "revision", "location", "dir"], where, errors);
    for (const k of ["id", "tag", "revision"]) {
      if (typeof p[k] !== "string" || !TOKEN.test(p[k]))
        errors.push(`${where}.${k} must be a short name`);
    }
    if (!LOCATIONS.includes(p.location)) errors.push(`${where}.location must be release or local`);
    else if (p.location === "release" && p.dir !== null)
      errors.push(`${where}.dir must be null for a release pack`);
    else if (p.location === "local") {
      const bad = relPathProblem(p.dir);
      if (bad) errors.push(`${where}.dir ${bad}`);
    }
  });
  noDuplicates(
    list.map((p) => (isObject(p) ? p.id : null)),
    "packs",
    errors,
  );
}

function checkModels(list, errors) {
  if (!Array.isArray(list)) return errors.push("models must be a list");
  list.forEach((m, i) => {
    const where = `models[${i}]`;
    if (!isObject(m)) return errors.push(`${where} must be an object`);
    onlyKeys(m, ["fridayId", "dir", "bytes", "files"], where, errors);
    if (typeof m.fridayId !== "string" || !TOKEN.test(m.fridayId))
      errors.push(`${where}.fridayId must be a short name`);
    const bad = relPathProblem(m.dir);
    if (bad) errors.push(`${where}.dir ${bad}`);
    if (!isSize(m.bytes)) errors.push(`${where}.bytes must be a non-negative integer`);
    if (!Array.isArray(m.files) || m.files.length === 0)
      return errors.push(`${where}.files must be a non-empty list`);
    let total = 0;
    m.files.forEach((f, j) => {
      const fw = `${where}.files[${j}]`;
      if (!isObject(f)) return errors.push(`${fw} must be an object`);
      onlyKeys(f, ["path", "bytes", "sha256"], fw, errors);
      const fbad = relPathProblem(f.path);
      if (fbad) errors.push(`${fw}.path ${fbad}`);
      hexAndBytes(f, fw, errors);
      if (isSize(f.bytes)) total += f.bytes;
    });
    noDuplicates(
      m.files.map((f) => (isObject(f) ? f.path : null)),
      `${where}.files`,
      errors,
    );
    if (isSize(m.bytes) && m.bytes !== total)
      errors.push(`${where}.bytes must equal the sum of its files (${total})`);
  });
  noDuplicates(
    list.map((m) => (isObject(m) ? m.fridayId : null)),
    "models",
    errors,
  );
  noDuplicates(
    list.map((m) => (isObject(m) ? m.dir : null)),
    "models dir",
    errors,
  );
}

/** Strict check of a parsed bundle. Returns `{ ok, errors }`; never throws. */
function validate(obj) {
  const errors = [];
  if (!isObject(obj)) return { ok: false, errors: ["bundle must be an object"] };
  onlyKeys(
    obj,
    [
      "schema",
      "product",
      "channel",
      "version",
      "commit",
      "caller",
      "app",
      "inExe",
      "packs",
      "models",
    ],
    "bundle",
    errors,
  );
  if (obj.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (typeof obj.product !== "string" || !PRODUCT.test(obj.product))
    errors.push("product must be a short name");
  if (!CHANNELS.includes(obj.channel)) errors.push("channel must be stable or test");
  if (typeof obj.version !== "string" || !VERSION.test(obj.version))
    errors.push("version must look like 1.2.3 or 1.2.3.4");
  if (obj.commit !== null && (typeof obj.commit !== "string" || !COMMIT.test(obj.commit)))
    errors.push("commit must be a hex id or null");
  if (!CALLERS.includes(obj.caller)) errors.push(`caller must be one of ${CALLERS.join(", ")}`);
  checkApp(obj.app, errors);
  checkInExe(obj.inExe, errors);
  checkPacks(obj.packs, errors);
  checkModels(obj.models, errors);
  return { ok: errors.length === 0, errors };
}

function assertValid(obj) {
  const r = validate(obj);
  if (!r.ok) throw new Error(`invalid ${FILE_NAME}: ${r.errors.slice(0, 5).join("; ")}`);
}

const cmp = (a, b) => {
  const la = lower(a);
  const lb = lower(b);
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const slash = (v) => (typeof v === "string" ? v.replace(/\\/g, "/") : v);

/**
 * Build a bundle from plain inputs: copy only the known keys, turn Windows separators in relative paths into `/`,
 * fill a missing model byte total, sort every list, then validate. Throws a readable error when the result is not valid.
 */
function build(opts) {
  const o = isObject(opts) ? opts : {};
  const models = (Array.isArray(o.models) ? o.models : []).map((m) => {
    const src = isObject(m) ? m : {};
    const files = (Array.isArray(src.files) ? src.files : [])
      .map((f) => {
        const s = isObject(f) ? f : {};
        return {
          path: slash(s.path),
          bytes: s.bytes,
          sha256: typeof s.sha256 === "string" ? lower(s.sha256) : s.sha256,
        };
      })
      .sort((a, b) => cmp(String(a.path), String(b.path)));
    const total = files.reduce((n, f) => n + (isSize(f.bytes) ? f.bytes : 0), 0);
    return {
      fridayId: src.fridayId,
      dir: slash(src.dir),
      bytes: src.bytes === undefined ? total : src.bytes,
      files,
    };
  });
  const bundle = {
    schema: SCHEMA,
    product: o.product,
    channel: o.channel,
    version: o.version,
    commit: o.commit === undefined ? null : o.commit,
    caller: o.caller,
    app: (Array.isArray(o.app) ? o.app : [])
      .map((a) => {
        const s = isObject(a) ? a : {};
        return {
          name: s.name,
          kind: s.kind,
          bytes: s.bytes,
          sha256: typeof s.sha256 === "string" ? lower(s.sha256) : s.sha256,
        };
      })
      .sort((a, b) => cmp(String(a.name), String(b.name))),
    inExe: isObject(o.inExe)
      ? {
          builtins: isObject(o.inExe.builtins)
            ? { sha256: lowerHex(o.inExe.builtins.sha256) }
            : o.inExe.builtins,
          wheelhouse: isObject(o.inExe.wheelhouse)
            ? { bytes: o.inExe.wheelhouse.bytes, sha256: lowerHex(o.inExe.wheelhouse.sha256) }
            : (o.inExe.wheelhouse ?? null),
        }
      : o.inExe,
    packs: (Array.isArray(o.packs) ? o.packs : [])
      .map((p) => {
        const s = isObject(p) ? p : {};
        return {
          id: s.id,
          tag: s.tag,
          revision: s.revision,
          location: s.location,
          dir: s.dir === undefined ? null : slash(s.dir),
        };
      })
      .sort((a, b) => cmp(String(a.id), String(b.id))),
    models: models.sort((a, b) => cmp(String(a.fridayId), String(b.fridayId))),
  };
  assertValid(bundle);
  return bundle;
}

function lowerHex(v) {
  return typeof v === "string" ? lower(v) : v;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Canonical text: keys sorted at every level, two-space indent, LF, one trailing newline. */
function stringify(obj) {
  return `${JSON.stringify(sortKeys(obj), null, 2)}\n`;
}

/** SHA-256 (hex) of the canonical text of a valid bundle. */
function hashOf(obj) {
  assertValid(obj);
  return crypto.createHash("sha256").update(stringify(obj), "utf8").digest("hex");
}

/** Read and validate a bundle file. Null on a missing, oversized, damaged or invalid file. */
function read(file, { fs = nodeFs } = {}) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const raw = fs.readFileSync(file, "utf8");
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    return validate(parsed).ok ? parsed : null;
  } catch {
    return null;
  }
}

let tmpCounter = 0;

/** Write a valid bundle atomically: temp file in the same folder, fsync, rename. The old file stays whole on failure. */
function write(file, obj, { fs = nodeFs } = {}) {
  assertValid(obj);
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, stringify(obj));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== -1) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the error below is the one that matters */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
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

function inside(base, full) {
  const rel = nodePath.relative(base, full);
  return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

/**
 * Check that the files a bundle lists exist under `dir` with the listed size and SHA-256. Size first: a file whose
 * size differs is never hashed (a multi-GB hash on a slow or cloud-synced disk is the expensive step).
 * App files are read from `dir`; model files from `opts.modelsRoot` (default `dir`) at `<model.dir>/<file.path>`.
 * `opts.scope` is "all" (default), "app" or "models". Returns `{ ok, checked, bad: [{ path, reason }] }` with
 * reason one of missing, not-a-file, size, sha256, unreadable, invalid-bundle.
 */
function bundleFilesMatch(dir, bundle, opts = {}) {
  const fs = opts.fs || nodeFs;
  const scope = opts.scope || "all";
  const check = validate(bundle);
  if (!check.ok)
    return { ok: false, checked: 0, bad: [{ path: FILE_NAME, reason: "invalid-bundle" }] };
  const items = [];
  if (scope !== "models") {
    for (const a of bundle.app)
      items.push({ rel: a.name, base: dir, bytes: a.bytes, sha256: a.sha256 });
  }
  if (scope !== "app") {
    const root = opts.modelsRoot || dir;
    for (const m of bundle.models) {
      for (const f of m.files)
        items.push({ rel: `${m.dir}/${f.path}`, base: root, bytes: f.bytes, sha256: f.sha256 });
    }
  }
  const bad = [];
  let checked = 0;
  for (const it of items) {
    checked += 1;
    const base = nodePath.resolve(it.base);
    const full = nodePath.resolve(base, ...it.rel.split("/"));
    if (!inside(base, full)) {
      bad.push({ path: it.rel, reason: "invalid-bundle" });
      continue;
    }
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (err) {
      bad.push({ path: it.rel, reason: err && err.code === "ENOENT" ? "missing" : "unreadable" });
      continue;
    }
    if (!st.isFile()) bad.push({ path: it.rel, reason: "not-a-file" });
    else if (st.size !== it.bytes) bad.push({ path: it.rel, reason: "size" });
    else {
      try {
        if (lower(sha256OfFile(fs, full)) !== lower(it.sha256))
          bad.push({ path: it.rel, reason: "sha256" });
      } catch {
        bad.push({ path: it.rel, reason: "unreadable" });
      }
    }
  }
  return { ok: bad.length === 0, checked, bad };
}

/** The pin for one model from the rows of `config/friday-models.json` (`assets`): `{ files: [{ path, bytes, sha256 }] }`. */
function pinFromAssets(assets, fridayId) {
  const files = (Array.isArray(assets) ? assets : [])
    .filter((a) => isObject(a) && a.fridayId === fridayId)
    .map((a) => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 }));
  return { files };
}

/**
 * The config pin always wins. True only when the bundle's model lists exactly the files the pin lists, each with the
 * same size and SHA-256 (hex case ignored). No pin, an empty pin, an extra file, a missing file or a malformed
 * record is false, and a model that is false is not adoptable.
 */
function pinWins(bundleModel, pin) {
  const pinned = Array.isArray(pin) ? pin : isObject(pin) ? pin.files : null;
  if (
    !isObject(bundleModel) ||
    !Array.isArray(bundleModel.files) ||
    !Array.isArray(pinned) ||
    pinned.length === 0
  )
    return false;
  if (bundleModel.files.length !== pinned.length) return false;
  const byPath = new Map();
  for (const f of pinned) {
    if (
      !isObject(f) ||
      typeof f.path !== "string" ||
      typeof f.sha256 !== "string" ||
      !isSize(f.bytes)
    )
      return false;
    if (byPath.has(f.path)) return false;
    byPath.set(f.path, f);
  }
  for (const f of bundleModel.files) {
    if (!isObject(f)) return false;
    const want = byPath.get(f.path);
    if (!want || want.bytes !== f.bytes) return false;
    if (typeof f.sha256 !== "string" || lower(f.sha256) !== lower(want.sha256)) return false;
  }
  return true;
}

module.exports = {
  SCHEMA,
  FILE_NAME,
  MAX_BYTES,
  CHANNELS,
  CALLERS,
  APP_KINDS,
  build,
  validate,
  stringify,
  hashOf,
  read,
  write,
  bundleFilesMatch,
  pinFromAssets,
  pinWins,
};
