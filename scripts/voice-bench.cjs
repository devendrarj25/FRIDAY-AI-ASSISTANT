#!/usr/bin/env node
/**
 * Voice engine benchmark: the owner runs it on his own PC, on his own frozen evaluation set. No audio, no model and no
 * network lives in the repository, and nothing here invents a number: with no data it says so and exits 3, with an
 * engine whose runtime is missing it refuses the whole comparison and exits 2.
 *
 *   node scripts/voice-bench.cjs list
 *   node scripts/voice-bench.cjs run --engines faster-whisper-small,hindi-ear
 *        --manifest MANIFEST.json --references REFS.json --audio DIR        (speech to text)
 *        [--split test|dev] [--device cpu|cuda] [--python PYTHON] [--root FRIDAY_ROOT]
 *        [--adapters FILE.cjs] [--out REPORT.json]
 *   node scripts/voice-bench.cjs run --engines supertonic-3 --tts-texts TEXTS.json
 *        [--audio-out DIR] [--listener-form FORM.json]                      (text to speech)
 *
 * Speech to text: for each engine and each item of the split (audio `<DIR>/<id>.wav`, whose SHA-256 must equal the
 * manifest's), the word and character error with a matra-safe normaliser (voice-engine/transcript-scorer.ts, the one the
 * tests pin), a 95% range that resamples whole speakers (a block bootstrap, seeded), a transliteration-aware WER for the
 * Hinglish items beside the strict one, the real-time factor, the milliseconds to the first segment and to the final
 * text, the peak memory of the engine process and the video memory it added. Scoring goes through `scoreHeldOut` of
 * voice-eval-set.ts, so an unfrozen test split, a reference that does not match its hash or an empty split is refused
 * with no number. Text to speech: first-audio time, real-time factor and peak memory per text, and an optional
 * listener form for blind MOS-style rating by a person. There is no automatic MOS score and none is claimed.
 *
 * Exit: 0 done, 1 bad usage or invalid files, 2 refused (a runtime is missing, a hash differs, the scorer refused: no
 * number is printed), 3 no data (no manifest items, references, audio or texts: nothing was measured).
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { loadTs, sha256 } = require("./voice-eval.cjs");

const ROOT = path.resolve(__dirname, "..");
const EXIT = { OK: 0, USAGE: 1, REFUSED: 2, NO_DATA: 3 };
const AUDIO_EXT = [".wav", ".flac", ".mp3", ".ogg", ".m4a"];
const SIZE_NAMES = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"];
const BOOTSTRAP_DRAWS = 1000;

/* ------------------------------------------------------------------ pure helpers */

function seeded(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentileOf = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
};
const round = (value, places = 4) =>
  typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(places)) : null;

const VOWELS = {
  अ: "a",
  आ: "aa",
  इ: "i",
  ई: "ii",
  उ: "u",
  ऊ: "uu",
  ए: "e",
  ऐ: "ai",
  ओ: "o",
  औ: "au",
  ऑ: "o",
  ऋ: "ri",
};
const MATRAS = {
  "ा": "aa",
  "ि": "i",
  "ी": "ii",
  "ु": "u",
  "ू": "uu",
  "े": "e",
  "ै": "ai",
  "ो": "o",
  "ौ": "au",
  "ॉ": "o",
  "ृ": "ri",
};
const CONSONANTS = {
  क: "k",
  ख: "kh",
  ग: "g",
  घ: "gh",
  ङ: "n",
  च: "ch",
  छ: "chh",
  ज: "j",
  झ: "jh",
  ञ: "n",
  ट: "t",
  ठ: "th",
  ड: "d",
  ढ: "dh",
  ण: "n",
  त: "t",
  थ: "th",
  द: "d",
  ध: "dh",
  न: "n",
  प: "p",
  फ: "ph",
  ब: "b",
  भ: "bh",
  म: "m",
  य: "y",
  र: "r",
  ल: "l",
  व: "v",
  श: "sh",
  ष: "sh",
  स: "s",
  ह: "h",
};
const VIRAMA = "्";
const DEVANAGARI = /[ऀ-ॿ]/;

