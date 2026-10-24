/**
 * The update path is proven on every built installer (PR Validation, FRIDAY
 * Release and the CMD build all run verify-build, which runs this). Here the
 * installer is a stand-in with a block map; the checks are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const { verifyUpdatePath } = require_(path.join(root, "scripts/verify-update-path.cjs"));
const manifestScript = require_(path.join(root, "scripts/release-manifest.cjs"));

const VERSION = "9.9.9.9";
const NAME = `FRIDAY-Setup-${VERSION}.exe`;
const BLOCK = 16 * 1024;

function blockMap(data: Buffer) {
  const checksums: string[] = [];
  const sizes: number[] = [];
  for (let at = 0; at < data.length; at += BLOCK) {
    const chunk = data.subarray(at, Math.min(at + BLOCK, data.length));
    checksums.push(crypto.createHash("sha256").update(chunk).digest("base64"));
    sizes.push(chunk.length);
  }
  return { version: "2", files: [{ name: "file", offset: 0, checksums, sizes }] };
}

let dir = "";
let installer = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-uup-"));
  installer = path.join(dir, NAME);
  const data = crypto.randomBytes(BLOCK * 90 + 321);
  fs.writeFileSync(installer, data);
  fs.writeFileSync(`${installer}.blockmap`, zlib.gzipSync(JSON.stringify(blockMap(data))));
  fs.writeFileSync(path.join(dir, "latest.yml"), `version: ${VERSION}\n`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = () => verifyUpdatePath({ releaseDir: dir, installer, version: VERSION });

describe("verify the update path on a built installer", () => {
  it("passes for an installer with a matching block map and rebuilds a changed copy from ranges", async () => {
    const out = await run();
    expect(out.problems).toEqual([]);
    expect(out.notes.join("\n")).toContain("block map describes the installer exactly");
    expect(out.notes.join("\n")).toContain("differential download rebuilt the installer from");
    expect(out.notes.join("\n")).toContain(
      "the app finds the installer's checksum in the manifest",
    );
  }, 30_000);

  it("changes nothing in the release folder", async () => {
    const before = fs.readdirSync(dir).sort();
    await run();
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  }, 30_000);

  it("fails when electron-builder wrote no block map", async () => {
    fs.rmSync(`${installer}.blockmap`);
    const out = await run();
    expect(out.problems.join("\n")).toContain("blockmap is missing");
  });

  it("fails when the block map is for a different file", async () => {
    fs.writeFileSync(
      `${installer}.blockmap`,
      zlib.gzipSync(JSON.stringify(blockMap(crypto.randomBytes(BLOCK * 10)))),
    );
    const out = await run();
    expect(out.problems.join("\n")).toContain("block map describes");
  });

  it("fails when the block map is not readable", async () => {
    fs.writeFileSync(`${installer}.blockmap`, "not gzip");
    const out = await run();
    expect(out.problems.join("\n")).toContain("cannot be read");
  });
});

describe("the manifest lists the block map", () => {
  it("publishes it as metadata, never as a second installer", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "friday-man-"));
    try {
      const manifest = manifestScript.build({
        version: VERSION,
        releaseDir: dir,
        outDir: out,
        syncLatest: false,
      });
      const map = manifest.assets.find((a: { name: string }) => a.name === `${NAME}.blockmap`);
      expect(map).toMatchObject({ kind: "metadata" });
      expect(manifest.assets.filter((a: { kind: string }) => a.kind === "installer")).toHaveLength(
        1,
      );
      expect(fs.readFileSync(path.join(out, "SHA256SUMS.txt"), "utf8")).toContain(
        `  ${NAME}.blockmap`,
      );
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("wired into every build", () => {
  it("runs from verify-build, which PR Validation, FRIDAY Release and the CMD build all call", () => {
    const verify = fs.readFileSync(path.join(root, "scripts/verify-build.cjs"), "utf8");
    expect(verify).toContain("verify-update-path.cjs");
    const pipeline = fs.readFileSync(path.join(root, "scripts/build-pipeline.cjs"), "utf8");
    expect(pipeline).toContain('"scripts/verify-build.cjs"');
    const pr = fs.readFileSync(path.join(root, ".github/workflows/pr-validation.yml"), "utf8");
    expect(pr).toContain("node scripts/verify-build.cjs nsis");
  });
});
