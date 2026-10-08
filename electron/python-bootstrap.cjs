/**
 * A relocatable CPython for Windows, pinned and stored under the FRIDAY runtime.
 * A system Python and WinGet stay as a later path. This file does not change
 * the installer.
 */
const path = require("path");

const SPEC = {
  id: "FRIDAY Python",
  version: "3.12.15",
  tag: "20261003",
  file: "cpython-3.12.15+20261003-x86_64-pc-windows-msvc-install_only.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only.tar.gz",
  sha256: "4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08",
  bytes: 46509797,
  license: "PSF-2.0",
  archiveBin: "python/python.exe",
};

function standaloneSpec() {
  return { ...SPEC };
}

function windowsLongPath(file, platform = process.platform) {
  const full = path.resolve(file);
  if (platform !== "win32") return full;
  if (full.startsWith("\\\\?\\")) return full;
  if (full.length < 240) return full;
  return `\\\\?\\${full}`;
}

function interpreterPath(runtimeDir) {
  return path.join(runtimeDir, "FRIDAY_Python", SPEC.archiveBin);
}

function venvExe(runtimeDir, platform = "win32") {
  const envDir = path.join(runtimeDir, "py312");
  return platform === "win32"
    ? path.join(envDir, "Scripts", "python.exe")
    : path.join(envDir, "bin", "python");
}

function pipArgs(packages, cacheDir) {
  const args = ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check"];
  if (cacheDir) args.push("--find-links", cacheDir);
  args.push(...packages);
  return args;
}

function classifyBootstrapError(text) {
  const value = String(text || "");
  if (/antivirus|smartscreen|virus/i.test(value)) {
    return {
      cause: "antivirus",
      line: "Security software blocked the runtime file. Allow it, then retry.",
    };
  }
  if (/EPERM|EACCES|permission denied/i.test(value)) {
    return {
      cause: "permission",
      line: "The runtime folder could not be written. A per-user folder is enough.",
    };
  }
  if (/ENOSPC|disk full|no space/i.test(value)) {
    return { cause: "disk", line: "The disk filled up. Free space, then retry." };
  }
  if (/proxy|407/i.test(value))
    return { cause: "proxy", line: "A proxy blocked the runtime download." };
  if (/ENOTFOUND|getaddrinfo|offline|network/i.test(value)) {
    return {
      cause: "network",
      line: "The runtime download needs a network. Retry when it returns.",
    };
  }
  if (/checksum|sha256|hash/i.test(value)) {
    return { cause: "corrupt", line: "The runtime file did not match its pin. It was discarded." };
  }
  return {
    cause: "runtime",
    line: value.replace(/\s+/g, " ").trim().slice(-180) || "The runtime could not be prepared.",
  };
}

/**
 * Ordered install. The first failed fact is the cause. A later retry is safe.
 */
function installChain(facts) {
  const steps = [
    ["python", facts?.python, "no-python"],
    ["venv", facts?.venv, "no-python"],
    ["pip", facts?.pip, "no-pip"],
    ["packages", facts?.packages, "import-failed"],
    ["import", facts?.imported, "import-failed"],
    ["weights", facts?.weights, "downloading"],
    ["worker", facts?.worker, "model-failed"],
  ];
  for (const [step, ok, cause] of steps) {
    if (!ok) return { ok: false, step, cause, retry: true };
  }
  return { ok: true, step: "ready", cause: "ok", retry: false };
}

/**
 * Create the managed venv from a pinned interpreter. Download and extract are
 * injected so a test never touches the network.
 */
async function materialise(input) {
  const runtimeDir = input.runtimeDir;
  const platform = input.platform || "win32";
  const exists = input.exists || (() => false);
  const onLine = input.onLine || (() => {});
  const exe = venvExe(runtimeDir, platform);
  if (exists(exe)) return { exe, prefix: [], via: "venv" };
  let base = interpreterPath(runtimeDir);
  if (!exists(base)) {
    if (typeof input.download !== "function" || typeof input.extract !== "function") {
      return null;
    }
    onLine("downloading the pinned Python runtime");
    const file = await input.download(SPEC);
    if (!file) return null;
    const dest = path.join(runtimeDir, "FRIDAY_Python");
    await input.extract(file, dest);
    base = interpreterPath(runtimeDir);
    if (!exists(base)) return null;
  }
  const envDir = path.join(runtimeDir, "py312");
  onLine(`creating a managed runtime at ${envDir}`);
  await input.run(base, ["-m", "venv", windowsLongPath(envDir, platform)]);
  if (!exists(exe)) return null;
  const cache = input.wheelCache || "";
  await input.run(exe, pipArgs(["pip"], cache));
  return { exe, prefix: [], via: "standalone" };
}

module.exports = {
  SPEC,
  standaloneSpec,
  windowsLongPath,
  interpreterPath,
  venvExe,
  pipArgs,
  classifyBootstrapError,
  installChain,
  materialise,
};
