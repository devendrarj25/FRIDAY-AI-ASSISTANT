/**
 * FRIDAY — Electron binary guard.
 *
 * Electron's npm install script is the primary installer. If it did not leave a
 * usable binary, this guard runs that installer once and then downloads the
 * exact resolved Electron release archive as a deterministic fallback.
 *
 * The fallback follows redirects, honours HTTP_PROXY/HTTPS_PROXY through
 * undici, validates the response/archive and extracts into electron/dist.
 *
 * Usage:
 *   node scripts/ensure-electron.cjs            verify, download if missing
 *   node scripts/ensure-electron.cjs --quiet    same, less output
 *
 * Exit code 0 = a runnable Electron binary is present.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const root = path.resolve(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");
const installer = path.join(electronDir, "install.js");
const quiet = process.argv.includes("--quiet");

const log = (msg) => {
  if (!quiet) console.log(`[friday] ${msg}`);
};

const binaryName = () => {
  if (process.platform === "win32") return "electron.exe";
  if (process.platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return "electron";
};

const binaryPath = () => path.join(electronDir, "dist", binaryName());

const declaredVersion = () => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8")).version || null
    );
  } catch {
    return null;
  }
};

/** The range this project accepts, e.g. "^43.3.0". */
const declaredRange = () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return (
      (pkg.devDependencies && pkg.devDependencies.electron) ||
      (pkg.dependencies && pkg.dependencies.electron) ||
      null
    );
  } catch {
    return null;
  }
};

const parse = (v) =>
  String(v || "")
    .trim()
    .replace(/^[\^~v=]+/, "")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
const gte = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return true;
};

/**
 * Latest stable release that still satisfies the project's range, taken from
 * the official npm registry (https://www.npmjs.com/package/electron).
 * Used only when the resolved version cannot be read from node_modules.
 */
