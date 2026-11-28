/**
 * FRIDAY Core manifest: every pin is a full SHA-256, every host is on the download allowlist, the variant follows the
 * RAM, the FRIDAY Models release comes first once it holds a file, and an unpinned entry is skipped, never guessed.
 * No network and no weights: the files are tiny temp files.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const core = req(path.join(root, "electron/friday-core.cjs"));
const safety = req(path.join(root, "electron/download-safety.cjs"));
const manifest = JSON.parse(readFileSync(path.join(root, "config/friday-core.json"), "utf8"));
const runners = JSON.parse(readFileSync(path.join(root, "config/local-runners.json"), "utf8"));
const tiers = JSON.parse(readFileSync(path.join(root, "config/chat-tiers.json"), "utf8"));

type PinFile = {
  kind: string;
  disk: string;
  bytes: number;
  sha256: string;
  upstream: { repo: string; revision: string; file: string };
};
type Variant = {
  id: string;
  role: string;
  fridayName: string;
  licence: { id: string; source: string };
  files: PinFile[];
};
const variants = manifest.variants as Variant[];
const allFiles = variants.flatMap((v) => v.files);
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-core-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("friday-core.json pins", () => {
  it("pins every file by a full 64-hex sha256, a size and a revision", () => {
    expect(allFiles.length).toBe(7);
    for (const f of allFiles) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(f.bytes) && f.bytes > 0).toBe(true);
      expect(f.upstream.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(core.pinProblem(f)).toBe("");
    }
    for (const a of manifest.runtime.assets) expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("names the four FRIDAY models and keeps plain disk names under friday-core", () => {
    expect(variants.map((v) => v.fridayName)).toEqual([
      "FRIDAY Core",
      "FRIDAY Core Lite",
      "FRIDAY Core Q",
      "FRIDAY Recall embedder",
    ]);
    expect(manifest.diskDir).toBe("models/friday-core");
    for (const f of allFiles) expect(f.disk).toMatch(/^friday-core-[a-z0-9]+(-mmproj)?\.gguf$/);
    expect(new Set(allFiles.map((f) => f.disk)).size).toBe(allFiles.length);
  });

  it("uses only hosts the download allowlist knows, for every source and runtime asset", () => {
    for (const v of variants) {
      const plan = core.planAssets("/r", v.id, { pack: null });
      for (const a of plan.assets) {
        for (const s of a.sources) for (const url of s.urls) safety.assertAllowedUrl(url);
      }
    }
    for (const a of manifest.runtime.assets) {
      safety.assertAllowedUrl(manifest.runtime.urlPattern.replace("<name>", a.name));
    }
    safety.assertAllowedUrl(
      "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/x/y",
    );
  });

  it("agrees with the llama.cpp pin the setup already verifies", () => {
    const pinned = runners.runners.find((r: { id: string }) => r.id === "llamacpp").release;
    const cpu = manifest.runtime.assets.find((a: { id: string }) => a.id === "cpu-x64");
    expect(manifest.runtime.tag).toBe(pinned.tag);
    expect(cpu.name).toBe(pinned.asset);
    expect(cpu.sha256).toBe(pinned.sha256);
    expect(cpu.bytes).toBe(pinned.bytes);
  });

  it("pins the b12619 builds: every id named, hashed, sized and tied to the tag", () => {
    const rt = manifest.runtime;
    expect(rt.tag).toBe("b12619");
    const ids = rt.assets.map((a: { id: string }) => a.id);
    expect(ids).toEqual([
      "cpu-x64",
      "cpu-arm64",
      "cuda-12.4-x64",
      "cudart-12.4-x64",
      "cuda-13.5-x64",
      "cudart-13.5-x64",
      "vulkan-x64",
      "rocm-10.0-x64",
    ]);
    for (const a of rt.assets) {
      expect(a.bytes, a.id).toBeGreaterThan(10_000_000);
      expect(a.sha256, a.id).toMatch(/^[a-f0-9]{64}$/);
      expect(a.name, a.id).toMatch(
        a.id.startsWith("cudart")
          ? /^cudart-llama-bin-win-cuda-\d+\.\d+-x64\.zip$/
          : new RegExp(`^llama-${rt.tag}-bin-win-`),
      );
    }
    expect(rt.source).toContain(`/tag/${rt.tag}`);
    expect(rt.urlPattern).toContain(`/download/${rt.tag}/`);
    expect(rt.checkedAt >= rt.releasedAt).toBe(true);
  });

  it("names the existing small chat tiers as the fallback, and records a licence for every variant", () => {
    const known = new Set(tiers.tiers.map((t: { id: string; tag: string }) => `${t.id}:${t.tag}`));
    for (const t of manifest.fallbackTiers) expect(known.has(`${t.tier}:${t.tag}`)).toBe(true);
    for (const v of variants) {
      expect(Object.keys(manifest.licences)).toContain(v.licence.id);
      expect(v.licence.source).toMatch(/^https:\/\//);
    }
  });
});

describe("pickVariant", () => {
  it("picks the default on a roomy 16 GB PC and the lite one when free memory is short", () => {
    expect(core.pickVariant(16, 12).variant).toBe("e4b");
    expect(core.pickVariant(16, 9.9).variant).toBe("e2b");
    expect(core.pickVariant(16, 8).variant).toBe("e2b");
    expect(core.pickVariant(16, 6).variant).toBeNull();
  });

  it("counts Windows and the voice stack against installed memory", () => {
    expect(core.pickVariant(16, null).variant).toBe("e4b");
    expect(core.pickVariant(12, null).variant).toBe("e2b");
    expect(core.pickVariant(32, 40).variant).toBe("e4b");
  });

  it("falls back to the existing small chat tiers when nothing fits", () => {
    const eight = core.pickVariant(8, 5);
    expect(eight).toMatchObject({ ok: true, variant: null, fallback: { tag: "qwen3.5:2b" } });
    expect(core.pickVariant(6, 3).fallback.tag).toBe("qwen3.5:0.8b");
    expect(core.pickVariant(16, 4).fallback.tag).toBe("qwen3.5:0.8b");
  });

  it("puts the challenger first only when asked, and only when it fits", () => {
    expect(core.pickVariant(16, 12, { prefer: "q4b" }).variant).toBe("q4b");
    expect(core.pickVariant(12, null, { prefer: "q4b" }).variant).toBe("q4b");
    expect(core.pickVariant(8, 5, { prefer: "q4b" }).variant).toBeNull();
  });

  it("never picks the embedder and refuses unknown memory", () => {
    for (const ram of [4, 8, 12, 16, 32, 64])
      expect(core.pickVariant(ram, ram).variant).not.toBe("recall");
    expect(core.pickVariant(NaN, 4).ok).toBe(false);
    expect(core.pickVariant(0, 0).ok).toBe(false);
  });
});

describe("planAssets", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const small = {
    schemaVersion: 1,
    diskDir: "models/friday-core",
    memory: { windowsGb: 3.5, appReserveGb: 3.5 },
    mirrors: manifest.mirrors,
    fallbackTiers: manifest.fallbackTiers,
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
            sha256: sha("hello"),
            upstream: { repo: "a/b", revision: "c".repeat(40), file: "dir/m n.gguf" },
          },
          {
            kind: "mmproj",
            disk: "friday-core-t1-mmproj.gguf",
            bytes: 5,
            sha256: "abc123",
            upstream: { repo: "a/b", revision: "c".repeat(40), file: "p.gguf" },
          },
          {
            kind: "model",
            disk: "../escape.gguf",
            bytes: 5,
            sha256: sha("hello"),
            upstream: { repo: "a/b", revision: "c".repeat(40), file: "p.gguf" },
          },
        ],
      },
    ],
  };

  it("skips an unpinned or unsafe entry instead of guessing", () => {
    const plan = core.planAssets("/r", "t1", { manifest: small, pack: null, stat: () => null });
    expect(plan.assets.map((a: { disk: string }) => a.disk)).toEqual(["friday-core-t1.gguf"]);
    expect(plan.skipped).toEqual([
      { disk: "friday-core-t1-mmproj.gguf", reason: "no full sha256" },
      { disk: "../escape.gguf", reason: "unsafe disk name" },
    ]);
  });

  it("uses the upstream revision url and encodes the file path", () => {
    const plan = core.planAssets("/r", "t1", { manifest: small, pack: null, stat: () => null });
    const [source] = plan.assets[0].sources;
    expect(plan.assets[0].sources.map((s: { id: string }) => s.id)).toEqual(["upstream"]);
    expect(source.urls).toEqual([
      `https://huggingface.co/a/b/resolve/${"c".repeat(40)}/dir/m%20n.gguf`,
    ]);
  });

  it("lists the FRIDAY Models release first, with part names, only when the pack holds the file", () => {
    const pack = {
      revision: "2026.12.1",
      assets: [{ file: "core--t1.gguf", sha256: sha("hello"), parts: 3 }],
    };
    const plan = core.planAssets("/r", "t1", { manifest: small, pack, stat: () => null });
    const sources = plan.assets[0].sources;
    expect(sources.map((s: { id: string }) => s.id)).toEqual(["friday-models", "upstream"]);
    expect(sources[0].urls).toEqual([
      "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/friday-models-2026.12.1/core--t1.gguf.part001",
      "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/friday-models-2026.12.1/core--t1.gguf.part002",
      "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/friday-models-2026.12.1/core--t1.gguf.part003",
    ]);
    const other = core.planAssets("/r", "t1", {
      manifest: small,
      pack: { revision: "2026.12.1", assets: [{ file: "x", sha256: sha("other"), parts: 1 }] },
      stat: () => null,
    });
    expect(other.assets[0].sources.map((s: { id: string }) => s.id)).toEqual(["upstream"]);
  });

  it("builds the release url from the pack tag of the variant, and the old tag without packs[]", () => {
    const packs = [
      { id: "brain-weights", tag: "friday-brain-weights-2026.12.1", core: ["t1"] },
      { id: "recall-weights", tag: "friday-recall-weights-2026.12.1", core: ["r1"] },
    ];
    const asset = {
      revision: "2026.12.1",
      assets: [{ file: "x.gguf", sha256: sha("hello"), parts: 1 }],
    };
    const brain = core.planAssets("/r", "t1", {
      manifest: small,
      pack: { ...asset, packs },
      stat: () => null,
    });
    expect(brain.assets[0].sources[0].urls).toEqual([
      "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/friday-brain-weights-2026.12.1/x.gguf",
    ]);
    const old = core.planAssets("/r", "t1", { manifest: small, pack: asset, stat: () => null });
    expect(old.assets[0].sources[0].urls[0]).toContain("/download/friday-models-2026.12.1/");
    const real = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../config/friday-models.json"), "utf8"),
    );
    const tagOf = (v: string) =>
      real.packs.find((p: { core?: string[] }) => p.core?.includes(v))?.tag;
    expect(tagOf("e4b")).toMatch(/^friday-brain-weights-/);
    expect(tagOf("recall")).toMatch(/^friday-recall-weights-/);
  });

  it("lists the release mirror before the upstream, and ModelScope last, in the shipped manifest", () => {
    expect(manifest.mirrors.map((m: { id: string }) => m.id)).toEqual([
      "friday-models",
      "upstream",
      "modelscope",
    ]);
    const plan = core.planAssets("/r", "e4b", {
      pack: {
        revision: "2026.12.1",
        assets: [{ file: "e4b.gguf", sha256: variants[0]!.files[0]!.sha256, parts: 3 }],
      },
      stat: () => null,
    });
    expect(plan.assets[0].sources.map((s: { id: string }) => s.id)).toEqual([
      "friday-models",
      "upstream",
      "modelscope",
    ]);
    expect(plan.assets[1].sources.map((s: { id: string }) => s.id)).toEqual([
      "upstream",
      "modelscope",
    ]);
    expect(plan.assets[0].dest).toBe(
      path.join("/r", "models", "friday-core", "friday-core-e4b.gguf"),
    );
  });

  it("marks a file present only when the size on disk matches", () => {
    const here = core.planAssets("/r", "t1", {
      manifest: small,
      pack: null,
      stat: () => ({ size: 5 }),
    });
    const wrong = core.planAssets("/r", "t1", {
      manifest: small,
      pack: null,
      stat: () => ({ size: 4 }),
    });
    expect(here.assets[0].present).toBe(true);
    expect(wrong.assets[0].present).toBe(false);
  });

  it("refuses an unknown variant and a path that leaves the folder", () => {
    expect(core.planAssets("/r", "nope", { manifest: small }).ok).toBe(false);
    expect(() => core.diskPath("/r", "../x.gguf", { manifest: small })).toThrow(/unsafe/);
    expect(() => core.diskPath("/r", "a/b.gguf", { manifest: small })).toThrow(/unsafe/);
  });
});

describe("verifySha", () => {
  const body = "friday core test bytes";
  const digest = createHash("sha256").update(body).digest("hex");

  it("accepts a file whose size and sha256 match", async () => {
    const file = path.join(temp(), "w.gguf");
    writeFileSync(file, body);
    await expect(core.verifySha(file, digest, { bytes: body.length })).resolves.toEqual({
      ok: true,
      sha256: digest,
    });
  });

  it("refuses a changed file, a wrong size, a missing file and a short pin", async () => {
    const file = path.join(temp(), "w.gguf");
    writeFileSync(file, body + "!");
    expect((await core.verifySha(file, digest)).ok).toBe(false);
    expect((await core.verifySha(file, digest, { bytes: body.length })).reason).toMatch(
      /wrong size/,
    );
    expect((await core.verifySha(path.join(temp(), "none.gguf"), digest)).reason).toMatch(
      /not on disk/,
    );
    expect((await core.verifySha(file, digest.slice(0, 16))).reason).toMatch(/no full sha256/);
  });
});
