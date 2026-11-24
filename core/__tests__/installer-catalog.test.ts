/**
 * The Install Manager catalogue: every row with its fit, installed and latest version, update status and the source
 * that answered; quick (never the network on the read path), stale-while-revalidate, rate limited, and an update only
 * ever starts with the owner's consent or Full autonomy. Fake rows, fake feeds and a throwaway folder.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const cat = require_(path.join(root, "electron/installer-catalog.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-catalog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clock = (start = 1_800_000_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status < 400,
  status,
  url: "",
  headers: new Headers(headers),
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
function feeds(routes: Record<string, unknown>) {
  const hits: string[] = [];
  const fetchImpl = async (url: string) => {
    hits.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error("network down");
    const v = routes[key];
    return typeof v === "function" ? (v as () => unknown)() : reply(v);
  };
  return { fetchImpl, hits };
}

const FACTS_NO_GPU = {
  ramGb: 16,
  ramFreeGb: 10,
  gpus: [],
  sources: ["os-memory"],
  os: { is64Bit: true },
  cpu: { avx2: true },
  modelDrive: { freeGb: 100 },
  cuda: {},
  network: { online: true, metered: false },
  power: { onAc: true },
  vulkan: false,
};

const TOOLS = [
  { id: "ripgrep", category: "Dev", latest: { kind: "github", ref: "BurntSushi/ripgrep" } },
  { id: "uv (Python)", category: "Dev", latest: { kind: "pypi", ref: "uv" } },
  { id: "Docker", category: "Dev" }, // no source: unknown
  { id: "alias", aliasOf: "ripgrep" },
];
function build(over: Record<string, unknown> = {}) {
  const c = clock();
  const net = feeds({
    "https://api.github.com/repos/BurntSushi/ripgrep": { tag_name: "14.2.0", assets: [] },
    "https://pypi.org/pypi/uv/json": { info: { version: "0.9.0" }, releases: {} },
  });
  const lanes: string[] = [];
  const catalog = cat.createInstallerCatalog({
    root: () => dir,
    facts: () => FACTS_NO_GPU,
    tools: () => TOOLS,
    detected: () => ({
      tools: [
        { id: "ripgrep", installed: true, version: "14.1.0" },
        { id: "uv (Python)", installed: true, version: "0.9.0" },
        { id: "Docker", installed: false },
      ],
    }),
    packs: () => [],
    voice: () => [],
    runners: () => [],
    fetchImpl: net.fetchImpl,
    now: c.now,
    run: (kind: string, fn: () => unknown) => (lanes.push(kind), fn()),
    privacy: () => false,
    online: () => true,
    ...over,
  });
  return { catalog, net, c, lanes };
}
type Row = {
  id: string;
  fit: { state: string; alternative?: string };
  error?: string;
  updateStatus: string;
  latestVersion: string | null;
  engine: { chain: string[] };
  pinnedAnswer: boolean;
};
const row = (snap: { rows: { id: string }[] }, id: string) =>
  snap.rows.find((r) => r.id === id) as unknown as Row;

describe("updateStatusOf", () => {
  it("current, update, unknown and error", () => {
    const s = cat.updateStatusOf;
    expect(
      s({ installed: true, installedVersion: "1.0.0", latest: { ok: true, version: "1.1.0" } }),
    ).toBe("update");
    expect(
      s({ installed: true, installedVersion: "1.1.0", latest: { ok: true, version: "1.1.0" } }),
    ).toBe("current");
    expect(
      s({ installed: true, installedVersion: "2.0.0", latest: { ok: true, version: "1.1.0" } }),
    ).toBe("current");
    expect(
      s({ installed: false, installedVersion: null, latest: { ok: true, version: "1.1.0" } }),
    ).toBe("unknown");
    expect(
      s({ installed: null, installedVersion: null, latest: { ok: true, version: "1.1.0" } }),
    ).toBe("unknown");
    expect(
      s({ installed: true, installedVersion: null, latest: { ok: true, version: "1.1.0" } }),
    ).toBe("unknown");
    expect(s({ installed: true, installedVersion: "1", latest: null })).toBe("unknown");
    expect(s({ installed: true, installedVersion: "1", latest: { ok: false, error: "x" } })).toBe(
      "error",
    );
  });
  it("a pinned answer can prove an update but never 'current'; revisions compare by equality", () => {
    const s = cat.updateStatusOf;
    expect(
      s({
        installed: true,
        installedVersion: "1.0",
        latest: { ok: true, version: "1.2", pinned: true },
      }),
    ).toBe("update");
    expect(
      s({
        installed: true,
        installedVersion: "1.2",
        latest: { ok: true, version: "1.2", pinned: true },
      }),
    ).toBe("unknown");
    expect(
      s({
        installed: true,
        installedVersion: "abc",
        latest: { ok: true, version: "abc" },
        byRevision: true,
      }),
    ).toBe("current");
    expect(
      s({
        installed: true,
        installedVersion: "abc",
        latest: { ok: true, version: "def" },
        byRevision: true,
      }),
    ).toBe("update");
  });
});

describe("planUpdate: never silent", () => {
  const updateRow = { id: "x", updateStatus: "update", fit: { state: "supported" } };
  it("Ask and Balanced need this update's consent; Full may go ahead; consent always counts", () => {
    expect(cat.planUpdate({ row: updateRow, autonomy: "ask" })).toMatchObject({
      allowed: false,
      needsConsent: true,
    });
    expect(cat.planUpdate({ row: updateRow, autonomy: "balanced" })).toMatchObject({
      allowed: false,
      needsConsent: true,
    });
    expect(cat.planUpdate({ row: updateRow, autonomy: "full" })).toMatchObject({
      allowed: true,
      via: "full-autonomy",
    });
    expect(
      cat.planUpdate({ row: updateRow, autonomy: "ask", consent: { granted: true } }),
    ).toMatchObject({ allowed: true, via: "consent" });
    expect(
      cat.planUpdate({ row: updateRow, autonomy: "ask", consent: { granted: "yes" } }).allowed,
    ).toBe(false);
    expect(cat.planUpdate({ row: updateRow })).toMatchObject({
      allowed: false,
      needsConsent: true,
    }); // no dial reads as Ask
    expect(cat.planUpdate({ row: updateRow, autonomy: "nonsense" }).needsConsent).toBe(true);
  });
  it("no update, an unsupported PC or an unknown row is refused outright", () => {
    expect(
      cat.planUpdate({ row: { ...updateRow, updateStatus: "current" }, autonomy: "full" }).allowed,
    ).toBe(false);
    expect(
      cat.planUpdate({ row: { ...updateRow, fit: { state: "unsupported" } }, autonomy: "full" })
        .allowed,
    ).toBe(false);
    expect(cat.planUpdate({}).allowed).toBe(false);
  });
});

describe("snapshot is quick and never touches the network", () => {
  it("rows carry fit, installed, latest and status; with no answer yet the status is unknown", () => {
    const { catalog, net } = build();
    const snap = catalog.snapshot();
    expect(net.hits).toEqual([]);
    expect(snap.rows.map((r: { id: string }) => r.id)).toEqual([
      "ripgrep",
      "uv (Python)",
      "Docker",
    ]);
    expect(row(snap, "ripgrep")).toMatchObject({
      installed: true,
      installedVersion: "14.1.0",
      latestVersion: null,
      updateStatus: "unknown",
      source: null,
    });
    expect(row(snap, "ripgrep").fit.state).toBe("supported");
    expect(snap.split.supported).toEqual(["ripgrep", "uv (Python)", "Docker"]);
    expect(snap.hardwareKnown).toBe(true);
  });
});

describe("refresh: the ordered chain, the store and the status transitions", () => {
  it("asks each row's sources through the governor's download lane and then the snapshot shows update / current", async () => {
    const { catalog, lanes, c } = build();
    const out = await catalog.refresh({ trigger: "startup" });
    expect(out).toMatchObject({ refreshed: true, ok: 2, total: 2 });
    expect(lanes).toEqual(["download", "download"]);
    const snap = catalog.snapshot();
    expect(row(snap, "ripgrep")).toMatchObject({
      latestVersion: "14.2.0",
      updateStatus: "update",
      source: "github-api",
      stale: false,
      checkedAt: c.now(),
    });
    expect(row(snap, "uv (Python)")).toMatchObject({
      latestVersion: "0.9.0",
      updateStatus: "current",
      source: "pypi-json",
    });
    expect(row(snap, "Docker")).toMatchObject({ updateStatus: "unknown", latestVersion: null });
    expect(snap.counts).toMatchObject({ updates: 1 });
  });

  it("a row whose sources all fail reads as error; the others are unaffected; a later good answer clears it", async () => {
    let up = false;
    const c = clock();
    const net = feeds({
      "https://api.github.com/": () =>
        up ? reply({ tag_name: "14.2.0", assets: [] }) : reply({}, 500),
      "https://github.com/BurntSushi/ripgrep/releases.atom": () => reply({}, 500),
      "https://pypi.org/pypi/uv/json": { info: { version: "0.9.0" }, releases: {} },
    });
    const { catalog } = build({ fetchImpl: net.fetchImpl, now: c.now });
    await catalog.refresh({ trigger: "startup" });
    let snap = catalog.snapshot();
    expect(row(snap, "ripgrep")).toMatchObject({ updateStatus: "error" });
    expect(row(snap, "ripgrep").error).toMatch(/no official source/);
    expect(row(snap, "uv (Python)").updateStatus).toBe("current");
    up = true;
    c.advance(61_000);
    await catalog.refresh({ trigger: "manual" });
    snap = catalog.snapshot();
    expect(row(snap, "ripgrep")).toMatchObject({ updateStatus: "update", latestVersion: "14.2.0" });
    expect(row(snap, "ripgrep").error).toBeUndefined();
  });

  it("offline after a good answer: the cached version stays, marked stale, with its source and time", async () => {
    const c = clock();
    const { catalog } = build({ now: c.now });
    await catalog.refresh({ trigger: "startup" });
    const checked = c.now();
    c.advance(3 * 24 * 3600_000);
    const down = feeds({});
    const { catalog: later } = build({
      now: c.now,
      fetchImpl: down.fetchImpl,
      store: vendor.storeFor(dir),
    });
    await later.refresh({ trigger: "interval" });
    const snap = later.snapshot();
    expect(row(snap, "ripgrep")).toMatchObject({
      latestVersion: "14.2.0",
      stale: true,
      source: "github-api",
      checkedAt: checked,
      updateStatus: "update",
    });
    expect(snap.counts.stale).toBe(2);
  });

  it("the cache is written to the data root and a new catalogue reads it without the network", async () => {
    const c = clock();
    const { catalog } = build({ now: c.now });
    await catalog.refresh({ trigger: "startup" });
    expect(
      JSON.parse(readFileSync(path.join(dir, "cache", "vendor-feeds.json"), "utf8")).rows,
    ).toHaveProperty("ripgrep");
    const fresh = vendor.createFeedStore({ file: path.join(dir, "cache", "vendor-feeds.json") });
    const { catalog: again, net } = build({ now: c.now, store: fresh });
    expect(row(again.snapshot(), "ripgrep").latestVersion).toBe("14.2.0");
    expect(net.hits).toEqual([]);
  });

  it("daily: a second startup inside 24 h does not ask again; privacy and offline never ask; manual is rate limited", async () => {
    const c = clock();
    const { catalog, net } = build({ now: c.now });
    await catalog.refresh({ trigger: "startup" });
    const asked = net.hits.length;
    expect(await catalog.refresh({ trigger: "startup" })).toMatchObject({ refreshed: false });
    expect(net.hits.length).toBe(asked);
    expect(catalog.snapshot().nextManualRefreshInMs).toBe(0);
    const manual = await catalog.refresh({ trigger: "manual" });
    expect(manual.refreshed).toBe(true);
    expect(catalog.snapshot().nextManualRefreshInMs).toBeGreaterThan(0);
    const again = await catalog.refresh({ trigger: "manual" });
    expect(again).toMatchObject({ refreshed: false });
    expect(again.retryInMs).toBeGreaterThan(0);
    c.advance(61_000);
    expect((await catalog.refresh({ trigger: "manual" })).refreshed).toBe(true);

    const priv = build({ privacy: () => true });
    expect((await priv.catalog.refresh({ trigger: "startup" })).refreshed).toBe(false);
    const off = build({ online: () => false });
    expect((await off.catalog.refresh({ trigger: "startup" })).refreshed).toBe(false);
    expect(priv.net.hits).toEqual([]);
    expect(off.net.hits).toEqual([]);
  });

  it("two refreshes at once run once", async () => {
    const { catalog, net } = build();
    const a = catalog.refresh({ trigger: "startup" });
    const b = await catalog.refresh({ trigger: "startup" });
    expect(b).toMatchObject({ refreshed: false, running: true });
    await a;
    expect(net.hits.length).toBe(2);
  });

  it("catalog() answers at once and starts the refresh in the background when the cache is old", async () => {
    const { catalog, net } = build();
    const snap = catalog.catalog();
    expect(snap.rows).toHaveLength(3);
    expect(row(snap, "ripgrep").latestVersion).toBeNull(); // nothing awaited
    for (let i = 0; i < 50 && catalog.status().refreshing !== false; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    expect(net.hits.length).toBe(2);
    expect(row(catalog.snapshot(), "ripgrep").latestVersion).toBe("14.2.0");
    const noBg = build();
    noBg.catalog.catalog({ background: false });
    expect(noBg.net.hits).toEqual([]);
  });

  describe("a row whose sources keep failing", () => {
    const settle = async (catalog: ReturnType<typeof build>["catalog"]) => {
      for (let i = 0; i < 50 && catalog.status().refreshing; i += 1)
        await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 5));
    };
    /** uv answers once, then every source for it fails while ripgrep keeps answering. */
    function failingUv() {
      const down = { uv: false };
      const hits: string[] = [];
      const net = {
        hits,
        fetchImpl: async (url: string) => {
          hits.push(url);
          if (url.startsWith("https://api.github.com/repos/BurntSushi/ripgrep"))
            return reply({ tag_name: "14.2.0", assets: [] });
          if (url.startsWith("https://pypi.org/pypi/uv/json")) {
            if (down.uv) throw new Error("network down");
            return reply({ info: { version: "0.9.0" }, releases: {} });
          }
          throw new Error("network down");
        },
      };
      const built = build({ fetchImpl: net.fetchImpl });
      return { ...built, net, down };
    }
    const day = 24 * 60 * 60 * 1000;

    it("does not start a pass on every catalogue read, and backs off up to the daily interval", async () => {
      const { catalog, net, c, down } = failingUv();
      await catalog.refresh({ trigger: "startup" });
      expect(net.hits.length).toBe(2);
      // A day later uv's sources are down: its row stays old while ripgrep's is fresh.
      c.advance(day + 1000);
      down.uv = true;
      catalog.catalog();
      await settle(catalog);
      const afterFirst = net.hits.length;
      expect(afterFirst).toBeGreaterThan(2);
      // Ten catalogue reads in a row (the page opening, a poll) must not each start a pass.
      for (let i = 0; i < 10; i += 1) {
        catalog.catalog();
        await settle(catalog);
      }
      expect(net.hits.length).toBe(afterFirst);
      // The wait grows: after a few minutes one more try is allowed, then the next waits longer.
      c.advance(6 * 60 * 1000);
      catalog.catalog();
      await settle(catalog);
      const afterSecond = net.hits.length;
      expect(afterSecond).toBeGreaterThan(afterFirst);
      c.advance(6 * 60 * 1000);
      catalog.catalog();
      await settle(catalog);
      expect(net.hits.length).toBe(afterSecond); // the second wait is longer than the first
      // It is capped at the daily interval, and the owner's refresh button is never held back.
      c.advance(day);
      catalog.catalog();
      await settle(catalog);
      expect(net.hits.length).toBeGreaterThan(afterSecond);
      const before = net.hits.length;
      await catalog.refresh({ trigger: "manual" });
      expect(net.hits.length).toBeGreaterThan(before);
    });

    it("a pass that works again clears the wait", async () => {
      const { catalog, net, c, down } = failingUv();
      await catalog.refresh({ trigger: "startup" });
      c.advance(day + 1000);
      down.uv = true;
      catalog.catalog();
      await settle(catalog);
      down.uv = false;
      c.advance(6 * 60 * 1000);
      catalog.catalog();
      await settle(catalog);
      const healthy = net.hits.length;
      c.advance(60 * 60 * 1000);
      catalog.catalog(); // fresh now: nothing to ask
      await settle(catalog);
      expect(net.hits.length).toBe(healthy);
      expect(catalog.status().failedPasses).toBe(0);
    });

    it("a first run with every source down does not retry on each read either", async () => {
      const { catalog, net } = build({
        fetchImpl: async (url: string) => {
          net.hits.push(url);
          throw new Error("network down");
        },
      }) as ReturnType<typeof build> & { net: { hits: string[] } };
      catalog.catalog();
      await settle(catalog);
      const first = net.hits.length;
      for (let i = 0; i < 5; i += 1) {
        catalog.catalog();
        await settle(catalog);
      }
      expect(net.hits.length).toBe(first);
    });
  });

  it("a refresh never installs anything: no job runner is reachable from the catalogue", () => {
    const src = readFileSync(path.join(root, "electron/installer-catalog.cjs"), "utf8");
    expect(src).not.toMatch(/runJob|runEngineJob|spawn\(|execFile\(/);
  });
});

