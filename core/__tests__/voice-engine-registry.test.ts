/**
 * The voice engine registry: one table for every speech engine, kept equal to the pins, honest about what is usable,
 * and the source of the TTS ladder order. No audio, no model, no network.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
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
      "speaker-wespeaker",
      "hindi-vaani-ear",
      "stream-ear-nemotron",
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
        "bjollans/whisper-large-v3-vaani-hindi-ct2",
        "onnx-community/wespeaker-voxceleb-resnet34-LM",
        "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8",
      ].sort(),
    );
    expect(weights.EXTRA_MODELS.map((row) => row.catalogId)).toEqual(
      expect.arrayContaining([
        "denoise-dpdfnet",
        "speaker-wespeaker",
        "hindi-vaani-ear",
        "stream-ear-nemotron",
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
    expect(voiceEngineById.get("speaker-wespeaker")!.credit).toMatch(/CC-BY-4\.0/);
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
    expect(stt).toContain('"model": "moonshine-tiny-streaming"');
    expect(ids(chainFor("stt", "en", pc(16, 10)).order)).toContain("moonshine-en");
    expect(chainFor("stt", "hi", pc(16, 10)).order.map((row) => row.id)).not.toContain(
      "moonshine-en",
    );
  });
});
