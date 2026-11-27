/**
 * <root>/inventory.json writes down where each thing FRIDAY uses is installed,
 * from the real scan and the real folders, and only rewrites when it changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const inventory = require("../../electron/install-inventory.cjs");
const registry = require("../../electron/root-registry.cjs");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inventory-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const tool = (over: Record<string, unknown>) => ({
  id: "x",
  category: "Tool",
  installed: true,
  version: "1.0.0",
  path: null,
  manager: "winget",
  status: "Ready",
  ...over,
});

describe("install homes", () => {
  it("puts pip libraries in the managed environment, tools FRIDAY unpacked in runtime, system installs on the machine", () => {
    const unpacked = path.join(root, "runtime", "node", "node.exe");
    expect(inventory.homeOf(tool({ manager: "pip" }), root)).toBe("friday-python-env");
    expect(inventory.homeOf(tool({ manager: "npm" }), root)).toBe("npm-global");
    expect(inventory.homeOf(tool({ manager: "vendor", path: unpacked }), root)).toBe(
      "friday-runtime",
    );
    expect(inventory.homeOf(tool({ path: "C:\\Program Files\\Git\\cmd\\git.exe" }), root)).toBe(
      "machine",
    );
    // A tool FRIDAY has not unpacked yet would be unpacked into runtime, not scattered.
    expect(inventory.homeOf(tool({ manager: "vendor", installed: false, path: null }), root)).toBe(
      "friday-runtime",
    );
  });

  it("never names the program folder as a home", () => {
    expect(Object.keys(inventory.HOMES).some((home) => /app/i.test(home))).toBe(false);
  });
});

describe("inventory.json", () => {
  const scan = {
    at: 1_700_000_000_000,
    tools: [
      tool({ id: "Git", path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.50.0" }),
      tool({ id: "FFmpeg", version: "9.0" }),
      tool({ id: "faster-whisper", manager: "pip", version: "1.2.0" }),
      tool({ id: "Rust", installed: false, version: null, status: "Missing" }),
      tool({ id: "Git alias", aliasOf: "Git" }),
    ],
  };

  it("lists tools with their home, flags updates and skips duplicate alias rows", () => {
    fs.mkdirSync(path.join(root, "models", "qwen2.5-1.5b-instruct"), { recursive: true });
    fs.mkdirSync(path.join(root, "cache", "stt", "small"), { recursive: true });
    const built = inventory.buildInventory(root, {
      tools: scan.tools,
      latest: { Git: "2.51.0", FFmpeg: { version: "9.0" } },
      version: "1.1.4.5",
      at: scan.at,
    });
    const byId = Object.fromEntries(built.items.map((row: { id: string }) => [row.id, row]));
    expect(byId["Git"].home).toBe("machine");
    expect(byId["Git"].updateAvailable).toBe(true);
    expect(byId["Git"].removedByDeleteAllData).toBe(false);
    expect(byId["FFmpeg"].updateAvailable).toBe(false);
    expect(byId["faster-whisper"].home).toBe("friday-python-env");
    expect(byId["faster-whisper"].removedByDeleteAllData).toBe(true);
    expect(byId["Rust"].installed).toBe(false);
    expect(byId["Git alias"]).toBeUndefined();
    expect(byId["qwen2.5-1.5b-instruct"].home).toBe("friday-models");
    expect(byId["stt-small"].home).toBe("friday-speech");
    expect(built.totals.updatesAvailable).toBe(1);
    expect(built.totals.byHome["machine"]).toBe(2);
  });

  it("writes once, and rewrites only when something changed", () => {
    const first = inventory.writeInventory(root, scan, { version: "1.1.4.5" });
    expect(first.written).toBe(true);
    expect(inventory.readInventory(root).items.length).toBeGreaterThan(0);
    const later = { ...scan, at: scan.at + 60_000 };
    expect(inventory.writeInventory(root, later, { version: "1.1.4.5" }).written).toBe(false);
    fs.mkdirSync(path.join(root, "models", "new-model"), { recursive: true });
    expect(inventory.writeInventory(root, scan, { version: "1.1.4.5" }).written).toBe(true);
  });

  it("does nothing without a root or a scan", () => {
    expect(inventory.writeInventory("", scan).written).toBe(false);
    expect(inventory.writeInventory(root, null).written).toBe(false);
    expect(fs.existsSync(path.join(root, inventory.FILE))).toBe(false);
  });

  it("is one of the root's own descriptors and is wired to the scan", () => {
    expect(registry.DESCRIPTOR_FILES).toContain(inventory.FILE);
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.cjs"), "utf8");
    expect(main).toContain("recordInventory(scan)");
    expect(main).toContain("recordInventory(toolchain.lastDetected())");
  });
});

describe("post-update model check", () => {
  const sha = "a".repeat(64);
  const coreManifest = {
    schemaVersion: 1,
    diskDir: "models/friday-core",
    variants: [
      {
        id: "e4b",
        files: [
          {
            kind: "weights",
            disk: "core-e4b.gguf",
            bytes: 8,
            sha256: sha,
            upstream: { repo: "o/r", revision: "r1", file: "core-e4b.gguf" },
          },
          {
            kind: "projector",
            disk: "core-e4b-mmproj.gguf",
            bytes: 4,
            sha256: sha,
            upstream: { repo: "o/r", revision: "r1", file: "core-e4b-mmproj.gguf" },
          },
        ],
      },
      {
        id: "e2b",
        files: [
          {
            kind: "weights",
            disk: "core-e2b.gguf",
            bytes: 6,
            sha256: sha,
            upstream: { repo: "o/r", revision: "r1", file: "core-e2b.gguf" },
          },
        ],
      },
    ],
  };
  const voiceRows = [
    { id: "stt-pin-small", label: "FRIDAY Ear small matches its pin", ok: true, detail: "ok" },
    { id: "tts-pin", label: "FRIDAY Voice matches its pin", ok: false, detail: "x wrong size" },
  ];
  const weights = (rows = voiceRows, seen: Array<Record<string, unknown>> = []) => ({
    pinChecks: async (_root: string, deps: Record<string, unknown>) => {
      seen.push(deps);
      return rows;
    },
  });
  const coreDir = () => path.join(root, "models", "friday-core");
  const put = (name: string, size: number) => {
    fs.mkdirSync(coreDir(), { recursive: true });
    fs.writeFileSync(path.join(coreDir(), name), Buffer.alloc(size, 1));
  };
  const base = () => ({ weights: weights(), manifest: coreManifest });

  it("reads the voice pin rows by size only and flags a bad one without touching the disk", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await inventory.checkDownloadedModels(root, {
      weights: weights(voiceRows, seen),
      manifest: coreManifest,
    });
    expect(seen[0]?.["hash"]).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.hashed).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.bad).toEqual([
      {
        source: "voice",
        id: "tts-pin",
        label: "FRIDAY Voice matches its pin",
        detail: "x wrong size",
      },
    ]);
  });

  it("flags a FRIDAY Core file of the wrong size or a missing sibling, and deletes nothing", async () => {
    put("core-e4b.gguf", 5); // pinned 8
    put("core-e2b.gguf", 6); // pinned 6: good
    const result = await inventory.checkDownloadedModels(root, {
      ...base(),
      weights: weights([]),
    });
    const ids = result.bad.map((row: { id: string }) => row.id).sort();
    expect(ids).toEqual(["core-e4b-mmproj.gguf", "core-e4b.gguf"]);
    expect(result.ok).toBe(false);
    expect(fs.statSync(path.join(coreDir(), "core-e4b.gguf")).size).toBe(5);
    expect(fs.existsSync(path.join(coreDir(), "core-e2b.gguf"))).toBe(true);
  });

  it("does not flag a Core variant that is simply not installed", async () => {
    const result = await inventory.checkDownloadedModels(root, {
      ...base(),
      weights: weights([]),
    });
    expect(result.bad).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("catches a same-size corrupt Core file only when asked to hash", async () => {
    put("core-e2b.gguf", 6);
    const fastOnly = await inventory.checkDownloadedModels(root, {
      ...base(),
      weights: weights([]),
    });
    expect(fastOnly.ok).toBe(true);
    const hashed = await inventory.checkDownloadedModels(root, {
      ...base(),
      weights: weights([]),
      hash: true,
    });
    expect(hashed.hashed).toBe(true);
    expect(hashed.bad.map((row: { id: string }) => row.id)).toEqual(["core-e2b.gguf"]);
    expect(hashed.bad[0].detail).toMatch(/sha256|SHA-256/i);
    expect(fs.existsSync(path.join(coreDir(), "core-e2b.gguf"))).toBe(true);
  });

  it("turns a result into one Doctor row that names the files and says nothing was deleted", () => {
    const green = inventory.modelCheckRow({
      ok: true,
      checked: 3,
      hashed: false,
      bad: [],
      errors: [],
    });
    expect(green.id).toBe("models-after-update");
    expect(green.ok).toBe(true);
    expect(green.required).toBe(false);
    expect(green.detail).toMatch(/3/);
    const red = inventory.modelCheckRow({
      ok: false,
      checked: 3,
      hashed: false,
      bad: [{ source: "voice", id: "tts-pin", label: "FRIDAY Voice", detail: "x wrong size" }],
      errors: [],
    });
    expect(red.ok).toBe(false);
    expect(red.detail).toContain("tts-pin");
    expect(red.detail).toMatch(/not deleted/i);
    expect(red.badIds).toEqual(["tts-pin"]);
    const broken = inventory.modelCheckRow({
      ok: false,
      checked: 0,
      hashed: false,
      bad: [],
      errors: ["voice: boom"],
    });
    expect(broken.ok).toBe(false);
    expect(broken.detail).toContain("boom");
  });

  it("runs once per version, records the outcome in inventory.json and keeps it across rewrites", async () => {
    const scan = { at: 1_700_000_000_000, tools: [tool({ id: "FFmpeg" })] };
    inventory.writeInventory(root, scan, { version: "1.2.5.8" });
    expect(inventory.needsModelCheck(root, "1.2.5.8")).toBe(true);
    const first = await inventory.postUpdateCheck(root, { ...base(), version: "1.2.5.8", now: 5 });
    expect(first.ran).toBe(true);
    expect(first.persisted).toBe(true);
    expect(first.row.ok).toBe(false);
    const record = inventory.readInventory(root).modelCheck;
    expect(record).toMatchObject({
      version: "1.2.5.8",
      ok: false,
      hashed: false,
      bad: ["tts-pin"],
    });
    expect(inventory.needsModelCheck(root, "1.2.5.8")).toBe(false);
    // The next scan rewrites inventory.json; the record is kept and an unchanged scan writes nothing.
    expect(
      inventory.writeInventory(root, { ...scan, at: scan.at + 1 }, { version: "1.2.5.8" }).written,
    ).toBe(false);
    expect(inventory.readInventory(root).modelCheck.version).toBe("1.2.5.8");
    fs.mkdirSync(path.join(root, "models", "new-model"), { recursive: true });
    expect(inventory.writeInventory(root, scan, { version: "1.2.5.8" }).written).toBe(true);
    expect(inventory.readInventory(root).modelCheck.version).toBe("1.2.5.8");
    const again = await inventory.postUpdateCheck(root, { ...base(), version: "1.2.5.8" });
    expect(again.ran).toBe(false);
    const next = await inventory.postUpdateCheck(root, { ...base(), version: "1.2.5.9" });
    expect(next.ran).toBe(true);
  });

  it("hashes on request (Doctor repair) even when this version was already checked", async () => {
    inventory.writeInventory(root, { at: 1, tools: [] }, { version: "1.2.5.8" });
    await inventory.postUpdateCheck(root, { ...base(), version: "1.2.5.8" });
    const seen: Array<Record<string, unknown>> = [];
    const full = await inventory.verifyModelHashes(root, {
      weights: weights(voiceRows, seen),
      manifest: coreManifest,
      version: "1.2.5.8",
    });
    expect(seen[0]?.["hash"]).toBe(true);
    expect(full.result.hashed).toBe(true);
    expect(inventory.readInventory(root).modelCheck.hashed).toBe(true);
  });

  it("never throws: a failing source is reported, and the version is not marked as checked", async () => {
    inventory.writeInventory(root, { at: 1, tools: [] }, { version: "1.2.5.8" });
    const boom = {
      pinChecks: async () => {
        throw new Error("boom");
      },
    };
    const out = await inventory.postUpdateCheck(root, {
      weights: boom,
      manifest: coreManifest,
      version: "1.2.5.8",
    });
    expect(out.ran).toBe(true);
    expect(out.persisted).toBe(false);
    expect(out.result.errors.join(" ")).toContain("boom");
    expect(out.row.ok).toBe(false);
    expect(inventory.needsModelCheck(root, "1.2.5.8")).toBe(true);
  });

  it("does nothing without a root or a version, and never removes a file (source pin)", async () => {
    expect((await inventory.postUpdateCheck("", { version: "1" })).ran).toBe(false);
    expect((await inventory.postUpdateCheck(root, {})).ran).toBe(false);
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "electron", "install-inventory.cjs"),
      "utf8",
    );
    expect(source).not.toMatch(/rmSync|unlinkSync|rmdirSync|removeBad|quarantine/);
  });
});