async function latestCompatibleVersion() {
  const range = declaredRange();
  try {
    const { fetch } = require("undici");
    const response = await fetch("https://registry.npmjs.org/electron", {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const latest = data["dist-tags"] && data["dist-tags"].latest;
    if (!range) return latest || null;
    const floor = parse(range).join(".");
    const major = parse(range)[0];
    const caret = range.startsWith("^");
    const stable = Object.keys(data.versions || {})
      .filter((v) => !v.includes("-"))
      .filter((v) => gte(v, floor) && (!caret || parse(v)[0] === major))
      .sort((a, b) => (gte(a, b) ? 1 : -1));
    return stable[stable.length - 1] || latest || null;
  } catch {
    return null;
  }
}

/** True only when the resolved package has a physical, non-empty binary. */
const isPresent = () => {
  try {
    return fs.statSync(binaryPath()).isFile() && fs.statSync(binaryPath()).size > 0;
  } catch {
    return false;
  }
};

/**
 * Execute the real binary and read the version it reports. This is the only
 * proof that the download produced a working Electron: ELECTRON_RUN_AS_NODE
 * keeps it headless (no window, no display server) while still starting the
 * actual electron.exe.
 *
 * Returns { present, runnable, version, error, systemLibs }.
 */
const verifyBinary = () => {
  const result = {
    present: isPresent(),
    runnable: false,
    version: null,
    error: "",
    systemLibs: false,
  };
  if (!result.present) return result;
  try {
    const r = spawnSync(
      binaryPath(),
      ["-e", "process.stdout.write(process.versions.electron||'')"],
      {
        encoding: "utf8",
        cwd: root,
        timeout: 60000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    result.error = `${r.stderr || ""}`.trim().split(/\r?\n/)[0] || "";
    const reported = `${r.stdout || ""}`.trim();
    if (r.status === 0 && reported) {
      result.runnable = true;
      result.version = reported;
    }
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }
  // Missing desktop system libraries are an OS limitation (never Windows),
  // not a bad download.
  result.systemLibs = /shared librar|libglib|libgtk|libnss|\.so\.\d/i.test(result.error);
  return result;
};

/**
 * A binary is usable when it executes and reports a version. On non-Windows
 * hosts that simply lack desktop system libraries, a present binary of the
 * resolved version still counts — FRIDAY ships to Windows.
 */
const isUsable = () => {
  const v = verifyBinary();
  if (v.runnable) return true;
  return v.present && v.systemLibs && process.platform !== "win32";
};

/**
 * Environment that must not suppress the download. These are honoured by
 * electron/install.js and are the most common reason a clean install ends up
 * without a binary on a developer machine or CI runner.
 */
const downloadEnv = () => {
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.npm_config_electron_skip_binary_download;
  // Keep user-provided mirrors/caches (ELECTRON_MIRROR, ELECTRON_CACHE) intact.
  return env;
};

const runInstaller = () => {
  if (!fs.existsSync(installer)) return false;
  const r = spawnSync(process.execPath, [installer], {
    stdio: quiet ? "ignore" : "inherit",
    cwd: electronDir,
    env: downloadEnv(),
  });
  return r.status === 0 && isUsable();
};

const archiveName = (version) =>
  `electron-v${version}-${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.zip`;

/**
 * Official download endpoints (https://www.electronjs.org/download):
 * the GitHub release asset, plus a user-configured official mirror if present.
 */
const releaseArchives = (version) => {
  const urls = [
    `https://github.com/electron/electron/releases/download/v${version}/${archiveName(version)}`,
  ];
  const mirror = process.env.ELECTRON_MIRROR;
  if (mirror) urls.push(`${mirror.replace(/\/$/, "")}/v${version}/${archiveName(version)}`);
  return urls;
};

const loadExtractor = () => {
  try {
    const extractor = require("@electron-internal/extract-zip");
    return extractor.extract || extractor.default || extractor;
  } catch {
    const extractor = require("extract-zip");
    return extractor.extract || extractor.default || extractor;
  }
};

/**
 * Third official method: Electron's own @electron/get downloader, installed
 * on demand from the npm registry. It works even when the resolved electron
 * package's bundled install.js is missing or broken, and honours the same
 * official mirrors, caches and proxy settings.
 */
async function downloadViaElectronGet(version) {
  let get;
  try {
    get = require("@electron/get");
  } catch {
    const install = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", "@electron/get"],
      {
        stdio: quiet ? "ignore" : "inherit",
        cwd: root,
        env: downloadEnv(),
        shell: process.platform === "win32",
      },
    );
    if (install.status !== 0)
      throw new Error(`@electron/get could not be installed (exit ${install.status})`);
    get = require("@electron/get");
  }
  const archive = await get.downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
  });
  const destination = path.join(electronDir, "dist");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  await loadExtractor()(archive, { dir: destination });
  if (!isPresent()) throw new Error(`archive did not contain ${binaryName()}`);
  fs.writeFileSync(path.join(electronDir, "path.txt"), binaryName());
  if (!isUsable())
    throw new Error(
      `downloaded binary does not execute: ${verifyBinary().error || "no version reported"}`,
    );
  return true;
}

async function downloadResolvedRelease(version) {
  const { fetch, ProxyAgent } = require("undici");
  const extract = loadExtractor();

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-electron-"));
  const archive = path.join(tempDir, `electron-v${version}.zip`);
  const destination = path.join(electronDir, "dist");
  const urls = releaseArchives(version);
  let lastError = null;
  try {
    for (const url of urls) {
      // Two attempts per official endpoint: transient network/CDN hiccups are
      // the most common cause of a corrupted or partial download.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await fetch(url, {
            redirect: "follow",
            dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
            headers: { accept: "application/zip, application/octet-stream" },
          });
          if (!response.ok || !response.body) {
            throw new Error(`release download returned HTTP ${response.status}`);
          }
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          if (contentType.includes("text/html")) throw new Error(`release returned ${contentType}`);
          fs.rmSync(archive, { force: true });
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
          const header = Buffer.alloc(4);
          const fd = fs.openSync(archive, "r");
          try {
            fs.readSync(fd, header, 0, header.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          if (header[0] !== 0x50 || header[1] !== 0x4b || fs.statSync(archive).size === 0) {
            throw new Error("release response is not a valid ZIP archive");
          }
          fs.rmSync(destination, { recursive: true, force: true });
          fs.mkdirSync(destination, { recursive: true });
          await extract(archive, { dir: destination });
          if (!isPresent()) throw new Error(`archive did not contain ${binaryName()}`);
          fs.writeFileSync(path.join(electronDir, "path.txt"), binaryName());
          if (!isUsable()) {
            throw new Error(
              `downloaded binary does not execute: ${verifyBinary().error || "no version reported"}`,
            );
          }
          return true;
        } catch (error) {
          lastError = error;
          log(
            `download attempt ${attempt} failed for ${url} — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    throw lastError || new Error("no official release endpoint responded");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function ensureElectron() {
  if (!fs.existsSync(electronDir)) {
    // Production/deploy install without devDependencies — nothing to do.
    log("skip     electron is not installed in this tree");
    return true;
  }
  let version = declaredVersion();
  const initial = verifyBinary();
  if (initial.runnable || (initial.present && initial.systemLibs && process.platform !== "win32")) {
    log(
      initial.runnable
        ? `ok       electron binary verified (v${initial.version}) at ${binaryPath()}`
        : `ok       electron binary present (v${version || "unknown"}) — not launchable on this OS: ${initial.error}`,
    );
    return true;
  }
  if (initial.present) {
    log(
      `electron binary present but not runnable — reinstalling (${initial.error || "no version reported"})`,
    );
    fs.rmSync(path.join(electronDir, "dist"), { recursive: true, force: true });
  }
  if (!version) {
    // Fall back to the latest stable release compatible with package.json,
    // discovered from the official npm registry.
    log("resolved Electron version unreadable — querying the official npm registry ...");
    version = await latestCompatibleVersion();
  }
  if (!version) {
    console.error("[friday] error    cannot determine a compatible Electron version.");
    console.error("[friday]          see https://www.npmjs.com/package/electron");
    return false;
  }
  // Official methods, tried in order. Each one is verified against the real
  // binary; the actual failure reason of every method is printed.
  const methods = [
    {
      label: "Electron's official npm installer",
      run: async () => runInstaller(),
    },
    {
      label: `official GitHub release archive for v${version}`,
      run: () => downloadResolvedRelease(version),
    },
    {
      label: "official @electron/get downloader",
      run: () => downloadViaElectronGet(version),
    },
  ];
  for (const method of methods) {
    log(`electron binary missing — trying ${method.label} ...`);
    try {
      const done = await method.run();
      if (done && isUsable()) {
        const verified = verifyBinary();
        log(
          `ok       Electron v${verified.version || version} installed and verified via ${method.label}` +
            (verified.runnable ? " (binary executed successfully)" : ""),
        );
        return true;
      }
      console.error(`[friday] method failed: ${method.label} — no usable binary was produced`);
    } catch (error) {
      console.error(
        `[friday] method failed: ${method.label} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.error("[friday] error    electron binary could not be installed by any official method.");
  console.error(`[friday]          expected: ${binaryPath()}`);
  console.error("[friday]          official sources: https://www.npmjs.com/package/electron");
  console.error(
    "[friday]                            https://github.com/electron/electron/releases",
  );
  console.error("[friday]                            https://www.electronjs.org/download");
  return false;
}

module.exports = { ensureElectron, isPresent, isUsable, verifyBinary, binaryPath };

if (require.main === module) {
  ensureElectron()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(`[friday] error    ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
