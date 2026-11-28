#!/usr/bin/env node
/**
 * FRIDAY · release manifest + checksums.
 *
 * Runs after the Windows build has been verified and writes the two files that
 * make an update verifiable by the installed app:
 *
 *   release/SHA256SUMS.txt      one "sha256  filename" line per published asset
 *   release/friday-update.json  { version, tag, publishedAt, notes, assets[] }
 *
 * The installed FRIDAY downloads friday-update.json with the release, hashes
 * the installer it just downloaded and refuses to run anything whose SHA-256
 * does not match. No hash, no install.
 *
 * It also writes release/friday-bundle.json (electron/build-bundle.cjs, the one reader and writer) for every
 * caller: the app files, what the EXE carries, the weight packs and, for a CMD build only, the model folders on
 * this PC with a streamed SHA-256 per file. friday-update.json names it in the optional `bundle` key
 * ({ name, bytes, sha256 }); readers ignore keys they do not know, so the manifest schema does not change. The
 * record lists no friday-update.json hash, because that file holds the record's hash. A build with no packed
 * builtins list to describe writes no record (and removes a stale one); it never fails the build.
 *
 *   node scripts/release-manifest.cjs --version 1.2.3 [--notes release-notes.md]
 *   node scripts/release-manifest.cjs --version 1.2.3-test.1 --channel test [--caller cmd|test|release]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const IDENTITY = require("./identity.cjs");
const engine = require("./release-engine.cjs");
const bundleLib = require("../electron/build-bundle.cjs");
const voicePins = require("../electron/voice-pins.cjs");

const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");
/** A folder name the record can carry as a model id. */
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A file that is still arriving, apart from FRIDAY's own part files: a folder holding one is not a finished model. */
const UNFINISHED = /\.(part\d*|tmp|partial|download|crdownload)$/i;

/** SHA-256 of a file, read in 1 MiB steps so a multi-GB weight file never sits in memory. */
function sha256(file) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** The FRIDAY folder this build downloaded into (the same pick prefetch makes), never recorded from here. */
function findHome(env) {
  try {
    if (env.FRIDAY_WORKSPACE_ROOT) return path.resolve(env.FRIDAY_WORKSPACE_ROOT);
    return require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root;
  } catch {
    return null;
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Which build is writing: an explicit name wins; otherwise a hosted run is Release or Test and a PC run is the CMD. */
function callerOf(requested, channel, env) {
  const named = {
    cmd: "cmd",
    npm: "cmd",
    test: "test",
    release: "release",
    "pr-validation": "release",
  };
  const given = named[String(requested || "").toLowerCase()];
  if (given) return given;
  if (String(env.GITHUB_ACTIONS || "") === "true") return channel === "test" ? "test" : "release";
  return "cmd";
}

function commitOf(env) {
  const hex = /^[0-9a-f]{7,64}$/i;
  if (hex.test(String(env.GITHUB_SHA || ""))) return String(env.GITHUB_SHA).toLowerCase();
  try {
    const out = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5000,
    });
    const value = out.status === 0 ? String(out.stdout || "").trim() : "";
    return hex.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Where the CMD build keeps a weight pack (scripts/place-build.cjs buildPacks), relative to the FRIDAY folder. */
const packDirOf = (tag) => `installer/packs/${tag}`;

/** True when `<home>/installer/packs/<tag>` holds at least one file: only then is that pack a local source. */
function packOnDisk(home, tag) {
  if (!home || !FOLDER_ID.test(String(tag))) return false;
  const found = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && found(path.join(folder, entry.name))) return true;
    }
    return false;
  };
  try {
    return found(path.join(home, ...packDirOf(tag).split("/")));
  } catch {
    return false;
  }
}

/**
 * The weight packs this build knows: every `packs[]` row of config/friday-models.json, plus the old
 * `<tagPrefix><revision>` pack when a FRIDAY Core variant of config/friday-core.json is named by no row.
 * A pack that sits in `<home>/installer/packs/<tag>` (the CMD opt-in FRIDAY_BUILD_PACKS=1) is a local source
 * (`location: "local"`, `dir: "installer/packs/<tag>"`); any other pack stays on the release.
 */
