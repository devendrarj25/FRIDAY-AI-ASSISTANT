/**
 * FRIDAY Release reads the published assets back and checks them the way an
 * installed FRIDAY would. The assets here are a stand-in release written by the
 * real manifest script; the checks are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const { verifyPublishedRelease, parseLatest } = require_(
  path.join(root, "scripts/verify-published-release.cjs"),
);
const manifestScript = require_(path.join(root, "scripts/release-manifest.cjs"));

const VERSION = "9.9.9.9";
const SETUP = `FRIDAY-Setup-${VERSION}.exe`;

let dir = "";
const file = (name: string) => path.join(dir, name);
const run = () => verifyPublishedRelease({ dir, version: VERSION });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pub-"));
  const installer = crypto.randomBytes(4096);
  fs.writeFileSync(file(SETUP), installer);
  fs.writeFileSync(file(`FRIDAY-Portable-${VERSION}.exe`), crypto.randomBytes(2048));
  fs.writeFileSync(file(`${SETUP}.blockmap`), crypto.randomBytes(256));
  fs.writeFileSync(
    file("latest.yml"),
    [
      `version: ${VERSION}`,
      "files:",
      `  - url: ${SETUP}`,
      `    sha512: ${crypto.createHash("sha512").update(installer).digest("base64")}`,
      `    size: ${installer.length}`,
      `path: ${SETUP}`,
      `sha512: ${crypto.createHash("sha512").update(installer).digest("base64")}`,
      "releaseDate: '2026-01-01T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
  manifestScript.build({ version: VERSION, releaseDir: dir, outDir: dir, syncLatest: false });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("verify the published release", () => {
  it("passes when every uploaded file is the one the manifest describes", () => {
    const out = run();
    expect(out.problems).toEqual([]);
    expect(out.notes.join("\n")).toContain("match friday-update.json (size and SHA-256)");
    expect(out.notes.join("\n")).toContain("latest.yml names this version");
  });

  it("fails when an uploaded file is not the one that was verified", () => {
    fs.appendFileSync(file(SETUP), "x");
    expect(run().problems.join("\n")).toContain(`${SETUP} is 4097 bytes on the release`);
  });

  it("fails on a same-size file with other bytes", () => {
    const bytes = fs.readFileSync(file(SETUP));
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    fs.writeFileSync(file(SETUP), bytes);
    const text = run().problems.join("\n");
    expect(text).toContain("does not match its SHA-256");
    expect(text).toContain("latest.yml carries a SHA-512 that is not the uploaded installer's");
  });

  it("fails when an asset the manifest lists was never uploaded", () => {
    fs.rmSync(file(`${SETUP}.blockmap`));
    expect(run().problems.join("\n")).toContain("was not uploaded to the release");
  });

  it("fails when the manifest is for another version", () => {
    const manifest = JSON.parse(fs.readFileSync(file("friday-update.json"), "utf8"));
    fs.writeFileSync(
      file("friday-update.json"),
      JSON.stringify({ ...manifest, version: "9.9.9.8", tag: "v9.9.9.8" }),
    );
    expect(run().problems.join("\n")).toContain("friday-update.json is for v9.9.9.8");
  });

  it("fails when the checksum list disagrees with the manifest", () => {
    const sums = fs.readFileSync(file("SHA256SUMS.txt"), "utf8");
    fs.writeFileSync(
      file("SHA256SUMS.txt"),
      sums.replace(/[0-9a-f]/, (c) => (c === "0" ? "1" : "0")),
    );
    expect(run().problems.join("\n")).toContain("SHA256SUMS.txt does not agree");
  });

  it("fails when latest.yml points at another installer", () => {
    const latest = fs.readFileSync(file("latest.yml"), "utf8");
    fs.writeFileSync(file("latest.yml"), latest.replace(/^path: .*$/m, "path: Other.exe"));
    expect(run().problems.join("\n")).toContain("latest.yml points at Other.exe");
  });

  it("fails clearly when the manifest was not uploaded at all", () => {
    fs.rmSync(file("friday-update.json"));
    expect(run().problems.join("\n")).toContain("friday-update.json cannot be read");
  });

  it("reads the flat latest.yml keys and the first file size", () => {
    expect(parseLatest(fs.readFileSync(file("latest.yml"), "utf8"))).toMatchObject({
      version: VERSION,
      path: SETUP,
      size: 4096,
    });
  });
});

describe("a TEST build", () => {
  const TEST = "9.9.9.9-test.1";
  const setup = `FRIDAY-Test-Setup-${TEST}.exe`;
  it("is verified too, and latest.yml may carry the base line of its stamp", () => {
    const test = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pub-test-"));
    try {
      const bytes = crypto.randomBytes(1024);
      fs.writeFileSync(path.join(test, setup), bytes);
      fs.writeFileSync(path.join(test, `FRIDAY-Portable-${TEST}.exe`), crypto.randomBytes(512));
      fs.writeFileSync(path.join(test, `${setup}.blockmap`), crypto.randomBytes(64));
      const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
      fs.writeFileSync(
        path.join(test, "latest.yml"),
        `version: 9.9.9.9\nfiles:\n  - url: ${setup}\n    sha512: ${sha512}\n    size: 1024\npath: ${setup}\nsha512: ${sha512}\n`,
      );
      manifestScript.build({
        version: TEST,
        channel: "test",
        releaseDir: test,
        outDir: test,
        syncLatest: false,
      });
      expect(verifyPublishedRelease({ dir: test, version: TEST }).problems).toEqual([]);
      fs.rmSync(path.join(test, `${setup}.blockmap`));
      expect(verifyPublishedRelease({ dir: test, version: TEST }).problems.join("\n")).toContain(
        "was not uploaded",
      );
    } finally {
      fs.rmSync(test, { recursive: true, force: true });
    }
  });

  it("uploads the block map its manifest lists and reads the prerelease back", () => {
    const wf = fs.readFileSync(path.join(root, ".github/workflows/test-build.yml"), "utf8");
    expect(wf).toContain('assets+=("$setup.blockmap")');
    const readBack = wf.indexOf("scripts/verify-published-release.cjs");
    expect(readBack).toBeGreaterThan(wf.indexOf("gh release create"));
    expect(readBack).toBeLessThan(wf.indexOf("Keep only the last 3 TEST prereleases"));
  });
});

describe("FRIDAY Release runs it after publishing", () => {
  const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  it("downloads the release and verifies it in the confirm job, after the asset check", () => {
    const confirm = release.slice(release.indexOf("\n  confirm:"));
    const readBack = confirm.indexOf("Read the published assets back and verify them");
    expect(readBack).toBeGreaterThan(
      confirm.indexOf("Confirm the published release and its assets"),
    );
    expect(confirm.slice(readBack)).toContain('gh release download "v$VERSION"');
    expect(confirm.slice(readBack)).toContain("scripts/verify-published-release.cjs");
  });
});
