#!/usr/bin/env node
/**
 * FRIDAY — one Windows build recipe.
 *
 * The CMD pack, FRIDAY Release, and FRIDAY Test Build call this file.
 * They differ only by the options below: channel, version stamp, targets,
 * signing, and whether a later job publishes. The phase order does not.
 *
 *   node scripts/build-pipeline.cjs --channel production
 *   node scripts/build-pipeline.cjs --channel test --version 1.0.1.2-test.1 --targets portable
 *   node scripts/build-pipeline.cjs --plan
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnNpm, spawnDirect } = require("./win-spawn.cjs");
const layout = require("../electron/runtime-layout.cjs");
const stage = require("./stage-toolchain.cjs");
const setupNotices = require("./setup-notices.cjs");

const ROOT = path.resolve(__dirname, "..");

const PHASES = [
  "prepare-environment",
  "verify-versions",
  "stage-toolchain",
  "build-renderer",
  "package",
  "packaged-requires",
  "sign-hook",
  "manifest",
  "verify-artifacts",
  "verify-boot",
  "readiness",
  "packaged-self-check",
  "installer-smoke",
];

/** Command lines in phase order. Callers do not repeat this list. */
const PHASE_COMMANDS = {
  "prepare-environment": [
    "scripts/setup-windows.ps1 -ToolchainOnly",
    "scripts/check-engines.cjs",
    "npm ci --no-audit --no-fund",
    "scripts/ensure-electron.cjs",
    "scripts/setup-python.cjs",
    "scripts/prefetch-toolkit.cjs",
    "scripts/init-runtime.cjs",
    "scripts/check-environment.cjs --fix --summary",
    "scripts/env-registry.cjs repair",
  ],
  // canonical friday-version.json is the single truth
  "verify-versions": [
    "scripts/release-engine.cjs heal",
    "scripts/release-engine.cjs verify",
    "scripts/verify-deps.cjs",
  ],
  "stage-toolchain": ["scripts/stage-toolchain.cjs"],
  "build-renderer": ["npm run build:desktop"],
  package: ["scripts/builtins-manifest.cjs", "scripts/electron-pack.cjs"],
  "packaged-requires": ["scripts/packaged-requires.cjs"],
  "sign-hook": ["scripts/sign-windows.ps1"],
  manifest: ["scripts/release-manifest.cjs"],
  "verify-artifacts": ["scripts/verify-build.cjs", "scripts/builtins-manifest.cjs"],
  "verify-boot": ["scripts/verify-boot.cjs"],
  readiness: ["scripts/readiness-test.cjs --pack"],
  "packaged-self-check": [
    "python.exe get-pip.py",
    "python.exe -m pip --version",
    "python.exe -c import sys",
    "whisper-cli -h",
    "electron/friday-mcp.cjs initialize",
  ],
  "installer-smoke": ["scripts/windows-installer-smoke.ps1"],
};

const GITHUB_ASSET_LIMIT = 2147483648;

/** Node retries EBUSY, EPERM, EMFILE, ENFILE, and ENOTEMPTY. No second remover. */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

function removeTree(target) {
  fs.rmSync(target, REMOVE_OPTIONS);
}

function parseArgs(argv) {
  const options = {
    channel: "production",
    version: "",
    targets: ["nsis", "portable"],
    sign: "auto",
    publish: false,
    from: PHASES[0],
    through: PHASES[PHASES.length - 1],
    report: path.join(ROOT, "release", "build-report.json"),
    planOnly: false,
    offline: false,
    caller: "node",
    ref: "",
    commit: "",
    releaseType: "",
    strict: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--plan") options.planOnly = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--channel") options.channel = String(args[++i] || "");
    else if (arg === "--version") options.version = String(args[++i] || "");
    else if (arg === "--targets") {
      options.targets = String(args[++i] || "")
        .split(/[,\s]+/)
        .filter(Boolean);
    } else if (arg === "--from") options.from = String(args[++i] || "");
    else if (arg === "--through") options.through = String(args[++i] || "");
    else if (arg === "--report") options.report = path.resolve(String(args[++i] || ""));
    else if (arg === "--caller") options.caller = String(args[++i] || "");
    else if (arg === "--sign") options.sign = String(args[++i] || "auto");
    else if (arg === "--ref") options.ref = String(args[++i] || "");
    else if (arg === "--commit") options.commit = String(args[++i] || "");
    else if (arg === "--release-type") options.releaseType = String(args[++i] || "");
    else if (arg === "dir" || arg === "nsis" || arg === "portable") {
      options.targets = [arg];
    } else if (arg === "--dir") options.targets = ["dir"];
    else throw new Error(`unknown build option: ${arg}`);
  }
  if (options.channel !== "production" && options.channel !== "test") {
    throw new Error(`channel must be production or test (got ${options.channel})`);
  }
  if (!options.targets.length) throw new Error("at least one package target is required");
  if (process.env.FRIDAY_OFFLINE === "1") options.offline = true;
  return options;
}

function selectedPhases(options) {
  const start = PHASES.indexOf(options.from);
  const end = PHASES.indexOf(options.through);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`phase range ${options.from}..${options.through} is not in the pipeline`);
  }
  return PHASES.slice(start, end + 1);
}

function commandsFor(phases = PHASES) {
  return phases.flatMap((phase) => PHASE_COMMANDS[phase] || []);
}

function installerBounds(manifest) {
  const plan = stage.stagePlan(manifest);
  const floor = Math.floor(plan.sum * 0.7);
  // The wheelhouse (offline Python wheels) is a second tier beside the toolchain budget.
  const wheelhouseBudget = Number(manifest.wheelhouse?.budgetBytes) || 0;
  const ceiling = Math.min(
    GITHUB_ASSET_LIMIT - 1,
    Number(manifest.budgetBytes) + wheelhouseBudget + 800 * 1024 * 1024,
  );
  return {
    floor,
    ceiling,
    sum: plan.sum,
    budget: Number(manifest.budgetBytes) || 0,
    assetLimit: GITHUB_ASSET_LIMIT,
  };
}

function readManifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, "config", "toolchain-manifest.json"), "utf8"));
}

/**
 * A Setup or Portable file below the toolchain floor means staging did not
 * land. A file at or above the ceiling cannot be a GitHub release asset.
 */
