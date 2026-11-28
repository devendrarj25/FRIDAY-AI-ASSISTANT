/**
 * FRIDAY · locally built assets
 *
 * A CMD build (or a Setup folder that came with packs) leaves a `friday-bundle.json` next to its files. This module
 * finds those folders and says which pinned model a bundle can serve, so the installed app uses what is already on
 * this PC before it downloads anything. The order of the download chain is: a local bundle, the FRIDAY release, the
 * official upstream. It never writes, moves or deletes: the copy itself is `model-download.cjs`.
 *
 * Where a bundle is looked for, in this order (a folder counts only when it holds a bundle that
 * `build-bundle.cjs` reads and validates):
 *   1. `install-source`  the folder Setup was started from (HKCU\Software\FRIDAY `InstallSourceDir`)
 *   2. `installers`      `<root>/installer/installers/<app version>`, then the newest other version
 *   3. `release`         `<root>/release`, only when the root is a checkout (package.json name is friday)
 *   4. `portable`        the folder of the portable EXE
 *   5. `build-root`      each recorded build root (`staged-assets.cjs`), the root itself or its `release` folder
 * Paths are compared case-insensitively after their real path, so one folder is listed once.
 *
 * Off with `FRIDAY_LOCAL_BUNDLES=0` or the setting `install.useLocalBuilds` (stored as the toggle
 * `installUseLocalBuilds`, default on). A model is usable only when the bundle lists exactly the files of the config
 * pin with the pin's size and SHA-256 (`pinWins`), and the files on disk match the bundle (`bundleFilesMatch`). The
 * config pins always win over what a bundle says.
 */
"use strict";

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const childProcess = require("node:child_process");
const bundleLib = require("./build-bundle.cjs");

const ENV_OFF = "FRIDAY_LOCAL_BUNDLES";
const SETTING_TOGGLE = "installUseLocalBuilds";
const REGISTRY_KEY = "HKCU\\Software\\FRIDAY";
const REGISTRY_VALUE = "InstallSourceDir";
const LOCAL_LABEL = "local build";
const PRODUCT_PACKAGE = "friday";

const key = (value) => nodePath.resolve(String(value)).toLowerCase();

function realOf(fs, dir) {
  try {
    const real = fs.realpathSync.native || fs.realpathSync;
    return real(dir);
  } catch {
    return nodePath.resolve(dir);
  }
}

