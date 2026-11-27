/**
 * The three acquired optional ears, pinned: FRIDAY Ear English (int8 ONNX, English), FRIDAY Ear Swift (Hindi, Hinglish
 * and Indian English) and FRIDAY Ear Quick (tiny int8 ONNX, English, with its vocabulary as a second pin). Each is a
 * candidate that is downloaded on demand only, never bundled, never a default. Offline: no download, no network, no clock.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { modelById } from "../../src/lib/friday/model-catalog";
import { VOICE_MODEL_IDS } from "../../src/lib/friday/models-engine";

type Pin = {
  revision: string;
  license: string;
  licenseRecord: { id: string; url: string; redistribution: string; checkedAt: string };
  files: Record<string, { sha256: string; bytes: number }>;
};
type Asset = {
  fridayId: string;
  fridayName: string;
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  parts: number;
  from: { pin: string; file: string; recipe: string };
};
type Manifest = {
  assets: Asset[];
  packs: Array<{ id: string; models?: string[] }>;
};
const req = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const pins = req("../../electron/voice-pins.cjs") as {
  PINS: Record<string, Pin>;
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
  manifestFor: (repo: string) => { diskBytes: number; revision: string; basis: string } | null;
  bundleAllowed: (pin: unknown) => boolean;
};
const weights = req("../../electron/voice-weights.cjs") as {
  EXTRA_MODELS: Array<{
    catalogId: string;
    repo: string;
    rowId: string;
    label: string;
    kind: string;
  }>;
  ENGLISH_EAR_REPO: string;
  SWIFT_EAR_REPO: string;
  QUICK_EAR_REPO: string;
  QUICK_VOCAB_REPO: string;
  modelRegistry: () => Array<{
    catalogId: string;
    repo: string | null;
    dir: string[];
    label: string;
  }>;
  fridayReleasePlan: (
    repo: string,
    deps: Record<string, unknown>,
  ) => { tag: string; files: Array<{ name: string; sha256: string; bytes: number }> } | null;
  voiceModelsOnDisk: (
    root: string,
    exists: (file: string) => boolean,
  ) => Array<{ catalogId: string }>;
};
const builder = req("../../scripts/build-friday-models.cjs") as {
  manifestProblems: (manifest: unknown, pins: unknown) => string[];
  refusedModels: (manifest: unknown, pins: unknown, gate: unknown) => unknown[];
};
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "config/friday-models.json"), "utf8"),
) as Manifest;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/** Every pinned file, as read from the Hugging Face API at the pinned revision on 2026-11-27. */
const EXPECTED: Record<
  string,
  {
    revision: string;
    license: string;
    redistribution: string;
    catalogId: string;
    fridayId: string;
    name: string;
    files: Record<string, { sha256: string; bytes: number }>;
  }
> = {
  "istupakov/parakeet-tdt-0.6b-v2-onnx": {
    revision: "0bbb45a3365852604aef28b538a8f066f4ccaa85",
    license: "CC-BY-4.0",
    redistribution: "attribution",
    catalogId: "parakeet-ear",
    fridayId: "friday-ear-english",
    name: "FRIDAY Ear English",
    files: {
      "config.json": {
        sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
        bytes: 97,
      },
      "decoder_joint-model.int8.onnx": {
        sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3",
        bytes: 8998286,
      },
      "encoder-model.int8.onnx": {
        sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155",
        bytes: 652184014,
      },
      "vocab.txt": {
        sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
        bytes: 9384,
      },
    },
  },
  "udgamlabs/Shruti-ONNX": {
    revision: "a464a502cc732e4335313869e1ccf393ff8ba56b",
    license: "Apache-2.0",
    redistribution: "permissive",
    catalogId: "shruti-ear",
    fridayId: "friday-ear-swift",
    name: "FRIDAY Ear Swift",
    files: {
      LICENSE: {
        sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        bytes: 11358,
      },
      NOTICE: {
        sha256: "4e2e035dfd9a58c597cb81e5d644635ce8fd2ebbd51e44cc22b8bc5bf4da8110",
        bytes: 1031,
      },
      "hi/onnx-int8/decoder.onnx": {
        sha256: "777870e340af2c5a9513f8bef14ecf0c2d57ba7dbfe8682a99674ec58dbd6f70",
        bytes: 32293075,
      },
      "hi/onnx-int8/encoder.onnx": {
        sha256: "b26a33cedf74ce11f13ad3854f3c0a34e7272c4e2dfd0d5cd2818185b029b996",
        bytes: 19633861,
      },
      "hi/onnx-int8/frontend.onnx": {
        sha256: "0457d948c74b62e12b5d652d275269331092e13b22a2cdf64d2773c639a2b276",
        bytes: 911143,
      },
      "hi/onnx-int8/shruti.json": {
        sha256: "82aa655fef9ace280b626f5cfbbbe9a9e417c5c997a2708480e65d33ec3bdc45",
        bytes: 94153,
      },
      "hi/onnx/decoder.onnx": {
        sha256: "d6ad12693b4289fe5d8f23af5c87dffae9597aa5a585fffaea82fe54a3f27cc3",
        bytes: 20480122,
      },
      "hi/onnx/encoder.onnx": {
        sha256: "8935017652b2fec8932d9eb220a4ae1d5287b8b05904820eadabdc64c0de63d0",
        bytes: 10604825,
      },
      "hi/onnx/frontend.onnx": {
        sha256: "0457d948c74b62e12b5d652d275269331092e13b22a2cdf64d2773c639a2b276",
        bytes: 911143,
      },
      "hi/onnx/shruti.json": {
        sha256: "82aa655fef9ace280b626f5cfbbbe9a9e417c5c997a2708480e65d33ec3bdc45",
        bytes: 94153,
      },
    },
  },
  "moonshine-ai/moonshine": {
    revision: "48b4e427b587bcf67797a5be706d6ddc4a298149",
    license: "MIT",
    redistribution: "permissive",
    catalogId: "moonshine-ear",
    fridayId: "friday-ear-quick",
    name: "FRIDAY Ear Quick",
    files: {
      "onnx/merged/tiny/quantized/decoder_model_merged.onnx": {
        sha256: "eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367",
        bytes: 20243286,
      },
      "onnx/merged/tiny/quantized/encoder_model.onnx": {
        sha256: "c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a",
        bytes: 7937661,
      },
    },
  },
  "moonshine-ai/moonshine-tiny": {
    revision: "390624ed33d594443aa4aa221f5b9f283b545b5a",
    license: "MIT",
    redistribution: "permissive",
    catalogId: "moonshine-ear-vocab",
    fridayId: "friday-ear-quick-vocab",
    name: "FRIDAY Ear Quick Vocabulary",
    files: {
      "tokenizer.json": {
        sha256: "6579793438bc4fbafffacf699169ff53e3769c5a0a0f5e71cdee8853e8130deb",
        bytes: 1985530,
      },
    },
  },
};