function assertPackagedLayout({
  releaseDir,
  manifest,
  targets = ["nsis", "portable"],
  env = process.env,
  wheels,
}) {
  const plan = stage.stagePlan(manifest);
  const bounds = installerBounds(manifest);
  const errors = [];
  const unpacked = path.join(releaseDir, "win-unpacked");
  for (const pack of plan.packs) {
    const file = path.join(unpacked, "resources", ...layout.packRelative(pack.id).split("/"));
    if (!fs.existsSync(file)) {
      errors.push(
        `${pack.id} is missing at ${file} — toolchain staging did not land inside the app; refusing a small EXE`,
      );
    }
  }
  // The offline Python wheelhouse is part of every build unless FRIDAY_WHEELHOUSE=0 switched it off.
  if (manifest.wheelhouse && String(env.FRIDAY_WHEELHOUSE || "") !== "0") {
    const wheelhouse = require("./wheelhouse.cjs");
    const file = path.join(unpacked, "resources", ...wheelhouse.DEST.split("/"), "pack.bin");
    if (!fs.existsSync(file)) {
      errors.push(
        `the Python wheelhouse is missing at ${file} — wheelhouse staging did not land inside the app (FRIDAY_WHEELHOUSE=0 builds without it)`,
      );
    } else if (Array.isArray(wheels)) {
      for (const problem of wheelhouse.verifyWheelhouseZip(file, wheels)) {
        errors.push(`wheelhouse ${problem}`);
      }
    }
  }
  const names = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [];
  const wantSetup = targets.includes("nsis");
  const wantPortable = targets.includes("portable");
  const setup = names.find(
    (name) => /Setup-.+\.exe$/i.test(name) || /Test-Setup-.+\.exe$/i.test(name),
  );
  const portable = names.find((name) => /Portable-.+\.exe$/i.test(name));
  const check = (label, name) => {
    if (!name) {
      errors.push(`${label} EXE is missing — refusing a small EXE`);
      return;
    }
    const bytes = fs.statSync(path.join(releaseDir, name)).size;
    if (bytes < bounds.floor) {
      errors.push(
        `${label} ${name} is ${bytes} bytes, below the toolchain floor ${bounds.floor} — staging did not produce a full build`,
      );
    }
    if (bytes > bounds.ceiling) {
      errors.push(
        `${label} ${name} is ${bytes} bytes, above the ceiling ${bounds.ceiling} (GitHub asset limit ${bounds.assetLimit})`,
      );
    }
  };
  if (wantSetup) check("Setup", setup);
  if (wantPortable) check("Portable", portable);
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.errors = errors;
    throw error;
  }
  return { ok: true, bounds, setup: setup || null, portable: portable || null };
}

/** The wheels the lock pins, for the content check of the packed wheelhouse; undefined when it is switched off. */
function lockedWheels(root, manifest, env = process.env) {
  if (!manifest.wheelhouse || String(env.FRIDAY_WHEELHOUSE || "") === "0") return undefined;
  const wheelhouse = require("./wheelhouse.cjs");
  const lock = wheelhouse.readLock(path.join(root, manifest.wheelhouse.lock));
  return Array.isArray(lock.wheels) ? lock.wheels : [];
}

/**
 * Writes resources/builtins.json (scripts/builtins-manifest.cjs) from the checkout trees that electron-builder is
 * about to copy, so the installer and the portable EXE carry it. The generator needs electron/capabilities.cjs, which
 * lives inside app.asar once packed, so it runs here and verify-artifacts then proves it against the real pack.
 */
function writeBuiltins({ root = ROOT, outFile, version } = {}) {
  const out = outFile || path.join(root, "resources", "builtins.json");
  return require("./builtins-manifest.cjs").write(
    root,
    out,
    version ? { release: version } : undefined,
  );
}

/** Fails the build when win-unpacked\resources\builtins.json is missing or does not describe the packed trees. */
function assertBuiltins(resourcesDir) {
  const result = require("./builtins-manifest.cjs").verify(
    resourcesDir,
    path.join(resourcesDir, "builtins.json"),
  );
  if (!result.ok) {
    const shown = result.problems.slice(0, 10).join("; ");
    const more = result.problems.length > 10 ? ` (and ${result.problems.length - 10} more)` : "";
    throw new Error(`builtins.json does not match the packed app: ${shown}${more}`);
  }
  return result;
}

function runtimeSmokePlan(manifest = readManifest()) {
  const plan = stage.stagePlan(manifest);
  const byId = Object.fromEntries(plan.packs.map((pack) => [pack.id, pack]));
  return {
    python: {
      id: "python-embed",
      pack: byId["python-embed"]
        ? `resources/${byId["python-embed"].dest}/python-embed/pack.bin`
        : null,
      sha256: byId["python-embed"] ? byId["python-embed"].sha256 : "",
      bytes: byId["python-embed"] ? byId["python-embed"].bytes : 0,
      command: ["python.exe", "-m", "pip", "--version"],
    },
    getPip: byId["get-pip"]
      ? {
          id: "get-pip",
          pack: `resources/${byId["get-pip"].dest}/get-pip/pack.bin`,
          sha256: byId["get-pip"].sha256,
          bytes: byId["get-pip"].bytes,
          command: ["python.exe", "get-pip.py"],
        }
      : null,
    whisper: {
      id: "whisper-cpp",
      pack: byId["whisper-cpp"]
        ? `resources/${byId["whisper-cpp"].dest}/whisper-cpp/pack.bin`
        : null,
      sha256: byId["whisper-cpp"] ? byId["whisper-cpp"].sha256 : "",
      bytes: byId["whisper-cpp"] ? byId["whisper-cpp"].bytes : 0,
      command: ["Release/whisper-cli.exe", "-h"],
    },
    sandbox: {
      command: ["python.exe", "-c", "import sys; print(sys.executable)"],
    },
    mcp: {
      command: ["node", "electron/friday-mcp.cjs"],
      // A live server echoes the handshake. A build machine has no server,
      // and the launcher then reports that FRIDAY is not running.
      expect: "initialize",
      also: "FRIDAY is not running",
    },
    node: byId["node-win"]
      ? {
          id: "node-win",
          pack: `resources/${byId["node-win"].dest}/node-win/pack.bin`,
          sha256: byId["node-win"].sha256,
          bytes: byId["node-win"].bytes,
          command: ["node.exe", "--version"],
        }
      : null,
    model: byId["ggml-base"]
      ? {
          id: "ggml-base",
          pack: `resources/${byId["ggml-base"].dest}/ggml-base/pack.bin`,
          sha256: byId["ggml-base"].sha256,
          bytes: byId["ggml-base"].bytes,
          kind: "header",
          file: "ggml-base.bin",
        }
      : null,
  };
}

function signingStatusLines(env = process.env) {
  const secret = String(
    env.CSC_KEY_PASSWORD || env.FRIDAY_PFX_PASSWORD || env.CERTIFICATE_PASSWORD || "",
  );
  const lines = [
    "[FRIDAY] unsigned build. Set CSC_LINK and CSC_KEY_PASSWORD to a CA-issued PFX to Authenticode-sign.",
    "         Signing a new publisher does not by itself remove SmartScreen warnings.",
  ];
  if (secret && lines.some((line) => line.includes(secret))) {
    throw new Error("signing status leaked a secret");
  }
  return lines;
}

