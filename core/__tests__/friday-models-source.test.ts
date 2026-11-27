/**
 * The download chain of a pinned voice model: the FRIDAY Models release first, the official upstream source behind it.
 * A fake fetch stands in for GitHub and Hugging Face (no network, no clock): the release serves the pinned bytes, is
 * missing (404), serves wrong bytes, serves a split file in parts; a model the manifest does not hold keeps today's chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const download = require_("../../electron/model-download.cjs");
const weights = require_("../../electron/voice-weights.cjs");
const pins = require_("../../electron/voice-pins.cjs");
const pack = require_("../../scripts/build-friday-models.cjs");
const catalog = require_("../../electron/installer-catalog.cjs");
const sync = require_("../../electron/github-sync.cjs");

type Pin = { revision: string; files: Record<string, { sha256: string; bytes: number }> };
type Asset = {
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  parts: number;
  from: { pin: string; recipe: string; [key: string]: unknown };
  [key: string]: unknown;
};
type Manifest = {
  pack: string;
  tag: string;
  repository: string;
  partBytes: number;
  assets: Asset[];
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const REPO = "test/pinned-release";
const TAG = "friday-models-2026.1.1";
const BASE = `https://github.com/o/r/releases/download/${TAG}/`;

const FILES: Record<string, string> = {
  "config.json": "{}",
  "model.bin": "0123456789",
  "onnx/head.onnx": "head",
};
const PIN: Pin = {
  revision: "c".repeat(40),
  files: Object.fromEntries(
    Object.entries(FILES).map(([name, text]) => [name, { sha256: sha(text), bytes: text.length }]),
  ),
};

function assetsFor(partBytes: number, only: string[] = Object.keys(FILES)): Asset[] {
  return only.map((name) => {
    const text = FILES[name]!;
    return {
      fridayId: "friday-test",
      fridayName: "FRIDAY Test",
      path: name,
      file: `friday-test--${name.replace(/\//g, "-")}`,
      sha256: sha(text),
      bytes: text.length,
      parts: Math.max(1, Math.ceil(text.length / partBytes)),
      from: { pin: REPO, file: name, recipe: "copy", recipeVersion: 1 },
    };
  });
}

function manifest(partBytes = 1_900_000_000, assets = assetsFor(partBytes)): Manifest {
  return {
    pack: "friday-models",
    tag: TAG,
    repository: "o/r",
    partBytes,
    assets,
  };
}

const deps = (extra: Record<string, unknown> = {}) => ({
  pinForRepo: (name: string) => (name === REPO ? PIN : null),
  hub: { engineMode: () => "own", isBroken: () => false },
  env: {},
  ...extra,
});

/** What the fake GitHub release holds: file name (parts included) to bytes. `null` is a release that is not published. */
type Release = Record<string, string> | null;

function network(release: Release, upstream: Record<string, string> = FILES) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: { method?: string } = {}) => {
      const url = String(input);
      urls.push(url);
      const reply = (text: string | undefined) =>
        text === undefined
          ? new Response(null, { status: 404 })
          : new Response(init.method === "HEAD" ? null : text, {
              status: 200,
              headers: { "content-length": String(Buffer.byteLength(text)) },
            });
      if (url.startsWith(BASE)) {
        return reply(release ? release[decodeURIComponent(url.slice(BASE.length))] : undefined);
      }
      if (url.includes("/api/models/")) {
        return new Response(
          JSON.stringify({ siblings: Object.keys(FILES).map((rfilename) => ({ rfilename })) }),
          { status: 200 },
        );
      }
      const name = decodeURIComponent(
        url.split("/resolve/")[1]!.split("/").slice(1).join("/").split("?")[0]!,
      );
      return reply(upstream[name]);
    }),
  );
  return {
    urls,
    release: () => urls.filter((url) => url.startsWith(BASE)),
    hugging: () => urls.filter((url) => url.includes("huggingface.co")),
  };
}

/** The release holds every file under its FRIDAY name. */
function wholeRelease(files: Record<string, string> = FILES): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [`friday-test--${name.replace(/\//g, "-")}`, text]),
  );
}

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-models-source-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (sources = [{ kind: "hf-repo", repo: REPO, label: "Hugging Face" }]) => ({
  modelId: "friday-test",
  dir,
  sources,
});
const folder = () => path.join(dir, "friday-test");
const read = (name: string) => fs.readFileSync(path.join(folder(), ...name.split("/")), "utf8");
const events: string[] = [];
const onEvent = (event: { status?: string }) => events.push(String(event?.status || ""));

