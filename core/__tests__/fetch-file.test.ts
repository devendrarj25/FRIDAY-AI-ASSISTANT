/**
 * scripts/fetch-file.cjs: the one-file HTTPS download setup-windows.ps1 runs for the installers it fetches once
 * Node.js is there, with the same coloured percent, size and speed row as the other downloads. A fake `https.get`
 * serves the bytes: no network, no date, no Windows.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const https = require_("node:https") as { get: (...args: unknown[]) => unknown };
const fetchFile = require_("../../scripts/fetch-file.cjs") as {
  fetchFile: (
    url: string,
    out: string,
    onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void,
  ) => Promise<number>;
  nextUrl: (current: string, location: string) => string | null;
  parseContentRange: (value: unknown) => { start: number; total: number } | null;
  proxyConfigured: (env: Record<string, string>) => boolean;
  makeReporter: (
    label: string,
    stream: unknown,
    env: Record<string, string>,
    now: () => number,
  ) => (p: { bytesDone: number; bytesTotal: number }, state?: string) => void;
};

const realGet = https.get;
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "friday-fetch-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  https.get = realGet;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer; cut?: boolean };
/** The options (headers) of every request the fake served, in order. */
let sentOptions: { headers?: Record<string, string> }[] = [];
/** A fake https.get: each call takes the next reply; the asked URLs are recorded. */
function serve(replies: Reply[]) {
  const asked: string[] = [];
  sentOptions = [];
  https.get = (...args: unknown[]) => {
    const callback = args[2] as (res: unknown) => void;
    asked.push(String(args[0]));
    sentOptions.push(args[1] as { headers?: Record<string, string> });
    const reply = replies.shift() ?? { status: 500 };
    const req = new EventEmitter() as EventEmitter & { destroy: (e?: Error) => void };
    req.destroy = (error?: Error) => void (error && req.emit("error", error));
    setImmediate(() => {
      const res = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        setTimeout: () => void;
      };
      res.statusCode = reply.status;
      res.headers = reply.headers ?? {};
      res.setTimeout = () => {};
      callback(res);
      if (reply.cut) {
        if (reply.body) res.write(reply.body);
        setImmediate(() => res.emit("aborted"));
      } else if (reply.body) res.end(reply.body);
      else res.end();
    });
    return req;
  };
  return asked;
}

