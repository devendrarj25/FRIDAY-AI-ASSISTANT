/**
 * FRIDAY — Electron binary guard.
 *
 * Electron 42 and later publish no install script. npm ci therefore does not
 * download the binary. This guard runs the official installer (install.js)
 * and then the release archive and @electron/get if that installer does not
 * leave a usable binary.
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
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();
const { recolorStream } = require("./live-console.cjs");
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

/** The range this project accepts, e.g. "^45.2.1". */
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
  // The download shows no bar when its output is piped, so a proof-of-life line says it is still working.
  const cache =
    process.env.ELECTRON_CACHE ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "electron", "Cache") : "");
  const watched = [cache, path.join(electronDir, "dist")].filter(Boolean);
  const r = quiet
    ? spawnSync(process.execPath, [installer], {
        stdio: "ignore",
        cwd: electronDir,
        env: downloadEnv(),
      })
    : require("./with-activity.cjs").withActivityCommand(
        "electron download",
        watched,
        process.execPath,
        [installer],
        { cwd: electronDir, env: downloadEnv() },
      );
  return r.status === 0 && isUsable();
};

const archiveName = (version) =>
  `electron-v${version}-${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.zip`;

/**
 * Download endpoints, in order. Each is a release folder holding the archive and its SHASUMS256.txt:
 *   1. the official GitHub release (https://www.electronjs.org/download),
 *   2. the owner's own ELECTRON_MIRROR, when set,
 *   3. the Electron project's documented public mirror (npmmirror), which is the fast path from regions
 *      where GitHub release downloads are throttled or blocked.
 * The archive is always checked against a published SHA-256 list (the GitHub one first), so a mirror cannot
 * hand over a different file.
 */
const releaseFolders = (version) => {
  const folders = [`https://github.com/electron/electron/releases/download/v${version}`];
  const mirror = process.env.ELECTRON_MIRROR;
  if (mirror) folders.push(`${mirror.replace(/\/$/, "")}/v${version}`);
  folders.push(`https://cdn.npmmirror.com/binaries/electron/v${version}`);
  return [...new Set(folders)];
};

const releaseArchives = (version) =>
  releaseFolders(version).map((folder) => `${folder}/${archiveName(version)}`);

/** The SHA-256 a SHASUMS256.txt ("<hash> *<name>" per line) lists for one file, or null. */
const shasumFor = (text, name) => {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
};

const sha256File = (file) => {
  const hash = require("node:crypto").createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};

