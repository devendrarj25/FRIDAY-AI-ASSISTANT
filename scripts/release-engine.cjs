#!/usr/bin/env node
/**
 * FRIDAY · release engine (versioning + changelog)
 *
 * One implementation shared by the GitHub Actions release workflow and by the
 * desktop app's "Analyze changes" panel, so a release computed on CI and a
 * preview shown in FRIDAY can never disagree.
 *
 * Nothing here builds, tags or publishes — it only reads commit subjects and
 * decides:
 *   • which public increment the changes deserve
 *     (auto | patch | minor | major | extreme | rebuild)
 *   • what the "What's New" notes say, categorised from the real commits
 *
 * Human-facing levels on the four-part line (see VERSIONING.md).
 * Only the chosen counter moves. The others keep counting:
 *   PATCH / FIX     patch     1.0.1.2 -> 1.0.1.3
 *   MINOR / CHANGES minor     1.0.1.2 -> 1.0.2.2
 *   MAJOR / FEATURE major     1.0.1.2 -> 1.1.1.2
 *   EXTREME UPDATE  extreme   1.0.1.2 -> 2.0.1.2
 *   REBUILD         rebuild   same public version, new artifacts
 * `revision` is an alias of REBUILD. mode=auto does not invent the next
 * number. release_type=auto on an update chooses patch, minor, or major
 * from the changes and never selects extreme.
 *
 * CLI:
 *   node scripts/release-engine.cjs plan  --previous v1.2.0 --type auto [--log FILE]
 *   node scripts/release-engine.cjs apply --version 1.2.1 [--notes FILE] [--date ISO]
 *   node scripts/release-engine.cjs heal  [--version 1.2.1] [--check]
 *
 * `plan` prints JSON on stdout. `apply` writes config/friday-version.json
 * (canonical), the npm encoding in package.json, the renderer fallback and
 * CHANGELOG.md — it is only ever run by a release that already passed its
 * tests.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CANONICAL_REL = path.join("config", "friday-version.json");
const NSIS_VERSION_REL = path.join("installer", "build", "friday-version.nsh");

/** Git blob paths and pathspecs are POSIX even on Windows (`config\\file` is not a tree path). */
function posixRel(rel) {
  return String(rel || "")
    .split(/[/\\]+/)
    .filter(Boolean)
    .join("/");
}

/** Legacy three-part line (1.0.0–1.8.x). */
const EPOCH_LEGACY = 1;
/** Public four-part FRIDAY line starting at 1.0.0.0. */
const EPOCH_FRIDAY2 = 2;

/**
 * Canonical public release levels. Ids are stored in metadata; labels are
 * human-facing. `revision` is a compatibility alias of REBUILD: same number.
 */
const RELEASE_LEVELS = {
  patch: {
    id: "patch",
    label: "PATCH / FIX",
    aliases: ["fix"],
  },
  minor: {
    id: "minor",
    label: "MINOR / CHANGES",
    aliases: ["changes"],
  },
  major: {
    id: "major",
    label: "MAJOR / FEATURE",
    aliases: ["feature"],
  },
  extreme: {
    id: "extreme",
    label: "EXTREME UPDATE / FULL SYSTEM VERSION UPDATE",
    aliases: ["full", "generation"],
  },
  rebuild: {
    id: "rebuild",
    label: "REBUILD",
    aliases: ["none", "revision"],
  },
};
const RELEASE_LEVEL_IDS = Object.keys(RELEASE_LEVELS);

/**
 * Public FRIDAY version: X.Y.Z or X.Y.Z.W, optional -test.N.
 * Four-part is the current product scheme; three-part is the legacy line and
 * the npm/electron-builder SemVer encoding of a four-part identity.
 */
const VERSION_NUM = "\\d+\\.\\d+\\.\\d+(?:\\.\\d+)?";
const VERSION_FULL = `${VERSION_NUM}(?:-[0-9A-Za-z.-]+)?`;
const VERSION_FULL_RE = new RegExp(`^(${VERSION_NUM})(?:-([0-9A-Za-z.-]+))?$`);
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const TEST_VERSION_RE = /^(\d+\.\d+\.\d+(?:\.\d+)?)-test\.(\d+)$/i;

// ---- canonical FRIDAY version (public four-part + npm SemVer encoding) -----

/**
 * Parse a FRIDAY version string into components. Returns null when the value
 * is not a FRIDAY release version. Never invents 0.0.0 for a real release.
 */
function parseFridayVersion(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^v/i, "");
  const m = VERSION_FULL_RE.exec(raw);
  if (!m) return null;
  const core = m[1];
  const prerelease = m[2] || null;
  const parts = core.split(".").map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [major, minor, patch, revisionPart] = parts;
  const fourPart = parts.length === 4;
  return {
    raw,
    major,
    minor,
    patch,
    revision: fourPart ? revisionPart : 0,
    prerelease,
    fourPart,
    epoch: fourPart ? EPOCH_FRIDAY2 : EPOCH_LEGACY,
    channel: prerelease && /^test(\.|$)/i.test(prerelease) ? "test" : "stable",
  };
}

function formatPublic(parsed, { fourPart = parsed.fourPart } = {}) {
  const core = fourPart
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}.${parsed.revision}`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${core}-${parsed.prerelease}` : core;
}

function formatNpm(parsed) {
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${core}-${parsed.prerelease}` : core;
}

function identityFromParsed(parsed, { forceFourPart } = {}) {
  const fourPart = forceFourPart === undefined ? parsed.fourPart : Boolean(forceFourPart);
  const epoch = fourPart ? EPOCH_FRIDAY2 : EPOCH_LEGACY;
  const releaseVersion = formatPublic(parsed, { fourPart });
  const npmVersion = formatNpm(parsed);
  return {
    schema: 1,
    epoch,
    epochName: epoch === EPOCH_FRIDAY2 ? "friday-2" : "legacy",
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    revision: fourPart ? parsed.revision : 0,
    channel: parsed.channel,
    prerelease: parsed.prerelease,
    releaseVersion,
    displayVersion: releaseVersion,
    npmVersion,
    tag: `v${releaseVersion}`,
    windowsFileVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}.${fourPart ? parsed.revision : 0}`,
    buildNumber: String(fourPart ? parsed.revision : 0),
    fourPart,
  };
}

function canonicalObject(identity) {
  return {
    schema: 1,
    epoch: identity.epoch,
    epochName: identity.epochName,
    fourPart: Boolean(identity.fourPart),
    major: identity.major,
    minor: identity.minor,
    patch: identity.patch,
    revision: identity.revision,
    channel: identity.channel,
    prerelease: identity.prerelease,
  };
}

function identityFromCanonical(data) {
  const major = Number(data?.major);
  const minor = Number(data?.minor);
  const patch = Number(data?.patch);
  const revision = Number(data?.revision);
  if (![major, minor, patch, revision].every((n) => Number.isFinite(n) && n >= 0)) return null;
  const prerelease = data?.prerelease ? String(data.prerelease) : null;
  const fourPart =
    data.fourPart !== undefined ? Boolean(data.fourPart) : Number(data?.epoch) === EPOCH_FRIDAY2;
  const core = fourPart ? `${major}.${minor}.${patch}.${revision}` : `${major}.${minor}.${patch}`;
  const parsed = parseFridayVersion(prerelease ? `${core}-${prerelease}` : core);
  if (!parsed) return null;
  return identityFromParsed(parsed, { forceFourPart: fourPart });
}