describe("the real catalogue", () => {
  it("lists tools, engines and voice models with unique ids, a fit and a valid status on a PC with no GPU", () => {
    const catalog = cat.createInstallerCatalog({
      root: () => dir,
      facts: () => FACTS_NO_GPU,
      tools: () => toolchain.TOOLS,
      detected: () => ({ tools: [] }),
      packs: () => require_(path.join(root, "electron/toolchain-pack.cjs")).readManifest().packs,
      runners: () =>
        JSON.parse(readFileSync(path.join(root, "config/local-runners.json"), "utf8")).runners,
      online: () => true,
      privacy: () => true,
    });
    const snap = catalog.snapshot();
    const ids = snap.rows.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of snap.rows) {
      expect(cat.UPDATE_STATUSES).toContain(r.updateStatus);
      expect(["supported", "limited", "unsupported"]).toContain(r.fit.state);
    }
    const kinds = new Set(snap.rows.map((r: { kind: string }) => r.kind));
    for (const k of ["tool", "engine", "runtime-pack", "voice-model", "model"])
      expect(kinds.has(k)).toBe(true);
    expect(row(snap, "CUDA runtime libraries").fit.state).toBe("unsupported");
    expect(row(snap, "ONNX Runtime (GPU)").fit.alternative).toBe("ONNX Runtime (DirectML)");
    expect(row(snap, "ONNX Runtime (DirectML)").fit.state).toBe("unsupported"); // no GPU at all
    expect(row(snap, "llama.cpp").engine.chain).toEqual(["cpu"]);
    expect(row(snap, "llama.cpp").latestVersion).toMatch(/^\d+$/); // the pin, until a source answers
    expect(row(snap, "llama.cpp").pinnedAnswer).toBe(true);
    expect(snap.split.unsupported).toContain("CUDA runtime libraries");
    const voice = row(snap, "voice:supertonic-3");
    expect(voice).toMatchObject({ kind: "voice-model", installed: false, updateStatus: "unknown" });
    expect(voice.latestVersion).toMatch(/^[0-9a-f]{40}$/); // the pinned revision FRIDAY would install
    expect(voice.fit.state).toBe("supported");
    expect(snap.doctor.find((d: { id: string }) => d.id === "cuda-libs")).toMatchObject({
      status: "skip",
      repair: null,
    });
  });

  it("the new rows exist and carry the pins and requirements the roadmap asked for", () => {
    const by = (id: string) => toolchain.TOOLS.find((t: { id: string }) => t.id === id);
    expect(by("CUDA runtime libraries")).toMatchObject({
      pipBundle: "cuda-libs",
      requirements: { gpu: "nvidia", cudaMin: "12" },
    });
    expect(by("ONNX Runtime (GPU)").pipBundle).toBe("ort-gpu");
    expect(by("ONNX Runtime (DirectML)").pipBundle).toBe("ort-directml");
    expect(by("ONNX Runtime").pipBundle).toBe("ort-cpu");
    expect(by("llama.cpp").engine).toBe("llama.cpp");
    expect(by("FFmpeg (LGPL, portable)").engine).toBe("FFmpeg (LGPL, portable)");
    expect(by("stable-diffusion.cpp").engine).toBe("stable-diffusion.cpp");
    // no two ONNX Runtime variants may be installed together: each bundle lists the other two as conflicts
    for (const [key, others] of [
      ["ort-cpu", ["onnxruntime-directml", "onnxruntime-gpu"]],
      ["ort-directml", ["onnxruntime", "onnxruntime-gpu"]],
      ["ort-gpu", ["onnxruntime", "onnxruntime-directml"]],
    ] as const) {
      expect([...engines.PIP_BUNDLES[key].conflicts].sort()).toEqual([...others].sort());
    }
    expect(engines.PIP_BUNDLES["cuda-libs"].parts.map((p: { dist: string }) => p.dist)).toEqual([
      "nvidia-cublas-cu12",
      "nvidia-cudnn-cu12",
    ]);
    expect(engines.PIP_BUNDLES["cuda-libs"].verifyImport).toMatch(/nvidia\.cublas/); // where kernel/stt.py looks
  });
});

