/**
 * The FRIDAY weight packs: Voice Weights, Brain Weights and Recall Weights, each with its own FRIDAY name, revision, tag,
 * SHA256SUMS, NOTICE and upload command (config/friday-models.json `packs`, scripts/build-friday-models.cjs). The
 * assets of the first single-pack layout stay in the top-level list, so the reader that shipped before the packs still
 * finds them. Nothing here touches the network or the real PC.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");

type Asset = {
  fridayId: string;
  fridayName: string;
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  parts: number;
  disk?: string;
  from: { pin: string; file: string; recipe: string; recipeVersion: number };
};
type PackRow = {
  id: string;
  fridayName: string;
  revision: string;
  tag: string;
  title: string;
  models?: string[];
  helpers?: string[];
  core?: string[];
  pending?: { id: string; fridayId: string; reason: string }[];
};
type Manifest = {
  pack: string;
  revision: string;
  repository: string;
  tag: string;
  title: string;
  partBytes: number;
  packs: PackRow[];
  assets: Asset[];
};
type Job = { id: string; file: string; sha256: string; bytes: number; license: string };
type CoreFile = {
  disk: string;
  bytes: number;
  sha256: string;
  upstream: { repo: string; file: string };
};
type Core = {
  variants: { id: string; fridayId: string; fridayName: string; files: CoreFile[] }[];
};
type Pins = Record<string, { files: Record<string, { sha256: string; bytes: number }> }>;
type Sources = { helperJobs: Job[]; core: Core };
const builder = require_("../../scripts/build-friday-models.cjs") as {
  readManifest: () => Manifest;
  readCore: () => Core;
  HELPER_NAMES: Record<string, { fridayId: string; fridayName: string }>;
  pinTable: (sources: Record<string, unknown>) => Pins;
  packAssets: (m: Manifest, id: string, sources: Sources) => Asset[];
  packManifest: (m: Manifest, id: string, sources: Sources) => Manifest;
  packsProblems: (m: unknown, sources: Sources) => string[];
  manifestProblems: (m: unknown, pins: unknown) => string[];
  refusedModels: (m: unknown, pins: unknown, gate: unknown) => { fridayName: string }[];
  buildNotice: (m: unknown, built: unknown[], pins: unknown) => string;
  modelsOf: (m: unknown) => unknown[];
  splitPlan: (file: string, bytes: number, partBytes: number) => { length: number }[];
};
const voicePins = require_("../../electron/voice-pins.cjs") as {
  PINS: Pins;
  LICENCES: Record<string, unknown>;
  bundleAllowed: (pin: unknown) => boolean;
};
const weights = require_("../../electron/voice-weights.cjs") as {
  pinnedJobs: () => Job[];
  readFridayModels: () => Manifest | null;
  fridayReleasePlan: (repo: string, deps?: Record<string, unknown>) => { tag: string } | null;
};
const releaseEngine = require_("../../scripts/release-engine.cjs") as {
  compareBuilds: (a: string, b: string) => number;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const manifest = builder.readManifest();
const core = builder.readCore();
const helperJobs = weights.pinnedJobs();
const sources: Sources = { helperJobs, core };
const tableOf = (withCore: Core = core) =>
  builder.pinTable({
    voicePins: voicePins.PINS,
    helperJobs,
    core: withCore,
    licences: voicePins.LICENCES,
  });
const pins = tableOf();
const packOf = (id: string) => manifest.packs.find((p) => p.id === id)!;

describe("the three packs and their names", () => {
  it("are Voice Weights, Brain Weights and Recall Weights, each with a FRIDAY name and a pack tag", () => {
    expect(manifest.packs.map((p) => [p.id, p.fridayName])).toEqual([
      ["voice-weights", "FRIDAY Voice Weights"],
      ["brain-weights", "FRIDAY Brain Weights"],
      ["recall-weights", "FRIDAY Recall Weights"],
    ]);
    for (const p of manifest.packs) {
      expect(p.revision).toMatch(/^\d{4}\.\d{1,2}\.\d{1,3}$/);
      expect(p.tag).toBe(`friday-${p.id}-${p.revision}`);
      expect(p.title).toBe(`${p.fridayName} ${p.revision}`);
    }
    expect(packOf("voice-weights").tag).toBe("friday-voice-weights-2026.11.1");
  });

  it("have a sound layout against the voice pins, the helper pins and the Core manifest", () => {
    expect(builder.packsProblems(manifest, sources)).toEqual([]);
  });

  it("refuse a layout with a wrong tag, a duplicate model or a missing one", () => {
    const wrongTag = clone(manifest);
    wrongTag.packs[0]!.tag = "friday-models-2026.11.1";
    expect(builder.packsProblems(wrongTag, sources).join("\n")).toContain("tag must be");
    const twice = clone(manifest);
    twice.packs[1]!.models = ["friday-voice"];
    expect(builder.packsProblems(twice, sources).join("\n")).toContain("is in both");
    const missing = clone(manifest);
    missing.packs[0]!.models = missing.packs[0]!.models!.slice(1);
    expect(builder.packsProblems(missing, sources).join("\n")).toContain("is in no pack");
    const noCore = clone(manifest);
    noCore.packs[1]!.core = ["e4b", "e2b"];
    expect(builder.packsProblems(noCore, sources).join("\n")).toContain(
      "Core variant q4b is in no pack",
    );
  });
});

describe("every asset is in exactly one pack", () => {
  const all = manifest.packs.map((p) => builder.packAssets(manifest, p.id, sources));

  it("never repeats a file name or a pinned file across the packs", () => {
    const files = all.flat().map((a) => a.file.toLowerCase());
    expect(new Set(files).size).toBe(files.length);
    const pinned = all.flat().map((a) => `${a.from.pin}|${a.from.file}`);
    expect(new Set(pinned).size).toBe(pinned.length);
  });

  it("holds the whole first-layout list in the Voice pack, with every field unchanged", () => {
    const voice = all[0]!;
    expect(voice.slice(0, manifest.assets.length)).toEqual(manifest.assets);
    const listed = new Set(manifest.assets.map((a) => a.fridayId));
    expect(new Set(packOf("voice-weights").models)).toEqual(listed);
    const held = packOf("voice-weights").helpers!.length;
    expect(voice.length).toBe(manifest.assets.length + held);
  });

  it("puts every ear, voice and sense model in Voice, the Core models in Brain and the embedder in Recall", () => {
    const ids = (index: number) => [...new Set(all[index]!.map((a) => a.fridayId))];
    expect(ids(0)).toEqual(
      expect.arrayContaining([
        "friday-ear-tiny",
        "friday-ear-live",
        "friday-ear-hindi",
        "friday-ear-hinglish-large",
        "friday-voice",
        "friday-voice-lite",
        "friday-denoise",
        "friday-denoise-lite",
        "friday-speaker",
        "friday-punctuate-hindi",
        "friday-listen-gate",
        "friday-wake",
      ]),
    );
    expect(ids(1)).toEqual(["friday-core", "friday-core-lite", "friday-core-q"]);
    expect(ids(2)).toEqual(["friday-recall"]);
    for (const a of all[1]!.concat(all[2]!)) expect(ids(0)).not.toContain(a.fridayId);
  });

  it("leaves Turn pending while the bundle gate refuses its terms, and says so", () => {
    const pending = packOf("voice-weights").pending!;
    expect(pending.map((p) => p.id)).toEqual(["smart-turn"]);
    expect(builder.HELPER_NAMES["smart-turn"]!.fridayId).toBe(pending[0]!.fridayId);
    expect(packOf("voice-weights").helpers).toEqual(["silero-vad", "wake-embed"]);
    // When the allowlist learns the terms of Turn the gate lets it through and it belongs in `helpers`.
    expect(voicePins.bundleAllowed(pins["smart-turn"])).toBe(false);
    for (const id of packOf("voice-weights").helpers!)
      expect(voicePins.bundleAllowed(pins[id]), id).toBe(true);
  });
});

describe("the Core files come from config/friday-core.json", () => {
  it("lists each Core file with the size and SHA-256 its Core pin carries, under the variant's FRIDAY name", () => {
    const brain = builder.packAssets(manifest, "brain-weights", sources);
    const recall = builder.packAssets(manifest, "recall-weights", sources);
    const wanted = core.variants.flatMap((v) => v.files.map((f) => ({ v, f })));
    expect(brain.length + recall.length).toBe(wanted.length);
    for (const { v, f } of wanted) {
      const asset = [...brain, ...recall].find((a) => a.sha256 === f.sha256)!;
      expect(asset, f.disk).toBeTruthy();
      expect(asset.bytes).toBe(f.bytes);
      expect(asset.fridayId).toBe(v.fridayId);
      expect(asset.fridayName).toBe(v.fridayName);
      expect(asset.disk).toBe(f.disk);
      expect(asset.path).toBe(f.upstream.file);
      expect(asset.from).toEqual({
        pin: f.upstream.repo,
        file: f.upstream.file,
        recipe: "copy",
        recipeVersion: 1,
      });
      expect(asset.file).toBe(`${v.fridayId}--${f.upstream.file}`);
    }
    expect(JSON.stringify(manifest.assets)).not.toContain("gguf");
  });

  it("splits a Core model over the part size into parts that add up to the pinned size", () => {
    const brain = builder.packAssets(manifest, "brain-weights", sources);
    expect(brain.some((a) => a.parts > 1)).toBe(true);
    for (const asset of brain) {
      const plan = builder.splitPlan(asset.file, asset.bytes, manifest.partBytes);
      expect(plan.length).toBe(asset.parts);
      expect(plan.reduce((n, p) => n + p.length, 0)).toBe(asset.bytes);
    }
  });

  it("makes every pack a sound manifest that passes the bundle gate, with one notice line per model", () => {
    for (const p of manifest.packs) {
      const pm = builder.packManifest(manifest, p.id, sources);
      expect(pm.tag).toBe(p.tag);
      expect(builder.manifestProblems(pm, pins), p.id).toEqual([]);
      expect(builder.refusedModels(pm, pins, voicePins.bundleAllowed), p.id).toEqual([]);
      const models = builder.modelsOf(pm);
      const notice = builder.buildNotice(pm, models, pins);
      expect(notice.split("\n").filter((l) => l.startsWith("- ")).length).toBe(models.length);
      expect(notice).toContain(`# ${p.fridayName} ${p.revision}`);
      expect(notice).toContain("devendrarj25");
      expect(notice).not.toMatch(/claude|anthropic|gpt|openai|co-authored|@/i);
    }
  });

  it("refuses an unknown pack and a Core file that drifted from its pin", () => {
    expect(() => builder.packManifest(manifest, "nope-weights", sources)).toThrow(/unknown pack/);
    const drifted = clone(core);
    drifted.variants[0]!.files[0]!.sha256 = "0".repeat(64);
    const pm = builder.packManifest(manifest, "brain-weights", sources);
    expect(builder.manifestProblems(pm, tableOf(drifted)).join("\n")).toContain(
      "SHA-256 of its pin",
    );
  });
});

describe("a pack tag is never an app update", () => {
  it("ranks below every product tag and is not a version", () => {
    for (const p of manifest.packs) {
      expect(/^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(p.tag)).toBe(false);
      for (const product of ["v1.0.0.0", "v1.2.5.7", "1.2.5.8", "v9.9.9.9"])
        expect(releaseEngine.compareBuilds(p.tag, product), `${p.tag} vs ${product}`).toBeLessThan(
          0,
        );
    }
  });

  it("is published with --latest=false by the printed command", () => {
    expect(fs.readFileSync(path.join(root, "scripts/build-friday-models.cjs"), "utf8")).toContain(
      "--latest=false",
    );
  });
});

describe("the reader that shipped before the packs still works", () => {
  it("reads the manifest as a friday-models pack with the first release tag and the whole voice list", () => {
    const old = weights.readFridayModels()!;
    expect(old.pack).toBe("friday-models");
    expect(old.tag).toBe("friday-models-2026.11.1");
    expect(old.assets.length).toBe(manifest.assets.length);
    expect(builder.manifestProblems(old, voicePins.PINS)).toEqual([]);
  });

  it("still plans a release road for every pinned voice repository, from the same tag", () => {
    const repos = [...new Set(manifest.assets.map((a) => a.from.pin))];
    expect(repos.length).toBeGreaterThanOrEqual(18);
    for (const repo of repos) {
      const plan = weights.fridayReleasePlan(repo, { env: {} });
      expect(plan, repo).not.toBeNull();
      expect(plan!.tag).toBe(manifest.tag);
    }
  });

  it("is not thrown by the pack list or the helper and Core files that sit beside the old assets", () => {
    const without = clone(manifest) as Partial<Manifest>;
    delete without.packs;
    const repo = manifest.assets[0]!.from.pin;
    expect(weights.fridayReleasePlan(repo, { env: {}, fridayModels: without })).toEqual(
      weights.fridayReleasePlan(repo, { env: {} }),
    );
    expect(weights.fridayReleasePlan("silero-vad", { env: {} })).toBeNull();
  });
});

describe("the command line builds one pack at a time", () => {
  const script = path.join(root, "scripts", "build-friday-models.cjs");
  const out = path.join(os.tmpdir(), "friday-weight-packs-dry-run");
  const run = (args: string[]) =>
    execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it.each(manifest.packs.map((p) => [p.id, p.tag, p.title] as const))(
    "--dry-run lists %s with its tag and prints its own upload command",
    (id, tag, title) => {
      const text = run(["--pack", id, "--out", out, "--dry-run"]);
      expect(text).toContain(`${title} (${tag})`);
      expect(text).toContain("0 skipped");
      expect(text).toContain(`gh release create ${tag} --repo devendrarj25/FRIDAY-AI-ASSISTANT`);
      expect(text).toContain("--notes-file NOTICE.md --latest=false");
      expect(text).toContain(`friday-${id}.json`);
      for (const other of manifest.packs.filter((p) => p.id !== id))
        expect(text).not.toContain(other.tag);
      expect(fs.existsSync(out)).toBe(false);
    },
  );

  it("refuses a run with no --pack and a pack it does not know", () => {
    expect(() => run(["--out", out, "--dry-run"])).toThrow(/--pack/);
    expect(() => run(["--pack", "nope", "--out", out, "--dry-run"])).toThrow(/unknown pack/);
  });
});
