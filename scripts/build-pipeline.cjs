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
const fs = require("node:fs");
const path = require("node:path");
const { spawnNpm, spawnDirect, localTar } = require("./win-spawn.cjs");
const stage = require("./stage-toolchain.cjs");

const ROOT = path.resolve(__dirname, "..");

const PHASES = [
  "prepare-environment",
  "verify-versions",
  "stage-toolchain",
  "build-renderer",
  "package",
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
    "scripts/check-engines.cjs",
    "npm ci --no-audit --no-fund",
    "scripts/ensure-electron.cjs",
    "scripts/setup-python.cjs",
    "scripts/init-runtime.cjs",
    "scripts/check-environment.cjs --fix",
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
  package: ["scripts/electron-pack.cjs"],
  "sign-hook": ["scripts/sign-windows.ps1"],
  manifest: ["scripts/release-manifest.cjs"],
  "verify-artifacts": ["scripts/verify-build.cjs"],
  "verify-boot": ["scripts/verify-boot.cjs"],
  readiness: ["scripts/readiness-test.cjs --pack"],
  "packaged-self-check": [
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
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--plan") options.planOnly = true;
    else if (arg === "--offline") options.offline = true;
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
  const ceiling = Math.min(
    GITHUB_ASSET_LIMIT - 1,
    Number(manifest.budgetBytes) + 800 * 1024 * 1024,
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
function assertPackagedLayout({ releaseDir, manifest, targets = ["nsis", "portable"] }) {
  const plan = stage.stagePlan(manifest);
  const bounds = installerBounds(manifest);
  const errors = [];
  const unpacked = path.join(releaseDir, "win-unpacked");
  for (const pack of plan.packs) {
    const file = path.join(unpacked, "resources", pack.dest, pack.id, "pack.bin");
    if (!fs.existsSync(file)) {
      errors.push(
        `${pack.id} is missing at ${file} — toolchain staging did not land inside the app; refusing a small EXE`,
      );
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

function runtimeSmokePlan(manifest = readManifest()) {
  const plan = stage.stagePlan(manifest);
  const byId = Object.fromEntries(plan.packs.map((pack) => [pack.id, pack]));
  return {
    python: {
      id: "python-embed",
      pack: byId["python-embed"]
        ? `resources/${byId["python-embed"].dest}/python-embed/pack.bin`
        : null,
      command: ["python.exe", "-m", "pip", "--version"],
    },
    whisper: {
      id: "whisper-cpp",
      pack: byId["whisper-cpp"]
        ? `resources/${byId["whisper-cpp"].dest}/whisper-cpp/pack.bin`
        : null,
      command: ["Release/whisper-cli.exe", "-h"],
    },
    sandbox: {
      command: ["python.exe", "-c", "import sys; print(sys.executable)"],
    },
    mcp: {
      command: ["node", "electron/friday-mcp.cjs"],
      expect: "initialize",
    },
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
    stdout: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function extractZipPack(packFile, dest) {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(packFile, "r");
  try {
    fs.readSync(fd, header, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const zip = header[0] === 0x50 && header[1] === 0x4b;
  if (!zip) {
    throw new Error(`packaged self-check: ${packFile} is not a zip archive`);
  }
  const spec = localTar(packFile, ["-xf", packFile, "-C", dest]);
  const result = spawnDirect("tar", spec.args, { cwd: spec.cwd });
  if (result.status !== 0) {
    throw new Error(
      `packaged self-check: could not extract ${path.basename(packFile)} (${result.status})`,
    );
  }
}

function materialisePack(unpackDir, relativePack, dest, extract) {
  if (!relativePack) {
    throw new Error("packaged self-check: pack path is missing from the manifest");
  }
  const packFile = path.join(unpackDir, relativePack);
  if (!fs.existsSync(packFile)) {
    throw new Error(`packaged self-check: missing ${relativePack}`);
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
  );
  const whisperDir = materialisePack(
    unpackDir,
    plan.whisper.pack,
    path.join(work, "whisper"),
    extract,
  );
  const probes = [
    { name: "python", command: plan.python.command, cwd: pythonDir },
    { name: "sandbox", command: plan.sandbox.command, cwd: pythonDir },
    { name: "whisper", command: plan.whisper.command, cwd: whisperDir },
    {
      name: "mcp",
      command: plan.mcp.command,
      cwd: root,
      stdin: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      expect: plan.mcp.expect,
    },
  ];
  const lines = [];
  for (const probe of probes) {
    const result = runner(probe) || {};
    const status = result.status;
    const stdout = String(result.stdout || "");
    if (status !== 0) {
      throw new Error(
        `packaged self-check: ${probe.name} failed (${status === null || status === undefined ? "no exit" : status})`,
      );
    }
    if (probe.expect && !stdout.includes(probe.expect)) {
      throw new Error(`packaged self-check: ${probe.name} did not answer ${probe.expect}`);
    }
    lines.push(`${probe.name} ok`);
  }
  return lines.join("; ");
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
  for (const dir of [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "winCodeSign")
      : "",
    path.join(process.env.ELECTRON_BUILDER_CACHE, "winCodeSign"),
  ].filter(Boolean)) {
    removeTree(dir);
  }
}

function runNode(script, args, root) {
  const result = spawnDirect(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed (${result.status === null ? "no exit" : result.status})`);
  }
}

function npmCi(root) {
  const args = ["ci", "--no-audit", "--no-fund"];
  const once = spawnNpm(args, { cwd: root, stdio: "inherit" });
  if (once.status === 0) return;
  console.error("[FRIDAY] npm ci failed — npm cache verify, then retry against registry.npmjs.org");
  spawnNpm(["cache", "verify"], { cwd: root, stdio: "inherit" });
  const again = spawnNpm([...args, "--registry", "https://registry.npmjs.org/"], {
    cwd: root,
    stdio: "inherit",
  });
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

function signingRequested(options) {
  if (options.sign === "off" || options.sign === "false") return false;
  return Boolean(process.env.CSC_LINK || process.env.FRIDAY_PFX);
}

function runPhase(phase, options, root) {
  if (phase === "prepare-environment") {
    applyBuildCache(root);
    runNode("scripts/check-engines.cjs", [], root);
    npmCi(root);
    runNode("scripts/ensure-electron.cjs", ["--quiet"], root);
    runNode("scripts/setup-python.cjs", [], root);
    runNode("scripts/init-runtime.cjs", [], root);
    runNode("scripts/check-environment.cjs", ["--fix"], root);
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
    const built = spawnNpm(["run", "build:desktop"], { cwd: root, stdio: "inherit" });
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
    runNode("scripts/electron-pack.cjs", packArgs, root);
    return `packaged ${packArgs.join(" ")}`;
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
    const args = [
      "--version",
      version,
      "--channel",
      options.channel === "test" ? "test" : "stable",
    ];
    if (fs.existsSync(path.join(root, "release-notes.md")))
      args.push("--notes", "release-notes.md");
    if (options.releaseType) args.push("--type", options.releaseType);
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
    const verifyArgs = [mode];
    if (options.channel === "production" && mode !== "dir") {
      const engine = require("./release-engine.cjs");
      const identity = engine.readCanonicalIdentity({ root });
      verifyArgs.push("--version", options.version || identity.releaseVersion, "--manifest");
    }
    runNode("scripts/verify-build.cjs", verifyArgs, root);
    if (!options.targets.includes("dir") || options.targets.length > 1) {
      assertPackagedLayout({
        releaseDir: path.join(root, "release"),
        manifest: readManifest(root),
        targets: options.targets,
      });
    }
    return "artifacts verified";
  }
  if (phase === "verify-boot") {
    runNode("scripts/verify-boot.cjs", [], root);
    return "boot verified";
  }
  if (phase === "readiness") {
    runNode("scripts/readiness-test.cjs", ["--pack"], root);
    return "readiness passed";
  }
  if (phase === "packaged-self-check") {
    return runPackagedSelfCheck({
      platform: options.platform,
      unpackDir: options.unpackDir,
      root,
      runner: options.runner,
      extract: options.extract,
      manifest: options.manifest,
      workDir: options.workDir,
    });
  }
  if (phase === "installer-smoke") {
    if (process.platform !== "win32" || !options.targets.includes("nsis")) {
      return "skipped: installer smoke runs on Windows when an NSIS target was packaged";
    }
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
  };
  for (const phase of phases) {
    const started = Date.now();
    try {
      const detail = await runPhase(phase, options, root);
      const text = String(detail);
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
      fs.mkdirSync(path.dirname(options.report), { recursive: true });
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
      console.error(`[FRIDAY] ${phase} failed: ${message}`);
      return report;
    }
  }
  report.ok = true;
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  return report;
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
  if (!report.ok) process.exit(1);
}

module.exports = {
  PHASES,
  PHASE_COMMANDS,
  GITHUB_ASSET_LIMIT,
  parseArgs,
  selectedPhases,
  commandsFor,
  installerBounds,
  assertPackagedLayout,
  runtimeSmokePlan,
  applyChannel,
  signingRequested,
  signingStatusLines,
  runPackagedSelfCheck,
  runPipeline,
  REMOVE_OPTIONS,
  removeTree,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