function defaultSelfCheckRunner({ command, cwd, stdin }) {
  const result = spawnDirect(command[0], command.slice(1), {
    cwd,
    input: stdin,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: `${result.stdout || ""}${result.stderr || ""}${result.error ? result.error.message : ""}`,
  };
}

function whisperProbeCommand(whisperDir, fallback) {
  const nested = path.join(whisperDir, "Release", "whisper-cli.exe");
  const flat = path.join(whisperDir, "whisper-cli.exe");
  if (fs.existsSync(flat) && !fs.existsSync(nested)) return ["whisper-cli.exe", "-h"];
  return fallback;
}

function extractZipPack(packFile, dest) {
  try {
    require("../electron/archive-safe.cjs").extractArchiveFile(packFile, dest);
  } catch (error) {
    throw new Error(
      `packaged self-check: could not extract ${path.basename(packFile)} (${error.message})`,
    );
  }
}

function materialisePack(unpackDir, relativePack, dest, extract, expect) {
  if (!relativePack) {
    throw new Error("packaged self-check: pack path is missing from the manifest");
  }
  const packFile = path.join(unpackDir, relativePack);
  if (!fs.existsSync(packFile)) {
    throw new Error(`packaged self-check: missing ${relativePack}`);
  }
  if (expect && expect.sha256) {
    const body = fs.readFileSync(packFile);
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    if (expect.bytes && body.length !== expect.bytes) {
      throw new Error(`packaged self-check: ${relativePack} size does not match the manifest`);
    }
    if (hash !== expect.sha256) {
      throw new Error(`packaged self-check: ${relativePack} hash does not match the manifest`);
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  extract(packFile, dest);
  return dest;
}

/**
 * On Windows, extract the staged Python and whisper packs from the packaged
 * app and run the probes. Any other OS returns an explicit skip. A missing
 * pack or a failing probe throws.
 */
function runPackagedSelfCheck(input = {}) {
  const platform = input.platform || process.platform;
  if (platform !== "win32") {
    return "skipped: packaged self-check runs on Windows only";
  }
  const root = input.root || ROOT;
  const unpackDir = input.unpackDir || path.join(root, "release", "win-unpacked");
  if (!unpackDir || !fs.existsSync(unpackDir)) {
    throw new Error(`packaged self-check: packaged app directory is missing (${unpackDir})`);
  }
  const plan = runtimeSmokePlan(input.manifest || readManifest(root));
  const runner = input.runner || defaultSelfCheckRunner;
  const extract = input.extract || extractZipPack;
  const work = input.workDir || path.join(path.dirname(unpackDir), "self-check");
  fs.mkdirSync(work, { recursive: true });
  const pythonDir = materialisePack(
    unpackDir,
    plan.python.pack,
    path.join(work, "python"),
    extract,
    plan.python,
  );
  if (plan.getPip) {
    // The embeddable zip has no pip. First run copies the pinned script,
    // enables site, then runs it. The same order is the proof here.
    materialisePack(
      unpackDir,
      plan.getPip.pack,
      pythonDir,
      (file, dest) => {
        fs.copyFileSync(file, path.join(dest, "get-pip.py"));
      },
      plan.getPip,
    );
    require("../electron/toolchain-pack.cjs").writeEmbedPth(pythonDir);
  }
  const whisperDir = materialisePack(
    unpackDir,
    plan.whisper.pack,
    path.join(work, "whisper"),
    extract,
    plan.whisper,
  );
  let nodeDir = "";
  if (plan.node) {
    nodeDir = materialisePack(
      unpackDir,
      plan.node.pack,
      path.join(work, "node"),
      extract,
      plan.node,
    );
    require("../electron/bundled-runtime.cjs").flattenSingleRoot(nodeDir);
  }
  let modelDir = "";
  if (plan.model) {
    const copyModel = (file, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(file, path.join(dest, plan.model.file));
    };
    modelDir = materialisePack(
      unpackDir,
      plan.model.pack,
      path.join(work, "model"),
      copyModel,
      plan.model,
    );
  }
  const probes = [];
  if (plan.getPip) {
    probes.push({ name: "get-pip", command: plan.getPip.command, cwd: pythonDir });
  }
  probes.push(
    { name: "python", command: plan.python.command, cwd: pythonDir },
    { name: "sandbox", command: plan.sandbox.command, cwd: pythonDir },
    {
      name: "whisper",
      command: whisperProbeCommand(whisperDir, plan.whisper.command),
      cwd: whisperDir,
    },
    {
      name: "mcp",
      command: plan.mcp.command,
      cwd: root,
      stdin: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      expect: plan.mcp.expect,
      also: plan.mcp.also,
    },
  );
  if (plan.node) probes.push({ name: "node", command: plan.node.command, cwd: nodeDir });
  if (plan.model) {
    probes.push({ name: "model", kind: "header", file: plan.model.file, cwd: modelDir });
  }
  const lines = [];
  for (const probe of probes) {
    if (probe.kind === "header") {
      const file = path.join(probe.cwd, probe.file);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(16);
      let read = 0;
      try {
        read = fs.readSync(fd, buf, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (read < 16 || (buf[0] === 0x50 && buf[1] === 0x4b)) {
        throw new Error(`packaged self-check: ${probe.name} failed (header)`);
      }
      lines.push(`${probe.name} ok`);
      continue;
    }
    const result = runner(probe) || {};
    const status = result.status;
    const stdout = String(result.stdout || "");
    if (status !== 0) {
      const detail = stdout.replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(
        `packaged self-check: ${probe.name} failed (${status === null || status === undefined ? "no exit" : status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const accepted =
      !probe.expect || stdout.includes(probe.expect) || (probe.also && stdout.includes(probe.also));
    if (!accepted) {
      const detail = stdout.replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(
        `packaged self-check: ${probe.name} did not answer ${probe.expect}${detail ? `: ${detail}` : ""}`,
      );
    }
    lines.push(`${probe.name} ok`);
  }
  const sttScript = [
    path.join(unpackDir, "resources", "kernel", "stt.py"),
    path.join(unpackDir, "kernel", "stt.py"),
  ].find((file) => fs.existsSync(file));
  if (!sttScript) {
    lines.push("stt-self-test skipped: kernel script is not in this unpack");
  } else {
    const pythonExe = path.join(pythonDir, "python.exe");
    const speech = runner({
      name: "stt-self-test",
      command: [pythonExe, sttScript, "--self-test"],
      cwd: path.dirname(sttScript),
    });
    const speechOut = String((speech && speech.stdout) || "");
    const speechStatus = speech && speech.status;
    if (speechStatus !== 0 && !/skipped/i.test(speechOut)) {
      // The tail names the cause (an import error, a missing DLL) in the build log.
      const detail = speechOut.replace(/\s+/g, " ").trim().slice(-300);
      throw new Error(
        `packaged self-check: stt-self-test failed (${speechStatus === null || speechStatus === undefined ? "no exit" : speechStatus})${detail ? `: ${detail}` : ""}`,
      );
    }
    lines.push(
      /skipped/i.test(speechOut)
        ? `stt-self-test skipped${skipReason(speechOut)}`
        : "stt-self-test ok",
    );
  }
  return lines.join("; ");
}

/**
 * `npm ci` downloads the Electron zip into the default shared cache; the build then looks in
 * `.cache/electron` and would fetch the same ~100 MB again. Copy the matching zip folder across once.
 */
function seedElectronCache(target, source = defaultElectronCache()) {
  const copied = [];
  try {
    if (!source || !fs.existsSync(source) || path.resolve(source) === path.resolve(target))
      return copied;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = path.join(source, entry.name);
      const zips = fs.readdirSync(from).filter((f) => /^electron-v[\d.]+-.*\.zip$/.test(f));
      for (const zip of zips) {
        const to = path.join(target, entry.name, zip);
        if (fs.existsSync(to)) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(from, zip), to);
        copied.push(zip);
      }
    }
  } catch {
    // A cache that cannot be read only means the build downloads once, as before.
  }
  return copied;
}

/**
 * Why the speech self-test skipped, from its JSON answer (` (faster-whisper is not installed)`), so the build table
 * names the cause instead of a bare "skipped". "" when the answer has no reason.
 */
function skipReason(stdout) {
  for (const line of String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .reverse()) {
    try {
      const reason = String(JSON.parse(line).reason || "")
        .replace(/\s+/g, " ")
        .trim();
      return reason ? ` (${reason.length > 90 ? `${reason.slice(0, 87)}...` : reason})` : "";
    } catch {
      /* not the JSON line */
    }
  }
  return "";
}

/**
 * electron-builder 26 hands the Electron zip to @electron/get with no cache folder, so it reads the default shared
 * cache (where `npm run setup` put the zip). A cache hit is still checked against `SHASUMS256.txt`, which
 * @electron/get fetches from GitHub on every build unless `SHASUMS256.txt-<version>` sits at that cache root (the
 * `downloaded label=electron progress=100%` line of a build that should download nothing). Those checksums are the
 * ones the Electron npm package ships (`node_modules/electron/checksums.json`, locked by package-lock.json), so
 * they are written there once and the check runs offline. Returns the file written, or "" when nothing changed.
 */
function seedElectronChecksums(
  cacheRoot = defaultElectronCache(),
  electronDir = path.join(ROOT, "node_modules", "electron"),
) {
  try {
    if (!cacheRoot) return "";
    const version = JSON.parse(
      fs.readFileSync(path.join(electronDir, "package.json"), "utf8"),
    ).version;
    const sums = JSON.parse(fs.readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
    const rows = Object.entries(sums)
      .filter(
        ([name, sha]) => /^[a-f0-9]{64}$/i.test(String(sha)) && name.includes(`-v${version}-`),
      )
      .map(([name, sha]) => `${String(sha).toLowerCase()} *${name}`);
    if (!version || rows.length === 0) return "";
    const file = path.join(cacheRoot, `SHASUMS256.txt-${version}`);
    const text = `${rows.join("\n")}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return "";
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  } catch {
    // Without the seed the build only fetches the small checksum list, as before.
    return "";
  }
}

function defaultElectronCache() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "electron", "Cache") : "";
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(require("node:os").homedir(), ".cache"),
    "electron",
  );
}

function applyBuildCache(root = ROOT) {
  const cache = path.join(root, ".cache");
  if (!process.env.ELECTRON_BUILDER_CACHE) {
    process.env.ELECTRON_BUILDER_CACHE = path.join(cache, "electron-builder");
  }
  if (!process.env.ELECTRON_CACHE) process.env.ELECTRON_CACHE = path.join(cache, "electron");
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  fs.mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true });
  fs.mkdirSync(process.env.ELECTRON_CACHE, { recursive: true });
  seedElectronCache(process.env.ELECTRON_CACHE);
  seedElectronChecksums();
  for (const dir of [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "winCodeSign")
      : "",
    path.join(process.env.ELECTRON_BUILDER_CACHE, "winCodeSign"),
  ].filter(Boolean)) {
    removeTree(dir);
  }
}

/**
 * The install-and-chat check (start the packaged app in a throwaway folder, talk to a model, speak, restart it) is
 * for PR Validation and the release. A build on the owner's own PC ends once the installer and portable EXE are
 * built, verified and boot: installing and chatting is the owner's next step. `FRIDAY_BUILD_READINESS=1` (or
 * `npm run readiness`) runs it anyway.
 */
function readinessSkip(options, env = process.env) {
  const local = options && (options.caller === "cmd" || options.caller === "npm");
  if (!local || String(env.FRIDAY_BUILD_READINESS ?? "").trim() === "1") return "";
  return "skipped: a local build stops at a verified, bootable installer (npm run verify:install, or FRIDAY_BUILD_READINESS=1, runs the install-and-chat check)";
}

/**
 * The installer lifecycle (install, run, update, uninstall) installs FRIDAY on the PC that runs it, and restores
 * the per-user pointer files and registry key it touched. That belongs to PR Validation's clean runners. A build on
 * the owner's own PC builds the installer and leaves installing it to the owner. `FRIDAY_BUILD_INSTALLER_SMOKE=1`
 * runs it anyway.
 */
function installerSmokeSkip(options, env = process.env) {
  const local = options && (options.caller === "cmd" || options.caller === "npm");
  if (!local || String(env.FRIDAY_BUILD_INSTALLER_SMOKE ?? "").trim() === "1") return "";
  return "skipped: a local build does not install FRIDAY on this PC; run the installer yourself (FRIDAY_BUILD_INSTALLER_SMOKE=1 runs the install-and-uninstall check on demand)";
}

// Each node script of the pipeline can run for minutes without printing (electron-builder compressing the
// installer, the boot and readiness checks). A "still working" line every few seconds shows it is alive; the
// pack also reports how much of the installer exists so far.
const ACTIVITY_WATCH = { "scripts/electron-pack.cjs": ["release"] };

// Scripts that draw their own progress (download boards and bars, a live line of their own steps) run as they are:
// a second line over their output would only fight with it.
const SELF_DISPLAY = new Set([
  "scripts/setup-python.cjs",
  "scripts/prefetch-toolkit.cjs",
  "scripts/prefetch-models.cjs",
  "scripts/stage-toolchain.cjs",
]);
const STEP_LABEL = {
  "scripts/electron-pack.cjs": "packing the installer and portable EXE",
  "scripts/verify-build.cjs": "verifying the build",
  "scripts/verify-boot.cjs": "booting the packaged app",
  "scripts/ensure-electron.cjs": "Electron",
  "scripts/check-environment.cjs": "checking the environment",
  "scripts/packaged-requires.cjs": "checking the packaged files",
  "scripts/release-manifest.cjs": "writing the update manifest",
  "scripts/env-registry.cjs": "recording the environment",
  // The same script runs twice in a row; two lines that both said "release-engine" read like a repeat.
  "scripts/release-engine.cjs heal": "checking the version files",
  "scripts/release-engine.cjs verify": "verifying the version",
};

/**
 * The scripts whose failure is a NOTICE, not a stop: the agent tools are extras, the build does not need them. A script
 * here that exits non-zero is recorded (scripts/setup-notices.cjs) and the build goes on; every other script is a
 * blocker (check-engines, npm ci, the Electron binary, the Python environment, init-runtime, the environment check,
 * the packing steps) and a non-zero exit stops the build with its reason. FRIDAY_SETUP_STRICT=1 makes every notice a stop.
 */
const NOTICE_TIER = Object.freeze({
  "scripts/prefetch-toolkit.cjs": Object.freeze({
    id: "agent-toolkit",
    kind: "tool",
    label: "Agent toolkit",
  }),
});

function runNode(script, args, root, deps = {}) {
  const { withActivityCommand } = require("./with-activity.cjs");
  const watched = (ACTIVITY_WATCH[script] || []).map((dir) => path.join(root, dir));
  const target = [path.join(root, script), ...args];
  const result = deps.run
    ? deps.run(process.execPath, target, { cwd: root })
    : SELF_DISPLAY.has(script)
      ? spawnDirect(process.execPath, target, { cwd: root, stdio: "inherit" })
      : withActivityCommand(
          STEP_LABEL[`${script} ${args[0] || ""}`] ||
            STEP_LABEL[script] ||
            path.basename(script, ".cjs"),
          watched,
          process.execPath,
          target,
          { cwd: root },
        );
  if (result.status === 0) return { notice: false };
  const notice = NOTICE_TIER[script];
  if (notice && !setupNotices.isStrict(deps.env || process.env)) {
    setupNotices.recordNotice(
      {
        ...notice,
        reason: `${script} ended with exit ${result.status === null ? "no exit" : result.status}`,
        repair: "npm run doctor",
      },
      { root: deps.noticeRoot, log: deps.log || console.log },
    );
    return { notice: true };
  }
  throw new Error(`${script} failed (${result.status === null ? "no exit" : result.status})`);
}

/**
 * `npm ci` wipes node_modules and installs them again, which `npm run setup`
 * has just done. node_modules is current when npm's own hidden lockfile is
 * newer than package.json and package-lock.json and the Electron binary is in
 * place (npm ci does not download it, ensure-electron does); anything else (a pull, an edit, a missing piece) installs again.
 * FRIDAY_FORCE_NPM_CI=1 always installs.
 */
/**
 * The scripts the build runs from node_modules: vite's own script (`build:desktop` starts it with node) and
 * electron-builder's cli.js (electron-pack starts it with node). Neither needs a command link in node_modules\\.bin,
 * which an npm 12 install on Windows did not make runnable by cmd.exe ("'vite' is not recognized"). A folder
 * without these files is not current, so the build and Doctor run `npm ci`.
 */
const BUILD_TOOLS = {
  vite: path.join("vite", "bin", "vite.js"),
  "electron-builder": path.join("electron-builder", "cli.js"),
};
function missingBuildTools(root) {
  return Object.entries(BUILD_TOOLS)
    .filter(([, file]) => !fs.existsSync(path.join(root, "node_modules", file)))
    .map(([name]) => name);
}

function nodeModulesCurrent(root, env = process.env) {
  if (String(env.FRIDAY_FORCE_NPM_CI || "") === "1") return false;
  try {
    const modules = path.join(root, "node_modules");
    const installed = fs.statSync(path.join(modules, ".package-lock.json")).mtimeMs;
    const wanted = Math.max(
      fs.statSync(path.join(root, "package.json")).mtimeMs,
      fs.statSync(path.join(root, "package-lock.json")).mtimeMs,
    );
    const electron = path.join(modules, "electron");
    const binary = process.platform === "win32" ? "electron.exe" : "electron";
    const present =
      fs.existsSync(path.join(electron, "path.txt")) ||
      fs.existsSync(path.join(electron, "dist", binary));
    return installed >= wanted && present && missingBuildTools(root).length === 0;
  } catch {
    return false;
  }
}

function npmCi(root, force = false) {
  if (!force && nodeModulesCurrent(root)) {
    console.log("[FRIDAY] node_modules already matches package-lock.json; npm ci skipped");
    return;
  }
  const args = ["ci", "--no-audit", "--no-fund"];
  const { withActivityCommand } = require("./with-activity.cjs");
  const modules = [path.join(root, "node_modules")];
  const once = withActivityCommand("npm ci", modules, "npm", args, { cwd: root });
  if (once.status === 0) return;
  console.error("[FRIDAY] npm ci failed — npm cache verify, then retry against registry.npmjs.org");
  spawnNpm(["cache", "verify"], { cwd: root, stdio: "inherit" });
  const again = withActivityCommand(
    "npm ci",
    modules,
    "npm",
    [...args, "--registry", "https://registry.npmjs.org/"],
    { cwd: root },
  );
  if (again.status !== 0) throw new Error("npm ci failed after a registry retry");
}

function cleanOutputs(root) {
  removeTree(path.join(root, "release"));
  removeTree(path.join(root, "dist-desktop"));
}

function applyChannel(root, options) {
  const file = path.join(root, "resources", "build-channel.json");
  if (options.channel === "production") {
    removeTree(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        channel: "test",
        ref: options.ref || "",
        commit: options.commit || "",
        runId: process.env.GITHUB_RUN_ID || "",
        builtAt: "pipeline",
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Who is building, as the update manifest and friday-bundle.json record it. A hosted workflow (GITHUB_ACTIONS) is
 * `test` on the test channel and `release` otherwise; every local run (the CMD build, an npm script, a plain node call)
 * is `cmd`, so a local `--channel test` run is not labelled as a hosted one.
 */
function manifestCaller(options, env = process.env) {
  if (String(env.GITHUB_ACTIONS || "") !== "true") return "cmd";
  return options.channel === "test" ? "test" : "release";
}

/** The arguments of scripts/release-manifest.cjs for this run. */
function manifestArgs(options, { version, notes = false, env = process.env } = {}) {
  const args = [
    "--version",
    version,
    "--channel",
    options.channel === "test" ? "test" : "stable",
    "--caller",
    manifestCaller(options, env),
  ];
  if (notes) args.push("--notes", "release-notes.md");
  if (options.releaseType) args.push("--type", options.releaseType);
  return args;
}

function signingRequested(options) {
  if (options.sign === "off" || options.sign === "false") return false;
  return Boolean(process.env.CSC_LINK || process.env.FRIDAY_PFX);
}

function runPhase(phase, options, root) {
  if (phase === "prepare-environment") {
    applyBuildCache(root);
    // A step the build cannot run without (the toolchain, Node.js and npm, npm ci, the Electron binary, the Python
    // environment, the runtime folders, the build tools) stops the build with the reason. What can wait (the agent
    // tools, a model, a voice package, a Tesseract language) is a NOTICE: recorded, listed at the end of the build,
    // finished later in FRIDAY > Install Manager / Models. The toolchain comes first: Git, PowerShell, FFmpeg,
    // Tesseract and the Visual C++ runtime are checked (and installed from the official source when missing) before
    // npm ci, so a PC that has Node.js but not the rest is not discovered late.
    const stale = require("./explicit-python.cjs").dropStalePython(process.env);
    if (stale)
      console.log(
        `[friday] FRIDAY_PYTHON pointed at ${stale}, which is gone; using the Python setup created.`,
      );
    // A Node.js / npm update left by the last `npm run setup` finishes before anything starts.
    require("./running-tools-upgrade.cjs").waitForPending();
    ensureToolchain(root);
    runNode("scripts/check-engines.cjs", [], root);
    npmCi(root);
    runNode("scripts/ensure-electron.cjs", ["--quiet"], root);
    runNode("scripts/setup-python.cjs", [], root);
    // The agent tools (search, Git, build tools, Docker, Sandbox, CUDA): a tool that cannot be installed is a NOTICE.
    runNode("scripts/prefetch-toolkit.cjs", ["--no-update"], root);
    runNode("scripts/init-runtime.cjs", [], root);
    runNode("scripts/check-environment.cjs", ["--fix", "--summary"], root);
    runNode("scripts/env-registry.cjs", ["repair"], root);
    return "environment ready";
  }
  if (phase === "verify-versions") {
    runNode("scripts/release-engine.cjs", ["heal"], root);
    runNode("scripts/release-engine.cjs", ["verify"], root);
    runNode("scripts/verify-deps.cjs", [], root);
    return "version verified";
  }
  if (phase === "stage-toolchain") {
    if (options.version) {
      runNode("scripts/release-engine.cjs", ["stamp", "--version", options.version], root);
    }
    if (process.env.FRIDAY_SKIP_TOOLCHAIN_STAGE === "1") {
      throw new Error(
        "toolchain staging was skipped — refusing to build a small EXE. Unset FRIDAY_SKIP_TOOLCHAIN_STAGE.",
      );
    }
    const offline = options.offline === true || process.env.FRIDAY_OFFLINE === "1";
    return stage
      .beforePack({ offline })
      .then((result) => {
        if (!result || result.skipped) {
          throw new Error("toolchain staging produced nothing — refusing a small EXE");
        }
        const stamped = options.version ? `stamped ${options.version}; ` : "";
        return `${stamped}staged ${result.staged.length} packs (${result.sum} bytes)`;
      })
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        throw new Error(
          `toolchain staging failed (${message}). No network, or a SHA-256 mismatch, stops the build before a small EXE is written.`,
        );
      });
  }
  if (phase === "build-renderer") {
    cleanOutputs(root);
    // Heal first: a node_modules without the build scripts gets a real install instead of a "not recognized" stop.
    const missing = missingBuildTools(root);
    if (missing.length) {
      console.log(
        `[FRIDAY] build tools missing from node_modules (${missing.join(", ")}); installing the dependencies again`,
      );
      npmCi(root, true);
      const still = missingBuildTools(root);
      if (still.length)
        throw new Error(`build tools are still missing after npm ci: ${still.join(", ")}`);
    }
    // On a real console the bundle builds under the live line: no list of 170 files, one moving line while it works
    // and one summary at the end. A log (CI, a file) keeps vite's own report.
    const winSpawn = require("./win-spawn.cjs");
    const plan = winSpawn.viteBuildPlan(root);
    const built = require("./with-activity.cjs").liveWanted()
      ? require("./with-activity.cjs").withActivityCommand(
          "building the interface",
          [path.join(root, "dist-desktop")],
          plan.file,
          [...plan.args, "--logLevel", "warn"],
          { cwd: root },
        )
      : winSpawn.spawnViteBuild(root);
    if (built.status !== 0) throw new Error("renderer bundle failed");
    if (!fs.existsSync(path.join(root, "dist-desktop", "index.html"))) {
      throw new Error("renderer bundle missing — build failed");
    }
    return "renderer built";
  }
  if (phase === "package") {
    applyChannel(root, options);
    const packArgs = ["--win"];
    if (options.targets.includes("dir") && options.targets.length === 1) packArgs.push("--dir");
    else packArgs.push(...options.targets.filter((target) => target !== "dir"));
    if (options.channel === "test") {
      packArgs.push(
        "-c.appId=dev.friday.desk.test",
        "-c.productName=FRIDAY Test",
        "-c.win.executableName=FRIDAY",
        "-c.nsis.shortcutName=FRIDAY Test",
        "-c.nsis.menuCategory=FRIDAY Test",
        "-c.nsis.uninstallDisplayName=FRIDAY Test - Personal AI Assistant",
      );
    }
    const written = writeBuiltins({ root, version: options.version });
    const builtinCount = Object.values(written.trees).reduce((sum, list) => sum + list.length, 0);
    runNode("scripts/electron-pack.cjs", packArgs, root);
    return `packaged ${packArgs.join(" ")}; builtins.json lists ${builtinCount} built-ins`;
  }
  if (phase === "packaged-requires") {
    runNode("scripts/packaged-requires.cjs", [], root);
    return "packaged requires resolved";
  }
  if (phase === "sign-hook") {
    if (!signingRequested(options)) {
      for (const line of signingStatusLines()) console.log(line);
      return "unsigned";
    }
    const pfx = process.env.CSC_LINK || process.env.FRIDAY_PFX;
    if (!fs.existsSync(pfx))
      throw new Error("signing certificate path is set but the PFX file is missing");
    const signArgs = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "sign-windows.ps1"),
      "-PfxPath",
      pfx,
      "-PfxPassword",
      process.env.CSC_KEY_PASSWORD || process.env.FRIDAY_PFX_PASSWORD || "",
      "-TargetDir",
      path.join(root, "release"),
    ];
    if (process.env.EXPECTED_PUBLISHER) {
      signArgs.push("-ExpectedPublisher", process.env.EXPECTED_PUBLISHER);
    }
    const result = spawnDirect("powershell", signArgs, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) throw new Error("Authenticode signing failed");
    return "signed";
  }
  if (phase === "manifest") {
    if (options.targets.length === 1 && options.targets[0] === "dir") {
      return "skipped: unpacked dir has no installer manifest";
    }
    const engine = require("./release-engine.cjs");
    const identity = engine.readCanonicalIdentity({ root });
    const version = options.version || identity.releaseVersion;
    const args = manifestArgs(options, {
      version,
      notes: fs.existsSync(path.join(root, "release-notes.md")),
    });
    runNode("scripts/release-manifest.cjs", args, root);
    return options.channel === "test"
      ? "test checksums written; stable channel files are this run's test manifest only"
      : "update manifest written";
  }
  if (phase === "verify-artifacts") {
    const mode = options.targets.includes("dir")
      ? "dir"
      : options.targets.includes("nsis") && options.targets.includes("portable")
        ? "all"
        : options.targets[0];
    const verifyArgs = [mode, "--skip-packaged-requires"];
    if (options.channel === "production" && mode !== "dir") {
      const engine = require("./release-engine.cjs");
      const identity = engine.readCanonicalIdentity({ root });
      verifyArgs.push("--version", options.version || identity.releaseVersion, "--manifest");
    }
    runNode("scripts/verify-build.cjs", verifyArgs, root);
    assertBuiltins(path.join(root, "release", "win-unpacked", "resources"));
    if (!options.targets.includes("dir") || options.targets.length > 1) {
      const manifest = readManifest(root);
      assertPackagedLayout({
        releaseDir: path.join(root, "release"),
        manifest,
        targets: options.targets,
        wheels: lockedWheels(root, manifest),
      });
    }
    return "artifacts verified";
  }
  if (phase === "verify-boot") {
    runNode("scripts/verify-boot.cjs", [], root);
    return "boot verified";
  }
  if (phase === "readiness") {
    const skip = readinessSkip(options);
    if (skip) return skip;
    runNode("scripts/readiness-test.cjs", ["--pack"], root);
    return "readiness passed";
  }
  if (phase === "packaged-self-check") {
    const detail = runPackagedSelfCheck({
      platform: options.platform,
      unpackDir: options.unpackDir,
      root,
      runner: options.runner,
      extract: options.extract,
      manifest: options.manifest,
      workDir: options.workDir,
    });
    // The check unpacks Python, whisper and Node (hundreds of MB, plus the pip it installed) beside the installer.
    // On the owner's PC that folder is not an output, so it is removed once the check has passed.
    if ((options.caller === "cmd" || options.caller === "npm") && !options.workDir) {
      try {
        removeTree(path.join(root, "release", "self-check"));
      } catch {
        /* a folder that stays only costs disk; the next build clears release\ */
      }
    }
    return detail;
  }
  if (phase === "installer-smoke") {
    if (process.platform !== "win32" || !options.targets.includes("nsis")) {
      return "skipped: installer smoke runs on Windows when an NSIS target was packaged";
    }
    const skip = installerSmokeSkip(options);
    if (skip) return skip;
    const releaseDir = path.join(root, "release");
    const setup = fs.readdirSync(releaseDir).find((name) => /Setup-.+\.exe$/i.test(name));
    if (!setup) throw new Error("installer smoke found no Setup EXE");
    const product = options.channel === "test" ? "FRIDAY Test" : "FRIDAY";
    const result = spawnDirect(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "windows-installer-smoke.ps1"),
        "-Installer",
        path.join(releaseDir, setup),
        "-Product",
        product,
        "-ReleaseDir",
        releaseDir,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("installer lifecycle smoke failed");
    return "installer smoke passed";
  }
  throw new Error(`unknown phase ${phase}`);
}

