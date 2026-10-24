/**
 * Gated and private Hugging Face repositories open with the owner's own token,
 * and the token goes to Hugging Face only, for the length of one download.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const download = createRequire(import.meta.url)("../../electron/model-download.cjs") as {
  withHfAuth: (url: string, init?: Record<string, unknown>) => { headers?: Record<string, string> };
  downloadModel: (
    job: Record<string, unknown>,
    onEvent: () => void,
    signal: AbortSignal | undefined,
    deps: Record<string, unknown>,
  ) => Promise<{ ok: boolean }>;
};

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the Hugging Face token", () => {
  it("is not attached when no download is running", () => {
    expect(download.withHfAuth("https://huggingface.co/api/models/a/b").headers).toBeUndefined();
  });

  it("is sent to huggingface.co while a download runs, then dropped", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
        seen.push({ url: String(url), auth: init.headers?.["authorization"] });
        return new Response("{}", { status: 401 });
      }),
    );
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-hf-token-"));
    folders.push(dir);
    const result = await download.downloadModel(
      {
        modelId: "gated",
        sources: [{ kind: "hf-repo", repo: "meta-llama/Llama-3.2-1B", label: "x" }],
        dir,
      },
      () => {},
      undefined,
      { hfToken: "hf_secret_token" },
    );
    expect(result.ok).toBe(false);
    const listing = seen.find((call) => call.url.includes("/api/models/meta-llama/Llama-3.2-1B"));
    expect(listing?.auth).toBe("Bearer hf_secret_token");
    // After the download the token is gone.
    expect(download.withHfAuth("https://huggingface.co/x").headers).toBeUndefined();
  });

  it("never goes to another host", async () => {
    const seen: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers?: Record<string, string> } = {}) => {
        seen.push(init.headers?.["authorization"]);
        return new Response("{}", { status: 404 });
      }),
    );
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-hf-token-"));
    folders.push(dir);
    await download.downloadModel(
      {
        modelId: "x",
        sources: [{ kind: "url", url: "https://example.com/m.gguf", label: "x" }],
        dir,
      },
      () => {},
      undefined,
      { hfToken: "hf_secret_token" },
    );
    expect(seen.filter(Boolean)).toEqual([]);
  });
});
