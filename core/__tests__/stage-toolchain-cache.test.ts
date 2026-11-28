/**
 * The pack cache under .cache/toolchain: a pack that a crash or a full disk left cut short, or that was damaged
 * afterwards, is a cache miss (deleted, fetched again), and a fresh pack is written beside its name and renamed.
 * Fake fetches and temp folders only; no network, no date, no Windows.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const stage = require_("../../scripts/stage-toolchain.cjs") as {
  stageBundledPacks: (input: {
    manifest: unknown;
    cacheDir: string;
    stageDir: string;
    fetchImpl: (url: string) => Promise<{ body: Buffer }>;
    offline?: boolean;
    log?: (line: string) => void;
  }) => Promise<{ staged: Array<{ id: string; file: string; bytes: number }> }>;
};

const body = Buffer.from("a complete pack body");
const sha = createHash("sha256").update(body).digest("hex");
const manifest = {
  budgetBytes: 100,
  packs: [
    {
      id: "python-embed",
      tier: "bundled",
      sha256: sha,
      bytes: body.length,
      url: "https://primary.example/python.zip",
      license: "MIT",
    },
  ],
};

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "friday-stage-cache-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a damaged pack in .cache/toolchain is a miss", () => {
  it("deletes a truncated cached pack, fetches it again and writes it through a .part file", async () => {
    const root = temp();
    const cacheDir = path.join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `${sha}.bin`);
    writeFileSync(cacheFile, body.subarray(0, 5));
    const lines: string[] = [];
    let fetched = 0;
    const result = await stage.stageBundledPacks({
      manifest,
      cacheDir,
      stageDir: path.join(root, "resources"),
      log: (line) => lines.push(line),
      fetchImpl: async () => {
        fetched += 1;
        return { body };
      },
    });
    expect(fetched).toBe(1);
    expect(lines.join("\n")).toContain("incomplete or damaged");
    expect(readFileSync(cacheFile).equals(body)).toBe(true);
    expect(readFileSync(result.staged[0]!.file).equals(body)).toBe(true);
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("treats a same-size pack with the wrong bytes as a miss as well", async () => {
    const root = temp();
    const cacheDir = path.join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `${sha}.bin`);
    writeFileSync(cacheFile, Buffer.alloc(body.length, 1));
    const result = await stage.stageBundledPacks({
      manifest,
      cacheDir,
      stageDir: path.join(root, "resources"),
      fetchImpl: async () => ({ body }),
    });
    expect(result.staged).toHaveLength(1);
    expect(readFileSync(cacheFile).equals(body)).toBe(true);
  });

  it("keeps a good cached pack and downloads nothing", async () => {
    const root = temp();
    const cacheDir = path.join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, `${sha}.bin`), body);
    const result = await stage.stageBundledPacks({
      manifest,
      cacheDir,
      stageDir: path.join(root, "resources"),
      offline: true,
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    expect(result.staged).toHaveLength(1);
  });

  it("still stops when a pack keeps failing after the fetch, and leaves no half pack behind", async () => {
    const root = temp();
    const cacheDir = path.join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, `${sha}.bin`), body.subarray(0, 3));
    await expect(
      stage.stageBundledPacks({
        manifest,
        cacheDir,
        stageDir: path.join(root, "resources"),
        fetchImpl: async () => ({ body: Buffer.from("wrong") }),
      }),
    ).rejects.toThrow(/SHA-256/);
    expect(existsSync(path.join(cacheDir, `${sha}.bin`))).toBe(false);
  });
});