/** Devanagari to a plain Roman spelling: the inherent "a" is written, but not at the end of a word. */
function romanise(word) {
  const chars = [...word];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (CONSONANTS[c] !== undefined) {
      out += CONSONANTS[c];
      const next = chars[i + 1];
      if (next === VIRAMA) {
        i += 1;
      } else if (next !== undefined && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i += 1;
      } else if (next !== undefined) {
        out += "a";
      }
    } else if (VOWELS[c] !== undefined) out += VOWELS[c];
    else if (c === "ं" || c === "ँ") out += "n";
    else if (c === "ः") out += "h";
    else if (MATRAS[c] !== undefined) out += MATRAS[c];
    else if (c !== VIRAMA) out += c;
  }
  return out;
}

/**
 * A spelling-tolerant key for one word, so Roman Hinglish ("kaam", "kam") and Devanagari ("काम") compare as one word.
 * Deterministic and approximate: Devanagari is written in Roman letters, then accents go, long vowels and doubled
 * letters collapse and a few Roman habits fold (ph/f, w/v, z/j, ai/e, au/o). Two different words can share a key, so the
 * number it gives is always reported BESIDE the strict word error, never in its place.
 */
function romanSkeleton(word) {
  let t = DEVANAGARI.test(word) ? romanise(word) : word;
  t = t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/z/g, "j")
    .replace(/ai|ei|ae/g, "e")
    .replace(/au|ou/g, "o")
    .replace(/(ee|ii)/g, "i")
    .replace(/(oo|uu)/g, "u")
    .replace(/([a-z])\1+/g, "$1");
  return t;
}

/** Word error with both sides reduced to `romanSkeleton`; needs the scorer's `normaliseTranscript` and `editDistance`. */
function transliterationAwareCounts(scorer, reference, hypothesis) {
  const key = (text) =>
    scorer.normaliseTranscript(text).split(" ").filter(Boolean).map(romanSkeleton);
  const ref = key(reference);
  return { edits: scorer.editDistance(ref, key(hypothesis)), words: ref.length };
}

/**
 * Corpus WER with a 95% range that resamples whole BLOCKS (one block per speaker), not single sentences, so one
 * speaker with many items cannot make the range look tight. Seeded, 1000 draws; null below two blocks.
 */
function blockBootstrap(rows, seed = 7919) {
  const blocks = new Map();
  for (const row of rows) {
    const key = row.block;
    const cur = blocks.get(key) || { edits: 0, words: 0 };
    cur.edits += row.edits;
    cur.words += row.words;
    blocks.set(key, cur);
  }
  const list = [...blocks.values()];
  const edits = list.reduce((s, b) => s + b.edits, 0);
  const words = list.reduce((s, b) => s + b.words, 0);
  const wer = words ? edits / words : edits ? 1 : 0;
  if (list.length < 2) return { wer, blocks: list.length, range: null };
  const next = seeded(seed + list.length * 31 + words);
  const draws = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d += 1) {
    let e = 0;
    let w = 0;
    for (let k = 0; k < list.length; k += 1) {
      const pick = list[Math.floor(next() * list.length)];
      e += pick.edits;
      w += pick.words;
    }
    draws.push(w ? e / w : e ? 1 : 0);
  }
  return {
    wer,
    blocks: list.length,
    range: { low: percentileOf(draws, 2.5), high: percentileOf(draws, 97.5) },
  };
}

/**
 * The blind rating sheet for a listener: the clips in a seeded random order under neutral codes, empty rating fields.
 * The key (code to engine) is returned apart and goes only into the report, never into the sheet.
 */