describe("fetch-file", () => {
  it("writes the file through a .part name and reports each chunk", async () => {
    const body = Buffer.from("installer bytes");
    const asked = serve([
      { status: 200, headers: { "content-length": String(body.length) }, body },
    ]);
    const out = path.join(temp(), "node.msi");
    const seen: number[] = [];
    const size = await fetchFile.fetchFile("https://a.example/node.msi", out, (p) =>
      seen.push(p.bytesDone),
    );
    expect(size).toBe(body.length);
    expect(readFileSync(out).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(body.length);
    expect(asked).toEqual(["https://a.example/node.msi"]);
    expect(readdirSync(path.dirname(out))).toEqual(["node.msi"]);
  });

  it("follows an https redirect and refuses one that leaves https", async () => {
    const body = Buffer.from("ok");
    const asked = serve([
      { status: 302, headers: { location: "https://cdn.example/x/node.msi" } },
      { status: 200, headers: { "content-length": "2" }, body },
    ]);
    const out = path.join(temp(), "a.bin");
    await fetchFile.fetchFile("https://a.example/node.msi", out);
    expect(asked).toEqual(["https://a.example/node.msi", "https://cdn.example/x/node.msi"]);
    expect(fetchFile.nextUrl("https://a.example/p", "/other")).toBe("https://a.example/other");
    expect(fetchFile.nextUrl("https://a.example/p", "http://evil.example/x")).toBeNull();

    serve([{ status: 302, headers: { location: "http://evil.example/x" } }]);
    const refused = path.join(temp(), "b.bin");
    await expect(fetchFile.fetchFile("https://a.example/n", refused)).rejects.toThrow(/not https/);
    expect(existsSync(refused)).toBe(false);
  });

  it("leaves nothing behind on an HTTP error or a short body", async () => {
    serve([{ status: 404 }]);
    const dir = temp();
    await expect(
      fetchFile.fetchFile("https://a.example/n", path.join(dir, "a.bin")),
    ).rejects.toThrow(/HTTP 404/);
    serve([{ status: 200, headers: { "content-length": "10" }, body: Buffer.from("short") }]);
    await expect(
      fetchFile.fetchFile("https://a.example/n", path.join(dir, "b.bin")),
    ).rejects.toThrow(/got 5 of 10/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the .part of a cut connection and continues it with a Range request", async () => {
    const dir = temp();
    const out = path.join(dir, "big.bin");
    serve([
      { status: 200, headers: { "content-length": "10" }, body: Buffer.from("abcde"), cut: true },
    ]);
    await expect(fetchFile.fetchFile("https://a.example/big", out)).rejects.toThrow(/cut/);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(`${out}.part`, "utf8")).toBe("abcde");

    serve([
      {
        status: 206,
        headers: { "content-range": "bytes 5-9/10", "content-length": "5" },
        body: Buffer.from("fghij"),
      },
    ]);
    const seen: number[] = [];
    const size = await fetchFile.fetchFile("https://a.example/big", out, (p) =>
      seen.push(p.bytesDone),
    );
    expect(sentOptions[0]?.headers?.["Range"]).toBe("bytes=5-");
    expect(size).toBe(10);
    expect(readFileSync(out, "utf8")).toBe("abcdefghij");
    expect(seen.at(-1)).toBe(10);
    expect(readdirSync(dir)).toEqual(["big.bin"]);
  });

  it("starts over when the server ignores the range, sends the wrong one, or refuses it", async () => {
    const full = Buffer.from("0123456789");
    const dir = temp();
    const out = path.join(dir, "r.bin");
    const keep = () => writeFileSync(`${out}.part`, "stale");

    keep();
    serve([{ status: 200, headers: { "content-length": "10" }, body: full }]);
    await fetchFile.fetchFile("https://a.example/r", out);
    expect(sentOptions[0]?.headers?.["Range"]).toBe("bytes=5-");
    expect(readFileSync(out).equals(full)).toBe(true);

    keep();
    serve([
      { status: 206, headers: { "content-range": "bytes 0-9/10" }, body: full },
      { status: 200, headers: { "content-length": "10" }, body: full },
    ]);
    await fetchFile.fetchFile("https://a.example/r", out);
    expect(sentOptions.map((o) => o.headers?.["Range"])).toEqual(["bytes=5-", undefined]);
    expect(readFileSync(out).equals(full)).toBe(true);

    keep();
    serve([{ status: 416 }, { status: 200, headers: { "content-length": "10" }, body: full }]);
    await fetchFile.fetchFile("https://a.example/r", out);
    expect(sentOptions.map((o) => o.headers?.["Range"])).toEqual(["bytes=5-", undefined]);
    expect(readFileSync(out).equals(full)).toBe(true);
    expect(readdirSync(dir)).toEqual(["r.bin"]);
  });

  it("reads a Content-Range header and nothing else", () => {
    expect(fetchFile.parseContentRange("bytes 5-9/10")).toEqual({ start: 5, total: 10 });
    expect(fetchFile.parseContentRange("bytes 5-9/*")).toEqual({ start: 5, total: 0 });
    expect(fetchFile.parseContentRange("items 5-9/10")).toBeNull();
    expect(fetchFile.parseContentRange(undefined)).toBeNull();
  });

  it("leaves a proxy to curl.exe and Invoke-WebRequest", () => {
    expect(fetchFile.proxyConfigured({ HTTPS_PROXY: "http://proxy.example:8080" })).toBe(true);
    expect(fetchFile.proxyConfigured({ PATH: "/usr/bin" })).toBe(false);
  });

  it("draws the coloured percent, size and speed row on a console and plain tenths in a log", () => {
    const MB = 1024 ** 2;
    const rows: string[] = [];
    let clock = 0;
    const console_ = { isTTY: true, write: (text: string) => void rows.push(text) };
    const draw = fetchFile.makeReporter("node.msi", console_, { FORCE_COLOR: "1" }, () => clock);
    draw({ bytesDone: 0, bytesTotal: 40 * MB });
    clock = 1000;
    draw({ bytesDone: 10 * MB, bytesTotal: 40 * MB });
    const shown = rows.join("");
    expect(shown).toContain("\x1b[");
    const flat = shown.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(flat).toContain("25%");
    expect(flat).toContain("10 MB/40 MB");
    expect(flat).toContain("MB/s");

    const lines: string[] = [];
    const log = { isTTY: false, write: (text: string) => void lines.push(text) };
    const plain = fetchFile.makeReporter("node.msi", log, {}, () => 0);
    for (let done = 0; done <= 40; done += 1) plain({ bytesDone: done * MB, bytesTotal: 40 * MB });
    plain({ bytesDone: 40 * MB, bytesTotal: 40 * MB }, "done");
    expect(lines.every((line) => !line.includes("\x1b["))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(lines.at(-1)).toContain("100%");
  });
});