function packsOf(root, home = null) {
  const models = readJson(path.join(root, "config", "friday-models.json"));
  const core = readJson(path.join(root, "config", "friday-core.json"));
  const rows = Array.isArray(models?.packs) ? models.packs : [];
  const out = rows
    .filter((p) => p && p.id && p.tag && p.revision)
    .map((p) => ({ id: p.id, tag: p.tag, revision: p.revision, location: "release", dir: null }));
  const named = new Set(rows.flatMap((p) => (Array.isArray(p?.core) ? p.core : [])));
  const mirror = (Array.isArray(core?.mirrors) ? core.mirrors : []).find(
    (m) => m?.kind === "release",
  );
  const loose = (Array.isArray(core?.variants) ? core.variants : []).some((v) => !named.has(v?.id));
  if (loose && mirror && models?.revision && !out.some((p) => p.id === models.pack)) {
    out.push({
      id: models.pack || "friday-models",
      tag: models.tag || `${mirror.tagPrefix}${models.revision}`,
      revision: models.revision,
      location: "release",
      dir: null,
    });
  }
  return out.map((p) =>
    packOnDisk(home, p.tag) ? { ...p, location: "local", dir: packDirOf(p.tag) } : p,
  );
}

/** FRIDAY's own marker files and download scratch (the predicate the pin audit uses, not a second list). */
const isOwnFile = (rel) =>
  voicePins.unexpectedFiles("", { files: {} }, { list: () => [rel] }).length === 0;

/** Every file under a model folder, or null when it holds a link, a stray entry or an unfinished download. */
function filesOf(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(folder, entry.name);
      if (isOwnFile(rel)) continue;
      if (entry.isDirectory()) {
        if (!walk(full, rel)) return false;
      } else if (entry.isFile() && !UNFINISHED.test(entry.name)) {
        out.push({ path: rel, bytes: fs.statSync(full).size, sha256: sha256(full) });
      } else return false;
    }
    return true;
  };
  return walk(dir, "") && out.length ? out : null;
}

/** The finished model folders under `<home>/models`: only what exists, never an error for what does not. */
function modelsOf(home) {
  const list = [];
  try {
    const base = path.join(home, "models");
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !FOLDER_ID.test(entry.name))
        continue;
      try {
        const files = filesOf(path.join(base, entry.name));
        if (files) list.push({ fridayId: entry.name, dir: `models/${entry.name}`, files });
      } catch {
        /* a folder that cannot be read is not listed */
      }
    }
  } catch {
    /* no models folder on this PC */
  }
  return list;
}

/** friday-bundle.json for this build, or null when there is no packed builtins list to describe. */
function bundleOf({ clean, test, caller, assets, sumsFile, resourcesDir, home, env, commit }) {
  const builtins = path.join(resourcesDir, "builtins.json");
  if (!fs.existsSync(builtins)) return null;
  const pack = path.join(resourcesDir, "toolchain", "wheelhouse", "pack.bin");
  const kindOf = (a) =>
    /\.blockmap$/i.test(a.name) ? "blockmap" : /^latest\.yml$/i.test(a.name) ? "latest" : a.kind;
  const input = {
    product: IDENTITY.updateManifestIdentity().product,
    channel: test ? "test" : "stable",
    version: clean.replace(/-.*$/, ""),
    commit,
    caller,
    app: [
      ...assets.map((a) => ({ name: a.name, kind: kindOf(a), bytes: a.bytes, sha256: a.sha256 })),
      {
        name: path.basename(sumsFile),
        kind: "sums",
        bytes: fs.statSync(sumsFile).size,
        sha256: sha256(sumsFile),
      },
    ],
    inExe: {
      builtins: { sha256: sha256(builtins) },
      wheelhouse: fs.existsSync(pack)
        ? { bytes: fs.statSync(pack).size, sha256: sha256(pack) }
        : null,
    },
    packs: packsOf(ROOT, caller === "cmd" ? home : null),
    models: [],
  };
  if (caller === "cmd" && String(env.FRIDAY_BUNDLE_MODELS || "") !== "0" && home) {
    // One folder the record cannot describe (a name Windows refuses) is left out, never a failed build.
    input.models = modelsOf(home).filter((m) => {
      try {
        bundleLib.build({ ...input, models: [m] });
        return true;
      } catch {
        return false;
      }
    });
  }
  return bundleLib.build(input);
}

