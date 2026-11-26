/**
 * scripts/voice-bench.cjs with fake engines: no model, no audio of a person, no network, no GPU. The recordings are tiny
 * files whose bytes are the text the synthetic manifest hashed; the engines are plain objects.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normaliseTranscript,
  wordCounts,
} from "../../src/lib/friday/voice-engine/transcript-scorer";

const root = join(__dirname, "..", "..");
const fixtures = join(root, "core", "fixtures", "voice-eval");
const req = createRequire(import.meta.url);
const bench = req("../../scripts/voice-bench.cjs") as {
  EXIT: Record<string, number>;
  main: (argv: string[], deps?: Record<string, unknown>) => Promise<number>;
  romanSkeleton: (word: string) => string;
  blockBootstrap: (rows: { block: string; edits: number; words: number }[]) => {
    wer: number;
    blocks: number;
    range: { low: number; high: number } | null;
  };
  findAudio: (dir: string, id: string) => string | null;
  buildListenerForm: (
    clips: { engine: string; lang: string; text: string; audioPath?: string }[],
    options?: { audioFor?: (clip: unknown, code: string) => string },
  ) => {
    form: { items: Record<string, unknown>[] };
    key: Record<string, string>;
  };
};
const evalCli = req("../../scripts/voice-eval.cjs") as {
  main: (argv: string[], out?: (line: string) => void) => Promise<number>;
};

type Item = { id: string; language: string; split: string };
let dir = "";
let manifest = "";
const refs = join(fixtures, "synthetic-references.json");
const references = JSON.parse(readFileSync(refs, "utf8")) as Record<string, string>;
const hypotheses = JSON.parse(
  readFileSync(join(fixtures, "synthetic-hypotheses.json"), "utf8"),
) as Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "voice-bench-"));
  manifest = join(dir, "manifest.json");
  copyFileSync(join(fixtures, "synthetic-manifest.json"), manifest);
  mkdirSync(join(dir, "audio"));
  const items = JSON.parse(readFileSync(manifest, "utf8")).items as Item[];
  for (const item of items)
    writeFileSync(join(dir, "audio", `${item.id}.wav`), `synthetic-audio:${item.id}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const freeze = () => evalCli.main(["freeze", "--manifest", manifest, "--write"], () => {});

/** A fake engine that answers from a table, with fixed timings and memory. */
const engine = (answers: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const calls = { opened: 0, closed: 0, transcribed: [] as string[] };
  return {
    calls,
    available: async () => ({ ok: true }),
    open: async () => {
      calls.opened += 1;
    },
    transcribe: async (file: string, item: { id: string }) => {
      calls.transcribed.push(item.id);
      return {
        text: answers[item.id] ?? "",
        firstPartialMs: 120,
        finalMs: 400,
        rssMb: 512,
        ...extra,
      };
    },
    close: () => {
      calls.closed += 1;
    },
  };
};

async function run(args: string[], deps: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await bench.main(args, {
    out: (line: string) => lines.push(line),
    clock: () => new Date("2026-11-24T10:00:00Z"),
    vramProbe: async () => null,
    ...deps,
  });
  return { code, text: lines.join("\n") };
}
const sttArgs = (engines: string, extra: string[] = []) => [
  "run",
  "--engines",
  engines,
  "--manifest",
  manifest,
  "--references",
  refs,
  "--audio",
  join(dir, "audio"),
  "--out",
  join(dir, "report.json"),
  ...extra,
];

