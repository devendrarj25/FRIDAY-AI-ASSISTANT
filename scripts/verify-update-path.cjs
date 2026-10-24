#!/usr/bin/env node
/**
 * FRIDAY · prove the update path on the artifacts that were just built.
 *
 * A green build used to say nothing about whether an installed FRIDAY could
 * update from it: the manifest, the checksums, the block map and the way the
 * app reads them were first exercised by FRIDAY Release itself. This runs
 * inside `verify-build.cjs`, so PR Validation, FRIDAY Release and the CMD
 * build all prove the same things on the real installer:
 *
 *   1. the installer has its block map and the block map describes exactly
 *      that file (electron-builder wrote it; the app will read it);
 *   2. the manifest and checksums the release will publish (written to a
 *      scratch folder, nothing in release/ changes) list the installer and its
 *      block map with the right SHA-256, every published file is one the app
 *      recognises, and the app finds the installer's checksum in it;
 *   3. a differential download rebuilds a changed copy of the real installer
 *      from the real one plus only the changed blocks, over HTTP with Range,
 *      and the result matches its SHA-256.
 *
 *   node scripts/verify-update-path.cjs --release release --installer <file> --version 1.2.3.4
 *
 * Exit code 1 lists every problem. Nothing is published and release/ is only read.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Serve one file with HTTP Range support, like GitHub's CDN does. */
