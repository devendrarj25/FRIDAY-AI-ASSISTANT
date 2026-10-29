/**
 * A new installer is rebuilt from the one already on this PC plus only the
 * blocks that changed — and whenever that does not work out, the normal full
 * download takes over. Block maps here are synthetic (fixed-size blocks); the
 * plan only compares checksum strings, exactly as electron-updater does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const diff = require_(path.join(root, "electron/differential-download.cjs"));
const sync = require_(path.join(root, "electron/github-sync.cjs"));
const safety = require_(path.join(root, "electron/update-safety.cjs"));

const BLOCK = 16 * 1024;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function blockMap(data: Buffer, block = BLOCK) {
  const checksums: string[] = [];
  const sizes: number[] = [];
  for (let at = 0; at < data.length; at += block) {
    const chunk = data.subarray(at, Math.min(at + block, data.length));
    checksums.push(crypto.createHash("sha256").update(chunk).digest("base64"));
    sizes.push(chunk.length);
  }
  return { version: "2", files: [{ name: "file", offset: 0, checksums, sizes }] };
}
const gz = (map: unknown) => zlib.gzipSync(JSON.stringify(map));

/** old: 160 blocks of random data. new: two changed regions and a new tail. */
function pair() {
  const old = crypto.randomBytes(BLOCK * 160 + 1234);
  const next = Buffer.from(old);
  crypto.randomBytes(BLOCK * 3).copy(next, BLOCK * 20);
  crypto.randomBytes(BLOCK * 2).copy(next, BLOCK * 100);
  const grown = Buffer.concat([next, crypto.randomBytes(BLOCK * 4 + 77)]);
  return { old, next: grown };
}

