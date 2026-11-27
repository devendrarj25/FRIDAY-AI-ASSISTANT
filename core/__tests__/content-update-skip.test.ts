import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const importer = require_(path.resolve(process.cwd(), "electron/importer.cjs"));

const dirs: string[] = [];
const temp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `friday-content-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

type Manifest = { version?: string; provenance?: string; [key: string]: unknown };
function putItem(base: string, rel: string, manifest: Manifest, body = "body") {
  const dir = path.join(base, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}
const readManifest = (base: string, rel: string): Manifest =>
  JSON.parse(fs.readFileSync(path.join(base, ...rel.split("/"), "manifest.json"), "utf8"));
const has = (base: string, rel: string) => fs.existsSync(path.join(base, ...rel.split("/")));
const entry = (id: string, version: string) => ({
  id,
  segment: "core",
  path: id,
  version,
  sha256: "0".repeat(64),
});
const builtins = (items: Array<ReturnType<typeof entry>>) => ({
  schema: 1,
  release: "1.2.5.8",
  trees: { skills: items },
});

/** A staged GitHub release tree plus an empty workspace, as the packaged app sees them. */
function setup() {
  const root = temp("root");
  const staged = temp("staged");
  const scan = { ok: true, id: "t1", contentRoot: staged, githubRef: "v1.2.5.8", layout: "repo" };
  return { root, staged, scan };
}
const apply = (
  root: string,
  scan: object,
  built: ReturnType<typeof builtins> | null,
  areas: string[] | null = ["skills"],
) => importer.applyImport({ root, scan, areas, builtins: built });

describe("Update content skips what the release already ships", () => {
  it("skips an incoming item at an equal version and reports it as already in this release", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "1.0.0" });
    const result = await apply(root, scan, builtins([entry("skills/core/alpha", "1.0.0")]));
    expect(result.ok).toBe(true);
    expect(has(root, "skills/core/alpha")).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.alreadyInRelease).toEqual([
      expect.objectContaining({
        id: "skills/core/alpha",
        version: "1.0.0",
        reason: "already in this release",
      }),
    ]);
  });

  it("skips an incoming item that is older than the built-in", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "0.9.0" });
    const result = await apply(root, scan, builtins([entry("skills/core/alpha", "1.0.0")]));
    expect(has(root, "skills/core/alpha")).toBe(false);
    expect(result.alreadyInRelease).toHaveLength(1);
  });

  it("lands an item whose version is strictly newer than the built-in, tagged release-content", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/beta", { name: "beta", version: "1.2.0" }, "new body");
    const result = await apply(root, scan, builtins([entry("skills/core/beta", "1.0.0")]));
    expect(result.applied).toBeGreaterThan(0);
    expect(result.alreadyInRelease).toEqual([]);
    expect(fs.readFileSync(path.join(root, "skills/core/beta/SKILL.md"), "utf8")).toBe("new body");
    expect(readManifest(root, "skills/core/beta")).toMatchObject({
      version: "1.2.0",
      provenance: "release-content",
    });
  });

  it("lands an item the release does not ship as a built-in, tagged release-content", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "0.1.0" });
    const result = await apply(root, scan, builtins([entry("skills/core/alpha", "1.0.0")]));
    expect(result.applied).toBeGreaterThan(0);
    expect(readManifest(root, "skills/core/gamma").provenance).toBe("release-content");
  });

  it("treats an unparseable incoming version as not newer and an unparseable built-in as older", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/nover", { name: "nover" });
    putItem(staged, "skills/core/oldbi", { name: "oldbi", version: "1.0.0" });
    const noVersionBuiltin = { ...entry("skills/core/oldbi", "x"), version: null };
    const result = await apply(
      root,
      scan,
      builtins([entry("skills/core/nover", "1.0.0"), noVersionBuiltin as never]),
    );
    expect(has(root, "skills/core/nover")).toBe(false);
    expect(has(root, "skills/core/oldbi")).toBe(true);
    expect(result.alreadyInRelease.map((r: { id: string }) => r.id)).toEqual(["skills/core/nover"]);
  });

  it("matches ids without regard to case", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "1.0.0" });
    const result = await apply(root, scan, builtins([entry("skills/core/ALPHA", "1.0.0")]));
    expect(result.alreadyInRelease).toHaveLength(1);
  });
});

describe("Update content never overwrites or deletes the owner's items", () => {
  it("keeps a workspace item the owner made, even when the release has a newer one at that path", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/core/gamma", { name: "gamma", version: "9.0.0" }, "mine");
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "10.0.0" }, "release");
    const result = await apply(root, scan, builtins([]));
    expect(fs.readFileSync(path.join(root, "skills/core/gamma/SKILL.md"), "utf8")).toBe("mine");
    expect(readManifest(root, "skills/core/gamma").version).toBe("9.0.0");
    expect(result.keptYours).toEqual([expect.objectContaining({ id: "skills/core/gamma" })]);
  });

  it("keeps items whose stored provenance is import, marketplace or forge", async () => {
    const { root, staged, scan } = setup();
    for (const [name, provenance] of [
      ["i", "import"],
      ["m", "marketplace"],
      ["f", "forge"],
    ] as const) {
      putItem(root, `skills/core/${name}`, { name, version: "1.0.0", provenance }, "mine");
      putItem(staged, `skills/core/${name}`, { name, version: "2.0.0" }, "release");
    }
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toHaveLength(3);
    for (const name of ["i", "m", "f"])
      expect(fs.readFileSync(path.join(root, `skills/core/${name}/SKILL.md`), "utf8")).toBe("mine");
  });

  it("updates an item an earlier Update content placed (release-content) when the release is newer", async () => {
    const { root, staged, scan } = setup();
    putItem(
      root,
      "skills/core/gamma",
      { name: "gamma", version: "1.0.0", provenance: "release-content" },
      "old",
    );
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.1.0" }, "newer");
    const result = await apply(root, scan, builtins([]));
    expect(result.keptYours).toEqual([]);
    expect(fs.readFileSync(path.join(root, "skills/core/gamma/SKILL.md"), "utf8")).toBe("newer");
    expect(readManifest(root, "skills/core/gamma")).toMatchObject({
      version: "1.1.0",
      provenance: "release-content",
    });
  });

  it("never deletes an owner item that the release does not mention", async () => {
    const { root, staged, scan } = setup();
    putItem(root, "skills/custom/mine", { name: "mine", version: "1.0.0" }, "keep me");
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" });
    await apply(root, scan, builtins([]));
    expect(fs.readFileSync(path.join(root, "skills/custom/mine/SKILL.md"), "utf8")).toBe("keep me");
  });

  it("applying the same release twice changes nothing the second time", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" });
    const first = await apply(root, scan, builtins([]));
    expect(first.applied).toBeGreaterThan(0);
    const second = await apply(root, scan, builtins([]));
    expect(second.applied).toBe(0);
    expect(readManifest(root, "skills/core/gamma").provenance).toBe("release-content");
  });

  it("a rollback of the apply restores the workspace and removes the provenance mark", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/gamma", { name: "gamma", version: "1.0.0" });
    const result = await apply(root, scan, builtins([]));
    expect(result.backup).toBeTruthy();
    expect(importer.rollbackImport({ root, backup: result.backup }).ok).toBe(true);
    expect(has(root, "skills/core/gamma")).toBe(false);
  });
});

describe("outside the packaged app nothing changes", () => {
  it("with no built-ins manifest every item lands exactly as before, with no provenance written", async () => {
    const { root, staged, scan } = setup();
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "1.0.0" });
    const before = fs.readFileSync(path.join(staged, "skills/core/alpha/manifest.json"), "utf8");
    const result = await apply(root, scan, null);
    expect(result.alreadyInRelease ?? []).toEqual([]);
    expect(fs.readFileSync(path.join(root, "skills/core/alpha/manifest.json"), "utf8")).toBe(
      before,
    );
  });

  it("a manual import (no GitHub ref) is never filtered by the built-ins manifest", async () => {
    const { root, staged } = setup();
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "1.0.0" });
    const scan = { ok: true, id: "t2", contentRoot: staged, layout: "repo" };
    await apply(root, scan, builtins([entry("skills/core/alpha", "1.0.0")]));
    expect(has(root, "skills/core/alpha")).toBe(true);
  });

  it("reads resources/builtins.json from the program folder when no manifest is passed", async () => {
    const { root, staged, scan } = setup();
    const resources = temp("resources");
    fs.writeFileSync(
      path.join(resources, "builtins.json"),
      JSON.stringify(builtins([entry("skills/core/alpha", "1.0.0")])),
    );
    putItem(staged, "skills/core/alpha", { name: "alpha", version: "1.0.0" });
    const result = await importer.applyImport({
      root,
      scan,
      areas: ["skills"],
      resourcesPath: resources,
    });
    expect(has(root, "skills/core/alpha")).toBe(false);
    expect(result.alreadyInRelease).toHaveLength(1);
  });

  it("ignores a damaged or foreign builtins.json and installs as before", () => {
    const resources = temp("resources");
    expect(importer.readBuiltinsManifest(resources)).toBeNull();
    fs.writeFileSync(path.join(resources, "builtins.json"), "{not json");
    expect(importer.readBuiltinsManifest(resources)).toBeNull();
    fs.writeFileSync(path.join(resources, "builtins.json"), JSON.stringify({ schema: 9 }));
    expect(importer.readBuiltinsManifest(resources)).toBeNull();
  });
});