describe("no data, no number", () => {
  it("exits 3 and measures nothing when there is no manifest, references or audio", async () => {
    const fake = engine({});
    const result = await run(["run", "--engines", "faster-whisper-small"], {
      adapters: { "faster-whisper-small": fake },
    });
    expect(result.code).toBe(3);
    expect(result.text).toMatch(/NO DATA/);
    expect(result.text).toMatch(/--manifest/);
    expect(fake.calls.opened).toBe(0);
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("exits 3 on the committed catalogue, which lists no items", async () => {
    const result = await run(
      [
        "run",
        "--engines",
        "faster-whisper-small",
        "--manifest",
        join(root, "config", "voice", "eval-manifest.json"),
        "--references",
        refs,
        "--audio",
        join(dir, "audio"),
      ],
      { adapters: { "faster-whisper-small": engine({}) } },
    );
    expect(result.code).toBe(3);
    expect(result.text).toMatch(/items in split "test"/);
    expect(result.text).not.toMatch(/WER/);
  });

  it("exits 3 for text to speech with no texts", async () => {
    const result = await run(["run", "--engines", "supertonic-3"], {
      adapters: { "supertonic-3": { available: async () => ({ ok: true }) } },
    });
    expect(result.code).toBe(3);
    expect(result.text).toMatch(/--tts-texts/);
  });

  it("exits 1 for an unknown engine, a non-speech engine and a missing --engines", async () => {
    expect((await run(["run", "--engines", "nope"])).code).toBe(1);
    expect((await run(["run", "--engines", "silero-vad"])).text).toMatch(/vad engine/);
    expect((await run(["run"])).code).toBe(1);
    expect((await run(["frobnicate"])).code).toBe(1);
  });
});

describe("a missing runtime refuses the whole comparison", () => {
  it("refuses a candidate with no runtime even when the other engine is fine, and prints no number", async () => {
    await freeze();
    const ok = engine(references);
    const result = await run(sttArgs("faster-whisper-small,voxtral-mini-4b-realtime-gguf"), {
      adapters: { "faster-whisper-small": ok },
    });
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/REFUSED: engines whose runtime is missing/);
    expect(result.text).toMatch(/voxtral-mini-4b-realtime-gguf: no runtime wrapper/);
    expect(result.text).not.toMatch(/WER/);
    expect(ok.calls.opened).toBe(0);
  });

  it("refuses an adapter that says it is unavailable, with its reason", async () => {
    await freeze();
    const down = {
      ...engine({}),
      available: async () => ({ ok: false, reason: "model.bin not in the folder" }),
    };
    const result = await run(sttArgs("faster-whisper-small"), {
      adapters: { "faster-whisper-small": down },
    });
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/runtime missing \(model\.bin not in the folder\)/);
  });

  it("the default CTranslate2 adapter refuses a folder with no tokenizer (the Vaani ear today) without starting Python", async () => {
    await freeze();
    const fridayRoot = join(dir, "friday");
    mkdirSync(join(fridayRoot, "models", "hindi-vaani-ear"), { recursive: true });
    for (const name of ["config.json", "model.bin"])
      writeFileSync(join(fridayRoot, "models", "hindi-vaani-ear", name), "x");
    const result = await run(sttArgs("hindi-vaani-ear", ["--root", fridayRoot]));
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/tokenizer\.json not in/);
  });

  it("refuses recordings that are not the manifest's", async () => {
    await freeze();
    writeFileSync(join(dir, "audio", "t-en-1.wav"), "someone else");
    rmSync(join(dir, "audio", "t-hi-1.wav"));
    const result = await run(sttArgs("faster-whisper-small"), {
      adapters: { "faster-whisper-small": engine(references) },
    });
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/audio of t-en-1 does not match/);
    expect(result.text).toMatch(/no audio file for t-hi-1/);
  });
});

