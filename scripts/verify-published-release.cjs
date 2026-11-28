#!/usr/bin/env node
/**
 * FRIDAY · prove that what GitHub serves is what the build verified.
 *
 * verify-update-path.cjs proves the update path on the files a build just wrote.
 * An installed FRIDAY never sees those files: it downloads the release's assets
 * from GitHub. After FRIDAY Release publishes, this reads the downloaded assets
 * back and checks, the way the app does, that:
 *
 *   1. friday-update.json is for this version and lists the installer, the
 *      portable EXE and the block map;
 *   2. every file the manifest lists was uploaded whole: its size and SHA-256
 *      are the manifest's;
 *   3. SHA256SUMS.txt agrees with the files and with the manifest;
 *   4. latest.yml names this version and this installer, with the installer's
 *      real size and SHA-512;
 *   5. friday-bundle.json (the build record) is the file friday-update.json names:
 *      its size and SHA-256 match, it is a valid record for this version and
 *      channel, and every app file it lists is the uploaded file;
 *   6. no uploaded file is larger than 2147483648 bytes, the most GitHub
 *      accepts for one release asset.
 *
 *   node scripts/verify-published-release.cjs --dir <downloaded assets> --version 1.2.3.4
 *
 * Exit code 1 lists every problem. Nothing is written and nothing is published.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const bundleLib = require("../electron/build-bundle.cjs");

/** GitHub refuses a release asset above this size (2 GiB). */
const MAX_ASSET_BYTES = 2147483648;

/** Streamed, so a file near the limit is never read into memory whole. */
function digest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
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
  return hash.digest(encoding);
}

/** latest.yml is electron-builder's flat YAML; only these scalar keys are read. */
function parseLatest(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(version|path|sha512|releaseDate):\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (size && out.size === undefined) out.size = Number(size[1]);
  }
  return out;
}

/** The build record the manifest names: the right file, a valid record, and every app file it lists is real. */
function checkBundle({ manifest, assets, clean, at, fail, notes }) {
  const ref = manifest.bundle;
  if (!ref || typeof ref !== "object") {
    fail(
      "friday-update.json names no bundle (friday-bundle.json), so an installed app finds no build record.",
    );
    return;
  }
  if (ref.name !== bundleLib.FILE_NAME) {
    fail(`friday-update.json names the bundle ${ref.name}, not ${bundleLib.FILE_NAME}.`);
    return;
  }
  const file = at(bundleLib.FILE_NAME);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    fail(`friday-bundle.json cannot be read from the published release: ${error.message}`);
    return;
  }
  if (size !== ref.bytes || digest(file, "sha256", "hex") !== String(ref.sha256).toLowerCase()) {
    fail(
      "friday-bundle.json on the release does not match the size or SHA-256 in friday-update.json.",
    );
    return;
  }
  const record = bundleLib.read(file);
  if (!record) {
    fail("friday-bundle.json is not a valid build record.");
    return;
  }
  const base = clean.replace(/-.*$/, "");
  if (record.version !== base) fail(`friday-bundle.json is for v${record.version}, not v${base}.`);
  if (record.channel !== (manifest.channel === "test" ? "test" : "stable")) {
    fail(`friday-bundle.json is for the ${record.channel} channel, not ${manifest.channel}.`);
  }
  const listed = new Map(assets.map((a) => [a.name, a]));
  let agreed = true;
  for (const row of record.app) {
    const known = listed.get(row.name);
    const upload = at(row.name);
    let same = false;
    try {
      same = known
        ? known.bytes === row.bytes && String(known.sha256).toLowerCase() === row.sha256
        : fs.statSync(upload).size === row.bytes && digest(upload, "sha256", "hex") === row.sha256;
    } catch {
      same = false;
    }
    if (!same) {
      agreed = false;
      fail(`friday-bundle.json does not agree with the file on the release about ${row.name}.`);
    }
  }
  if (agreed) {
    notes.push(
      `friday-bundle.json matches friday-update.json (size, SHA-256 and ${record.app.length} app files)`,
    );
  }
}

