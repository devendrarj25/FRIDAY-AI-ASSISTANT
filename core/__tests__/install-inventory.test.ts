/**
 * <root>/inventory.json writes down where each thing FRIDAY uses is installed,
 * from the real scan and the real folders, and only rewrites when it changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
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

/* ------------------------------------------------------------------ local builds, adopt-by-hash, busy retry */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const bundleFor = (modelDir: string, files: Array<{ path: string; text: string }>) => ({
  schema: 1,
  models: [
    {
      fridayId: path.basename(modelDir),
      dir: modelDir,
      bytes: files.reduce((sum, file) => sum + file.text.length, 0),
      files: files.map((file) => ({
        path: file.path,
        bytes: file.text.length,
        sha256: sha(file.text),
      })),
    },
  ],
});

describe("local build source on a row", () => {
  const scan = { at: 1, tools: [] as unknown[] };

  const seedModel = (name: string) => {
    fs.mkdirSync(path.join(root, "models", name), { recursive: true });
  };
  const seedBuild = (name: string, text: string) => {
    const build = path.join(root, "release");
    fs.mkdirSync(path.join(build, "models", name), { recursive: true });
    fs.writeFileSync(path.join(build, "models", name, "w.bin"), text);
    return build;
  };

  it("adds localSource {origin, dir} to a model row that a local bundle holds, through the injected function", () => {
    seedModel("alpha");
    seedModel("beta");
    const build = seedBuild("alpha", "alpha-weights");
    const localSources = () => [
      {
        origin: "release",
        dir: build,
        bundle: bundleFor("models/alpha", [{ path: "w.bin", text: "alpha-weights" }]),
      },
    ];
    const built = inventory.buildInventory(root, { ...scan, localSources });
    const alpha = built.items.find((row: { id: string }) => row.id === "alpha");
    const beta = built.items.find((row: { id: string }) => row.id === "beta");
    expect(alpha.localSource).toEqual({ origin: "release", dir: build });
    // Additive: a row that no bundle holds has no key at all, so old readers see today's shape.
    expect("localSource" in beta).toBe(false);
  });

  it("skips a bundle whose files are not on disk with the listed size, and survives a throwing source", () => {
    seedModel("alpha");
    const build = seedBuild("alpha", "short");
    const wrong = () => [
      {
        origin: "release",
        dir: build,
        bundle: bundleFor("models/alpha", [{ path: "w.bin", text: "alpha-weights" }]),
      },
    ];
    expect(
      inventory.buildInventory(root, { ...scan, localSources: wrong }).items[0].localSource,
    ).toBeUndefined();
    const boom = () => {
      throw new Error("registry offline");
    };
    const none = inventory.buildInventory(root, { ...scan, localSources: boom });
    expect(none.items).toHaveLength(1);
    expect(none.items[0].localSource).toBeUndefined();
  });

  it("is written into inventory.json by writeInventory and absent when no source is given", () => {
    seedModel("alpha");
    const build = seedBuild("alpha", "alpha-weights");
    const localSources = () => [
      {
        origin: "installers",
        dir: build,
        bundle: bundleFor("models/alpha", [{ path: "w.bin", text: "alpha-weights" }]),
      },
    ];
    inventory.writeInventory(root, scan, { version: "1", localSources });
    expect(inventory.readInventory(root).items[0].localSource).toEqual({
      origin: "installers",
      dir: build,
    });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inventory-plain-"));
    try {
      fs.mkdirSync(path.join(plain, "models", "alpha"), { recursive: true });
      inventory.writeInventory(plain, scan, { version: "1" });
      expect("localSource" in inventory.readInventory(plain).items[0]).toBe(false);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("adopt by hash", () => {
  const place = (name: string, text: string) => {
    const dest = path.join(root, "models", "m", name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    return dest;
  };

  it("keeps a file in its canonical place when size then SHA-256 match, and downloads nothing for it", async () => {
    const dest = place("w.bin", "weights");
    const hashed: string[] = [];
    const out = await inventory.adoptByHash(
      [{ id: "m/w.bin", dest, bytes: 7, sha256: sha("weights") }],
      {
        hashFile: async (file: string) => {
          hashed.push(file);
          return sha("weights");
        },
      },
    );
    expect(out.adopted).toEqual(["m/w.bin"]);
    expect(out.pending).toEqual([]);
    expect(out.items[0]).toMatchObject({ id: "m/w.bin", state: "adopted", adopted: true });
    expect(hashed).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("weights");
  });

  it("checks the size first and never hashes a file whose size differs (no cloud hydration of mismatches)", async () => {
    const dest = place("w.bin", "weights");
    const hashed: string[] = [];
    const out = await inventory.adoptByHash(
      [
        { id: "wrong-size", dest, bytes: 99, sha256: sha("weights") },
        { id: "absent", dest: path.join(root, "models", "m", "nope.bin"), bytes: 7, sha256: "a" },
      ],
      {
        hashFile: async (file: string) => {
          hashed.push(file);
          return sha("weights");
        },
      },
    );
    expect(hashed).toEqual([]);
    expect(out.adopted).toEqual([]);
    expect(out.pending).toEqual(["wrong-size", "absent"]);
    expect(out.items.map((row: { state: string }) => row.state)).toEqual(["size", "missing"]);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("hashes only on a size match, leaves a same-size different file untouched and does not adopt it", async () => {
    const dest = place("w.bin", "weightX");
    const out = await inventory.adoptByHash([
      { id: "m/w.bin", dest, bytes: 7, sha256: sha("weights") },
      { id: "no-pin", dest, bytes: 7, sha256: null },
    ]);
    expect(out.adopted).toEqual([]);
    expect(out.items.map((row: { state: string }) => row.state)).toEqual(["sha256", "no-pin"]);
    expect(fs.readFileSync(dest, "utf8")).toBe("weightX");
  });

  it("reports an unreadable file as pending instead of throwing", async () => {
    const dest = place("w.bin", "weights");
    const out = await inventory.adoptByHash(
      [{ id: "m/w.bin", dest, bytes: 7, sha256: sha("weights") }],
      {
        hashFile: async () => {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        },
      },
    );
    expect(out.adopted).toEqual([]);
    expect(out.items[0].state).toBe("unreadable");
  });
});

describe("busy retry", () => {
  const busy = (code = "EBUSY") => Object.assign(new Error(code), { code });

  it("tries up to five times with 100 to 800 ms backoff and returns the value of the first success", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await inventory.retryBusy(
      () => {
        calls += 1;
        if (calls < 3) throw busy(calls === 1 ? "EBUSY" : "EPERM");
        return "done";
      },
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    expect(out).toMatchObject({ ok: true, value: "done", tries: 3 });
    expect(waits).toEqual([100, 200]);
    expect(inventory.BUSY_RETRY).toEqual({ tries: 5, delays: [100, 200, 400, 800] });
  });

  it("gives up after five busy tries and reports the code, without sleeping after the last one", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await inventory.retryBusy(
      () => {
        calls += 1;
        throw busy("EBUSY");
      },
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    expect(calls).toBe(5);
    expect(waits).toEqual([100, 200, 400, 800]);
    expect(out).toMatchObject({ ok: false, tries: 5, code: "EBUSY" });
  });

  it("does not retry an error that is not a lock (a missing file fails at once)", async () => {
    let calls = 0;
    const out = await inventory.retryBusy(
      () => {
        calls += 1;
        throw busy("ENOENT");
      },
      { sleep: async () => undefined },
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, tries: 1, code: "ENOENT" });
  });

  it("replaces a copy once the lock clears", async () => {
    const dest = path.join(root, "w.bin");
    const src = `${dest}.part`;
    fs.writeFileSync(dest, "old");
    fs.writeFileSync(src, "new");
    let calls = 0;
    const out = await inventory.replaceKeepingOld(src, dest, {
      sleep: async () => undefined,
      rename: (from: string, to: string) => {
        calls += 1;
        if (calls < 3) throw busy();
        fs.renameSync(from, to);
      },
    });
    expect(out).toMatchObject({ ok: true, tries: 3 });
    expect(fs.readFileSync(dest, "utf8")).toBe("new");
  });

  it("keeps the OLD copy when the lock never clears, leaves the new file where it is and says so", async () => {
    const dest = path.join(root, "w.bin");
    const src = `${dest}.part`;
    fs.writeFileSync(dest, "old");
    fs.writeFileSync(src, "new");
    const out = await inventory.replaceKeepingOld(src, dest, {
      sleep: async () => undefined,
      rename: () => {
        throw busy("EPERM");
      },
    });
    expect(out).toMatchObject({ ok: false, kept: "old", code: "EPERM", tries: 5, src, dest });
    expect(out.detail).toMatch(/old copy kept/i);
    expect(fs.readFileSync(dest, "utf8")).toBe("old");
    expect(fs.readFileSync(src, "utf8")).toBe("new");
  });
});

describe("model check row wording", () => {
  const red = {
    ok: false,
    checked: 3,
    hashed: false,
    bad: [{ source: "voice", id: "tts-pin", label: "FRIDAY Voice", detail: "x wrong size" }],
    errors: [],
  };

  it("tells the owner what to do (Install Manager > Repair) and promises no automatic fix", () => {
    const row = inventory.modelCheckRow(red);
    expect(row.fixable).toBe(false);
    expect(row.detail).toMatch(/not deleted/i);
    expect(row.detail).toContain("tts-pin");
    expect(row.detail).not.toMatch(/repair fetches|will be repaired|fixed automatically/i);
    expect(row.fix).toMatch(/Install Manager/);
    expect(row.fix).toMatch(/Repair/);
    expect(row.badIds).toEqual(["tts-pin"]);
  });

  it("has no fix text on a green row", () => {
    const row = inventory.modelCheckRow({
      ok: true,
      checked: 2,
      hashed: true,
      bad: [],
      errors: [],
    });
    expect(row.fix ?? null).toBeNull();
    expect(row.fixable).toBe(false);
  });
});

describe("localSourceFor: the one matcher the catalog and the inventory share", () => {
  const seedBuild = (name: string, text: string) => {
    const build = path.join(root, "release");
    fs.mkdirSync(path.join(build, "models", name), { recursive: true });
    fs.writeFileSync(path.join(build, "models", name, "w.bin"), text);
    return build;
  };
  const entryFor = (build: string, name = "alpha", text = "alpha-weights") => ({
    origin: "release",
    dir: build,
    bundle: bundleFor(`models/${name}`, [{ path: "w.bin", text }]),
  });

  it("matches a catalog voice id and an inventory model id by the same name", () => {
    const build = seedBuild("alpha", "alpha-weights");
    const entries = [entryFor(build)];
    const want = { origin: "release", dir: build };
    expect(inventory.localSourceFor("alpha", entries)).toEqual(want);
    expect(inventory.localSourceFor("voice:alpha", entries)).toEqual(want);
    expect(inventory.localSourceFor("voice:ALPHA", entries)).toEqual(want);
    expect(inventory.localSourceFor("beta", entries)).toBeNull();
  });

  it("returns null for a model that is only inside the FRIDAY folder itself", () => {
    const build = seedBuild("alpha", "alpha-weights");
    const entries = [entryFor(build)];
    // Without a root the parent of the build folder (the root) is a base too; with the root named it is skipped.
    fs.mkdirSync(path.join(root, "models", "gamma"), { recursive: true });
    fs.writeFileSync(path.join(root, "models", "gamma", "w.bin"), "gamma-weights");
    const inRoot = [entryFor(build, "gamma", "gamma-weights")];
    expect(inventory.localSourceFor("gamma", inRoot)).toEqual({ origin: "release", dir: build });
    expect(inventory.localSourceFor("gamma", inRoot, { root })).toBeNull();
    expect(inventory.localSourceFor("alpha", entries, { root })).toEqual({
      origin: "release",
      dir: build,
    });
  });

  it("checks the disk once per entry and model, so a polled catalog does no stat per file", () => {
    const build = seedBuild("alpha", "alpha-weights");
    const entries = [entryFor(build)];
    const spy = vi.spyOn(fs, "statSync");
    try {
      expect(inventory.localSourceFor("alpha", entries, { root })).not.toBeNull();
      const first = spy.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      expect(inventory.localSourceFor("voice:alpha", entries, { root })).not.toBeNull();
      expect(inventory.localSourceFor("beta", entries, { root })).toBeNull();
      expect(spy.mock.calls.length).toBe(first);
      // A new discovery gives new entry objects, so the next look reads the disk again.
      expect(inventory.localSourceFor("alpha", [entryFor(build)], { root })).not.toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThan(first);
    } finally {
      spy.mockRestore();
    }
  });

  it("an injected verifier is used as given and is never remembered", () => {
    const build = seedBuild("alpha", "alpha-weights");
    const entries = [entryFor(build)];
    const verify = vi.fn(() => false);
    expect(inventory.localSourceFor("alpha", entries, { verify })).toBeNull();
    expect(inventory.localSourceFor("alpha", entries, { verify })).toBeNull();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("main.cjs keeps no second copy of the matcher", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.cjs"), "utf8");
    expect(main).toContain("installInventory.localSourceFor(");
    expect(main).not.toMatch(/const present = \(entry, model\)/);
    expect(main).not.toMatch(/lastName\(model\.dir\)/);
  });
});
