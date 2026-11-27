/**
 * Hardening of the built-in versus user layer: the owner's record
 * (config/capabilities.json) is never rewritten from a damaged read, the boot
 * sync writes its snapshot only after the record, one ignore list keeps a
 * runtime cache from turning "identical" into "overridden", list() survives a
 * locked file, and a pack can never claim release-content provenance.
 * Throwaway folders only; no clock, network or machine dependence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CapabilityRegistry } from "../discovery";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");

type Row = { id: string; status: string; enabled: boolean; provenance?: string | null };
type Roots = { appRoot: string; workspaceRoot: string };
type Report = {
  ok: boolean;
  skipped: string | null;
  error?: string;
  failedFile?: string;
  counts: { builtins: number; overridden: number; stale: number } | null;
  removed: string[];
  pruned: string[];
};
type Caps = {
  list: (roots: Roots) => { items: Row[] };
  setEnabled: (roots: { workspaceRoot: string }, id: string, on: boolean) => { ok: boolean };
  readStateFile: (workspaceRoot: string) => {
    exists: boolean;
    readable: boolean;
    source?: string;
    value: Record<string, unknown>;
  };
  upgradeState: (raw: unknown) => Record<string, unknown>;
  writeState: (workspaceRoot: string, state: unknown) => boolean;
  installPack: (
    roots: { workspaceRoot: string },
    pack: Record<string, unknown>,
    hint?: string,
    options?: { provenance?: string },
  ) => { ok: boolean; id: string; path: string };
  installFromUrl: (
    roots: { workspaceRoot: string },
    url: string,
  ) => Promise<{ ok: boolean; installed?: string[] }>;
  markVerified: (roots: { workspaceRoot: string }, id: string, result: unknown) => { ok: boolean };
  uninstallPack: (
    roots: { workspaceRoot: string },
    id: string,
  ) => { ok: boolean; warning?: string };
  recordFork: (roots: Roots, id: string) => { ok: boolean };
  resetBuiltin: (
    roots: Roots,
    id: string,
    options?: { now?: () => number },
  ) => { ok: boolean; backup?: string; warning?: string; undo?: { from: string; to: string } };
  RESERVED_KEYS: Set<string>;
};
type Sync = {
  run: (options: Roots & { env?: Record<string, string>; capabilities?: unknown }) => Report;
  itemHash: (target: string) => string;
  shadowHash: (target: string, options?: { maxBytes?: number }) => string | null;
  doctorRow: (report: Report) => { ok: boolean; detail: string };
  IGNORED_NAMES: string[];
};
const capabilities = require_(path.join(ROOT, "electron", "capabilities.cjs")) as Caps;
const sync = require_(path.join(ROOT, "electron", "builtins-sync.cjs")) as Sync;
const generator = require_(path.join(ROOT, "scripts", "builtins-manifest.cjs")) as {
  generate: (
    root: string,
    o: { release: string },
  ) => { trees: Record<string, { sha256: string }[]> };
  write: (root: string, file: string, o: { release: string }) => unknown;
};
const modulesApi = require_(path.join(ROOT, "electron", "modules.cjs")) as {
  setEnabled: (
    roots: { workspaceRoot: string },
    id: string,
    on: boolean,
  ) => Promise<{ ok: boolean }>;
};

let appRoot = "";
let workspaceRoot = "";
const ID = "agents/core/demo";
const stateFile = () => path.join(workspaceRoot, "config", "capabilities.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
const writeRaw = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const GOOD = {
  schema: 2,
  "tools/custom/keep": false,
  forks: { [ID]: { baseVersion: "1.0.0", baseSha256: "a".repeat(64), at: 1 } },
  removedBuiltins: {},
};
const TRUNCATED = '{"schema":2,"forks":{"agents/core/de';
const put = (root: string, name: string, version: string, extra: Record<string, unknown> = {}) => {
  const dir = path.join(root, "agents", "core", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name, version, ...extra }));
  return dir;
};
const ship = (release: string) =>
  generator.write(appRoot, path.join(appRoot, "builtins.json"), { release });
const row = (id = ID) =>
  capabilities.list({ appRoot, workspaceRoot }).items.find((item) => item.id === id) as Row;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-harden-"));
  appRoot = path.join(base, "app");
  workspaceRoot = path.join(base, "workspace");
  fs.mkdirSync(appRoot);
  fs.mkdirSync(workspaceRoot);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(path.dirname(appRoot), { recursive: true, force: true });
});

describe("the owner's record is never rewritten from a damaged read", () => {
  it("reads through the .bak when the file is truncated", () => {
    writeRaw(stateFile(), TRUNCATED);
    writeRaw(`${stateFile()}.bak`, JSON.stringify(GOOD));
    const read = capabilities.readStateFile(workspaceRoot);
    expect(read).toMatchObject({ exists: true, readable: true, source: "backup" });
    expect(read.value["forks"]).toEqual(GOOD.forks);
  });

  it("keeps the forks when a toggle follows a truncated write that left a .bak", () => {
    writeRaw(stateFile(), TRUNCATED);
    writeRaw(`${stateFile()}.bak`, JSON.stringify(GOOD));
    expect(capabilities.setEnabled({ workspaceRoot }, "tools/custom/t5", false).ok).toBe(true);
    const state = readState();
    expect(state.forks).toEqual(GOOD.forks);
    expect(state["tools/custom/t5"]).toBe(false);
    expect(state["tools/custom/keep"]).toBe(false);
  });

  it("refuses a toggle over a damaged record with no backup and leaves its bytes", () => {
    writeRaw(stateFile(), TRUNCATED);
    const result = capabilities.setEnabled({ workspaceRoot }, "tools/custom/t5", false);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(TRUNCATED);
  });

  it("never rewrites a record from a newer FRIDAY", () => {
    const newer = JSON.stringify({ schema: 9, future: { a: 1 } });
    writeRaw(stateFile(), newer);
    expect(capabilities.setEnabled({ workspaceRoot }, "tools/custom/t5", true).ok).toBe(false);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(newer);
  });

  it("writes a toggle atomically and keeps the previous body as .bak", () => {
    writeRaw(stateFile(), JSON.stringify(GOOD));
    expect(capabilities.setEnabled({ workspaceRoot }, "tools/custom/t5", true).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${stateFile()}.bak`, "utf8")).forks).toEqual(GOOD.forks);
  });

  it("uninstall keeps the other forks (.bak) and leaves a damaged file with no backup alone", () => {
    const pack = { tree: "skills", id: "gone", name: "Gone", code: "export default 1" };
    const installed = capabilities.installPack({ workspaceRoot }, pack);
    writeRaw(
      stateFile(),
      JSON.stringify({ ...GOOD, forks: { ...GOOD.forks, [installed.id]: { at: 2 } } }),
    );
    expect(capabilities.uninstallPack({ workspaceRoot }, installed.id).ok).toBe(true);
    expect(readState().forks).toEqual(GOOD.forks);

    const again = capabilities.installPack({ workspaceRoot }, pack);
    fs.rmSync(`${stateFile()}.bak`, { force: true });
    writeRaw(stateFile(), TRUNCATED);
    expect(capabilities.uninstallPack({ workspaceRoot }, again.id).ok).toBe(true);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(TRUNCATED);
  });

  it("markVerified leaves a damaged record with no backup alone", () => {
    const pack = { tree: "skills", id: "checked", name: "Checked", code: "export default 1" };
    const installed = capabilities.installPack({ workspaceRoot }, pack);
    writeRaw(stateFile(), TRUNCATED);
    capabilities.markVerified({ workspaceRoot }, installed.id, { ok: true });
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(TRUNCATED);
  });

  it("refuses the reserved keys in every writer, the module Enable path included", async () => {
    writeRaw(stateFile(), JSON.stringify(GOOD));
    for (const key of ["schema", "forks", "removedBuiltins", "lastBuiltins", "prunedToggles"])
      expect(capabilities.setEnabled({ workspaceRoot }, key, true).ok).toBe(false);
    expect((await modulesApi.setEnabled({ workspaceRoot }, "forks", true)).ok).toBe(false);
    expect(readState()).toEqual(GOOD);
    expect(capabilities.RESERVED_KEYS.has("prunedToggles")).toBe(true);
  });

  it("the registry toggle in core/discovery refuses reserved ids, damaged records and keeps forks", () => {
    const registry = new CapabilityRegistry();
    registry.setRoot(workspaceRoot);
    writeRaw(stateFile(), JSON.stringify(GOOD));
    expect(registry.setEnabled("forks", true)).toBe(false);
    expect(registry.setEnabled("lastBuiltins", true)).toBe(false);
    expect(readState()).toEqual(GOOD);

    expect(registry.setEnabled("tools/custom/t5", false)).toBe(true);
    expect(readState().forks).toEqual(GOOD.forks);
    expect(fs.existsSync(`${stateFile()}.bak`)).toBe(true);

    fs.rmSync(`${stateFile()}.bak`, { force: true });
    writeRaw(stateFile(), TRUNCATED);
    const damaged = new CapabilityRegistry();
    damaged.setRoot(workspaceRoot);
    expect(damaged.setEnabled("tools/custom/t5", false)).toBe(false);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(TRUNCATED);
  });
});

describe("the boot sync writes the record first, the snapshot after it", () => {
  const snapshotFile = () => path.join(workspaceRoot, "config", "builtins-last.json");

  it("keeps the tombstone for a removed built-in when the record write fails once", () => {
    put(appRoot, "old1", "1.0.0");
    put(appRoot, "keep", "1.0.0");
    ship("1.0.0.0");
    expect(sync.run({ appRoot, workspaceRoot }).ok).toBe(true);
    fs.rmSync(path.join(appRoot, "agents", "core", "old1"), { recursive: true });
    ship("1.0.0.1");
    const failing = { ...capabilities, writeState: () => false };
    const second = sync.run({ appRoot, workspaceRoot, capabilities: failing });
    expect(second).toMatchObject({ ok: false, skipped: "write-failed" });
    expect(second.failedFile).toContain("capabilities.json");
    expect(second.error ?? "").toContain("capabilities.json");
    const third = sync.run({ appRoot, workspaceRoot });
    expect(third.removed).toEqual(["agents/core/old1"]);
    expect(readState().removedBuiltins["agents/core/old1"]).toBeDefined();
    expect(fs.existsSync(snapshotFile())).toBe(true);
  });

  it("writes no snapshot at all when the record cannot be written", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const failing = { ...capabilities, writeState: () => false };
    expect(sync.run({ appRoot, workspaceRoot, capabilities: failing }).ok).toBe(false);
    expect(fs.existsSync(snapshotFile())).toBe(false);
  });

  it("names the error text and the stage when the sync throws", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const boom = {
      ...capabilities,
      list: () => {
        throw new Error("disk exploded");
      },
    };
    const report = sync.run({ appRoot, workspaceRoot, capabilities: boom });
    expect(report).toMatchObject({ ok: false, skipped: "error" });
    expect(report.error).toContain("disk exploded");
  });
});

describe("one ignore list for every hash of an item", () => {
  const extras = (dir: string) => {
    for (const rel of [
      "__pycache__/main.cpython-312.pyc",
      "stray.pyc",
      "Thumbs.db",
      "DESKTOP.INI",
      ".DS_Store",
      "node_modules/pkg/index.js",
      ".git/HEAD",
    ])
      writeRaw(path.join(dir, ...rel.split("/")), "runtime noise");
  };

  it("does not let runtime extras change the item hash, and a real file still does", () => {
    const dir = put(appRoot, "demo", "1.0.0");
    fs.writeFileSync(path.join(dir, "main.py"), "print(1)\n");
    const clean = sync.itemHash(dir);
    extras(dir);
    expect(sync.itemHash(dir)).toBe(clean);
    fs.writeFileSync(path.join(dir, "main.py"), "print(2)\n");
    expect(sync.itemHash(dir)).not.toBe(clean);
    expect(sync.IGNORED_NAMES).toEqual(
      expect.arrayContaining(["__pycache__", "node_modules", ".git", "thumbs.db", "desktop.ini"]),
    );
  });

  it("makes the build generator and the runtime agree with and without the extras", () => {
    const dir = put(appRoot, "demo", "1.0.0");
    fs.writeFileSync(path.join(dir, "main.py"), "print(1)\n");
    const shaOf = () =>
      generator.generate(appRoot, { release: "1.0.0.0" }).trees["agents"]?.[0]?.sha256;
    const clean = shaOf();
    extras(dir);
    expect(shaOf()).toBe(clean);
    expect(sync.itemHash(dir)).toBe(clean);
  });

  it("calls a workspace copy with a __pycache__ identical, not overridden", () => {
    put(appRoot, "demo", "1.0.0");
    const copy = put(workspaceRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    extras(copy);
    expect(row().status).toBe("identical");
  });

  it("keeps compiled caches out of every capability tree the installer packs", () => {
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    const blocks = yml.split(/\n {2}- from: /).slice(1);
    for (const tree of ["modules", "skills", "tools", "agents", "plugins", "workflows"]) {
      const block = blocks.find((text) => text.startsWith(`${tree}\n`)) ?? "";
      expect(block, tree).toContain('"!**/__pycache__/**"');
      expect(block, tree).toContain('"!**/*.pyc"');
    }
    const workflows = blocks.find((text) => text.startsWith("workflows\n")) ?? "";
    expect(workflows).toContain('"!active/**"');
  });
});

