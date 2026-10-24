/**
 * The one download routine behind app, source and pack updates. A fake server
 * stands in for GitHub and its CDN: it can cut the connection mid-file, send
 * nothing, ignore Range, rate-limit, redirect and answer with a web page.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require_ = createRequire(import.meta.url);
const dl = require_(path.join(import.meta.dirname, "../../electron/resilient-download.cjs"));

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-dl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const payload = Buffer.from(Array.from({ length: 300_000 }, (_v, i) => (i * 7 + 3) % 251));
const sha = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

type Plan = {
  /** Called once per request; return how to answer it. */
  next: (call: { n: number; range: number; url: string; auth: string }) => Answer;
};
type Answer =
  | {
      kind: "ok";
      status?: number;
      cutAfter?: number;
      hang?: boolean;
      type?: string;
      ignoreRange?: boolean;
      /** A proxy that compresses: Content-Length counts the compressed bytes. */
      encoding?: string;
    }
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "redirect"; to: string };

function server(plan: Plan) {
  const calls: { url: string; range: number; auth: string; encoding: string }[] = [];
  const fetchImpl = async (
    url: string,
    init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ) => {
    const headers = init.headers || {};
    const range = /bytes=(\d+)-/.exec(headers["range"] || "");
    const call = {
      n: calls.length + 1,
      range: range ? Number(range[1]) : 0,
      url: String(url),
      auth: headers["authorization"] || "",
    };
    calls.push({
      url: call.url,
      range: call.range,
      auth: call.auth,
      encoding: headers["accept-encoding"] || "",
    });
    const answer = plan.next(call);
    if (answer.kind === "redirect") {
      return new Response(null, { status: 302, headers: { location: answer.to } });
    }
    if (answer.kind === "status") {
      return new Response("nope", { status: answer.status, headers: answer.headers || {} });
    }
    const honourRange = call.range > 0 && !answer.ignoreRange;
    const start = honourRange ? call.range : 0;
    const body = payload.subarray(start);
    const status = honourRange ? 206 : (answer.status ?? 200);
    const responseHeaders: Record<string, string> = {
      "content-type": answer.type || "application/octet-stream",
      "content-length": String(body.length),
    };
    if (answer.encoding) {
      responseHeaders["content-encoding"] = answer.encoding;
      responseHeaders["content-length"] = String(Math.floor(body.length / 3));
    }
    if (status === 206)
      responseHeaders["content-range"] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
    // A pull stream hands out one chunk per read, so what was sent before a break
    // really reaches the reader (error() on a full queue would discard it).
    let at = 0;
    const cut = Math.min(answer.cutAfter ?? body.length, body.length);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at < cut) {
          const end = Math.min(at + 40_000, cut);
          controller.enqueue(body.subarray(at, end));
          at = end;
          return;
        }
        if (answer.hang) {
          await new Promise<void>((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
          return;
        }
        if (cut < body.length) {
          controller.error(new TypeError("terminated"));
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  };
  return { fetchImpl, calls };
}

const run = (fetchImpl: unknown, extra: Record<string, unknown> = {}) =>
  dl.downloadToFile({
    url: "https://api.github.com/repos/o/r/releases/assets/9",
    dest: path.join(dir, "FRIDAY-Setup.exe"),
    token: "t0k",
    expectedBytes: payload.length,
    fetchImpl,
    sleep: async () => {},
    stallMs: 60,
    ...extra,
  });

describe("a complete file", () => {
  it("downloads, reports progress and lands with the exact bytes", async () => {
    const { fetchImpl, calls } = server({ next: () => ({ kind: "ok" }) });
    const events: { percent: number }[] = [];
    const out = await run(fetchImpl, { onProgress: (e: { percent: number }) => events.push(e) });
    expect(out).toMatchObject({ ok: true, attempts: 1, bytes: payload.length });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
    expect(fs.existsSync(`${out.file}.part`)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(events.at(-1)?.percent).toBeGreaterThan(50);
  });
});

describe("a connection that breaks mid-file", () => {
  it("keeps what arrived and continues from there, up to the end", async () => {
    const { fetchImpl, calls } = server({
      next: (c) =>
        c.n === 1
          ? { kind: "ok", cutAfter: 120_000 }
          : c.n === 2
            ? { kind: "ok", cutAfter: 90_000 }
            : { kind: "ok" },
    });
    const out = await run(fetchImpl);
    expect(out).toMatchObject({ ok: true, attempts: 3, resumed: true });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
    expect(calls[1]?.range).toBe(120_000);
    expect(calls[2]?.range).toBe(210_000);
  });

  it("notices a stream that ends early without an error", async () => {
    // The server closes cleanly after fewer bytes than it announced.
    let first = true;
    const { fetchImpl } = server({ next: () => ({ kind: "ok" }) });
    const short = async (url: string, init: unknown) => {
      const res = await (fetchImpl as (u: string, i: unknown) => Promise<Response>)(url, init);
      if (!first) return res;
      first = false;
      const cut = payload.subarray(0, 100_000);
      return new Response(cut, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    };
    const out = await run(short);
    expect(out.ok).toBe(true);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
    expect(out.attempts).toBe(2);
  });

  it("gives up after the attempts, keeps the part for the next try and says so", async () => {
    const { fetchImpl } = server({ next: () => ({ kind: "ok", cutAfter: 50_000 }) });
    const out = await run(fetchImpl, { attempts: 3 });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Tried 3 times");
    expect(out.error).toContain("continues from it");
    expect(out.resumable).toBe(true);
    expect(fs.statSync(path.join(dir, "FRIDAY-Setup.exe.part")).size).toBeGreaterThan(0);
  });
});

describe("a connection that goes silent", () => {
  it("is cut by the stall watchdog and retried", async () => {
    const { fetchImpl, calls } = server({
      next: (c) => (c.n === 1 ? { kind: "ok", cutAfter: 80_000, hang: true } : { kind: "ok" }),
    });
    const out = await run(fetchImpl);
    expect(out.ok).toBe(true);
    expect(calls[1]?.range).toBe(80_000);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
  });
});

describe("how a server may answer", () => {
  it("restarts cleanly when it ignores Range and sends the whole file again", async () => {
    const { fetchImpl } = server({
      next: (c) =>
        c.n === 1 ? { kind: "ok", cutAfter: 70_000 } : { kind: "ok", ignoreRange: true },
    });
    const out = await run(fetchImpl);
    expect(out.ok).toBe(true);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
  });

  it("asks for the raw file and does not trust Content-Length on a compressed answer", async () => {
    const { fetchImpl, calls } = server({ next: () => ({ kind: "ok", encoding: "gzip" }) });
    const out = await run(fetchImpl, { expectedBytes: 0 });
    expect(out).toMatchObject({ ok: true, attempts: 1 });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
    expect(calls[0]?.encoding).toBe("identity");
  });

  it("waits out a rate limit or a 503 and tries again", async () => {
    const waits: number[] = [];
    const { fetchImpl } = server({
      next: (c) =>
        c.n === 1
          ? { kind: "status", status: 429, headers: { "retry-after": "7" } }
          : c.n === 2
            ? { kind: "status", status: 503 }
            : { kind: "ok" },
    });
    const out = await run(fetchImpl, { sleep: async (ms: number) => void waits.push(ms) });
    expect(out).toMatchObject({ ok: true, attempts: 3 });
    expect(waits[0]).toBe(7000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
  });

  it("does not retry what cannot change: 404 and 403", async () => {
    for (const status of [404, 403, 401]) {
      const { fetchImpl, calls } = server({ next: () => ({ kind: "status", status }) });
      const out = await run(fetchImpl);
      expect(out).toMatchObject({ ok: false, fatal: true, attempts: 1, status });
      expect(calls).toHaveLength(1);
    }
    const { fetchImpl } = server({ next: () => ({ kind: "status", status: 403 }) });
    expect((await run(fetchImpl)).error).toContain("Contents: Read-only");
  });

  it("refuses a web page where the file should be", async () => {
    const { fetchImpl } = server({ next: () => ({ kind: "ok", type: "text/html" }) });
    const out = await run(fetchImpl);
    expect(out).toMatchObject({ ok: false, fatal: true });
    expect(out.error).toContain("web page");
  });

  it("refuses a file whose first bytes are a web page even with a binary content type", async () => {
    const page = Buffer.from("<!DOCTYPE html><html>login</html>".padEnd(2000, " "));
    const fetchImpl = async () =>
      new Response(page, { status: 200, headers: { "content-type": "application/octet-stream" } });
    const out = await run(fetchImpl, { expectedBytes: 0 });
    expect(out.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "FRIDAY-Setup.exe"))).toBe(false);
  });
});

describe("redirects and the token", () => {
  it("sends the token to the first host only, never to the CDN, and re-resolves on every attempt", async () => {
    const { fetchImpl, calls } = server({
      next: (c) =>
        c.url.startsWith("https://api.github.com")
          ? { kind: "redirect", to: `https://objects.githubusercontent.com/signed?n=${c.n}` }
          : c.n <= 2
            ? { kind: "ok", cutAfter: 100_000 }
            : { kind: "ok" },
    });
    const out = await run(fetchImpl);
    expect(out.ok).toBe(true);
    for (const call of calls) {
      if (call.url.startsWith("https://api.github.com")) expect(call.auth).toBe("Bearer t0k");
      else expect(call.auth).toBe("");
    }
    const cdn = calls.filter((c) => c.url.includes("objects.githubusercontent.com"));
    expect(new Set(cdn.map((c) => c.url)).size).toBe(cdn.length);
  });
});

describe("checks before the file is accepted", () => {
  it("rejects a file that is not the announced size", async () => {
    const fetchImpl = async () =>
      new Response(Buffer.concat([payload, Buffer.from("extra")]), { status: 200 });
    const out = await run(fetchImpl, { expectedBytes: payload.length, attempts: 2 });
    expect(out.ok).toBe(false);
  });

  it("runs the caller's check, and stops after the second failed check", async () => {
    const { fetchImpl, calls } = server({ next: () => ({ kind: "ok" }) });
    const out = await run(fetchImpl, { validate: () => "Checksum mismatch." });
    expect(out).toMatchObject({ ok: false, fatal: true, attempts: 2 });
    expect(out.error).toBe("Checksum mismatch.");
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, "FRIDAY-Setup.exe"))).toBe(false);
  });

  it("recognises a complete and a cut-off zip", () => {
    const whole = path.join(dir, "whole.zip");
    const AdmZip = null;
    void AdmZip;
    const header = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const eocd = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
    fs.writeFileSync(whole, Buffer.concat([header, Buffer.alloc(100), eocd]));
    expect(dl.zipLooksComplete(whole)).toBe(true);
    const cut = path.join(dir, "cut.zip");
    fs.writeFileSync(cut, Buffer.concat([header, Buffer.alloc(300)]));
    expect(dl.zipLooksComplete(cut)).toBe(false);
  });
});

describe("cancel and resume across runs", () => {
  it("stops when the owner cancels and leaves the part for later", async () => {
    const controller = new AbortController();
    const { fetchImpl } = server({ next: () => ({ kind: "ok", cutAfter: 100_000, hang: true }) });
    const pending = run(fetchImpl, { signal: controller.signal, stallMs: 5000 });
    setTimeout(() => controller.abort(), 50);
    const out = await pending;
    expect(out).toMatchObject({ ok: false, cancelled: true });
  });

  it("continues a part left by an earlier run", async () => {
    const part = path.join(dir, "FRIDAY-Setup.exe.part");
    fs.writeFileSync(part, payload.subarray(0, 150_000));
    const { fetchImpl, calls } = server({ next: () => ({ kind: "ok" }) });
    const out = await run(fetchImpl);
    expect(out).toMatchObject({ ok: true, resumed: true });
    expect(calls[0]?.range).toBe(150_000);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(payload));
  });

  it("finishes without a request when the part is already the whole file", async () => {
    fs.writeFileSync(path.join(dir, "FRIDAY-Setup.exe.part"), payload);
    const { fetchImpl, calls } = server({ next: () => ({ kind: "ok" }) });
    const out = await run(fetchImpl);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