function isDir(fs, dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The value of one HKCU registry string through `reg query`, or null. Windows only; tests inject their own reader. */
function defaultReadRegistry(keyPath, name, { platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  try {
    const out = childProcess.execFileSync("reg", ["query", keyPath, "/v", name], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, "i").exec(out);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** The stored setting: the toggle `installUseLocalBuilds` in `<root>/config/friday-preferences.json`. Default true. */
function settingOn(root, fs = nodeFs) {
  if (!root) return true;
  try {
    const raw = JSON.parse(
      fs.readFileSync(nodePath.join(root, "config", "friday-preferences.json"), "utf8"),
    );
    return raw?.toggles?.[SETTING_TOGGLE] !== false;
  } catch {
    return true;
  }
}

/**
 * Is local discovery on? `FRIDAY_LOCAL_BUNDLES=0` and `install.useLocalBuilds=false` turn it off. The caller may pass
 * the setting as `useLocalBuilds` (a boolean); without it the stored preferences file under `root` is read.
 */
function enabled(root, { env = process.env, useLocalBuilds, fs = nodeFs } = {}) {
  if (String(env?.[ENV_OFF] ?? "1").trim() === "0") return false;
  if (typeof useLocalBuilds === "boolean") return useLocalBuilds;
  return settingOn(root, fs);
}

/** Dotted numbers compared part by part, newest first. A name that is not a version sorts last. */
function newestFirst(a, b) {
  const num = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const [x, y] = [num(a), num(b)];
  if (!x || !y) return x ? -1 : y ? 1 : a < b ? 1 : -1;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function isCheckout(root, fs) {
  try {
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(root, "package.json"), "utf8"));
    return pkg?.name === PRODUCT_PACKAGE;
  } catch {
    return false;
  }
}

/**
 * A UNC share (`\\host\share`, `\\?\UNC\...`, `//host/share`) or a device path is never looked at: statting or
 * resolving it would open a network connection. The value is judged as written, before any resolve.
 */
function isLocalPath(value) {
  return !/^[\\/]{2}/.test(value) && !value.includes("\0");
}

/** The folders to look in, in order, each with its origin. Existence is not checked here. */
function candidateFolders(root, opts, fs) {
  const env = opts.env || process.env;
  const out = [];
  const add = (origin, dir) => {
    if (typeof dir === "string" && dir.trim() && isLocalPath(dir.trim()))
      out.push({ origin, dir: nodePath.resolve(dir.trim()) });
  };
  const read = opts.readRegistry || ((k, n) => defaultReadRegistry(k, n));
  try {
    add("install-source", read(REGISTRY_KEY, REGISTRY_VALUE));
  } catch {
    /* an unreadable registry is no source */
  }
  if (root) {
    const base = nodePath.join(root, "installer", "installers");
    let names = [];
    try {
      names = fs.readdirSync(base).filter((name) => isDir(fs, nodePath.join(base, name)));
    } catch {
      names = [];
    }
    const wanted = opts.appVersion ? String(opts.appVersion) : "";
    const first = names.filter((name) => wanted && name.toLowerCase() === wanted.toLowerCase());
    const rest = names.filter((name) => !first.includes(name)).sort(newestFirst);
    for (const name of [...first, ...rest]) add("installers", nodePath.join(base, name));
    if (isCheckout(root, fs)) add("release", nodePath.join(root, "release"));
  }
  add("portable", opts.portableDir === undefined ? env.PORTABLE_EXECUTABLE_DIR : opts.portableDir);
  let roots = [];
  try {
    roots = (opts.readBuildRoots || (() => require("./staged-assets.cjs").readBuildRoots(env)))();
  } catch {
    roots = [];
  }
  for (const build of Array.isArray(roots) ? roots : []) {
    if (!build?.root) continue;
    add("build-root", build.root);
    add("build-root", nodePath.join(build.root, "release"));
  }
  return out;
}

/**
 * Every folder that holds a parseable `friday-bundle.json`, in the order above, each real folder once.
 * Returns `[{ origin, dir, bundle }]`. Never throws; off (setting or env) returns `[]`.
 * Options (all injectable): `env`, `readRegistry(keyPath, name)`, `portableDir`, `fs`, `appVersion`, `useLocalBuilds`,
 * `readBuildRoots()`.
 */
function discoverLocalBundles(root, opts = {}) {
  const fs = opts.fs || nodeFs;
  try {
    if (!enabled(root, { env: opts.env, useLocalBuilds: opts.useLocalBuilds, fs })) return [];
    const seen = new Set();
    const found = [];
    for (const { origin, dir } of candidateFolders(root, opts, fs)) {
      if (!isDir(fs, dir)) continue;
      const real = realOf(fs, dir);
      if (seen.has(key(real))) continue;
      const bundle = bundleLib.read(nodePath.join(dir, bundleLib.FILE_NAME), { fs });
      if (!bundle) continue;
      seen.add(key(real));
      found.push({ origin, dir, bundle });
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * The folders a bundle's relative paths can start from: the bundle folder, its parent (a `release` folder sits in
 * its checkout) and, for an `installers/<version>` folder, the FRIDAY root three levels up.
 */
function baseRootsOf(entry) {
  const out = [entry.dir, nodePath.dirname(entry.dir)];
  if (entry.origin === "installers") out.push(nodePath.resolve(entry.dir, "..", "..", ".."));
  const seen = new Set();
  return out.filter((dir) => !seen.has(key(dir)) && seen.add(key(dir)));
}

const lastSegment = (dir) => String(dir).split("/").filter(Boolean).pop() || "";

function sizeIs(fs, file, bytes) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size === bytes;
  } catch {
    return false;
  }
}

const insideOf = (base, full) => {
  const rel = nodePath.relative(base, full);
  return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
};

/**
 * Which local bundle can serve the pinned model `modelId`, or null.
 *
 * `pinFiles` is the config pin as `[{ path, bytes, sha256 }]` (or `{ files }`). `releasePlan` (optional) is the
 * FRIDAY release plan of the same model (`voice-weights.fridayReleasePlan`): a bundle pack with the same tag and a
 * local folder can serve its part files, joined later by the copy. A model folder of the bundle wins over a pack.
 *
 * A bundle model is usable only when `pinWins` is true (exactly the pinned files, same size and SHA-256), its files
 * are on disk with the listed size and, with `deep` (default), `bundleFilesMatch` says the SHA-256 of every file
 * matches too. `deep: false` skips the hash pass here: the copy then holds every file to the pinned SHA-256 while it
 * streams, so a main process is not blocked for a multi-GB hash. A model folder that is the install root's own is never
 * a source (it is already in place).
 *
 * Returns `{ origin, dir, via: "models" | "pack", files: [{ name, bytes, sha256, parts: [{ path, bytes }] }] }`.
 */
function planLocalModel({
  bundles,
  installRoot,
  modelId,
  pinFiles,
  releasePlan,
  deep = true,
  fs = nodeFs,
}) {
  const pinned = Array.isArray(pinFiles) ? pinFiles : pinFiles?.files;
  if (!modelId || !Array.isArray(pinned) || !pinned.length || !Array.isArray(bundles)) return null;
  const home = installRoot ? key(realOf(fs, installRoot)) : "";
  for (const entry of bundles) {
    const bases = baseRootsOf(entry);
    const model = (entry.bundle.models || []).find(
      (m) => lastSegment(m.dir).toLowerCase() === String(modelId).toLowerCase(),
    );
    if (model && bundleLib.pinWins(model, { files: pinned })) {
      for (const base of bases) {
        if (home && key(realOf(fs, base)) === home) continue;
        const folder = nodePath.resolve(base, ...model.dir.split("/"));
        if (!insideOf(nodePath.resolve(base), folder)) continue;
        const present = model.files.every((f) =>
          sizeIs(fs, nodePath.resolve(folder, ...f.path.split("/")), f.bytes),
        );
        if (!present) continue;
        if (deep) {
          const single = { ...entry.bundle, models: [model] };
          if (
            !bundleLib.bundleFilesMatch(entry.dir, single, {
              scope: "models",
              modelsRoot: base,
              fs,
            }).ok
          )
            continue;
        }
        return {
          origin: entry.origin,
          dir: entry.dir,
          via: "models",
          files: model.files.map((f) => ({
            name: f.path,
            bytes: f.bytes,
            sha256: f.sha256.toLowerCase(),
            parts: [{ path: nodePath.resolve(folder, ...f.path.split("/")), bytes: f.bytes }],
          })),
        };
      }
    }
    const pack = releasePlan
      ? (entry.bundle.packs || []).find((p) => p.location === "local" && p.tag === releasePlan.tag)
      : null;
    if (!pack) continue;
    for (const base of bases) {
      const folder = nodePath.resolve(base, ...String(pack.dir).split("/"));
      if (!insideOf(nodePath.resolve(base), folder)) continue;
      const files = [];
      for (const file of releasePlan.files) {
        const parts = file.parts.map((p) => ({
          path: nodePath.join(folder, p.file),
          bytes: p.bytes,
        }));
        if (!parts.every((p) => sizeIs(fs, p.path, p.bytes))) break;
        files.push({
          name: file.name,
          bytes: file.bytes,
          sha256: file.sha256.toLowerCase(),
          parts,
        });
      }
      if (files.length === releasePlan.files.length)
        return { origin: entry.origin, dir: entry.dir, via: "pack", files };
    }
  }
  return null;
}

/**
 * Which local bundle holds one FRIDAY Core file (`models/friday-core/<disk>` in a bundle model, or the parts of its
 * release asset in a local pack), or null. `file` is the manifest entry `{ disk, bytes, sha256 }`; `asset` the release
 * asset of `config/friday-models.json` (optional) with `tag` the pack tag it lives under.
 * Returns `{ origin, dir, via, parts: [{ path, bytes }] }`.
 */
function planLocalCoreFile({ bundles, installRoot, file, asset, tag, fs = nodeFs }) {
  if (!Array.isArray(bundles) || !file?.disk || !/^[0-9a-f]{64}$/.test(String(file.sha256)))
    return null;
  const home = installRoot ? key(realOf(fs, installRoot)) : "";
  for (const entry of bundles) {
    for (const base of baseRootsOf(entry)) {
      if (home && key(realOf(fs, base)) === home) continue;
      for (const model of entry.bundle.models || []) {
        if (lastSegment(model.dir) !== "friday-core") continue;
        const row = model.files.find((f) => f.path === file.disk);
        if (!row || row.bytes !== file.bytes || row.sha256.toLowerCase() !== file.sha256) continue;
        const full = nodePath.resolve(base, ...model.dir.split("/"), file.disk);
        if (insideOf(nodePath.resolve(base), full) && sizeIs(fs, full, file.bytes))
          return {
            origin: entry.origin,
            dir: entry.dir,
            via: "models",
            parts: [{ path: full, bytes: file.bytes }],
          };
      }
    }
    const pack =
      asset && tag
        ? (entry.bundle.packs || []).find((p) => p.location === "local" && p.tag === tag)
        : null;
    if (!pack) continue;
    for (const base of baseRootsOf(entry)) {
      const folder = nodePath.resolve(base, ...String(pack.dir).split("/"));
      if (!insideOf(nodePath.resolve(base), folder)) continue;
      const count = Number.isInteger(asset.parts) && asset.parts > 0 ? asset.parts : 1;
      const names = Array.from({ length: count }, (_, i) =>
        count <= 1 ? asset.file : `${asset.file}.part${String(i + 1).padStart(3, "0")}`,
      );
      const paths = names.map((n) => nodePath.join(folder, n));
      if (!paths.every((p) => isFile(fs, p))) continue;
      const parts = paths.map((p) => ({ path: p, bytes: fs.statSync(p).size }));
      // The parts are joined and held to the pinned size and SHA-256 by the copy; a total that is off is no source.
      if (parts.reduce((n, p) => n + p.bytes, 0) === file.bytes)
        return { origin: entry.origin, dir: entry.dir, via: "pack", parts };
    }
  }
  return null;
}

function isFile(fs, file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  ENV_OFF,
  SETTING_TOGGLE,
  LOCAL_LABEL,
  defaultReadRegistry,
  enabled,
  discoverLocalBundles,
  baseRootsOf,
  planLocalModel,
  planLocalCoreFile,
};
