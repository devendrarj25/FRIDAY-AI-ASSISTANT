import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const fresh = require_("../../electron/model-freshness.cjs") as {
  listRepo: (
    repo: string,
    o?: object,
  ) => Promise<{
    ok: boolean;
    files?: { path: string; size: number; sha256: string | null }[];
    error?: string;
  }>;
  changedFiles: (l: { path: string; size: number }[], dir: string) => string[];
  checkRepoFresh: (
    o: object,
  ) => Promise<{ fresh: boolean | null; changed: string[]; reason: string }>;
  staleFor: (row: object, o?: object) => Promise<string[]>;
  reposOf: (row: object) => string[];
};

const dirs: string[] = [];
function folder(files: Record<string, number>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-fresh-"));
  dirs.push(dir);
  for (const [name, size] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const listing = (items: unknown) => async () => ({ ok: true, json: async () => items });

describe("has a model folder changed upstream", () => {
  it("reads sizes and content hashes from the tree listing", async () => {
    const out = await fresh.listRepo("owner/model", {
      fetchImpl: listing([
        { type: "file", path: "model.bin", size: 5, lfs: { oid: "ABC", size: 900 } },
        { type: "file", path: "config.json", size: 12 },
        { type: "directory", path: "sub" },
      ]),
    });
    expect(out.files).toEqual([
      { path: "model.bin", size: 900, sha256: "abc" },
      { path: "config.json", size: 12, sha256: null },
    ]);
    expect((await fresh.listRepo("bad id", {})).error).toBe("not a repository id");
    expect(
      (await fresh.listRepo("a/b", { fetchImpl: async () => ({ ok: false, status: 404 }) })).error,
    ).toBe("HTTP 404");
  });

  it("flags only local files whose size differs", () => {
    const dir = folder({ "a.bin": 10, "sub/b.json": 4 });
    const changed = fresh.changedFiles(
      [
        { path: "a.bin", size: 10 },
        { path: "sub/b.json", size: 9 },
        { path: "never-downloaded.bin", size: 99 },
      ],
      dir,
    );
    expect(changed).toEqual(["sub/b.json"]);
  });

  it("says fresh, stale or cannot tell, and never calls an offline network stale", async () => {
    const dir = folder({ "a.bin": 10 });
    const same = await fresh.checkRepoFresh({
      repo: "o/m",
      dir,
      fetchImpl: listing([{ type: "file", path: "a.bin", size: 10 }]),
    });
    expect(same).toMatchObject({ fresh: true, changed: [] });
    const newer = await fresh.checkRepoFresh({
      repo: "o/m",
      dir,
      fetchImpl: listing([{ type: "file", path: "a.bin", size: 11 }]),
    });
    expect(newer).toMatchObject({ fresh: false, changed: ["a.bin"] });
    const offline = await fresh.checkRepoFresh({
      repo: "o/m",
      dir,
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(offline.fresh).toBeNull();
  });

  it("works out the folder and repositories of a prefetch row", async () => {
    const root = folder({ "tiny/a.bin": 3 });
    const parent = path.dirname(path.join(root, "tiny"));
    const row = {
      job: {
        modelId: "tiny",
        dir: parent,
        sources: [
          { kind: "hf-repo", repo: "o/m" },
          { kind: "url", url: "x" },
        ],
      },
    };
    expect(fresh.reposOf(row)).toEqual(["o/m"]);
    const stale = await fresh.staleFor(row, {
      fetchImpl: listing([{ type: "file", path: "a.bin", size: 4 }]),
    });
    expect(stale).toEqual(["o/m/a.bin"]);
    expect(await fresh.staleFor({}, {})).toEqual([]);
  });
});