describe("scoring goes through the held-out scorer", () => {
  it("refuses a test number before the test set is frozen", async () => {
    const result = await run(sttArgs("faster-whisper-small"), {
      adapters: { "faster-whisper-small": engine(references) },
    });
    expect(result.code).toBe(2);
    expect(result.text).toMatch(/not frozen/);
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("scores a frozen set: a perfect engine against a noisy one, with ranges, timing, memory and Hinglish both ways", async () => {
    await freeze();
    const perfect = engine(references);
    const noisy = engine(hypotheses, { firstPartialMs: 300, finalMs: 1200, rssMb: 900 });
    let vram = 1000;
    const result = await run(sttArgs("faster-whisper-small,faster-whisper-base"), {
      adapters: { "faster-whisper-small": perfect, "faster-whisper-base": noisy },
      vramProbe: async () => (vram += 50),
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.generatedOn).toBe("2026-11-24T10:00:00.000Z");
    const [good, bad] = report.engines;
    expect(good.id).toBe("faster-whisper-small");
    expect(good.wer).toBe(0);
    expect(good.cer).toBe(0);
    expect(bad.wer).toBeGreaterThan(0);
    expect(bad.blockRange.high).toBeGreaterThanOrEqual(bad.wer);
    const testItems = (
      JSON.parse(readFileSync(manifest, "utf8")).items as { split: string; durationMs: number }[]
    ).filter((i) => i.split === "test");
    const audioMs = testItems.reduce((sum, i) => sum + i.durationMs, 0);
    expect(good.realTimeFactor).toBe(Number(((7 * 400) / audioMs).toFixed(4)));
    expect(good.finalMs).toEqual({ n: 7, p50: 400, p95: 400 });
    expect(bad.firstSegmentMs.p50).toBe(300);
    expect(bad.peakRssMb).toBe(900);
    expect(bad.peakVramAddedMb).toBeGreaterThan(0);
    expect(good.byLanguage.hinglish).toHaveProperty("transliterationAwareWer");
    expect(good.byLanguage.hi).not.toHaveProperty("transliterationAwareWer");
    expect(report.ranking.map((r: { id: string }) => r.id)).toEqual([
      "faster-whisper-small",
      "faster-whisper-base",
    ]);
    expect(report.notes.join(" ")).toMatch(/too few items in/);
    expect(perfect.calls.closed).toBe(1);
    expect(result.text).toMatch(/report written/);
  });

  it("counts an engine that fails on a file as failed and still scores the rest", async () => {
    await freeze();
    const flaky = engine(references);
    const original = flaky.transcribe;
    flaky.transcribe = async (file: string, item: { id: string }) => {
      if (item.id === "t-en-1") throw new Error("decoder died");
      return original(file, item);
    };
    const result = await run(sttArgs("faster-whisper-small"), {
      adapters: { "faster-whisper-small": flaky },
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.engines[0].failed).toEqual([{ id: "t-en-1", error: "decoder died" }]);
  });

  it("the dev split needs no frozen lock", async () => {
    const result = await run(sttArgs("faster-whisper-small", ["--split", "dev"]), {
      adapters: { "faster-whisper-small": engine(references) },
    });
    expect(result.code).toBe(0);
  });
});

describe("the maths", () => {
  it("keeps Devanagari vowel signs: a different matra is a different word", () => {
    expect(normaliseTranscript("की किताब")).toBe("की किताब");
    expect(wordCounts("की", "कि").edits).toBe(1);
    expect(wordCounts("फ़ोन", "फोन").edits).toBe(0); // the nukta spelling is folded, on purpose
  });

  it("reads Roman and Devanagari Hinglish spellings of one word as one word, and different words as different", () => {
    for (const [a, b] of [
      ["काम", "kaam"],
      ["काम", "kam"],
      ["समझ", "samajh"],
      ["अलार्म", "alarm"],
      ["लगा", "laga"],
      ["फोन", "fon"],
    ]) {
      expect(bench.romanSkeleton(a!), `${a} ${b}`).toBe(bench.romanSkeleton(b!));
    }
    expect(bench.romanSkeleton("सुबह")).not.toBe(bench.romanSkeleton("शाम"));
  });

  it("resamples whole speakers: one speaker gives no range, and the range is seeded and ordered", () => {
    const one = bench.blockBootstrap([
      { block: "a", edits: 1, words: 4 },
      { block: "a", edits: 0, words: 4 },
    ]);
    expect(one).toMatchObject({ blocks: 1, range: null, wer: 0.125 });
    const rows = [
      { block: "a", edits: 0, words: 10 },
      { block: "b", edits: 5, words: 10 },
      { block: "c", edits: 1, words: 10 },
      { block: "d", edits: 3, words: 10 },
    ];
    const first = bench.blockBootstrap(rows);
    expect(first).toEqual(bench.blockBootstrap(rows));
    expect(first.range!.low).toBeLessThanOrEqual(first.wer);
    expect(first.range!.high).toBeGreaterThanOrEqual(first.wer);
    expect(first.range!.high).toBeGreaterThan(first.range!.low);
  });
});

describe("text to speech and the listener form", () => {
  it("measures first audio and real-time factor, and writes a blind form with the key only in the report", async () => {
    const texts = join(dir, "texts.json");
    writeFileSync(
      texts,
      JSON.stringify([
        { id: "a", lang: "hi", text: "नमस्ते" },
        { id: "b", lang: "en", text: "hello there" },
      ]),
    );
    const voice = (first: number) => ({
      available: async () => ({ ok: true }),
      open: async () => {},
      synthesize: async (_text: string, _lang: string, file: string) => ({
        firstAudioMs: first,
        synthMs: 500,
        audioMs: 2000,
        audioPath: file,
        rssMb: 640,
      }),
      close: () => {},
    });
    const form = join(dir, "form.json");
    const result = await run(
      [
        "run",
        "--engines",
        "supertonic-3,edge-tts",
        "--tts-texts",
        texts,
        "--audio-out",
        join(dir, "clips"),
        "--listener-form",
        form,
        "--out",
        join(dir, "tts.json"),
      ],
      { adapters: { "supertonic-3": voice(180), "edge-tts": voice(420) } },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "tts.json"), "utf8"));
    expect(report.engines.map((e: { id: string }) => e.id)).toEqual(["supertonic-3", "edge-tts"]);
    expect(report.engines[0]).toMatchObject({ role: "tts", realTimeFactor: 0.25, peakRssMb: 640 });
    expect(report.engines[0].firstAudioMs.p50).toBe(180);
    const sheet = JSON.parse(readFileSync(form, "utf8"));
    expect(sheet.items).toHaveLength(4);
    expect(JSON.stringify(sheet)).not.toMatch(/supertonic|edge-tts/);
    for (const row of sheet.items) {
      expect(row.audio).toMatch(/^form-clips\/S\d{3}\.wav$/);
    }
    for (const row of sheet.items)
      expect(row).toMatchObject({ naturalness: null, intelligibility: null });
    expect(Object.keys(report.listenerKey).sort()).toEqual(
      sheet.items.map((r: { code: string }) => r.code).sort(),
    );
    expect(JSON.stringify(report)).not.toMatch(/"mos"\s*:\s*\d/);
    expect(report.method.mos).toMatch(/no automatic MOS/);
  });

  it("orders the clips the same way every time", () => {
    const clips = [1, 2, 3, 4, 5].map((n) => ({ engine: `e${n}`, lang: "en", text: `t${n}` }));
    const audioFor = (_clip: unknown, code: string) => `${code}.wav`;
    expect(bench.buildListenerForm(clips, { audioFor })).toEqual(
      bench.buildListenerForm(clips, { audioFor }),
    );
  });
});

describe("findAudio never leaves the audio folder", () => {
  it("finds an ordinary id and refuses ids that are paths", () => {
    const audio = join(dir, "audio");
    expect(bench.findAudio(audio, "t-en-1")).toBe(join(audio, "t-en-1.wav"));
    writeFileSync(join(dir, "outside.wav"), "x");
    mkdirSync(join(audio, "sub"));
    writeFileSync(join(audio, "sub", "inner.wav"), "x");
    for (const id of [
      "../outside",
      "..",
      ".",
      "a/../../outside",
      "sub/inner",
      "sub\\inner",
      join(dir, "outside"),
      "/etc/passwd",
      "C:\\Windows\\x",
      "t-en-1\0",
      "..\\outside",
      "x..y",
      "",
    ]) {
      expect(bench.findAudio(audio, id), JSON.stringify(id)).toBeNull();
    }
  });

  it("refuses a file that is a link out of the folder", () => {
    const audio = join(dir, "audio");
    writeFileSync(join(dir, "secret.wav"), ["synthetic-audio", "t-hi-1"].join("-"));
    rmSync(join(audio, "t-hi-1.wav"));
    try {
      symlinkSync(join(dir, "secret.wav"), join(audio, "t-hi-1.wav"));
    } catch {
      return; // a platform that cannot link: nothing to test
    }
    expect(bench.findAudio(audio, "t-hi-1")).toBeNull();
  });
});

describe("as a command", () => {
  it("runs under node, lists the registry and exits 3 with no data", () => {
    const list = spawnSync(process.execPath, [join(root, "scripts", "voice-bench.cjs"), "list"], {
      encoding: "utf8",
    });
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/hindi-vaani-ear\tstt\toptional-pinned\tNOT USABLE/);
    expect(list.stdout).toMatch(/faster-whisper-small\tstt\tinstalled-by-default\tusable/);
    const none = spawnSync(
      process.execPath,
      [join(root, "scripts", "voice-bench.cjs"), "run", "--engines", "faster-whisper-small"],
      { encoding: "utf8" },
    );
    expect(none.status).toBe(3);
    expect(none.stdout).toMatch(/NO DATA/);
    const stream = spawnSync(
      process.execPath,
      [join(root, "scripts", "voice-bench.cjs"), "stt-stream"],
      { encoding: "utf8" },
    );
    expect(stream.status).toBe(3);
    expect(stream.stdout).toMatch(/NO DATA/);
  });

  it("is an npm script", () => {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    expect(scripts["voice:bench"]).toBe("node scripts/voice-bench.cjs");
  });
});