function buildListenerForm(clips, options = {}) {
  const seed = options.seed ?? 20261123;
  const next = seeded(seed);
  const order = clips.map((clip, index) => ({ clip, index }));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const key = {};
  const items = order.map(({ clip }, n) => {
    const code = `S${String(n + 1).padStart(3, "0")}`;
    key[code] = clip.engine;
    return {
      code,
      language: clip.lang,
      text: clip.text,
      audio: options.audioFor ? options.audioFor(clip, code) : null,
      naturalness: null,
      intelligibility: null,
      notes: "",
    };
  });
  return {
    form: {
      schema: 1,
      instructions:
        "Listen to each clip once or twice and give naturalness and intelligibility from 1 (bad) to 5 (excellent). Engine names are hidden on purpose. This is one listener's opinion, not an automatic score.",
      scale: { min: 1, max: 5 },
      items,
    },
    key,
  };
}

function summarise(values) {
  return {
    n: values.length,
    p50: round(percentileOf(values, 50), 1),
    p95: round(percentileOf(values, 95), 1),
  };
}

/* ------------------------------------------------------------------ default adapters */

const fridayRoot = (flags) =>
  flags.root || process.env.FRIDAY_ROOT || path.join(os.homedir(), ".friday");

/** The folder a CTranslate2 engine is read from: a speech size under cache/stt, any other ear under models/<id>. */
function ct2Folder(engine, flags) {
  const root = fridayRoot(flags);
  if (engine.sizeRank !== undefined)
    return path.join(root, "cache", "stt", SIZE_NAMES[engine.sizeRank]);
  return path.join(root, "models", engine.id);
}

function pythonOf(flags) {
  return (
    flags.python ||
    process.env.FRIDAY_PYTHON ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

/** A line-based child process: one request in, one JSON answer out. */
function lineProcess(command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  const waiting = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const resolve = waiting.shift();
      if (resolve) {
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, reason: "bad-answer", detail: line.slice(0, 80) });
        }
      }
    }
  });
  child.on("error", (error) => {
    while (waiting.length)
      waiting.shift()({ ok: false, reason: "spawn-failed", detail: String(error.message) });
  });
  child.on("close", () => {
    while (waiting.length) waiting.shift()({ ok: false, reason: "process-ended", detail: "" });
  });
  return {
    ask: (request) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        child.stdin.write(`${JSON.stringify(request)}\n`);
      }),
    close: () => {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

function ct2Adapter(engine, flags) {
  const folder = ct2Folder(engine, flags);
  const worker = path.join(ROOT, "kernel", "voice_bench_worker.py");
  let proc = null;
  return {
    folder,
    async available() {
      const missing = ["config.json", "model.bin", "tokenizer.json"].filter(
        (name) => !fs.existsSync(path.join(folder, name)),
      );
      if (missing.length) return { ok: false, reason: `${missing.join(", ")} not in ${folder}` };
      const probe = spawnSync(pythonOf(flags), [worker], {
        input: `${JSON.stringify({ op: "probe" })}\n`,
        encoding: "utf8",
        timeout: 60000,
      });
      let answer = null;
      try {
        answer = JSON.parse(String(probe.stdout || "").split("\n")[0] || "null");
      } catch {
        answer = null;
      }
      return answer?.ok
        ? { ok: true }
        : {
            ok: false,
            reason: `faster-whisper is not importable (${answer?.detail || probe.error?.message || "no answer"})`,
          };
    },
    async open() {
      proc = lineProcess(pythonOf(flags), [worker]);
      const loaded = await proc.ask({
        op: "load",
        dir: folder,
        device: flags.device || "cpu",
        compute: flags.device === "cuda" ? "float16" : "int8",
      });
      if (!loaded.ok) throw new Error(`${loaded.reason}: ${loaded.detail}`);
    },
    async transcribe(audioPath, item) {
      const answer = await proc.ask({
        op: "transcribe",
        audio: audioPath,
        language: item.language === "en" ? "en" : "hi",
      });
      if (!answer.ok) throw new Error(`${answer.reason}: ${answer.detail}`);
      return answer;
    },
    close() {
      proc?.close();
    },
  };
}

function runtimeTtsAdapter(engine, flags) {
  const script = path.join(ROOT, "kernel", "voice_runtime.py");
  const env = { ...process.env, FRIDAY_ROOT: fridayRoot(flags) };
  return {
    async available() {
      const out = spawnSync(pythonOf(flags), [script, "--status"], {
        encoding: "utf8",
        env,
        timeout: 60000,
      });
      try {
        const status = JSON.parse(String(out.stdout || "{}"));
        return status?.tts?.ready
          ? { ok: true }
          : { ok: false, reason: status?.tts?.reason || "the voice is not installed" };
      } catch {
        return {
          ok: false,
          reason: "voice_runtime.py gave no status (python or onnxruntime missing)",
        };
      }
    },
    async open() {},
    async synthesize(text, lang, outFile) {
      const started = process.hrtime.bigint();
      const out = spawnSync(
        pythonOf(flags),
        [
          script,
          "--speak",
          "--text",
          text,
          "--lang",
          lang === "en" ? "en-IN" : "hi-IN",
          "--out",
          outFile,
        ],
        { encoding: "utf8", env, timeout: 120000 },
      );
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let answer = {};
      try {
        answer = JSON.parse(
          String(out.stdout || "{}")
            .trim()
            .split("\n")
            .pop() || "{}",
        );
      } catch {
        answer = {};
      }
      if (!answer.ok) throw new Error(answer.reason || "no audio");
      // The runtime writes a whole clip, so the first audio is known only as the whole synthesis time (an upper bound).
      const bytes = fs.statSync(outFile).size;
      return {
        firstAudioMs: ms,
        synthMs: ms,
        audioMs: Math.max(1, ((bytes - 44) / 2 / 44100) * 1000),
        audioPath: outFile,
        firstAudioKind: "whole-clip",
      };
    },
    close() {},
  };
}

function defaultAdapter(engine, flags) {
  if (engine.role === "stt" && engine.runtime === "ctranslate2") return ct2Adapter(engine, flags);
  if (engine.role === "tts" && engine.id === "supertonic-3")
    return runtimeTtsAdapter(engine, flags);
  return null;
}

/* ------------------------------------------------------------------ the run */

const readJson = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) flags[arg.slice(2)] = argv[(i += 1)];
    else positional.push(arg);
  }
  return { flags, positional };
}