/** Published SHA-256 for the archive: GitHub's list first, then the list next to the archive that was fetched. */
const publishedSha256 = async (fetchFn, dispatcher, version, archiveUrl) => {
  const name = archiveName(version);
  const lists = [
    `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`,
    `${archiveUrl.slice(0, archiveUrl.lastIndexOf("/"))}/SHASUMS256.txt`,
  ];
  for (const url of [...new Set(lists)]) {
    try {
      const response = await fetchFn(url, { redirect: "follow", dispatcher });
      if (!response.ok) continue;
      const found = shasumFor(await response.text(), name);
      if (found) return found;
    } catch {
      /* the next list, or no checksum at all: the ZIP check and the run check still apply */
    }
  }
  return null;
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
    const { spawnNpm } = require("./win-spawn.cjs");
    const install = spawnNpm(["install", "--no-save", "--no-audit", "--no-fund", "@electron/get"], {
      stdio: quiet ? "ignore" : "inherit",
      cwd: root,
      env: downloadEnv(),
    });
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
          const expected = await publishedSha256(
            fetch,
            proxy ? new ProxyAgent(proxy) : undefined,
            version,
            url,
          );
          if (expected) {
            const actual = sha256File(archive);
            if (actual !== expected) {
              throw new Error(`SHA-256 mismatch (expected ${expected}, got ${actual})`);
            }
            log(`verified SHA-256 ${expected.slice(0, 12)}... for ${archiveName(version)}`);
          } else {
            log("no published SHA-256 list could be read; ZIP and run checks only");
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
  const lifecycle = (() => {
    try {
      const scripts =
        JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8")).scripts || {};
      return Boolean(scripts.install || scripts.postinstall || scripts.preinstall);
    } catch {
      return false;
    }
  })();
  if (!initial.present && !lifecycle) {
    log(
      `installing Electron v${version} (the package has no install script, so npm ci does not download the binary)`,
    );
  } else if (!initial.present) {
    log("electron install script did not leave a binary — installing it now");
  }
  for (const method of methods) {
    log(`trying ${method.label} ...`);
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

/**
 * The installer tools electron-builder downloads while it packages (NSIS and its plugins, from the
 * electron-builder-binaries releases on GitHub, each pinned by SHA-256 inside electron-builder). Without this the
 * first download happens in the middle of the build, and a dropped connection there fails the whole pack. They are
 * fetched here, with electron-builder's own downloader and cache folder, so setup and Doctor have already fetched
 * and checked them, and the build only reads them. The pins come from the installed electron-builder, so a newer
 * one is followed without editing this file. A mirror set in ELECTRON_BUILDER_BINARIES_MIRROR is honoured.
 * Only a Windows build makes an NSIS installer, so only Windows fetches them (FRIDAY_PREFETCH_BUILDER_TOOLS=1
 * forces it elsewhere).
 */
const builderCacheDir = (env = process.env) =>
  env.ELECTRON_BUILDER_CACHE || path.join(root, ".cache", "electron-builder");

const installerToolsMarker = (env = process.env) =>
  path.join(builderCacheDir(env), ".friday-installer-tools.json");

const installerToolsWanted = (env = process.env, platform = process.platform) =>
  platform === "win32" || String(env.FRIDAY_PREFETCH_BUILDER_TOOLS || "") === "1";

function builderVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", "app-builder-lib", "package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

/** Ready = fetched by this electron-builder version and every recorded folder is still there. */
function installerToolsReady(env = process.env, platform = process.platform) {
  if (!installerToolsWanted(env, platform))
    return { wanted: false, ready: true, reason: "not needed here" };
  try {
    const marker = JSON.parse(fs.readFileSync(installerToolsMarker(env), "utf8"));
    if (marker.builder !== builderVersion()) {
      return { wanted: true, ready: false, reason: "fetched by another electron-builder version" };
    }
    const gone = [marker.nsis, marker.plugins].filter((dir) => !dir || !fs.existsSync(dir));
    if (gone.length) return { wanted: true, ready: false, reason: "a cached folder is missing" };
    return { wanted: true, ready: true, reason: "cached", paths: [marker.nsis, marker.plugins] };
  } catch {
    return { wanted: true, ready: false, reason: "not fetched yet" };
  }
}

/**
 * The second source for the installer tools: the public npmmirror copy of the electron-builder-binaries releases.
 * electron-builder checks every archive against the SHA-256 it pins, so a mirror can only be a different road to
 * the same bytes. Used only after the GitHub tries failed, and never over a mirror the owner set.
 */
const BUILDER_BINARIES_MIRROR = "https://cdn.npmmirror.com/binaries/electron-builder-binaries/";
const BUILDER_MIRROR_VARS = [
  "NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR",
  "npm_config_electron_builder_binaries_mirror",
  "npm_package_config_electron_builder_binaries_mirror",
  "ELECTRON_BUILDER_BINARIES_MIRROR",
];
const builderMirrorOwned = (env = process.env) =>
  BUILDER_MIRROR_VARS.some((name) => Boolean(String(env[name] || "").trim()));

async function ensureInstallerTools({
  env = process.env,
  platform = process.platform,
  loadToolset = () =>
    require(path.join(root, "node_modules", "app-builder-lib", "out", "toolsets", "windows.js")),
  waits = [2000, 5000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!installerToolsWanted(env, platform)) {
    log("skip     installer tools are fetched on Windows only");
    return true;
  }
  if (!fs.existsSync(path.join(root, "node_modules", "app-builder-lib"))) {
    log("skip     electron-builder is not installed in this tree");
    return true;
  }
  if (installerToolsReady(env, platform).ready) {
    log("ok       installer tools (NSIS) already fetched");
    return true;
  }
  env.ELECTRON_BUILDER_CACHE = builderCacheDir(env);
  fs.mkdirSync(env.ELECTRON_BUILDER_CACHE, { recursive: true });
  let lastError = null;
  const fetchTools = async () => {
    const toolset = loadToolset();
    // electron-builder draws its download bars itself, wider than the window; they get the console's bar.
    const restoreBars = recolorStream(process.stdout, env);
    let make;
    let plugins;
    try {
      make = await toolset.getMakeNsisPath(undefined);
      plugins = await toolset.getNsisPluginsPath(undefined);
    } finally {
      restoreBars();
    }
    const nsis = path.dirname(make.path);
    if (!fs.existsSync(make.path) || !fs.existsSync(plugins)) {
      throw new Error(`the download left no makensis at ${make.path}`);
    }
    fs.writeFileSync(
      installerToolsMarker(env),
      JSON.stringify({ builder: builderVersion(), nsis, plugins, at: new Date().toISOString() }),
    );
    log(`ok       installer tools ready at ${nsis}`);
  };
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    try {
      log(
        `fetching installer tools (NSIS) for electron-builder${attempt ? `, try ${attempt + 1}` : ""} ...`,
      );
      await fetchTools();
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < waits.length) await sleep(waits[attempt]);
    }
  }
  // GitHub failed every try: a second source, the npmmirror copy of the same releases (the pinned SHA-256 still
  // decides). A mirror the owner set is theirs and is never replaced.
  if (!builderMirrorOwned(env)) {
    log("second source: cdn.npmmirror.com");
    env.ELECTRON_BUILDER_BINARIES_MIRROR = BUILDER_BINARIES_MIRROR;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          log(
            `fetching installer tools (NSIS) from cdn.npmmirror.com${attempt ? `, try ${attempt + 1}` : ""} ...`,
          );
          await fetchTools();
          return true;
        } catch (error) {
          lastError = error;
          if (attempt < 1) await sleep(waits[0] ?? 0);
        }
      }
    } finally {
      delete env.ELECTRON_BUILDER_BINARIES_MIRROR;
    }
  }
  console.error(
    `[friday] installer tools could not be fetched: ${lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError)}`,
  );
  console.error(
    "[friday]          source: https://github.com/electron-userland/electron-builder-binaries/releases",
  );
  console.error(
    "[friday]          behind a proxy or a firewall: allow github.com and release-assets.githubusercontent.com,",
  );
  console.error(
    "[friday]          or point ELECTRON_BUILDER_BINARIES_MIRROR at a mirror of that release list, then run: npm run setup:electron",
  );
  return false;
}

module.exports = {
  releaseArchives,
  shasumFor,
  sha256File,
  ensureElectron,
  ensureInstallerTools,
  installerToolsReady,
  builderMirrorOwned,
  builderCacheDir,
  isPresent,
  isUsable,
  verifyBinary,
  binaryPath,
};

if (require.main === module) {
  const { leave } = require("./leave.cjs");
  ensureElectron()
    .then(async (ok) => (ok ? ensureInstallerTools() : false))
    .then((ok) => leave(ok ? 0 : 1))
    .catch((error) => {
      console.error(`[friday] error    ${error instanceof Error ? error.message : String(error)}`);
      leave(1);
    });
}
