/**
 * First run on this PC. Staged pack.bin files stay inside the install.
 * Extraction writes only under the user runtime folder. No admin step.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const layout = require("./runtime-layout.cjs");
const archive = require("./archive-safe.cjs");
const packApi = require("./toolchain-pack.cjs");

const STAMP = ".friday-pack.json";

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function defaultRun(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
  });
  return {
    status: result.status,
    stdout: `${result.stdout || ""}${result.stderr || ""}`,
    error: result.error ? String(result.error.message || result.error) : "",
  };
}

function readStamp(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STAMP), "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(dir, stamp) {
  fs.writeFileSync(path.join(dir, STAMP), `${JSON.stringify(stamp)}\n`);
}

function quarantineMessage() {
  return "Security software may have quarantined the runtime file. Allow FRIDAY, then retry.";
}

function flattenSingleRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name !== STAMP);
  const files = entries.filter((entry) => entry.isFile() && entry.name !== STAMP);
  if (files.length || dirs.length !== 1) return;
  const nested = path.join(dir, dirs[0].name);
  for (const name of fs.readdirSync(nested)) {
    archive.renameWithRetry(path.join(nested, name), path.join(dir, name));
  }
  fs.rmSync(nested, { recursive: true, force: true });
}

function headerOk(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 16) return false;
    if (buf[0] === 0x50 && buf[1] === 0x4b) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function proveTool(id, runtimeRoot, run) {
  const spec = layout.toolSpec(id);
  if (!spec) return { ok: false, stdout: "", error: "unknown tool" };
  if (spec.prove === "header") {
    const file = layout.entryFile(runtimeRoot, id);
    const ok = headerOk(file);
    return { ok, stdout: ok ? "header ok" : "model header is short", error: "" };
  }
  const argv = layout.proveArgv(runtimeRoot, id);
  if (!argv) return { ok: true, stdout: "", error: "" };
  const result = run(argv[0], argv.slice(1)) || {};
  const stdout = String(result.stdout || "");
  const ok = result.status === 0 && stdout.trim().length > 0;
  return { ok, stdout, error: String(result.error || "") };
}

function materialiseOne(input) {
  const id = input.id;
  const spec = layout.toolSpec(id);
  const pack = (input.manifest.packs || []).find((item) => item.id === id);
  const now = typeof input.now === "function" ? input.now : Date.now;
  const run = input.run || defaultRun;
  const progress = input.onProgress || (() => {});
  if (!spec || !pack) {
    return { id, ok: false, step: "manifest", message: `${id} is not a bundled pack` };
  }
  const runtimeRoot = input.runtimeRoot;
  const dest = path.join(runtimeRoot, spec.dir);
  const entry = layout.entryFile(runtimeRoot, id);
  const stamp = readStamp(dest);
  if (id === "get-pip" && !input.force && entry && fs.existsSync(entry) && stamp && stamp.proved) {
    progress({ id, phase: "ready" });
    return {
      id,
      ok: true,
      step: "ready",
      file: entry,
      version: pack.version,
      source: stamp.source || "bundled pack",
      hashOk: true,
      lastRun: stamp.provedAt || null,
      proved: true,
      message: `${id} is already extracted`,
    };
  }
  if (
    !input.force &&
    stamp &&
    stamp.sha256 === pack.sha256 &&
    entry &&
    fs.existsSync(entry) &&
    (spec.prove !== "header" ? true : headerOk(entry))
  ) {
    if (stamp.proved || input.prove === false) {
      progress({ id, phase: "ready" });
      return {
        id,
        ok: true,
        step: "ready",
        file: entry,
        version: pack.version,
        source: stamp.source || "bundled pack",
        hashOk: true,
        lastRun: stamp.provedAt || null,
        proved: Boolean(stamp.proved),
        message: `${id} is already extracted`,
      };
    }
  }
  const packFile = layout.findPack(id, input.resourcesRoots || []);
  if (!packFile) {
    return {
      id,
      ok: false,
      step: "missing",
      message: `${id} pack.bin was not found under the app resources folder`,
    };
  }
  progress({ id, phase: "hash" });
  const hash = sha256File(packFile);
  const bytes = fs.statSync(packFile).size;
  if (bytes !== pack.bytes || hash !== pack.sha256) {
    return {
      id,
      ok: false,
      step: "hash",
      hashOk: false,
      message: `${id} failed SHA-256 or size check`,
    };
  }
  const sibling = path.join(runtimeRoot, `.partial-${id}-${process.pid}`);
  fs.rmSync(sibling, { recursive: true, force: true });
  fs.mkdirSync(sibling, { recursive: true });
  const extract = input.extract || archive.extractArchiveFile;
  let extracted = false;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !extracted; attempt += 1) {
    try {
      progress({ id, phase: "extract", attempt });
      if (spec.kind === "file") {
        const named = path.join(sibling, spec.fileName || spec.entry);
        fs.mkdirSync(path.dirname(named), { recursive: true });
        fs.copyFileSync(packFile, named);
      } else {
        extract(packFile, sibling);
        if (spec.flatten) flattenSingleRoot(sibling);
      }
      if (id === "python-embed") packApi.writeEmbedPth(sibling);
      if (!fs.existsSync(path.join(sibling, ...spec.entry.split("/")))) {
        lastError = new Error(quarantineMessage());
        lastError.code = "EPERM";
        continue;
      }
      extracted = true;
    } catch (error) {
      lastError = error;
      const text = String(error && (error.code || error.message));
      if (!/EPERM|EBUSY|quarantine|antivirus/i.test(text)) break;
    }
  }
  if (!extracted) {
    fs.rmSync(sibling, { recursive: true, force: true });
    const code = lastError && lastError.code;
    const antivirus =
      code === "EPERM" || code === "EBUSY" || /quarantine|antivirus/i.test(String(lastError));
    return {
      id,
      ok: false,
      step: antivirus ? "antivirus" : "extract",
      message: antivirus ? quarantineMessage() : String(lastError && lastError.message),
    };
  }
  if (id === "get-pip") {
    const pythonDir = path.join(runtimeRoot, "python");
    fs.mkdirSync(pythonDir, { recursive: true });
    fs.copyFileSync(path.join(sibling, "get-pip.py"), path.join(pythonDir, "get-pip.py"));
    fs.rmSync(sibling, { recursive: true, force: true });
  } else {
    fs.rmSync(dest, { recursive: true, force: true });
    const replaced = archive.replaceDirectory({ source: sibling, target: dest });
    fs.rmSync(sibling, { recursive: true, force: true });
    if (!replaced.ok || !fs.existsSync(entry)) {
      return {
        id,
        ok: false,
        step: "extract",
        message: replaced.error
          ? String(replaced.error.message || replaced.error)
          : `${id} entry is missing`,
      };
    }
  }
  if (id === "python-embed") {
    const pipPack = (input.manifest.packs || []).find((item) => item.id === "get-pip");
    const pipFile = pipPack ? layout.findPack("get-pip", input.resourcesRoots || []) : null;
    if (
      pipFile &&
      pipPack &&
      fs.statSync(pipFile).size === pipPack.bytes &&
      sha256File(pipFile) === pipPack.sha256
    ) {
      fs.copyFileSync(pipFile, path.join(dest, "get-pip.py"));
    }
  }
  const landed = id === "get-pip" ? path.join(runtimeRoot, "python", "get-pip.py") : entry;
  if (!fs.existsSync(landed)) {
    return { id, ok: false, step: "extract", message: `${id} entry is missing after extract` };
  }
  let proved = false;
  let proveOut = "";
  if (input.prove !== false && (id === "python-embed" || id === "get-pip")) {
    const pythonExe = path.join(runtimeRoot, "python", "python.exe");
    const pipScript = path.join(runtimeRoot, "python", "get-pip.py");
    if (fs.existsSync(pythonExe) && fs.existsSync(pipScript)) {
      const boot = run(pythonExe, [pipScript]) || {};
      if (boot.status !== 0) {
        const text = `${boot.stdout || ""} ${boot.error || ""}`;
        return {
          id,
          ok: false,
          step: /antivirus|quarantine|EPERM/i.test(text) ? "antivirus" : "pip",
          file: landed,
          hashOk: true,
          version: pack.version,
          source: packFile,
          message: /antivirus|quarantine|EPERM/i.test(text)
            ? quarantineMessage()
            : `get-pip did not finish (${String(boot.stdout || boot.error || "no output").slice(0, 180)})`,
        };
      }
    }
  }
  if (input.prove !== false) {
    const proveId = id === "get-pip" ? "python-embed" : id;
    const result = proveTool(proveId, runtimeRoot, run);
    proved = result.ok;
    proveOut = result.stdout;
    if (!proved) {
      return {
        id,
        ok: false,
        step: "prove",
        file: landed,
        hashOk: true,
        version: pack.version,
        source: packFile,
        message: `${id} did not run (${String(result.error || result.stdout || "no output").slice(0, 180)})`,
      };
    }
  }
  const provedAt = proved ? new Date(now()).toISOString() : null;
  if (id !== "get-pip") {
    writeStamp(dest, {
      id,
      sha256: pack.sha256,
      version: pack.version,
      source: packFile,
      proved: Boolean(proved),
      provedAt,
      proveOut: String(proveOut || "").slice(0, 200),
    });
  }
  progress({ id, phase: proved ? "ready" : "extracted" });
  return {
    id,
    ok: input.prove === false ? true : Boolean(proved),
    step: proved ? "ready" : "extracted",
    file: id === "get-pip" ? path.join(runtimeRoot, "python", "get-pip.py") : entry,
    version: pack.version,
    source: packFile,
    hashOk: true,
    lastRun: provedAt,
    proved: Boolean(proved),
    message: proved ? `${id} is ready` : `${id} is extracted`,
  };
}

function materialise(input = {}) {
  const runtimeRoot = input.runtimeRoot;
  if (!runtimeRoot)
    return { ok: false, step: "path", tools: {}, events: [], log: ["no runtime folder"] };
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const lock = path.join(runtimeRoot, ".bundled-runtime.lock");
  let fd = null;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      return {
        ok: false,
        step: "busy",
        tools: {},
        events: [],
        log: ["another first-run is still extracting"],
      };
    }
    const denied = error.code === "EPERM" || error.code === "EACCES" || error.code === "EROFS";
    return {
      ok: false,
      step: denied ? "permission" : "path",
      tools: {},
      events: [],
      log: [
        denied
          ? "The runtime folder could not be written. A per-user folder is enough."
          : String(error.message || error),
      ],
    };
  }
  const events = [];
  const tools = {};
  const log = [];
  try {
    const manifest = input.manifest || packApi.readManifest();
    const ids = input.ids || layout.BUNDLED_IDS;
    for (const id of ids) {
      const row = materialiseOne({
        ...input,
        id,
        manifest,
        onProgress: (event) => {
          events.push(event);
          if (typeof input.onProgress === "function") input.onProgress(event);
        },
      });
      tools[id] = row;
      log.push(row.message);
    }
    const ok = Object.values(tools).every((row) => row.ok);
    return { ok, step: ok ? "ready" : "partial", tools, events, log };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function inspect(input = {}) {
  const manifest = input.manifest || packApi.readManifest();
  const ids = input.ids || layout.BUNDLED_IDS;
  const tools = ids.map((id) => {
    const pack = (manifest.packs || []).find((item) => item.id === id);
    const spec = layout.toolSpec(id);
    const file = input.runtimeRoot ? layout.entryFile(input.runtimeRoot, id) : "";
    const present = Boolean(file && fs.existsSync(file));
    const stamp =
      spec && input.runtimeRoot ? readStamp(path.join(input.runtimeRoot, spec.dir)) : null;
    let hashOk = Boolean(stamp && pack && stamp.sha256 === pack.sha256);
    if (id === "get-pip" && present && pack) {
      try {
        hashOk = sha256File(file) === pack.sha256 && fs.statSync(file).size === pack.bytes;
      } catch {
        hashOk = false;
      }
    }
    return {
      id,
      name: pack ? pack.name : id,
      version: pack ? pack.version : "",
      present,
      proved: Boolean(present && stamp && stamp.proved),
      hashOk,
      source: stamp ? stamp.source : layout.findPack(id, input.resourcesRoots || []),
      lastRun: stamp ? stamp.provedAt : null,
      manual: null,
    };
  });
  return { tools };
}

function doctorRows(states) {
  return (states || []).map((state) => {
    const ready = state.proved === true;
    const parts = [
      state.version ? `version ${state.version}` : "",
      state.source ? `source ${state.source}` : "",
      state.hashOk ? "hash OK" : "hash not checked",
      state.lastRun ? `last run ${state.lastRun}` : "not run",
    ].filter(Boolean);
    return {
      id: `toolchain:${state.id}`,
      label: state.name || state.id,
      group: "Bundled runtime",
      status: ready ? "Ready" : state.present ? "Warning" : "Missing",
      detail: parts.join(" · "),
      cause: ready
        ? null
        : state.present
          ? "The tool is on disk and has not been run."
          : "The bundled pack is not extracted yet.",
      fix: ready
        ? null
        : state.manual || "Re-extract the bundled pack from the installed resources folder.",
      fixable: !ready && !state.manual,
    };
  });
}

module.exports = {
  materialise,
  inspect,
  doctorRows,
  sha256File,
  quarantineMessage,
  flattenSingleRoot,
};
