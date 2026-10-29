/**
 * Registering an imported GGUF with Ollama. Current Ollama refuses a Modelfile
 * that points at a file path (HTTP 400): the file goes up as a blob and
 * /api/create names it under `files`. Stand-in server, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs") as {
  registerGguf: (
    name: string,
    file: string,
    onEvent?: (e: { status: string }) => void,
  ) => Promise<{ ok: boolean; error?: string; already?: boolean }>;
};

const folders: string[] = [];
const gguf = (bytes = "GGUF-test-bytes") => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-reg-"));
  folders.push(dir);
  const file = path.join(dir, "auk-flash-f16.gguf");
  writeFileSync(file, bytes);
  return { file, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
};

type Call = { url: string; method: string; body?: unknown };
function server(opts: { blobExists?: boolean; createStatus?: number; createError?: string } = {}) {
  const calls: Call[] = [];
  const fake = vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body });
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }));
    if (url.includes("/api/blobs/") && method === "HEAD")
      return new Response(null, { status: opts.blobExists ? 200 : 404 });
    if (url.includes("/api/blobs/") && method === "POST")
      return new Response(null, { status: 201 });
    if (url.endsWith("/api/create")) {
      const status = opts.createStatus ?? 200;
      return new Response(
        status === 200 ? '{"status":"success"}' : JSON.stringify({ error: opts.createError }),
        { status },
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fake);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registering a GGUF with Ollama", () => {
  it("uploads the file as a blob and names it under files", async () => {
    const { file, digest } = gguf();
    const calls = server();
    const result = await download.registerGguf("imported-auk", file);
    expect(result.ok).toBe(true);
    const upload = calls.find((c) => c.method === "POST" && c.url.includes("/api/blobs/"));
    expect(upload?.url.endsWith(`/api/blobs/${digest}`)).toBe(true);
    const create = calls.find((c) => c.url.endsWith("/api/create"))!;
    expect(JSON.parse(String(create.body))).toEqual({
      model: "imported-auk",
      files: { "auk-flash-f16.gguf": digest },
      stream: false,
    });
  });

  it("does not upload a file Ollama already holds", async () => {
    const { file } = gguf();
    const calls = server({ blobExists: true });
    expect((await download.registerGguf("imported-auk", file)).ok).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/blobs/"))).toBe(false);
  });

  it("reports Ollama's own reason instead of a bare status", async () => {
    const { file } = gguf();
    server({ createStatus: 400, createError: "unsupported architecture: auk" });
    const result = await download.registerGguf("imported-auk", file);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 400: unsupported architecture: auk");
  });

  it("falls back to the Modelfile form on a server that has no blob route", async () => {
    const { file } = gguf();
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
        calls.push({ url, method: init.method || "GET", body: init.body });
        if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }));
        if (url.includes("/api/blobs/")) return new Response(null, { status: 404 });
        return new Response("{}", { status: 200 });
      }),
    );
    expect((await download.registerGguf("imported-auk", file)).ok).toBe(true);
    const create = calls.filter((c) => c.url.endsWith("/api/create")).pop()!;
    expect(String(create.body)).toContain("modelfile");
  });
});
