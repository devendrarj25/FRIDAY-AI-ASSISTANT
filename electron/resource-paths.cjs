/**
 * One lookup for files that ship next to the packaged app (extraResources)
 * and next to this repo in development.
 *
 * Nothing in this file reads the disk while it is being loaded. Callers read
 * inside a function. A missing file is a degraded row, not a throw.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** JSON and YAML the Doctor expects to be able to open. */
const WATCHED = [
  "download-hosts.json",
  "local-runners.json",
  "toolchain-versions.json",
  "friday-version.json",
  "toolchain-manifest.json",
  "kernel.yaml",
  "models.yaml",
];

const cache = new Map();

function resourcesRoots() {
  const roots = [];
  const push = (value) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  // Packaged extraResources live here. Development Electron points this at
  // its own resources directory, which does not contain FRIDAY's config.
  if (process.resourcesPath) push(process.resourcesPath);
  // Source checkout: this file is electron/resource-paths.cjs.
  push(path.resolve(__dirname, ".."));
  if (process.resourcesPath) push(path.join(process.resourcesPath, "app.asar"));
  if (process.execPath) push(path.join(path.dirname(process.execPath), "resources"));
  // The stdio launcher is a real file at resources/app.asar.unpacked/electron.
  // Config stays at resources/config, one directory above that extract.
  if (path.basename(path.resolve(__dirname, "..")) === "app.asar.unpacked") {
    push(path.resolve(__dirname, "..", ".."));
  }
  return roots;
}

function safeParts(relative) {
  const parts = String(relative || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (
    !parts.length ||
    parts.some((part) => part === "." || part === ".." || !FILE_NAME.test(part))
  ) {
    return null;
  }
  return parts;
}

function firstExisting(parts, wantFile) {
  for (const root of resourcesRoots()) {
    const candidate = path.join(root, ...parts);
    try {
      const stat = fs.statSync(candidate);
      if (wantFile ? stat.isFile() : stat.isDirectory() || stat.isFile()) return candidate;
    } catch {
      /* the next root may have it */
    }
  }
  return null;
}

function resolveConfigFile(name) {
  const file = String(name || "");
  if (!FILE_NAME.test(file)) return null;
  return firstExisting(["config", file], true);
}

function resolveResourceDir(name) {
  const parts = safeParts(name);
  if (!parts) return null;
  return firstExisting(parts, false);
}

function resolveResourceFile(relative) {
  const parts = safeParts(relative);
  if (!parts) return null;
  return firstExisting(parts, true);
}

function inspectConfig(name) {
  const key = String(name || "");
  if (cache.has(key)) return cache.get(key);
  const file = resolveConfigFile(key);
  if (!file) {
    const missing = { name: key, file: null, value: null, degraded: true, error: "not found" };
    cache.set(key, missing);
    return missing;
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    const value = key.endsWith(".json") ? JSON.parse(text) : text;
    const row = { name: key, file, value, degraded: false, error: "" };
    cache.set(key, row);
    return row;
  } catch (error) {
    const row = {
      name: key,
      file,
      value: null,
      degraded: true,
      error: error && error.message ? error.message : String(error),
    };
    cache.set(key, row);
    return row;
  }
}

function readConfigJson(name, fallback) {
  const loaded = inspectConfig(name);
  if (!loaded.degraded && loaded.value && typeof loaded.value === "object") {
    if (
      fallback &&
      typeof fallback === "object" &&
      !Array.isArray(fallback) &&
      !Array.isArray(loaded.value)
    ) {
      return { ...loaded, value: { ...fallback, ...loaded.value } };
    }
    return loaded;
  }
  return { ...loaded, value: fallback === undefined ? null : fallback };
}

function configHealth() {
  return WATCHED.map((name) => {
    const row = inspectConfig(name);
    return { name: row.name, file: row.file, degraded: row.degraded, error: row.error };
  });
}

function clearConfigCache() {
  cache.clear();
}

module.exports = {
  WATCHED,
  resourcesRoots,
  resolveConfigFile,
  resolveResourceDir,
  resolveResourceFile,
  inspectConfig,
  readConfigJson,
  configHealth,
  clearConfigCache,
};
