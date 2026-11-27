/**
 * FRIDAY Ear Hinglish Pro: the source pin, the `ct2-int8` recipe of the voice pack builder, and the pack rows. No
 * network and no Python run here: the downloader and the converter are injected, so the build is proven on small
 * files whose hashes the test computes itself.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");

type Row = { sha256: string; bytes: number };
type From = {
  pin: string;
  file: string;
  recipe: string;
  recipeVersion: number;
  derivedSha256?: string;
};
type Asset = {
  fridayId: string;
  fridayName: string;
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  parts: number;
  from: From;
};
type Pin = {
  revision: string;
  license: string;
  licenseRecord?: Record<string, unknown>;
  files: Record<string, Row>;
};
type Manifest = {
  pack: string;
  fridayName?: string;
  revision: string;
  repository: string;
  tag: string;
  title: string;
  partBytes: number;
  packs: { id: string; models?: string[] }[];
  assets: Asset[];
};
type Step = { pin: string; recipe: string; recipeVersion: number; files: string[] };
type Built = {
  files: string[];
  steps?: Step[];
  rows: { file: string; bytes: number; sha256: string }[];
};
type Download = (
  url: string,
  dest: string,
  options: { sha256: string; needBytes: number; label: string },
) => Promise<number>;
type ConvertCall = { python: string; source: string; out: string; quantization: string };

const pack = require_("../../scripts/build-friday-models.cjs") as {
  RECIPES: string[];
  CT2_OUTPUTS: string[];
  readManifest: () => Manifest;
  manifestProblems: (manifest: unknown, pins: Record<string, Pin>) => string[];
  packAssets: (manifest: Manifest, packId: string, sources: unknown) => Asset[];
  conversionsOf: (model: { fridayId: string; assets: Asset[] }) => Step[];
  modelsOf: (
    manifest: unknown,
  ) => { fridayId: string; fridayName: string; pin: string; assets: Asset[] }[];
  noticeLine: (model: unknown, pin: unknown) => string;
  buildPack: (options: Record<string, unknown>) => Promise<Built>;
};
const voicePins = require_("../../electron/voice-pins.cjs") as {
  PINS: Record<string, Pin>;
  LICENCES: Record<string, unknown>;
  bundleAllowed: (pin: unknown) => boolean;
  manifestFor: (
    repo: string,
  ) => { decodeLanguage?: string; diskBytes: number; license: string } | null;
};

const weights = require_("../../electron/voice-weights.cjs") as { pinnedJobs: () => unknown[] };
const APEX = "Oriserve/Whisper-Hindi2Hinglish-Apex";
const ID = "friday-ear-hinglish-pro";
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const manifest = pack.readManifest();
const mine = manifest.assets.filter((a) => a.fridayId === ID);

describe("the Apex source pin", () => {
  const pin = voicePins.PINS[APEX]!;

  it("is pinned at a full revision with a full hash and a size for every file", () => {
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.files).sort()).toEqual([
      "README.md",
      "added_tokens.json",
      "config.json",
      "generation_config.json",
      "model.safetensors",
      "preprocessor_config.json",
      "tokenizer.json",
      "vocab.json",
    ]);
    for (const [name, row] of Object.entries(pin.files)) {
      expect(row.sha256, name).toMatch(HEX64);
      expect(Number.isInteger(row.bytes) && row.bytes > 0, name).toBe(true);
    }
    expect(pin.files["model.safetensors"]!.bytes).toBe(1617825448);
  });

  it("carries a licence the bundle gate allows, and its card travels with the weights", () => {
    expect(pin.license).toBe("Apache-2.0");
    expect(voicePins.bundleAllowed(pin)).toBe(true);
    expect(pin.files["README.md"]).toBeTruthy();
  });

  it("records the language token en for Hinglish in its facts", () => {
    const facts = voicePins.manifestFor(APEX)!;
    expect(facts.decodeLanguage).toBe("en");
    expect(facts.diskBytes).toBe(Object.values(pin.files).reduce((n, r) => n + r.bytes, 0));
  });
});

describe("the pack rows of FRIDAY Ear Hinglish Pro", () => {
  it("joins the voice pack as one model with a FRIDAY name and no other pack lists it", () => {
    const packs = manifest.packs.filter((p) => (p.models ?? []).includes(ID));
    expect(packs.map((p) => p.id)).toEqual(["voice-weights"]);
    expect(mine.length).toBe(8);
    for (const a of mine) {
      expect(a.fridayName).toBe("FRIDAY Ear Hinglish Pro");
      expect(a.file).toBe(`${ID}--${a.path}`);
      expect(a.sha256).toMatch(HEX64);
      expect(a.parts).toBe(1);
    }
    expect(
      pack
        .packAssets(manifest, "voice-weights", { helperJobs: weights.pinnedJobs() })
        .filter((a) => a.fridayId === ID),
    ).toHaveLength(8);
  });

  it("converts three files with the ct2-int8 recipe, pins each derived hash, and copies the rest", () => {
    expect(pack.RECIPES).toContain("ct2-int8");
    const converted = mine.filter((a) => a.from.recipe === "ct2-int8");
    expect(converted.map((a) => a.path).sort()).toEqual([
      "config.json",
      "model.bin",
      "vocabulary.json",
    ]);
    for (const a of converted) {
      expect(a.from.recipeVersion).toBeGreaterThanOrEqual(1);
      expect(a.from.derivedSha256).toBe(a.sha256);
      expect(pack.CT2_OUTPUTS).toContain(a.path);
    }
    const pin = voicePins.PINS[APEX]!;
    for (const a of mine.filter((row) => row.from.recipe === "copy")) {
      expect(pin.files[a.from.file], a.path).toEqual({ sha256: a.sha256, bytes: a.bytes });
    }
    const bin = converted.find((a) => a.path === "model.bin")!;
    expect(bin.from.file).toBe("model.safetensors");
    expect(bin.bytes).toBeLessThan(manifest.partBytes);
  });

  it("is sound against the pin table and covers every file of the pin", () => {
    expect(pack.manifestProblems(manifest, voicePins.PINS)).toEqual([]);
    const listed = new Set(mine.map((a) => a.from.file));
    for (const name of Object.keys(voicePins.PINS[APEX]!.files))
      expect(listed.has(name), name).toBe(true);
  });

  it("states in its notice line that the copy is converted, and keeps the licence duty", () => {
    const model = pack.modelsOf(manifest).find((m) => m.fridayId === ID)!;
    const line = pack.noticeLine(model, voicePins.PINS[APEX]);
    expect(line).toContain("converted with the ct2-int8 recipe (version 1)");
    expect(line).not.toContain("unmodified copy");
    expect(line).toContain("Apache-2.0");
  });

  it("refuses a derived hash that is not the asset's own, and a ct2-int8 file the converter never writes", () => {
    const wrong = clone(manifest);
    wrong.assets.find((a) => a.fridayId === ID && a.path === "model.bin")!.from.derivedSha256 =
      "1".repeat(64);
    expect(pack.manifestProblems(wrong, voicePins.PINS).join("\n")).toContain("derived SHA-256");
    const odd = clone(manifest);
    odd.assets.find((a) => a.fridayId === ID && a.path === "model.bin")!.path = "../escape.bin";
    expect(pack.manifestProblems(odd, voicePins.PINS).join("\n")).toContain(
      "ct2-int8 asset must be one of",
    );
  });
});

describe("the dry run", () => {
  it("lists the conversion step, fetches nothing and writes nothing", async () => {
    const lines: string[] = [];
    let calls = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hp-dry-"));
    try {
      const out = await pack.buildPack({
        manifest: { ...manifest, assets: mine, partBytes: manifest.partBytes },
        pins: voicePins.PINS,
        gate: voicePins.bundleAllowed,
        outDir: path.join(dir, "out"),
        dryRun: true,
        download: async () => {
          calls += 1;
          return 0;
        },
        log: (line: string) => lines.push(line),
      });
      expect(calls).toBe(0);
      expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
      expect(out.steps).toEqual([
        {
          fridayId: ID,
          pin: APEX,
          recipe: "ct2-int8",
          recipeVersion: 1,
          files: ["config.json", "model.bin", "vocabulary.json"],
        },
      ]);
      expect(lines.join("\n")).toMatch(
        /would convert Oriserve\/Whisper-Hindi2Hinglish-Apex with ct2-int8/,
      );
      expect(lines.join("\n")).toContain("kernel/voice_merge.py convert");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ct2-int8 build with a fake downloader and a fake converter", () => {
  const sourceFiles: Record<string, Buffer> = {
    "model.safetensors": Buffer.from("weights-bf16"),
    "config.json": Buffer.from('{"decoder_layers":4}'),
    "vocab.json": Buffer.from('{"a":0}'),
    "tokenizer.json": Buffer.from("tok"),
  };
  const converted: Record<string, Buffer> = {
    "model.bin": Buffer.from("ct2-weights-int8"),
    "config.json": Buffer.from('{"ct2":true}'),
    "vocabulary.json": Buffer.from('["a"]'),
  };
  const PIN = "someone/apex-like";
  const fakePins = (): Record<string, Pin> => ({
    [PIN]: {
      revision: "a".repeat(40),
      license: "Apache-2.0",
      licenseRecord: voicePins.PINS[APEX]!.licenseRecord!,
      files: Object.fromEntries(
        Object.entries(sourceFiles).map(([n, b]) => [n, { sha256: sha(b), bytes: b.length }]),
      ),
    },
  });
  const fakeManifest = (tamper = false): Manifest => {
    const asset = (p: string, from: string, recipe: string): Asset => {
      const data = recipe === "copy" ? sourceFiles[from]! : converted[p]!;
      const derived = sha(tamper && p === "model.bin" ? Buffer.from("different") : data);
      return {
        fridayId: "friday-ear-fake",
        fridayName: "FRIDAY Ear Fake",
        path: p,
        file: `friday-ear-fake--${p}`,
        sha256: recipe === "copy" ? sha(data) : derived,
        bytes: recipe === "copy" ? data.length : tamper && p === "model.bin" ? 9 : data.length,
        parts: 1,
        from: {
          pin: PIN,
          file: from,
          recipe,
          recipeVersion: 1,
          ...(recipe === "copy" ? {} : { derivedSha256: derived }),
        },
      };
    };
    return {
      pack: "voice-weights",
      fridayName: "FRIDAY Voice Weights",
      revision: "2026.11.1",
      repository: "devendrarj25/FRIDAY-AI-ASSISTANT",
      tag: "friday-voice-weights-2026.11.1",
      title: "FRIDAY Voice Weights 2026.11.1",
      partBytes: 1_900_000_000,
      packs: [],
      assets: [
        asset("model.bin", "model.safetensors", "ct2-int8"),
        asset("config.json", "config.json", "ct2-int8"),
        asset("vocabulary.json", "vocab.json", "ct2-int8"),
        asset("tokenizer.json", "tokenizer.json", "copy"),
      ],
    };
  };
  const run = async (m: Manifest, outDir: string) => {
    const fetched: string[] = [];
    const convertCalls: ConvertCall[] = [];
    const download: Download = async (url, dest, options) => {
      expect(options.sha256).toMatch(HEX64);
      const bytes = sourceFiles[decodeURIComponent(url.split("/").pop()!)];
      fetched.push(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes!);
      return bytes!.length;
    };
    const convert = (call: ConvertCall) => {
      convertCalls.push(call);
      for (const name of Object.keys(sourceFiles))
        expect(fs.existsSync(path.join(call.source, name)), name).toBe(true);
      fs.mkdirSync(call.out, { recursive: true });
      for (const [name, data] of Object.entries(converted))
        fs.writeFileSync(path.join(call.out, name), data);
    };
    const out = await pack.buildPack({
      manifest: m,
      pins: fakePins(),
      gate: voicePins.bundleAllowed,
      outDir,
      download,
      convert,
      python: "py-test",
    });
    return { out, fetched, convertCalls };
  };

  it("fetches the source once, converts once, checks the hashes and removes the work folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hp-build-"));
    try {
      const { out, fetched, convertCalls } = await run(fakeManifest(), dir);
      expect(convertCalls).toHaveLength(1);
      expect(convertCalls[0]!.python).toBe("py-test");
      expect(convertCalls[0]!.quantization).toBe("int8");
      expect(fetched.some((u) => u.includes(`/resolve/${"a".repeat(40)}/model.safetensors`))).toBe(
        true,
      );
      for (const [name, data] of Object.entries(converted))
        expect(fs.readFileSync(path.join(dir, `friday-ear-fake--${name}`))).toEqual(data);
      expect(out.rows.map((r) => r.file).sort()).toEqual([
        "friday-ear-fake--config.json",
        "friday-ear-fake--model.bin",
        "friday-ear-fake--tokenizer.json",
        "friday-ear-fake--vocabulary.json",
      ]);
      expect(fs.readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a converted file whose hash differs from the pinned one and leaves no such file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hp-bad-"));
    try {
      await expect(run(fakeManifest(true), dir)).rejects.toThrow(
        /converted file does not match its pinned SHA-256 \(recipe ct2-int8 version 1/,
      );
      expect(fs.existsSync(path.join(dir, "friday-ear-fake--model.bin"))).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second run keeps the checked files and converts nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hp-again-"));
    try {
      await run(fakeManifest(), dir);
      const second = await run(fakeManifest(), dir);
      expect(second.convertCalls).toHaveLength(0);
      expect(second.fetched).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the converter command", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "build-friday-models.cjs"), "utf8");

  it("runs kernel/voice_merge.py convert isolated, without a shell, and the entry exists", () => {
    expect(script).toMatch(/execFileSync\(/);
    expect(script).toMatch(
      /\["-I", CT2_SCRIPT, "convert", source, out, "--quantization", quantization\]/,
    );
    expect(script).toContain('path.join(root, "kernel", "voice_merge.py")');
    const kernel = fs.readFileSync(path.join(root, "kernel", "voice_merge.py"), "utf8");
    expect(kernel).toContain('argv[0] == "convert"');
    expect(kernel).toContain("--quantization");
  });

  it("takes the python from --python when the owner gives one", () => {
    const { parseArgs } = pack as unknown as { parseArgs: (a: string[]) => { python: string } };
    expect(parseArgs(["--pack", "voice-weights", "--python", "C:\\py\\python.exe"]).python).toBe(
      "C:\\py\\python.exe",
    );
    expect(parseArgs(["--pack", "voice-weights"]).python).toBe("");
  });
});
