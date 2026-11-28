/**
 * The ModelScope second road (decision D-4). ModelScope holds byte-identical copies of more pinned repositories than the
 * five Systran speech ones: FRIDAY's Supertonic voice, the speaker embedder, the turbo speech model (under its old
 * publisher name), the Smart Turn helper and the FRIDAY Core GGUF files. Every road is only another place for the same
 * pinned bytes: the pin's SHA-256 and size stay the authority, so a wrong mirror file is refused and the next road runs.
 * Each url below was fetched and hashed (or its size and X-Linked-ETag read) on 2026-11-28 before it was added.
 * No network, no real clock: a fake fetch and an injected downloader stand in for the hosts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const weights = require_("../../electron/voice-weights.cjs");
const pins = require_("../../electron/voice-pins.cjs");
const download = require_("../../electron/model-download.cjs");
const safety = require_("../../electron/download-safety.cjs");
const core = require_("../../electron/friday-core.cjs");
const coreManifest = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../config/friday-core.json"), "utf8"),
);

const TURBO_PIN = "dropbox-dash/faster-whisper-large-v3-turbo";
const TURBO_MIRROR = "mobiuslabsgmbh/faster-whisper-large-v3-turbo";
const HELD = [
  ["Supertone/supertonic-3", "Supertone/supertonic-3"],
  [
    "onnx-community/wespeaker-voxceleb-resnet34-LM",
    "onnx-community/wespeaker-voxceleb-resnet34-LM",
  ],
  [TURBO_PIN, TURBO_MIRROR],
] as const;

type Row = { relPath: string; url: string; sha256: string; bytes: number };

describe("the ModelScope copy of the pinned voice repositories", () => {
  it.each(HELD)("%s is a url-set of exactly the pinned files, hashes and sizes", (pinned, held) => {
    const source = weights.modelscopeSource(pinned);
    const pin = pins.pinForRepo(pinned);
    expect(source).toMatchObject({ kind: "url-set", host: "modelscope.cn", repo: pinned });
    expect(source.files.map((f: Row) => f.relPath).sort()).toEqual(Object.keys(pin.files).sort());
    for (const file of source.files as Row[]) {
      expect(file.sha256).toBe(pin.files[file.relPath].sha256);
      expect(file.bytes).toBe(pin.files[file.relPath].bytes);
      expect(file.url).toBe(
        `https://modelscope.cn/api/v1/models/${held}/repo?Revision=master&FilePath=${encodeURIComponent(file.relPath)}`,
      );
      expect(() => safety.assertAllowedUrl(file.url)).not.toThrow();
    }
  });

  it("the turbo copy lives under the old publisher name, the repository the pin renamed away from", () => {
    const urls = weights.modelscopeSource(TURBO_PIN).files.map((f: Row) => f.url);
    expect(urls.every((url: string) => url.includes(`/models/${TURBO_MIRROR}/`))).toBe(true);
    expect(urls.some((url: string) => url.includes("dropbox-dash"))).toBe(false);
  });

  it("stays out of what was not compared: the plan's first turbo repository, silero, a stranger", () => {
    // The first road of the turbo plan is the old name, so the speech plan keeps its two Hugging Face sources.
    expect(weights.modelscopeSource(weights.STT_REPOS["large-v3-turbo"])).toBeNull();
    expect(weights.modelscopeSource("snakers4/silero-vad")).toBeNull();
    expect(weights.modelscopeSource("someone/else")).toBeNull();
    expect(Object.keys(weights.MODELSCOPE_REPO_MAP)).toEqual([TURBO_PIN]);
  });

  it("the silero helper has no ModelScope road: that file has the same size and different bytes", () => {
    const silero = weights.pinnedJobs().find((row: { id: string }) => row.id === "silero-vad");
    for (const source of silero.sources) expect(String(source.url)).not.toContain("modelscope");
  });

  it("the Smart Turn helper gets a ModelScope source with the pinned hash behind its Hugging Face one", () => {
    const row = weights.pinnedJobs().find((item: { id: string }) => item.id === "smart-turn");
    expect(row.sources).toHaveLength(2);
    const [first, second] = row.sources;
    expect(first.url).toContain("huggingface.co/pipecat-ai/smart-turn-v3/resolve/");
    expect(second).toMatchObject({
      kind: "url",
      url: "https://modelscope.cn/api/v1/models/pipecat-ai/smart-turn-v3/repo?Revision=master&FilePath=smart-turn-v3.2-cpu.onnx",
      sha256: row.sha256,
      bytes: row.bytes,
    });
    expect(second.sha256).toBe(first.sha256);
    expect(() => safety.assertAllowedUrl(second.url)).not.toThrow();
  });
});

describe("the download chain carries the ModelScope road", () => {
  const hf = (repo: string) => ({ kind: "hf-repo", repo, label: "Hugging Face" });
  const kinds = (list: { kind: string }[]) => list.map((s) => s.kind);

  it("puts the copy last, behind every Hugging Face source, for each held repository", () => {
    for (const [pinned] of HELD) {
      const chain = weights.withModelscopeRoad([hf(pinned)]);
      expect(kinds(chain)).toEqual(["hf-repo", "url-set"]);
      expect(chain[1]).toEqual(weights.modelscopeSource(pinned));
    }
    const turbo = weights.withModelscopeRoad(weights.sttPlan("large-v3-turbo", "/r").sources);
    expect(kinds(turbo)).toEqual(["hf-repo", "hf-repo", "url-set"]);
  });

  it("adds nothing for a repository ModelScope does not hold, and never a second copy", () => {
    const stranger = [hf("someone/else")];
    expect(weights.withModelscopeRoad(stranger)).toBe(stranger);
    const already = [
      hf("Supertone/supertonic-3"),
      weights.modelscopeSource("Supertone/supertonic-3"),
    ];
    expect(kinds(weights.withModelscopeRoad(already))).toEqual(["hf-repo", "url-set"]);
    expect(weights.withModelscopeRoad(null)).toEqual([]);
  });

  it("the release and local-bundle chain still ends with the official source, the mirror is a separate step", () => {
    const sources = [hf("Supertone/supertonic-3")];
    const chain = weights.withFridayRelease(sources, { localBundles: [], fridayModels: null });
    expect(chain[chain.length - 1]).toBe(sources[0]);
  });
});

describe("a wrong ModelScope file is refused", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ms-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a copy whose bytes have the pinned size but another SHA-256 fails the audit and leaves nothing behind", async () => {
    const repo = "onnx-community/wespeaker-voxceleb-resnet34-LM";
    const source = weights.modelscopeSource(repo);
    const seen: string[] = [];
    const result = await weights.downloadMirrorSet(source, dir, {
      // The stand-in downloader skips its own hash check on purpose, so the folder audit is what must catch it.
      downloadUrl: async (url: string, dest: string) => {
        seen.push(url);
        const row = (source.files as Row[]).find((f) => f.url === url)!;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.alloc(row.bytes, 7));
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checksum mismatch/);
    expect(seen).toHaveLength(source.files.length);
    for (const file of source.files as Row[])
      expect(fs.existsSync(path.join(dir, file.relPath))).toBe(false);
  });

  it("a file entry that differs from the pin is refused before any request", async () => {
    const source = weights.modelscopeSource("Supertone/supertonic-3");
    const forged = {
      ...source,
      files: source.files.map((f: Row, i: number) =>
        i === 0 ? { ...f, sha256: "0".repeat(64) } : f,
      ),
    };
    let calls = 0;
    const result = await weights.downloadMirrorSet(forged, dir, {
      downloadUrl: async () => {
        calls += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match the pin/);
    expect(calls).toBe(0);
  });
});

describe("a release road that answers 404 falls through to ModelScope", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const REPO = "test/pinned-release";
  const TAG = "friday-models-2026.1.1";
  const FILES: Record<string, string> = {
    "config.json": "{}",
    "model.bin": "0123456789",
    "a.onnx": "x",
  };
  const PIN = {
    revision: "c".repeat(40),
    files: Object.fromEntries(
      Object.entries(FILES).map(([n, t]) => [n, { sha256: sha(t), bytes: t.length }]),
    ),
  };
  const manifest = {
    pack: "friday-models",
    tag: TAG,
    repository: "o/r",
    partBytes: 1_900_000_000,
    assets: Object.entries(FILES).map(([name, text]) => ({
      fridayId: "friday-test",
      path: name,
      file: `friday-test--${name}`,
      sha256: sha(text),
      bytes: text.length,
      parts: 1,
      from: { pin: REPO, file: name, recipe: "copy", recipeVersion: 1 },
    })),
  };
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ms-chain-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("costs one request on the release, one per file on the mirror, and the model installs", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        requests.push(String(input));
        return new Response(null, { status: 404 });
      }),
    );
    const mirror = {
      kind: "url-set",
      host: "modelscope.cn",
      label: "ModelScope (same SHA-256)",
      repo: REPO,
      files: Object.entries(FILES).map(([name, text]) => ({
        kind: "url",
        url: `https://modelscope.cn/api/v1/models/${REPO}/repo?Revision=master&FilePath=${encodeURIComponent(name)}`,
        sha256: sha(text),
        bytes: text.length,
        relPath: name,
        label: "ModelScope (same SHA-256)",
      })),
    };
    const mirrorUrls: string[] = [];
    const result = await download.downloadModel(
      {
        modelId: "friday-test",
        dir,
        persist: false,
        sources: [
          { kind: "hf-repo", repo: REPO, label: "Hugging Face" },
          { kind: "url-set", host: "modelscope.cn", repo: REPO },
        ],
      },
      undefined,
      undefined,
      {
        localBundles: [],
        fridayModels: manifest,
        pinForRepo: (name: string) => (name === REPO ? PIN : null),
        mirrorSource: (name: string) => (name === REPO ? mirror : null),
        hub: { engineMode: () => "own", isBroken: () => false },
        env: {},
        downloadUrl: async (url: string, dest: string) => {
          mirrorUrls.push(url);
          const name = decodeURIComponent(url.split("FilePath=")[1]!);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, FILES[name]!);
        },
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("url-set");
    const base = `https://github.com/o/r/releases/download/${TAG}/`;
    expect(requests.filter((url) => url.startsWith(base))).toHaveLength(1);
    expect(mirrorUrls).toHaveLength(Object.keys(FILES).length);
    expect(new Set(mirrorUrls).size).toBe(mirrorUrls.length);
    for (const [name, text] of Object.entries(FILES))
      expect(fs.readFileSync(path.join(dir, "friday-test", name), "utf8")).toBe(text);
  });
});

describe("FRIDAY Core: the ModelScope road and the real runtime sizes", () => {
  const mirror = coreManifest.mirrors.find((m: { id: string }) => m.id === "modelscope");

  it("lists ModelScope after the upstream road, with the repositories it was compared on", () => {
    expect(coreManifest.mirrors.map((m: { id: string }) => m.id)).toEqual([
      "friday-models",
      "upstream",
      "modelscope",
    ]);
    expect(mirror).toMatchObject({
      kind: "modelscope",
      match: "sha256",
      urlPattern: "https://modelscope.cn/api/v1/models/<repo>/repo?Revision=master&FilePath=<file>",
    });
    const used = new Set<string>(
      coreManifest.variants.flatMap((v: { files: { upstream: { repo: string } }[] }) =>
        v.files.map((f) => f.upstream.repo),
      ),
    );
    expect([...used].sort()).toEqual([...mirror.repos].sort());
  });

  it("every shipped file gets a ModelScope road ending the chain, built from the upstream repo and file", () => {
    for (const variant of coreManifest.variants) {
      const plan = core.planAssets("/r", variant.id, { pack: null, stat: () => null });
      expect(plan.ok).toBe(true);
      for (const asset of plan.assets) {
        const file = variant.files.find((f: { disk: string }) => f.disk === asset.disk);
        const ids = asset.sources.map((s: { id: string }) => s.id);
        expect(ids).toEqual(["upstream", "modelscope"]);
        const road = asset.sources[1];
        expect(road.parts).toBe(1);
        expect(road.urls).toEqual([
          `https://modelscope.cn/api/v1/models/${file.upstream.repo}/repo?Revision=master&FilePath=${file.upstream.file
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
        ]);
        expect(() => safety.assertAllowedUrl(road.urls[0])).not.toThrow();
      }
    }
  });

  it("a repository ModelScope was not compared on gets no road", () => {
    const small = {
      schemaVersion: 1,
      diskDir: "models/friday-core",
      memory: { windowsGb: 3.5, appReserveGb: 3.5 },
      mirrors: coreManifest.mirrors,
      fallbackTiers: coreManifest.fallbackTiers,
      variants: [
        {
          id: "t1",
          role: "default",
          fridayName: "Test",
          licence: { id: "Apache-2.0" },
          files: [
            {
              kind: "model",
              disk: "friday-core-t1.gguf",
              bytes: 5,
              sha256: createHash("sha256").update("hello").digest("hex"),
              upstream: { repo: "a/b", revision: "c".repeat(40), file: "m.gguf" },
            },
          ],
        },
      ],
    };
    const plan = core.planAssets("/r", "t1", { manifest: small, pack: null, stat: () => null });
    expect(plan.assets[0].sources.map((s: { id: string }) => s.id)).toEqual(["upstream"]);
  });

  it("holds the real byte counts of the pinned runtime zips, read from the release", () => {
    const bytes = Object.fromEntries(
      coreManifest.runtime.assets.map((a: { id: string; bytes: number }) => [a.id, a.bytes]),
    );
    expect(bytes).toMatchObject({
      "cpu-x64": 25027471,
      "cuda-12.4-x64": 357966040,
      "cudart-12.4-x64": 391443627,
      "vulkan-x64": 38863716,
    });
    expect(JSON.stringify(coreManifest)).not.toMatch(/"bytes": null/);
    expect(coreManifest.unverified.join(" ")).not.toMatch(/runtime bytes/i);
  });
});