/**
 * The PC-level toolchain, checked and installed before anything else on Windows:
 * scripts/setup-windows.ps1 -ToolchainOnly reuses every tool that meets its floor and
 * installs the latest stable release of a missing or older one from the official
 * source. Not run on hosted CI (the runner image owns its toolchain). A tool that
 * cannot be installed throws, with the reason printed above.
 */
function ensureToolchain(root, env = process.env, platform = process.platform, deps = {}) {
  if (platform !== "win32") return "skipped: toolchain setup runs on Windows only";
  if (env.CI || env.GITHUB_ACTIONS) return "skipped: hosted CI keeps its own toolchain";
  const run = deps.run || spawnDirect;
  const result = run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "setup-windows.ps1"),
      "-ToolchainOnly",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (!result || result.status !== 0) {
    throw new Error(
      "the Windows toolchain is not complete (scripts\\setup-windows.ps1 -ToolchainOnly failed, see above). Fix it, then run npm run doctor",
    );
  }
  // A tool installed just now is not on this process's PATH yet; read the new PATH once.
  const read = deps.readPath || readWindowsPath;
  const fresh = read();
  if (fresh) {
    // One key, each folder once: appending the whole registry PATH again doubled it and left a second spelling of the key.
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
    env[key] = require("./win-path.cjs").mergePaths(env[key], fresh);
  }
  return "toolchain ready";
}

