/**
 * Rust must install from the official rustup-init even when the large channel document is slow,
 * a missing feed must say why, and the Hugging Face official client is tried first and checked.
 * No network and no Python here: fake fetches and a fake client process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const hub = require_(path.join(root, "electron/hf-hub-download.cjs"));
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const HASH = "a".repeat(64);
const reply = (body: string, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  text: async () => body,
  json: async () => JSON.parse(body),
});

describe("Rust feed", () => {
  afterEach(() => vendor.clearFeedCache());

  it("still offers rustup-init when the big channel document never arrives", async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      if (url.endsWith("rustup-init.exe.sha256")) return reply(`${HASH} *rustup-init.exe\n`);
      if (url.includes("channel-rust-stable.toml")) throw new Error("timed out");
      if (url.includes("api.github.com/repos/rust-lang/rust")) {
        return reply(JSON.stringify({ tag_name: "1.93.1", assets: [] }));
      }
      throw new Error(`unexpected ${url}`);
    };
    const feed = await vendor.resolveFeed("Rust", { fetchImpl, force: true });
    expect(feed.install).toEqual({
      url: "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
      sha256: HASH,
    });
    expect(feed.installerArgs).toEqual([
      "-y",
      "--default-toolchain",
      "stable",
      "--profile",
      "minimal",
    ]);
    expect(feed.version).toBe("1.93.1");
    // The digest file is read first: the install does not wait for the version lookup.
    expect(asked[0]).toContain("rustup-init.exe.sha256");
  });

  it("reads the digest file as rust-lang.org publishes it: the bare hash and nothing else", async () => {
    // https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256
    // holds only the 64 characters and a newline. A parser that needs a file name found no digest,
    // so the official installer was never offered and setup failed on Rust.
    const fetchImpl = async (url: string) => {
      if (url.endsWith("rustup-init.exe.sha256")) return reply(`${HASH}\n`);
      if (url.includes("channel-rust-stable.toml")) {
        return reply('[pkg.rust]\nversion = "1.93.1 (abcdef 2026-01-01)"\n');
      }
      throw new Error(`unexpected ${url}`);
    };
    const feed = await vendor.resolveFeed("Rust", { fetchImpl, force: true });
    expect(feed.install).toEqual({
      url: "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
      sha256: HASH,
    });
    expect(feed.version).toBe("1.93.1");
  });

  it("accepts rustup-init without an Authenticode signature, on its SHA-256 alone", () => {
    // rust-lang.org publishes rustup-init.exe unsigned. Requiring "Valid" rejected the right file.
    const source = read("electron/toolchain.cjs");
    expect(read("electron/vendor-sources.cjs")).toContain("allowUnsigned: true");
    expect(source).toContain("...(feed.allowUnsigned ? { allowUnsigned: true } : {})");
    expect(source).toContain(
      'tool.allowUnsigned && tool.sha256 && String(signed.reason) === "NotSigned"',
    );
    // Any other result (HashMismatch, NotTrusted ...) still refuses the file.
    expect(source).toContain("if (!signed.ok && !unsignedOk) {");
  });

  it("takes a bare hash only when no file name is asked for", () => {
    expect(vendor.hashFromSums(`${HASH}\n`, "")).toBe(HASH);
    expect(vendor.hashFromSums(`${HASH}  *rustup-init.exe\n`, "")).toBe(HASH);
    // A multi-file sums list still needs the name, so a bare line there is never mistaken for it.
    expect(vendor.hashFromSums(`${HASH}\n`, "node-v22-x64.msi")).toBeNull();
    expect(vendor.hashFromSums(`${HASH}  node-v22-x64.msi\n`, "node-v22-x64.msi")).toBe(HASH);
    expect(vendor.hashFromSums("not a digest", "")).toBeNull();
  });

  it("tries the small digest file twice before giving up", async () => {
    let asked = 0;
    const fetchImpl = async (url: string) => {
      if (url.endsWith("rustup-init.exe.sha256")) {
        asked += 1;
        if (asked === 1) throw new Error("timed out");
        return reply(`${HASH}\n`);
      }
      throw new Error("offline");
    };
    const feed = await vendor.resolveFeed("Rust", { fetchImpl, force: true });
    expect(feed.install.sha256).toBe(HASH);
    expect(asked).toBe(2);
  });

  it("gives the long channel document more than the 8 second default", () => {
    expect(read("electron/vendor-sources.cjs")).toContain("timeout: 45_000");
  });

  it("remembers why a feed gave nothing, so the install can say it", async () => {
    const fetchImpl = async () => {
      throw new Error("static.rust-lang.org answered 503");
    };
    const feed = await vendor.resolveFeed("Rust", { fetchImpl, force: true });
    expect(feed).toBeNull();
    expect(vendor.feedFailure("Rust")).toContain("503");
    expect(read("electron/toolchain.cjs")).toContain("gave no installer (");
  });
});

describe("Hugging Face official client", () => {
  const dirs: string[] = [];
  const target = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-hub-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  /** A stand-in for `python -c ...`: writes the files the client would write, then exits. */
  const fakeClient =
    (opts: {
      write?: Record<string, string>;
      exit?: number;
      hang?: boolean;
      slow?: boolean;
      beats?: number;
    }) =>
    (_python: string, args: string[]) => {
      const dest = args[3] as string;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let closed = false;
      const finish = (code: number) => {
        if (closed) return;
        closed = true;
        child.emit("close", code);
      };
      child.kill = () => finish(1);
      // A Xet client writes nothing to the folder for a long time but reports its bytes through its bar.
      for (let i = 1; i <= (opts.beats || 0); i += 1) {
        setTimeout(() => {
          child.stdout.emit("data", `FRIDAYBYTES\tDownloading bytes\t${i}\t${opts.beats}\n`);
        }, i * 60);
      }
      if (!opts.hang) {
        setTimeout(
          () => {
            for (const [name, text] of Object.entries(opts.write || {})) {
              mkdirSync(path.dirname(path.join(dest, name)), { recursive: true });
              writeFileSync(path.join(dest, name), text);
            }
            mkdirSync(path.join(dest, ".cache", "huggingface", "download"), { recursive: true });
            if (opts.exit) child.stderr.emit("data", "Traceback: boom");
            finish(opts.exit || 0);
          },
          opts.beats ? (opts.beats + 1) * 60 : opts.slow ? 120 : 5,
        );
      }
      return child;
    };

  const files = [
    { name: "config.json", size: 2, sha256: "" },
    { name: "model.bin", size: 5, sha256: sha("12345") },
  ];

  it("keeps what it fetched when sizes and SHA-256 match, and tidies its cache folder", async () => {
    const dest = target();
    const events: { bytesTotal: number }[] = [];
    const res = await hub.download({
      repo: "Systran/faster-whisper-base",
      dest,
      files,
      python: "python",
      pollMs: 20,
      onProgress: (event: { bytesTotal: number }) => events.push(event),
      spawnImpl: fakeClient({ write: { "config.json": "{}", "model.bin": "12345" }, slow: true }),
    });
    expect(res).toMatchObject({ ok: true, bytes: 7 });
    expect(existsSync(path.join(dest, ".cache"))).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.bytesTotal === 7)).toBe(true);
  });

  it("keeps nothing when a weight fails its SHA-256", async () => {
    const dest = target();
    const res = await hub.download({
      repo: "x/y",
      dest,
      files,
      python: "python",
      pollMs: 20,
      spawnImpl: fakeClient({ write: { "config.json": "{}", "model.bin": "WRONG" } }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("model.bin");
    expect(existsSync(path.join(dest, "model.bin"))).toBe(false);
  });

  it("reports a client that exits with an error, and one that goes quiet", async () => {
    const failed = await hub.download({
      repo: "x/y",
      dest: target(),
      files,
      python: "python",
      pollMs: 20,
      spawnImpl: fakeClient({ exit: 1 }),
    });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.error).toContain("boom");
    const quiet = await hub.download({
      repo: "x/y",
      dest: target(),
      files,
      python: "python",
      pollMs: 20,
      stallMs: 150,
      spawnImpl: fakeClient({ hang: true }),
    });
    expect(quiet).toMatchObject({ ok: false });
    expect(quiet.error).toContain("no byte");
  });

  it("trusts the bytes the client reports, so a Xet download that writes late is not cut off as stalled", async () => {
    // Without the client's own count this run looks silent for 540 ms, longer than the 250 ms stall limit.
    const events: { bytesDone: number }[] = [];
    const res = await hub.download({
      repo: "x/y",
      dest: target(),
      files,
      python: "python",
      pollMs: 20,
      stallMs: 250,
      startMs: 250,
      onProgress: (event: { bytesDone: number }) => events.push(event),
      spawnImpl: fakeClient({ write: { "config.json": "{}", "model.bin": "12345" }, beats: 8 }),
    });
    expect(res).toMatchObject({ ok: true });
    // The count it reported shows up as progress before any file reached the disk.
    expect(events.some((event) => event.bytesDone > 0 && event.bytesDone < 7)).toBe(true);
  });

  it("asks the client for its byte count and keeps its Xet cache inside the folder it cleans up", () => {
    const source = read("electron/hf-hub-download.cjs");
    expect(hub.SCRIPT).toContain("tqdm_class=Beat");
    expect(hub.SCRIPT).toContain("FRIDAYBYTES");
    expect(source).toContain("HF_XET_CACHE");
    expect(source).toContain('HF_HUB_DISABLE_PROGRESS_BARS: "0"');
  });

  it("gives up a client that has moved no byte since the start, long before the stall limit", async () => {
    // The owner's PC: every large model waited 60 seconds for a client that never produced a byte.
    const started = Date.now();
    const silent = await hub.download({
      repo: "x/y",
      dest: target(),
      files,
      python: "python",
      pollMs: 20,
      startMs: 120,
      stallMs: 60_000,
      spawnImpl: fakeClient({ hang: true }),
    });
    expect(silent).toMatchObject({ ok: false });
    expect(silent.error).toContain("no byte in the first");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("remembers a failed client for the rest of the run, so the next model skips the wait", () => {
    hub.resetBroken();
    expect(hub.isBroken()).toBe(false);
    hub.markBroken(1_000);
    expect(hub.isBroken(1_000 + 29 * 60_000)).toBe(true);
    expect(hub.isBroken(1_000 + 31 * 60_000)).toBe(false);
    hub.resetBroken();
    const source = read("electron/model-download.cjs");
    expect(source).toContain("hub.markBroken()");
    expect(source).toContain("the Hugging Face client failed earlier in this run");
  });

  it("counts a part for at most 99 percent so a reserved file never looks finished", () => {
    const dest = target();
    const dir = path.join(dest, ".cache", "huggingface", "download");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "model.bin.abc.incomplete"), Buffer.alloc(1000));
    expect(hub.bytesOnDisk(dest, [{ name: "model.bin", size: 1000 }]).done).toBe(990);
    writeFileSync(path.join(dest, "model.bin"), Buffer.alloc(1000));
    expect(hub.bytesOnDisk(dest, [{ name: "model.bin", size: 1000 }]).done).toBe(1000);
  });

  it("is first for huggingface.co only, can be turned off, and falls back to the own downloader", () => {
    expect(hub.engineMode({})).toBe("auto");
    expect(hub.engineMode({ FRIDAY_HF_ENGINE: "OWN" })).toBe("own");
    expect(hub.engineMode({ FRIDAY_HF_ENGINE: "nonsense" })).toBe("auto");
    expect(hub.findPython({ env: { FRIDAY_PYTHON: "/p/python" }, exists: () => true })).toBe(
      "/p/python",
    );
    expect(hub.findPython({ env: {}, exists: () => false })).toBeNull();
    const source = read("electron/model-download.cjs");
    expect(source).toContain('listing.host === "https://huggingface.co"');
    expect(source).toContain("using FRIDAY's own downloader");
    expect(read("electron/hf-hub-download.cjs")).toContain('HF_XET_HIGH_PERFORMANCE: "1"');
    // Setup hands the model step its own Python, and an owner's FRIDAY_PYTHON only while that file exists.
    expect(read("scripts/setup-python.cjs")).toMatch(
      /FRIDAY_PYTHON:\s*require\("\.\/explicit-python\.cjs"\)\.explicitPython\(process\.env\.FRIDAY_PYTHON\)\s*\|\|\s*python/,
    );
  });
});
