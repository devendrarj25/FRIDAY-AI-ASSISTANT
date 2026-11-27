/**
 * The owner's data survives Update content, a damaged record, a forged mark and a
 * missing main file. One recipe hashes an item (importer and built-ins sync), a hash-less
 * release mark is never a licence to overwrite, files that belong to no repo item never
 * replace a workspace file, a flat manifest cannot claim another item's id, and the
 * record is read through its .bak by every reader. Throwaway folders only; no clock,
 * network or machine dependence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CapabilityRegistry, scanManifestFolder, scanSegment } from "../discovery";
import { runMigrations } from "../../installer/migration";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const importer = require_(path.join(ROOT, "electron", "importer.cjs"));
const sync = require_(path.join(ROOT, "electron", "builtins-sync.cjs"));
const caps = require_(path.join(ROOT, "electron", "capabilities.cjs"));
const skills = require_(path.join(ROOT, "electron", "skills.cjs"));
const safeWrite = require_(path.join(ROOT, "electron", "safe-write.cjs"));
const migrations = require_(path.join(ROOT, "electron", "data-migrations.cjs"));
const generator = require_(path.join(ROOT, "scripts", "builtins-manifest.cjs"));

const dirs: string[] = [];
const temp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `friday-odh-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

type Manifest = Record<string, unknown>;
const text = (manifest: Manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
function putItem(base: string, rel: string, manifest: Manifest, body = "body", bom = false) {
  const dir = path.join(base, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), (bom ? "﻿" : "") + text(manifest));
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}
const read = (base: string, rel: string) =>
  fs.readFileSync(path.join(base, ...rel.split("/")), "utf8");
const readJson = (base: string, rel: string) => JSON.parse(read(base, rel).replace(/^\uFEFF/, ""));
const has = (base: string, rel: string) => fs.existsSync(path.join(base, ...rel.split("/")));
const entry = (id: string, version: string, sha256 = "0".repeat(64)) => ({
  id,
  segment: "core",
  path: id,
  version,
  sha256,
});
const builtins = (items: Array<ReturnType<typeof entry>>) => ({
  schema: 1,
  release: "1.2.5.8",
  trees: { skills: items },
});
function setup() {
  const root = temp("root");
  const staged = temp("staged");
  const scan = { ok: true, id: "o1", contentRoot: staged, githubRef: "v1.2.5.8", layout: "repo" };
  return { root, staged, scan };
}
const apply = (
  root: string,
  scan: object,
  built: ReturnType<typeof builtins> | null,
  areas: string[] = ["skills"],
) => importer.applyImport({ root, scan, areas, builtins: built });

const stateOf = (root: string) => path.join(root, "config", "capabilities.json");
const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

describe("(a) a release mark without a content hash is not a licence to replace", () => {
  it("keeps an item with a hash-less mark that the owner edited, with its own reason", async () => {
    const { root, staged, scan } = setup();
    putItem(
      root,
      "skills/core/g",
      { name: "g", version: "1.0.0", provenance: "release-content" },
      "edited",
    );
    putItem(staged, "skills/core/g", { name: "g", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(read(root, "skills/core/g/SKILL.md")).toBe("edited");
    expect(result.keptYours).toEqual([
      expect.objectContaining({ id: "skills/core/g", reason: "unmarked or legacy mark" }),
    ]);
  });

  it("still replaces a hash-less marked copy whose bytes equal the shipped built-in", async () => {
    const { root, staged, scan } = setup();
    const dir = putItem(root, "skills/core/g", {
      name: "g",
      version: "1.0.0",
      provenance: "release-content",
    });
    const sha = sync.itemHash(dir);
    putItem(staged, "skills/core/g", { name: "g", version: "1.5.0" }, "newer");
    const result = await apply(root, scan, builtins([entry("skills/core/g", "1.0.0", sha)]));
    expect(result.keptYours).toEqual([]);
    expect(read(root, "skills/core/g/SKILL.md")).toBe("newer");
  });
});

describe("(b) recordFork goes through the guarded writer", () => {
  const ID = "agents/core/demo";
  it("does not rebuild a damaged record with no backup from {}", () => {
    const app = temp("app");
    const ws = temp("ws");
    const dir = path.join(app, "agents", "core", "demo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "demo", version: "1.0.0" }),
    );
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    const damaged = '{"schema":2,"tools/custom/keep":false,"forks":{"x":';
    write(stateOf(ws), damaged);
    const result = caps.recordFork({ appRoot: app, workspaceRoot: ws }, ID);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(stateOf(ws), "utf8")).toBe(damaged);
    expect(fs.existsSync(`${stateOf(ws)}.bak`)).toBe(false);
  });

  it("keeps every other entry of a good record when it adds the fork", () => {
    const app = temp("app");
    const ws = temp("ws");
    const dir = path.join(app, "agents", "core", "demo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "demo", version: "1.0.0" }),
    );
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    write(
      stateOf(ws),
      JSON.stringify({
        schema: 2,
        "tools/custom/keep": false,
        forks: {},
        removedBuiltins: { a: { since: "1" } },
      }),
    );
    expect(caps.recordFork({ appRoot: app, workspaceRoot: ws }, ID).ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateOf(ws), "utf8"));
    expect(state["tools/custom/keep"]).toBe(false);
    expect(state.removedBuiltins.a).toEqual({ since: "1" });
    expect(state.forks[ID].baseVersion).toBe("1.0.0");
  });

  it("migrateState and the boot sync refuse a damaged record with no backup", () => {
    const app = temp("app");
    const ws = temp("ws");
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    write(stateOf(ws), '{"schema":1,"a":tr');
    expect(caps.migrateState(ws)).toMatchObject({ ok: false, migrated: false });
    expect(sync.run({ appRoot: app, workspaceRoot: ws }).skipped).toBe("unreadable-state");
    expect(fs.readFileSync(stateOf(ws), "utf8")).toBe('{"schema":1,"a":tr');
  });

  it("the boot sync writes through editState, with the injected writer", () => {
    const app = temp("app");
    const ws = temp("ws");
    const dir = path.join(app, "agents", "core", "demo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "demo", version: "1.0.0" }),
    );
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    const edit = vi.fn(caps.editState);
    const report = sync.run({
      appRoot: app,
      workspaceRoot: ws,
      capabilities: { ...caps, editState: edit },
    });
    expect(report.ok).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(stateOf(ws), "utf8")).lastBuiltins.release).toBe("1.0.0.0");
  });
});

describe("(c) one hash recipe for the importer and the built-ins record", () => {
  it("does not read an item as edited because of __pycache__ or Thumbs.db", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/g", { name: "g", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    fs.mkdirSync(path.join(root, "skills/core/g/__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills/core/g/__pycache__/x.pyc"), "bytes");
    fs.writeFileSync(path.join(root, "skills/core/g/Thumbs.db"), "bytes");
    putItem(staged, "skills/core/g", { name: "g", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toEqual([]);
    expect(read(root, "skills/core/g/SKILL.md")).toBe("newer");
  });

  it("exports the manifest-override form of itemHash that the importer reuses", () => {
    const dir = temp("item");
    fs.writeFileSync(path.join(dir, "manifest.json"), '{"a":1}\n');
    fs.writeFileSync(path.join(dir, "b.txt"), "x");
    const swapped = sync.itemHash(dir, {
      override: { file: path.join(dir, "manifest.json"), text: '{"b":2}\n' },
    });
    const other = temp("item2");
    fs.writeFileSync(path.join(other, "manifest.json"), '{"b":2}\n');
    fs.writeFileSync(path.join(other, "b.txt"), "x");
    expect(swapped).toBe(sync.itemHash(other));
  });

  it("hashes CRLF text the same as LF across a read chunk boundary, without a whole-file read", () => {
    const dir = temp("big");
    const edge = 1024 * 1024; // one chunk
    const lf = Buffer.concat([
      Buffer.alloc(edge - 1, 97),
      Buffer.from("\n"),
      Buffer.alloc(100, 98),
    ]);
    const crlf = Buffer.concat([
      Buffer.alloc(edge - 1, 97),
      Buffer.from("\r\n"),
      Buffer.alloc(100, 98),
    ]);
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, "f.txt"), lf);
    fs.writeFileSync(path.join(b, "f.txt"), crlf);
    const spy = vi.spyOn(fs, "readFileSync");
    const first = sync.itemHash(a);
    const second = sync.itemHash(b);
    expect(second).toBe(first);
    expect(spy.mock.calls.some((call) => String(call[0]).endsWith("f.txt"))).toBe(false);
    const reference = crypto
      .createHash("sha256")
      .update(`f.txt\0${crypto.createHash("sha256").update(lf).digest("hex")}\n`)
      .digest("hex");
    expect(first).toBe(reference);
  });

  it("keeps a binary file byte-exact", () => {
    const dir = temp("bin");
    const data = Buffer.from([0, 13, 10, 1, 2]);
    fs.writeFileSync(path.join(dir, "x.bin"), data);
    const expected = crypto
      .createHash("sha256")
      .update(`x.bin\0${crypto.createHash("sha256").update(data).digest("hex")}\n`)
      .digest("hex");
    expect(sync.itemHash(dir)).toBe(expected);
  });
});

describe("(d) files with no repo item never replace a workspace file", () => {
  it("keeps an owner item whose repo manifest has a BOM and a damaged manifest alike", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/core/mine", { name: "mine", version: "1.0.0" }, "owner text");
    putItem(staged, "skills/core/mine", { name: "mine", version: "9.0.0" }, "release text", true);
    fs.writeFileSync(path.join(staged, "skills/core/mine/manifest.json"), "{ broken");
    const result = await apply(root, scan, builtins([]));
    expect(read(root, "skills/core/mine/SKILL.md")).toBe("owner text");
    expect(result.keptYours.length).toBeGreaterThan(0);
  });

  it("keeps a repo file that belongs to no item when a different file is already there", async () => {
    const { root, staged, scan } = setup();
    fs.mkdirSync(path.join(root, "skills/notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills/notes/README.md"), "owner notes");
    fs.mkdirSync(path.join(staged, "skills/notes"), { recursive: true });
    fs.writeFileSync(path.join(staged, "skills/notes/README.md"), "release notes");
    const result = await apply(root, scan, builtins([]));
    expect(read(root, "skills/notes/README.md")).toBe("owner notes");
    expect(result.keptYours).toEqual([
      expect.objectContaining({ id: "skills/notes/README.md", reason: "your own file" }),
    ]);
  });

  it("does not add a new file into an owner item folder the repo has no item for", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/core/mine", { name: "mine", version: "1.0.0" }, "owner text");
    fs.mkdirSync(path.join(staged, "skills/core/mine"), { recursive: true });
    fs.writeFileSync(path.join(staged, "skills/core/mine/EXTRA.md"), "release extra");
    const result = await apply(root, scan, builtins([]));
    expect(has(root, "skills/core/mine/EXTRA.md")).toBe(false);
    expect(result.keptYours).toEqual([expect.objectContaining({ id: "skills/core/mine" })]);
  });

  it("still lands a brand-new file where the workspace has nothing", async () => {
    const { root, staged, scan } = setup();
    fs.mkdirSync(path.join(staged, "skills/notes"), { recursive: true });
    fs.writeFileSync(path.join(staged, "skills/notes/NEW.md"), "release");
    const result = await apply(root, scan, builtins([]));
    expect(read(root, "skills/notes/NEW.md")).toBe("release");
    expect(result.keptYours).toEqual([]);
  });

  it("still updates an untouched landed item whose folder gets a new file", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/g", { name: "g", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    putItem(staged, "skills/core/g", { name: "g", version: "1.1.0" }, "newer");
    fs.writeFileSync(path.join(staged, "skills/core/g/EXTRA.md"), "more");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toEqual([]);
    expect(read(root, "skills/core/g/EXTRA.md")).toBe("more");
  });
});

describe("(e) a flat manifest cannot claim another item's id", () => {
  const flat = (base: string, name: string, manifest: Manifest) => {
    write(path.join(base, "skills", "manifests", `${name}.json`), text(manifest));
  };
  it("derives the id from the path, so the owner's item wins", () => {
    const app = temp("app");
    const ws = temp("ws");
    putItem(ws, "skills/core/mine", { name: "mine", version: "1.0.0" });
    flat(ws, "x", { id: "skills/core/mine", name: "hijack", version: "999" });
    const items = caps.list({ appRoot: app, workspaceRoot: ws }).items;
    const mine = items.find((item: { id: string }) => item.id === "skills/core/mine");
    expect(mine.name).toBe("mine");
    expect(items.some((item: { id: string }) => item.id === "skills/manifests/x")).toBe(true);
  });

  it("lets a flat manifest pick another name only inside manifests/, never another file's id", () => {
    const app = temp("app");
    const ws = temp("ws");
    flat(ws, "mine", { name: "mine" });
    flat(ws, "x", { id: "skills/manifests/mine", name: "hijack" });
    flat(ws, "y", { id: "skills/manifests/renamed", name: "ok" });
    const items = caps.list({ appRoot: app, workspaceRoot: ws }).items;
    const byId = (id: string) => items.find((item: { id: string }) => item.id === id);
    expect(byId("skills/manifests/mine").name).toBe("mine");
    expect(byId("skills/manifests/x").name).toBe("hijack");
    expect(byId("skills/manifests/renamed").name).toBe("ok");
  });

  it("never lets a flat manifest take a reserved key as its id", () => {
    const app = temp("app");
    const ws = temp("ws");
    flat(ws, "y", { id: "forks", name: "bad" });
    flat(ws, "z", { id: "__proto__", name: "bad" });
    const ids = caps
      .list({ appRoot: app, workspaceRoot: ws })
      .items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain("forks");
    expect(ids).not.toContain("__proto__");
  });

  it("the registry of core/discovery derives the same id", () => {
    const ws = temp("ws");
    putItem(ws, "skills/core/mine", { name: "mine", version: "1.0.0" });
    flat(ws, "x", { id: "skills/core/mine", name: "hijack", version: "999" });
    const registry = new CapabilityRegistry();
    registry.setRoot(ws);
    registry.register("segment", () => scanSegment(ws, "skills", "core"));
    registry.register("flat", () => scanManifestFolder(ws, "skills"));
    const entries = registry.list();
    expect(entries.find((entry) => entry.id === "skills/core/mine")?.name).toBe("mine");
    expect(entries.map((entry) => entry.id)).toContain("skills/manifests/x");
  });

  it("markVerified and setEnabled refuse reserved keys; a parked toggle for one is dropped", () => {
    const app = temp("app");
    const ws = temp("ws");
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    expect(caps.setEnabled({ workspaceRoot: ws }, "forks", true).ok).toBe(false);
    expect(caps.markVerified({ workspaceRoot: ws }, "forks", { ok: true }).ok).toBe(false);
    write(
      stateOf(ws),
      JSON.stringify({
        schema: 2,
        forks: {},
        removedBuiltins: {},
        prunedToggles: { forks: true, "tools/custom/ok": true },
      }),
    );
    flat(ws, "forks", { id: "forks", name: "bad" });
    write(path.join(ws, "tools", "custom", "ok", "manifest.json"), JSON.stringify({ name: "ok" }));
    expect(sync.run({ appRoot: app, workspaceRoot: ws }).ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateOf(ws), "utf8"));
    expect(state.forks).toEqual({});
    expect(state["tools/custom/ok"]).toBe(true);
  });
});

describe("(f) an imported pack cannot forge the release-content mark", () => {
  it("strips the mark and its hash from a zip or folder import", async () => {
    const root = temp("root");
    const source = temp("source");
    putItem(source, "skills/custom/pack", {
      name: "pack",
      version: "1.0.0",
      provenance: "release-content",
      releaseSha256: "a".repeat(64),
    });
    const scan = await importer.scanImport({ root, source });
    expect(scan.ok).toBe(true);
    const result = await importer.applyImport({ root, scan });
    expect(result.ok).toBe(true);
    const landed = readJson(root, "plugins/installed/pack/manifest.json");
    expect(landed.provenance).toBe("import");
    expect(landed.releaseSha256).toBeUndefined();
    expect(read(root, "plugins/installed/pack/SKILL.md")).toBe("body");
  });

  it("still marks what Update content itself placed", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/g", {
      name: "g",
      version: "1.0.0",
      provenance: "release-content",
    });
    await apply(root, scan, builtins([]));
    const landed = readJson(root, "skills/core/g/manifest.json");
    expect(landed.provenance).toBe("release-content");
    expect(landed.releaseSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("(g) the Skills page and the registry read the record through its .bak", () => {
  const TRUNCATED = '{"schema":2,"skills/custom/s1":fal';
  it("skills.list shows a toggle that only the backup holds", () => {
    const ws = temp("ws");
    const dir = path.join(ws, "skills", "custom", "s1");
    write(path.join(dir, "skill.json"), JSON.stringify({ id: "s1", name: "s1", version: 1 }));
    write(path.join(dir, "skill.mjs"), "export default {}");
    write(stateOf(ws), TRUNCATED);
    write(`${stateOf(ws)}.bak`, JSON.stringify({ schema: 2, "skills/custom/s1": false }));
    const found = skills
      .list({ workspaceRoot: ws })
      .skills.find((s: { id: string }) => s.id === "s1");
    expect(found.enabled).toBe(false);
  });

  it("the registry shows the same toggle", () => {
    const ws = temp("ws");
    putItem(ws, "agents/core/a1", { name: "a1", version: "1.0.0" });
    write(stateOf(ws), '{"schema":2,"agents/core/a1":fal');
    write(`${stateOf(ws)}.bak`, JSON.stringify({ schema: 2, "agents/core/a1": false }));
    const registry = new CapabilityRegistry();
    registry.setRoot(ws);
    registry.register("segment", () => scanSegment(ws, "agents", "core"));
    expect(registry.list().find((entry) => entry.id === "agents/core/a1")?.enabled).toBe(false);
  });
});

describe("(h) a missing main file with a readable backup is read from the backup", () => {
  it("readStateFile answers from the .bak with source backup", () => {
    const ws = temp("ws");
    write(`${stateOf(ws)}.bak`, JSON.stringify({ schema: 2, forks: { a: { at: 1 } }, x: true }));
    const read1 = caps.readStateFile(ws);
    expect(read1).toMatchObject({ exists: true, readable: true, source: "backup" });
    expect(read1.value.x).toBe(true);
  });

  it("setEnabled keeps the forks that only the backup holds", () => {
    const ws = temp("ws");
    write(
      `${stateOf(ws)}.bak`,
      JSON.stringify({ schema: 2, forks: { a: { at: 1 } }, removedBuiltins: {} }),
    );
    expect(caps.setEnabled({ workspaceRoot: ws }, "tools/custom/t", true).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateOf(ws), "utf8")).forks).toEqual({ a: { at: 1 } });
  });

  it("migration 0001 does not create {} over a record whose main file is missing but .bak is good", () => {
    const ws = temp("ws");
    write(`${stateOf(ws)}.bak`, '{"schema":2,"forks":{"a":{"at":1}}}');
    expect(migrations.run(ws, "1.0.0").applied).toEqual(["0001-config-capabilities"]);
    expect(fs.existsSync(stateOf(ws))).toBe(false);
  });

  it("the typed migration list does the same", () => {
    const ws = temp("ws");
    write(`${stateOf(ws)}.bak`, '{"schema":2,"forks":{"a":{"at":1}}}');
    runMigrations(ws, "1.0.0");
    expect(fs.existsSync(stateOf(ws))).toBe(false);
  });

  it("migration 0001 still creates the record when neither file exists", () => {
    const ws = temp("ws");
    migrations.run(ws, "1.0.0");
    expect(fs.readFileSync(stateOf(ws), "utf8").trim()).toBe("{}");
  });

  it("the safe writer does not copy a main that does not parse over a good .bak", () => {
    const dir = temp("sw");
    const file = path.join(dir, "rec.json");
    fs.writeFileSync(`${file}.bak`, '{"good":true}');
    fs.writeFileSync(file, '{"good":tr');
    safeWrite.writeJsonSafe(file, { next: 1 });
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe('{"good":true}');
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ next: 1 });
    // the next write, from a good main, backs it up again
    safeWrite.writeJsonSafe(file, { next: 2 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ next: 1 });
  });

  it("the async safe writer keeps the good .bak too", async () => {
    const dir = temp("sw2");
    const file = path.join(dir, "rec.json");
    fs.writeFileSync(`${file}.bak`, '{"good":true}');
    fs.writeFileSync(file, "{");
    await safeWrite.writeJsonSafeAsync(file, { next: 1 });
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe('{"good":true}');
  });
});

describe("(i) the shadow-hash cache sees a rename and caps the file count", () => {
  it("returns the fresh hash after a same-size rename that keeps the mtime", () => {
    const dir = temp("sh");
    const item = path.join(dir, "item");
    fs.mkdirSync(item);
    fs.writeFileSync(path.join(item, "a.txt"), "same");
    const when = new Date(Date.UTC(2026, 0, 1));
    fs.utimesSync(path.join(item, "a.txt"), when, when);
    const before = sync.shadowHash(item);
    fs.renameSync(path.join(item, "a.txt"), path.join(item, "b.txt"));
    fs.utimesSync(path.join(item, "b.txt"), when, when);
    fs.utimesSync(item, when, when);
    const after = sync.shadowHash(item);
    expect(after).not.toBe(before);
    expect(after).toBe(sync.itemHash(item));
  });

  it("reads an item with too many files as not identical", () => {
    const dir = temp("many");
    const item = path.join(dir, "item");
    fs.mkdirSync(item);
    for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(item, `f${i}`), "x");
    expect(sync.shadowHash(item, { maxFiles: 5 })).toBeNull();
    expect(sync.shadowHash(item)).toBe(sync.itemHash(item));
  });
});

describe("(j) a reset hands the renderer an id, never an absolute path", () => {
  const ID = "agents/core/demo";
  function prepare() {
    const app = temp("app");
    const ws = temp("ws");
    for (const root of [app, ws])
      putItem(root, "agents/core/demo", { name: "demo", version: "1.0.0" }, "body");
    fs.writeFileSync(path.join(ws, "agents/core/demo/SKILL.md"), "mine");
    generator.write(app, path.join(app, "builtins.json"), { release: "1.0.0.0" });
    caps.recordFork({ appRoot: app, workspaceRoot: ws }, ID);
    return { app, ws };
  }

  it("returns a relative backup id and an undo that carries no absolute path", () => {
    const { app, ws } = prepare();
    const result = caps.resetBuiltin({ appRoot: app, workspaceRoot: ws }, ID, {
      now: () => Date.UTC(2026, 10, 27, 10, 15, 0),
    });
    expect(result.ok).toBe(true);
    expect(result.backupId).toBe("capabilities/agents__core__demo-20261127T101500");
    expect(JSON.stringify(result.undo)).not.toContain(ws);
    expect(path.isAbsolute(result.undo.backupId)).toBe(false);
    const pub = caps.publicResetResult(result);
    expect(JSON.stringify(pub)).not.toContain(ws);
    expect(pub).toMatchObject({ ok: true, id: ID, backupId: result.backupId });
  });

  it("main re-derives both paths from the id and checks them", () => {
    const { app, ws } = prepare();
    const result = caps.resetBuiltin({ appRoot: app, workspaceRoot: ws }, ID);
    const paths = caps.resolveUndo({ appRoot: app, workspaceRoot: ws }, result.undo);
    expect(paths.ok).toBe(true);
    expect(paths.from).toBe(result.backup);
    expect(paths.to.startsWith(ws)).toBe(true);
    expect(
      caps.resolveUndo({ appRoot: app, workspaceRoot: ws }, { id: ID, backupId: "../../etc" }).ok,
    ).toBe(false);
    expect(
      caps.resolveUndo(
        { appRoot: app, workspaceRoot: ws },
        { id: "../x", backupId: result.backupId },
      ).ok,
    ).toBe(false);
    expect(
      caps.resolveUndo({ appRoot: app, workspaceRoot: ws }, { from: result.backup, to: ws }).ok,
    ).toBe(false);
  });
});
