/**
 * llama.cpp as a local engine FRIDAY installs and runs herself.
 *
 * Setup downloads the pinned Windows release zip named in `config/local-runners.json` (SHA-256 checked by the
 * downloader), and this file unpacks it into `<FRIDAY_ROOT>/runtime/engines/llama.cpp/<tag>/`. Nothing here touches
 * the system PATH or needs administrator rights. `findServer` gives the `llama-server` binary to start, and
 * `preferred` picks the chat model FRIDAY downloaded when more than one GGUF sits in the models folder.
 *
 * The zip is unpacked by Python's zipfile after every entry is checked to stay inside the target folder, so a
 * zip with a `..` or absolute path cannot write elsewhere.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SERVER_NAMES = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
/** The chat model setup downloads for her; its file name carries this id. */
const DEFAULT_CHAT_ID = "qwen2.5-1.5b-instruct";

const engineDir = (root) => path.join(root, "runtime", "engines", "llama.cpp");

function walk(dir, depth, hit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && hit(entry.name)) return full;
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = walk(path.join(dir, entry.name), depth - 1, hit);
    if (found) return found;
  }
  return null;
}

/** The llama-server FRIDAY installed (the newest release folder wins), or null. */
function findServer(root) {
  if (!root) return null;
  const base = engineDir(root);
  let tags = [];
  try {
    tags = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const tag of tags) {
    const found = walk(path.join(base, tag), 2, (name) =>
      SERVER_NAMES.includes(name.toLowerCase()),
    );
    if (found) return found;
  }
  return null;
}

const installed = (root) => Boolean(findServer(root));

/** With several GGUF files and no choice made, the chat model setup downloaded is used; otherwise null. */
function preferred(paths) {
  const mine = (paths || []).filter((p) =>
    path.basename(p).toLowerCase().replace(/_/g, "-").includes(DEFAULT_CHAT_ID),
  );
  return mine.length === 1 ? mine[0] : null;
}

const SAFE_EXTRACT = `
import os, sys, zipfile
zip_path, dest = sys.argv[1], os.path.realpath(sys.argv[2])
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(zip_path) as z:
    for info in z.infolist():
        target = os.path.realpath(os.path.join(dest, info.filename))
        if target != dest and not target.startswith(dest + os.sep):
            sys.stderr.write("unsafe path in zip: " + info.filename + "\\n")
            sys.exit(3)
    z.extractall(dest)
print("ok")
`;

/** Unpack a zip into `dest` through Python's zipfile. `run` is injected by tests. */
function extractZip(zip, dest, { python = process.env.FRIDAY_PYTHON || "python", run } = {}) {
  const exec =
    run ||
    ((cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) =>
          resolve({
            ok: !err,
            output: String(stdout || "").trim(),
            error: err ? String(stderr || err.message) : null,
          }),
        );
      }));
  return exec(python, ["-I", "-c", SAFE_EXTRACT, zip, dest]);
}

/**
 * Put a downloaded release zip in place. Returns { ok, server } or { ok: false, error }.
 * An already installed server for the same tag is kept as it is.
 */
async function installFromZip(root, zip, tag, deps = {}) {
  if (!root || !zip || !fs.existsSync(zip))
    return { ok: false, error: "the llama.cpp zip is not on disk" };
  const dest = path.join(
    engineDir(root),
    String(tag || "release").replace(/[^A-Za-z0-9._-]/g, "_"),
  );
  const before = findServer(root);
  if (before && before.startsWith(dest)) return { ok: true, server: before, kept: true };
  const out = await extractZip(zip, dest, deps);
  if (!out.ok) return { ok: false, error: out.error || "the zip could not be unpacked" };
  const server = findServer(root);
  return server
    ? { ok: true, server }
    : { ok: false, error: "the zip was unpacked but holds no llama-server" };
}

module.exports = {
  engineDir,
  findServer,
  installed,
  preferred,
  extractZip,
  installFromZip,
  DEFAULT_CHAT_ID,
};
