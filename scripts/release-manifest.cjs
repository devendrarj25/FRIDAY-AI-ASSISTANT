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
 *   node scripts/release-manifest.cjs --version 1.2.3 [--notes release-notes.md]
 *   node scripts/release-manifest.cjs --version 1.2.3-test.1 --channel test
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const IDENTITY = require("./identity.cjs");
const engine = require("./release-engine.cjs");

const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function build({ version, notes = "", channel = "stable", releaseType: requested = "" } = {}) {
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
  if (identity) engine.syncLatestYml(identity, { root: ROOT });
  // A TEST build publishes the same two Windows deliverables as an official
  // release, under the separate "FRIDAY Test" identity so it installs beside —
  // never over — the production FRIDAY.
  const candidates = [
    `FRIDAY-Setup-${clean}.exe`,
    `FRIDAY-Test-Setup-${clean}.exe`,
    `FRIDAY-Portable-${clean}.exe`,
    "latest.yml",
  ];
  const assets = candidates
    .map((name) => ({ name, file: path.join(RELEASE, name) }))
    .filter((a) => fs.existsSync(a.file))
    .map((a) => ({
      name: a.name,
      bytes: fs.statSync(a.file).size,
      sha256: sha256(a.file),
      kind: /setup/i.test(a.name)
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

  fs.writeFileSync(
    path.join(RELEASE, "SHA256SUMS.txt"),
    `${assets.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`,
  );
  fs.writeFileSync(
    path.join(RELEASE, "friday-update.json"),
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
  const version =
    flag("version") ||
    engine.readCanonicalIdentity({ root: ROOT })?.releaseVersion ||
    JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  try {
    const manifest = build({
      version,
      channel: flag("channel", "stable"),
      releaseType: flag("type"),
      notes: notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "",
    });
    for (const a of manifest.assets) console.log(`[friday] ${a.sha256}  ${a.name}`);
    console.log(`[friday] ok       release manifest for v${manifest.version}`);
  } catch (error) {
    console.error(`[friday] manifest failed: ${error.message}`);
    process.exit(1);
  }
}