describe("the release plan", () => {
  it("is built from the manifest only when every pinned file is held with the pin's own hash and size", () => {
    const plan = weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest() }));
    expect(plan.tag).toBe(TAG);
    expect(plan.files.map((file: { name: string }) => file.name)).toEqual(Object.keys(FILES));
    expect(plan.files[2].parts).toEqual([
      { file: "friday-test--onnx-head.onnx", url: `${BASE}friday-test--onnx-head.onnx`, bytes: 4 },
    ]);
    const short = assetsFor(1_900_000_000, ["config.json", "model.bin"]);
    expect(
      weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest(1e9, short) })),
    ).toBeNull();
    const wrong = assetsFor(1_900_000_000).map((asset) =>
      asset.path === "model.bin" ? { ...asset, sha256: sha("other") } : asset,
    );
    expect(
      weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest(1e9, wrong) })),
    ).toBeNull();
    const derived = assetsFor(1_900_000_000).map((asset) => ({
      ...asset,
      from: { ...asset.from, recipe: "int8-dynamic" },
    }));
    expect(
      weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest(1e9, derived) })),
    ).toBeNull();
    expect(weights.fridayReleasePlan(REPO, deps({ fridayModels: null }))).toBeNull();
    expect(weights.fridayReleasePlan("else/where", deps({ fridayModels: manifest() }))).toBeNull();
  });

  it("names the parts like the builder does and refuses a part count the bytes do not give", () => {
    const plan = weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest(4) }));
    const bin = plan.files.find((file: { name: string }) => file.name === "model.bin");
    const planned = pack.splitPlan(bin.file, bin.bytes, 4);
    expect(bin.parts.map((part: { file: string }) => part.file)).toEqual(
      planned.map((part: { file: string }) => part.file),
    );
    expect(bin.parts.map((part: { bytes: number }) => part.bytes)).toEqual(
      planned.map((part: { length: number }) => part.length),
    );
    const wrong = assetsFor(4).map((asset) =>
      asset.path === "model.bin" ? { ...asset, parts: 2 } : asset,
    );
    expect(weights.fridayReleasePlan(REPO, deps({ fridayModels: manifest(4, wrong) }))).toBeNull();
  });

  it("is off with FRIDAY_MODELS_RELEASE=0 and adds a source before the upstream one only when a plan exists", () => {
    const sources = [{ kind: "hf-repo", repo: REPO, label: "Hugging Face" }];
    const withPack = weights.withFridayRelease(sources, deps({ fridayModels: manifest() }));
    expect(withPack.map((source: { kind: string }) => source.kind)).toEqual([
      "friday-release",
      "hf-repo",
    ]);
    expect(withPack[0].label).toBe("FRIDAY release");
    expect(withPack[1]).toBe(sources[0]);
    const off = weights.withFridayRelease(
      sources,
      deps({ fridayModels: manifest(), env: { FRIDAY_MODELS_RELEASE: "0" } }),
    );
    expect(off).toEqual(sources);
    expect(weights.withFridayRelease(sources, deps({ fridayModels: null }))).toEqual(sources);
    const url = [{ kind: "url", url: "https://example.com/a.onnx", sha256: "a".repeat(64) }];
    expect(weights.withFridayRelease(url, deps({ fridayModels: manifest() }))).toEqual(url);
  });

  it("holds every pinned model of the real manifest, with real pins and the real tag", () => {
    const real = weights.readFridayModels();
    expect(real?.pack).toBe("friday-models");
    const repos = [
      ...new Set((real.assets as Asset[]).map((a) => (a.from as { pin: string }).pin)),
    ];
    expect(repos.length).toBeGreaterThanOrEqual(18);
    for (const repo of repos) {
      const plan = weights.fridayReleasePlan(repo, { env: {} });
      expect(plan, repo).not.toBeNull();
      expect(plan.tag).toBe(real.tag);
      expect(plan.files.length).toBe(Object.keys(pins.pinForRepo(repo).files).length);
      for (const file of plan.files) {
        expect(
          file.parts.every((part: { url: string }) =>
            part.url.startsWith(
              `https://github.com/${real.repository}/releases/download/${real.tag}/`,
            ),
          ),
        ).toBe(true);
      }
    }
  });
});

