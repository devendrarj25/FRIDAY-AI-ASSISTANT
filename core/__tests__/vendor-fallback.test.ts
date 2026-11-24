/**
 * Latest versions from official sources only, in an ordered chain per row: a source that is down, slow, rate-limited
 * or empty falls through to the next one; a conditional request (ETag, Last-Modified) saves the body; offline serves
 * the cached answer marked stale; a download is verified against the digest the official API published and refused on
 * a mismatch. Fake feeds, a fake clock and a throwaway folder: no network and no real PC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));

const H = (c: string) => c.repeat(64);
type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  hang?: boolean;
  throws?: string;
};
type Routes = Record<string, Reply | ((url: string, init: RequestInit) => Reply)>;

function network(routes: Routes) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers || {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error("network down");
    const spec = routes[key]!;
    const reply = typeof spec === "function" ? spec(url, init) : spec;
    if (reply.throws) throw new Error(reply.throws);
    if (reply.hang) {
      await new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    const status = reply.status ?? 200;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers(reply.headers || {}),
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-feeds-"));
  vendor.clearFeedCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clock = (start = 1_800_000_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const GH_RELEASE = {
  tag_name: "b11300",
  assets: [
    {
      name: "llama-b11300-bin-win-cpu-x64.zip",
      browser_download_url: "https://github.com/x/y/a.zip",
      size: 10,
      digest: `sha256:${H("a")}`,
    },
    {
      name: "llama-b11300-bin-win-vulkan-x64.zip",
      browser_download_url: "https://github.com/x/y/v.zip",
      size: 20,
      digest: `sha256:${H("b")}`,
    },
  ],
};
const ATOM = `<?xml version="1.0"?><feed><entry><id>1</id><link rel="alternate" type="text/html" href="https://github.com/ggml-org/llama.cpp/releases/tag/b11299"/><title>b11299</title></entry><entry><link rel="alternate" href="https://github.com/ggml-org/llama.cpp/releases/tag/b11200"/></entry></feed>`;

const GITHUB_CHAIN = [
  { kind: "github-api", repo: "ggml-org/llama.cpp", strip: "^b" },
  { kind: "github-atom", repo: "ggml-org/llama.cpp", strip: "^b" },
  { kind: "pinned", version: "11243", assets: [] },
];

describe("source chain: GitHub", () => {
  it("the releases API answers first and its asset digests are read as sha256", async () => {
    const net = network({
      "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest": { body: GH_RELEASE },
    });
    const out = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({
      ok: true,
      version: "11300",
      tag: "b11300",
      source: "github-api",
      stale: false,
    });
    expect(out.assets[1]).toMatchObject({
      name: "llama-b11300-bin-win-vulkan-x64.zip",
      sha256: H("b"),
      bytes: 20,
    });
    expect(out.attempts).toEqual([expect.objectContaining({ source: "github-api", ok: true })]);
    expect(net.calls).toHaveLength(1);
  });

  it("a rate-limited API falls to releases.atom, which names the version but offers no assets", async () => {
    const net = network({
      "https://api.github.com/": { status: 403, body: { message: "rate limit" } },
      "https://github.com/ggml-org/llama.cpp/releases.atom": { body: ATOM },
    });
    const out = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({ ok: true, version: "11299", source: "github-atom" });
    expect(out.assets).toEqual([]);
    expect(out.attempts.map((a: { source: string; ok: boolean }) => [a.source, a.ok])).toEqual([
      ["github-api", false],
      ["github-atom", true],
    ]);
    expect(out.attempts[0].error).toMatch(/403/);
  });

  it("a source that hangs is given up after its own short timeout and the next one answers", async () => {
    const net = network({
      "https://api.github.com/": { hang: true },
      "https://github.com/ggml-org/llama.cpp/releases.atom": { body: ATOM },
    });
    const started = Date.now();
    const out = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
      timeoutMs: 40,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toMatchObject({ ok: true, source: "github-atom" });
    expect(out.attempts[0].error).toMatch(/time|abort/i);
  });

  it("a fetch that ignores the abort signal still cannot hold the chain", async () => {
    const stuck = async () => new Promise(() => undefined);
    const out = await vendor.resolveLatest(
      "x",
      [
        { kind: "github-api", repo: "a/b" },
        { kind: "pinned", version: "1" },
      ],
      {
        fetchImpl: stuck,
        now: clock().now,
        timeoutMs: 30,
      },
    );
    expect(out).toMatchObject({ ok: true, version: "1", source: "pinned", pinned: true });
  });

  it("every source down and nothing cached: the pinned catalogue answers, flagged as pinned", async () => {
    const net = network({});
    const out = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({ ok: true, version: "11243", source: "pinned", pinned: true });
    expect(out.attempts.filter((a: { ok: boolean }) => !a.ok)).toHaveLength(2);
  });

  it("no pinned source and nothing cached is a clear error that names every source tried", async () => {
    const net = network({});
    const out = await vendor.resolveLatest("x", GITHUB_CHAIN.slice(0, 2), {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/github-api/);
    expect(out.error).toMatch(/github-atom/);
  });
});

describe("source chain: conditional requests and the stale cache", () => {
  it("a second look sends the ETag and Last-Modified, and a 304 serves the stored answer", async () => {
    const file = path.join(dir, "feeds.json");
    const store = vendor.createFeedStore({ file });
    const c = clock();
    let n = 0;
    const net = network({
      "https://api.github.com/": (_u, init) => {
        n += 1;
        const h = (init.headers || {}) as Record<string, string>;
        if (n === 1)
          return {
            body: GH_RELEASE,
            headers: { etag: 'W/"abc"', "last-modified": "Mon, 01 Jan 2026 00:00:00 GMT" },
          };
        expect(h["if-none-match"]).toBe('W/"abc"');
        expect(h["if-modified-since"]).toBe("Mon, 01 Jan 2026 00:00:00 GMT");
        return { status: 304 };
      },
    });
    const first = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      store,
      now: c.now,
    });
    expect(first.version).toBe("11300");
    c.advance(25 * 3600_000);
    const second = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: net.fetchImpl,
      store,
      now: c.now,
    });
    expect(second).toMatchObject({
      ok: true,
      version: "11300",
      source: "github-api",
      notModified: true,
      stale: false,
    });
    expect(second.assets).toHaveLength(2);
    expect(second.checkedAt).toBe(c.now());
    expect(net.calls).toHaveLength(2);
  });

  it("offline after a good answer: the cached value is returned, marked stale, with the time it was checked", async () => {
    const store = vendor.createFeedStore({ file: path.join(dir, "feeds.json") });
    const c = clock();
    const up = network({ "https://api.github.com/": { body: GH_RELEASE } });
    await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: up.fetchImpl,
      store,
      now: c.now,
    });
    const checkedAt = c.now();
    c.advance(3 * 24 * 3600_000);
    const down = network({});
    const out = await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: down.fetchImpl,
      store,
      now: c.now,
    });
    expect(out).toMatchObject({
      ok: true,
      version: "11300",
      stale: true,
      checkedAt,
      source: "github-api",
    });
    expect(out.attempts.every((a: { ok: boolean }) => !a.ok)).toBe(true);
  });

  it("the store survives a restart: a new store on the same file serves the old answer", async () => {
    const file = path.join(dir, "cache", "feeds.json");
    const a = vendor.createFeedStore({ file });
    const up = network({
      "https://api.github.com/": { body: GH_RELEASE, headers: { etag: '"e1"' } },
    });
    await vendor.resolveLatest("llama.cpp", GITHUB_CHAIN, {
      fetchImpl: up.fetchImpl,
      store: a,
      now: clock().now,
    });
    a.flush();
    expect(existsSync(file)).toBe(true);
    const b = vendor.createFeedStore({ file });
    expect(b.getRow("llama.cpp")).toMatchObject({ value: { version: "11300" } });
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe(1);
  });

  it("a corrupt cache file starts empty and never throws; flush writes only when something changed", () => {
    const file = path.join(dir, "feeds.json");
    writeFileSync(file, "{not json");
    const store = vendor.createFeedStore({ file });
    expect(store.getRow("x")).toBeNull();
    expect(store.flush()).toBe(false);
    store.putRow("x", { value: { version: "1" }, checkedAt: 5 });
    expect(store.flush()).toBe(true);
    expect(store.flush()).toBe(false);
  });
});

describe("source chain: PyPI and Hugging Face", () => {
  const CUBLAS = {
    info: { version: "12.9.3.13" },
    releases: {
      "12.9.2.10": [
        {
          filename: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
          url: "https://files.pythonhosted.org/w.whl",
          size: 553,
          digests: { sha256: H("c") },
          yanked: false,
        },
        {
          filename: "nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl",
          url: "https://files.pythonhosted.org/l.whl",
          size: 500,
          digests: { sha256: H("d") },
        },
      ],
      "12.9.3.13": [
        {
          filename: "nvidia_cublas_cu12-12.9.3.13-py3-none-manylinux_2_27_x86_64.whl",
          url: "https://files.pythonhosted.org/l2.whl",
          size: 501,
          digests: { sha256: H("e") },
        },
      ],
      "13.0.0rc1": [
        {
          filename: "nvidia_cublas_cu12-13.0.0rc1-py3-none-win_amd64.whl",
          url: "https://files.pythonhosted.org/rc.whl",
          size: 1,
          digests: { sha256: H("f") },
        },
      ],
    },
  };
  const CHAIN = [
    { kind: "pypi-json", pkg: "nvidia-cublas-cu12", platform: "win_amd64" },
    { kind: "pypi-simple", pkg: "nvidia-cublas-cu12", platform: "win_amd64" },
    { kind: "pinned", version: "12.9.2.10", assets: [] },
  ];

  it("picks the newest release that has a wheel for this platform, skips pre-releases, reads its sha256", async () => {
    const net = network({ "https://pypi.org/pypi/nvidia-cublas-cu12/json": { body: CUBLAS } });
    const out = await vendor.resolveLatest("cublas", CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({ ok: true, version: "12.9.2.10", source: "pypi-json" });
    expect(out.assets).toEqual([
      expect.objectContaining({
        name: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
        sha256: H("c"),
        bytes: 553,
      }),
    ]);
  });

  it("when the JSON API is down the Simple API (PEP 691) gives the same answer", async () => {
    const net = network({
      "https://pypi.org/pypi/": { status: 502 },
      "https://pypi.org/simple/nvidia-cublas-cu12/": {
        body: {
          files: [
            {
              filename: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
              url: "https://files.pythonhosted.org/w.whl",
              hashes: { sha256: H("c") },
              size: 553,
            },
            {
              filename: "nvidia_cublas_cu12-12.9.3.13-py3-none-manylinux_2_27_x86_64.whl",
              url: "https://files.pythonhosted.org/l2.whl",
              hashes: { sha256: H("e") },
            },
            {
              filename: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
              url: "https://x",
              hashes: { sha256: H("9") },
              yanked: true,
            },
          ],
        },
      },
    });
    const out = await vendor.resolveLatest("cublas", CHAIN, {
      fetchImpl: net.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({ ok: true, version: "12.9.2.10", source: "pypi-simple" });
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].sha256).toBe(H("c"));
    expect(net.calls.map((c) => c.url).some((u) => u.includes("/simple/"))).toBe(true);
    expect(net.calls.find((c) => c.url.includes("/simple/"))!.headers["accept"]).toMatch(
      /vnd\.pypi\.simple\.v1\+json/,
    );
  });

  it("Hugging Face: the model API gives the revision and LFS digests; down falls to the pinned revision", async () => {
    const chain = [
      { kind: "hf-api", repo: "Systran/faster-whisper-small" },
      { kind: "pinned", version: "pinnedrev", revision: "pinnedrev", assets: [] },
    ];
    const up = network({
      "https://huggingface.co/api/models/Systran/faster-whisper-small": {
        body: {
          sha: "abc123def4567890",
          siblings: [
            { rfilename: "model.bin", size: 9, lfs: { sha256: H("1"), size: 9 } },
            { rfilename: "config.json", size: 2 },
          ],
        },
      },
    });
    const out = await vendor.resolveLatest("hf", chain, {
      fetchImpl: up.fetchImpl,
      now: clock().now,
    });
    expect(out).toMatchObject({
      ok: true,
      version: "abc123def4567890",
      revision: "abc123def4567890",
      source: "hf-api",
    });
    expect(out.assets.find((a: { name: string }) => a.name === "model.bin")).toMatchObject({
      sha256: H("1"),
      url: "https://huggingface.co/Systran/faster-whisper-small/resolve/abc123def4567890/model.bin",
    });
    expect(up.calls[0]!.url).toContain("blobs=true");
    const down = await vendor.resolveLatest("hf2", chain, {
      fetchImpl: network({}).fetchImpl,
      now: clock().now,
    });
    expect(down).toMatchObject({ ok: true, version: "pinnedrev", pinned: true });
  });

  it("the version order is numeric, not alphabetical, and a pre-release never beats its release", () => {
    expect(vendor.compareVersions("12.9.10", "12.9.2")).toBeGreaterThan(0);
    expect(vendor.compareVersions("1.0.0", "1.0.0rc1")).toBeGreaterThan(0);
    expect(vendor.compareVersions("2.0", "2.0.0")).toBe(0);
  });
});

describe("downloads are checked against the official digest", () => {
  it("verifyFile accepts the right digest and refuses a different one", async () => {
    const file = path.join(dir, "a.bin");
    writeFileSync(file, "hello");
    const sha = require_("node:crypto").createHash("sha256").update("hello").digest("hex");
    expect(await vendor.verifyFile(file, sha)).toMatchObject({ ok: true });
    expect(await vendor.verifyFile(file, `sha256:${sha.toUpperCase()}`)).toMatchObject({
      ok: true,
    });
    const bad = await vendor.verifyFile(file, H("0"));
    expect(bad).toMatchObject({ ok: false, actual: sha });
    expect(await vendor.verifyFile(path.join(dir, "missing"), sha)).toMatchObject({ ok: false });
    expect((await vendor.verifyFile(file, "")).ok).toBe(false); // no digest means no install
  });

  it("downloadVerified: a mismatch deletes the file and moves on, the next source wins, the first error is kept", async () => {
    const good = require_("node:crypto").createHash("sha256").update("GOOD").digest("hex");
    const tried: string[] = [];
    const download = async (url: string, file: string) => {
      tried.push(url);
      mkdirSync(path.dirname(file), { recursive: true });
      if (url.includes("a.example")) return void writeFileSync(file, "TAMPERED");
      if (url.includes("b.example")) throw new Error("connection reset");
      writeFileSync(file, "GOOD");
    };
    const out = await vendor.downloadVerified(
      [
        { url: "https://a.example/f.zip", sha256: good, source: "github-api" },
        { url: "https://b.example/f.zip", sha256: good, source: "mirror" },
        { url: "https://c.example/f.zip", sha256: good, source: "pinned" },
      ],
      { download, dest: path.join(dir, "dl", "f.zip") },
    );
    expect(out).toMatchObject({ ok: true, source: "pinned" });
    expect(tried).toHaveLength(3);
    expect(out.failures.map((f: { source: string }) => f.source)).toEqual(["github-api", "mirror"]);
    expect(out.failures[0].error).toMatch(/digest/i);
    expect(readFileSync(out.file, "utf8")).toBe("GOOD");
  });

  it("every source failing is a clear error, no file is left behind and nothing is installed", async () => {
    const download = async (_u: string, file: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "NOPE");
    };
    const dest = path.join(dir, "dl", "f.zip");
    const out = await vendor.downloadVerified(
      [{ url: "https://a.example/f.zip", sha256: H("1"), source: "api" }],
      { download, dest },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/digest/i);
    expect(existsSync(dest)).toBe(false);
  });

  it("a candidate with no digest is never downloaded", async () => {
    let called = 0;
    const out = await vendor.downloadVerified(
      [{ url: "https://a.example/f.zip", sha256: "", source: "api" }],
      {
        download: async () => void (called += 1),
        dest: path.join(dir, "f.zip"),
      },
    );
    expect(out.ok).toBe(false);
    expect(called).toBe(0);
    expect(out.error).toMatch(/no sha-?256/i);
  });

  it("the official digest and the pinned one must agree for the same version, or the install is refused", () => {
    expect(
      vendor.agreeOnDigest({ version: "1", sha256: H("a") }, { version: "1", sha256: H("a") }),
    ).toMatchObject({ ok: true });
    const bad = vendor.agreeOnDigest(
      { version: "1", sha256: H("a") },
      { version: "1", sha256: H("b") },
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/pinned/i);
    // a newer version has no pin to disagree with
    expect(
      vendor.agreeOnDigest({ version: "1", sha256: H("a") }, { version: "2", sha256: H("b") }),
    ).toMatchObject({ ok: true });
    expect(vendor.agreeOnDigest(null, { version: "2", sha256: H("b") })).toMatchObject({
      ok: true,
    });
  });
});

describe("refresh plan: daily, jittered, rate-limited, never on a timer of its own", () => {
  const DAY = 24 * 3600_000;
  it("refreshes after a day with the jitter as the start delay, and not before", () => {
    expect(
      vendor.planFeedRefresh({ trigger: "startup", ageMs: 2 * DAY, jitterMs: 12_345 }),
    ).toMatchObject({ refresh: true, delayMs: 12_345 });
    expect(
      vendor.planFeedRefresh({ trigger: "interval", ageMs: DAY - 1000, jitterMs: 5 }),
    ).toMatchObject({ refresh: false });
    expect(vendor.planFeedRefresh({ trigger: "startup", ageMs: null, jitterMs: 5 })).toMatchObject({
      refresh: true,
    });
    expect(
      vendor.planFeedRefresh({ trigger: "startup", ageMs: 9 * DAY, jitterMs: 999_999 }).delayMs,
    ).toBeLessThan(60_000);
  });
  it("privacy and offline skip the network; the cache keeps serving", () => {
    expect(
      vendor.planFeedRefresh({ trigger: "startup", ageMs: 9 * DAY, privacy: true }),
    ).toMatchObject({ refresh: false });
    expect(
      vendor.planFeedRefresh({ trigger: "startup", ageMs: 9 * DAY, online: false }),
    ).toMatchObject({ refresh: false });
  });
  it("a manual refresh runs at once, but not twice inside the rate limit", () => {
    const first = vendor.planFeedRefresh({ trigger: "manual", ageMs: 1000, sinceManualMs: null });
    expect(first).toMatchObject({ refresh: true, delayMs: 0 });
    const soon = vendor.planFeedRefresh({ trigger: "manual", ageMs: 1000, sinceManualMs: 10_000 });
    expect(soon.refresh).toBe(false);
    expect(soon.retryInMs).toBeGreaterThan(0);
    expect(soon.retryInMs).toBeLessThanOrEqual(vendor.MANUAL_MIN_MS);
    expect(
      vendor.planFeedRefresh({
        trigger: "manual",
        ageMs: 1000,
        sinceManualMs: vendor.MANUAL_MIN_MS + 1,
      }).refresh,
    ).toBe(true);
  });
});

describe("no new always-on timer", () => {
  it("the feed, fit and catalogue modules start no interval and keep their one-shot timers to the request timeout", () => {
    for (const file of [
      "vendor-sources.cjs",
      "engine-fit.cjs",
      "installer-catalog.cjs",
      "llama-runtime.cjs",
      "engine-install.cjs",
    ]) {
      const p = path.join(root, "electron", file);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, "utf8");
      expect(src, file).not.toMatch(/setInterval\s*\(/);
    }
    const catalog = path.join(root, "electron/installer-catalog.cjs");
    if (existsSync(catalog)) expect(readFileSync(catalog, "utf8")).not.toMatch(/setTimeout\s*\(/);
  });
});