function serveFile(file) {
  const size = fs.statSync(file).size;
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
    if (!range) {
      res.writeHead(200, { "content-length": size });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), size - 1);
    res.writeHead(206, {
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/next.exe` }),
    ),
  );
}

async function verifyUpdatePath({ releaseDir, installer, version, workDir }) {
  const problems = [];
  const notes = [];
  const fail = (text) => problems.push(text);
  const diff = require("../electron/differential-download.cjs");
  const sync = require("../electron/github-sync.cjs");
  const installerName = path.basename(installer);

  // 1 · the block map next to the installer
  const mapFile = `${installer}.blockmap`;
  let map = null;
  if (!fs.existsSync(mapFile)) {
    fail(
      `${installerName}.blockmap is missing: electron-builder did not write the installer's block map, so no update could download only what changed.`,
    );
  } else {
    try {
      map = diff.parseBlockMap(fs.readFileSync(mapFile));
      const described = diff.mapSize(map);
      const actual = fs.statSync(installer).size;
      if (described !== actual) {
        fail(`the block map describes ${described} bytes but the installer is ${actual} bytes.`);
        map = null;
      } else {
        notes.push(
          `block map describes the installer exactly (${map.files[0].checksums.length} blocks)`,
        );
      }
    } catch (error) {
      fail(`the block map cannot be read: ${error.message}`);
    }
  }

  // 2 · the manifest and checksums the release would publish, read like the app reads them
  const scratch = fs.mkdtempSync(path.join(workDir || os.tmpdir(), "friday-update-path-"));
  try {
    const manifestBuild = require("./release-manifest.cjs").build;
    const channel = /Test-Setup/i.test(installerName) ? "test" : "stable";
    const manifest = manifestBuild({
      version,
      channel,
      releaseDir,
      outDir: scratch,
      syncLatest: false,
    });
    const installerRow = (manifest.assets || []).find((a) => a.name === installerName);
    if (!installerRow) fail(`the manifest does not list ${installerName}.`);
    else if (installerRow.sha256 !== sha256(installer)) {
      fail("the manifest checksum of the installer is not the installer's SHA-256.");
    } else if (sync.expectedChecksum(manifest, installerName) !== installerRow.sha256) {
      fail("the app cannot find the installer's checksum in the manifest.");
    } else notes.push("the app finds the installer's checksum in the manifest");
    if (map && !(manifest.assets || []).some((a) => a.name === `${installerName}.blockmap`)) {
      fail("the manifest does not list the installer's block map.");
    }
    const sums = fs.readFileSync(path.join(scratch, "SHA256SUMS.txt"), "utf8");
    for (const row of manifest.assets || []) {
      if (!sums.includes(`${row.sha256}  ${row.name}`)) fail(`SHA256SUMS.txt lacks ${row.name}.`);
      const kind = sync.classifyAsset(row.name).kind;
      if (kind === "other") fail(`the app would not recognise the published file ${row.name}.`);
    }
    if (sync.classifyAsset(installerName).kind !== "installer") {
      fail(`the app does not treat ${installerName} as an installer.`);
    }
    notes.push(
      `manifest and checksums list ${(manifest.assets || []).length} files the app recognises`,
    );
  } catch (error) {
    fail(`the manifest could not be built: ${error.message}`);
  }

  // 3 · a differential download against the real installer
  if (map) {
    const nextFile = path.join(scratch, "next.exe");
    let served = null;
    try {
      const oldPlan = diff.summarize(diff.computeOperations(map, map));
      if (oldPlan.download !== 0) fail("an unchanged installer would still download blocks.");
      // The next version: the same file with a few blocks changed. Only the
      // checksums of those blocks differ in its block map, which is all the plan compares.
      const file = map.files[0];
      const changed = [
        ...new Set(
          [3, Math.floor(file.sizes.length / 2), file.sizes.length - 2].filter(
            (i) => i >= 0 && i < file.sizes.length,
          ),
        ),
      ];
      fs.copyFileSync(installer, nextFile);
      const nextMap = JSON.parse(JSON.stringify(map));
      const fd = fs.openSync(nextFile, "r+");
      try {
        for (const index of changed) {
          let offset = 0;
          for (let i = 0; i < index; i += 1) offset += file.sizes[i];
          const stamp = crypto.randomBytes(Math.min(file.sizes[index], 64));
          fs.writeSync(fd, stamp, 0, stamp.length, offset);
          nextMap.files[0].checksums[index] = `${file.checksums[index]}~changed`;
        }
      } finally {
        fs.closeSync(fd);
      }
      const expectedDownload = changed.reduce((sum, i) => sum + file.sizes[i], 0);
      served = await serveFile(nextFile);
      const part = path.join(scratch, "rebuilt.exe.part");
      const out = await diff.downloadDifferential({
        url: served.url,
        oldFile: installer,
        oldBlockMap: map,
        newBlockMap: nextMap,
        part,
        expectedBytes: fs.statSync(nextFile).size,
        sha256: sha256(nextFile),
        // A tiny installer would be "not worth it" by design; this is a real one.
        minSaving: 0.05,
        fetchImpl: (url, init) => fetch(url, init),
      });
      if (!out.ok) {
        fail(
          `the differential download did not work on the real installer: ${out.reason} ${out.error || ""}`.trim(),
        );
      } else if (sha256(part) !== sha256(nextFile)) {
        fail("the differential download built a file that differs from the new installer.");
      } else if (out.downloaded !== expectedDownload) {
        fail(`it fetched ${out.downloaded} bytes but only ${expectedDownload} had changed.`);
      } else {
        notes.push(
          `differential download rebuilt the installer from ${out.downloaded} of ${out.bytes} bytes`,
        );
      }
    } catch (error) {
      fail(`the differential self-test crashed: ${error.message}`);
    } finally {
      if (served) await new Promise((resolve) => served.server.close(resolve));
    }
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  return { problems, notes };
}

module.exports = { verifyUpdatePath };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : "";
  };
  const releaseDir = path.resolve(flag("release") || path.join(ROOT, "release"));
  const installer = path.resolve(flag("installer") || "");
  const version = String(flag("version") || "").replace(/^v/i, "");
  if (!flag("installer") || !version || !fs.existsSync(installer)) {
    console.error(
      "[friday] usage: verify-update-path.cjs --release <dir> --installer <file> --version <v>",
    );
    process.exit(2);
  }
  verifyUpdatePath({ releaseDir, installer, version }).then(({ problems, notes }) => {
    for (const note of notes) console.log(`[friday] ok       Update path: ${note}`);
    for (const problem of problems) console.error(`[friday] UPDATE   ${problem}`);
    if (problems.length) {
      console.error(
        `[friday] update path failed (${problems.length} problem${problems.length === 1 ? "" : "s"}).`,
      );
      process.exit(1);
    }
  });
}
