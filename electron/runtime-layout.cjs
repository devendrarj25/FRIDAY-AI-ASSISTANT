/**
 * Where a staged toolchain pack lives, where first-run extraction puts it,
 * and which file proves the tool is there.
 *
 * Staged: resources/<dest>/<id>/pack.bin
 * Runtime: <FRIDAY runtime>/<dir>/<entry>
 */
const path = require("node:path");

const SPEECH_IDS = new Set(["whisper-cpp", "ggml-base", "ggml-tiny"]);

const TOOLS = {
  "python-embed": {
    dir: "python",
    entry: "python.exe",
    kind: "zip",
    prove: ["python.exe", "-m", "pip", "--version"],
  },
  "get-pip": {
    dir: "python",
    entry: "get-pip.py",
    kind: "file",
    fileName: "get-pip.py",
  },
  "node-win": {
    dir: "node",
    entry: "node.exe",
    kind: "zip",
    flatten: true,
    prove: ["node.exe", "--version"],
  },
  "whisper-cpp": {
    dir: "whisper.cpp",
    entry: "Release/whisper-cli.exe",
    kind: "zip",
    also: ["Release/whisper-server.exe"],
    prove: ["Release/whisper-cli.exe", "--help"],
  },
  "ggml-base": {
    dir: "ggml-base",
    entry: "ggml-base.bin",
    kind: "file",
    fileName: "ggml-base.bin",
    prove: "header",
  },
};

const BUNDLED_IDS = ["python-embed", "get-pip", "node-win", "whisper-cpp", "ggml-base"];

function destFor(id) {
  return SPEECH_IDS.has(id) ? "speech" : "toolchain";
}

function toolSpec(id) {
  return TOOLS[id] || null;
}

/** Path under the app resources directory. */
function packRelative(id) {
  return path.posix.join(destFor(id), id, "pack.bin");
}

/** Path under the user runtime directory, using forward slashes. */
function entryRelative(id) {
  const spec = toolSpec(id);
  if (!spec) return "";
  return path.posix.join(spec.dir, spec.entry);
}

function entryFile(runtimeRoot, id) {
  const rel = entryRelative(id);
  if (!runtimeRoot || !rel) return "";
  return path.join(runtimeRoot, ...rel.split("/"));
}

function proveArgv(runtimeRoot, id) {
  const spec = toolSpec(id);
  if (!spec || spec.prove === "header" || !Array.isArray(spec.prove)) return null;
  const [file, ...rest] = spec.prove;
  return [path.join(runtimeRoot, spec.dir, ...file.split("/")), ...rest];
}

/**
 * Installed NSIS and portable both expose the extraResources tree through
 * Electron's resources path. A dev checkout uses the repo resources folder.
 * The nested resources/resources tree is the old extraResources `to` value.
 */
function resourceRoots(input = {}) {
  const roots = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(String(dir));
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  add(input.resourcesPath);
  if (input.resourcesPath) add(path.join(input.resourcesPath, "resources"));
  if (input.execPath) add(path.join(path.dirname(input.execPath), "resources"));
  if (input.portableDir) add(path.join(input.portableDir, "resources"));
  if (input.devRoot) add(path.join(input.devRoot, "resources"));
  for (const extra of input.extra || []) add(extra);
  return roots;
}

function findPack(id, roots, existsSync = require("node:fs").existsSync) {
  const rel = packRelative(id);
  for (const root of roots || []) {
    const file = path.join(root, ...rel.split("/"));
    try {
      if (existsSync(file)) return file;
    } catch {
      /* unreadable root */
    }
  }
  return null;
}

function findToolFile(id, runtimeRoots, existsSync = require("node:fs").existsSync) {
  for (const root of runtimeRoots || []) {
    const file = entryFile(root, id);
    try {
      if (file && existsSync(file)) return file;
    } catch {
      /* unreadable runtime */
    }
  }
  return null;
}

module.exports = {
  BUNDLED_IDS,
  TOOLS,
  destFor,
  toolSpec,
  packRelative,
  entryRelative,
  entryFile,
  proveArgv,
  resourceRoots,
  findPack,
  findToolFile,
};