const REPOS = Object.keys(EXPECTED);

describe("the acquired ears are pinned by revision, SHA-256 and bytes", () => {
  it.each(REPOS)("%s parses and matches its read-back digests", (repo) => {
    const want = EXPECTED[repo]!;
    const pin = pins.pinForRepo(repo)!;
    expect(pin, repo).toBeTruthy();
    expect(pin.revision).toMatch(HEX40);
    expect(pin.revision).toBe(want.revision);
    expect(pin.license).toBe(want.license);
    expect(pin.files).toEqual(want.files);
    for (const [name, row] of Object.entries(pin.files)) {
      expect(row.sha256, name).toMatch(HEX64);
      expect(Number.isInteger(row.bytes) && row.bytes > 0, name).toBe(true);
    }
  });

  it("holds Moonshine only under its current organisation names", () => {
    expect(weights.QUICK_EAR_REPO).toBe("moonshine-ai/moonshine");
    expect(weights.QUICK_VOCAB_REPO).toBe("moonshine-ai/moonshine-tiny");
    expect(
      Object.keys(pins.PINS)
        .filter((repo) => /moonshine/i.test(repo))
        .sort(),
    ).toEqual(["moonshine-ai/moonshine", "moonshine-ai/moonshine-tiny"]);
    for (const file of [
      "electron/voice-pins.cjs",
      "electron/voice-weights.cjs",
      "src/lib/friday/model-catalog.ts",
      "config/friday-models.json",
    ]) {
      expect(fs.readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/UsefulSensors/i);
    }
  });

  it("pins the three Swift subfolder sets whole, with the Hindi folders only", () => {
    const names = Object.keys(pins.pinForRepo(weights.SWIFT_EAR_REPO)!.files);
    for (const set of ["hi/onnx", "hi/onnx-int8"]) {
      for (const file of ["frontend.onnx", "encoder.onnx", "decoder.onnx", "shruti.json"])
        expect(names, `${set}/${file}`).toContain(`${set}/${file}`);
    }
    expect(names.filter((n) => n.includes("/") && !/^hi\/onnx(-int8)?\//.test(n))).toEqual([]);
  });

  it("has the manifest facts the hardware budget reads, from the pinned bytes", () => {
    for (const repo of REPOS) {
      const facts = pins.manifestFor(repo)!;
      expect(facts, repo).not.toBeNull();
      expect(facts.diskBytes).toBe(pins.pinnedBytes(pins.pinForRepo(repo)!));
      expect(facts.revision).toBe(EXPECTED[repo]!.revision);
    }
    expect(pins.manifestFor(weights.ENGLISH_EAR_REPO)!.basis).toBe("measured");
  });
});

describe("the licence gate allows each pin to be redistributed", () => {
  it.each(REPOS)("%s carries a licence record that bundleAllowed accepts", (repo) => {
    const pin = pins.pinForRepo(repo)!;
    expect(pin.licenseRecord.id).toBe(EXPECTED[repo]!.license);
    expect(pin.licenseRecord.redistribution).toBe(EXPECTED[repo]!.redistribution);
    expect(pin.licenseRecord.url.startsWith("https://")).toBe(true);
    expect(pins.bundleAllowed(pin), repo).toBe(true);
  });

  it("is refused by the gate when the record is dropped", () => {
    const pin = pins.pinForRepo(weights.ENGLISH_EAR_REPO)!;
    expect(pins.bundleAllowed({ ...pin, licenseRecord: undefined })).toBe(false);
    expect(
      pins.bundleAllowed({ ...pin, licenseRecord: { ...pin.licenseRecord, id: "CC-BY-SA-4.0" } }),
    ).toBe(false);
  });
});

describe("each ear is a FRIDAY row, with no other developer's name in what the owner sees", () => {
  const rows = REPOS.map((repo) => [repo, EXPECTED[repo]!] as const);

  it.each(rows)("%s is registered with its FRIDAY label and a catalogue row", (repo, want) => {
    const extra = weights.EXTRA_MODELS.find((row) => row.repo === repo)!;
    expect(extra, repo).toBeTruthy();
    expect(extra.catalogId).toBe(want.catalogId);
    expect(extra.rowId).toBe(`${want.catalogId}-pin`);
    expect(extra.label).toBe(want.name);
    expect(extra.kind).toBe("stt");
    const row = modelById.get(want.catalogId)!;
    expect(row, want.catalogId).toBeTruthy();
    expect(row.name).toBe(want.name);
    expect(row.category).toBe("Speech to Text");
    expect(row.url).toBe(`https://huggingface.co/${repo}`);
    expect(row.license).toBe(want.license);
    expect(row.installed ?? null).toBeNull();
    expect(VOICE_MODEL_IDS).toContain(want.catalogId);
    const entry = weights.modelRegistry().find((item) => item.catalogId === want.catalogId)!;
    expect(entry.repo).toBe(repo);
    expect(entry.dir).toEqual(["models", want.catalogId]);
  });

  it("uses the three FRIDAY names", () => {
    const names = weights.EXTRA_MODELS.map((row) => row.label);
    for (const name of ["FRIDAY Ear English", "FRIDAY Ear Swift", "FRIDAY Ear Quick"])
      expect(names).toContain(name);
    const credit =
      /nvidia|parakeet|nemo|shruti|udgam|cactus|whistle|moonshine|useful|istupakov|apache|creative commons/i;
    for (const repo of REPOS) {
      const want = EXPECTED[repo]!;
      expect(want.name).not.toMatch(credit);
      expect(modelById.get(want.catalogId)!.name).not.toMatch(credit);
    }
  });

  it("is installed only when every pinned file is on disk", () => {
    for (const repo of REPOS) {
      const want = EXPECTED[repo]!;
      const names = Object.keys(want.files);
      const have = (missing: string) => (file: string) =>
        names.some(
          (name) =>
            name !== missing &&
            file.endsWith(`${want.catalogId}${path.sep}${name.split("/").join(path.sep)}`),
        );
      const ids = (missing: string) =>
        weights.voiceModelsOnDisk("/friday", have(missing)).map((row) => row.catalogId);
      expect(ids("")).toContain(want.catalogId);
      for (const name of names) expect(ids(name)).not.toContain(want.catalogId);
    }
  });
});

describe("the ears are in the FRIDAY Voice Weights pack, as unchanged copies of their pins", () => {
  const voice = () => manifest.packs.find((pack) => pack.id === "voice-weights")!;

  it("names the four models in the voice pack and in no other", () => {
    for (const repo of REPOS) expect(voice().models).toContain(EXPECTED[repo]!.fridayId);
    for (const pack of manifest.packs.filter((p) => p.id !== "voice-weights"))
      for (const repo of REPOS) expect(pack.models || []).not.toContain(EXPECTED[repo]!.fridayId);
  });

  it("lists every pinned file once, with the pin's own SHA-256 and size and FRIDAY names", () => {
    for (const repo of REPOS) {
      const want = EXPECTED[repo]!;
      const assets = manifest.assets.filter((a) => a.fridayId === want.fridayId);
      expect(assets.map((a) => a.from.file).sort()).toEqual(Object.keys(want.files).sort());
      for (const a of assets) {
        expect(a.from.pin).toBe(repo);
        expect(a.from.recipe).toBe("copy");
        expect(a.fridayName).toBe(want.name);
        expect(a.file.startsWith(`${want.fridayId}--`)).toBe(true);
        expect(a.sha256).toBe(want.files[a.from.file]!.sha256);
        expect(a.bytes).toBe(want.files[a.from.file]!.bytes);
      }
    }
  });

  it("passes the builder's own checks and the bundle gate", () => {
    expect(builder.manifestProblems(manifest, pins.PINS)).toEqual([]);
    expect(builder.refusedModels(manifest, pins.PINS, pins.bundleAllowed)).toEqual([]);
  });

  it("gives each pin a release plan from the voice tag, so the release is tried before the upstream page", () => {
    for (const repo of REPOS) {
      const plan = weights.fridayReleasePlan(repo, { fridayModels: manifest, env: {} })!;
      expect(plan, repo).toBeTruthy();
      expect(plan.tag).toMatch(/^friday-voice-weights-/);
      expect(plan.files.map((f) => f.name).sort()).toEqual(
        Object.keys(EXPECTED[repo]!.files).sort(),
      );
    }
  });
});