describe("llamaCppStrategy follows the facts", () => {
  const python = { exe: "python", prefix: [] as string[] };
  const mk = (smi: string, cap: string, facts: unknown) => ({
    resolvePython: async () => python,
    ensureManagedPython: async () => null,
    facts,
    run: async (cmd: string, args: string[]) => {
      if (cmd === "nvidia-smi") return args.join(" ").includes("compute_cap") ? cap : smi;
      return "3.12";
    },
  });
  const nv = (vram: number, level = "12.9") => ({
    gpus: [{ vendor: "nvidia", vramGb: vram, vramCapped: false }],
    gpuVendor: "nvidia",
    vramFreeGb: vram - 0.5,
    cudaReady: true,
    cuda: { driverCuda: level },
    sources: ["nvidia-smi"],
  });
  it("CUDA wheel only for a card the CUDA 12 build supports; the CPU wheel, with the reason, otherwise", async () => {
    const good = await toolchain.llamaCppStrategy(mk("RTX, 576.80", "8.6", nv(8)));
    expect(good).toMatchObject({ ok: true, backend: "cuda", fallback: "cpu" });
    expect(good.extraIndex).toMatch(/cu124$/);
    const old = await toolchain.llamaCppStrategy(mk("card, 391.0", "6.1", nv(8)));
    expect(old).toMatchObject({ ok: true, backend: "cpu" });
    expect(old.note).toMatch(/6\.1/);
    expect(old.extraIndex).toBeUndefined();
    const small = await toolchain.llamaCppStrategy(mk("card, 576", "8.6", nv(2)));
    expect(small.backend).toBe("cpu");
    const none = await toolchain.llamaCppStrategy(mk("", "", { gpus: [], sources: ["os-memory"] }));
    expect(none).toMatchObject({ ok: true, backend: "cpu" });
    expect(none.note).toMatch(/no NVIDIA GPU detected/);
    const older = await toolchain.llamaCppStrategy(mk("card, 560", "8.6", nv(8, "12.2")));
    expect(older.extraIndex).toMatch(/cu121$/);
  });
  it("without facts the old rule holds, with the compute-capability guard", async () => {
    expect((await toolchain.llamaCppStrategy(mk("RTX, 576", "", null))).backend).toBe("cuda");
    expect((await toolchain.llamaCppStrategy(mk("GTX, 391", "6.1", null))).backend).toBe("cpu");
    expect((await toolchain.llamaCppStrategy(mk("", "", null))).backend).toBe("cpu");
  });
  it("a Python that cannot run it is still refused with its own words", async () => {
    const out = await toolchain.llamaCppStrategy({
      ...mk("", "", null),
      resolvePython: async () => null,
    });
    expect(out.ok).toBe(false);
  });
});
