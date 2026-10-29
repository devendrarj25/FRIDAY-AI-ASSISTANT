/**
 * The app downloader must never hand back a file with holes. Parallel ranges
 * are held to their exact length, a stopped download resumes only from what
 * each range really wrote, and a server that ignores Range still yields the
 * right bytes. Loopback server only: no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs") as {
  downloadUrl: (url: string, dest: string, options?: Record<string, unknown>) => Promise<number>;
};

const body = Buffer.alloc(4096);
for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + (i >> 8)) & 0xff;
const sha = createHash("sha256").update(body).digest("hex");
const split = { segmentThreshold: 1000, maxSegments: 4 };

type Mode = { ignoreRange?: boolean; cutFirst?: boolean };
let server: Server | null = null;
let dir = "";

async function serve(mode: Mode = {}) {
  const requests: string[] = [];
  let cut = Boolean(mode.cutFirst);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.headers.range || ""}`.trim());
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": body.length, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    const range = /bytes=(\d+)-(\d+)?/.exec(String(req.headers.range || ""));
    if (!range || mode.ignoreRange) {
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      "content-length": slice.length,
      "content-range": `bytes ${start}-${end}/${body.length}`,
    });
    if (cut && start > 0) {
      // The stream ends early and cleanly: half of the range arrives, then the socket closes.
      cut = false;
      res.write(slice.subarray(0, slice.length >> 1));
      res.end();
      res.socket?.destroy();
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/file.bin`, requests };
}

afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const target = () => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-dl-"));
  return path.join(dir, "file.bin");
};

describe("download integrity", () => {
  it("joins parallel ranges into exactly the published bytes", async () => {
    const { url, requests } = await serve();
    const dest = target();
    await download.downloadUrl(url, dest, { ...split, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(requests.filter((r) => r.startsWith("GET bytes=")).length).toBe(4);
  });

  it("asks again for the rest of a range that ended early instead of leaving a hole", async () => {
    const { url, requests } = await serve({ cutFirst: true });
    const dest = target();
    await download.downloadUrl(url, dest, { ...split, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(requests.filter((r) => r.startsWith("GET bytes=")).length).toBeGreaterThan(4);
  });

  it("falls back to one clean stream when the server ignores Range", async () => {
    const { url } = await serve({ ignoreRange: true });
    const dest = target();
    await download.downloadUrl(url, dest, { ...split, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it("does not trust a partial file by its size: a leftover .part without its table starts over", async () => {
    const { url } = await serve();
    const dest = target();
    // Three quarters of the size on disk, but zeros where parallel ranges had not written yet.
    const holey = Buffer.alloc(3072);
    body.copy(holey, 3072 - 100, 3072 - 100, 3072);
    writeFileSync(`${dest}.part`, holey);
    await download.downloadUrl(url, dest, { ...split, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it("resumes only the bytes each range is missing when the table matches", async () => {
    const { url, requests } = await serve();
    const dest = target();
    const part = Buffer.alloc(body.length);
    body.copy(part, 0, 0, 1024);
    writeFileSync(`${dest}.part`, part);
    writeFileSync(
      `${dest}.part.json`,
      JSON.stringify({
        total: body.length,
        segments: [
          { start: 0, end: 1023, got: 1024 },
          { start: 1024, end: 2047, got: 0 },
          { start: 2048, end: 3071, got: 0 },
          { start: 3072, end: 4095, got: 0 },
        ],
      }),
    );
    await download.downloadUrl(url, dest, { ...split, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(requests).not.toContain("GET bytes=0-1023");
    expect(existsSync(`${dest}.part.json`)).toBe(false);
  });

  it("fetches a failing checksum once more, then reports it and keeps no bad file", async () => {
    const { url, requests } = await serve();
    const dest = target();
    await expect(
      download.downloadUrl(url, dest, { ...split, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(requests.filter((r) => r === "HEAD").length).toBe(2);
  });
});