function readCanonicalFile(root = ROOT) {
  const file = path.join(root, CANONICAL_REL);
  if (!fs.existsSync(file)) return null;
  try {
    return identityFromCanonical(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Identity at a git ref (e.g. origin/main), not the working tree.
 * Official Publish stays checked out at the start-of-run commit after Safe
 * Merge advances origin/main - reading the local tree there is stale.
 */
function readCanonicalIdentityAtRef(ref, { root = ROOT } = {}) {
  const name = String(ref || "").trim();
  if (!name || /[:\s]|^\.|^\-|\.\.|[\x00-\x1f]/.test(name)) return null;
  const { execFileSync } = require("node:child_process");
  try {
    const spec = `${name}:${posixRel(CANONICAL_REL)}`;
    const raw = execFileSync("git", ["show", spec], {
      encoding: "utf8",
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
    return identityFromCanonical(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCanonicalFile(identity, { root = ROOT } = {}) {
  const file = path.join(root, CANONICAL_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify(canonicalObject(identity), null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === payload) return false;
  fs.writeFileSync(file, payload);
  return true;
}

function writeNsisVersionHeader(identity, { root = ROOT } = {}) {
  const file = path.join(root, NSIS_VERSION_REL);
  if (!fs.existsSync(path.dirname(file))) return false;
  const body = `; GENERATED by scripts/release-engine.cjs — do not edit.\n!define FRIDAY_DISPLAY_VERSION "${identity.releaseVersion}"\n!define FRIDAY_NPM_VERSION "${identity.npmVersion}"\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return false;
  fs.writeFileSync(file, body);
  return true;
}

/**
 * The identity this tree is shipping. Canonical JSON is the authority.
 * package.json is the derived npm/electron-builder SemVer encoding.
 */
function readCanonicalIdentity({ root = ROOT, version } = {}) {
  const fromFile = readCanonicalFile(root);
  if (version) {
    const parsed = parseFridayVersion(version);
    if (!parsed) return null;
    // The npm encoding of the canonical identity (1.0.0 for public 1.0.0.0)
    // must never collapse the public four-part release line.
    if (
      fromFile &&
      (parsed.raw === fromFile.releaseVersion || parsed.raw === fromFile.npmVersion)
    ) {
      return fromFile;
    }
    return identityFromParsed(parsed, { forceFourPart: parsed.fourPart ? true : undefined });
  }
  if (fromFile) return fromFile;
  const pkgFile = path.join(root, "package.json");
  if (!fs.existsSync(pkgFile)) return null;
  try {
    const parsed = parseFridayVersion(JSON.parse(fs.readFileSync(pkgFile, "utf8")).version);
    return parsed ? identityFromParsed(parsed) : null;
  } catch {
    return null;
  }
}

function requireIdentity(version, { root = ROOT } = {}) {
  const identity = readCanonicalIdentity({ root, version });
  if (!identity) throw new Error(VERSION_UNRESOLVED);
  if (
    identity.major === 0 &&
    identity.minor === 0 &&
    identity.patch === 0 &&
    identity.revision === 0
  )
    throw new Error(VERSION_UNRESOLVED);
  return identity;
}

function packFlags(identity) {
  const v = identity.releaseVersion;
  const test = identity.channel === "test" || isTestVersion(v);
  const parsed = parseFridayVersion(v);
  const fileVersion =
    identity.windowsFileVersion ||
    (parsed
      ? `${parsed.major}.${parsed.minor}.${parsed.patch}.${parsed.fourPart ? parsed.revision : 0}`
      : "0.0.0.0");
  return {
    buildNumber: identity.buildNumber,
    setupArtifact: test ? `FRIDAY-Test-Setup-${v}.exe` : `FRIDAY-Setup-${v}.exe`,
    portableArtifact: `FRIDAY-Portable-${v}.exe`,
    extraArgs: [
      `-c.buildNumber=${identity.buildNumber}`,
      // electron-builder 26 signAndEditResources runs AFTER afterPack and
      // takes FileVersion from metadata.shortVersion || buildVersion (npm).
      // TEST 1.0.0.0-test.1 otherwise becomes string "1.0.0-test.1" and
      // binary FILEVERSION 1.0.0.1 (Test EXE Build 33901573538).
      `-c.buildVersion=${fileVersion}`,
      `-c.extraMetadata.shortVersion=${fileVersion}`,
      `-c.extraMetadata.shortVersionWindows=${fileVersion}`,
      `-c.win.artifactName=${test ? `FRIDAY-Test-Setup-${v}.exe` : `FRIDAY-Setup-${v}.exe`}`,
      `-c.portable.artifactName=FRIDAY-Portable-${v}.exe`,
    ],
  };
}

function electronBuilderArgs(identity, extra = []) {
  return [...packFlags(identity).extraArgs, ...extra];
}

/**
 * electron-builder writes `release/latest.yml` from the npm SemVer encoding
 * (`package.json` version, e.g. `1.0.0`). FRIDAY's public identity is
 * four-part (`1.0.0.0`). Rewrite that file so verify-build, checksums and the
 * updater all see the public version. No-op when the file is absent.
 */
function syncLatestYml(identity, { root = ROOT } = {}) {
  const file = path.join(root, "release", "latest.yml");
  if (!identity?.releaseVersion || !fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, "utf8");
  let body = before.replace(/^version:\s*.+$/m, `version: ${identity.releaseVersion}`);
  const npmV = identity.npmVersion;
  const publicV = identity.releaseVersion;
  if (npmV && publicV && npmV !== publicV) {
    const escaped = npmV.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body.replace(
      new RegExp(`(FRIDAY-(?:Test-Setup|Setup|Portable)-)${escaped}(?=\\.exe\\b)`, "g"),
      `$1${publicV}`,
    );
  }
  if (body === before) return false;
  fs.writeFileSync(file, body);
  return true;
}

// ---- version arithmetic ----------------------------------------------------

/** "v1.2.3" / "1.2.3.4-test.1" -> [epoch, major, minor, patch, revision]. */
function parseVersion(value) {
  const parsed = parseFridayVersion(value);
  if (!parsed) return [0, 0, 0, 0, 0];
  return [parsed.epoch, parsed.major, parsed.minor, parsed.patch, parsed.revision];
}

/**
 * Numeric ordering including the version epoch.
 * Four-part friday-2 identities outrank older three-part identities, so
 * 1.0.0.0 is an update, not a downgrade. 1.0.0 (npm encoding) equals 1.0.0.0.
 */
function compareVersionCores(a, b) {
  const pa = parseFridayVersion(a);
  const pb = parseFridayVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const sameTrio = pa.major === pb.major && pa.minor === pb.minor && pa.patch === pb.patch;
  if (sameTrio && pa.fourPart !== pb.fourPart) {
    const revA = pa.fourPart ? pa.revision : 0;
    const revB = pb.fourPart ? pb.revision : 0;
    if (revA !== revB) return revA - revB;
  } else if (pa.epoch !== pb.epoch) {
    return pa.epoch - pb.epoch;
  }
  const seqA = [pa.major, pa.minor, pa.patch, pa.fourPart ? pa.revision : 0];
  const seqB = [pb.major, pb.minor, pb.patch, pb.fourPart ? pb.revision : 0];
  for (let i = 0; i < 4; i += 1) if (seqA[i] !== seqB[i]) return seqA[i] - seqB[i];
  return 0;
}

/** > 0 when a is newer than b (release line only; prerelease ignored). */
function compareVersions(a, b) {
  return compareVersionCores(a, b);
}

/** Strict stable version: three-part legacy or four-part public, no prerelease. */
const isStableVersion = (value) => STABLE_VERSION_RE.test(String(value || "").replace(/^v/i, ""));

/**
 * Resolve all release PRs into one deterministic state.
 *
 * GitHub returns PRs by update time, which is not release order. An older PR
 * can therefore appear first after a comment or check rerun. Official release
 * state is instead ordered by SemVer. Lower OPEN versions are retained as
 * history but classified as superseded by the highest OPEN version.
 */
function resolvePreparedState({ current, prepared = [] } = {}) {
  const declared = String(current || "").replace(/^v/i, "");
  const normalised = (prepared || [])
    .map((p) => ({
      ...p,
      number: Number(p?.number || 0),
      version: String(p?.version || "").replace(/^v/i, ""),
      state: String(p?.state || "").toLowerCase(),
    }))
    .filter((p) => isStableVersion(p.version) && ["open", "merged", "closed"].includes(p.state));
  const open = normalised
    .filter((p) => p.state === "open")
    .sort((a, b) => compareVersions(b.version, a.version) || b.number - a.number);
  const latestOpen = open[0] || null;
  const duplicateLatest = latestOpen ? open.filter((p) => p.version === latestOpen.version) : [];
  const superseded = latestOpen
    ? open.filter((p) => compareVersions(p.version, latestOpen.version) < 0)
    : [];
  const mergedCurrent =
    normalised
      .filter((p) => p.state === "merged" && p.version === declared)
      .sort((a, b) => b.number - a.number)[0] || null;
  const mergedAhead =
    normalised
      .filter((p) => p.state === "merged" && compareVersions(p.version, declared) > 0)
      .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
  const conflicts = [];

  if (duplicateLatest.length > 1) {
    conflicts.push(`multiple open release Pull Requests declare v${latestOpen.version}`);
  }
  if (mergedAhead) {
    conflicts.push(
      `release/v${mergedAhead.version} is merged but main still declares v${declared || "unknown"}`,
    );
  }

  return {
    current: declared,
    prepared: normalised,
    latestOpen,
    superseded,
    mergedCurrent,
    mergedAhead,
    ambiguous: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Map a workflow / CLI / UI increment onto a canonical level id.
 * Unknown values stay unknown (null) so callers can fail closed.
 */
function normalizeReleaseType(kind) {
  const raw = String(kind || "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") return "auto";
  for (const id of RELEASE_LEVEL_IDS) {
    const meta = RELEASE_LEVELS[id];
    if (raw === id || meta.aliases.includes(raw)) return id;
  }
  return null;
}

function extractNotesReleaseType(text) {
  const m = String(text || "").match(/\*\*Release type:\*\*\s*(.+?)\s*$/m);
  if (!m) return null;
  const raw = m[1].trim();
  const byLabel = RELEASE_LEVEL_IDS.find((id) => RELEASE_LEVELS[id].label === raw);
  if (byLabel) return byLabel;
  const normalized = normalizeReleaseType(raw);
  return normalized && normalized !== "auto" ? normalized : null;
}

function releaseTypeLabel(kind) {
  const id = normalizeReleaseType(kind);
  if (!id || id === "auto") return null;
  return RELEASE_LEVELS[id].label;
}

/**
 * Infer the public level from two public versions. Used when notes/manifest
 * need the type but the caller only has previous + next.
 */
function inferReleaseType(previous, next) {
  const from = parseFridayVersion(previous);
  const to = parseFridayVersion(next);
  if (!from || !to) return null;
  if (compareVersionCores(previous, next) === 0) return "rebuild";
  if (to.major !== from.major) return "extreme";
  if (to.minor !== from.minor) return "major";
  if (to.patch !== from.patch) return "minor";
  if (to.revision !== from.revision) return "patch";
  return "rebuild";
}

/**
 * One central bump. Four-part public arithmetic moves only the chosen counter.
 * The other three keep their count, so a later number still shows how many
 * patches, minors, majors, and extremes have happened:
 *   patch    (PATCH / FIX)     revision += 1
 *   minor    (MINOR / CHANGES) patch += 1
 *   major    (MAJOR / FEATURE) minor += 1
 *   extreme  (EXTREME UPDATE)  major += 1
 *   rebuild / revision         unchanged
 * From 1.0.1.2: patch 1.0.1.3, minor 1.0.2.2, major 1.1.1.2, extreme 2.0.1.2.
 * Three-part previous versions keep SemVer (patch/minor/major) so older lines
 * stay comparable; extreme there is major.
 */
function bumpVersion(previous, kind) {
  const level = normalizeReleaseType(kind);
  const parsed = parseFridayVersion(previous);
  if (level === "rebuild" || level === "auto") {
    if (!parsed) {
      return (
        String(previous || "")
          .trim()
          .replace(/^v/i, "") || "0.0.0"
      );
    }
    return formatPublic(parsed, { fourPart: parsed.fourPart });
  }
  if (!parsed) {
    const [major, minor, patch] = [0, 0, 0];
    if (level === "extreme" || level === "major") return `${major + 1}.0.0`;
    if (level === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }
  if (parsed.fourPart) {
    const next = { ...parsed, prerelease: null, fourPart: true };
    if (level === "extreme") next.major += 1;
    else if (level === "major") next.minor += 1;
    else if (level === "minor") next.patch += 1;
    else if (level === "patch") next.revision += 1;
    return formatPublic(next, { fourPart: true });
  }
  const { major, minor, patch } = parsed;
  if (level === "extreme" || level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Highest clean SemVer from releases, tags and the declared package version.
 * Test/RC prereleases are deliberately ignored: they can never advance the
 * official baseline used by either release preparation or test builds.
 */
function stableBaseline(values = []) {
  const stable = (values || [])
    .map((value) =>
      String(value || "")
        .trim()
        .replace(/^v/i, ""),
    )
    .filter((value) => isStableVersion(value));
  return stable.reduce((latest, value) => {
    const cmp = compareVersions(value, latest);
    if (cmp > 0) return value;
    if (cmp < 0) return latest;
    // Equal cores: the public four-part form (1.0.0.0) outranks the npm
    // encoding (1.0.0) so TEST/official baselines never collapse to SemVer.
    const next = parseFridayVersion(value);
    const prev = parseFridayVersion(latest);
    if (next?.fourPart && !prev?.fourPart) return value;
    return latest;
  }, "0.0.0");
}

/**
 * The REAL baseline of a release: which previous published stable release the
 * changes must be measured against, and whether that baseline exists as a git
 * tag in this clone.
 *
 * Getting this wrong is what makes a release note describe the whole history of
 * the repository: a baseline VERSION that has no corresponding TAG cannot be
 * used as a commit range, and the caller must fall back to a real commit
 * (the previous release commit) instead of to the root of history.
 *
 * Prereleases (`vX.Y.Z-test.N`) are never a stable baseline, and lexical
 * ordering is never used - versions are compared numerically.
 *
 * @param {object}   input
 * @param {string[]} [input.releases] published stable release tags
 * @param {string[]} [input.tags]     git tags present in the clone
 * @param {string}   [input.declared] package.json version (last resort)
 */
function releaseBaseline({ releases = [], tags = [], declared = "" } = {}) {
  const stableOnly = (list) =>
    (list || [])
      .map((v) =>
        String(v || "")
          .trim()
          .replace(/^v/i, ""),
      )
      .filter((v) => isStableVersion(v));

  const published = stableOnly(releases);
  const tagged = stableOnly(tags);
  const declaredStable = stableOnly([String(declared || "").split("-")[0]]);

  const newest = (list) =>
    list.reduce((latest, v) => (compareVersions(v, latest) > 0 ? v : latest), "");

  // A published release that also exists as a tag is the only fully trustworthy
  // baseline: it names both a version AND a commit.
  const bothVersions = published.filter((v) => tagged.includes(v));
  const both = newest(bothVersions);
  if (both) {
    return { version: both, tag: `v${both}`, hasTag: true, source: "published release" };
  }
  const tagOnly = newest(tagged);
  if (tagOnly) {
    return { version: tagOnly, tag: `v${tagOnly}`, hasTag: true, source: "git tag" };
  }
  const publishedOnly = newest(published);
  if (publishedOnly) {
    // Published, but the tag is not in this clone: the version is known, the
    // commit is not. The caller must NOT walk the whole history for it.
    return {
      version: publishedOnly,
      tag: `v${publishedOnly}`,
      hasTag: false,
      source: "published release without a local tag",
    };
  }
  const fallback = newest(declaredStable);
  if (fallback) {
    return {
      version: fallback,
      tag: `v${fallback}`,
      hasTag: false,
      source: "declared package.json version (nothing released yet)",
    };
  }
  return { version: "0.0.0", tag: "", hasTag: false, source: "none" };
}

// ---- test (pre-release) versions -------------------------------------------
//
// Official versions stay clean: 1.3.1, 1.3.2, 1.4.0.
// A test build of the same source line is a real SemVer prerelease of the
// version it is testing: 1.3.1-test.1, 1.3.1-test.2, 1.3.2-test.1 …
// Test versions are NEVER produced by the release workflow and never land on
// main — they exist only inside a portable Test EXE and its TEST prerelease.

/** "v1.3.1-test.2" / "v1.0.0.0-test.2" -> 2; anything else -> 0. */
function testIteration(value) {
  const m = String(value || "")
    .trim()
    .replace(/^v/i, "")
    .match(TEST_VERSION_RE);
  return m ? Number(m[2]) : 0;
}

/** Is this a FRIDAY test (prerelease) version? */
const isTestVersion = (value) => testIteration(value) > 0;

/**
 * The next test version for a base version, given the tags/releases that
 * already exist. 1.0.0.0 + ["v1.0.0.0-test.1"] -> 1.0.0.0-test.2.
 */
function testVersion(base, existing = []) {
  const parsed = parseFridayVersion(String(base || "").split("-")[0]);
  const clean = parsed
    ? formatPublic(parsed, { fourPart: parsed.fourPart })
    : String(base || "")
        .replace(/^v/i, "")
        .split("-")[0];
  const highest = existing
    .map((v) =>
      String(v || "")
        .trim()
        .replace(/^v/i, ""),
    )
    .filter((v) => v.startsWith(`${clean}-test.`))
    .reduce((max, v) => Math.max(max, testIteration(v)), 0);
  const iteration = highest + 1;
  const version = `${clean}-test.${iteration}`;
  return { base: clean, iteration, version, tag: `v${version}` };
}

// ---- commit classification -------------------------------------------------

const CATEGORIES = [
  ["Added", /^(feat|feature|add)\b/i],
  ["Fixed", /^(fix|bug|bugfix|hotfix)\b/i],
  ["Security", /^(sec|security)\b/i],
  ["Performance", /^(perf|performance)\b/i],
  ["Changed", /^(refactor|change|rework|remove|revert)\b/i],
  ["Improved", /^(improve|enhance|polish|ui|ux|style)\b/i],
  ["Technical", /^(chore|build|ci|test|tests|docs|deps|release)\b/i],
];

/** User-facing What's New headings, in display order. */
const USER_FACING_ORDER = [
  "Added",
  "Improved",
  "Fixed",
  "Changed",
  "Security",
  "Performance",
  "Removed",
  "Breaking Changes",
];
const TECHNICAL_SECTION = "Technical / Internal";
const ORDER = [...USER_FACING_ORDER, TECHNICAL_SECTION];
/** Shown when a release only refreshed packaging and checks. No repository words. */
const STEADY_UPDATE =
  "This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.";
const SECTION_TO_KEY = {
  Added: "added",
  Improved: "improved",
  Fixed: "fixed",
  Changed: "changed",
  Security: "security",
  Performance: "performance",
  Removed: "removed",
  "Breaking Changes": "breaking",
  [TECHNICAL_SECTION]: "technical",
};

const FORBIDDEN_NOTE_PATTERNS = [
  { id: "v0.0.0", re: /(?<![\d.])v?0\.0\.0(?:\.0)?(?:-test(?:\.\d+)?)?(?![\d.])/i },
  { id: "transient-whats-new", re: /transient What's New/i },
  { id: "transient-release", re: /transient release/i },
  { id: "leaked-docs-fixture", re: /transient What's New staged by the release workflow/i },
  { id: "test-fixture", re: /test fixture/i },
  { id: "placeholder", re: /\bplaceholder\b/i },
  { id: "lorem", re: /lorem ipsum/i },
  { id: "no-source-changes", re: /No source changes were recorded/i },
];

const VERSION_UNRESOLVED =
  "ERROR: Unable to resolve canonical release version. Publishing stopped.";

/** A real release version. Never 0.0.0, never an empty fallback. */
function requireReleaseVersion(version) {
  const clean = String(version || "")
    .trim()
    .replace(/^v/i, "");
  if (!clean || (!isStableVersion(clean) && !isTestVersion(clean))) {
    throw new Error(VERSION_UNRESOLVED);
  }
  const parsed = parseFridayVersion(clean);
  if (
    !parsed ||
    (parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0 && parsed.revision === 0)
  ) {
    throw new Error(VERSION_UNRESOLVED);
  }
  return parsed.raw;
}

function formatReleaseDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime()))
    throw new Error("ERROR: invalid release date. Publishing stopped.");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function isoDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime()))
    throw new Error("ERROR: invalid release date. Publishing stopped.");
  return d.toISOString().slice(0, 10);
}

function emptyChanges() {
  return {
    added: [],
    improved: [],
    fixed: [],
    changed: [],
    security: [],
    performance: [],
    removed: [],
    breaking: [],
    technical: [],
  };
}

function isIgnoredSubject(line) {
  const text = String(line || "").trim();
  if (!text) return true;
  if (/^Merge (branch|pull request|remote)/i.test(text)) return true;
  if (/^release: v?\d+\.\d+\.\d+(?:\.\d+)?/i.test(text)) return true;
  if (/^(chore|docs|ci|build)(\([^)]*\))?:\s*(bump|stamp|sync) versions?\b/i.test(text))
    return true;
  return false;
}

function stripDeveloperNoise(text) {
  return String(text || "")
    .replace(/\s*\(#[0-9]+\)/g, "")
    .replace(/\bPR\s*#\d+\b/gi, "")
    .replace(/\b(?:commit|sha)\s*[:`']?[0-9a-f]{7,40}[`']?/gi, "")
    .replace(/(^|[\s,;])[0-9a-f]{7,40}(?=$|[\s,;.])/gi, "$1")
    .replace(/`+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.,;:]+$/g, "");
}

function isImplementationDetail(text) {
  const line = String(text || "");
  if (/\b(?:src|electron|scripts|core|kernel|docs|config|installer|\.github)\/[\w./-]+/.test(line))
    return true;
  if (/\b[\w.-]+\.(ts|tsx|js|cjs|mjs|py|yml|yaml|json|md)\b/i.test(line)) return true;
  if (/\b\d+ files? changed\b/i.test(line)) return true;
  return false;
}

/** User-facing What's New must never look like a git log or pull-request list. */
function looksLikeCommitDump(text) {
  const line = String(text || "").trim();
  if (!line) return false;
  if (
    /^(feat|fix|chore|docs|ci|test|tests|build|refactor|perf|style|release|revert)(\([^)]*\))?:\s/i.test(
      line,
    )
  )
    return true;
  if (/\(#\d+\)/.test(line) || /\bPR\s*#\d+\b/i.test(line)) return true;
  if (/\bMerge (?:branch|pull request)\b/i.test(line)) return true;
  if (/\bpull request #\d+/i.test(line)) return true;
  return false;
}

/**
 * Dated GitHub/Windows proof. Heal must not rewrite these as if they belonged
 * to the next unpublished version (that is how AUDIT/README claimed v1.0.0.1
 * was verified while only v1.0.0.0 was published).
 */
function gitTagExists(version, { root = ROOT } = {}) {
  const v = String(version || "")
    .replace(/^v/i, "")
    .trim();
  if (!v || /[:\s]|^\.|^\-|\.\.|[\x00-\x1f]/.test(v)) return false;
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/v${v}`], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
    return true;
  } catch {
    return false;
  }
}

/** A VERSION_DOCS line that still says this version has no GitHub tag. */
function isUnpublishedClaimLine(line, version) {
  const v = String(version || "")
    .replace(/^v/i, "")
    .trim();
  if (!v) return false;
  const t = String(line || "");
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!t.includes(v)) return false;
  if (new RegExp(`\\bunpublished\\s+${esc}\\b`, "i").test(t)) return true;
  if (/\bno tag yet\b/i.test(t) && t.includes(v)) return true;
  if (/\bhas not tagged\b/i.test(t) && t.includes(v)) return true;
  if (/\bhas not created a GitHub release\b/i.test(t) && t.includes(v)) return true;
  if (/\bNOT PUBLISHED\b/.test(t) && t.includes(v)) return true;
  return false;
}

function repairUnpublishedClaimLine(line, version) {
  const v = String(version || "")
    .replace(/^v/i, "")
    .trim();
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = String(line || "");
  out = out.replace(
    new RegExp(`unpublished\\s+${esc}\\s*\\(no tag yet\\)`, "gi"),
    `published **${v}** (GitHub tag \`v${v}\`)`,
  );
  out = out.replace(
    new RegExp(`Official Publish has not tagged ${esc}`, "gi"),
    `Official Publish tagged ${v}`,
  );
  out = out.replace(/\bhas not created a GitHub release\b/gi, "has a published GitHub release");
  out = out.replace(
    new RegExp(`\\*\\*NOT VERIFIED\\*\\*\\s*\\(Official Publish has not tagged ${esc}\\)`, "gi"),
    `**VERIFIED** (GitHub tag \`v${v}\`)`,
  );
  out = out.replace(/\bNOT PUBLISHED\b/g, "PUBLISHED");
  out = out.replace(/— re-run Official Publish[^.\n]*/gi, `— GitHub tag \`v${v}\``);
  return out;
}

function repairUnpublishedClaims(text, version, { root = ROOT } = {}) {
  if (!gitTagExists(version, { root })) return String(text || "");
  return String(text || "")
    .split("\n")
    .map((line) =>
      isUnpublishedClaimLine(line, version) ? repairUnpublishedClaimLine(line, version) : line,
    )
    .join("\n");
}

function isPublishedEvidenceLine(line) {
  const t = String(line || "");
  if (!t.trim()) return false;
  if (/\bNOT PUBLISHED\b/.test(t) || /\bNOT VERIFIED\b/.test(t)) return true;
  if (/\blast published Official\b/i.test(t)) return true;
  if (/\bpublished Official tag remains\b/i.test(t)) return true;
  if (
    /\bVERIFIED\b/.test(t) &&
    /\b(?:published|windows-latest|Official Publish|Test EXE)\b/i.test(t)
  )
    return true;
  if (/\bOfficial Publish\b/.test(t) && /`?\d{8,}/.test(t)) return true;
  if (/\bTest EXE Build\b/.test(t) && /`?\d{8,}/.test(t)) return true;
  if (/\bPR Validation\b/.test(t) && /`?\d{8,}/.test(t)) return true;
  if (/\bGitHub tag\b/.test(t) && /\bv?\d+\.\d+\.\d+/.test(t)) return true;
  if (/\bPackaged identity\b/i.test(t)) return true;
  if (/FRIDAY\|[^\n]*\|\d+\.\d+/.test(t)) return true;
  if (/\binstaller smoke\b/i.test(t)) return true;
  if (
    /\bwindows-latest\b/i.test(t) &&
    /\b(?:published|FileVersion|FILEVERSION|Identity|installer smoke)\b/i.test(t)
  )
    return true;
  if (
    /\b(?:FILEVERSION|FileVersion|ProductVersion)\b/.test(t) &&
    /\b(?:published|windows-latest|Identity|verified)\b/i.test(t)
  )
    return true;
  return false;
}

function replaceVersionOutsideEvidence(text, from, to) {
  const source = String(from || "");
  const target = String(to || "");
  if (!source || source === target) return String(text || "");
  const rx = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return String(text || "")
    .split("\n")
    .map((line) => (isPublishedEvidenceLine(line) ? line : line.replace(rx, target)))
    .join("\n");
}

function toSentence(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const body = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

/**
 * Known FRIDAY product topics. Matched before a commit subject is used as a
 * What's New bullet, so Windows/update language stays owner-facing even when
 * the git subject names a workflow or script.
 */
const OWNER_TOPIC_RULES = [
  {
    id: "test-fileversion",
    re: /\b(?:fileversion|productversion|windows file version|shortversionwindows|brand-windows|aftersign)\b/i,
    category: "Fixed",
    text: "The test build now shows the same public version as the installed app. Its test label still shows which test build it is.",
  },
  {
    id: "official-publish-resume",
    re: /\b(?:verify-main|stale checkout|resume(?:s|d)?(?:\s+\w+){0,6}\s+publish|origin\/main)\b/i,
    category: "Fixed",
    text: "If a release stops halfway, starting it again continues from the current version.",
  },
  {
    id: "prepare-follow-version",
    re: /\b(?:prepare tests?|version-system-reset|windows-packaging-version).*(?:version|follow)|follow(?:s)? the current (?:public )?version/i,
    category: "Fixed",
    text: "A small fix can be published without the version step getting stuck.",
  },
  {
    id: "installer-downgrade",
    re: /\binstaller downgrade\b/i,
    category: "Fixed",
    text: "The installer no longer installs an older FRIDAY over a newer one.",
  },
  {
    id: "update-channel-switch",
    re: /\bupdate channel switch\b/i,
    category: "Added",
    text: "You can switch between the Stable and Test update channels from Settings.",
  },
  {
    id: "whats-new-owner-facing",
    re: /\b(?:what'?s new|owner-facing notes|human(?:-|\s)written notes)\b/i,
    category: "Improved",
    text: "What's New is written in plain language about what was added, improved, or fixed.",
  },
  {
    id: "heal-historical-evidence",
    re: /\b(?:historical evidence|published evidence|rewriteDeclarations)\b/i,
    category: "Fixed",
    text: "Older update notes stay as they were published, so a new version does not rewrite them.",
  },
];

const REPO_INTERNAL_RE =
  /\b(?:vitest|pytest|typecheck|eslint|prettier|docs-engine|release-engine|orchestrat(?:e|or)|workflow_dispatch|github actions|pr validation|safe merge|FRIDAY_STATE|cloud-agent)\b/i;

function matchOwnerTopic(text) {
  const line = String(text || "");
  for (const rule of OWNER_TOPIC_RULES) {
    if (rule.re.test(line)) return rule;
  }
  return null;
}

function isRepoInternalSubject(commit) {
  const type = String(commit?.type || "").toLowerCase();
  if (["chore", "test", "tests", "docs", "ci", "build", "style"].includes(type)) return true;
  const text = `${commit?.summary || ""} ${commit?.scope || ""}`;
  if (REPO_INTERNAL_RE.test(text)) return true;
  if (isImplementationDetail(text)) return true;
  return false;
}

function toOwnerFacingSentence(summary, commit) {
  const cleaned = stripDeveloperNoise(summary);
  if (!cleaned) return "";
  const topic = matchOwnerTopic(cleaned);
  if (topic) return topic.text;
  const add = /^(?:add|adds|added|introduce|introduces|introduced)\s+(.+)$/i.exec(cleaned);
  if (add) {
    const rest = add[1].replace(/^friday\s+/i, "");
    if (/^friday\b/i.test(add[1])) return toSentence(add[1]);
    return toSentence(`FRIDAY now includes ${rest}`);
  }
  const stop = /^(?:stop|stops|stopped|prevent|prevents|prevented)\s+(.+)$/i.exec(cleaned);
  if (stop) {
    const rest = stop[1].replace(/^the\s+/i, "");
    return toSentence(`${rest.charAt(0).toUpperCase()}${rest.slice(1)} is no longer allowed`);
  }
  const hasVerb =
    /^(add|fix|stop|make|allow|keep|use|show|hide|move|update|improve|remove|prevent|enable|disable|restore|resume|let|write|sync|gate|stamp|brand)\b/i.test(
      cleaned,
    );
  if (
    !hasVerb &&
    cleaned.split(/\s+/).length <= 8 &&
    (commit?.type === "feat" || commit?.category === "Added")
  ) {
    if (/^friday\b/i.test(cleaned)) return toSentence(cleaned);
    return toSentence(`FRIDAY now includes ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`);
  }
  return toSentence(cleaned);
}

function displayCategory(commit) {
  if (commit.breaking) return "Breaking Changes";
  if (
    /^(remove|removed|delete|drop)\b/i.test(commit.type) ||
    /^(remove|removed|delete|drop)\b/i.test(commit.summary)
  )
    return "Removed";
  if (commit.type === "feat" && /^(ui|ux|style)$/i.test(commit.scope)) return "Improved";
  if (commit.category === "Technical") return TECHNICAL_SECTION;
  if (/\bFRIDAY_STATE\b|\bdocs-engine\b|\brelease-engine\b/i.test(commit.summary))
    return TECHNICAL_SECTION;
  return commit.category || TECHNICAL_SECTION;
}

function toUserFacingItem(commit) {
  const text = stripDeveloperNoise(commit.summary);
  if (!text) return null;
  const topic = matchOwnerTopic(text);
  if (topic) {
    if (mentionsHousekeeping(topic.text)) return { drop: true };
    return { category: topic.category, text: topic.text, key: topic.id };
  }
  if (
    isRepoInternalSubject(commit) ||
    isImplementationDetail(text) ||
    looksLikeCommitDump(text) ||
    mentionsHousekeeping(text)
  ) {
    return { drop: true };
  }
  const category = displayCategory(commit);
  if (category === TECHNICAL_SECTION) return { drop: true };
  const sentence = toOwnerFacingSentence(text, commit);
  if (!sentence || looksLikeCommitDump(sentence) || mentionsHousekeeping(sentence)) {
    return { drop: true };
  }
  return { category, text: sentence, key: `${category}|${sentence.toLowerCase()}` };
}

function mentionsHousekeeping(text) {
  const line = String(text || "");
  if (/\b(?:pull request|github|repository)\b/i.test(line)) return true;
  if (/\b(?:workflow_dispatch|github actions|\.github)\b/i.test(line)) return true;
  return false;
}

function ownerIntro(clean, releaseLabel) {
  const kind =
    {
      "PATCH / FIX": "a small fix",
      "MINOR / CHANGES": "an update with changes",
      "MAJOR / FEATURE": "a larger update",
      "EXTREME / NEW GENERATION": "a new generation of FRIDAY",
    }[releaseLabel] || "an update";
  return `FRIDAY ${clean} is ${kind}. Here is what changed for you.`;
}

function joinAnd(parts) {
  const items = (parts || []).filter(Boolean);
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function shortLead(items, fallback) {
  const first = String(items?.[0] || "").replace(/[.]+$/g, "");
  const words = first.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 14) {
    if (/^FRIDAY\b/.test(first)) return first;
    return first.charAt(0).toLowerCase() + first.slice(1);
  }
  return fallback;
}

function userChangeItems(changes) {
  return USER_FACING_ORDER.flatMap((name) => changes[SECTION_TO_KEY[name]] || []);
}

function asSentence(text) {
  const body = String(text || "").trim();
  if (!body) return "";
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

function buildSummary(version, changes, { test } = {}) {
  const only = userChangeItems(changes);
  if (only.length === 1) return asSentence(only[0]);
  const phrases = [];
  if (changes.added.length) phrases.push(shortLead(changes.added, "new capabilities"));
  if (changes.improved.length) phrases.push("improvements");
  if (changes.fixed.length) phrases.push("reliability fixes");
  if (changes.changed.length) phrases.push("behaviour updates");
  if (changes.security.length) phrases.push("security hardening");
  if (changes.performance.length) phrases.push("performance improvements");
  if (changes.removed.length) phrases.push("removed items");
  if (changes.breaking.length) phrases.push("breaking changes");
  if (!phrases.length) {
    return test
      ? "Verification build of the current source — no new changes since the last release."
      : STEADY_UPDATE;
  }
  const verb = changes.added.length ? "adds" : "includes";
  return `FRIDAY ${version} ${verb} ${joinAnd(phrases)}.`;
}

function extractNotesVersion(text) {
  const m = String(text || "").match(new RegExp(`^##\\s+(?:FRIDAY\\s+)?v?(${VERSION_FULL})`, "m"));
  return m ? m[1] : "";
}

function extractChangelogVersion(text) {
  const m = String(text || "").match(new RegExp(`^## v(${VERSION_FULL})\\s*$`, "m"));
  return m ? m[1] : "";
}

function sectionsFromChanges(changes) {
  return ORDER.filter((name) => (changes[SECTION_TO_KEY[name]] || []).length).map((name) => ({
    name,
    items: changes[SECTION_TO_KEY[name]].slice(),
  }));
}

/** A commit subject line -> { type, breaking, scope, summary, category }. */
function classify(subject) {
  const line = String(subject || "").trim();
  const header = line.match(/^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i);
  const breaking =
    Boolean(header?.[3]) || /\bBREAKING[ -]CHANGE\b/i.test(line) || /^breaking\b/i.test(line);
  const type = header ? header[1].toLowerCase() : "";
  const summary = header ? header[4].trim() : line;
  const probe = header ? `${type}: ${summary}` : line;
  const category =
    (CATEGORIES.find(([, re]) => re.test(probe)) || [])[0] || (breaking ? "Changed" : "Technical");
  return {
    type,
    breaking,
    scope: header?.[2] ? header[2].slice(1, -1) : "",
    summary,
    category,
  };
}

/**
 * Which increment the real changes deserve.
 *
 * Conventional signals map onto the public four-part levels:
 *   • fix/chore/docs/ci/build/perf/refactor  -> PATCH / FIX (patch)
 *   • "feat: …" / grouped meaningful change  -> MINOR / CHANGES (minor)
 *   • significant capability / breaking API  -> MAJOR / FEATURE (major)
 * Extreme Update is never inferred from commit prefixes.
 * Unclassified subjects are ambiguous and never choose a bump on their own.
 */
function detectBump(subjects) {
  const commits = (subjects || []).map(classify);
  if (commits.some((c) => c.breaking)) return "major";
  if (commits.some((c) => c.type && c.category === "Added")) return "minor";
  return "patch";
}

function classifiedSubjects(subjects) {
  return (subjects || []).filter((line) => {
    const item = classify(line);
    return Boolean(item.type || item.breaking);
  });
}

/**
 * Auto classification on the four-part line uses the same names as explicit
 * --type: patch, minor, major. Extreme is never selected automatically —
 * even a BREAKING CHANGE footer becomes MAJOR / FEATURE. Unknown kinds fail
 * closed (null) instead of guessing extreme or a new generation.
 */
function bumpKindForScheme(kind, previous) {
  const parsed = parseFridayVersion(previous);
  const level = normalizeReleaseType(kind);
  if (level === "rebuild" || level === "auto" || !level) return kind;
  if (level === "extreme") return parsed?.fourPart ? "major" : "major";
  return level;
}

/**
 * Resolve the bump that plan / decide / nextVersion will apply.
 * Explicit --type wins. Auto never returns extreme. All-unclassified subjects
 * fail closed instead of guessing.
 */
function resolveBump({ previous, type = "auto", subjects = [] } = {}) {
  const requested = normalizeReleaseType(type);
  if (type && type !== "auto" && requested === null) {
    return {
      ok: false,
      bump: null,
      error: `unknown release type "${type}" — use auto, patch, minor, major, extreme, revision, or rebuild`,
    };
  }
  if (requested && requested !== "auto") {
    if (requested === "rebuild") {
      return { ok: true, bump: "rebuild", auto: false };
    }
    return { ok: true, bump: requested, auto: false };
  }
  const classified = classifiedSubjects(subjects);
  const ambiguous = ambiguousSubjects(subjects);
  if ((subjects || []).filter(Boolean).length && !classified.length && ambiguous.length) {
    return {
      ok: false,
      bump: null,
      auto: true,
      ambiguous,
      error:
        "commit subjects are unclassified, so auto will not guess a release level — choose patch, minor, major, or extreme explicitly",
    };
  }
  if (!classified.length) {
    return { ok: true, bump: "patch", auto: true, ambiguous };
  }
  const detected = detectBump(classified);
  const bump = bumpKindForScheme(detected, previous);
  if (bump === "extreme") {
    return { ok: true, bump: "major", auto: true, ambiguous };
  }
  return { ok: true, bump, auto: true, ambiguous };
}

/** Subjects with no conventional header — reported, never used to bump. */
const ambiguousSubjects = (subjects) =>
  (subjects || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .filter((line) => !/^Merge (branch|pull request|remote)/i.test(line))
    .filter((line) => !/^release: v?\d+\.\d+\.\d+(?:\.\d+)?/i.test(line))
    .filter((line) => !classify(line).type && !classify(line).breaking);

/** Group commits into the release-note sections, dropping noise + duplicates. */
function groupChanges(subjects) {
  const groups = new Map();
  const seen = new Set();
  let droppedInternal = false;
  for (const subject of subjects || []) {
    const line = String(subject || "").trim();
    if (isIgnoredSubject(line)) continue;
    const item = toUserFacingItem(classify(line));
    if (!item || item.drop || item.category === TECHNICAL_SECTION) {
      droppedInternal = true;
      continue;
    }
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item.text);
  }
  const hasUser = USER_FACING_ORDER.some((name) => groups.get(name)?.length);
  if (!hasUser && droppedInternal) groups.set("Improved", [STEADY_UPDATE]);
  return ORDER.filter((name) => groups.get(name)?.length).map((name) => ({
    name,
    items: groups.get(name),
  }));
}

function changesFromSections(sections) {
  const changes = emptyChanges();
  for (const section of sections || []) {
    const key = SECTION_TO_KEY[section.name];
    if (key) changes[key] = (section.items || []).slice();
  }
  return changes;
}

/**
 * Canonical What's New data. GitHub, CHANGELOG, releases/notes, README and the
 * in-app preview all render from this object — never from a second generator.
 */
function buildCanonicalRelease({
  version,
  previous = null,
  subjects = [],
  channel = "stable",
  ref = "",
  commit = "",
  date = new Date(),
  extra = "",
  sections = null,
  releaseType = null,
} = {}) {
  const clean = requireReleaseVersion(version);
  const test = channel === "test" || isTestVersion(clean);
  const grouped = sections || groupChanges(subjects);
  const changes = changesFromSections(grouped);
  const breaking = (subjects || []).map(classify).filter((c) => c.breaking);
  const previousVersion = previous ? String(previous).trim().replace(/^v/i, "") : null;
  const requested = normalizeReleaseType(releaseType);
  const prevParsed = previousVersion ? parseFridayVersion(previousVersion) : null;
  const nextParsed = parseFridayVersion(clean);
  const inferred =
    prevParsed?.fourPart && nextParsed?.fourPart ? inferReleaseType(previousVersion, clean) : null;
  const resolvedType =
    requested && requested !== "auto"
      ? requested
      : inferred && inferred !== "rebuild"
        ? inferred
        : null;
  const releaseLabel = releaseTypeLabel(resolvedType);
  const intro = test ? "" : ownerIntro(clean, releaseLabel);
  return {
    version: clean,
    tag: `v${clean}`,
    releasedAt: isoDate(date),
    releasedOn: formatReleaseDate(date),
    channel: test ? "test" : "stable",
    releaseType: resolvedType || null,
    releaseLabel,
    previousVersion: previousVersion || null,
    summary: buildSummary(clean, changes, { test }),
    intro,
    changes,
    importantNotes: [
      ...(breaking.length
        ? [
            `Breaking change: ${breaking.map((c) => stripDeveloperNoise(c.summary) || c.summary).join("; ")}.`,
          ]
        : []),
      test
        ? "Your FRIDAY data remains preserved — a test build never replaces chats, memory, settings, credentials, models or runtimes."
        : "Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.",
      "Downloads are verified against the published SHA-256 before installation.",
    ],
    test: test ? { ref: String(ref || ""), commit: String(commit || "") } : null,
    extra: String(extra || "").trim(),
    source: "generated",
  };
}

function renderCanonical(data) {
  const test = data.channel === "test";
  const lines = [];
  lines.push(`## FRIDAY v${data.version}${test ? " — TEST BUILD" : ""}`);
  lines.push("");
  lines.push(
    ...[
      `**Released:** ${data.releasedOn}  `,
      `**Channel:** ${
        test ? "TEST (pre-release — never installed automatically)" : "Stable (official release)"
      }  `,
      data.releaseLabel && data.releaseType && data.releaseType !== "rebuild"
        ? `**Release type:** ${data.releaseLabel}  `
        : "",
      data.previousVersion
        ? `**Changes since:** v${data.previousVersion}  `
        : `**Baseline:** first public version  `,
      `**Summary:** ${data.summary}`,
    ].filter(Boolean),
  );
  lines.push("");

  if (test) {
    lines.push("**This is a TEST build, not an official release.**", "");
    if (data.test?.ref)
      lines.push(
        `- Built from: ${data.test.ref}${data.test.commit ? ` @ ${data.test.commit}` : ""}`,
      );
    lines.push(
      "- Portable: it runs without installing and keeps its own state in `<FRIDAY_ROOT>/profiles/test/`,",
      "  while reusing the models, voices, Python runtime and assets already in your FRIDAY_ROOT.",
      "- Install it explicitly from FRIDAY → Settings → Updates → Test channel.",
      "",
    );
  }

  if (data.kind === "baseline") {
    lines.push("### Baseline", "");
    lines.push(
      "This is the first public version of FRIDAY.",
      "",
      "The capabilities below are part of this first version. They are not claimed as work added after it.",
      "",
      "### Included",
      "",
    );
    const groups = data.includedGroups?.length
      ? data.includedGroups
      : [{ heading: "Included", items: data.included || [] }];
    for (const group of groups) {
      if (group.heading && group.heading !== "Included") {
        lines.push(`#### ${group.heading}`, "");
      }
      for (const item of group.items || []) lines.push(`- ${item}`);
      lines.push("");
    }
    lines.push("### Important Notes", "");
    for (const note of data.importantNotes || []) lines.push(`- ${note}`);
    lines.push("");
    if (data.extra) lines.push(String(data.extra).trim(), "");
    return `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`;
  }

  lines.push("### What's New", "");
  if (data.intro) {
    lines.push(String(data.intro).trim(), "");
  }
  const userSections = USER_FACING_ORDER.filter(
    (name) => (data.changes[SECTION_TO_KEY[name]] || []).length,
  );
  if (userSections.length) {
    const areas = new Map();
    const leftover = new Map();
    for (const name of userSections) {
      for (const item of data.changes[SECTION_TO_KEY[name]]) {
        const area = areaName(item);
        if (area) {
          if (!areas.has(area)) areas.set(area, []);
          areas.get(area).push(item);
        } else {
          if (!leftover.has(name)) leftover.set(name, []);
          leftover.get(name).push(item);
        }
      }
    }
    for (const area of STORE_AREAS) {
      const items = areas.get(area.name);
      if (!items?.length) continue;
      lines.push(`#### ${area.name}`);
      for (const item of items) lines.push(`- ${item}`);
      lines.push("");
    }
    for (const name of USER_FACING_ORDER) {
      const items = leftover.get(name);
      if (!items?.length) continue;
      lines.push(`#### ${name}`);
      for (const item of items) lines.push(`- ${item}`);
      lines.push("");
    }
  } else {
    lines.push(
      "#### Improved",
      test
        ? "- Verification build of the current source — no new changes since the last release."
        : `- ${STEADY_UPDATE}`,
      "",
    );
  }

  lines.push("### Important Notes", "");
  for (const note of data.importantNotes || []) lines.push(`- ${note}`);
  lines.push("");
  if (data.extra) lines.push(String(data.extra).trim(), "");
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Markdown "What's New" from pre-grouped sections (same canonical renderer). */
function renderNotes({ version, previous, sections, date = new Date(), channel = "stable" }) {
  return renderCanonical(
    buildCanonicalRelease({ version, previous, sections, date, channel, subjects: [] }),
  );
}

/**
 * The single "What's New" renderer used by BOTH published channels — the
 * official release workflow and the TEST prerelease — so GitHub, CHANGELOG,
 * releases/notes, README and the in-app preview can never disagree.
 */
function whatsNew(opts = {}) {
  return renderCanonical(buildCanonicalRelease(opts));
}

/** Store-style areas. A bullet lands here when it names the part of FRIDAY it changes. */
const STORE_AREAS = [
  { name: "Flow Studio", re: /\b(flow studio|diagram|wire chart|workflow runner)\b/i },
  { name: "Voice", re: /\b(voice|wake word|microphone|spoken|speech|auto mode)\b/i },
  { name: "Chat", re: /\b(chat|conversation|message)\b/i },
  { name: "Brain", re: /\b(brain|memor(?:y|ies)|claim|retriev)\b/i },
  { name: "Models", re: /\b(model|provider)\b/i },
  { name: "Desktop", re: /\b(desktop|window|installer|portable)\b/i },
  { name: "Updates", re: /\b(update channel|packag|version number)\b/i },
  { name: "Safety", re: /\b(privacy|permission|billing|firewall)\b/i },
];

function areaName(text) {
  const line = String(text || "");
  for (const area of STORE_AREAS) {
    if (area.re.test(line)) return area.name;
  }
  return "";
}

function isNotesHeading(section) {
  return (
    USER_FACING_ORDER.includes(section) ||
    STORE_AREAS.some((area) => area.name === section) ||
    section === "Included" ||
    section === "Baseline" ||
    BASELINE_INCLUDED_HEADINGS.includes(section)
  );
}

function userFacingBullets(text) {
  const body = String(text || "");
  const start = body.search(/^### (?:What's New|Baseline|Included)\s*$/m);
  if (start < 0) return [];
  const rest = body.slice(start);
  const endMatch = rest.search(/^### Important Notes\s*$/m);
  const block = endMatch >= 0 ? rest.slice(0, endMatch) : rest;
  const bullets = [];
  let section = "";
  for (const line of block.split("\n")) {
    const heading = /^#{2,4}\s+(.+)\s*$/.exec(line);
    if (heading && !/^(What's New|Baseline|Included)$/i.test(heading[1].trim())) {
      section = heading[1].trim();
      continue;
    }
    if (heading && /^(Included|Baseline)$/i.test(heading[1].trim())) {
      section = heading[1].trim();
      continue;
    }
    const item = /^- (.+)$/.exec(line);
    if (item && section && section !== TECHNICAL_SECTION && isNotesHeading(section))
      bullets.push(item[1]);
  }
  return bullets;
}

const BASELINE_INCLUDED_GROUPS = [
  {
    heading: "Core",
    items: [
      "A desktop app on this PC, with its own local service",
      "Your chats, settings, and files stay in one FRIDAY folder, and the app checks that it is ready to use",
    ],
  },
  {
    heading: "AI & Brain",
    items: [
      "You can talk with FRIDAY, and it keeps the thread of the conversation",
      "Local models and cloud models are both available, and you choose which one answers",
      "Paid cloud models stay off until you turn them on",
    ],
  },
  {
    heading: "Memory",
    items: [
      "FRIDAY remembers across conversations, on this PC",
      "Those memories stay in your FRIDAY folder",
    ],
  },
  {
    heading: "Voice",
    items: [
      "Auto Mode and Manual Mode with the same approval rules as typed chat",
      "Wake word, speech to text, and spoken replies are included. A real microphone has not been checked on a Windows PC",
    ],
  },
  {
    heading: "Capabilities",
    items: [
      "Tools, skills, agents, plugins, and workflows",
      "Browser, terminal, devices, tasks, and a safe place to try things",
    ],
  },
  {
    heading: "Tools & Automation",
    items: [
      "Setup, install help, diagnostics, and self-repair",
      "A personal desk for everyday work is already included",
    ],
  },
  {
    heading: "Security",
    items: [
      "Permission tiers, privacy firewall, billing firewall and safety gates",
      "Updates are checked before they install, and you can roll back. Your data is not reset by a version number",
    ],
  },
  {
    heading: "Installation & Updates",
    items: [
      "Windows installer and a portable app. Uninstall can keep your data, or you can choose to delete all of it",
      "Stable and Test update channels, so a test build can sit beside the app you use every day",
    ],
  },
  {
    heading: "Developer/Platform Support",
    items: [
      "The Windows installer, the portable app, and update checks ship with this first version",
      "Documentation stays with the version you install",
    ],
  },
];
const BASELINE_INCLUDED_HEADINGS = BASELINE_INCLUDED_GROUPS.map((group) => group.heading);
const BASELINE_INCLUDED = BASELINE_INCLUDED_GROUPS.flatMap((group) => group.items);

function buildBaselineRelease({ version, date = new Date() } = {}) {
  const identity = identityFromParsed(parseFridayVersion(requireReleaseVersion(version)), {
    forceFourPart: true,
  });
  return {
    kind: "baseline",
    version: identity.releaseVersion,
    tag: identity.tag,
    releasedAt: isoDate(date),
    releasedOn: formatReleaseDate(date),
    channel: "stable",
    previousVersion: null,
    summary: "FRIDAY 1.0.0.0 is the first public version.",
    changes: emptyChanges(),
    included: BASELINE_INCLUDED.slice(),
    includedGroups: BASELINE_INCLUDED_GROUPS.map((group) => ({
      heading: group.heading,
      items: group.items.slice(),
    })),
    importantNotes: [
      "This is FRIDAY 1.0.0.0, the first public version: the complete app as it exists now.",
      "The capabilities above are part of this first version.",
      "Your FRIDAY data, settings, memory, models, connectors and workflows are not reset by this version number.",
      "Downloads are verified against the published SHA-256 before installation.",
    ],
    test: null,
    extra: "",
    source: "baseline",
  };
}

function baselineWhatsNew(opts = {}) {
  return renderCanonical(buildBaselineRelease(opts));
}

function nextVersion(previous, kind = "auto", subjects = []) {
  const resolved = resolveBump({ previous, type: kind, subjects });
  if (!resolved.ok) {
    const error = new Error(resolved.error);
    error.code = "AMBIGUOUS_RELEASE_TYPE";
    throw error;
  }
  const bump = resolved.bump;
  const version = bumpVersion(previous, bump);
  return { previous, bump, version, tag: `v${version}`, releaseType: bump };
}

/**
 * Fail closed before a GitHub Release body, changelog entry or notes file is
 * published. Never lets v0.0.0, the docs-registry fixture, or an empty body
 * reach the owner.
 */
function assertPublishableNotes(
  body,
  { version, channel = "stable", requireChanges = true, source = "generated" } = {},
) {
  const text = String(body || "");
  const issues = [];
  const expected = requireReleaseVersion(version);
  if (!text.trim()) issues.push("release notes are empty");
  const found = extractNotesVersion(text);
  if (!found) issues.push("What's New does not declare a version");
  else if (found !== expected)
    issues.push(`What's New version ${found} does not match release version ${expected}`);
  for (const pattern of FORBIDDEN_NOTE_PATTERNS) {
    if (pattern.re.test(text)) issues.push(`forbidden placeholder/test content (${pattern.id})`);
  }
  const official = channel !== "test" && !isTestVersion(expected);
  const markedTest = /^## FRIDAY v\S+ — TEST BUILD\s*$/m.test(text);
  if (official && markedTest) issues.push("official release notes must not be marked TEST");
  if (!official && channel === "test" && !markedTest)
    issues.push("TEST release notes must say FRIDAY TEST BUILD");
  if (mentionsHousekeeping(text) || /^#### Technical \/ Internal\s*$/m.test(text))
    issues.push(
      "user-facing notes must not mention pull requests, the repository, or internal files",
    );
  for (const bullet of userFacingBullets(text)) {
    if (isImplementationDetail(bullet) || mentionsHousekeeping(bullet))
      issues.push(`user-facing notes must not list implementation paths (${bullet})`);
    if (looksLikeCommitDump(bullet))
      issues.push(`user-facing notes must not be a commit or pull-request dump (${bullet})`);
  }
  const hasUser = userFacingBullets(text).length > 0;
  const hasMaintenance =
    /refreshes how FRIDAY is packaged|Verification build of the current source/i.test(text);
  if (requireChanges && !hasUser && !hasMaintenance) {
    issues.push("empty release notes");
  }
  if (source === "owner" && !text.trim())
    issues.push("empty owner override cannot replace generated notes");
  if (issues.length) {
    const error = new Error(`ERROR: ${issues.join("; ")}. Publishing stopped.`);
    error.issues = issues;
    throw error;
  }
  return { ok: true, version: expected, source };
}

function validateOwnerOverride(text, { version, channel = "stable" } = {}) {
  const body = String(text || "").trim();
  if (!body) {
    throw new Error(
      "ERROR: empty owner override cannot replace generated notes. Publishing stopped.",
    );
  }
  return assertPublishableNotes(body, { version, channel, source: "owner", requireChanges: true });
}

function guardPublishableRelease({
  version,
  body,
  packageVersion = "",
  changelog = "",
  notesFileBody = "",
  tag = "",
  setup = "",
  channel = "stable",
  requireChanges = true,
} = {}) {
  const expected = requireReleaseVersion(version);
  const parsed = parseFridayVersion(expected);
  const identity = parsed
    ? identityFromParsed(parsed, { forceFourPart: parsed.fourPart || undefined })
    : null;
  const issues = [];
  try {
    assertPublishableNotes(body, { version: expected, channel, requireChanges });
  } catch (error) {
    issues.push(...(error.issues || [error.message]));
  }
  const pairs = [
    ["package.json", packageVersion],
    ["GitHub tag", tag],
    ["CHANGELOG", extractChangelogVersion(changelog)],
    ["releases/notes", extractNotesVersion(notesFileBody || body)],
  ];
  for (const [label, value] of pairs) {
    if (!value) continue;
    const clean = String(value).replace(/^v/i, "");
    if (
      label === "package.json" &&
      identity &&
      (clean === expected || clean === identity.npmVersion)
    )
      continue;
    if (clean !== expected) issues.push(`${label} is ${clean}, expected ${expected}`);
  }
  if (setup) {
    const name = String(setup).split(/[/\\]/).pop() || "";
    if (!name.includes(expected))
      issues.push(`EXE artifact ${name} does not include version ${expected}`);
  }
  if (issues.length) {
    const error = new Error(`ERROR: ${issues.join("; ")}. Publishing stopped.`);
    error.issues = issues;
    throw error;
  }
  return { ok: true, version: expected };
}

/**
 * Resolve the git range for a release without ever walking the whole history
 * when a previous stable version exists.
 */
function resolveCommitRange({ previous, head = "HEAD", root = ROOT } = {}) {
  const { execFileSync } = require("node:child_process");
  const prev = String(previous || "")
    .trim()
    .replace(/^v/i, "");
  const missing =
    "ERROR: Unable to resolve the previous stable release commit. Refusing to describe the whole history as this release. Publishing stopped.";
  if (!prev || prev === "0.0.0") return { ok: false, range: "", subjects: [], error: missing };
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return "";
    }
  };
  const rev = (ref) => run(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  let from = rev(`v${prev}`) || rev(prev);
  if (!from) from = run(["log", "-1", "--format=%H", `--grep=^release: v${prev}$`]);
  if (!from) return { ok: false, range: "", from: "", head, subjects: [], error: missing };
  const range = `${from}..${head}`;
  const out = run(["log", "--no-merges", "--pretty=%s", range]);
  const subjects = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, range, from, head, subjects, error: "" };
}

/**
 * Full ordering including FRIDAY test prereleases:
 *   1.3.1 < 1.3.2-test.1 < 1.3.2-test.2 < 1.3.2
 * `compareVersions` deliberately ignores the prerelease part (it answers "which
 * version line is newer"); this answers "which exact build is newer".
 */
function compareBuilds(a, b) {
  const base = compareVersions(a, b);
  if (base !== 0) return base;
  const ia = testIteration(a);
  const ib = testIteration(b);
  if (ia === ib) return 0;
  if (!ia) return 1; // an official build outranks its own prereleases
  if (!ib) return -1;
  return ia - ib;
}

/**
 * PowerShell FileVersionInfo.FileVersion on windows-latest omits a trailing
 * `.0` when FilePrivatePart is 0: public 1.0.0.0 is reported as "1.0.0"
 * (PR Validation 33888385242, after a second rcedit version-string pass).
 * ProductVersion and the binary FILEVERSION still carry the four-part
 * identity; those are checked separately. This is not npm encoding.
 */
function fileVersionStringMatches(seen, expected) {
  const a = String(seen || "")
    .replace(/\0/g, "")
    .trim();
  const b = String(expected || "")
    .replace(/\0/g, "")
    .trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return /^\d+\.\d+\.\d+\.0$/.test(b) && a === b.slice(0, -2);
}

/**
 * The CANONICAL CHANGELOG heading of this repository.
 *
 * CHANGELOG.md always uses `## vX.Y.Z` - nothing else. The published GitHub
 * release keeps its friendlier "FRIDAY vX.Y.Z" title, but the changelog is a
 * machine-verified document (core/__tests__/version-sync.test.ts) and must not
 * drift with the presentation of the release page.
 */
const changelogHeading = (version) => `## v${String(version || "").replace(/^v/i, "")}`;

/**
 * Public versions already written up in CHANGELOG.md.
 *
 * Headings are the written history. They are not a successful publish.
 * A version advances only when a tag or GitHub release exists. Headings
 * newer than `atOrBelow` are ignored so a prepared version cannot count
 * itself as already released.
 */
function changelogShippedVersions(body, { atOrBelow = "" } = {}) {
  const keys = [
    ...String(body || "").matchAll(new RegExp(`^## v(${VERSION_FULL})\\s*$`, "gm")),
  ].map((m) => m[1]);
  const unique = [...new Set(keys)].filter((v) => isStableVersion(v) && !isTestVersion(v));
  const cap = String(atOrBelow || "")
    .trim()
    .replace(/^v/i, "");
  if (!cap || !isStableVersion(cap)) return unique;
  return unique.filter((v) => compareVersions(v, cap) <= 0);
}

/**
 * Commit subjects since a public line that CHANGELOG.md already shipped,
 * when this clone has no tag for it. The product history before that line
 * is the changelog, not this git history, so these subjects are the delta.
 * Returns ok:false when the line is not in the changelog, so a first
 * unpublished version still confirms without a commit list.
 */
function commitsSinceShipped(previous, { root = ROOT } = {}) {
  const prev = String(previous || "")
    .trim()
    .replace(/^v/i, "");
  const changelogFile = path.join(root, "CHANGELOG.md");
  if (!prev || !isStableVersion(prev) || !fs.existsSync(changelogFile)) {
    return { ok: false, subjects: [] };
  }
  const shipped = changelogShippedVersions(fs.readFileSync(changelogFile, "utf8"), {
    atOrBelow: prev,
  });
  if (!shipped.includes(prev)) return { ok: false, subjects: [] };
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["log", "--no-merges", "--pretty=%s", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const subjects = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: subjects.length > 0, subjects };
  } catch {
    return { ok: false, subjects: [] };
  }
}

/**
 * Turn generated release notes into a CHANGELOG entry: the presentation title
 * (`## FRIDAY v1.4.2 — TEST BUILD`) is rewritten to the canonical heading, the
 * body is kept exactly as generated.
 */
function changelogEntry(notes, version = "") {
  const body = String(notes || "").trim();
  const first = body.split("\n")[0] || "";
  const found = first.match(new RegExp(`^#{1,3}\\s*(?:FRIDAY\\s+)?v?(${VERSION_FULL})`, "i"));
  const clean = String(version || found?.[1] || "").replace(/^v/i, "");
  if (!clean) return body;
  const heading = changelogHeading(clean);
  if (found) return [heading, ...body.split("\n").slice(1)].join("\n").trim();
  return `${heading}\n\n${body}`;
}

/**
 * Keep one body per `## vX.Y.Z` heading. Duplicate release-engine prepends
 * used to leave several 1.6.x blocks; the more specific write-up (Fixed /
 * Improved) outranks a later "Changes / Work in progress" stub.
 */
function changelogVersionKey(headingLine) {
  const m = String(headingLine || "").match(new RegExp(`^## v(${VERSION_FULL})\\s*$`));
  return m ? m[1] : "";
}

function changelogSectionScore(section) {
  const text = String(section || "");
  let score = text.length;
  if (/^#### Fixed\b/m.test(text)) score += 50_000;
  if (/^#### Improved\b/m.test(text)) score += 20_000;
  if (/Work in progress/i.test(text) && /^- Changes$/m.test(text)) score -= 10_000;
  return score;
}

function splitChangelogSections(rest) {
  const text = String(rest || "").trim();
  if (!text) return [];
  const parts = text.split(/^(?=## v)/m);
  return parts.map((p) => p.replace(/\s+$/, "")).filter(Boolean);
}

function dedupeChangelogRest(rest) {
  const best = new Map();
  for (const section of splitChangelogSections(rest)) {
    const first = section.split("\n")[0] || "";
    const key = changelogVersionKey(first);
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || changelogSectionScore(section) > changelogSectionScore(prev))
      best.set(key, section);
  }
  return [...best.entries()]
    .sort((a, b) => compareVersions(b[0], a[0]) || 0)
    .map(([, section]) => section)
    .join("\n\n");
}

function uniqueChangelogHeadings(body) {
  const keys = [
    ...String(body || "").matchAll(new RegExp(`^## v(${VERSION_FULL})\\s*$`, "gm")),
  ].map((m) => m[1]);
  return { keys, unique: keys.length === new Set(keys).size };
}

/**
 * Header fragments that must never become part of a version section.
 * A longer intro (epoch/legacy explanation) used to survive `changelogRest`
 * and attach to `## v1.0.0.0`.
 */
const CHANGELOG_HEADER_LEAKS = [
  /What changed in each released version/i,
  /Generated by the release workflow/i,
  /The newest section is the current public line/i,
];

/**
 * The `## vX.Y.Z` body of CHANGELOG.md without the file header.
 * Everything before the first version heading is intro and is discarded —
 * a header-only changelog must not leak that line into the first entry,
 * and extra intro paragraphs must not attach to `## vX.Y.Z`.
 */
function changelogRest(body) {
  const existing = String(body || "").trim();
  const heading = existing.match(/^## v/m);
  if (heading && heading.index !== undefined) return existing.slice(heading.index).trim();
  if (existing.startsWith("# FRIDAY")) {
    return existing
      .split("\n")
      .slice(1)
      .join("\n")
      .replace(/^\s*What changed in each[^\n]*(\n|$)/, "")
      .trim();
  }
  return existing;
}

function changelogSectionFor(body, version) {
  const clean = String(version || "").replace(/^v/i, "");
  return (
    splitChangelogSections(changelogRest(body)).find(
      (section) => changelogVersionKey(section.split("\n")[0] || "") === clean,
    ) || ""
  );
}

/** Add (or replace) a release entry in CHANGELOG.md without losing earlier history. */
function updateChangelog(body, entry, version = "") {
  const header =
    "# FRIDAY — Changelog\n\nWhat changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.\n";
  const rest = changelogRest(body);
  // The freshly generated entry is authoritative for its own version: preparing
  // (or re-preparing) a version replaces its section in place instead of leaving
  // a second `## vX.Y.Z` heading behind. Every earlier version is preserved and
  // still deduplicated, and the whole log stays ordered newest-first.
  const entrySection = changelogEntry(entry, version);
  const entryKey = changelogVersionKey(entrySection.split("\n")[0] || "");
  const previousSections = splitChangelogSections(rest).filter(
    (section) => !entryKey || changelogVersionKey(section.split("\n")[0] || "") !== entryKey,
  );
  const cleaned = dedupeChangelogRest([entrySection, ...previousSections].join("\n\n"));
  return `${header}\n${cleaned ? `${cleaned}\n` : ""}`;
}

// ---- plan / apply ----------------------------------------------------------

function plan({ previous, type = "auto", subjects = [], date = new Date() }) {
  const resolved = resolveBump({ previous, type, subjects });
  if (!resolved.ok) {
    return {
      previous: previous || null,
      bump: null,
      auto: true,
      ok: false,
      error: resolved.error,
      ambiguous: resolved.ambiguous || ambiguousSubjects(subjects),
      safeDefault: false,
      version: null,
      tag: null,
      commits: subjects.length,
      sections: groupChanges(subjects),
      canonical: null,
      notes: "",
    };
  }
  const kind = resolved.bump;
  const version = bumpVersion(previous || "0.0.0", kind);
  const sections = groupChanges(subjects);
  const ambiguous = resolved.ambiguous || ambiguousSubjects(subjects);
  return {
    previous: previous || null,
    bump: kind,
    auto: Boolean(resolved.auto),
    ok: true,
    ambiguous,
    safeDefault: Boolean(resolved.auto) && kind === "patch",
    version,
    tag: `v${version}`,
    commits: subjects.length,
    sections,
    releaseType: kind,
    releaseLabel: releaseTypeLabel(kind),
    canonical: buildCanonicalRelease({
      version,
      previous,
      subjects,
      date,
      channel: "stable",
      releaseType: kind,
    }),
    notes: whatsNew({
      version,
      previous,
      subjects,
      date,
      channel: "stable",
      releaseType: kind,
    }),
  };
}

/**
 * A public number is consumed only by a successful publish (a stable tag or
 * GitHub release in `released`). A changelog heading written during prepare
 * is not a publish.
 *
 * When `declared` is ahead of the last successful release:
 *   same release type (or auto) keeps that unpublished number;
 *   a different explicit type skips it and bumps from the last success.
 */
function unpublishedRetry({ declared, baseline, released = [], type = "auto" } = {}) {
  const current = String(declared || "")
    .trim()
    .replace(/^v/i, "");
  const published = (released || [])
    .map((value) =>
      String(value || "")
        .trim()
        .replace(/^v/i, ""),
    )
    .filter((value) => isStableVersion(value) && !isTestVersion(value));
  if (!isStableVersion(current) || published.includes(current)) {
    return { unpublished: false, reuse: false, base: current, failedType: null };
  }
  const prior = published
    .filter((value) => compareVersions(value, current) < 0)
    .sort((a, b) => compareVersions(b, a))[0];
  const given = String(baseline || "")
    .trim()
    .replace(/^v/i, "");
  const base =
    prior || (given && isStableVersion(given) && compareVersions(current, given) > 0 ? given : "");
  if (!base) {
    return { unpublished: true, reuse: true, base: current, failedType: null };
  }
  const failedType = inferReleaseType(base, current);
  const requested = normalizeReleaseType(type);
  const reuse =
    !requested ||
    requested === "auto" ||
    requested === "rebuild" ||
    !failedType ||
    failedType === "rebuild" ||
    requested === failedType;
  return { unpublished: true, reuse, base, failedType, requested };
}

function decisionForUnpublished({ declared, baseline, released, type }) {
  const retry = unpublishedRetry({ declared, baseline, released, type });
  if (!retry.unpublished) return null;
  if (retry.reuse) {
    const kind = retry.failedType && retry.failedType !== "rebuild" ? retry.failedType : null;
    return {
      action: "update",
      version: declared,
      tag: `v${declared}`,
      bump: "none",
      releaseType: "none",
      releaseLabel: null,
      existing: false,
      reason: kind
        ? `v${declared} has not been published — a ${releaseTypeLabel(kind) || kind} run keeps that version until a GitHub release exists`
        : `main already declares unreleased v${declared} — releasing the declared version instead of bumping again`,
    };
  }
  const resolved = resolveBump({ previous: retry.base, type, subjects: [] });
  if (!resolved.ok) return { action: "error", reason: resolved.error };
  const bump = resolved.bump;
  const version = bumpVersion(retry.base, bump);
  const published = (released || []).map((value) =>
    String(value || "")
      .trim()
      .replace(/^v/i, ""),
  );
  if (published.includes(version)) {
    return {
      action: "error",
      reason: `v${version} is already published — choose rebuild or an explicit increment`,
    };
  }
  return {
    action: "update",
    version,
    tag: `v${version}`,
    bump,
    releaseType: bump,
    releaseLabel: releaseTypeLabel(bump),
    existing: false,
    reason: `v${declared} was not published. This run asked for ${releaseTypeLabel(bump) || bump} instead of ${releaseTypeLabel(retry.failedType) || retry.failedType}, so v${declared} is skipped and the next version is taken from v${retry.base}`,
  };
}

/**
 * Release mode decision — the single implementation behind the workflow's
 * `mode` input (rebuild | update | auto) and `release_type`.
 *
 *   rebuild, or release_type revision → same number. A pack for a check.
 *   update + release_type auto → patch, minor, or major from the commits.
 *             Extreme is never chosen here.
 *   update + an explicit level → move only that counter.
 *   auto + release_type auto → do not invent the next number. An unpublished
 *             line is finished as it stands.
 *   auto + an explicit level → that level, same retry rules as update.
 * A failed publish is not a consumed number. The same type retries it. A
 * different explicit type skips it and counts from the last success.
 */
function decideRelease({
  mode = "auto",
  current,
  baseline,
  subjects = [],
  type = "auto",
  released = [],
} = {}) {
  const declared = String(current || "0.0.0").replace(/^v/i, "");
  const base = String(baseline || declared).replace(/^v/i, "");
  const published = (released || [])
    .map((v) =>
      String(v || "")
        .trim()
        .replace(/^v/i, ""),
    )
    .filter(Boolean);
  const real = (subjects || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .filter((line) => !/^Merge (branch|pull request|remote)/i.test(line))
    .filter((line) => !/^release: v?\d+\.\d+\.\d+(?:\.\d+)?/i.test(line));
  const requested = normalizeReleaseType(type);

  const keep = (reason) => ({
    action: "rebuild",
    version: declared,
    tag: `v${declared}`,
    bump: "none",
    releaseType: "rebuild",
    releaseLabel: releaseTypeLabel("rebuild"),
    existing: published.includes(declared),
    reason,
  });

  if (mode !== "rebuild" && mode !== "update" && mode !== "auto") {
    return { action: "error", reason: `unknown release mode "${mode}"` };
  }

  if (mode === "rebuild" || requested === "rebuild") {
    return keep(
      mode === "rebuild"
        ? "rebuild requested — the declared version is kept exactly as it is"
        : "revision keeps the declared version — same number, packed again for a check",
    );
  }

  // Default auto (mode and release type both auto) never invents the next
  // number. An explicit patch, minor, major, or extreme still moves that one
  // counter, including when the workflow mode is auto.
  if (mode === "auto" && (!requested || requested === "auto")) {
    const pending = decisionForUnpublished({
      declared,
      baseline: base,
      released: published,
      type: "auto",
    });
    if (pending) return pending;
    return keep(
      published.includes(declared)
        ? `auto keeps published v${declared} — choose update and release type auto to follow the changes, or name patch, minor, major, or extreme`
        : `auto keeps v${declared}`,
    );
  }

  // Unpublished, including a prepare that wrote a changelog and then failed:
  // the same release type keeps that number. A different explicit type
  // skips it and bumps from the last successful publish.
  const pending = decisionForUnpublished({
    declared,
    baseline: base,
    released: published,
    type,
  });
  if (pending) return pending;
  const resolved = resolveBump({ previous: base, type, subjects: real });
  if (!resolved.ok) {
    return { action: "error", reason: resolved.error };
  }
  const bump = resolved.bump;
  if (bump === "rebuild") {
    return keep("revision keeps the declared version — same number, packed again for a check");
  }
  const version = bumpVersion(base, bump);
  if (published.includes(version)) {
    return {
      action: "error",
      reason: `v${version} is already published — choose rebuild or an explicit increment`,
    };
  }
  return {
    action: "update",
    version,
    tag: `v${version}`,
    bump,
    releaseType: bump,
    releaseLabel: releaseTypeLabel(bump),
    existing: false,
    reason:
      mode === "auto"
        ? `${real.length} releasable commit${real.length === 1 ? "" : "s"} since v${base} — ${releaseTypeLabel(bump) || bump} increment`
        : `update requested — ${releaseTypeLabel(bump) || bump} increment over ${base}`,
  };
}

/**
 * Publish-stage handoff — the guard that makes "the version Prepare chose" the
 * version Publish actually releases.
 *
 * Publish never recomputes a version: it releases whatever the merged release
 * PR put into config/friday-version.json on main (public four-part). The
 * failure this prevents is publishing while that PR is still OPEN: main then
 * still declares the previous version, and the run either dies with a
 * confusing "release vX already exists" or silently republishes stale source.
 *
 *   current   - public releaseVersion on the main commit being published
 *   prepared  - release/vX.Y.Z pull requests: { version, state: open|merged|closed }
 *   released  - stable versions/tags that already exist
 *
 * A pending (open) prepared version that is newer than main stops an
 * update/auto publish with an actionable message. rebuild is still allowed:
 * republishing the currently released version is a deliberate, safe action.
 */
function publishHandoff({ mode = "auto", current, prepared = [], released = [] } = {}) {
  const declared = String(current || "").replace(/^v/i, "");
  if (!isStableVersion(declared)) {
    return { action: "error", reason: "main does not declare a valid public FRIDAY version" };
  }
  const published = (released || [])
    .map((v) =>
      String(v || "")
        .trim()
        .replace(/^v/i, ""),
    )
    .filter(Boolean);
  const state = resolvePreparedState({ current: declared, prepared });
  const pending =
    state.latestOpen && compareVersions(state.latestOpen.version, declared) > 0
      ? state.latestOpen
      : null;

  const action =
    mode === "rebuild"
      ? "rebuild"
      : mode === "update"
        ? "update"
        : published.includes(declared)
          ? "rebuild"
          : "update";

  if (state.ambiguous && mode !== "rebuild") {
    return {
      action: "error",
      version: declared,
      pending: state.latestOpen?.version || state.mergedAhead?.version || null,
      superseded: state.superseded.map((p) => p.version),
      reason: `${state.conflicts.join("; ")} — release state is ambiguous; reconcile the release PRs and run Publish again.`,
    };
  }

  if (state.latestOpen?.version === declared && !state.mergedCurrent && mode !== "rebuild") {
    const pr = state.latestOpen.number;
    return {
      action: "error",
      version: declared,
      pending: declared,
      superseded: state.superseded.map((p) => p.version),
      reason:
        `main declares v${declared}, but its release Pull Request` +
        (pr ? ` #${pr}` : "") +
        " is still open rather than merged — " +
        "run Official Publish (mode=auto) so Safe Merge can merge it, then publish proceeds. Do not skip that gate.\n" +
        releaseOperatorGuide({ version: declared, prNumber: pr }),
    };
  }

  if (pending && mode !== "rebuild") {
    return {
      action: "error",
      version: declared,
      pending: pending.version,
      superseded: state.superseded.map((p) => p.version),
      reason:
        `v${pending.version} was prepared but its release Pull Request is still open — ` +
        `main still declares v${declared}. Merge release/v${pending.version} into main and publish again ` +
        `(or publish with mode = rebuild to republish v${declared} as-is).`,
    };
  }

  if (action === "update" && published.includes(declared)) {
    return {
      action: "error",
      version: declared,
      pending: pending ? pending.version : null,
      reason:
        `release v${declared} already exists — ` +
        (pending
          ? `merge the prepared release/v${pending.version} first, `
          : "prepare a new version, ") +
        "or publish with mode = rebuild to replace its assets.",
    };
  }

  return {
    action,
    version: declared,
    tag: `v${declared}`,
    existing: published.includes(declared),
    pending: pending ? pending.version : null,
    superseded: state.superseded.map((p) => p.version),
    reason:
      action === "rebuild"
        ? `rebuild of v${declared} — same version, assets replaced`
        : `publishing prepared v${declared} from main`,
  };
}

/**
 * Exact next operator actions when the release pipeline stops.
 * Named workflows and inputs — not a generic "run prepare".
 */
function releaseOperatorGuide({ version = "", prNumber = null } = {}) {
  const v = String(version || "").replace(/^v/i, "");
  const pr = prNumber ? String(prNumber) : "<the release PR number>";
  const verHint = v || "<version from package.json on main>";
  return [
    "Exact next steps (do not skip Safe Merge, do not force-merge):",
    "1. GitHub → Actions → Official Publish → Run workflow",
    "   Use workflow from: main",
    "   Inputs: mode=auto; release_type=auto finishes the number already declared and does not invent the next one.",
    "   A new counter needs mode=update. release_type=auto then follows the changes (never extreme).",
    "   That one dispatch sequences prepare → PR Validation → Safe Merge → publish.",
    "2. If you must run stages by hand:",
    "   a. Actions → Release / Build → Run workflow from main",
    "      Inputs: stage=prepare; mode=update when the number should move; release_type=auto or an explicit level",
    "   b. After PR Validation is green: Actions → Safe Merge → Run workflow from main",
    `      Inputs: scope=selected; pr_numbers=${pr}; confirm=MERGE`,
    "   c. Actions → Official Publish → Run workflow from main (mode=auto)",
    "      or Actions → Release / Build → stage=publish; mode=auto",
    `   Target version in this checkout: ${verHint}`,
  ].join("\n");
}

/**
 * Classify why publish cannot prove a merged release/vX.Y.Z PR.
 * Callers gather GitHub state; this function only names the blocker.
 */
function diagnosePublishBlockers({
  version,
  published = false,
  openPr = null,
  mergedPr = null,
  ancestor = false,
  changelogOk = false,
} = {}) {
  const clean = String(version || "").replace(/^v/i, "");
  const tag = `v${clean}`;
  const head = `release/${tag}`;
  const prNumber = openPr?.number || mergedPr?.number || null;
  const guide = releaseOperatorGuide({ version: clean, prNumber });

  if (published) {
    return {
      ok: false,
      kind: "already_published",
      message: `GitHub Release ${tag} already exists. Do not re-run publish for this tag unless you intend a rebuild (Official Publish mode=rebuild).\n${guide}`,
    };
  }

  if (openPr && openPr.number) {
    const failing = [].concat(openPr.failingChecks || []).filter(Boolean);
    const pending = [].concat(openPr.pendingChecks || []).filter(Boolean);
    const why = failing.length
      ? `PR Validation or another required check is failing (${failing.slice(0, 6).join(", ")}). Fix the checks, then run Safe Merge — do not force-merge.`
      : pending.length
        ? "required checks are still running. Wait for PR Validation to finish green, then run Safe Merge."
        : openPr.mergeable === "CONFLICTING"
          ? `the PR has merge conflicts with main. Resolve conflicts on ${head}, wait for green checks, then run Safe Merge.`
          : `the PR is open and has not been merged. Run Safe Merge (scope=selected, pr_numbers=${openPr.number}, confirm=MERGE).`;
    return {
      ok: false,
      kind: "pr_open_unmerged",
      message: `Release PR #${openPr.number} for ${head} is still open${
        openPr.url ? ` (${openPr.url})` : ""
      }. ${why}\n${guide}`,
    };
  }

  if (mergedPr && mergedPr.number) {
    if (!ancestor) {
      return {
        ok: false,
        kind: "merged_not_on_main",
        message: `Release PR #${mergedPr.number} for ${head} is merged, but that merge commit is not yet an ancestor of the main commit being published. Wait for GitHub to update main (do not force-push), then re-run Official Publish with mode=auto.\n${guide}`,
      };
    }
    if (!changelogOk) {
      return {
        ok: false,
        kind: "changelog_missing",
        message: `Release PR for ${head} is merged into main, but CHANGELOG.md is missing a unique heading for ${tag}. Inspect the merged PR, then re-run prepare if needed.\n${guide}`,
      };
    }
    return {
      ok: true,
      kind: "ready",
      message: `merged ${head} is on main with a changelog heading`,
    };
  }

  return {
    ok: false,
    kind: "no_prepare",
    message: `No merged release PR for ${head} and no open PR with that head. The prepare stage never created ${head}, or its PR was closed without merging. Run Official Publish (mode=auto) on main so prepare opens the PR; wait for Safe Merge; publish follows automatically.\n${guide}`,
  };
}

/**
 * Documentation files that name the version that actually ships. Only the
 * CURRENT release number is synchronised - historical entries (CHANGELOG,
 * release notes) are never rewritten.
 *
 * Two kinds of documents:
 *   * full      - every occurrence of the previous version is the shipping one
 *                 (README, INSTALL, storage contract).
 *   * governed  - policy documents that also contain deliberate EXAMPLE
 *                 versions (ordering tables, prerelease samples). Only the
 *                 statements that declare the shipping version are rewritten.
 */
const VERSION_DOCS = ["README.md", "INSTALL.md", "AUDIT.md", "docs/FRIDAY_STORAGE_CONTRACT.md"];
const GOVERNED_DOCS = [
  // Living briefing: only the "(currently version X)" line is a declaration.
  // Other sentences are not rewritten as if they declared the shipping version.
  "FRIDAY_STATE.md",
  // AI session protocol: only the live "current public line **FRIDAY X**"
  // sentence is a shipping declaration. "Next public revision is **Y**" is
  // rewritten to the patch bump of X. The four-part example (`1.0.0.0`) is
  // left alone.
  "AGENTS.md",
  "CONTRIBUTING.md",
  "VERSIONING.md",
  "RELEASE.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/FRIDAY_ARCHITECTURE_BASELINE.md",
  "docs/FRIDAY_BUILD_AND_RELEASE.md",
  "docs/FRIDAY_CHANGE_CONTROL.md",
  "docs/FRIDAY_FEATURES.md",
  "docs/FRIDAY_GITHUB_ACTIONS.md",
  "docs/FRIDAY_MASTER_FLOW.md",
  "docs/FRIDAY_MERGE_FLOW.md",
  "docs/FRIDAY_PROVIDERS_AND_SECRETS.md",
  "docs/FRIDAY_USER_GUIDE.md",
  "docs/FRIDAY_IMPORT_FORMAT.md",
];

/** Statements that declare the shipping version inside a governed document. */
function governedPatterns(from) {
  const v = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // **Current shipping version: 1.3.2**
    [new RegExp(`(Current shipping version:\\s*)${v}`, "g"), "$1"],
    // | 1.3.2 (current) | Yes |
    [new RegExp(`(\\|\\s*)${v}(\\s*\\(current\\))`, "g"), "$1", "$2"],
    // | `1.3.2` | Official, stable release | Stable |
    [new RegExp("(\\|\\s*`)" + v + "(`\\s*\\|\\s*Official)", "g"), "$1", "$2"],
    // FRIDAY-Setup-1.3.2.exe / FRIDAY-Test-Portable-1.3.2.exe
    [new RegExp(`(FRIDAY-(?:Test-)?(?:Setup|Portable)-)${v}`, "g"), "$1"],
    // v1.3.2 headings/links that name the shipping release notes file
    [new RegExp(`(releases/notes/v)${v}`, "g"), "$1"],
    // Document titles and section headings: "... (v1.3.2)"
    [new RegExp(`(\\(v)${v}(\\))`, "g"), "$1", "$2"],
    // "Current shipping version: **1.3.2**"
    [new RegExp(`(Current shipping version:\\s*[\`*]{0,2}v?)${v}`, "g"), "$1"],
    // "Version: **1.3.2**" / "**Version:** 1.3.2"
    [new RegExp(`(Version:\\**\\s*\\**)${v}`, "g"), "$1"],
    // "baseline locked** on the 1.3.2 checkout"
    [new RegExp(`(locked\\**\\s*on the )${v}`, "g"), "$1"],
    // Prose: "(currently version 1.0.0.0)" (FRIDAY_STATE.md)
    [new RegExp(`(\\(\\s*currently version\\s*[\`*]{0,2}v?)${v}`, "g"), "$1"],
  ];
}

/**
 * Version-declaration statements that must always name the shipping version.
 * Used by `release-engine verify` and the version-sync test so documentation
 * can never silently drift behind package.json again.
 *
 * The list covers two shapes:
 *   * structured declarations (front-matter lines, table rows, artifact names);
 *   * prose declarations - an English phrase that states which version the
 *     document describes, immediately followed by the number. These are the
 *     ones that used to survive every release (AUDIT.md kept saying "state of
 *     the codebase at version 1.4.1" long after 1.5.0 shipped) because the
 *     synchroniser only rewrote the exact previous number.
 * A declaration must NOT match a prerelease/ordering example (1.4.1-test.1) or
 * a longer number, hence the trailing `(?![.\d-])` guard on the prose forms.
 */
// Prose: "(currently version 1.0.0.0)" (FRIDAY_STATE.md)
const CURRENTLY_VERSION_PATTERN = new RegExp(
  `\\(currently version\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])\\)`,
  "g",
);
// AGENTS.md live public line — not the four-part example (`1.0.0.0`).
const AGENTS_CURRENT_PUBLIC_LINE_PATTERN = new RegExp(
  `current public line\\s*\\*\\*FRIDAY\\s+(${VERSION_NUM})\\*\\*`,
  "g",
);
const AGENTS_NEXT_PUBLIC_REVISION_PATTERN = new RegExp(
  `Next public revision is\\s*\\*\\*(${VERSION_NUM})\\*\\*`,
  "g",
);
const VERSIONING_PUBLIC_ROW_PATTERN = new RegExp(
  `Public FRIDAY \\(\`releaseVersion\`\\)\\s*\\|\\s*\`(${VERSION_NUM})(?![.\\d-])\``,
  "g",
);
const NPM_ENCODING_PATTERN =
  /npm encoding(\s+\|\s*|\s+)([`*]{0,2})(\d+\.\d+\.\d+(?:\.\d+)?)([`*]{0,2})/g;
const VERSIONING_NPM_ROW_PATTERN =
  /(\|\s*npm \/ electron-builder \(`package\.json` `version`\)\s*\|\s*`)([^`]+)(`)/g;

function npmVersionFor(version) {
  const parsed = parseFridayVersion(String(version || "").replace(/^v/i, ""));
  if (!parsed) return "";
  return identityFromParsed(parsed, {
    forceFourPart: parsed.fourPart || undefined,
  }).npmVersion;
}

/** Keep "npm encoding X" and the versioning identity table on the live encoding. */
function rewriteNpmEncodingClaims(text, npmVersion) {
  if (!npmVersion) return String(text || "");
  return String(text || "")
    .replace(new RegExp(NPM_ENCODING_PATTERN.source, "g"), (match, sep, open, found, close) =>
      found === npmVersion ? match : `npm encoding${sep}${open}${npmVersion}${close}`,
    )
    .replace(new RegExp(VERSIONING_NPM_ROW_PATTERN.source, "g"), (match, open, found, close) =>
      found === npmVersion ? match : `${open}${npmVersion}${close}`,
    );
}

/** Next unpublished public number: PATCH / FIX bump of the shipping line. */
function nextPublicRevision(version) {
  const parsed = parseFridayVersion(version);
  if (!parsed) return null;
  const stable = formatPublic({ ...parsed, prerelease: null }, { fourPart: parsed.fourPart });
  return bumpVersion(stable, "patch");
}

const DECLARATION_PATTERNS = [
  new RegExp(`Current shipping version:\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`(?<!Current )[Ss]hipping version:\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`Version:\\**\\s*\\**v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`\\(v(${VERSION_NUM})\\)`, "g"),
  new RegExp(`FRIDAY-(?:Test-)?(?:Setup|Portable)-(${VERSION_NUM})\\.exe`, "g"),
  new RegExp(`\\|\\s*\`(${VERSION_NUM})\`\\s*\\|\\s*Official`, "g"),
  new RegExp(`\\bat version\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`\\bstamped\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`\\baccepted for\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(`\\bas of (?:version\\s*)?[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  new RegExp(
    `\\b(?:shipping|current) version (?:is|=)\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`,
    "g",
  ),
  new RegExp(
    `\\bdocuments? (?:describes?|covers?)\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`,
    "g",
  ),
  new RegExp(`\\blocked\\**\\s*on the\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])\\s*checkout`, "g"),
  new RegExp(`\\|\\s*[\`*]{0,2}(${VERSION_NUM})[\`*]{0,2}\\s*\\(current\\)`, "g"),
  new RegExp(`\\bWhat is new in\\s*[\`*]{0,2}v?(${VERSION_NUM})(?![.\\d-])`, "g"),
  CURRENTLY_VERSION_PATTERN,
];

/**
 * Which declaration patterns apply to one governed file.
 *
 * FRIDAY_STATE.md is a living briefing of current facts.
 * Applying every pattern would rewrite historical sentences as if they
 * declared the shipping version. Only the live "(currently version X)"
 * sentence is a declaration.
 */
function declarationPatternsFor(rel) {
  if (rel === "FRIDAY_STATE.md") return [CURRENTLY_VERSION_PATTERN];
  if (rel === "AGENTS.md") return [AGENTS_CURRENT_PUBLIC_LINE_PATTERN];
  if (rel === "VERSIONING.md") return [...DECLARATION_PATTERNS, VERSIONING_PUBLIC_ROW_PATTERN];
  return DECLARATION_PATTERNS;
}

/** Documents whose declared version must equal the canonical public releaseVersion. */
function versionDrift({ root = ROOT, version } = {}) {
  const identity = readCanonicalIdentity({ root, version });
  const expected =
    identity?.releaseVersion ||
    (version
      ? String(version).replace(/^v/i, "")
      : JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  const stale = [];
  for (const rel of [...VERSION_DOCS, ...GOVERNED_DOCS]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (isPublishedEvidenceLine(line)) return;
      for (const rx of declarationPatternsFor(rel)) {
        rx.lastIndex = 0;
        let match;
        while ((match = rx.exec(line))) {
          if (match[1] !== expected) {
            stale.push({ file: rel, line: i + 1, found: match[1], expected, text: line.trim() });
          }
        }
      }
    });
    if (rel === "AGENTS.md") {
      const nextExpected = nextPublicRevision(expected);
      if (nextExpected) {
        text.split("\n").forEach((line, i) => {
          if (isPublishedEvidenceLine(line)) return;
          AGENTS_NEXT_PUBLIC_REVISION_PATTERN.lastIndex = 0;
          let match;
          while ((match = AGENTS_NEXT_PUBLIC_REVISION_PATTERN.exec(line))) {
            if (match[1] !== nextExpected) {
              stale.push({
                file: rel,
                line: i + 1,
                found: match[1],
                expected: nextExpected,
                text: line.trim(),
              });
            }
          }
        });
      }
    }
    const npmExpected = identity?.npmVersion || npmVersionFor(expected);
    if (npmExpected) {
      text.split("\n").forEach((line, i) => {
        if (isPublishedEvidenceLine(line)) return;
        for (const rx of [NPM_ENCODING_PATTERN, VERSIONING_NPM_ROW_PATTERN]) {
          const lineRx = new RegExp(rx.source, "g");
          let match;
          while ((match = lineRx.exec(line))) {
            const found = rx === NPM_ENCODING_PATTERN ? match[3] : match[2];
            if (found !== npmExpected) {
              stale.push({
                file: rel,
                line: i + 1,
                found,
                expected: npmExpected,
                text: line.trim(),
              });
            }
          }
        }
      });
    }
  }
  return { ok: stale.length === 0, expected, stale };
}

/**
 * Rewrite exactly the statements `versionDrift` audits, whatever version they
 * currently name. This is what makes documentation synchronization idempotent:
 * a release branch whose package.json was already bumped (previous === clean)
 * still gets its declarations repaired, instead of silently doing nothing and
 * failing `verify` later in CI. Nothing outside a declaration statement is
 * touched, so ordering examples, history and changelogs survive untouched.
 */
function rewriteDeclarations(text, clean, rel) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (isPublishedEvidenceLine(line)) return line;
      let out = line;
      for (const rx of declarationPatternsFor(rel)) {
        out = out.replace(new RegExp(rx.source, "g"), (match, found) =>
          found === clean ? match : match.replace(found, clean),
        );
      }
      return out;
    })
    .join("\n");
}

function rewriteNextPublicRevision(text, shippingVersion) {
  const next = nextPublicRevision(shippingVersion);
  if (!next) return String(text || "");
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (isPublishedEvidenceLine(line)) return line;
      return line.replace(
        new RegExp(AGENTS_NEXT_PUBLIC_REVISION_PATTERN.source, "g"),
        (match, found) => (found === next ? match : match.replace(found, next)),
      );
    })
    .join("\n");
}

function syncDocs(previous, clean, { root = ROOT } = {}) {
  const touched = [];
  const from = String(previous || "").replace(/^v/i, "");
  const bumped = Boolean(from) && from !== clean;
  for (const rel of VERSION_DOCS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    let after = repairUnpublishedClaims(before, clean, { root });
    after = bumped ? replaceVersionOutsideEvidence(after, from, clean) : after;
    after = rewriteDeclarations(after, clean, rel);
    after = rewriteNpmEncodingClaims(after, npmVersionFor(clean));
    if (after !== before) {
      fs.writeFileSync(file, after);
      touched.push(rel);
    }
  }
  const rules = bumped ? governedPatterns(from) : [];
  for (const rel of GOVERNED_DOCS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    // FRIDAY_STATE.md keeps historical work-log and lock-in numbers; only the
    // live "(currently version X)" sentence is rewritten (via patternsFor).
    // AGENTS.md keeps the four-part example (`1.0.0.0`) and only rewrites the
    // live public line plus the next-revision sentence.
    if (rel !== "FRIDAY_STATE.md" && rel !== "AGENTS.md") {
      after = after
        .split("\n")
        .map((line) => {
          if (isPublishedEvidenceLine(line)) return line;
          let out = line;
          for (const [rx, keep, tail = ""] of rules)
            out = out.replace(rx, `${keep}${clean}${tail}`);
          return out;
        })
        .join("\n");
    }
    after = rewriteDeclarations(after, clean, rel);
    after = rewriteNpmEncodingClaims(after, npmVersionFor(clean));
    if (rel === "AGENTS.md") after = rewriteNextPublicRevision(after, clean);
    if (after !== before) {
      fs.writeFileSync(file, after);
      touched.push(rel);
    }
  }
  // README section 9 is regenerated, never hand-grown: summary + links only.
  if (syncWhatsNew(clean, { root })) touched.push("README.md");
  if (syncLicenseYear({ root })) touched.push("LICENSE");
  // The documentation index and the README documentation map are generated
  // from one registry, so a release can never leave them behind.
  if (root === ROOT) touched.push(...require("./docs-engine.cjs").sync());
  return [...new Set(touched)];
}

/** Keep every version source in step with the release being published. */
function applyVersion(version, { root = ROOT, docs = true } = {}) {
  const raw = requireReleaseVersion(version);
  const parsed = parseFridayVersion(raw);
  if (!parsed) throw new Error(VERSION_UNRESOLVED);
  const existing = readCanonicalFile(root);
  // Passing the npm encoding of the current canonical identity must keep the
  // public four-part version. A real new version (1.0.0.1, 1.0.1.0, …) still
  // follows the string that was asked for.
  const sameAsExisting =
    existing && (parsed.raw === existing.releaseVersion || parsed.raw === existing.npmVersion);
  const identity = sameAsExisting
    ? existing
    : identityFromParsed(parsed, { forceFourPart: parsed.fourPart ? true : undefined });
  const publicVersion = identity.releaseVersion;
  const npmVersion = identity.npmVersion;
  const touched = [];

  const pkgFile = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const previousIdentity = existing;
  const previous = previousIdentity?.releaseVersion || pkg.version;

  if (writeCanonicalFile(identity, { root })) touched.push(CANONICAL_REL);
  if (writeNsisVersionHeader(identity, { root })) touched.push(NSIS_VERSION_REL);

  if (pkg.version !== npmVersion) {
    pkg.version = npmVersion;
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    touched.push("package.json");
  }

  const lockFile = path.join(root, "package-lock.json");
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      lock.version = npmVersion;
      if (lock.packages?.[""]) lock.packages[""].version = npmVersion;
      fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
      touched.push("package-lock.json");
    } catch {
      /* a malformed lockfile must never abort a release */
    }
  }

  const versionFile = path.join(root, "src", "lib", "friday", "version.ts");
  if (fs.existsSync(versionFile)) {
    const before = fs.readFileSync(versionFile, "utf8");
    const after = before.replace(
      /export const APP_VERSION = compiled \|\| "[^"]+";/,
      `export const APP_VERSION = compiled || "${publicVersion}";`,
    );
    if (after !== before) {
      fs.writeFileSync(versionFile, after);
      touched.push("src/lib/friday/version.ts");
    }
  }

  if (docs && !isTestVersion(publicVersion))
    touched.push(...syncDocs(previous, publicVersion, { root }));
  return { version: publicVersion, npmVersion, identity, touched };
}

/* ------------------------------------------------- README "What is new" ---
 * ONE topic, ONE document. CHANGELOG.md is the full history and
 * releases/notes/vX.Y.Z.md is the per-release detail, so README section 9 is
 * only ever a short summary plus the two links. This writer regenerates that
 * section on every release, which is what stops it from re-growing into a
 * third copy of the same write-up.
 */
const WHATS_NEW_MARKER =
  "<!-- release-engine: generated section. Summary plus links only - the full\n     write-up lives in the changelog and the release notes. -->";

/** The short summary line, read from the real release notes when they exist. */
function whatsNewSummary(clean, { root = ROOT } = {}) {
  const file = path.join(root, "releases", "notes", `v${clean}.md`);
  const notes = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const field = (label) =>
    (new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`).exec(notes)?.[1] || "").trim();
  const released = field("Released");
  const channel = field("Channel");
  const summary = field("Summary");
  const parts = [];
  if (released) parts.push(`Released ${released}`);
  if (channel) parts.push(`on the ${channel.replace(/\s*\(.*\)$/, "")} channel`);
  const head = parts.length ? parts.join(" ") : `Version ${clean}`;
  return summary ? `${head} - ${summary.replace(/\s+$/, "")}` : `${head}.`;
}

/** The whole generated section body for one version. */
function whatsNewSection(clean, { root = ROOT } = {}) {
  return [
    `## 9. What is new in ${clean}`,
    "",
    WHATS_NEW_MARKER,
    "",
    whatsNewSummary(clean, { root }),
    "",
    `- Full detail for this release: **[releases/notes/v${clean}.md](releases/notes/v${clean}.md)**`,
    "- Changelog for the current public line: **[CHANGELOG.md](CHANGELOG.md)**",
    "",
  ].join("\n");
}

/** Replace README section 9 with the generated short form. Returns true if changed. */
function syncWhatsNew(clean, { root = ROOT } = {}) {
  const file = path.join(root, "README.md");
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, "utf8");
  const lines = before.split("\n");
  const start = lines.findIndex((line) => /^##\s*9\.\s*What is new in/.test(line));
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Keep a horizontal rule that belongs to the NEXT section.
  let tail = end;
  while (tail > start && lines[tail - 1].trim() === "") tail -= 1;
  if (lines[tail - 1] && lines[tail - 1].trim() === "---") tail -= 1;
  let after = [
    ...lines.slice(0, start),
    ...whatsNewSection(clean, { root }).split("\n"),
    ...lines.slice(tail, end),
    ...lines.slice(end),
  ].join("\n");
  if (end === lines.length) after = after.replace(/\n+$/, "\n");
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

/* --------------------------------------------------------------- LICENSE ---
 * The licence carries a copyright year that must never go stale. It is not a
 * versioned document, so it stays out of VERSION_DOCS/GOVERNED_DOCS and gets
 * this one narrow rewrite instead.
 */
function syncLicenseYear({ root = ROOT, year = new Date().getUTCFullYear() } = {}) {
  const file = path.join(root, "LICENSE");
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/(Copyright \(c\) )(\d{4})(-\d{4})?/, (match, head, from) =>
    Number(from) >= year ? match : `${head}${from}-${year}`,
  );
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

function writeChangelog(entry, { root = ROOT, version = "" } = {}) {
  const file = path.join(root, "CHANGELOG.md");
  const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, updateChangelog(body, entry, version));
  return file;
}

/* ------------------------------------------------------------ self-heal ---
 * ONE repair for every place a version can drift. config/friday-version.json
 * is the single source of truth. package.json holds the npm/electron-builder
 * SemVer encoding of that identity. Everything else (lockfile, renderer
 * fallback, LICENSE year, governed documents, CHANGELOG, releases/notes,
 * README "What is new", the generated documentation index/map, NSIS header)
 * is derived and can be regenerated at any time. `releaseHealth` only
 * reports, `healRelease` repairs and re-reports. Both are idempotent: a
 * healthy tree is left exactly as it is, and running the repair twice never
 * changes anything the second time. Only a genuine sync/drift problem is
 * ever "fixed" here — a failing test, a type error or a broken build is not
 * documentation drift and is deliberately left for the real gate to report.
 */

/** Per-release notes rebuilt from the changelog section of that version. */
function notesFromChangelogSection(section, clean) {
  const lines = String(section || "")
    .trim()
    .split("\n");
  return `${[`## FRIDAY v${clean}`, ...lines.slice(1)].join("\n").trim()}\n`;
}

/** README section 9 exactly as it is on disk (null when README has none). */
function readmeWhatsNew(root = ROOT) {
  const file = path.join(root, "README.md");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => /^##\s*9\.\s*What is new in/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let tail = end;
  while (tail > start && lines[tail - 1].trim() === "") tail -= 1;
  if (lines[tail - 1] && lines[tail - 1].trim() === "---") tail -= 1;
  return lines.slice(start, tail).join("\n").trimEnd();
}

/**
 * Every sync/drift problem for `version` (default: package.json), as plain
 * one-line findings. An empty list means the tree is release-ready as far as
 * versioning and documentation are concerned.
 */
function releaseHealth({ root = ROOT, version } = {}) {
  const pkgFile = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const identity = readCanonicalIdentity({ root, version });
  const issues = [];
  if (
    !identity ||
    (!isStableVersion(identity.releaseVersion) && !isTestVersion(identity.releaseVersion))
  ) {
    const clean = String(version || pkg.version || "").replace(/^v/i, "");
    return {
      version: clean,
      ok: false,
      fixable: false,
      issues: [
        `"${clean}" is not a FRIDAY version (X.Y.Z, X.Y.Z.W, or a -test.N prerelease) — nothing can be derived from it`,
      ],
    };
  }
  const clean = identity.releaseVersion;
  const npmVersion = identity.npmVersion;

  const canonical = readCanonicalFile(root);
  if (!canonical) {
    issues.push(`${CANONICAL_REL} is missing — it is the canonical version source`);
  } else if (canonical.releaseVersion !== clean || canonical.npmVersion !== npmVersion) {
    issues.push(
      `${CANONICAL_REL} declares ${canonical.releaseVersion} (npm ${canonical.npmVersion}), expected ${clean} (npm ${npmVersion})`,
    );
  }

  if (pkg.version !== npmVersion)
    issues.push(
      `package.json declares ${pkg.version}, expected npm encoding ${npmVersion} of ${clean}`,
    );

  const nshFile = path.join(root, NSIS_VERSION_REL);
  if (fs.existsSync(path.dirname(nshFile))) {
    if (!fs.existsSync(nshFile)) {
      issues.push(`${NSIS_VERSION_REL} is missing — installer DisplayVersion cannot be derived`);
    } else {
      const nsh = fs.readFileSync(nshFile, "utf8");
      if (!nsh.includes(`FRIDAY_DISPLAY_VERSION "${clean}"`))
        issues.push(`${NSIS_VERSION_REL} DisplayVersion does not match ${clean}`);
      if (!nsh.includes(`FRIDAY_NPM_VERSION "${npmVersion}"`))
        issues.push(`${NSIS_VERSION_REL} npm version does not match ${npmVersion}`);
    }
  }

  const lockFile = path.join(root, "package-lock.json");
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      const root0 = lock.packages?.[""]?.version;
      if (lock.version !== npmVersion || (root0 !== undefined && root0 !== npmVersion))
        issues.push(`package-lock.json declares ${lock.version}, expected ${npmVersion}`);
    } catch {
      issues.push("package-lock.json is not valid JSON");
    }
  }

  const versionFile = path.join(root, "src", "lib", "friday", "version.ts");
  if (fs.existsSync(versionFile)) {
    const found = /export const APP_VERSION = compiled \|\| "([^"]+)";/.exec(
      fs.readFileSync(versionFile, "utf8"),
    )?.[1];
    if (found !== undefined && found !== clean)
      issues.push(`src/lib/friday/version.ts falls back to ${found}, expected ${clean}`);
  }

  if (isTestVersion(clean))
    return { version: clean, npmVersion, ok: !issues.length, fixable: true, issues };

  if (gitTagExists(clean, { root })) {
    for (const rel of VERSION_DOCS) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isUnpublishedClaimLine(line, clean)) {
            issues.push(
              `${rel}:${i + 1} still claims v${clean} is unpublished though git tag v${clean} exists`,
            );
          }
        });
    }
  }

  const drift = versionDrift({ root, version: clean });
  for (const s of drift.stale)
    issues.push(`${s.file}:${s.line} declares ${s.found}, expected ${clean}`);

  const licenseFile = path.join(root, "LICENSE");
  if (fs.existsSync(licenseFile)) {
    const year = new Date().getUTCFullYear();
    const text = fs.readFileSync(licenseFile, "utf8");
    const m = /Copyright \(c\) (\d{4})(-(\d{4}))?/.exec(text);
    if (m && Number(m[3] || m[1]) < year)
      issues.push(`LICENSE copyright year ends at ${m[3] || m[1]}, expected ${year}`);
  }

  const changelogFile = path.join(root, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : "";
  const headings = uniqueChangelogHeadings(changelog);
  if (!headings.unique) {
    const dupes = [...new Set(headings.keys.filter((k, i) => headings.keys.indexOf(k) !== i))];
    issues.push(`CHANGELOG.md repeats ${dupes.map((k) => `## v${k}`).join(", ")}`);
  }
  if (!headings.keys.includes(clean)) issues.push(`CHANGELOG.md has no ## v${clean} section`);
  if (!changelog.trimStart().startsWith("# FRIDAY"))
    issues.push("CHANGELOG.md is missing its header");
  const currentSection = changelogSectionFor(changelog, clean);
  if (currentSection && CHANGELOG_HEADER_LEAKS.some((rx) => rx.test(currentSection)))
    issues.push(`CHANGELOG.md ## v${clean} still contains leftover file-header prose`);

  const notesFile = path.join(root, "releases", "notes", `v${clean}.md`);
  if (!fs.existsSync(notesFile) || !fs.readFileSync(notesFile, "utf8").trim())
    issues.push(`releases/notes/v${clean}.md is missing`);
  else {
    try {
      assertPublishableNotes(fs.readFileSync(notesFile, "utf8"), {
        version: clean,
        requireChanges: false,
      });
    } catch (error) {
      for (const issue of error.issues || [error.message])
        issues.push(`releases/notes/v${clean}.md: ${issue}`);
    }
    const changelogVersion = extractChangelogVersion(changelog);
    if (changelogVersion && changelogVersion !== clean)
      issues.push(`CHANGELOG.md latest version is ${changelogVersion}, expected ${clean}`);
    const expectedSection = changelogEntry(fs.readFileSync(notesFile, "utf8"), clean).trim();
    if (currentSection && expectedSection && currentSection.trim() !== expectedSection)
      issues.push(`CHANGELOG.md ## v${clean} does not match releases/notes/v${clean}.md`);
  }

  const section = readmeWhatsNew(root);
  if (section !== null && section !== whatsNewSection(clean, { root }).trimEnd())
    issues.push(
      `README.md "What is new" section does not match the generated section for ${clean}`,
    );

  if (root === ROOT) {
    const docs = require("./docs-engine.cjs").inspect();
    if (docs.indexStale) issues.push("docs/README.md index block is stale");
    if (docs.mapStale) issues.push("README.md documentation map is stale");
  }

  return { version: clean, ok: !issues.length, fixable: true, issues };
}

/** Commit subjects since `previousTag`, or [] when git/tag is unavailable. */
function commitSubjectsSince(previousTag, root = ROOT) {
  if (!previousTag) return [];
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["log", "--no-merges", "--pretty=%s", `${previousTag}..HEAD`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Repair every drift `releaseHealth` reports and report what changed.
 *
 *   • version sources: package.json, package-lock.json, version.ts (applyVersion)
 *   • CHANGELOG.md ⇄ releases/notes/vX.Y.Z.md: whichever exists is the source
 *     for the other; when both exist the changelog is deduplicated in place;
 *     when neither exists the entry is generated from the real commits since
 *     the newest changelog version (or states plainly that none were found)
 *   • governed documents, README "What is new", LICENSE year, docs index/map
 *
 * Returns { version, before, repaired, after, ok }. `ok` is false only when a
 * problem survived the repair — that is never silent: `after.issues` names it.
 */
function newestLocalStableTag(root) {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["tag", "--list", "v*"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((line) => line.trim().replace(/^v/i, ""))
      .filter((value) => isStableVersion(value) && !isTestVersion(value))
      .reduce((best, value) => (!best || compareVersions(value, best) > 0 ? value : best), "");
  } catch {
    return "";
  }
}

/**
 * Drop changelog sections and note files for versions that were written
 * during a failed publish and then skipped. A version with a git tag stays.
 * Nothing is removed when this checkout has no stable tag to measure from.
 */
function pruneUnpublishedAhead(keep, { root = ROOT } = {}) {
  const newest = newestLocalStableTag(root);
  if (!newest) return [];
  const keepClean = String(keep || "").replace(/^v/i, "");
  const changelogFile = path.join(root, "CHANGELOG.md");
  if (!fs.existsSync(changelogFile)) return [];
  const body = fs.readFileSync(changelogFile, "utf8");
  const sections = splitChangelogSections(changelogRest(body));
  const drop = sections
    .map((section) => changelogVersionKey(section.split("\n")[0] || ""))
    .filter(
      (version) =>
        version &&
        version !== keepClean &&
        compareVersions(version, newest) > 0 &&
        !gitTagExists(version, { root }),
    );
  if (!drop.length) return [];
  const header =
    "# FRIDAY — Changelog\n\nWhat changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.\n";
  const kept = sections.filter((section) => {
    const key = changelogVersionKey(section.split("\n")[0] || "");
    return key && !drop.includes(key);
  });
  fs.writeFileSync(changelogFile, `${header}\n${kept.join("\n\n")}${kept.length ? "\n" : ""}`);
  for (const version of drop) {
    const notes = path.join(root, "releases", "notes", `v${version}.md`);
    if (fs.existsSync(notes)) fs.unlinkSync(notes);
  }
  return drop;
}

function healRelease({ root = ROOT, version, date = new Date() } = {}) {
  const before = releaseHealth({ root, version });
  if (!before.fixable)
    return { version: before.version, before, repaired: [], after: before, ok: false };
  const clean = before.version;
  if (before.ok) return { version: clean, before, repaired: [], after: before, ok: true };

  const candidates = [
    ...new Set([
      "package.json",
      "package-lock.json",
      CANONICAL_REL,
      NSIS_VERSION_REL,
      "src/lib/friday/version.ts",
      "LICENSE",
      "CHANGELOG.md",
      `releases/notes/v${clean}.md`,
      "docs/README.md",
      ...VERSION_DOCS,
      ...GOVERNED_DOCS,
    ]),
  ];
  const snapshot = new Map(
    candidates.map((rel) => {
      const file = path.join(root, rel);
      return [rel, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null];
    }),
  );

  // 1. version sources (documentation follows in step 3 with the full picture)
  applyVersion(clean, { root, docs: false });

  if (!isTestVersion(clean)) {
    pruneUnpublishedAhead(clean, { root });
    // 2. CHANGELOG ⇄ release notes
    const changelogFile = path.join(root, "CHANGELOG.md");
    const notesFile = path.join(root, "releases", "notes", `v${clean}.md`);
    const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : "";
    const sections = splitChangelogSections(changelogRest(changelog));
    const own = sections.filter((s) => changelogVersionKey(s.split("\n")[0] || "") === clean);
    const notes =
      fs.existsSync(notesFile) && fs.readFileSync(notesFile, "utf8").trim()
        ? fs.readFileSync(notesFile, "utf8")
        : "";

    let entry = notes;
    let notesValid = false;
    if (entry) {
      try {
        assertPublishableNotes(entry, { version: clean, requireChanges: false });
        notesValid = true;
      } catch {
        entry = "";
      }
    }
    if (!entry && own.length) {
      // The reviewed changelog text is the source; the best-scored copy wins
      // when the heading was duplicated.
      entry = notesFromChangelogSection(dedupeChangelogRest(own.join("\n\n")), clean);
      try {
        assertPublishableNotes(entry, { version: clean, requireChanges: false });
      } catch {
        entry = "";
      }
    }
    if (!entry) {
      const parsed = parseFridayVersion(clean);
      if (
        parsed?.fourPart &&
        parsed.major === 1 &&
        parsed.minor === 0 &&
        parsed.patch === 0 &&
        parsed.revision === 0 &&
        !parsed.prerelease
      ) {
        entry = baselineWhatsNew({ version: clean, date });
      } else {
        const newest = sections
          .map((s) => changelogVersionKey(s.split("\n")[0] || ""))
          .filter((k) => k && isStableVersion(k) && compareVersions(k, clean) < 0)
          .sort((a, b) => compareVersions(b, a))[0];
        entry = whatsNew({
          version: clean,
          previous: newest ? `v${newest}` : null,
          subjects: commitSubjectsSince(newest ? `v${newest}` : "", root),
          channel: "stable",
          date,
        });
      }
    }
    if (!notesValid) {
      fs.mkdirSync(path.dirname(notesFile), { recursive: true });
      fs.writeFileSync(notesFile, entry.endsWith("\n") ? entry : `${entry}\n`);
    }
    // `updateChangelog` replaces this version's section in place and
    // deduplicates every other heading, so a healthy log is rewritten
    // byte-for-byte identical.
    fs.writeFileSync(changelogFile, updateChangelog(changelog, entry, clean));

    // 3. governed documents, README section 9, LICENSE year, docs index/map
    syncDocs(clean, clean, { root });
  }

  const repaired = candidates.filter((rel) => {
    const file = path.join(root, rel);
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    return now !== snapshot.get(rel);
  });
  const after = releaseHealth({ root, version: clean });
  return { version: clean, before, repaired, after, ok: after.ok };
}

module.exports = {
  parseVersion,
  parseFridayVersion,
  compareVersions,
  compareBuilds,
  fileVersionStringMatches,
  identityFromParsed,
  identityFromCanonical,
  readCanonicalIdentity,
  readCanonicalIdentityAtRef,
  readCanonicalFile,
  writeCanonicalFile,
  writeNsisVersionHeader,
  packFlags,
  electronBuilderArgs,
  syncLatestYml,
  EPOCH_LEGACY,
  EPOCH_FRIDAY2,
  CANONICAL_REL,
  posixRel,
  resolvePreparedState,
  bumpVersion,
  nextPublicRevision,
  bumpKindForScheme,
  normalizeReleaseType,
  releaseTypeLabel,
  inferReleaseType,
  extractNotesReleaseType,
  resolveBump,
  RELEASE_LEVELS,
  nextVersion,
  stableBaseline,
  releaseBaseline,
  testVersion,
  testIteration,
  isTestVersion,
  isStableVersion,

  classify,
  detectBump,
  ambiguousSubjects,
  looksLikeCommitDump,
  isPublishedEvidenceLine,
  replaceVersionOutsideEvidence,

  groupChanges,
  renderNotes,
  whatsNew,
  baselineWhatsNew,
  buildBaselineRelease,
  BASELINE_INCLUDED,
  BASELINE_INCLUDED_GROUPS,
  BASELINE_INCLUDED_HEADINGS,
  buildCanonicalRelease,
  renderCanonical,
  requireReleaseVersion,
  assertPublishableNotes,
  validateOwnerOverride,
  guardPublishableRelease,
  resolveCommitRange,
  extractNotesVersion,
  extractChangelogVersion,
  FORBIDDEN_NOTE_PATTERNS,
  USER_FACING_ORDER,
  TECHNICAL_SECTION,
  changelogHeading,
  changelogShippedVersions,
  commitsSinceShipped,
  changelogEntry,
  changelogRest,
  changelogSectionFor,
  updateChangelog,
  dedupeChangelogRest,
  uniqueChangelogHeadings,
  CHANGELOG_HEADER_LEAKS,
  plan,
  decideRelease,
  unpublishedRetry,
  publishHandoff,
  releaseOperatorGuide,
  diagnosePublishBlockers,
  syncDocs,
  syncWhatsNew,
  whatsNewSection,
  whatsNewSummary,
  syncLicenseYear,
  rewriteDeclarations,
  versionDrift,
  VERSION_DOCS,
  GOVERNED_DOCS,
  applyVersion,
  writeChangelog,
  releaseHealth,
  healRelease,
};

// ---- CLI -------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "plan";
  const flag = (name, fallback = "") => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  if (cmd === "plan") {
    const logFile = flag("log");
    const raw = logFile ? fs.readFileSync(logFile, "utf8") : fs.readFileSync(0, "utf8"); // stdin: `git log --pretty=%s | release-engine plan`
    const subjects = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const result = plan({
      previous: flag("previous") || null,
      type: flag("type", "auto"),
      subjects,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (cmd === "commits-since") {
    // Subjects since a changelog-shipped line that has no tag in this clone.
    //   node scripts/release-engine.cjs commits-since --previous v1.0.0.2
    // Exit 1 when that line is not in CHANGELOG.md.
    const result = commitsSinceShipped(flag("previous"), {
      root: flag("root") || process.cwd(),
    });
    if (!result.ok) process.exit(1);
    process.stdout.write(`${result.subjects.join("\n")}\n`);
  } else if (cmd === "decide") {
    // rebuild | update | auto -> the concrete action and version.
    //   node scripts/release-engine.cjs decide --mode auto --baseline v1.3.2 \
    //     [--type patch] [--log commits.txt] [--released released.txt]
    const logFile = flag("log");
    const raw = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const releasedFile = flag("released");
    const released =
      releasedFile && fs.existsSync(releasedFile)
        ? fs
            .readFileSync(releasedFile, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    const currentVersion =
      flag("current") ||
      readCanonicalIdentity({})?.releaseVersion ||
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const decision = decideRelease({
      mode: flag("mode", "auto"),
      current: currentVersion,
      baseline: flag("baseline"),
      type: flag("type", "auto"),
      subjects: raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      released,
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.action === "error") process.exit(1);
  } else if (cmd === "handoff") {
    // Publish-stage guard: does main really carry the prepared version?
    //   node scripts/release-engine.cjs handoff --mode auto \
    //     [--current 1.3.2] [--prepared prepared.json] [--released released.txt]
    const preparedFile = flag("prepared");
    let prepared = [];
    if (preparedFile && fs.existsSync(preparedFile)) {
      try {
        prepared = JSON.parse(fs.readFileSync(preparedFile, "utf8")) || [];
      } catch {
        prepared = [];
      }
    }
    const releasedFile = flag("released");
    const released =
      releasedFile && fs.existsSync(releasedFile)
        ? fs
            .readFileSync(releasedFile, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    const decision = publishHandoff({
      mode: flag("mode", "auto"),
      current:
        flag("current") ||
        readCanonicalIdentity({})?.releaseVersion ||
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
      prepared,
      released,
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.action === "error") process.exit(1);
  } else if (cmd === "diagnose-publish") {
    const jsonFlag = (name) => {
      const file = flag(name);
      if (!file || !fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    };
    const result = diagnosePublishBlockers({
      version: flag("version"),
      published: flag("published") === "true",
      openPr: jsonFlag("open"),
      mergedPr: jsonFlag("merged"),
      ancestor: flag("ancestor") === "true",
      changelogOk: flag("changelog-ok") === "true",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      process.exit(1);
    }
  } else if (cmd === "apply") {
    const version = flag("version") || readCanonicalIdentity({})?.releaseVersion || "";
    if (!version) {
      console.error("apply needs --version X.Y.Z[.W] or a canonical config/friday-version.json");
      process.exit(1);
    }
    const applied = applyVersion(version);
    const notesFile = flag("notes");
    if (notesFile && fs.existsSync(notesFile)) {
      // The changelog always receives the canonical `## vX.Y.Z` heading,
      // whatever title the published release page uses.
      writeChangelog(fs.readFileSync(notesFile, "utf8"), { version: applied.version });
    }
    console.log(`version ${applied.version} -> ${applied.touched.join(", ") || "already in sync"}`);
  } else if (cmd === "baseline") {
    // The real previous stable release + whether its tag exists in this clone.
    //   node scripts/release-engine.cjs baseline --releases released.txt \
    //     --tags tags.txt [--declared 1.4.1]
    const lines = (file) =>
      file && fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    const result = releaseBaseline({
      releases: lines(flag("releases")),
      tags: lines(flag("tags")),
      declared:
        flag("declared") ||
        readCanonicalIdentity({})?.releaseVersion ||
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (cmd === "testplan") {
    // Next TEST prerelease for the version currently on the branch.
    //   node scripts/release-engine.cjs testplan [--base 1.3.1] [--existing FILE]
    // --existing is a newline list of tags/releases that already exist.
    const base =
      flag("base") ||
      readCanonicalIdentity({})?.releaseVersion ||
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const file = flag("existing");
    const existing =
      file && fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    process.stdout.write(`${JSON.stringify(testVersion(base, existing), null, 2)}\n`);
  } else if (cmd === "notes") {
    // The one "What's New" renderer for both channels.
    //   git log --pretty=%s A..B | node scripts/release-engine.cjs notes \
    //     --version 1.3.2 [--previous v1.3.1] [--channel test] [--ref BR] [--commit SHA] [--date ISO] [--out FILE]
    try {
      const logFile = flag("log");
      const raw = logFile ? fs.readFileSync(logFile, "utf8") : fs.readFileSync(0, "utf8");
      const subjects = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const version =
        flag("version") ||
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
      requireReleaseVersion(version);
      const rawType = flag("type");
      const releaseType =
        !rawType || rawType === "none" || rawType === "auto" ? undefined : rawType;
      const body = whatsNew({
        version,
        previous: flag("previous") || null,
        subjects,
        channel: flag("channel", "stable"),
        ref: flag("ref"),
        commit: flag("commit"),
        date: flag("date") ? new Date(flag("date")) : new Date(),
        extra: flag("extra"),
        releaseType,
      });
      const out = flag("out");
      if (out) fs.writeFileSync(out, body);
      process.stdout.write(body);
    } catch (error) {
      console.error(error.message || error);
      process.exit(1);
    }
  } else if (cmd === "guard-notes") {
    // Fail closed before GitHub Release publication.
    //   node scripts/release-engine.cjs guard-notes --version 1.0.0.1 --file release-notes.md \
    //     [--package package.json] [--changelog CHANGELOG.md] [--notes-file releases/notes/v1.0.0.1.md] \
    //     [--tag v1.0.0.1] [--setup release/FRIDAY-Setup-1.0.0.1.exe] [--channel stable]
    try {
      const version =
        flag("version") ||
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
      const file = flag("file");
      if (!file || !fs.existsSync(file)) {
        throw new Error("ERROR: --file is required and must exist. Publishing stopped.");
      }
      const readIf = (rel) => (rel && fs.existsSync(rel) ? fs.readFileSync(rel, "utf8") : "");
      const pkgFile = flag("package");
      const packageVersion = pkgFile ? JSON.parse(fs.readFileSync(pkgFile, "utf8")).version : "";
      guardPublishableRelease({
        version,
        body: fs.readFileSync(file, "utf8"),
        packageVersion,
        changelog: readIf(flag("changelog")),
        notesFileBody: readIf(flag("notes-file")),
        tag: flag("tag"),
        setup: flag("setup"),
        channel: flag("channel", "stable"),
        requireChanges: !args.includes("--allow-empty"),
      });
      console.log(`release notes for v${requireReleaseVersion(version)} are publishable`);
    } catch (error) {
      console.error(error.message || error);
      process.exit(1);
    }
  } else if (cmd === "range") {
    const result = resolveCommitRange({
      previous: flag("previous"),
      head: flag("head", "HEAD"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      process.exit(1);
    }
  } else if (cmd === "identity") {
    const ref = flag("ref");
    const identity = ref
      ? readCanonicalIdentityAtRef(ref)
      : readCanonicalIdentity({ version: flag("version") || undefined });
    if (!identity) {
      console.error(VERSION_UNRESOLVED);
      process.exit(1);
    }
    const field = flag("field");
    if (field) {
      if (!(field in identity)) {
        console.error(`unknown identity field: ${field}`);
        process.exit(1);
      }
      process.stdout.write(`${identity[field]}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
    }
  } else if (cmd === "next") {
    const previous =
      flag("previous") ||
      readCanonicalIdentity({})?.releaseVersion ||
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const logFile = flag("log");
    const subjects = logFile
      ? fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
    const result = nextVersion(previous, flag("type", "auto"), subjects);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (cmd === "compare") {
    const a = flag("a") || args[1];
    const b = flag("b") || args[2];
    if (!a || !b) {
      console.error("compare needs two versions: --a 1.0.0.0 --b 1.0.0.1");
      process.exit(1);
    }
    const n = compareBuilds(a, b);
    process.stdout.write(
      `${JSON.stringify({ a, b, result: n, meaning: n > 0 ? "a newer" : n < 0 ? "b newer" : "equal" }, null, 2)}\n`,
    );
  } else if (cmd === "release-health" || cmd === "health") {
    const health = releaseHealth({ version: flag("version") || undefined });
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    if (!health.ok) process.exit(1);
  } else if (cmd === "verify") {
    const health = releaseHealth({ version: flag("version") || undefined });
    if (health.ok) {
      console.log(
        `version ${health.version} - all version sources and governed documents are in sync`,
      );
    } else {
      console.error(`version ${health.version} - ${health.issues.length} drift issue(s):`);
      for (const issue of health.issues) console.error(`  ${issue}`);
      process.exit(1);
    }
  } else if (cmd === "sync") {
    // Repair governed documentation declarations for the version already
    // declared by config/friday-version.json (or --version). Idempotent and safe to re-run.
    //   node scripts/release-engine.cjs sync
    const version =
      flag("version") ||
      readCanonicalIdentity({})?.releaseVersion ||
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const touched = syncDocs(version, String(version).replace(/^v/i, ""));
    console.log(`version ${version} -> ${touched.join(", ") || "documentation already in sync"}`);
    const report = versionDrift({});
    if (!report.ok) {
      console.error(`version ${report.expected} - still stale after sync:`);
      for (const s of report.stale) console.error(`  ${s.file}:${s.line} found ${s.found}`);
      process.exit(1);
    }
  } else if (cmd === "heal") {
    // SELF-HEAL. Repair every version/documentation drift for the version
    // package.json declares (or --version), report what was rewritten, and
    // fail only when a problem survived the repair. Idempotent: a healthy tree
    // is not touched. `--check` reports without writing anything.
    //   node scripts/release-engine.cjs heal [--version X.Y.Z] [--check]
    const version = flag("version") || undefined;
    if (args.includes("--check")) {
      const health = releaseHealth({ version });
      if (health.ok) {
        console.log(`version ${health.version} - release-ready, nothing to heal`);
      } else {
        console.error(`version ${health.version} - ${health.issues.length} drift issue(s):`);
        for (const issue of health.issues) console.error(`  ${issue}`);
        process.exit(1);
      }
    } else {
      const result = healRelease({ version });
      if (result.before.ok) {
        console.log(`version ${result.version} - release-ready, nothing to heal`);
      } else {
        console.log(
          `version ${result.version} - healing ${result.before.issues.length} drift issue(s):`,
        );
        for (const issue of result.before.issues) console.log(`  ${issue}`);
        console.log(
          result.repaired.length
            ? `repaired: ${result.repaired.join(", ")}`
            : "repaired: nothing to rewrite",
        );
      }
      if (!result.ok) {
        console.error(`version ${result.version} - still not release-ready after heal:`);
        for (const issue of result.after.issues) console.error(`  ${issue}`);
        process.exit(1);
      }
    }
  } else if (cmd === "files") {
    // Every path `apply`/`heal` can rewrite, one per line. The release workflow
    // stages exactly this list, so a document added to VERSION_DOCS/GOVERNED_DOCS
    // can never again be synced on disk but left out of the release commit.
    //   node scripts/release-engine.cjs files [--version X.Y.Z]
    const notesVersion = String(
      flag("version") ||
        readCanonicalIdentity({})?.releaseVersion ||
        JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
    ).replace(/^v/i, "");
    const files = [
      CANONICAL_REL,
      NSIS_VERSION_REL,
      "package.json",
      "package-lock.json",
      "CHANGELOG.md",
      `releases/notes/v${notesVersion}.md`,
      "src/lib/friday/version.ts",
      "LICENSE",
      ...VERSION_DOCS,
      ...GOVERNED_DOCS,
    ];
    for (const rel of files) {
      if (fs.existsSync(path.join(ROOT, rel))) console.log(posixRel(rel));
    }
  } else if (cmd === "stamp") {
    // Version sources only — no CHANGELOG, no release notes. Used by the test
    // build so a portable TEST EXE reports its real prerelease version.
    const version = flag("version");
    if (!version) {
      console.error("stamp needs --version X.Y.Z[-test.N]");
      process.exit(1);
    }
    const applied = applyVersion(version, { docs: false });
    console.log(`stamped ${applied.version} -> ${applied.touched.join(", ") || "already in sync"}`);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}