describe("a model the manifest holds is fetched from the FRIDAY release first", () => {
  it("takes every file from the release, verifies it, certifies the folder and says so", async () => {
    const net = network(wholeRelease());
    events.length = 0;
    const result = await download.downloadModel(
      job(),
      onEvent,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("friday-release");
    expect(result.servedFrom).toBe("FRIDAY release");
    expect(net.hugging()).toEqual([]);
    expect(net.release().length).toBeGreaterThanOrEqual(3);
    for (const [name, text] of Object.entries(FILES)) expect(read(name)).toBe(text);
    expect(pins.readMarker(folder())?.revision).toBe(PIN.revision);
    expect(weights.servedSource(folder(), PIN)).toBe("FRIDAY release");
    expect(events.join("\n")).toContain("source: FRIDAY release");
  });

  it("joins a split file from its parts and holds the whole file to the manifest hash and size", async () => {
    const parts = {
      "friday-test--model.bin.part001": "0123",
      "friday-test--model.bin.part002": "4567",
      "friday-test--model.bin.part003": "89",
    };
    const net = network({ ...wholeRelease(), "friday-test--model.bin": "", ...parts });
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest(4) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.servedFrom).toBe("FRIDAY release");
    expect(read("model.bin")).toBe("0123456789");
    expect(net.release().some((url) => url.endsWith("model.bin.part002"))).toBe(true);
    expect(net.release().some((url) => url.endsWith("model.bin"))).toBe(false);
    expect(net.hugging()).toEqual([]);
    // The staged parts and the join file are gone, and the pinned folder holds only the pinned files.
    expect(pins.unexpectedFiles(folder(), PIN)).toEqual([]);
    expect(fs.existsSync(path.join(folder(), ".cache", "friday-release"))).toBe(false);
    expect(fs.readdirSync(folder()).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("falls back to the official source when a part is wrong, and removes what it staged", async () => {
    // Same length, other bytes: every part has its size, only the joined file's SHA-256 can tell.
    const net = network({
      ...wholeRelease(),
      "friday-test--model.bin.part001": "0123",
      "friday-test--model.bin.part002": "XXXX",
      "friday-test--model.bin.part003": "89",
    });
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest(4) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(result.servedFrom).toBe("official source");
    expect(result.attempts[0].source).toBe("FRIDAY release");
    expect(result.attempts[0].error).toMatch(/checksum|SHA/i);
    expect(read("model.bin")).toBe("0123456789");
    expect(net.hugging().length).toBeGreaterThan(0);
    expect(
      fs.existsSync(
        path.join(folder(), ".cache", "friday-release", "friday-test--model.bin.part002"),
      ),
    ).toBe(false);
    expect(weights.servedSource(folder(), PIN)).toBe("official source");
  });

  it("falls back to the official source on a 404 (the release is not published), after one look", async () => {
    const net = network(null);
    events.length = 0;
    const result = await download.downloadModel(
      job(),
      onEvent,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(result.servedFrom).toBe("official source");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ source: "FRIDAY release" });
    expect(result.attempts[0].error).toMatch(/404|not available/i);
    // One HEAD, no retries: a missing release must not cost seconds per file.
    expect(net.release()).toHaveLength(1);
    expect(events.join("\n")).toMatch(/source failed \(FRIDAY release\)/);
    for (const [name, text] of Object.entries(FILES)) expect(read(name)).toBe(text);
    expect(weights.servedSource(folder(), PIN)).toBe("official source");
  });

  it("refuses wrong bytes from the release (never kept), and takes the file from the official source", async () => {
    const net = network({ ...wholeRelease(), "friday-test--model.bin": "0123456XXX" });
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(result.servedFrom).toBe("official source");
    expect(result.attempts[0].error).toMatch(/checksum/i);
    expect(read("model.bin")).toBe("0123456789");
    expect(net.hugging().some((url) => url.includes("model.bin"))).toBe(true);
    expect(pins.unexpectedFiles(folder(), PIN)).toEqual([]);
  });

  it("fails honestly when the release is wrong and the official source is wrong too", async () => {
    network(
      { ...wholeRelease(), "friday-test--model.bin": "0123456XXX" },
      { ...FILES, "model.bin": "ZZZZZZZZZZ" },
    );
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(folder(), "model.bin"))).toBe(false);
  });

  it("keeps a folder that is already whole: no request to the release, no change of the source note", async () => {
    network(wholeRelease());
    await download.downloadModel(job(), undefined, undefined, deps({ fridayModels: manifest() }));
    const again = network(wholeRelease());
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok).toBe(true);
    expect(again.release()).toEqual([]);
    expect(weights.servedSource(folder(), PIN)).toBe("FRIDAY release");
  });
});

describe("a model the manifest does not hold keeps today's chain exactly", () => {
  it("fetches only from the official source, adds no source note and no servedFrom", async () => {
    const without = manifest(1_900_000_000, assetsFor(1_900_000_000, ["config.json"]));
    const net = network(wholeRelease());
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: without }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(result).not.toHaveProperty("servedFrom");
    expect(result.attempts).toEqual([]);
    expect(net.release()).toEqual([]);
    expect(fs.existsSync(weights.sourceNotePath(folder()))).toBe(false);
    expect(weights.servedSource(folder(), PIN)).toBe("");
  });

  it("is the same with no manifest at all, and with the release switched off", async () => {
    for (const extra of [
      { fridayModels: null },
      { fridayModels: manifest(), env: { FRIDAY_MODELS_RELEASE: "0" } },
    ]) {
      fs.rmSync(folder(), { recursive: true, force: true });
      const net = network(wholeRelease());
      const result = await download.downloadModel(job(), undefined, undefined, deps(extra));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result).not.toHaveProperty("servedFrom");
      expect(net.release()).toEqual([]);
    }
  });
});

