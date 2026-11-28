/**
 * What the renderer sends to `models:download` is data: the folder name must be a plain id, and a mirror set is rebuilt
 * from the trusted pin, never taken from the urls the renderer chose.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
type Result = { ok: boolean; error?: string; via?: string };
const download = require_("../../electron/model-download.cjs") as {
  isSafeModelId: (id: unknown) => boolean;
  downloadModel: (
    job: unknown,
    onEvent?: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
    deps?: Record<string, unknown>,
  ) => Promise<Result>;
};
const weights = require_("../../electron/voice-weights.cjs") as {
  modelscopeSource: (repo: string) => { repo: string; files: { url: string }[] } | null;
  STT_REPOS: Record<string, string>;
};
const mainSource = readFileSync(path.resolve(__dirname, "../../electron/main.cjs"), "utf8");

describe("model ids that become a folder name", () => {
  it("accepts the catalog shapes and refuses a path", () => {
    for (const ok of ["tiny", "moonshine-en", "qwen2.5-7b", "a", "Llama_3.1-8B"])
      expect(download.isSafeModelId(ok), ok).toBe(true);
    for (const bad of [
      "",
      "..",
      "../evil",
      "a/b",
      "a\\b",
      "a..b",
      ".hidden",
      "-lead",
      "a b",
      "x".repeat(82),
      "C:\\x",
      null,
      undefined,
      7,
    ])
      expect(download.isSafeModelId(bad), String(bad)).toBe(false);
  });

  it("downloadModel refuses a hostile id before any download or path", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-id-"));
    try {
      let calls = 0;
      for (const modelId of ["../evil", "a/b", "..", "a\\b"]) {
        const result = await download.downloadModel(
          {
            modelId,
            dir,
            sources: [{ kind: "url", url: "https://example.invalid/x.bin", label: "x" }],
            persist: false,
          },
          () => {},
          undefined,
          {
            localBundles: [],
            downloadUrl: async () => {
              calls += 1;
              return 0;
            },
          },
        );
        expect(result.ok, modelId).toBe(false);
        expect(result.error).toMatch(/model id/i);
      }
      expect(calls).toBe(0);
      expect(existsSync(path.join(dir, "..", "evil"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.cjs checks the id before the first path or job is made", () => {
    const at = mainSource.indexOf('ipcMain.handle("models:download"');
    const body = mainSource.slice(at, at + 1400);
    expect(body).toContain("isSafeModelId(modelId)");
    expect(body.indexOf("isSafeModelId(modelId)")).toBeLessThan(body.indexOf("modelJobs.set"));
  });
});

describe("a url-set source is rebuilt from the trusted pin", () => {
  const repo = weights.STT_REPOS["tiny"] as string;
  const trusted = weights.modelscopeSource(repo);

  it("uses the pinned urls whatever files and urls the renderer sent", async () => {
    expect(trusted).not.toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-uset-"));
    const urls: string[] = [];
    try {
      const forged = {
        kind: "url-set",
        host: "evil.example",
        label: "mirror",
        repo,
        files: [
          {
            kind: "url",
            url: "https://evil.example/a",
            sha256: "0".repeat(64),
            bytes: 1,
            relPath: "../../x",
          },
        ],
      };
      const result = await download.downloadModel(
        { modelId: "test-ear", dir, sources: [forged], persist: false },
        () => {},
        undefined,
        {
          localBundles: [],
          downloadUrl: async (url: string) => {
            urls.push(url);
            throw new Error("stop");
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url.startsWith("https://modelscope.cn/")).toBe(true);
        expect(trusted?.files.map((file) => file.url)).toContain(url);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a repository no verified mirror holds", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-uset-"));
    let calls = 0;
    try {
      const result = await download.downloadModel(
        {
          modelId: "test-ear",
          dir,
          sources: [{ kind: "url-set", host: "evil.example", repo: "evil/repo", files: [] }],
          persist: false,
        },
        () => {},
        undefined,
        {
          localBundles: [],
          downloadUrl: async () => {
            calls += 1;
            return 0;
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