describe("list() hashing is safe and cheap", () => {
  it("still lists when one file of a shadowing copy cannot be read", () => {
    put(appRoot, "demo", "1.0.0");
    const copy = put(workspaceRoot, "demo", "1.0.0");
    fs.writeFileSync(path.join(copy, "locked.bin"), "x");
    ship("1.0.0.0");
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file).endsWith("locked.bin"))
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return (real as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const items = capabilities.list({ appRoot, workspaceRoot }).items;
    expect(items.find((item) => item.id === ID)?.status).toBe("overridden");
  });

  it("hashes an unchanged shadowing copy once, and again after it changes", () => {
    put(appRoot, "demo", "1.0.0");
    const copy = put(workspaceRoot, "demo", "1.0.0");
    const notes = path.join(copy, "notes.txt");
    fs.writeFileSync(notes, "one");
    ship("1.0.0.0");
    const real = fs.readFileSync;
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
        (real as (...args: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync);
    const reads = () => spy.mock.calls.filter(([file]) => String(file) === notes).length;
    capabilities.list({ appRoot, workspaceRoot });
    expect(reads()).toBe(1);
    capabilities.list({ appRoot, workspaceRoot });
    expect(reads()).toBe(1);
    fs.writeFileSync(notes, "two!");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(notes, later, later);
    capabilities.list({ appRoot, workspaceRoot });
    expect(reads()).toBe(2);
  });

  it("gives up on an item over the byte cap instead of reading it", () => {
    const dir = put(workspaceRoot, "big", "1.0.0");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(64, 1));
    expect(sync.shadowHash(dir, { maxBytes: 16 })).toBeNull();
    expect(sync.shadowHash(dir, { maxBytes: 4096 })).toBe(sync.itemHash(dir));
  });
});