function readWindowsPath() {
  const out = spawnDirect(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return outputText(out);
}

function outputText(out) {
  return out && out.status === 0 ? String(out.stdout || "").trim() : "";
}

/**
 * With --strict (PR Validation) a phase that reports "skipped:" is a failure.
 * On the Windows runner nothing may be skipped, so a silently skipped smoke or
 * self-check can never turn into a green check.
 */
function assertNotSkipped(phase, detail, options) {
  if (options && options.strict && String(detail).startsWith("skipped:")) {
    throw new Error(`${phase} was skipped, and --strict does not allow that: ${detail}`);
  }
}

async function runPipeline(options, root = ROOT) {
  const phases = selectedPhases(options);
  const report = {
    ok: false,
    channel: options.channel,
    version: options.version || null,
    targets: options.targets,
    publish: options.publish,
    sign: signingRequested(options) ? "requested" : "unsigned",
    caller: options.caller,
    phases: [],
    notices: [],
  };
  const openNotices = () => {
    try {
      return Array.isArray(options.notices) ? options.notices : setupNotices.readNotices();
    } catch {
      return [];
    }
  };
  for (const [index, phase] of phases.entries()) {
    const started = Date.now();
    // The head of every phase, so a long build reads as numbered steps: `build 4/13: build-renderer`.
    console.log(`[friday] build ${index + 1}/${phases.length}: ${phase}`);
    try {
      const detail = await runPhase(phase, options, root);
      const text = String(detail);
      assertNotSkipped(phase, text, options);
      report.phases.push({
        name: phase,
        status: text.startsWith("skipped:") ? "skipped" : "ok",
        ms: Date.now() - started,
        detail: text,
      });
      console.log(`[FRIDAY] ${phase}: ${detail}`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      report.phases.push({
        name: phase,
        status: "failed",
        ms: Date.now() - started,
        detail: message,
      });
      report.ok = false;
      report.notices = openNotices();
      fs.mkdirSync(path.dirname(options.report), { recursive: true });
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
      console.error(`[FRIDAY] ${phase} failed: ${message}`);
      return report;
    }
  }
  report.ok = true;
  report.notices = openNotices();
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * The last thing a local build prints: what was checked, what was produced and how to
 * use it. READY only when the whole recipe ran and nothing failed. Pure, so a test reads it.
 */
function readySummary(options, report, root = ROOT, fsImpl = fs) {
  const lines = [];
  const phases = Array.isArray(report?.phases) ? report.phases : [];
  const whole = options.from === PHASES[0] && options.through === PHASES[PHASES.length - 1];
  const rule = "=".repeat(78);
  lines.push(rule);
  const skipped = phases.some((phase) => phase.status === "skipped");
  if (report?.ok && whole) {
    lines.push(
      skipped
        ? "FRIDAY BUILD READY - every check that applies passed (skipped steps are listed)"
        : "FRIDAY BUILD READY - every check passed and the build is ready to use",
    );
  } else if (report?.ok) {
    lines.push(`FRIDAY BUILD PARTIAL - phases ${options.from} .. ${options.through} passed`);
  } else {
    lines.push("FRIDAY BUILD FAILED - see the first error above");
  }
  lines.push(rule);
  for (const phase of phases) {
    const mark = phase.status === "ok" ? "PASS " : phase.status === "skipped" ? "SKIP " : "FAIL ";
    // The whole first line of the detail, wrapped under the first column: a skip reason such as "a local build
    // stops at a verified, bootable installer (npm run verify:install ...)" used to be cut mid-sentence.
    const detail = String(phase.detail || "")
      .split(/\r?\n/)[0]
      .slice(0, 400);
    const wrapped = [];
    for (let rest = detail; rest.length;) {
      let cut = rest.length <= 52 ? rest.length : rest.lastIndexOf(" ", 52);
      if (cut <= 0) cut = Math.min(52, rest.length);
      wrapped.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    lines.push(`${mark}${String(phase.name).padEnd(22)} ${wrapped[0] || ""}`);
    for (const more of wrapped.slice(1)) lines.push(`${" ".repeat(28)}${more}`);
  }
  // What could not be finished here: the same row shape (7 + 20 + 1 columns), never a failure of the build.
  const notices = Array.isArray(report?.notices) ? report.notices : [];
  for (const entry of notices) {
    const text = String(entry?.reason || "")
      .split(/\r?\n/)[0]
      .slice(0, 400);
    lines.push(
      `NOTICE ${String(entry?.label || entry?.id || "")
        .slice(0, 20)
        .padEnd(20)} ${text}`,
    );
  }
  if (notices.length) {
    lines.push(
      `${" ".repeat(28)}${notices.length} item(s) can be finished later in ${setupNotices.WHERE}.`,
    );
  }
  if (report?.ok) {
    const release = path.join(root, "release");
    const found = [];
    try {
      for (const name of fsImpl.readdirSync(release)) {
        if (/^FRIDAY(?: Test)?-(?:Setup|Portable)-.+\.exe$/i.test(name)) found.push(name);
      }
    } catch {
      /* no release folder: nothing was packaged by this run */
    }
    const unpacked = path.join(release, "win-unpacked", "FRIDAY.exe");
    lines.push("");
    for (const name of found) {
      let size = "";
      try {
        size = ` (${(fsImpl.statSync(path.join(release, name)).size / 1048576).toFixed(0)} MB)`;
      } catch {
        size = "";
      }
      lines.push(`  ${path.join("release", name)}${size}`);
    }
    if (fsImpl.existsSync(unpacked))
      lines.push(`  ${path.join("release", "win-unpacked", "FRIDAY.exe")}`);
    if (found.some((name) => /Setup/i.test(name))) {
      lines.push("");
      lines.push("  Install : run the Setup EXE above (Next, choose a folder, Install).");
      lines.push("  Portable: run the Portable EXE; no install needed.");
    }
    if (report.phases?.some((phase) => phase.name === "readiness" && phase.status === "skipped")) {
      lines.push(
        "  Check   : npm run verify:install runs this build once and chats with it (optional).",
      );
    }
    lines.push("  Repair  : npm run doctor checks and fixes this PC at any time.");
  } else {
    lines.push("");
    lines.push("  After fixing the cause: npm run doctor, then npm run build:win");
  }
  lines.push(rule);
  return lines;
}

/**
 * The `placed` row of the FRIDAY BUILD READY table: after a whole green run, the CMD build copies its outputs to
 * `<FRIDAY folder>/installer/installers/<version>/` (scripts/place-build.cjs). It is not a phase: `build N/13`
 * counts PHASES only, and the row is added to the printed table after the report file was written. Null when the run
 * was partial or failed; a SKIP row for another caller, CI and FRIDAY_PLACE_BUILD=0. Never throws.
 */
function placedRow(options, report, root = ROOT, deps = {}) {
  const whole = options.from === PHASES[0] && options.through === PHASES[PHASES.length - 1];
  if (!report?.ok || !whole) return null;
  const lib = require("./place-build.cjs");
  const env = deps.env || process.env;
  try {
    const skip = lib.skipReason({ caller: options.caller, env });
    if (skip) return lib.rowFor({ status: "skipped", reason: skip });
    const home =
      deps.home || require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root;
    const place = deps.place || lib.placeBuild;
    return lib.rowFor(
      place({
        root: home,
        releaseDir: path.join(root, "release"),
        caller: options.caller,
        env,
        log: (line) => console.log(line),
      }),
    );
  } catch (error) {
    return lib.rowFor({ status: "failed", reason: error && error.message ? error.message : error });
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.planOnly) {
    console.log(
      JSON.stringify(
        { phases: selectedPhases(options), commands: commandsFor(selectedPhases(options)) },
        null,
        2,
      ),
    );
    return;
  }
  const report = await runPipeline(options);
  if (options.caller === "cmd" || options.caller === "npm") {
    const placed = placedRow(options, report);
    if (placed) report.phases.push(placed);
    for (const line of readySummary(options, report)) console.log(line);
  }
  if (!report.ok) require("./leave.cjs").leave(1);
}

module.exports = {
  readinessSkip,
  installerSmokeSkip,
  seedElectronCache,
  seedElectronChecksums,
  skipReason,
  PHASES,
  PHASE_COMMANDS,
  GITHUB_ASSET_LIMIT,
  parseArgs,
  assertNotSkipped,
  ensureToolchain,
  readySummary,
  runNode,
  NOTICE_TIER,
  placedRow,
  selectedPhases,
  commandsFor,
  installerBounds,
  assertPackagedLayout,
  writeBuiltins,
  assertBuiltins,
  runtimeSmokePlan,
  applyChannel,
  signingRequested,
  manifestCaller,
  manifestArgs,
  signingStatusLines,
  runPackagedSelfCheck,
  runPipeline,
  nodeModulesCurrent,
  missingBuildTools,
  npmCi,
  REMOVE_OPTIONS,
  removeTree,
};

// Colour that means something on a real console; plain text everywhere else.
require("./live-console.cjs").installColorConsole();
if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    require("./leave.cjs").leave(1);
  });
}
