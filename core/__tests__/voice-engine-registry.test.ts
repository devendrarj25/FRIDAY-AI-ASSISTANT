/**
 * The voice engine registry: one table for every speech engine, kept equal to the pins, honest about what is usable,
 * and the source of the TTS ladder order. No audio, no model, no network.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VOICE_ENGINES,
  allowedSpeechSizes,
  chainFor,
  defaultEngines,
  engineFacts,
  isUsable,
  notYetUsable,
  ownerDecisions,
  speechSizeLadder,
  ttsLadderOrder,
  unusableReason,
  voiceEngineById,
  type ChainFacts,
} from "../../src/lib/friday/voice-engine/voice-engine-registry";
import { VOICE_CHAINS } from "../../src/lib/friday/voice-engine/voice-engine-table";
import { TTS_INFO } from "../../src/lib/friday/voice-engine/tts-provider";

const require_ = createRequire(import.meta.url);
const pins = require_("../../electron/voice-pins.cjs") as {
  PINS: Record<string, { license: string; files: Record<string, { bytes: number }> }>;
  SELF_TESTS: Record<string, { kind: string; wrapper: string | null }>;
  pinForRepo: (repo: string) => unknown;
};
const weights = require_("../../electron/voice-weights.cjs") as {
  modelRegistry: () => { catalogId: string; repo: string | null }[];
  manifestOf: (id: string) => Record<string, unknown> | null;
  EXTRA_MODELS: { catalogId: string; repo: string }[];
};
const ROOT = path.resolve(__dirname, "..", "..");

const pc = (ram: number, free: number, vram = 0, cudaRuntimeReady = false): ChainFacts => ({
  hardware: {
    cpuThreads: 8,
    ramTotalGb: ram,
    ramAvailableGb: free,
    ...(vram ? { vramGb: vram, gpuName: "any gpu" } : {}),
    diskFreeGb: 200,
  },
  cudaRuntimeReady,
});
const ids = (list: { id: string }[]) => list.map((row) => row.id);

describe("the table is the pins", () => {
  it("every pinned repository has exactly one registry row, and every pinned row names a real pin", () => {
    const owners = new Map<string, string[]>();
    for (const engine of VOICE_ENGINES) {
      if (!engine.pinRepo) continue;
      expect(pins.pinForRepo(engine.pinRepo), engine.id).toBeTruthy();
      owners.set(engine.pinRepo, [...(owners.get(engine.pinRepo) ?? []), engine.id]);
    }
    expect(Object.keys(pins.PINS).sort()).toEqual([...owners.keys()].sort());
    for (const [repo, rows] of owners) expect(rows, repo).toHaveLength(1);
  });

  it("memory, disk, CPU and GPU numbers of a pinned engine equal FACTS and the summed pinned bytes", () => {
    const registered = new Set(weights.modelRegistry().map((row) => row.catalogId));
    for (const engine of VOICE_ENGINES.filter((row) => row.pinRepo)) {
      expect(registered.has(engine.id), engine.id).toBe(true);
      const node = weights.manifestOf(engine.id)!;
      const web = engineFacts(engine)!;
      for (const key of Object.keys(web) as (keyof typeof web)[]) {
        expect(web[key], `${engine.id}.${key}`).toEqual(node[key]);
      }
    }
  });

  it("every model the weights registry lists (a speech size, an ear, a voice, a helper) is a registry row", () => {
    for (const row of weights.modelRegistry()) {
      expect(voiceEngineById.has(row.catalogId), row.catalogId).toBe(true);
    }
  });

  it("the licence of the weights names the pinned licence", () => {
    for (const engine of VOICE_ENGINES.filter((row) => row.pinRepo)) {
      const pinned = pins.PINS[engine.pinRepo!]!.license;
      expect(engine.weightLicence, engine.id).toContain(pinned);
    }
  });

  it("the Whisper sizes and the budget ladder are the same sizes", () => {
    expect(speechSizeLadder()).toEqual([
      "tiny",
      "base",
      "small",
      "medium",
      "large-v3",
      "large-v3-turbo",
    ]);
    const big = allowedSpeechSizes({ ...pc(64, 48, 24, true) });
    expect(big).toEqual(speechSizeLadder().filter((size) => size !== "large-v3"));
  });
});

describe("usable means a wrapper and a self-test, never a hope", () => {
  it("the wrapper files exist in this repository", () => {
    for (const engine of VOICE_ENGINES.filter((row) => row.wrapper)) {
      expect(
        fs.existsSync(path.join(ROOT, engine.wrapper!)),
        `${engine.id}: ${engine.wrapper}`,
      ).toBe(true);
    }
  });

  it("status and usability never disagree", () => {
    for (const engine of VOICE_ENGINES) {
      if (engine.status === "installed-by-default") {
        expect(isUsable(engine), engine.id).toBe(true);
      }
      if (engine.status === "candidate-runtime-missing") {
        expect(isUsable(engine), engine.id).toBe(false);
        expect(engine.blockedBy.length, engine.id).toBeGreaterThan(30);
      }
      if (isUsable(engine)) {
        expect(engine.wrapper && engine.selfTest, engine.id).toBeTruthy();
      } else {
        expect(unusableReason(engine), engine.id).not.toBe("");
      }
      if (engine.status === "optional-pinned") expect(engine.pinRepo, engine.id).toBeTruthy();
    }
  });

  it("the new optional pins are pinned and self-tested but not usable, and say why", () => {
    for (const id of [
      "denoise-dpdfnet",
      "denoise-gtcrn",
      "speaker-wespeaker",
      "hindi-vaani-ear",
      "stream-ear-nemotron",
      "hinglish-ear-trelis",
    ]) {
      const engine = voiceEngineById.get(id)!;
      expect(engine.status, id).toBe("optional-pinned");
      expect(engine.selfTest, id).toBe(true);
      expect(isUsable(engine), id).toBe(false);
      const test = pins.SELF_TESTS[engine.pinRepo!]!;
      expect(test.wrapper, id).toBe(engine.wrapper);
    }
    expect(Object.keys(pins.SELF_TESTS).sort()).toEqual(
      [
        "Ceva-IP/DPDFNet",
        "TigreGotico/audiosronnx-gtcrn",
        "bjollans/whisper-large-v3-vaani-hindi-ct2",
        "nikh360pro/capsbro-hinglish-ct2",
        "onnx-community/wespeaker-voxceleb-resnet34-LM",
        "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8",
      ].sort(),
    );
    expect(weights.EXTRA_MODELS.map((row) => row.catalogId)).toEqual(
      expect.arrayContaining([
        "denoise-dpdfnet",
        "denoise-gtcrn",
        "speaker-wespeaker",
        "hindi-vaani-ear",
        "stream-ear-nemotron",
        "hinglish-ear-trelis",
      ]),
    );
  });

  it("the light Hindi voice already has its runtime, so it is optional-pinned and usable", () => {
    const light = voiceEngineById.get("hindi-light-tts")!;
    expect(light.status).toBe("optional-pinned");
    expect(isUsable(light)).toBe(true);
    expect(light.flags).toContain("cc-by-credit");
  });

  it("the candidates list exact files whose sizes add up to their disk number, and are not usable", () => {
    const wanted = [
      "qwen3-asr-0.6b-gguf",
      "qwen3-asr-1.7b-gguf",
      "voxtral-mini-4b-realtime-gguf",
      "chatterbox-multilingual-onnx",
      "chatterbox-multilingual-gguf",
      "kokoro-82m-hindi-onnx",
    ];
    for (const id of wanted) {
      const engine = voiceEngineById.get(id)!;
      expect(engine.status, id).toBe("candidate-runtime-missing");
      expect(engine.pinRepo, id).toBeNull();
      expect(engine.files!.length, id).toBeGreaterThan(1);
      expect(
        engine.files!.reduce((sum, f) => sum + f.bytes, 0),
        id,
      ).toBe(engineFacts(engine)!.diskBytes);
      expect(engineFacts(engine)!.basis, id).toBe("estimated");
      expect(engine.repo, id).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
    expect(voiceEngineById.get("voxtral-mini-4b-realtime-gguf")).toMatchObject({
      streaming: true,
      publishedWer: [{ dataset: expect.stringContaining("Fleurs"), wer: 0.1288 }],
    });
    expect(voiceEngineById.get("kokoro-82m-hindi-onnx")!.blockedBy).toMatch(
      /eSpeak NG \(GPL-3\.0\)/,
    );
    expect(voiceEngineById.get("kokoro-82m-hindi-onnx")!.blockedBy).toMatch(
      /kokoro-onnx pip package is forbidden/,
    );
    for (const row of notYetUsable()) expect(row.why.length, row.id).toBeGreaterThan(20);
  });

  it("the vaani repository's published WER is recorded, as the publisher's and not FRIDAY's", () => {
    const vaani = voiceEngineById.get("hindi-vaani-ear")!;
    expect(vaani.publishedWer!.map((row) => row.dataset)).toContain("Fleurs (hi)");
    expect(vaani.blockedBy).toMatch(/CANDIDATE, not a default/);
    expect(vaani.blockedBy).toMatch(/tokenizer\.json/);
    for (const lang of ["hi", "en", "hinglish"] as const) {
      expect(ids(chainFor("stt", lang, pc(64, 48, 24, true)).order)).not.toContain(
        "hindi-vaani-ear",
      );
    }
  });
});

describe("what the table says for every engine", () => {
  it("names Hindi yes or no for every speech, text, turn and language engine", () => {
    for (const engine of VOICE_ENGINES) {
      if (["denoise", "speaker", "wake"].includes(engine.role)) continue; // signal-level: nobody measured Hindi
      expect(["yes", "no"], engine.id).toContain(engine.languages.hi);
    }
  });

  it("keeps the voice stack torch-free and never names a forbidden package as its runtime", () => {
    const banned = /\b(torch|vllm|vosk|piper-tts|kokoro-onnx|sherpa-onnx|silero-vad pip)\b/i;
    for (const engine of VOICE_ENGINES) {
      expect(engine.torchFree, engine.id).toBe(true);
      expect(banned.test(`${engine.runtime} ${engine.wrapper ?? ""}`), engine.id).toBe(false);
    }
  });

  it("carries the owner-decision flags the research found", () => {
    const flags = (id: string) => voiceEngineById.get(id)!.flags;
    expect(flags("supertonic-3")).toContain("openrail-m");
    expect(flags("openwakeword")).toContain("cc-by-nc");
    expect(flags("fasttext-lid218")).toContain("cc-by-nc");
    expect(flags("indicconformer-600m-multilingual")).toContain("gated");
    expect(flags("kokoro-82m-hindi-onnx")).toContain("gpl-separate-process");
    expect(voiceEngineById.get("speaker-wespeaker")!.weightLicence).toMatch(/CC-BY-4\.0/);
    const decided = ownerDecisions().map((row) => row.id);
    expect(decided).toEqual(
      expect.arrayContaining(["supertonic-3", "openwakeword", "indicconformer-600m-multilingual"]),
    );
  });

  it("covers every role", () => {
    const roles = new Set(VOICE_ENGINES.map((engine) => engine.role));
    for (const role of [
      "stt",
      "tts",
      "vad",
      "turn",
      "wake",
      "speaker",
      "langid",
      "denoise",
      "punct",
    ]) {
      expect(roles.has(role as never), role).toBe(true);
    }
    for (const [role, byLang] of Object.entries(VOICE_CHAINS)) {
      for (const [lang, chain] of Object.entries(byLang!)) {
        for (const id of chain!) {
          expect(voiceEngineById.get(id)?.role, `${role}/${lang}/${id}`).toBe(role);
        }
      }
    }
    expect(new Set(VOICE_ENGINES.map((engine) => engine.id)).size).toBe(VOICE_ENGINES.length);
    expect(defaultEngines().length).toBeGreaterThan(8);
  });
});

describe("the fallback chain per role and language", () => {
  it("is the TTS ladder in tts-provider.ts today: online, light Hindi, Supertonic, system, rule voice", () => {
    expect(ttsLadderOrder()).toEqual(["edge", "hindi-light", "supertonic", "sapi", "formant"]);
    for (const info of Object.values(TTS_INFO)) {
      const row = VOICE_ENGINES.find((engine) => engine.ladderId === info.id)!;
      expect(row, info.id).toBeTruthy();
      expect(row.role).toBe("tts");
      expect(row.runtime === "cloud", info.id).toBe(info.privacy === "cloud");
      const spoken: readonly string[] = info.languages;
      const speaks = (lang: "hi" | "en") => spoken.includes("*") || spoken.includes(lang);
      expect(row.languages.hi === "yes", `${info.id} hi`).toBe(speaks("hi"));
      expect(row.languages.en === "yes", `${info.id} en`).toBe(speaks("en"));
    }
  });

  it("leaves a candidate out with its reason and keeps Hindi first for Hindi", () => {
    const result = chainFor("stt", "hi", pc(16, 10));
    expect(result.order[0]!.id).toBe("hindi-ear");
    for (const id of ["hindi-vaani-ear", "voxtral-mini-4b-realtime-gguf", "qwen3-asr-1.7b-gguf"]) {
      expect(result.order.map((row) => row.id)).not.toContain(id);
      expect(result.blocked.find((row) => row.id === id)?.why.length, id).toBeGreaterThan(20);
    }
  });

  it("trims Whisper sizes by the speech budget: a small PC never gets the large ones, a big one is led by the largest allowed", () => {
    const small = chainFor("stt", "en", pc(8, 5));
    expect(ids(small.order)).toContain("faster-whisper-base");
    expect(ids(small.order)).not.toContain("faster-whisper-large-v3-turbo");
    expect(small.blocked.find((row) => row.id === "faster-whisper-large-v3-turbo")?.why).toMatch(
      /budget/,
    );
    const big = chainFor("stt", "en", pc(32, 24, 12, true));
    expect(big.order[0]!.id).toBe("faster-whisper-large-v3-turbo");
    expect(ids(big.order)).not.toContain("faster-whisper");
    expect(big.blocked.find((row) => row.id === "faster-whisper")?.why).toMatch(/owner locks it/);
  });

  it("reads numbers, never a GPU name", () => {
    const a = pc(32, 24, 12, true);
    const b: ChainFacts = {
      ...a,
      hardware: { ...a.hardware, gpuName: "a card nobody has heard of" },
    };
    expect(chainFor("stt", "hi", b)).toEqual(chainFor("stt", "hi", a));
    expect(chainFor("stt", "hi", pc(32, 24, 12, false))).not.toEqual(chainFor("stt", "hi", a));
  });

  it("drops an engine that is not installed when the caller knows what is, but never a built-in one", () => {
    const result = chainFor("tts", "en", { ...pc(16, 10), installed: new Set(["supertonic-3"]) });
    expect(ids(result.order)).toEqual(["edge-tts", "supertonic-3", "sapi", "formant"]);
    const none = chainFor("tts", "hi", { ...pc(16, 10), installed: new Set() });
    expect(none.blocked.find((row) => row.id === "hindi-light-tts")?.why).toBe("not installed");
    expect(ids(none.order)).toEqual(["edge-tts", "sapi", "formant"]);
  });

  it("refuses an engine that does not speak the language, and says unverified out loud", () => {
    const hindi = chainFor("stt", "hi", pc(16, 10));
    expect(ids(hindi.order)).not.toContain("moonshine-en");
    const hinglish = chainFor("stt", "hinglish", pc(16, 10));
    expect(hinglish.order[0]!.id).toBe("hinglish-ear");
    expect(hinglish.order.find((row) => row.id === "hindi-ear")!.languageSupport).toBe(
      "unverified",
    );
    expect(chainFor("denoise", "en", pc(16, 10)).order.map((row) => row.id)).toEqual(["rnnoise"]);
    expect(chainFor("wake", "en", pc(16, 10)).order.map((row) => row.id)).toEqual([
      "transcript-wake",
    ]);
    expect(chainFor("tts", "en", pc(16, 10)).blocked.map((row) => row.id)).toContain(
      "chatterbox-multilingual-onnx",
    );
  });

  it("a PC with almost no memory still keeps the engines that need none", () => {
    const tiny = chainFor("tts", "hi", pc(2, 0.6));
    expect(ids(tiny.order)).toEqual(expect.arrayContaining(["sapi", "formant"]));
  });

  it("Moonshine is the English streaming ear setup really installs, and the row says so truthfully", () => {
    const engine = voiceEngineById.get("moonshine-en")!;
    expect(engine.status).toBe("installed-by-default");
    expect(isUsable(engine)).toBe(true);
    expect(engine.runtime).toBe("python-package");
    expect(engine.wrapper).toBe("kernel/stt.py");
    expect(engine.label).toContain("tiny streaming");
    expect(engine.blockedBy).toBe("");
    expect(engine.languages).toEqual({ hi: "no", en: "yes", hinglish: "no" });
    // The row matches the code that runs it: the package is required, the kernel reports this model name.
    const requirements = fs.readFileSync(
      path.join(ROOT, "kernel/requirements-capabilities.txt"),
      "utf8",
    );
    expect(requirements).toMatch(/^moonshine-voice>=/m);
    const stt = fs.readFileSync(path.join(ROOT, "kernel/stt.py"), "utf8");
    // The English rung names the package model, or the own Quick ear's model when that one answered.
    expect(stt).toContain('"model": own_model or "moonshine-tiny-streaming"');
    expect(stt).toContain('"moonshine-en", "moonshine-tiny-streaming"');
    expect(ids(chainFor("stt", "en", pc(16, 10)).order)).toContain("moonshine-en");
    expect(chainFor("stt", "hi", pc(16, 10)).order.map((row) => row.id)).not.toContain(
      "moonshine-en",
    );
  });
});

describe("FRIDAY Ear Hinglish Pro installs from the converted release files and never from its source", () => {
  type Plan = {
    bytes: number;
    tag: string;
    files: { name: string; sha256: string; bytes: number; parts: { url: string }[] }[];
  };
  type Check = { id: string; ok: boolean; detail: string };
  const derived = require_("../../electron/voice-weights.cjs") as {
    DERIVED_EARS: { catalogId: string; repo: string; needs: string[] }[];
    NEEDS_RELEASE: string;
    modelRegistry: () => { catalogId: string; repo: string | null; derivedFrom?: string }[];
    manifestOf: (id: string) => Record<string, unknown> | null;
    derivedEarPlan: (id: string, deps?: Record<string, unknown>) => Plan | null;
    derivedEarPin: (
      id: string,
      deps?: Record<string, unknown>,
    ) => { files: Record<string, { sha256: string; bytes: number }> } | null;
    derivedEarState: (
      root: string,
      id: string,
      deps?: Record<string, unknown>,
    ) => { state: string; text: string; sources: { kind: string; repo: string }[] };
    withFridayRelease: (sources: unknown[], deps?: Record<string, unknown>) => { kind: string }[];
    voiceModelsOnDisk: (root: string, exists: (file: string) => boolean) => { catalogId: string }[];
    pinChecks: (root: string, deps?: Record<string, unknown>) => Promise<Check[]>;
    folderChecks: (root: string, deps?: Record<string, unknown>) => Promise<Check[]>;
    pinSelfTests: (root: string, deps?: Record<string, unknown>) => Promise<Check[]>;
  };
  const APEX = "Oriserve/Whisper-Hindi2Hinglish-Apex";
  const ID = "hinglish-ear-pro";
  const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
  const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "friday-hp-install-"));

  // A small stand-in for the pin and its release pack: the same shape, tiny bytes, hashes the test computes itself.
  const source: Record<string, Buffer> = {
    "README.md": Buffer.from("card"),
    "model.safetensors": Buffer.from("bf16-weights"),
    "config.json": Buffer.from('{"layers":4}'),
    "vocab.json": Buffer.from('{"a":0}'),
    "tokenizer.json": Buffer.from("tok"),
    "preprocessor_config.json": Buffer.from("{}"),
  };
  const out: Record<string, Buffer> = {
    "model.bin": Buffer.from("ct2-int8-weights"),
    "config.json": Buffer.from('{"ct2":true}'),
    "vocabulary.json": Buffer.from('["a"]'),
    "README.md": source["README.md"]!,
    "tokenizer.json": source["tokenizer.json"]!,
    "preprocessor_config.json": source["preprocessor_config.json"]!,
  };
  const FROM: Record<string, string> = {
    "model.bin": "model.safetensors",
    "config.json": "config.json",
    "vocabulary.json": "vocab.json",
    "README.md": "README.md",
    "tokenizer.json": "tokenizer.json",
    "preprocessor_config.json": "preprocessor_config.json",
  };
  const CONVERTED = new Set(["model.bin", "config.json", "vocabulary.json"]);
  const fakePin = {
    revision: "a".repeat(40),
    license: "Apache-2.0",
    files: Object.fromEntries(
      Object.entries(source).map(([name, data]) => [
        name,
        { sha256: sha(data), bytes: data.length },
      ]),
    ),
  };
  const asset = (name: string) => ({
    fridayId: "friday-ear-hinglish-pro",
    path: name,
    file: `friday-ear-hinglish-pro--${name}`,
    sha256: sha(out[name]!),
    bytes: out[name]!.length,
    parts: 1,
    from: {
      pin: APEX,
      file: FROM[name],
      recipe: CONVERTED.has(name) ? "ct2-int8" : "copy",
      recipeVersion: 1,
      ...(CONVERTED.has(name) ? { derivedSha256: sha(out[name]!) } : {}),
    },
  });
  const pack = (change?: (assets: ReturnType<typeof asset>[]) => void) => {
    const assets = Object.keys(out).map(asset);
    change?.(assets);
    return {
      pack: "friday-models",
      repository: "devendrarj25/FRIDAY-AI-ASSISTANT",
      tag: "friday-models-2026.11.1",
      partBytes: 1_900_000_000,
      assets,
    };
  };
  const fake = (change?: (assets: ReturnType<typeof asset>[]) => void) => ({
    fridayModels: pack(change),
    pinForRepo: (repo: string) => (repo === APEX ? fakePin : null),
    env: {},
  });
  const stage = (root: string, skip = "") => {
    const dir = path.join(root, "models", ID);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(out))
      if (name !== skip) fs.writeFileSync(path.join(dir, name), data);
    return dir;
  };

  it("is a registry row with no repository to fetch, whose disk is the converted copy", () => {
    const row = derived.modelRegistry().find((item) => item.catalogId === ID)!;
    expect(row.repo).toBeNull();
    expect(row.derivedFrom).toBe(APEX);
    const facts = derived.manifestOf(ID)!;
    const plan = derived.derivedEarPlan(ID)!;
    expect(facts["repo"]).toBeNull();
    expect(facts["sourceRepo"]).toBe(APEX);
    expect(facts["decodeLanguage"]).toBe("en");
    expect(facts["diskBytes"]).toBe(plan.bytes);
    expect(plan.bytes).toBeLessThan(pins.PINS[APEX]!.files["model.safetensors"]!.bytes);
    expect(voiceEngineById.get(ID)!.pinRepo).toBe(APEX);
  });

  it("plans the eight converted files from the release and never the source weights", () => {
    const plan = derived.derivedEarPlan(ID)!;
    expect(plan.files.map((file) => file.name).sort()).toEqual([
      "README.md",
      "added_tokens.json",
      "config.json",
      "generation_config.json",
      "model.bin",
      "preprocessor_config.json",
      "tokenizer.json",
      "vocabulary.json",
    ]);
    for (const needed of derived.DERIVED_EARS[0]!.needs)
      expect(plan.files.some((file) => file.name === needed)).toBe(true);
    const urls = plan.files.flatMap((file) => file.parts.map((part) => part.url));
    expect(urls.length).toBe(8);
    for (const url of urls) {
      expect(url).toContain(`/releases/download/${plan.tag}/friday-ear-hinglish-pro--`);
      expect(url).not.toMatch(/safetensors|huggingface/);
    }
  });

  it("has no plan, and says it needs the release, when a file is missing, changed or the road is off", () => {
    expect(derived.derivedEarPlan(ID, fake())).not.toBeNull();
    const without = fake((assets) => {
      assets.splice(
        assets.findIndex((row) => row.path === "model.bin"),
        1,
      );
    });
    expect(derived.derivedEarPlan(ID, without)).toBeNull();
    const wrongCopy = fake((assets) => {
      assets.find((row) => row.path === "tokenizer.json")!.sha256 = "1".repeat(64);
    });
    expect(derived.derivedEarPlan(ID, wrongCopy)).toBeNull();
    const wrongDerived = fake((assets) => {
      assets.find((row) => row.path === "model.bin")!.from.derivedSha256 = "2".repeat(64);
    });
    expect(derived.derivedEarPlan(ID, wrongDerived)).toBeNull();
    const escape = fake((assets) => {
      assets.find((row) => row.path === "model.bin")!.path = "../model.bin";
    });
    expect(derived.derivedEarPlan(ID, escape)).toBeNull();
    expect(
      derived.derivedEarPlan(ID, { ...fake(), env: { FRIDAY_MODELS_RELEASE: "0" } }),
    ).toBeNull();
    const state = derived.derivedEarState("/friday", ID, without);
    expect(state).toMatchObject({ state: "needs-release", sources: [] });
    expect(state.text).toBe("needs the FRIDAY release (not published yet)");
    expect(derived.NEEDS_RELEASE).toBe(state.text);
  });

  it("offers the release as the only source, and drops the 1.6 GB source from any chain", () => {
    const state = derived.derivedEarState("/friday", ID, { ...fake(), exists: () => false });
    expect(state.state).toBe("release");
    expect(state.sources.map((row) => [row.kind, row.repo])).toEqual([["friday-release", APEX]]);
    expect(state.text).toContain("never fetched");
    const chain = derived.withFridayRelease([
      { kind: "hf-repo", repo: APEX, label: "Hugging Face" },
      { kind: "hf-repo", repo: "Systran/faster-whisper-base", label: "Hugging Face" },
    ]) as { kind: string; repo: string }[];
    // The source is gone and no release source stands in for it; the other repository keeps its own chain.
    expect(JSON.stringify(chain)).not.toContain(APEX);
    expect(chain.every((row) => row.repo === "Systran/faster-whisper-base")).toBe(true);
    expect(chain.some((row) => row.kind === "hf-repo")).toBe(true);
  });

  it("counts as installed only when every release file is on disk", () => {
    const root = temp();
    try {
      const have = (file: string) => fs.existsSync(file);
      expect(derived.derivedEarState(root, ID, { ...fake(), exists: have }).state).toBe("release");
      stage(root, "model.bin");
      expect(derived.derivedEarState(root, ID, { ...fake(), exists: have }).state).toBe("release");
      stage(root);
      expect(derived.derivedEarState(root, ID, { ...fake(), exists: have }).state).toBe(
        "installed",
      );
      expect(derived.derivedEarState(root, ID, { ...fake(), exists: have }).sources).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the folder against the release files, red for a changed file, and marks a passing one", async () => {
    const root = temp();
    try {
      const deps = { ...fake(), exists: (file: string) => fs.existsSync(file), hash: true };
      expect((await derived.pinChecks(root, deps)).map((row) => row.id)).toEqual([]);
      const dir = stage(root);
      const good = (await derived.pinChecks(root, deps)).find(
        (row) => row.id === "hinglish-ear-pro-pin",
      )!;
      expect(good.ok).toBe(true);
      expect(good.detail).toContain("6 files match");
      // The doctor's adopt step writes the marker the kernel reads: the source repository's name, the release files.
      expect(fs.existsSync(path.join(dir, ".friday-pin.json"))).toBe(false);
      await derived.folderChecks(root, { ...deps, adopt: true });
      const marker = JSON.parse(fs.readFileSync(path.join(dir, ".friday-pin.json"), "utf8")) as {
        repo: string;
        files: Record<string, { bytes: number; sha256: string }>;
      };
      expect(marker.repo).toBe(APEX);
      expect(Object.keys(marker.files).sort()).toEqual(Object.keys(out).sort());
      expect(marker.files["model.bin"]).toEqual({
        bytes: out["model.bin"]!.length,
        sha256: sha(out["model.bin"]!),
      });
      fs.writeFileSync(path.join(dir, "model.bin"), "ct2-int8-weightZ");
      const bad = (await derived.pinChecks(root, deps)).find(
        (row) => row.id === "hinglish-ear-pro-pin",
      )!;
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain("model.bin fails SHA-256");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives the Doctor a self-test row that names what is missing, and runs the ct2 folder test once installed", async () => {
    const root = temp();
    try {
      const none = await derived.pinSelfTests(root, {
        ...fake((assets) => assets.splice(0, 1)),
        exists: () => false,
      });
      const row = none.find((entry) => entry.id === `optional-${ID}`)!;
      expect(row).toMatchObject({ ok: true, installId: "" });
      expect(row.detail).toContain("needs the FRIDAY release (not published yet)");
      const waiting = (await derived.pinSelfTests(root, { ...fake(), exists: () => false })).find(
        (entry) => entry.id === `optional-${ID}`,
      )!;
      expect(waiting.detail).toContain("FRIDAY release only");
      stage(root);
      const seen: { catalogId: string; spec: { kind: string; needs: string[] } }[] = [];
      const rows = await derived.pinSelfTests(root, {
        ...fake(),
        exists: (file: string) => fs.existsSync(file),
        runSelfTest: async (input: unknown) => {
          seen.push(input as never);
          return { ok: true, reason: "", detail: "the folder is whole and ctranslate2 imports" };
        },
      });
      expect(rows.find((entry) => entry.id === `selftest-${ID}`)).toMatchObject({
        ok: true,
        required: false,
      });
      expect(seen.filter((entry) => entry.catalogId === ID)[0]!.spec).toMatchObject({
        kind: "ct2-folder",
        needs: derived.DERIVED_EARS[0]!.needs,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists the folder as on disk only with every release file, and no pin points at its source weights", () => {
    const listed = (names: string[]) =>
      derived
        .voiceModelsOnDisk("/friday", (file) =>
          names.some((name) => file.endsWith(`${ID}${path.sep}${name}`)),
        )
        .map((row) => row.catalogId);
    const all = derived.derivedEarPlan(ID)!.files.map((file) => file.name);
    expect(listed(all)).toContain(ID);
    expect(listed(all.filter((name) => name !== "model.bin"))).not.toContain(ID);
    expect(listed(["model.safetensors"])).not.toContain(ID);
  });
});