describe("the Doctor row reads live counts", () => {
  it("shows an overridden copy made after the sync ran", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const report = sync.run({ appRoot, workspaceRoot });
    expect(sync.doctorRow(report).detail).toBe("Built-ins 1, overridden 0, stale 0");
    put(workspaceRoot, "demo", "1.0.0", { summary: "my edit" });
    expect(sync.doctorRow(report).detail).toBe("Built-ins 1, overridden 1, stale 0");
    expect(sync.doctorRow({ ...report, roots: undefined } as Report).detail).toBe(
      "Built-ins 1, overridden 0, stale 0",
    );
  });
});

describe("provenance comes from a trusted argument, never from the pack body", () => {
  const pack = { tree: "skills", id: "prov-hard", name: "Prov", code: "export default 1" };
  const stored = (result: { path: string }) =>
    JSON.parse(fs.readFileSync(path.join(result.path, "skill.json"), "utf8")).provenance;

  it("stores a pack that claims release-content as marketplace, with or without a hint", () => {
    const claim = { ...pack, provenance: "release-content" };
    expect(stored(capabilities.installPack({ workspaceRoot }, claim))).toBe("marketplace");
    expect(stored(capabilities.installPack({ workspaceRoot }, claim, "skills"))).toBe("import");
  });

  it("takes a value from the trusted options argument and never release-content from it", () => {
    expect(
      stored(capabilities.installPack({ workspaceRoot }, pack, undefined, { provenance: "forge" })),
    ).toBe("forge");
    expect(
      stored(
        capabilities.installPack({ workspaceRoot }, pack, undefined, {
          provenance: "release-content",
        }),
      ),
    ).toBe("marketplace");
  });

  it("does not let a pack body claim to be the owner's own", () => {
    expect(
      stored(capabilities.installPack({ workspaceRoot }, { ...pack, provenance: "user" })),
    ).toBe("marketplace");
  });

  it("marks a pack fetched from a URL as marketplace whatever its body says", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...pack, id: "from-url", provenance: "forge" }),
      })),
    );
    const result = await capabilities.installFromUrl({ workspaceRoot }, "https://example.test/p");
    expect(result.ok).toBe(true);
    const [id] = result.installed ?? [];
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, ...String(id).split("/"), "skill.json"), "utf8"),
    );
    expect(manifest.provenance).toBe("marketplace");
  });
});