const SAFE_ID = /^[\w.-]+$/;

/**
 * The recording of one manifest item, or null. An id that is not a plain file stem (a path separator, `..`, an
 * absolute path, an empty string) is refused, and the resolved real path must still lie inside `dir`, so a manifest
 * can never make the benchmark read a file outside the owner's audio folder.
 */
function findAudio(dir, id) {
  const stem = String(id);
  if (!SAFE_ID.test(stem) || stem === "." || stem.includes("..")) return null;
  let base;
  try {
    base = fs.realpathSync(dir);
  } catch {
    return null;
  }
  for (const ext of AUDIO_EXT) {
    const file = path.join(dir, `${stem}${ext}`);
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    const inside = path.relative(base, real);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
    return file;
  }
  return null;
}

const fileSha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main(argv, deps = {}) {
  const out = deps.out || console.log;
  const clock = deps.clock || (() => new Date());
  const now = deps.now || (() => Number(process.hrtime.bigint() / 1000n) / 1000);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0] || "list";
  const registry =
    deps.registry || (await loadTs("src/lib/friday/voice-engine/voice-engine-registry.ts"));

  if (command === "list") {
    for (const engine of registry.VOICE_ENGINES) {
      const why = registry.unusableReason(engine);
      out(
        `${engine.id}\t${engine.role}\t${engine.status}\t${why ? `NOT USABLE: ${why.slice(0, 90)}` : "usable"}`,
      );
    }
    return EXIT.OK;
  }
  if (command !== "run") return fail(`unknown command "${command}" (list, run)`, EXIT.USAGE, out);
  if (!flags.engines) return fail("--engines a,b is required (see: list)", EXIT.USAGE, out);

  const engines = [];
  for (const id of String(flags.engines)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const engine = registry.voiceEngineById.get(id);
    if (!engine) return fail(`unknown engine "${id}" (see: list)`, EXIT.USAGE, out);
    if (engine.role !== "stt" && engine.role !== "tts")
      return fail(
        `${id} is a ${engine.role} engine; this benchmark measures stt and tts`,
        EXIT.USAGE,
        out,
      );
    engines.push(engine);
  }
  if (!engines.length) return fail("--engines names no engine", EXIT.USAGE, out);
  const stt = engines.filter((e) => e.role === "stt");
  const tts = engines.filter((e) => e.role === "tts");

  // 1. data first: with none, nothing is measured and nothing is faked.
  const lib = await loadTs("src/lib/friday/voice-engine/voice-eval-set.ts");
  const scorer = await loadTs("src/lib/friday/voice-engine/transcript-scorer.ts");
  const split = flags.split || "test";
  let manifest = null;
  let references = null;
  let scope = [];
  if (stt.length) {
    const missing = [];
    if (!flags.manifest || !fs.existsSync(flags.manifest))
      missing.push("--manifest FILE (the owner's evaluation manifest)");
    if (!flags.references || !fs.existsSync(flags.references)) missing.push("--references FILE");
    if (!flags.audio || !fs.existsSync(flags.audio))
      missing.push("--audio DIR (the recordings, named <id>.wav)");
    if (!missing.length) {
      let raw;
      try {
        raw = readJson(flags.manifest);
        references = readJson(flags.references);
      } catch (error) {
        return fail(`cannot read the manifest or references: ${error.message}`, EXIT.USAGE, out);
      }
      const checked = lib.validateManifest(raw, sha256);
      if (!checked.manifest) {
        out(`INVALID manifest: ${checked.problems.length} problem(s)`);
        for (const problem of checked.problems) out(`  - ${problem}`);
        return EXIT.USAGE;
      }
      manifest = { raw, checked: checked.manifest };
      scope = checked.manifest.items.filter((item) => item.split === split);
      if (!scope.length)
        missing.push(
          `items in split "${split}" of the manifest (it lists ${checked.manifest.items.length})`,
        );
    }
    if (missing.length) {
      out("NO DATA: nothing was measured. Missing:");
      for (const line of missing) out(`  - ${line}`);
      return EXIT.NO_DATA;
    }
  }
  let ttsTexts = [];
  if (tts.length) {
    if (!flags["tts-texts"] || !fs.existsSync(flags["tts-texts"])) {
      out(
        "NO DATA: nothing was measured. Missing:\n  - --tts-texts FILE ([{id, lang, text}, ...])",
      );
      return EXIT.NO_DATA;
    }
    ttsTexts = readJson(flags["tts-texts"]);
    if (!Array.isArray(ttsTexts) || !ttsTexts.length) {
      out("NO DATA: nothing was measured. Missing:\n  - at least one text in --tts-texts");
      return EXIT.NO_DATA;
    }
  }

  // 2. every engine needs a runtime that is really there, or the comparison is refused whole.
  const adapterTable =
    deps.adapters || (flags.adapters ? require(path.resolve(flags.adapters)) : {});
  const adapters = new Map();
  const refused = [];
  for (const engine of engines) {
    const adapter = adapterTable[engine.id] || defaultAdapter(engine, flags);
    if (!adapter) {
      refused.push(
        `${engine.id}: no runtime wrapper (${registry.unusableReason(engine) || "no adapter"})`,
      );
      continue;
    }
    let state;
    try {
      state = await adapter.available();
    } catch (error) {
      state = { ok: false, reason: String(error?.message || error) };
    }
    if (!state?.ok)
      refused.push(`${engine.id}: runtime missing (${state?.reason || "unavailable"})`);
    else adapters.set(engine.id, adapter);
  }
  if (refused.length) {
    out("REFUSED: engines whose runtime is missing are never compared; no number is reported");
    for (const line of refused) out(`  - ${line}`);
    return EXIT.REFUSED;
  }

  // 3. the recordings must be the ones the manifest names.
  const audioOf = new Map();
  if (stt.length) {
    const problems = [];
    for (const item of scope) {
      const file = findAudio(flags.audio, item.id);
      if (!file) problems.push(`no audio file for ${item.id}`);
      else if (fileSha(file) !== item.sha256)
        problems.push(`audio of ${item.id} does not match the manifest SHA-256`);
      else audioOf.set(item.id, file);
    }
    if (problems.length) {
      out("REFUSED: the recordings are not the manifest's; no number is reported");
      for (const line of problems.slice(0, 20)) out(`  - ${line}`);
      return EXIT.REFUSED;
    }
  }

  const report = {
    schema: 1,
    generatedOn: clock().toISOString(),
    split,
    manifestId: manifest?.checked.id ?? null,
    device: flags.device || "cpu",
    method: {
      scoring:
        "scoreHeldOut (voice-eval-set.ts): corpus WER and CER, matra-safe normaliser of transcript-scorer.ts; blockRange resamples whole speakers",
      transliterationAware:
        "Hinglish items only, approximate (romanSkeleton): reported beside the strict WER, never instead of it",
      latency:
        "firstSegmentMs is the first finished segment (Whisper is not a streaming model); finalMs is the whole transcription",
      mos: "no automatic MOS: the listener form is rated by a person",
    },
    engines: [],
    ranking: [],
    notes: [],
  };
  const vramProbe = deps.vramProbe || defaultVramProbe;

  // 4. speech to text
  for (const engine of stt) {
    const adapter = adapters.get(engine.id);
    const baseVram = await vramProbe();
    const hypotheses = {};
    const timing = [];
    const failures = [];
    let peakRss = null;
    let peakVram = null;
    try {
      await adapter.open();
    } catch (error) {
      out(`REFUSED: ${engine.id} could not be opened (${error.message}); no number is reported`);
      adapter.close?.();
      return EXIT.REFUSED;
    }
    for (const item of scope) {
      const started = now();
      try {
        const got = await adapter.transcribe(audioOf.get(item.id), item);
        hypotheses[item.id] = String(got.text ?? "");
        const wall = now() - started;
        timing.push({
          id: item.id,
          finalMs: typeof got.finalMs === "number" ? got.finalMs : wall,
          firstMs: typeof got.firstPartialMs === "number" ? got.firstPartialMs : null,
          durationMs: item.durationMs,
        });
        if (typeof got.rssMb === "number") peakRss = Math.max(peakRss ?? 0, got.rssMb);
      } catch (error) {
        failures.push({ id: item.id, error: String(error.message || error).slice(0, 120) });
      }
      const vram = await vramProbe();
      if (vram !== null && baseVram !== null) peakVram = Math.max(peakVram ?? 0, vram - baseVram);
    }
    if (typeof adapter.peakRssMb === "function") {
      const own = await adapter.peakRssMb();
      if (typeof own === "number") peakRss = Math.max(peakRss ?? 0, own);
    }
    adapter.close?.();
    const scored = lib.scoreHeldOut({
      manifest: manifest.raw,
      references,
      hypotheses,
      sha256,
      split,
      engine: engine.id,
    });
    if (scored.status === "refused") {
      out("REFUSED: no number is reported");
      for (const reason of scored.reasons) out(`  - ${reason}`);
      return EXIT.REFUSED;
    }
    const rows = scope
      .filter((item) => item.id in hypotheses)
      .map((item) => {
        const ref = String(references[item.id] ?? "").normalize("NFC");
        const strict = scorer.wordCounts(ref, hypotheses[item.id]);
        const trans = transliterationAwareCounts(scorer, ref, hypotheses[item.id]);
        return { item, strict, trans, block: `${item.source}:${item.speaker}` };
      });
    const byLang = {};
    for (const lang of ["hi", "en", "hinglish"]) {
      const part = rows.filter((row) => row.item.language === lang);
      if (!part.length) continue;
      byLang[lang] = {
        items: part.length,
        strictWer: round(blockBootstrap(part.map((r) => ({ block: r.block, ...r.strict }))).wer),
        blockRange: rangeOf(blockBootstrap(part.map((r) => ({ block: r.block, ...r.strict })))),
        blocks: blockBootstrap(part.map((r) => ({ block: r.block, ...r.strict }))).blocks,
        ...(lang === "hinglish"
          ? {
              transliterationAwareWer: round(
                blockBootstrap(part.map((r) => ({ block: r.block, ...r.trans }))).wer,
              ),
              transliterationAwareRange: rangeOf(
                blockBootstrap(part.map((r) => ({ block: r.block, ...r.trans }))),
              ),
            }
          : {}),
      };
    }
    const overall = blockBootstrap(rows.map((r) => ({ block: r.block, ...r.strict })));
    const audioMs = timing.reduce((s, t) => s + t.durationMs, 0);
    const decodeMs = timing.reduce((s, t) => s + t.finalMs, 0);
    report.engines.push({
      id: engine.id,
      role: "stt",
      status: engine.status,
      registryUsable: registry.isUsable(engine),
      runtime: engine.runtime,
      items: scope.length,
      failed: failures,
      wer: round(overall.wer),
      blockRange: rangeOf(overall),
      cer: round(scored.report.overall.corpusCer),
      cerRange: scored.report.overall.corpusCerRange,
      byLanguage: byLang,
      scorerReport: scored.report,
      realTimeFactor: audioMs ? round(decodeMs / audioMs) : null,
      firstSegmentMs: summarise(timing.flatMap((t) => (t.firstMs === null ? [] : [t.firstMs]))),
      finalMs: summarise(timing.map((t) => t.finalMs)),
      peakRssMb: peakRss,
      peakVramAddedMb: peakVram,
      peakVramNote:
        peakVram === null
          ? "no GPU memory reading was available"
          : "video memory added over the pre-load reading",
    });
  }
  const sttReports = report.engines.filter((e) => e.role === "stt");
  report.ranking = sttReports
    .map((e) => ({ id: e.id, wer: e.wer, range: e.blockRange }))
    .sort((a, b) => (a.wer ?? 9) - (b.wer ?? 9));
  if (report.ranking.length > 1) {
    const [first, second] = report.ranking;
    const overlap = first.range && second.range && first.range.high >= second.range.low;
    report.notes.push(
      overlap || !first.range || !second.range
        ? `${first.id} and ${second.id} are not separated by the speaker-block range: no winner is claimed`
        : `${first.id} is ahead of ${second.id} outside the speaker-block range on this set`,
    );
  }
  for (const e of sttReports) {
    const small = Object.entries(e.scorerReport.byLanguage).filter(([, g]) => !g.claimable);
    for (const [lang] of small)
      report.notes.push(
        `${e.id}: too few items in ${lang} to claim a number (MIN_ITEMS_FOR_CLAIM)`,
      );
  }

  // 5. text to speech
  const clips = [];
  const audioOut = flags["audio-out"]
    ? path.resolve(flags["audio-out"])
    : fs.mkdtempSync(path.join(os.tmpdir(), "friday-bench-tts-"));
  if (tts.length) fs.mkdirSync(audioOut, { recursive: true });
  for (const engine of tts) {
    const adapter = adapters.get(engine.id);
    try {
      await adapter.open();
    } catch (error) {
      out(`REFUSED: ${engine.id} could not be opened (${error.message}); no number is reported`);
      return EXIT.REFUSED;
    }
    const first = [];
    const rtf = [];
    const failures = [];
    let peakRss = null;
    for (const entry of ttsTexts) {
      const file = path.join(
        audioOut,
        `${engine.id}-${String(entry.id).replace(/[^\w.-]/g, "_")}.wav`,
      );
      try {
        const got = await adapter.synthesize(String(entry.text), String(entry.lang || "en"), file);
        first.push(got.firstAudioMs);
        if (got.audioMs > 0) rtf.push(got.synthMs / got.audioMs);
        if (typeof got.rssMb === "number") peakRss = Math.max(peakRss ?? 0, got.rssMb);
        clips.push({
          engine: engine.id,
          lang: entry.lang,
          text: entry.text,
          audioPath: got.audioPath || file,
        });
      } catch (error) {
        failures.push({ id: entry.id, error: String(error.message || error).slice(0, 120) });
      }
    }
    adapter.close?.();
    report.engines.push({
      id: engine.id,
      role: "tts",
      status: engine.status,
      registryUsable: registry.isUsable(engine),
      runtime: engine.runtime,
      texts: ttsTexts.length,
      failed: failures,
      firstAudioMs: summarise(first),
      realTimeFactor: rtf.length ? round(percentileOf(rtf, 50)) : null,
      peakRssMb: peakRss,
    });
  }
  if (flags["listener-form"] && clips.length) {
    const formFile = path.resolve(flags["listener-form"]);
    // The sheet must not name the engine, so each clip is copied under its neutral code next to the sheet.
    const clipDir = `${formFile.replace(/\.json$/i, "")}-clips`;
    fs.mkdirSync(clipDir, { recursive: true });
    const { form, key } = buildListenerForm(clips, {
      audioFor: (clip, code) => {
        const copy = path.join(
          clipDir,
          `${code}${path.extname(clip.audioPath || ".wav") || ".wav"}`,
        );
        if (clip.audioPath && fs.existsSync(clip.audioPath)) fs.copyFileSync(clip.audioPath, copy);
        return path.basename(clipDir) + "/" + path.basename(copy);
      },
    });
    fs.writeFileSync(formFile, `${JSON.stringify(form, null, 2)}\n`);
    report.listenerKey = key;
    report.notes.push(
      `listener form written to ${path.resolve(flags["listener-form"])} (${form.items.length} clips); the key is in this report only`,
    );
  }

  const date = clock().toISOString().slice(0, 10);
  const dest = flags.out
    ? path.resolve(flags.out)
    : path.join(fridayRoot(flags), "reports", `voice-bench-${date}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
  for (const e of report.engines) {
    out(
      e.role === "stt"
        ? `${e.id}: WER ${e.wer} (speaker-block range ${fmt(e.blockRange)}), CER ${e.cer}, RTF ${e.realTimeFactor}, final p50 ${e.finalMs.p50} ms, peak RSS ${e.peakRssMb ?? "n/a"} MB`
        : `${e.id}: first audio p50 ${e.firstAudioMs.p50} ms, RTF ${e.realTimeFactor}, peak RSS ${e.peakRssMb ?? "n/a"} MB`,
    );
  }
  for (const note of report.notes) out(`note: ${note}`);
  out(`report written: ${dest}`);
  return EXIT.OK;
}

const rangeOf = (b) => (b.range ? { low: round(b.range.low), high: round(b.range.high) } : null);
const fmt = (range) => (range ? `${range.low} to ${range.high}` : "n/a");

/** Video memory in use, in MB, from nvidia-smi, or null when there is no reading (no NVIDIA GPU, no tool). */
async function defaultVramProbe() {
  const res = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (res.status !== 0) return null;
  const used = String(res.stdout)
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter(Number.isFinite);
  return used.length ? Math.max(...used) : null;
}

function fail(message, code, out) {
  out(message);
  return code;
}

module.exports = {
  EXIT,
  main,
  romanSkeleton,
  transliterationAwareCounts,
  blockBootstrap,
  buildListenerForm,
  ct2Folder,
  findAudio,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
