import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const importer = require_(path.resolve(process.cwd(), "electron/importer.cjs"));
const builtinsSync = require_(path.resolve(process.cwd(), "electron/builtins-sync.cjs"));

const dirs: string[] = [];
const temp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `friday-owner-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

type Manifest = Record<string, unknown>;
const manifestText = (manifest: Manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
function putItem(base: string, rel: string, manifest: Manifest, body = "body", bom = false) {
  const dir = path.join(base, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), (bom ? "\uFEFF" : "") + manifestText(manifest));
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}
function putFlat(base: string, tree: string, name: string, manifest: Manifest) {
  const dir = path.join(base, tree, "manifests");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), manifestText(manifest));
}
const read = (base: string, rel: string) =>
  fs.readFileSync(path.join(base, ...rel.split("/")), "utf8");
const has = (base: string, rel: string) => fs.existsSync(path.join(base, ...rel.split("/")));
const readJson = (base: string, rel: string) => JSON.parse(read(base, rel).replace(/^\uFEFF/, ""));

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
const apply = (root: string, scan: object, built: ReturnType<typeof builtins> | null) =>
  importer.applyImport({ root, scan, areas: ["skills"], builtins: built });

describe("an owner item with no readable release-content mark is never replaced", () => {
  it("keeps an owner item whose manifest starts with a UTF-8 byte order mark", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/custom/x", { name: "x", version: "1.0.0" }, "mine", true);
    putItem(staged, "skills/custom/x", { name: "x", version: "2.0.0" }, "release");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toHaveLength(1);
    expect(read(root, "skills/custom/x/SKILL.md")).toBe("mine");
    expect(read(root, "skills/custom/x/manifest.json")).toContain("1.0.0");
  });

  it("keeps an owner item whose manifest is damaged", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/custom/x", { name: "x" }, "mine");
    fs.writeFileSync(path.join(root, "skills/custom/x/manifest.json"), "{ not json");
    putItem(staged, "skills/custom/x", { name: "x", version: "2.0.0" }, "release");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toHaveLength(1);
    expect(read(root, "skills/custom/x/SKILL.md")).toBe("mine");
  });

  it("keeps an owner item that has no manifest at all", async () => {
    const { root, staged, scan } = setup();
    fs.mkdirSync(path.join(root, "skills/custom/x"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills/custom/x/SKILL.md"), "mine");
    putItem(staged, "skills/custom/x", { name: "x", version: "2.0.0" }, "release");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toHaveLength(1);
    expect(read(root, "skills/custom/x/SKILL.md")).toBe("mine");
  });
});

describe("flat manifests/*.json items", () => {
  it("keeps the owner's flat manifest when the release carries the same file", async () => {
    const { root, staged, scan } = setup();
    putFlat(root, "skills", "flat", {
      id: "skills/manifests/flat",
      name: "mine",
      version: "1.0.0",
    });
    putFlat(staged, "skills", "flat", {
      id: "skills/manifests/flat",
      name: "rel",
      version: "2.0.0",
    });
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toEqual([expect.objectContaining({ id: "skills/manifests/flat" })]);
    expect(readJson(root, "skills/manifests/flat.json").name).toBe("mine");
  });

  it("skips a flat manifest the installer already ships at that version", async () => {
    const { root, staged, scan } = setup();
    putFlat(staged, "skills", "flat", {
      id: "skills/manifests/flat",
      name: "rel",
      version: "1.0.0",
    });
    const result = await apply(root, scan, builtins([entry("skills/manifests/flat", "1.0.0")]));
    expect(has(root, "skills/manifests/flat.json")).toBe(false);
    expect(result.alreadyInRelease).toEqual([
      expect.objectContaining({ id: "skills/manifests/flat" }),
    ]);
  });

  it("lands a new flat manifest marked as release content, then updates it next release", async () => {
    const { root, staged, scan } = setup();
    putFlat(staged, "skills", "flat", {
      id: "skills/manifests/flat",
      name: "rel",
      version: "1.0.0",
    });
    await apply(root, scan, builtins([]));
    expect(readJson(root, "skills/manifests/flat.json")).toMatchObject({
      provenance: "release-content",
      version: "1.0.0",
    });
    putFlat(staged, "skills", "flat", {
      id: "skills/manifests/flat",
      name: "rel",
      version: "1.1.0",
    });
    const second = await apply(root, scan, builtins([]));
    expect(second.keptYours).toEqual([]);
    expect(readJson(root, "skills/manifests/flat.json").version).toBe("1.1.0");
  });
});

describe("a landed item the owner edited reads as the owner's on the next update", () => {
  it("stores the content hash next to the mark, with the same recipe as the built-ins record", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    const landed = readJson(root, "skills/core/gamma/manifest.json");
    expect(landed.provenance).toBe("release-content");
    expect(landed.releaseSha256).toMatch(/^[0-9a-f]{64}$/);
    // the hash covers the item as it was when the mark was written (no hash field yet)
    const copy = temp("copy");
    fs.cpSync(path.join(root, "skills/core/gamma"), path.join(copy, "gamma"), { recursive: true });
    const { releaseSha256, ...marked } = landed;
    fs.writeFileSync(path.join(copy, "gamma/manifest.json"), manifestText(marked));
    expect(releaseSha256).toBe(builtinsSync.itemHash(path.join(copy, "gamma")));
  });

  it("keeps an edit made to the body of a landed item", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    fs.writeFileSync(path.join(root, "skills/core/gamma/SKILL.md"), "my edit");
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(read(root, "skills/core/gamma/SKILL.md")).toBe("my edit");
    expect(result.keptYours).toEqual([expect.objectContaining({ id: "skills/core/gamma" })]);
  });

  it("keeps an edit made to the manifest of a landed item", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    const landed = readJson(root, "skills/core/gamma/manifest.json");
    fs.writeFileSync(
      path.join(root, "skills/core/gamma/manifest.json"),
      manifestText({ ...landed, description: "mine" }),
    );
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toHaveLength(1);
    expect(read(root, "skills/core/gamma/SKILL.md")).toBe("body");
  });

  it("still updates an untouched landed item", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" }, "body");
    await apply(root, scan, builtins([]));
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toEqual([]);
    expect(read(root, "skills/core/gamma/SKILL.md")).toBe("newer");
    expect(readJson(root, "skills/core/gamma/manifest.json").version).toBe("1.1.0");
  });
});

describe("a copy placed before the mark existed", () => {
  it("is treated as release content when its bytes equal the shipped built-in", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/core/old", { name: "old", version: "1.0.0" }, "shipped body");
    const sha = builtinsSync.itemHash(path.join(root, "skills/core/old"));
    putItem(staged, "skills/core/old", { name: "old", version: "1.5.0" }, "newer body");
    const result = await apply(root, scan, builtins([entry("skills/core/old", "1.0.0", sha)]));
    expect(result.keptYours).toEqual([]);
    expect(read(root, "skills/core/old/SKILL.md")).toBe("newer body");
  });

  it("stays the owner's otherwise, and is named with the reason unmarked copy", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/core/old", { name: "old", version: "1.0.0" }, "changed body");
    putItem(staged, "skills/core/old", { name: "old", version: "1.5.0" }, "newer body");
    const result = await apply(
      root,
      scan,
      builtins([entry("skills/core/old", "1.0.0", "a".repeat(64))]),
    );
    expect(read(root, "skills/core/old/SKILL.md")).toBe("changed body");
    expect(result.keptYours).toEqual([
      expect.objectContaining({ id: "skills/core/old", reason: "unmarked copy" }),
    ]);
  });
});

describe("nested items resolve to the longest matching folder", () => {
  it("decides each file by its own item, however many items there are", async () => {
    const { root, staged, scan } = setup();
    const ids: Array<ReturnType<typeof entry>> = [];
    for (let i = 0; i < 40; i += 1) {
      putItem(staged, `skills/core/s${i}`, { name: `s${i}`, version: "1.0.0" }, `b${i}`);
      ids.push(entry(`skills/core/s${i}`, i % 2 ? "1.0.0" : "0.5.0"));
    }
    const result = await apply(root, scan, builtins(ids));
    expect(result.alreadyInRelease).toHaveLength(20);
    expect(has(root, "skills/core/s0/SKILL.md")).toBe(true);
    expect(has(root, "skills/core/s1/SKILL.md")).toBe(false);
  });
});
