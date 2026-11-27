/**
 * What the FRIDAY Release workflow publishes is exactly what the installed app
 * knows how to detect, verify, download and install — and what a new version
 * ships as defaults reaches the owner's config without overwriting their edits.
 * The workflow file is only read here, never run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const sync = require_(path.join(root, "electron/github-sync.cjs"));
const seed = require_(path.join(root, "electron/config-seed.cjs"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

describe("the release workflow and the app agree", () => {
  const publish = workflow.slice(workflow.indexOf("- name: Create GitHub Release"));
  const loop = publish.slice(publish.indexOf("for asset in"), publish.indexOf("; do"));
  const listed = [...loop.matchAll(/"([^"]+)"/g)]
    .map((m) =>
      String(m[1])
        .replace(/^release\//, "")
        .replace("${{ steps.plan.outputs.version }}", "9.9.9"),
    )
    .filter((name) => /\.(exe|yml|json|txt|md|blockmap)$/.test(name));

  it("publishes the installer, the portable app, the manifest, checksums and notes", () => {
    expect(listed).toEqual(
      expect.arrayContaining([
        "FRIDAY-Setup-9.9.9.exe",
        "FRIDAY-Portable-9.9.9.exe",
        "latest.yml",
        "friday-update.json",
        "SHA256SUMS.txt",
        "CHANGELOG.md",
        // Lets the next update fetch only what changed (differential download).
        "FRIDAY-Setup-9.9.9.exe.blockmap",
      ]),
    );
  });

  it("knows what every published file is, and installs only the installer", () => {
    const kinds = Object.fromEntries(listed.map((name) => [name, sync.classifyAsset(name).kind]));
    expect(kinds).toMatchObject({
      "FRIDAY-Setup-9.9.9.exe": "installer",
      "FRIDAY-Portable-9.9.9.exe": "portable",
      "latest.yml": "updater-metadata",
      "friday-update.json": "update-manifest",
      "SHA256SUMS.txt": "checksums",
      "CHANGELOG.md": "notes",
      "FRIDAY-Setup-9.9.9.exe.blockmap": "updater-metadata",
    });
    expect(sync.classifyAsset("FRIDAY-Setup-9.9.9.exe").installable).toBe(true);
    expect(sync.classifyAsset("friday-update.json").installable).toBe(false);
  });

  it("refuses to publish a release the app could not verify", () => {
    expect(publish).toContain("update manifest missing — release stopped.");
    expect(publish).toContain("update manifest was not uploaded — release incomplete.");
  });

  it("finds the checksum of the installer in the manifest the workflow writes", () => {
    const manifest = {
      version: "9.9.9",
      assets: [
        { name: "FRIDAY-Setup-9.9.9.exe", sha256: "aa" },
        { name: "FRIDAY-Portable-9.9.9.exe", sha256: "bb" },
      ],
    };
    expect(sync.expectedChecksum(manifest, "FRIDAY-Setup-9.9.9.exe")).toBe("aa");
    expect(sync.expectedChecksum(manifest, "missing.exe")).toBeNull();
    const builder = fs.readFileSync(path.join(root, "scripts/release-manifest.cjs"), "utf8");
    expect(builder).toContain("sha256: sha256(a.file)");
    expect(builder).toContain("friday-update.json");
  });
});

describe("shipped defaults reach the owner's config without overwriting edits", () => {
  let dir = "";
  let shipped = "";
  const names = ["kernel.yaml"];
  const put = (file: string, text: string) => fs.writeFileSync(file, text);
  const run = () =>
    seed.syncSeedConfig({ dir, names, resolve: (n: string) => path.join(shipped, n) });

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-seed-"));
    dir = path.join(base, "config");
    shipped = path.join(base, "shipped");
    fs.mkdirSync(dir);
    fs.mkdirSync(shipped);
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  it("copies a missing file and then leaves a current one alone", () => {
    put(path.join(shipped, "kernel.yaml"), "v1");
    expect(run()).toEqual([{ name: "kernel.yaml", action: "copied" }]);
    expect(fs.readFileSync(path.join(dir, "kernel.yaml"), "utf8")).toBe("v1");
    expect(run()).toEqual([{ name: "kernel.yaml", action: "current" }]);
  });

  it("brings a newer shipped file forward when the owner never changed theirs", () => {
    put(path.join(shipped, "kernel.yaml"), "v1");
    run();
    put(path.join(shipped, "kernel.yaml"), "v2");
    expect(run()).toEqual([{ name: "kernel.yaml", action: "updated" }]);
    expect(fs.readFileSync(path.join(dir, "kernel.yaml"), "utf8")).toBe("v2");
    expect(fs.readFileSync(path.join(dir, "kernel.yaml.bak"), "utf8")).toBe("v1");
  });

  it("never overwrites a file the owner edited; the new one is saved beside it", () => {
    put(path.join(shipped, "kernel.yaml"), "v1");
    run();
    put(path.join(dir, "kernel.yaml"), "v1 + my change");
    put(path.join(shipped, "kernel.yaml"), "v2");
    expect(run()).toEqual([{ name: "kernel.yaml", action: "kept" }]);
    expect(fs.readFileSync(path.join(dir, "kernel.yaml"), "utf8")).toBe("v1 + my change");
    expect(fs.readFileSync(path.join(dir, "kernel.yaml.new"), "utf8")).toBe("v2");
  });

  it("treats a copy from before this was tracked as the owner's", () => {
    put(path.join(dir, "kernel.yaml"), "old copy");
    put(path.join(shipped, "kernel.yaml"), "v2");
    expect(run()).toEqual([{ name: "kernel.yaml", action: "kept" }]);
    expect(fs.readFileSync(path.join(dir, "kernel.yaml"), "utf8")).toBe("old copy");
  });

  it("is wired into start-up and survives a missing shipped file", () => {
    expect(fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8")).toContain(
      "syncSeedConfig",
    );
    expect(seed.syncSeedConfig({ dir, names: ["nope.yaml"], resolve: () => null })).toEqual([]);
  });
});

describe("the build record (friday-bundle.json) travels with every manifest", () => {
  const bundleLib = require_(path.join(root, "electron/build-bundle.cjs"));
  const manifestScript = require_(path.join(root, "scripts/release-manifest.cjs"));
  const VERSION = "9.9.9.9";
  const SETUP = `FRIDAY-Setup-${VERSION}.exe`;
  const made: string[] = [];
  const hex = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

  /** A release folder, a packed-resources folder and a FRIDAY folder, all in a throwaway tree. */
  function stage() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-bundle-rel-"));
    made.push(base);
    const dir = path.join(base, "release");
    const res = path.join(base, "resources");
    const home = path.join(base, "home");
    fs.mkdirSync(path.join(res, "toolchain", "wheelhouse"), { recursive: true });
    fs.mkdirSync(path.join(home, "models"), { recursive: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, SETUP), "installer bytes");
    fs.writeFileSync(path.join(dir, `FRIDAY-Portable-${VERSION}.exe`), "portable bytes");
    fs.writeFileSync(path.join(dir, `${SETUP}.blockmap`), "blocks");
    fs.writeFileSync(path.join(dir, "latest.yml"), `version: ${VERSION}\n`);
    fs.writeFileSync(path.join(res, "builtins.json"), '{"builtins":[]}');
    fs.writeFileSync(path.join(res, "toolchain", "wheelhouse", "pack.bin"), "wheels");
    return { base, dir, res, home };
  }
  const run = (s: ReturnType<typeof stage>, extra: Record<string, unknown> = {}) =>
    manifestScript.build({
      version: VERSION,
      releaseDir: s.dir,
      outDir: s.dir,
      syncLatest: false,
      resourcesDir: s.res,
      fridayRoot: s.home,
      commit: null,
      env: {},
      ...extra,
    });
  const bundleOf = (s: ReturnType<typeof stage>) =>
    bundleLib.read(path.join(s.dir, "friday-bundle.json"));
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("writes release/friday-bundle.json: app files, what the EXE carries and the weight packs", () => {
    const s = stage();
    run(s, { caller: "release" });
    const bundle = bundleOf(s);
    expect(bundle).not.toBeNull();
    expect(bundle).toMatchObject({
      schema: 1,
      version: VERSION,
      channel: "stable",
      caller: "release",
    });
    const byKind = Object.fromEntries(bundle.app.map((a: { kind: string }) => [a.kind, a]));
    expect(Object.keys(byKind).sort()).toEqual([
      "blockmap",
      "installer",
      "latest",
      "portable",
      "sums",
    ]);
    expect(byKind["installer"]).toEqual({
      name: SETUP,
      kind: "installer",
      bytes: 15,
      sha256: hex("installer bytes"),
    });
    expect(byKind["sums"].sha256).toBe(hex(fs.readFileSync(path.join(s.dir, "SHA256SUMS.txt"))));
    expect(bundle.inExe).toEqual({
      builtins: { sha256: hex('{"builtins":[]}') },
      wheelhouse: { bytes: 6, sha256: hex("wheels") },
    });
    const ids = bundle.packs.map((p: { id: string }) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["voice-weights", "brain-weights", "recall-weights"]),
    );
    for (const p of bundle.packs) {
      expect(p).toMatchObject({ location: "release", dir: null });
      expect(p.tag).toMatch(/^friday-/);
    }
    expect(bundle.models).toEqual([]);
    // Same inputs, same bytes: no clock in the record.
    const first = fs.readFileSync(path.join(s.dir, "friday-bundle.json"));
    run(s, { caller: "release" });
    expect(fs.readFileSync(path.join(s.dir, "friday-bundle.json")).equals(first)).toBe(true);
  });

  it("names the bundle in friday-update.json without growing assets or the checksum list", () => {
    const s = stage();
    fs.writeFileSync(path.join(s.dir, `FRIDAY-Test-Setup-${VERSION}-test.2.exe`), "test installer");
    const manifest = run(s, { caller: "test", channel: "test", version: `${VERSION}-test.2` });
    const file = path.join(s.dir, "friday-bundle.json");
    const bytes = fs.readFileSync(file);
    expect(manifest.bundle).toEqual({
      name: "friday-bundle.json",
      bytes: bytes.length,
      sha256: hex(bytes),
    });
    const written = JSON.parse(fs.readFileSync(path.join(s.dir, "friday-update.json"), "utf8"));
    expect(written.bundle).toEqual(manifest.bundle);
    expect(written.assets.map((a: { name: string }) => a.name)).not.toContain("friday-bundle.json");
    expect(fs.readFileSync(path.join(s.dir, "SHA256SUMS.txt"), "utf8")).not.toContain(
      "friday-bundle",
    );
    // A test version keeps its stamp in the manifest; the record names the base line.
    expect(bundleOf(s)).toMatchObject({ version: VERSION, channel: "test", caller: "test" });
  });

  it("lists the model folders on this PC only for a CMD build, hashes them, and never fails on a gap", () => {
    const s = stage();
    const put = (rel: string, text: string) => {
      const file = path.join(s.home, "models", ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    put("friday-ear-tiny/config.json", "{}");
    put("friday-ear-tiny/sub/model.bin", "weights");
    put("friday-ear-half/model.bin.part", "unfinished");
    put(".staging/x.bin", "scratch");
    run(s, { caller: "cmd" });
    expect(bundleOf(s).models).toEqual([
      {
        fridayId: "friday-ear-tiny",
        dir: "models/friday-ear-tiny",
        bytes: 9,
        files: [
          { path: "config.json", bytes: 2, sha256: hex("{}") },
          { path: "sub/model.bin", bytes: 7, sha256: hex("weights") },
        ],
      },
    ]);
    // Other callers, the off switch and a missing folder each give an honest empty list.
    run(s, { caller: "release" });
    expect(bundleOf(s).models).toEqual([]);
    run(s, { caller: "cmd", env: { FRIDAY_BUNDLE_MODELS: "0" } });
    expect(bundleOf(s).models).toEqual([]);
    fs.rmSync(path.join(s.home, "models"), { recursive: true, force: true });
    expect(() => run(s, { caller: "cmd" })).not.toThrow();
    expect(bundleOf(s).models).toEqual([]);
  });
});
