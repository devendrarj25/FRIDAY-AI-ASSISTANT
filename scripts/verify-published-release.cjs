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
 *      real size and SHA-512.
 *
 *   node scripts/verify-published-release.cjs --dir <downloaded assets> --version 1.2.3.4
 *
 * Exit code 1 lists every problem. Nothing is written and nothing is published.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const digest = (file, algorithm, encoding) =>
  crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

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

function verifyPublishedRelease({ dir, version }) {
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

  let checked = 0;
  for (const row of assets) {
    const file = at(row.name);
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

module.exports = { verifyPublishedRelease, parseLatest };

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
