/**
 * A url pin may name the file it must land as (the kernel finds the wake
 * embedding model by that name). Only a bare .onnx file name is honoured; a
 * path or a traversal falls back to the name in the URL. Loopback only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs") as {
  downloadModel: (
    job: Record<string, unknown>,
    onEvent?: (e: unknown) => void,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
};

const body = Buffer.alloc(2048, 7);
const sha = createHash("sha256").update(body).digest("hex");
let server: Server | null = null;
let dir = "";

afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

async function land(fileName: unknown) {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server!.address() as { port: number }).port;
  dir = mkdtempSync(path.join(tmpdir(), "friday-pin-"));
  const result = await download.downloadModel({
    modelId: "wake-embed",
    dir,
    sources: [
      {
        kind: "url",
        url: `http://127.0.0.1:${port}/embedding_model.onnx`,
        fileName,
        sha256: sha,
        bytes: body.length,
      },
    ],
  });
  return result;
}

describe("a url pin can name the file it lands as", () => {
  it("lands as the pinned .onnx name", async () => {
    const r = await land("wake-embed.onnx");
    expect(r.ok).toBe(true);
    expect(path.basename(r.path!)).toBe("wake-embed.onnx");
    expect(existsSync(r.path!)).toBe(true);
  });
  it("keeps the URL name when the pin names no file", async () => {
    const r = await land(undefined);
    expect(r.ok).toBe(true);
    expect(path.basename(r.path!)).toBe("embedding_model.onnx");
  });
  it.each(["../escape.onnx", "sub/dir.onnx", "name.exe", ""])(
    "ignores the unsafe name %j",
    async (bad) => {
      const r = await land(bad);
      expect(r.ok).toBe(true);
      expect(path.basename(r.path!)).toBe("embedding_model.onnx");
      expect(path.dirname(r.path!)).toBe(path.join(dir, "wake-embed"));
    },
  );
});