type Call = { url: string; range: string; auth: string };
/** GitHub-like: the API address redirects to a CDN; the CDN honours Range. */
function server(file: Buffer, opts: { ignoreRange?: boolean; failFirstRange?: boolean } = {}) {
  const calls: Call[] = [];
  let failed = false;
  const fetchImpl = async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const headers = init.headers || {};
    calls.push({
      url: String(url),
      range: headers["range"] || "",
      auth: headers["authorization"] || "",
    });
    if (String(url).startsWith("https://api.github.com/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/signed" },
      });
    }
    const m = /bytes=(\d+)-(\d+)/.exec(headers["range"] || "");
    if (opts.failFirstRange && !failed) {
      failed = true;
      return new Response("expired", { status: 403 });
    }
    if (!m || opts.ignoreRange) return new Response(new Uint8Array(file), { status: 200 });
    const start = Number(m[1]);
    const end = Number(m[2]);
    return new Response(new Uint8Array(file.subarray(start, end + 1)), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${file.length}` },
    });
  };
  return { fetchImpl, calls };
}

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-diff-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the plan", () => {
  it("copies what both versions share and downloads only what changed, merged into ranges", () => {
    const { old, next } = pair();
    const ops = diff.computeOperations(blockMap(old), blockMap(next));
    const downloads = ops.filter((o: { kind: string }) => o.kind === "download");
    const plan = diff.summarize(ops);
    expect(plan.download + plan.copy).toBe(next.length);
    // 3 + 2 changed blocks, plus the old 1234-byte tail and the 4 blocks + 77 bytes appended.
    expect(plan.download).toBe(BLOCK * 9 + 1234 + 77);
    expect(downloads.length).toBeLessThanOrEqual(4);
    // Nothing is planned twice and the ranges tile the new file.
    let at = 0;
    for (const op of ops as { kind: string; start: number; end: number }[]) {
      at += op.end - op.start;
    }
    expect(at).toBe(next.length);
  });

  it("refuses block maps it cannot compare", () => {
    const a = blockMap(crypto.randomBytes(BLOCK * 2));
    expect(() => diff.computeOperations(a, { ...a, version: "3" })).toThrow(/versions differ/);
    expect(() => diff.parseBlockMap(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => diff.parseBlockMap(zlib.gzipSync("{}"))).toThrow(/no usable file/);
    expect(diff.parseBlockMap(gz(a)).files[0].sizes).toHaveLength(2);
  });
});

describe("rebuilding the installer", () => {
  const run = (over: Record<string, unknown>) => {
    const { old, next } = pair();
    const oldFile = path.join(dir, "FRIDAY-Setup-1.0.exe");
    fs.writeFileSync(oldFile, old);
    const srv = server(next, (over["server"] as never) || {});
    const options = {
      url: "https://api.github.com/repos/o/r/releases/assets/9",
      token: "t0k",
      oldFile,
      oldBlockMap: blockMap(old),
      newBlockMap: blockMap(next),
      part: path.join(dir, "FRIDAY-Setup-2.0.exe.diff.part"),
      expectedBytes: next.length,
      sha256: sha(next),
      fetchImpl: srv.fetchImpl,
      sleep: async () => {},
      stallMs: 2000,
      ...over,
    };
    delete (options as Record<string, unknown>)["server"];
    return { old, next, srv, options, go: () => diff.downloadDifferential(options) };
  };

  it("builds the exact new file fetching only the changed ranges, with the token sent only to GitHub", async () => {
    const t = run({});
    const events: { total: number; received: number }[] = [];
    const out = await diff.downloadDifferential({
      ...t.options,
      onProgress: (e: never) => events.push(e),
    });
    expect(out.ok).toBe(true);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
    expect(out.downloaded).toBeLessThan(t.next.length * 0.2);
    expect(out.reused).toBeGreaterThan(t.next.length * 0.8);
    const cdn = t.srv.calls.filter((c) => c.url.startsWith("https://cdn.example"));
    expect(cdn.length).toBeGreaterThan(0);
    expect(cdn.every((c) => c.auth === "" && /^bytes=\d+-\d+$/.test(c.range))).toBe(true);
    // The API redirect was walked once; later ranges went straight to the CDN.
    expect(t.srv.calls.filter((c) => c.url.startsWith("https://api.github.com")).length).toBe(1);
    expect(events.at(-1)?.received).toBe(out.downloaded);
    expect(events.at(-1)?.total).toBe(out.downloaded);
  });

  it("asks for a fresh address when the signed one has expired", async () => {
    const t = run({ server: { failFirstRange: true } });
    const out = await t.go();
    expect(out.ok).toBe(true);
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
  });

  it("falls back, and leaves nothing behind, when the server ignores Range", async () => {
    const t = run({ server: { ignoreRange: true } });
    const out = await t.go();
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(fs.existsSync(t.options.part as string)).toBe(false);
  });

  it("falls back when the rebuilt file is not the published one", async () => {
    const t = run({ sha256: "00".repeat(32) });
    const out = await t.go();
    expect(out).toMatchObject({ ok: false, reason: "checksum" });
    expect(fs.existsSync(t.options.part as string)).toBe(false);
  });

  it("falls back when the old installer no longer matches its block map, or little is shared", async () => {
    const t = run({});
    fs.appendFileSync(t.options["oldFile"] as string, "x");
    expect(await t.go()).toMatchObject({ ok: false, reason: "old-file-changed" });
    const other = crypto.randomBytes(BLOCK * 40);
    const fresh = run({
      newBlockMap: blockMap(other),
      expectedBytes: other.length,
      sha256: sha(other),
    });
    expect(await fresh.go()).toMatchObject({ ok: false, reason: "not-worth" });
  });

  it("will not run without a published checksum to verify against", async () => {
    const t = run({ sha256: "" });
    expect(await t.go()).toMatchObject({ ok: false, reason: "no-checksum" });
  });

  it("stops when cancelled and removes the partial file", async () => {
    const t = run({});
    const controller = new AbortController();
    controller.abort();
    const out = await diff.downloadDifferential({ ...t.options, signal: controller.signal });
    expect(out).toMatchObject({ ok: false, cancelled: true });
    expect(fs.existsSync(t.options.part as string)).toBe(false);
  });
});

describe("inside the installer download", () => {
  const NAME = "FRIDAY-Setup-2.0.0.0.exe";
  const asset = (n: string) => `https://api.github.com/repos/o/r/releases/assets/${n}`;

  async function setup(stub: { ignoreRange?: boolean } = {}) {
    sync.writeConfig(dir, { repo: "o/r", updateToken: "ro" });
    const { old, next } = pair();
    const installers = path.join(dir, "updates", "installers");
    fs.mkdirSync(installers, { recursive: true });
    const oldFile = path.join(installers, "FRIDAY-Setup-1.0.0.0.exe");
    fs.writeFileSync(oldFile, old);
    fs.writeFileSync(`${oldFile}.blockmap`, gz(blockMap(old)));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
        const u = String(url);
        const range = init.headers?.["range"] || "";
        calls.push(`${u} ${range}`.trim());
        if (u.startsWith("https://api.github.com/")) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://cdn.example/${u.split("/").pop()}` },
          });
        }
        if (u.endsWith("/2"))
          return new Response(new Uint8Array(gz(blockMap(next))), { status: 200 });
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        if (m && !stub.ignoreRange) {
          return new Response(new Uint8Array(next.subarray(Number(m[1]), Number(m[2]) + 1)), {
            status: 206,
            headers: { "content-range": `bytes ${m[1]}-${m[2]}/${next.length}` },
          });
        }
        return new Response(new Uint8Array(next), {
          status: 200,
          headers: {
            "content-length": String(next.length),
            "content-type": "application/octet-stream",
          },
        });
      }),
    );
    const input = {
      root: dir,
      apiUrl: asset("1"),
      assetId: 1,
      name: NAME,
      bytes: next.length,
      sha256: sha(next),
      blockmap: { apiUrl: asset("2"), id: 2, name: `${NAME}.blockmap` },
    };
    return { old, next, calls, input, installers };
  }

  it("downloads only the difference against the previous installer and remembers the new block map", async () => {
    const t = await setup();
    const out = await sync.downloadInstaller(t.input);
    expect(out).toMatchObject({ ok: true, verified: true, differential: true });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
    expect(out.downloaded).toBeLessThan(t.next.length * 0.2);
    expect(fs.existsSync(`${out.file}.blockmap`)).toBe(true);
    // The whole file was never requested.
    expect(t.calls.some((c) => c.includes("cdn.example/1") && !c.includes("bytes="))).toBe(false);
  });

  it("falls back to the full download when ranges are not supported, and still saves the block map", async () => {
    const t = await setup({ ignoreRange: true });
    const out = await sync.downloadInstaller(t.input);
    expect(out.ok).toBe(true);
    expect(out.differential).toBeUndefined();
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
    expect(fs.existsSync(`${out.file}.blockmap`)).toBe(true);
    expect(fs.existsSync(`${out.file}.diff.part`)).toBe(false);
  });

  it("downloads in full when there is no earlier installer with a block map", async () => {
    const t = await setup();
    fs.rmSync(path.join(t.installers, "FRIDAY-Setup-1.0.0.0.exe.blockmap"));
    const out = await sync.downloadInstaller(t.input);
    expect(out.ok).toBe(true);
    expect(out.differential).toBeUndefined();
    expect(fs.existsSync(`${out.file}.blockmap`)).toBe(true);
  });

  it("reads the earlier installer's block map from its own release when none was saved beside it", async () => {
    const t = await setup();
    const oldExe = path.join(t.installers, "FRIDAY-Setup-1.0.0.0.exe");
    const oldMap = fs.readFileSync(`${oldExe}.blockmap`);
    fs.rmSync(`${oldExe}.blockmap`);
    const inner = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: unknown) => {
        const u = String(url);
        if (u === "https://api.github.com/repos/o/r/releases/tags/v1.0.0.0") {
          return new Response(
            JSON.stringify({
              assets: [
                {
                  id: 7,
                  name: "FRIDAY-Setup-1.0.0.0.exe.blockmap",
                  size: oldMap.length,
                  url: asset("7"),
                  browser_download_url: "https://github.com/o/r/releases/download/v1.0.0.0/x",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u === asset("7")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example/old.blockmap" },
          });
        }
        if (u === "https://cdn.example/old.blockmap")
          return new Response(new Uint8Array(oldMap), { status: 200 });
        return inner(url, init);
      }),
    );
    const out = await sync.downloadInstaller(t.input);
    expect(out).toMatchObject({ ok: true, verified: true, differential: true });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
    // It is remembered for the next time.
    expect(fs.existsSync(`${oldExe}.blockmap`)).toBe(true);
  });

  it("downloads in full when the earlier release has no block map either", async () => {
    const t = await setup();
    const oldExe = path.join(t.installers, "FRIDAY-Setup-1.0.0.0.exe");
    fs.rmSync(`${oldExe}.blockmap`);
    const inner = globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: unknown) =>
        String(url).includes("/releases/tags/")
          ? new Response(JSON.stringify({ assets: [] }), { status: 200 })
          : inner(url, init),
      ),
    );
    const out = await sync.downloadInstaller(t.input);
    expect(out.ok).toBe(true);
    expect(out.differential).toBeUndefined();
  });

  it("works without any block map at all (older releases)", async () => {
    const t = await setup();
    const { blockmap: _unused, ...plain } = t.input;
    void _unused;
    const out = await sync.downloadInstaller(plain);
    expect(out.ok).toBe(true);
    expect(out.differential).toBeUndefined();
    expect(sha(fs.readFileSync(out.file))).toBe(sha(t.next));
  });

  it("keeps and prunes block maps together with their installers", () => {
    const base = path.join(dir, "updates", "installers");
    fs.mkdirSync(base, { recursive: true });
    ["a", "b", "c"].forEach((n, i) => {
      const f = path.join(base, `FRIDAY-Setup-${n}.exe`);
      fs.writeFileSync(f, "x");
      fs.writeFileSync(`${f}.blockmap`, "m");
      const at = new Date(2026, 0, i + 1);
      fs.utimesSync(f, at, at);
    });
    safety.pruneInstallers({ root: dir, keep: 2 });
    expect(fs.readdirSync(base).sort()).toEqual([
      "FRIDAY-Setup-b.exe",
      "FRIDAY-Setup-b.exe.blockmap",
      "FRIDAY-Setup-c.exe",
      "FRIDAY-Setup-c.exe.blockmap",
    ]);
  });
});

describe("wired to the release", () => {
  it("finds the block map beside the installer in the release's files", () => {
    const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
    expect(main).toContain("a.name === `${asset.name}.blockmap`");
    expect(main).toContain("blockmap,");
  });
});
