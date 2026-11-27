/**
 * The Hindi punctuation model and the light Hindi voice: two optional ONNX downloads, pinned by revision, SHA-256
 * and bytes, never bundled, each with a Models-page row, a Doctor pin row and a per-file repair. The default
 * listening and speaking paths never need them. Offline: the disk is a temp folder and nothing is downloaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { modelById } from "../../src/lib/friday/model-catalog";
import { VOICE_MODEL_IDS } from "../../src/lib/friday/models-engine";

type Pin = {
  revision: string;
  license: string;
  files: Record<string, { sha256: string; bytes: number }>;
};
type Extra = { catalogId: string; repo: string; rowId: string; label: string };
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
  auditDir: (
    dir: string,
    pin: Pin,
    options?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; missing: string[]; wrongSize: string[]; wrongDigest: string[] }>;
  removeBad: (dir: string, audit: { wrongSize: string[]; wrongDigest: string[] }) => string[];
  selectPinned: (
    listing: { files: string[]; meta?: Record<string, { sha256?: string }> },
    pin: Pin,
  ) => { ok: boolean; error?: string };
};
const weights = req("../../electron/voice-weights.cjs") as {
  HINDI_PUNCT_REPO: string;
  HINDI_LIGHT_REPO: string;
  EAR_MODELS: Array<{ catalogId: string }>;
  EXTRA_MODELS: Extra[];
  voiceModelsOnDisk: (
    root: string,
    exists: (file: string) => boolean,
  ) => Array<{ catalogId: string; kind: string }>;
  pinChecks: (
    root: string,
    deps: Record<string, unknown>,
  ) => Promise<Array<{ id: string; ok: boolean; detail: string }>>;
};
const caps = req("../../electron/model-capabilities.cjs") as {
  resolveCapabilities: (model: Record<string, unknown>) => Record<string, unknown>;
};
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");

const HEX64 = /^[0-9a-f]{64}$/;
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hindi-extras-"));
  folders.push(dir);
  return dir;
}

describe("the Hindi punctuation model is pinned", () => {
  const pin = () => pins.pinForRepo(weights.HINDI_PUNCT_REPO)!;

  it("is the Apache-2.0 ONNX model at one revision, with every file's digest and size", () => {
    expect(weights.HINDI_PUNCT_REPO).toBe("1-800-BAD-CODE/punct_cap_seg_47_language");
    expect(pin().revision).toBe("1b9d51fc7989ebc61e844d407d9dadd08ff4ba28");
    expect(pin().license).toBe("Apache-2.0");
    expect(pin().files).toEqual({
      "punct_cap_seg_47lang.onnx": {
        sha256: "640d91c06b7cc5b3e065c12a7097188378aad3bc11568ff1d72c4c0a2acb0df4",
        bytes: 232986305,
      },
      "spe_unigram_64k_lowercase_47lang.model": {
        sha256: "1bc15b6e5fd80dfac9999582ce3efcad2ac1f7cf4e0e9769b329f5de9ca5af47",
        bytes: 1186519,
      },
      "config.yaml": {
        sha256: "30eb8e05fcea3865828ab73f41fbba21dd7faf127a61950a706af9156f5b84f2",
        bytes: 516,
      },
    });
    for (const row of Object.values(pin().files)) expect(row.sha256).toMatch(HEX64);
  });
});

describe("the light Hindi voice is pinned and credited", () => {
  const pin = () => pins.pinForRepo(weights.HINDI_LIGHT_REPO)!;

  it("is the CC-BY-4.0 ONNX model at one revision, with every file's digest and size", () => {
    expect(weights.HINDI_LIGHT_REPO).toBe("sulabhkatiyar/indic-tiny-tts-hindi");
    expect(pin().revision).toBe("1fb1b108ee6ffb73ee74bd68b283ec13eb39e957");
    expect(pin().license).toBe("CC-BY-4.0");
    expect(pin().files).toEqual({
      "onnx/text_encoder.onnx": {
        sha256: "38df505ea822800d91a13bdc4a670f81ee964e9e0fe24a705590859fe7cfd08f",
        bytes: 17695838,
      },
      "onnx/flow_decoder.onnx": {
        sha256: "923a0472ec4d4c05c43bfc8ea512f8f762cf447b9f6ce1f01043144e1f6d1252",
        bytes: 19169253,
      },
      "onnx/vocoder.onnx": {
        sha256: "44d36238a761750447038895ab194e2378f6f4ba2c2d089a4766fa52810ef353",
        bytes: 54150036,
      },
      "onnx/onnx_manifest.json": {
        sha256: "30ce6bb339f2d27b0aada791c57f4197b2dd9ddd7d710dbcb36eb095bd5f762f",
        bytes: 3117,
      },
      "config.json": {
        sha256: "4078fd217dc171808b58f05b5ed78f85d78126bf7bf46351186fcf039411f66d",
        bytes: 3443,
      },
      "LICENSE.md": {
        sha256: "64fa648284b590c9e62a0d40521ba8c40728ec16cfb485245ef620436f0579ed",
        bytes: 2976,
      },
    });
    for (const row of Object.values(pin().files)) expect(row.sha256).toMatch(HEX64);
    expect(pins.pinnedBytes(pin())).toBeLessThan(100_000_000); // about 91 MB: small, never the default
  });

  it("shows the FRIDAY name and no credit in the Models page text, with the licence as a field", () => {
    const row = modelById.get("hindi-light-tts")!;
    expect(row.license).toBe("CC-BY-4.0");
    expect(row.name).toBe("FRIDAY Voice Lite");
    expect(row.url).toBe("https://huggingface.co/sulabhkatiyar/indic-tiny-tts-hindi");
  });
});

describe("both have a Models row, a disk check, a Doctor pin row and a repair", () => {
  it("keeps the three ears as they were and adds these eight beside them (two Hindi extras, six optional pins)", () => {
    expect(weights.EAR_MODELS.map((ear) => ear.catalogId)).toEqual([
      "hindi-ear",
      "hinglish-ear",
      "hindi-fallback-ear",
    ]);
    expect(weights.EXTRA_MODELS.map((row) => [row.catalogId, row.rowId])).toEqual([
      ["hindi-punct", "hindi-punct-pin"],
      ["hindi-light-tts", "hindi-light-tts-pin"],
      ["denoise-dpdfnet", "denoise-dpdfnet-pin"],
      ["denoise-gtcrn", "denoise-gtcrn-pin"],
      ["speaker-wespeaker", "speaker-wespeaker-pin"],
      ["hindi-vaani-ear", "hindi-vaani-ear-pin"],
      ["stream-ear-nemotron", "stream-ear-nemotron-pin"],
      ["hinglish-ear-trelis", "hinglish-ear-trelis-pin"],
    ]);
  });

  it("lists both in the catalogue, installed only from the disk and off by default", () => {
    for (const extra of weights.EXTRA_MODELS) {
      const row = modelById.get(extra.catalogId)!;
      expect(row, extra.catalogId).toBeTruthy();
      expect(row.installed ?? null).toBeNull();
      expect(VOICE_MODEL_IDS).toContain(extra.catalogId);
      expect(row.url).toBe(`https://huggingface.co/${extra.repo}`);
    }
    expect(modelById.get("hindi-punct")!.category).toBe("Speech to Text");
    expect(modelById.get("hindi-light-tts")!.category).toBe("Text to Speech");
    expect(modelById.get("hindi-punct")!.license).toBe("Apache-2.0");
  });

  it("is recognised as audio, not a chat model", () => {
    for (const extra of weights.EXTRA_MODELS) {
      const found = caps.resolveCapabilities({ id: extra.catalogId, name: extra.catalogId }) as {
        audio?: boolean;
        chat?: boolean;
        tools?: boolean;
      };
      expect(found.audio, extra.catalogId).toBe(true);
      expect(found.chat, extra.catalogId).not.toBe(true);
    }
  });

  it("is installed only when every pinned file is on disk, nested folders included", () => {
    for (const extra of weights.EXTRA_MODELS) {
      const names = Object.keys(pins.pinForRepo(extra.repo)!.files);
      const have = (missing: string) => (file: string) =>
        names.some(
          (name) =>
            name !== missing &&
            file.endsWith(`${extra.catalogId}${path.sep}${name.split("/").join(path.sep)}`),
        );
      const ids = (missing: string) =>
        weights.voiceModelsOnDisk("/friday", have(missing)).map((row) => row.catalogId);
      expect(ids(""), extra.catalogId).toContain(extra.catalogId);
      for (const name of names)
        expect(ids(name), `${extra.catalogId} without ${name}`).not.toContain(extra.catalogId);
    }
  });

  it("gives the voice check one pin row each, only when installed, red for a short file", async () => {
    const root = temp();
    const exists = (file: string) => fs.existsSync(file);
    expect((await weights.pinChecks(root, { exists })).map((row) => row.id)).toEqual([]);
    for (const extra of weights.EXTRA_MODELS) {
      for (const name of Object.keys(pins.pinForRepo(extra.repo)!.files)) {
        const file = path.join(root, "models", extra.catalogId, ...name.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "x");
      }
    }
    const rows = await weights.pinChecks(root, { exists });
    const punct = rows.find((entry) => entry.id === "hindi-punct-pin");
    expect(punct?.ok).toBe(false);
    expect(punct?.detail).toMatch(/punct_cap_seg_47lang\.onnx wrong size/);
    const voice = rows.find((entry) => entry.id === "hindi-light-tts-pin");
    expect(voice?.ok).toBe(false);
    expect(voice?.detail).toMatch(/onnx\/vocoder\.onnx wrong size/);
    expect(rows.find((entry) => entry.id === "hindi-punct-pin")?.detail).not.toMatch(/missing/);
  });

  it("repairs only the damaged file", async () => {
    const root = temp();
    const dir = path.join(root, "models", "hindi-light-tts");
    fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
    const pin = pins.pinForRepo(weights.HINDI_LIGHT_REPO)!;
    const small: Pin = {
      ...pin,
      files: {
        "config.json": { sha256: pin.files["config.json"]!.sha256, bytes: 4 },
        "onnx/vocoder.onnx": { sha256: pin.files["onnx/vocoder.onnx"]!.sha256, bytes: 8 },
      },
    };
    fs.writeFileSync(path.join(dir, "config.json"), "abcd");
    fs.writeFileSync(path.join(dir, "onnx", "vocoder.onnx"), "short");
    const audit = await pins.auditDir(dir, small);
    expect(audit.wrongSize).toEqual(["onnx/vocoder.onnx"]);
    expect(pins.removeBad(dir, audit)).toEqual(["onnx/vocoder.onnx"]);
    expect(fs.existsSync(path.join(dir, "onnx", "vocoder.onnx"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("refuses a listing that lacks a pinned file or names another digest", () => {
    for (const extra of weights.EXTRA_MODELS) {
      const pin = pins.pinForRepo(extra.repo)!;
      const names = Object.keys(pin.files);
      expect(pins.selectPinned({ files: names.slice(1) }, pin).ok).toBe(false);
      const meta = { [names[0]!]: { sha256: "0".repeat(64) } };
      expect(pins.selectPinned({ files: names, meta }, pin).ok).toBe(false);
      expect(pins.selectPinned({ files: names }, pin).ok).toBe(true);
    }
  });

  it("offers the Install Manager button from the voice check for both", () => {
    const source = read("electron/voice-verify.cjs");
    const table = /const OPTIONAL_INSTALL = \{([\s\S]*?)\};/.exec(source)?.[1] ?? "";
    expect(table).toMatch(/"hindi-punct": "hindi-punct"/);
    expect(table).toMatch(/"hindi-light-tts": "hindi-light-tts"/);
    // The kernel prints the lines this table is keyed by.
    const runtime = read("kernel/voice_runtime.py");
    expect(runtime).toContain("OPTIONAL hindi-punct optional - not installed");
    expect(runtime).toContain("{tts_hindi_light.MODEL_DIR} optional - not installed");
    expect(read("kernel/tts_hindi_light.py")).toContain('MODEL_DIR = "hindi-light-tts"');
  });
});

describe("neither is on the default path", () => {
  it("the Hindi ear punctuates through the optional module only, and Supertonic is the default engine", () => {
    expect(read("kernel/hindi_ear.py")).toMatch(/hindi_punct\.apply\(text\)/);
    const runtime = read("kernel/voice_runtime.py");
    expect(runtime).toContain('DEFAULT_ENGINE = "supertonic-3"');
    expect(runtime).toMatch(/asked == HINDI_LIGHT_ENGINE/);
  });

  it("adds no forbidden voice dependency and keeps the one new package optional", () => {
    const capabilities = read("kernel/requirements-capabilities.txt");
    expect(capabilities).toMatch(/^sentencepiece>=0\.2\.3$/m);
    for (const forbidden of ["torch", "vllm", "vosk", "piper-tts", "kokoro-onnx", "sherpa-onnx"]) {
      expect(capabilities.toLowerCase()).not.toMatch(new RegExp(`^${forbidden}\\b`, "m"));
    }
    for (const file of ["kernel/hindi_punct.py", "kernel/tts_hindi_light.py"]) {
      expect(read(file), file).not.toMatch(
        /^\s*(import|from)\s+(torch|punctuators|vosk|sherpa_onnx)\b/m,
      );
    }
    const required = read("kernel/requirements.txt");
    expect(required).not.toMatch(/sentencepiece/);
  });

  it("registers sentencepiece once as an optional pip row in the toolchain and the Install Manager catalogue", () => {
    const toolchain = read("electron/toolchain.cjs");
    expect(toolchain.match(/T\("sentencepiece", "Voice"/g)).toHaveLength(1);
    expect(toolchain).toMatch(/pipDist: "sentencepiece",\s*pip: "sentencepiece"/);
    const catalog = read("src/lib/friday/catalog.ts");
    const row = catalog.slice(catalog.indexOf('"sentencepiece"'), catalog.indexOf('"pyrnnoise"'));
    expect(catalog.match(/^\s*"sentencepiece",$/gm)).toHaveLength(1);
    expect(row).toContain("https://pypi.org/project/sentencepiece/");
    expect(row).toContain('"pip"');
    expect(row).toContain('"optional"');
  });
});
