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
