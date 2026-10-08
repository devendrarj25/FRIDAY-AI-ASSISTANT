/**
 * Isolated runtime helpers for the pinned toolchain manifest.
 * Nothing here changes the system PATH or the registry.
 */
const fs = require("fs");
const path = require("path");

const MANIFEST = path.join(__dirname, "..", "config", "toolchain-manifest.json");

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function packById(id) {
  return readManifest().packs.find((pack) => pack.id === id) || null;
}

function windowsLongPath(file) {
  const resolved = path.resolve(file);
  if (process.platform !== "win32") return resolved;
  if (resolved.startsWith("\\\\?\\")) return resolved;
  if (resolved.length < 240) return resolved;
  return `\\\\?\\${resolved}`;
}

function embedPthText() {
  return ["python312.zip", ".", "Lib\\site-packages", "import site", ""].join("\n");
}

function writeEmbedPth(dir) {
  const target = windowsLongPath(path.join(dir, "python312._pth"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, embedPthText(), "utf8");
  return target;
}

function classifyBootstrapError(text) {
  const raw = String(text || "");
  if (/antivirus|quarantine|smartscreen|blocked by/i.test(raw)) return "antivirus";
  if (/EPERM|EACCES|permission denied|access is denied/i.test(raw)) return "permission";
  if (/ENOSPC|disk full|no space/i.test(raw)) return "disk";
  if (/proxy|407/i.test(raw)) return "proxy";
  if (/ENOTFOUND|ETIMEDOUT|network|getaddrinfo/i.test(raw)) return "network";
  if (/corrupt|hash|checksum|sha256/i.test(raw)) return "corrupt";
  if (/unicode|path too long|ENOENT/i.test(raw)) return "path";
  return "runtime";
}

function findPythonExe(root) {
  const candidates = [
    path.join(root, "FRIDAY_Python", "python.exe"),
    path.join(root, "python-embed", "python.exe"),
    path.join(root, "py312", "Scripts", "python.exe"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

/**
 * First-run layout under the user runtime folder. Download and extract are
 * injected so a test never touches the network.
 */
function materialisePython(input) {
  const root = input.root;
  const existing = findPythonExe(root);
  if (existing) return { ok: true, exe: existing, step: "ready" };
  if (input.network === false)
    return { ok: false, exe: null, step: "need-network", cause: "network" };
  const pack = packById("python-embed");
  if (!pack) return { ok: false, exe: null, step: "manifest", cause: "corrupt" };
  if (typeof input.download !== "function" || typeof input.extract !== "function") {
    return { ok: false, exe: null, step: "no-fetcher", cause: "runtime" };
  }
  const file = input.download(pack);
  if (!file || file.sha256 !== pack.sha256 || file.bytes !== pack.bytes) {
    return { ok: false, exe: null, step: "hash", cause: "corrupt" };
  }
  const dest = path.join(root, "python-embed");
  input.extract(file.path, dest);
  writeEmbedPth(dest);
  const exe = path.join(dest, "python.exe");
  if (input.exists && !input.exists(exe))
    return { ok: false, exe: null, step: "extract", cause: "corrupt" };
  return { ok: true, exe, step: "extracted" };
}

function installChain(facts) {
  const steps = ["python", "venv", "pip", "packages", "import", "weights", "worker"];
  for (const step of steps) {
    if (facts[step] === false) {
      const cause =
        step === "python"
          ? "no-python"
          : step === "pip"
            ? "no-pip"
            : step === "import"
              ? "import-failed"
              : step === "weights"
                ? "downloading"
                : "model-failed";
      return { ok: false, step, cause, retry: true };
    }
  }
  return { ok: true, step: "ready", cause: "ok", retry: false };
}

module.exports = {
  readManifest,
  packById,
  windowsLongPath,
  embedPthText,
  writeEmbedPth,
  classifyBootstrapError,
  findPythonExe,
  materialisePython,
  installChain,
};