function build({
  version,
  notes = "",
  channel = "stable",
  releaseType: requested = "",
  // Where the artifacts are, where the two files are written, and whether
  // latest.yml is rewritten. The defaults are the real release; a verification
  // pass points them at a scratch folder so it changes nothing.
  releaseDir = RELEASE,
  outDir = releaseDir,
  syncLatest = true,
  // The build record: who is writing, the packed resources it describes, the FRIDAY folder whose model folders a
  // CMD build lists, the commit (null when unknown) and the environment. The defaults are the real build.
  caller = "",
  resourcesDir = path.join(releaseDir, "win-unpacked", "resources"),
  fridayRoot = undefined,
  commit = undefined,
  env = process.env,
} = {}) {
  const clean = String(version || "").replace(/^v/i, "");
  const test = channel === "test";
  const parsed = engine.parseFridayVersion(clean);
  const identity =
    engine.readCanonicalIdentity({ root: ROOT, version: clean }) ||
    (parsed
      ? engine.identityFromParsed(parsed, {
          forceFourPart: parsed.fourPart ? true : undefined,
        })
      : null);
  // Rewrite latest.yml to the public identity BEFORE hashing, otherwise the
  // checksum in friday-update.json would describe the npm-encoding file.
  if (identity && syncLatest) engine.syncLatestYml(identity, { root: ROOT });
  // A TEST build publishes the same two Windows deliverables as an official
  // release, under the separate "FRIDAY Test" identity so it installs beside —
  // never over — the production FRIDAY.
  const candidates = [
    `FRIDAY-Setup-${clean}.exe`,
    `FRIDAY-Test-Setup-${clean}.exe`,
    `FRIDAY-Portable-${clean}.exe`,
    // The installer's block map: lets the next update download only what changed.
    `FRIDAY-Setup-${clean}.exe.blockmap`,
    `FRIDAY-Test-Setup-${clean}.exe.blockmap`,
    "latest.yml",
  ];
  const assets = candidates
    .map((name) => ({ name, file: path.join(releaseDir, name) }))
    .filter((a) => fs.existsSync(a.file))
    .map((a) => ({
      name: a.name,
      bytes: fs.statSync(a.file).size,
      sha256: sha256(a.file),
      kind: /\.blockmap$/i.test(a.name)
        ? "metadata"
        : /setup/i.test(a.name)
          ? "installer"
          : /portable/i.test(a.name)
            ? "portable"
            : "metadata",
    }));

  // Stable always ships an installer. A test run may be portable-only, so it
  // needs at least one runnable EXE — never a metadata-only manifest.
  const ok = test
    ? assets.some((a) => a.kind === "installer" || a.kind === "portable")
    : assets.some((a) => a.kind === "installer");
  if (!ok) {
    throw new Error(
      `no ${test ? "installer or portable EXE" : "installer"} found in release/ for version ${clean}`,
    );
  }

  const fromNotes = engine.extractNotesReleaseType(notes);
  const requestedType = engine.normalizeReleaseType(requested);
  const releaseType =
    requestedType && requestedType !== "auto"
      ? requestedType
      : fromNotes && fromNotes !== "auto"
        ? fromNotes
        : null;

  const manifest = {
    ...IDENTITY.updateManifestIdentity(),
    version: clean,
    tag: `v${clean}`,
    channel: test ? "test" : "stable",
    publishedAt: new Date().toISOString(),
    notes,
    assets,
  };
  if (releaseType && releaseType !== "auto") manifest.releaseType = releaseType;
  if (releaseType && engine.releaseTypeLabel(releaseType)) {
    manifest.releaseLabel = engine.releaseTypeLabel(releaseType);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const sumsFile = path.join(outDir, "SHA256SUMS.txt");
  fs.writeFileSync(sumsFile, `${assets.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`);
  // The record goes next to the manifest; a stale one from an earlier run is never left to be published.
  const bundleFile = path.join(outDir, bundleLib.FILE_NAME);
  const which = callerOf(caller, channel, env);
  const record = bundleOf({
    clean,
    test,
    caller: which,
    assets,
    sumsFile,
    resourcesDir,
    home: fridayRoot === undefined ? findHome(env) : fridayRoot,
    env,
    commit: commit === undefined ? commitOf(env) : commit,
  });
  fs.rmSync(bundleFile, { force: true });
  if (record) {
    bundleLib.write(bundleFile, record);
    manifest.bundle = {
      name: bundleLib.FILE_NAME,
      bytes: fs.statSync(bundleFile).size,
      sha256: sha256(bundleFile),
    };
  }
  fs.writeFileSync(
    path.join(outDir, "friday-update.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

module.exports = { build, sha256 };

if (require.main === module) {
  const flag = (name, fallback = "") => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const notesFile = flag("notes");
  const caller = flag("caller");
  const version =
    flag("version") ||
    engine.readCanonicalIdentity({ root: ROOT })?.releaseVersion ||
    JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  try {
    const manifest = build({
      version,
      channel: flag("channel", "stable"),
      releaseType: flag("type"),
      caller,
      notes: notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "",
    });
    for (const a of manifest.assets) console.log(`[friday] ${a.sha256}  ${a.name}`);
    if (manifest.bundle) console.log(`[friday] ${manifest.bundle.sha256}  ${manifest.bundle.name}`);
    else
      console.log("[friday] note     no friday-bundle.json: no packed builtins list to describe");
    console.log(`[friday] ok       release manifest for v${manifest.version}`);
  } catch (error) {
    console.error(`[friday] manifest failed: ${error.message}`);
    process.exit(1);
  }
}
