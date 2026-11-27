/**
 * The llama.cpp "latest" source. The upstream `releases/latest` is now a semver source-only release; the Windows zips
 * live in the bNNNN releases. The `github-list` reader reads the release list, takes the newest bNNNN tag that has the
 * Windows CPU zip WITH a published digest, and a newer tag is adopted at most once a week. A version seen only by the
 * atom feed carries no digest, so it is used only when the pin holds a digest for that tag. A fake network; no clock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const SERVER = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const spec = () => engines.ENGINES["llama.cpp"];

type Asset = { name: string; digest?: string };
const zip = (tag: string, kind = "cpu-x64", withDigest = true): Asset => {
  const name = `llama-${tag}-bin-win-${kind}.zip`;
  return withDigest ? { name, digest: `sha256:${sha(name)}` } : { name };
};
const release = (tag: string, assets: Asset[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map((a) => ({
    name: a.name,
    browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${a.name}`,
    size: 1000,
    ...(a.digest ? { digest: a.digest } : {}),
  })),
  ...extra,
});
/** What upstream shows now: a semver source-only release on top, the bNNNN builds below. */
const sourceOnly = release("v1.1.0", [{ name: "llama.cpp-v1.1.0-source.tar.gz" }]);

function net(routes: { list?: unknown; atom?: string; down?: boolean }) {
  const calls: string[] = [];
  const answer = (body: string, ok = true, status = 200) => ({
    ok,
    status,
    url: "",
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (routes.down) throw new Error("offline");
    if (url.includes("/releases?per_page=15") && routes.list !== undefined)
      return answer(JSON.stringify(routes.list));
    if (url.endsWith("/releases.atom") && routes.atom !== undefined) return answer(routes.atom);
    return answer("", false, 503);
  };
  return { fetchImpl, calls };
}
const atom = (...tags: string[]) =>
  `<feed>${tags
    .map(
      (t) =>
        `<entry><link href="https://github.com/ggml-org/llama.cpp/releases/tag/${t}"/></entry>`,
    )
    .join("")}</feed>`;

const sources = () => engines.engineSources(spec());
const resolve = (n: ReturnType<typeof net>, store: unknown = null, at = T0) =>
  vendor.resolveLatest("llama.cpp", sources(), {
    fetchImpl: n.fetchImpl,
    store,
    now: () => at,
    force: true,
  });
const memoryStore = () => vendor.createFeedStore({ file: "" });

describe("github-list: the newest bNNNN release that has the Windows CPU zip and its digest", () => {
  it("v1.1.0 (source only) on top and b12774 with the zip below resolves b12774", async () => {
    const n = net({ list: [sourceOnly, release("b12774", [zip("b12774")])] });
    const out = await resolve(n);
    expect(out).toMatchObject({ ok: true, version: "12774", tag: "b12774", source: "github-list" });
    expect(out.pinned).toBe(false);
    const hit = out.assets.find((a: { name: string }) => /win-cpu-x64\.zip$/.test(a.name));
    expect(hit.sha256).toBe(sha("llama-b12774-bin-win-cpu-x64.zip"));
    expect(n.calls[0]).toBe("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15");
  });

  it("the resolved release plans a CPU install with that digest (no pin used)", async () => {
    const n = net({ list: [sourceOnly, release("b12774", [zip("b12774")])] });
    const answer = await resolve(n);
    const rel = engines.releaseForInstall(spec(), answer);
    expect(rel).toMatchObject({ ok: true, usedPin: false, tag: "b12774", version: "12774" });
    const planned = spec().plan({ backend: "cpu", variant: "avx2" }, rel.assets);
    expect(planned).toMatchObject({ ok: true });
    expect(planned.zips[0].sha256).toBe(sha("llama-b12774-bin-win-cpu-x64.zip"));
  });

  it("a release whose zip has no digest is refused; the next older release with a digest wins", async () => {
    const n = net({
      list: [
        sourceOnly,
        release("b12800", [zip("b12800", "cpu-x64", false)]),
        release("b12774", [zip("b12774")]),
      ],
    });
    expect(await resolve(n)).toMatchObject({ ok: true, tag: "b12774", source: "github-list" });
  });

  it("drafts, pre-releases and tags that are not bNNNN are never taken", async () => {
    const n = net({
      list: [
        release("b12900", [zip("b12900")], { draft: true }),
        release("b12890", [zip("b12890")], { prerelease: true }),
        release("b12880-rc1", [zip("b12880-rc1")]),
        release("b12774", [zip("b12774")]),
      ],
    });
    expect(await resolve(n)).toMatchObject({ ok: true, tag: "b12774" });
  });

  it("nothing in the list has a digest and the atom names a tag the pin has no digest for: the pin is used", async () => {
    const n = net({
      list: [sourceOnly, release("b12774", [zip("b12774", "cpu-x64", false)])],
      atom: atom("v1.1.0", "b12774", "b12700"),
    });
    const out = await resolve(n);
    expect(out).toMatchObject({ ok: true, pinned: true, source: "pinned" });
    expect(out.tag).toBe(spec().pinned.tag);
    expect(out.attempts.map((a: { source: string; ok: boolean }) => [a.source, a.ok])).toEqual([
      ["github-list", false],
      ["github-atom", false],
    ]);
  });
});

describe("the atom feed carries no digest: used only where the pin holds one for that tag", () => {
  it("an atom-only newer tag (no digest) fails closed to the pin", async () => {
    const out = await resolve(net({ atom: atom("v1.1.0", "b12774") }));
    expect(out).toMatchObject({ ok: true, pinned: true, tag: spec().pinned.tag });
    const attempt = out.attempts.find((a: { source: string }) => a.source === "github-atom");
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toMatch(/SHA-256/);
  });

  it("an atom answer for the pinned tag takes the pinned digest, the semver tag above it is skipped", async () => {
    const pin = spec().pinned;
    const out = await resolve(net({ atom: atom("v1.1.0", pin.tag) }));
    expect(out).toMatchObject({ ok: true, source: "github-atom", tag: pin.tag });
    expect(out.assets).toEqual(pin.assets);
    expect(out.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the chain is github-list, github-atom (bNNNN only), then the pin", () => {
    expect(sources().map((s: { kind: string }) => s.kind)).toEqual([
      "github-list",
      "github-atom",
      "pinned",
    ]);
    const [list, feed] = sources();
    expect(list).toMatchObject({ repo: "ggml-org/llama.cpp", tagPattern: "^b\\d+$" });
    expect(new RegExp(list.assetPattern).test("llama-b1-bin-win-cpu-x64.zip")).toBe(true);
    expect(feed).toMatchObject({ tagPattern: "^b\\d+$", requireDigest: true });
  });
});

describe("weekly cadence: a newer tag is adopted at most once a week", () => {
  it("a newer tag seen inside the week is held back, then adopted after seven days", async () => {
    const store = memoryStore();
    const first = await resolve(net({ list: [release("b12774", [zip("b12774")])] }), store, T0);
    expect(first.tag).toBe("b12774");
    const newer = net({
      list: [release("b12800", [zip("b12800")]), release("b12774", [zip("b12774")])],
    });
    const early = await resolve(newer, store, T0 + 2 * DAY);
    expect(early).toMatchObject({ ok: true, tag: "b12774", held: "b12800" });
    const late = await resolve(newer, store, T0 + 7 * DAY + 1);
    expect(late).toMatchObject({ ok: true, tag: "b12800" });
    expect(late.held).toBeUndefined();
  });

  it("three resolves in one week cause one download", async () => {
    const store = memoryStore();
    const downloads: string[] = [];
    const deps = {
      download: async (url: string, dest: string) => {
        const name = decodeURIComponent(url.split("/").pop()!);
        downloads.push(name);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, name);
      },
      extract: async (_z: string, dest: string) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, SERVER), "server");
        return { ok: true };
      },
      health: async () => ({ ok: true }),
      diskFree: () => 50 * 1024 ** 3,
      now: () => T0,
    };
    const facts = {
      ramGb: 16,
      gpus: [],
      gpuVendor: null,
      vramFreeGb: null,
      cudaReady: false,
      vulkan: false,
      cpu: { avx2: true, avx512: false },
      cuda: { driverCuda: null },
    };
    const lists = [
      [release("b12774", [zip("b12774")])],
      [release("b12800", [zip("b12800")]), release("b12774", [zip("b12774")])],
      [release("b12830", [zip("b12830")]), release("b12800", [zip("b12800")])],
    ];
    const dir = mkdtempSync(path.join(tmpdir(), "friday-latest-"));
    try {
      const outs = [];
      for (const [i, list] of lists.entries()) {
        const answer = await resolve(net({ list }), store, T0 + i * 2 * DAY);
        outs.push(
          await engines.installEngine(
            dir,
            spec(),
            { release: engines.releaseForInstall(spec(), answer), facts },
            deps,
          ),
        );
      }
      expect(outs.map((o) => o.ok)).toEqual([true, true, true]);
      expect(outs.map((o) => o.tag)).toEqual(["b12774", "b12774", "b12774"]);
      expect(outs.map((o) => Boolean(o.reused))).toEqual([false, true, true]);
      expect(downloads).toEqual(["llama-b12774-bin-win-cpu-x64.zip"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reuse: an install that is current and healthy is never downloaded again", () => {
  const facts = {
    ramGb: 16,
    gpus: [],
    gpuVendor: null,
    vramFreeGb: null,
    cudaReady: false,
    vulkan: false,
    cpu: { avx2: true, avx512: false },
    cuda: { driverCuda: null },
  };
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-reuse-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (log: string[], healthy = true) => ({
    download: async (url: string, dest: string) => {
      const name = decodeURIComponent(url.split("/").pop()!);
      log.push(name);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, name);
    },
    extract: async (_z: string, to: string) => {
      mkdirSync(to, { recursive: true });
      writeFileSync(path.join(to, SERVER), "server");
      return { ok: true };
    },
    health: async () => (healthy ? { ok: true } : { ok: false, reason: "it did not start" }),
    diskFree: () => 50 * 1024 ** 3,
    now: () => T0,
  });
  const rel = (tag: string) => ({
    ok: true,
    version: tag.replace(/^b/, ""),
    tag,
    source: "github-list",
    assets: [zip(tag)].map((a) => ({
      name: a.name,
      url: `https://x/${a.name}`,
      bytes: 10,
      sha256: sha(a.name),
    })),
  });

  it("the same or an older release is reused; a newer one installs", async () => {
    const log: string[] = [];
    await engines.installEngine(dir, spec(), { release: rel("b12774"), facts }, deps(log));
    const same = await engines.installEngine(
      dir,
      spec(),
      { release: rel("b12774"), facts },
      deps(log),
    );
    const older = await engines.installEngine(
      dir,
      spec(),
      { release: rel("b12000"), facts },
      deps(log),
    );
    expect(same).toMatchObject({ ok: true, reused: true, tag: "b12774" });
    expect(older).toMatchObject({ ok: true, reused: true, tag: "b12774" });
    expect(log).toHaveLength(1);
    const newer = await engines.installEngine(
      dir,
      spec(),
      { release: rel("b12800"), facts },
      deps(log),
    );
    expect(newer).toMatchObject({ ok: true, tag: "b12800" });
    expect(newer.reused).toBeFalsy();
    expect(log).toHaveLength(2);
  });

  it("an install that no longer starts is not reused: the zip is fetched again", async () => {
    const log: string[] = [];
    await engines.installEngine(dir, spec(), { release: rel("b12774"), facts }, deps(log));
    const sick = deps(log);
    let calls = 0;
    sick.health = async () => (++calls === 1 ? { ok: false, reason: "dll missing" } : { ok: true });
    const out = await engines.installEngine(dir, spec(), { release: rel("b12774"), facts }, sick);
    expect(out.ok).toBe(true);
    expect(out.reused).toBeFalsy();
    expect(log).toHaveLength(2);
  });

  it("a marker flagged unhealthy is never reused", async () => {
    const log: string[] = [];
    const first = await engines.installEngine(
      dir,
      spec(),
      { release: rel("b12774"), facts },
      deps(log),
    );
    const markerFile = path.join(path.dirname(first.bin), engines.MARKER);
    const marker = JSON.parse(readFileSync(markerFile, "utf8"));
    writeFileSync(markerFile, JSON.stringify({ ...marker, healthy: false }));
    const again = await engines.installEngine(
      dir,
      spec(),
      { release: rel("b12774"), facts },
      deps(log),
    );
    expect(again.reused).toBeFalsy();
    expect(log).toHaveLength(2);
  });
});

describe("offline and privacy keep the cache", () => {
  it("every source down after one good answer: the stored release is served, marked stale, with its digest", async () => {
    const store = memoryStore();
    await resolve(net({ list: [sourceOnly, release("b12774", [zip("b12774")])] }), store, T0);
    const out = await resolve(net({ down: true }), store, T0 + 3 * DAY);
    expect(out).toMatchObject({ ok: true, tag: "b12774", stale: true, via: "cache" });
    expect(out.assets.find((a: { name: string }) => /cpu-x64\.zip$/.test(a.name)).sha256).toBe(
      sha("llama-b12774-bin-win-cpu-x64.zip"),
    );
  });

  it("the refresh plan still holds the cache in privacy mode and offline", () => {
    expect(vendor.planFeedRefresh({ privacy: true }).refresh).toBe(false);
    expect(vendor.planFeedRefresh({ online: false }).refresh).toBe(false);
  });
});