describe("a toggle is never lost to a missing item", () => {
  it("keeps a false toggle in a tombstone and gives it back with the item", () => {
    put(appRoot, "demo", "1.0.0");
    const mine = put(workspaceRoot, "mine", "0.1.0");
    const MINE = "agents/core/mine";
    ship("1.0.0.0");
    expect(capabilities.setEnabled({ workspaceRoot }, MINE, false).ok).toBe(true);
    const hidden = `${mine}.hidden`;
    fs.renameSync(mine, hidden);
    ship("1.0.0.1");
    const first = sync.run({ appRoot, workspaceRoot });
    expect(first.pruned).toEqual([MINE]);
    expect(readState()[MINE]).toBeUndefined();
    expect(readState().prunedToggles[MINE]).toBe(false);

    fs.renameSync(hidden, mine);
    ship("1.0.0.2");
    const second = sync.run({ appRoot, workspaceRoot });
    expect(second.ok).toBe(true);
    expect(readState()[MINE]).toBe(false);
    expect(readState().prunedToggles?.[MINE]).toBeUndefined();
    expect(row(MINE).enabled).toBe(false);
  });

  it("upgradeState keeps the tombstone map and treats it as a record, not a toggle", () => {
    const state = capabilities.upgradeState({ a: true, prunedToggles: { b: false } });
    expect(state).toMatchObject({ schema: 2, a: true, prunedToggles: { b: false } });
    expect(capabilities.upgradeState({ a: true })).not.toHaveProperty("prunedToggles");
  });
});