function verifyPublishedRelease({ dir, version, maxBytes = MAX_ASSET_BYTES }) {
  const problems = [];
  const notes = [];
  const fail = (text) => problems.push(text);
  const clean = String(version || "").replace(/^v/i, "");
  const at = (name) => path.join(dir, name);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(at("friday-update.json"), "utf8"));
  } catch (error) {
    fail(`friday-update.json cannot be read from the published release: ${error.message}`);
    return { problems, notes };
  }
  if (manifest.version !== clean) {
    fail(`friday-update.json is for v${manifest.version}, not v${clean}.`);
  }
  if (manifest.tag !== `v${clean}`) fail(`friday-update.json names tag ${manifest.tag}.`);

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  for (const kind of ["installer", "portable"]) {
    if (!assets.some((a) => a.kind === kind)) fail(`friday-update.json lists no ${kind}.`);
  }
  if (!assets.some((a) => /\.blockmap$/i.test(a.name))) {
    fail("friday-update.json lists no block map, so no update could download only what changed.");
  }

  // No asset above the size GitHub accepts; such a file is never read or hashed.
  const oversized = new Set();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const size = fs.statSync(at(entry.name)).size;
    if (size > maxBytes) {
      oversized.add(entry.name);
      fail(
        `${entry.name} is ${size} bytes, over the release asset limit (GitHub accepts at most ${MAX_ASSET_BYTES}).`,
      );
    }
  }

  let checked = 0;
  for (const row of assets) {
    const file = at(row.name);
    if (oversized.has(row.name)) continue;
    if (!fs.existsSync(file)) {
      fail(`${row.name} is in friday-update.json but was not uploaded to the release.`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (size !== row.bytes) {
      fail(`${row.name} is ${size} bytes on the release but ${row.bytes} in friday-update.json.`);
      continue;
    }
    if (digest(file, "sha256", "hex") !== String(row.sha256).toLowerCase()) {
      fail(`${row.name} on the release does not match its SHA-256 in friday-update.json.`);
      continue;
    }
    checked += 1;
  }
  if (checked) notes.push(`${checked} uploaded files match friday-update.json (size and SHA-256)`);

  checkBundle({ manifest, assets, clean, at, fail, notes });

  // SHA256SUMS.txt
  try {
    const sums = new Map();
    for (const line of fs.readFileSync(at("SHA256SUMS.txt"), "utf8").split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (m) sums.set(m[2], m[1].toLowerCase());
    }
    for (const row of assets) {
      if (sums.get(row.name) !== String(row.sha256).toLowerCase()) {
        fail(`SHA256SUMS.txt does not agree with friday-update.json about ${row.name}.`);
      }
    }
    notes.push(`SHA256SUMS.txt lists ${sums.size} files and agrees with the manifest`);
  } catch (error) {
    fail(`SHA256SUMS.txt cannot be read from the published release: ${error.message}`);
  }

  // latest.yml names this installer and describes its real bytes
  const installer = assets.find((a) => a.kind === "installer");
  try {
    const latest = parseLatest(fs.readFileSync(at("latest.yml"), "utf8"));
    // A TEST build keeps its "-test.N" stamp in the manifest; electron-builder's
    // latest.yml may carry the base line, so the base line is accepted there.
    const sameLine =
      latest.version === clean ||
      (manifest.channel === "test" && clean.startsWith(`${latest.version}-test`));
    if (!sameLine) fail(`latest.yml is for v${latest.version}, not v${clean}.`);
    if (installer) {
      if (latest.path !== installer.name) {
        fail(`latest.yml points at ${latest.path}, not at ${installer.name}.`);
      } else if (fs.existsSync(at(installer.name))) {
        const file = at(installer.name);
        if (latest.size !== undefined && latest.size !== fs.statSync(file).size) {
          fail("latest.yml describes a different installer size than the one uploaded.");
        }
        if (latest.sha512 !== digest(file, "sha512", "base64")) {
          fail("latest.yml carries a SHA-512 that is not the uploaded installer's.");
        }
      }
    }
    if (!problems.some((p) => p.startsWith("latest.yml"))) {
      notes.push("latest.yml names this version and the uploaded installer's size and SHA-512");
    }
  } catch (error) {
    fail(`latest.yml cannot be read from the published release: ${error.message}`);
  }

  return { problems, notes };
}

module.exports = { verifyPublishedRelease, parseLatest, MAX_ASSET_BYTES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : "";
  };
  const dir = path.resolve(flag("dir") || "");
  const version = String(flag("version") || "").replace(/^v/i, "");
  if (!flag("dir") || !version || !fs.existsSync(dir)) {
    console.error("[friday] usage: verify-published-release.cjs --dir <assets> --version <v>");
    process.exit(2);
  }
  const { problems, notes } = verifyPublishedRelease({ dir, version });
  for (const note of notes) console.log(`[friday] ok       Published release: ${note}`);
  for (const problem of problems) console.error(`[friday] RELEASE  ${problem}`);
  if (problems.length) {
    console.error(
      `[friday] published release failed (${problems.length} problem${problems.length === 1 ? "" : "s"}).`,
    );
    process.exit(1);
  }
}