describe("the Install Manager row and the Doctor row say which source served the model", () => {
  it("shows the source of an installed pinned model, and nothing for an older install", () => {
    const real = pins.pinForRepo(weights.STT_REPOS.tiny);
    const tiny = path.join(dir, "cache", "stt", "tiny");
    for (const name of Object.keys(real.files)) {
      fs.mkdirSync(path.dirname(path.join(tiny, name)), { recursive: true });
      fs.writeFileSync(path.join(tiny, name), "x");
    }
    const row = () =>
      catalog
        .voiceRows(dir)
        .find((item: { id: string }) => item.id === "voice:faster-whisper-tiny");
    expect(row().servedFrom).toBeNull();
    fs.writeFileSync(
      weights.sourceNotePath(tiny),
      JSON.stringify({ schema: 1, source: "FRIDAY release", pinRevision: real.revision }),
    );
    expect(row().servedFrom).toBe("FRIDAY release");
    expect(weights.servedNote(tiny, real)).toBe("; installed from FRIDAY release");
    // A note of another revision, or of a source that is not one of the two, is not shown.
    fs.writeFileSync(
      weights.sourceNotePath(tiny),
      JSON.stringify({ schema: 1, source: "FRIDAY release", pinRevision: "d".repeat(40) }),
    );
    expect(row().servedFrom).toBeNull();
    fs.writeFileSync(
      weights.sourceNotePath(tiny),
      JSON.stringify({ schema: 1, source: "somewhere" }),
    );
    expect(weights.servedSource(tiny, real)).toBe("");
    const snap = catalog
      .createInstallerCatalog({ root: () => dir, voice: (root: string) => catalog.voiceRows(root) })
      .snapshot();
    expect(
      snap.rows.find((r: { id: string }) => r.id === "voice:faster-whisper-tiny"),
    ).not.toHaveProperty("servedFrom");
  });

  it("puts the source in the Doctor pin row of an installed speech size", async () => {
    const real = pins.pinForRepo(weights.STT_REPOS.tiny);
    const tiny = path.join(dir, "cache", "stt", "tiny");
    for (const [name, row] of Object.entries(real.files) as [string, { bytes: number }][]) {
      fs.mkdirSync(path.dirname(path.join(tiny, name)), { recursive: true });
      fs.writeFileSync(path.join(tiny, name), Buffer.alloc(row.bytes));
    }
    fs.writeFileSync(
      weights.sourceNotePath(tiny),
      JSON.stringify({ schema: 1, source: "official source", pinRevision: real.revision }),
    );
    const rows = await weights.pinChecks(dir, { exists: (file: string) => fs.existsSync(file) });
    const row = rows.find((item: { id: string }) => item.id === "stt-pin-tiny");
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(
      /match the pinned revision and size; installed from official source$/,
    );
  });
});

describe("the models release is never an app update", () => {
  const release = (tag: string, name = tag) => ({
    tag_name: tag,
    name,
    draft: false,
    prerelease: false,
    published_at: "2026-11-27T00:00:00Z",
    assets: [
      { id: 1, name: "FRIDAY-Setup-1.2.5.7.exe", size: 5, browser_download_url: "https://x" },
    ],
  });

  it("is not the update the checker offers, and not the latest release the Hub lists", async () => {
    const real = weights.readFridayModels();
    const releases = [release(real.tag, real.title), release("v1.2.5.7")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = String(url).includes("/releases")
          ? releases
          : { full_name: "o/r", private: false, default_branch: "main", permissions: {} };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "friday-models-update-"));
    try {
      await sync.writeConfig(work, { repo: "o/r", channel: "release", updateToken: "t" });
      const out = await sync.checkUpdate(work, { currentVersion: "1.2.5.7", channel: "release" });
      expect(out.ok).toBe(true);
      expect(out.updateAvailable).toBe(false);
      expect(JSON.stringify(out)).not.toContain(real.tag);
      const hub = await require_("../../electron/github-release.cjs").listReleases(work, {
        repo: "o/r",
      });
      expect(hub.latest?.tag).toBe("v1.2.5.7");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("the release tag is not an app version, so no updater rule can read it as one", () => {
    const real = weights.readFridayModels();
    expect(real.tag).toMatch(/^friday-models-\d{4}\.\d{1,2}\.\d{1,3}$/);
    expect(/^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(real.tag)).toBe(false);
    const source = fs.readFileSync(path.join(repoRoot, "scripts/build-friday-models.cjs"), "utf8");
    expect(source).toContain("--latest=false");
  });
});