describe("Reset to built-in resolves the copy the way list() does", () => {
  it("removes the copy list() shows (the last one wins) and refuses a case-variant id", () => {
    put(appRoot, "demo", "1.0.0");
    const folder = put(workspaceRoot, "demo", "1.0.0", { summary: "folder copy" });
    const flat = path.join(workspaceRoot, "agents", "manifests", "demo.json");
    writeRaw(
      flat,
      JSON.stringify({ id: ID, name: "demo", version: "1.0.0", summary: "flat copy" }),
    );
    ship("1.0.0.0");
    expect(capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID.toUpperCase()).ok).toBe(false);
    const result = capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(flat)).toBe(false);
    expect(fs.existsSync(path.join(folder, "manifest.json"))).toBe(true);
    expect(fs.readFileSync(result.backup as string, "utf8")).toContain("flat copy");
  });

  it("warns when the fork record could not be dropped, and gives the undo pointer", () => {
    put(appRoot, "demo", "1.0.0");
    const mine = put(workspaceRoot, "demo", "1.0.0", { summary: "my edit" });
    ship("1.0.0.0");
    expect(capabilities.recordFork({ appRoot, workspaceRoot }, ID).ok).toBe(true);
    // A folder where the temporary file goes makes the atomic write fail on any machine.
    fs.mkdirSync(`${stateFile()}.${process.pid}.tmp`);
    const result = capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID);
    expect(result.ok).toBe(true);
    expect(result.warning ?? "").toContain("capabilities.json");
    expect(result.undo).toEqual({ from: result.backup, to: mine });
    expect(readState().forks[ID]).toBeDefined();
  });

  it("returns no warning when the record is updated", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "demo", "1.0.0", { summary: "my edit" });
    ship("1.0.0.0");
    capabilities.recordFork({ appRoot, workspaceRoot }, ID);
    const result = capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(readState().forks[ID]).toBeUndefined();
  });
});
