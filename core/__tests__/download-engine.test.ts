/**
 * The download engine pulls small chunks with a pool of connections that grows while it still
 * helps, ends a connection that goes quiet, moves to another host when one fails, and reports real
 * bytes. Loopback servers only: no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs") as {
  downloadUrl: (url: string, dest: string, options?: Record<string, unknown>) => Promise<number>;
  planSegments: (total: number, count: number) => { start: number; end: number; got: number }[];
  CHUNK_BYTES: number;
};
const stage = require_("../../scripts/stage-toolchain.cjs") as {
  progressLine: (id: string, event: Record<string, unknown>, tty: boolean) => string;
};

const body = Buffer.alloc(64 * 1024);
for (let i = 0; i < body.length; i += 1) body[i] = (i * 17 + (i >> 9)) & 0xff;
const sha = createHash("sha256").update(body).digest("hex");

type Mode = {
  stallFirst?: boolean;
  hangFirstHeaders?: boolean;
  delayMs?: number;
  broken?: boolean;
};
const servers: Server[] = [];
let dir = "";

async function serve(mode: Mode = {}) {
  let live = 0;
  const stats = { peak: 0, gets: 0 };
  let stalled = !mode.stallFirst;
  let hung = !mode.hangFirstHeaders;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (mode.broken) {
      res.writeHead(500);
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": body.length, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    stats.gets += 1;
    const range = /bytes=(\d+)-(\d+)?/.exec(String(req.headers.range || ""));
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : body.length - 1;
    if (!hung) {
      hung = true; // the first request never gets headers
      return;
    }
    const slice = body.subarray(start, end + 1);
    live += 1;
    stats.peak = Math.max(stats.peak, live);
    const done = () => {
      live -= 1;
    };
    res.on("close", done);
    res.writeHead(206, {
      "content-length": slice.length,
      "content-range": `bytes ${start}-${end}/${body.length}`,
    });
    if (!stalled && start > 0) {
      stalled = true; // half of the first later chunk arrives, then the line goes quiet
      res.write(slice.subarray(0, slice.length >> 1));
      return;
    }
    setTimeout(() => res.end(slice), mode.delayMs || 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/file.bin`, stats };
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const target = () => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-engine-"));
  return path.join(dir, "file.bin");
};

const small = { segmentThreshold: 1000, maxSegments: 8, stallMs: 250, headersMs: 400 };

describe("download engine", () => {
  it("cuts a big file into 8 MB chunks and a small one into one chunk per connection", () => {
    const mb = 1024 * 1024;
    const big = download.planSegments(484 * mb, 16);
    expect(big.length).toBe(61);
    expect(big[0]).toEqual({ start: 0, end: download.CHUNK_BYTES - 1, got: 0 });
    expect(big.at(-1)?.end).toBe(484 * mb - 1);
    // Fewer chunks than connections would leave connections idle, so a mid-size file is cut finer.
    expect(download.planSegments(100 * mb, 16).length).toBe(16);
    expect(download.planSegments(4096, 4).length).toBe(4);
  });

  it("ends a connection that goes quiet and asks again for the rest of its chunk", async () => {
    const { url } = await serve({ stallFirst: true });
    const dest = target();
    await download.downloadUrl(url, dest, { ...small, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it("gives up on a server that sends no headers and tries again", async () => {
    const { url } = await serve({ hangFirstHeaders: true });
    const dest = target();
    await download.downloadUrl(url, dest, { ...small, sha256: sha });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it("moves to the alternate host when the first one fails, and checks the bytes", async () => {
    const bad = await serve({ broken: true });
    const good = await serve();
    const dest = target();
    await download.downloadUrl(bad.url, dest, {
      ...small,
      alternates: [good.url],
      sha256: sha,
    });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(good.stats.gets).toBeGreaterThan(0);
  });

  it("starts with a few connections and adds more while the speed still rises", async () => {
    const { url, stats } = await serve({ delayMs: 60 });
    const dest = target();
    await download.downloadUrl(url, dest, {
      ...small,
      segmentThreshold: 1000,
      maxSegments: 8,
      startConnections: 2,
      rampMs: 40,
      sha256: sha,
    });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(stats.peak).toBeGreaterThan(2);
    expect(stats.peak).toBeLessThanOrEqual(8);
  });

  it("reports real bytes, the connections in use and the host", async () => {
    const { url } = await serve({ delayMs: 30 });
    const dest = target();
    type Event = { bytesTotal?: number; connections?: number; host?: string };
    const events: Event[] = [];
    await download.downloadUrl(url, dest, {
      ...small,
      sha256: sha,
      onEvent: (event: Event) => events.push(event),
    });
    const last = events.filter((event) => event.bytesTotal).at(-1);
    expect(last?.bytesTotal).toBe(body.length);
    expect(events.some((event) => Number(event.connections) > 0)).toBe(true);
    expect(events.every((event) => event.host === "127.0.0.1" || event.host === undefined)).toBe(
      true,
    );
  });
});

describe("the progress line", () => {
  it("shows sizes, speed, ETA and connections, and clears the rest of a terminal row", () => {
    const event = {
      progress: 48,
      bytesDone: 232 * 1024 ** 2,
      bytesTotal: 484 * 1024 ** 2,
      speedMbps: 9.8,
      etaSeconds: 26,
      connections: 12,
    };
    const line = stage.progressLine("stt-small", event, true);
    expect(line).toContain("48% 232/484 MB 9.8 MB/s eta 26s 12 conn");
    expect(line.endsWith("\x1b[K")).toBe(true);
    expect(stage.progressLine("stt-small", { ...event, progress: 50 }, false)).toContain("50%");
  });
});
