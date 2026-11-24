import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LiveWords,
  livePassDeps,
  splitMixedScript,
  type LivePassReply,
  type LiveWordsUpdate,
} from "../../src/lib/friday/voice-engine/live-words";

const RATE = 16_000;

type Truth = { w: string; at: number }; // a word and the second it starts, on the utterance clock

/**
 * A scripted utterance and a fake decoder. The audio buffer is "everything spoken since `from`"; the decoder hears
 * the words of the truth that fall inside the buffer (with times relative to the buffer start) and may be told to
 * mishear a word on one pass.
 */
function rig(
  truth: Truth[],
  opts: {
    speaking?: () => boolean;
    passMs?: number;
    mishear?: Record<number, Record<string, string>>;
    reply?: (pass: number, buffer: { fromS: number; seconds: number }) => Partial<LivePassReply>;
    maxPasses?: number;
    hopMs?: number;
  } = {},
) {
  let t = 0; // ms on both the audio clock and the decoder clock
  const seen: { fromS: number; seconds: number; language: string }[] = [];
  const updates: LiveWordsUpdate[] = [];
  const cancels: string[] = [];
  let pass = 0;
  let from = 0;
  let hold: (() => void) | null = null;
  let holding = false;
  const lw = new LiveWords({
    timed: true,
    audioSince: (fromMono, maxMs) => {
      from = fromMono;
      const seconds = Math.max(0, (t - fromMono) / 1000);
      const wanted = Math.min(seconds, maxMs / 1000);
      return { samples: new Float32Array(Math.round(wanted * RATE)), rate: RATE };
    },
    encodeWav: (samples) => new Uint8Array(samples.length),
    transcribe: async (wav, hint) => {
      pass += 1;
      const seconds = wav.length / RATE;
      const fromS = Math.max(0, t / 1000 - seconds);
      seen.push({ fromS, seconds, language: hint.language });
      if (holding) await new Promise<void>((r) => (hold = r));
      const heardUntil = t / 1000;
      const words = truth
        .filter((x) => x.at >= fromS && x.at + 0.3 <= heardUntil)
        .map((x) => ({
          text: opts.mishear?.[pass]?.[x.w] ?? x.w,
          start: x.at - fromS,
          end: x.at - fromS + 0.3,
        }));
      void from;
      t += opts.passMs ?? 100;
      return {
        ok: true,
        text: words.map((x) => x.text).join(" "),
        words,
        segments: [],
        language: "en",
        languageProbability: 0.95,
        ...(opts.reply?.(pass, { fromS, seconds }) ?? {}),
      };
    },
    cancel: (id) => cancels.push(id),
    speaking: opts.speaking ?? (() => true),
    onUpdate: (u) => updates.push(u),
    now: () => t,
    hopMs: opts.hopMs ?? 700,
    ...(opts.maxPasses ? { maxPasses: opts.maxPasses } : {}),
  });
  return {
    lw,
    seen,
    updates,
    cancels,
    advance: (ms: number) => (t += ms),
    clock: () => t,
    hold: (v: boolean) => (holding = v),
    release: () => hold?.(),
  };
}

const sentence = (text: string, gap = 0.5, from = 0.1): Truth[] =>
  text.split(" ").map((w, i) => ({ w, at: from + i * gap }));

describe("LiveWords streaming (timed words, LocalAgreement-2)", () => {
  it("commits what two passes agree on and shows the rest as unstable", async () => {
    const r = rig(sentence("turn on the kitchen light please"), { passMs: 100 });
    r.lw.start(0);
    r.advance(2000);
    await r.lw.tick(); // first pass: nothing committed
    expect(r.updates.at(-1)).toMatchObject({ settled: "", passes: 1 });
    expect(r.updates.at(-1)?.shown).not.toBe("");
    r.advance(1500);
    await r.lw.tick();
    const u = r.updates.at(-1)!;
    expect(u.settled.length).toBeGreaterThan(0);
    expect(u.shown.startsWith(u.settled)).toBe(true);
    expect(u.shown).toBe(`${u.settled} ${u.unstable}`.trim());
  });

  it("reaches the whole sentence as committed once the audio stops growing", async () => {
    const r = rig(sentence("turn on the kitchen light please"));
    r.lw.start(0);
    for (let i = 0; i < 6; i += 1) {
      r.advance(1000);
      await r.lw.tick();
    }
    expect(r.updates.at(-1)?.settled).toBe("turn on the kitchen light please");
    expect(r.updates.at(-1)?.unstable).toBe("");
  });

  it("never settles a word that flips on one pass, and never changes a settled word", async () => {
    const r = rig(sentence("call mom about the dinner tonight"), {
      mishear: { 2: { mom: "tom" } },
    });
    r.lw.start(0);
    const settledSeen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      r.advance(1000);
      await r.lw.tick();
      settledSeen.push(r.updates.at(-1)!.settled);
    }
    for (let i = 1; i < settledSeen.length; i += 1) {
      expect(settledSeen[i]!.startsWith(settledSeen[i - 1]!)).toBe(true); // only ever grows
    }
    expect(settledSeen.at(-1)).toContain("mom");
    expect(settledSeen.join("|")).not.toContain("tom");
  });

  it("keeps absolute time across a buffer trim: no word is repeated or lost", async () => {
    const long = sentence(
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen",
      1,
      0.1,
    );
    const r = rig(long, {
      reply: (_p, b) => ({
        // a segment ends after every fourth word, as the decoder would report it
        segments: Array.from({ length: Math.floor(b.seconds / 4) }, (_, i) => ({
          start: i * 4,
          end: i * 4 + 3.4,
        })),
      }),
    });
    r.lw.start(0);
    for (let i = 0; i < 18; i += 1) {
      r.advance(1000);
      await r.lw.tick();
    }
    const last = r.updates.at(-1)!;
    const words = last.settled.split(" ");
    expect(new Set(words).size).toBe(words.length); // no repeats
    expect(words.slice(0, 5)).toEqual(["one", "two", "three", "four", "five"]);
    expect(words.length).toBeGreaterThanOrEqual(15);
    // the buffer was trimmed: a later pass reads less than the whole utterance
    expect(Math.max(...r.seen.map((s) => s.seconds))).toBeLessThan(18);
    expect(r.seen.at(-1)!.fromS).toBeGreaterThan(0);
  });

  it("caps the audio buffer at about 30 s even when nothing commits", async () => {
    const r = rig(sentence("a b c d e f g h i j", 4, 0.1), { maxPasses: 99 });
    r.lw.start(0);
    r.advance(45_000);
    await r.lw.tick();
    expect(Math.max(...r.seen.map((s) => s.seconds))).toBeLessThanOrEqual(30.01);
  });

  it("skips a pass until about half a second of new audio has accrued", async () => {
    const r = rig(sentence("hello there my friend how are you"), { hopMs: 100, passMs: 0 });
    r.lw.start(0);
    r.advance(1200);
    await r.lw.tick();
    expect(r.seen).toHaveLength(1);
    r.advance(300); // only 0.3 s new
    await r.lw.tick();
    expect(r.seen).toHaveLength(1);
    r.advance(300); // 0.6 s new
    await r.lw.tick();
    expect(r.seen).toHaveLength(2);
  });

  it("never starts a pass while the previous one is running, and waits 1.5 x a slow pass", async () => {
    const r = rig(sentence("hello there my friend how are you"), { passMs: 3000, hopMs: 500 });
    r.lw.start(0);
    r.advance(1500);
    r.hold(true);
    const first = r.lw.tick();
    await r.lw.tick();
    await r.lw.tick();
    expect(r.seen).toHaveLength(1);
    r.release();
    await first;
    r.hold(false);
    r.advance(1000); // 1 s after the pass ended; 1.5 x 3 s not reached
    await r.lw.tick();
    expect(r.seen).toHaveLength(1);
    r.advance(3600);
    await r.lw.tick();
    expect(r.seen).toHaveLength(2);
  });

  it("cancels the pass in flight when speech ends, and drops its late answer", async () => {
    let speaking = true;
    const r = rig(sentence("hello there my friend"), { speaking: () => speaking });
    r.lw.start(0);
    r.advance(1500);
    r.hold(true);
    const pending = r.lw.tick();
    speaking = false;
    await r.lw.tick(); // speech ended while a pass runs: stop and cancel it
    expect(r.lw.isActive()).toBe(false);
    expect(r.cancels).toHaveLength(1);
    expect(r.cancels[0]).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    r.release();
    await pending;
    expect(r.updates).toEqual([]);
  });

  it("stop cancels the pass in flight; stop with nothing running cancels nothing", async () => {
    const r = rig(sentence("hello there my friend"));
    r.lw.start(0);
    r.lw.stop();
    expect(r.cancels).toEqual([]);
    r.lw.start(0);
    r.advance(1500);
    r.hold(true);
    const pending = r.lw.tick();
    r.lw.stop();
    expect(r.cancels).toHaveLength(1);
    r.release();
    await pending;
    expect(r.updates).toEqual([]);
  });

  it("a cancelled or failed pass changes nothing and counts for nothing", async () => {
    const r = rig(sentence("hello there my friend"), {
      reply: (p) => (p === 1 ? { ok: false, cancelled: true, words: [] } : {}),
    });
    r.lw.start(0);
    r.advance(1500);
    await r.lw.tick();
    expect(r.updates).toEqual([]);
    r.advance(1500);
    await r.lw.tick();
    expect(r.updates.at(-1)?.passes).toBe(1);
  });

  it("asks each pass for the language the last confident pass heard", async () => {
    const r = rig(sentence("आज मौसम कैसा है भाई"), {
      reply: (p) =>
        p === 1
          ? { language: "hi", languageProbability: 0.96 }
          : p === 2
            ? { language: "en", languageProbability: 0.4 } // unsure: does not change the lock
            : { language: "hi", languageProbability: 0.9 },
    });
    r.lw.start(0);
    for (let i = 0; i < 3; i += 1) {
      r.advance(1000);
      await r.lw.tick();
    }
    expect(r.seen.map((s) => s.language)).toEqual(["", "hi", "hi"]);
  });

  it("looks again with no lock on every fourth pass, so a switch of language is noticed", async () => {
    const r = rig(sentence("hello there my friend how are you today"));
    r.lw.start(0);
    for (let i = 0; i < 5; i += 1) {
      r.advance(1000);
      await r.lw.tick();
    }
    expect(r.seen.map((s) => s.language)).toEqual(["", "en", "en", "", "en"]);
  });

  it("the Hindi ear (no probability, engine named) locks Hindi too", async () => {
    const r = rig(sentence("आज मौसम कैसा है भाई"), {
      reply: () => ({ language: "hi", languageProbability: null, engine: "hindi-ear" }),
    });
    r.lw.start(0);
    r.advance(1000);
    await r.lw.tick();
    r.advance(1000);
    await r.lw.tick();
    expect(r.seen[1]?.language).toBe("hi");
  });

  it("a new utterance forgets the locked language", async () => {
    const r = rig(sentence("hello there my friend"));
    r.lw.start(0);
    r.advance(1000);
    await r.lw.tick();
    r.lw.start(r.clock());
    r.advance(1000);
    await r.lw.tick();
    expect(r.seen.at(-1)?.language).toBe("");
  });

  it("falls back to the plain text hypothesis when a reply has no timed words", async () => {
    const r = rig(sentence("aaj ka weather batao"), {
      reply: (p) => ({ words: undefined as never, text: p === 1 ? "aaj ka" : "aaj ka weather" }),
    });
    r.lw.start(0);
    r.advance(1500);
    await r.lw.tick();
    r.advance(1500);
    await r.lw.tick();
    expect(r.updates.at(-1)).toMatchObject({ settled: "aaj ka", shown: "aaj ka weather" });
  });

  it("never lets a word hold two scripts", async () => {
    expect(splitMixedScript({ text: "meetingको", start: 0, end: 1 })).toEqual([
      { text: "meeting", start: 0, end: expect.closeTo(7 / 9, 3) },
      { text: "को", start: expect.closeTo(7 / 9, 3), end: 1 },
    ]);
    expect(splitMixedScript({ text: "hello", start: 0, end: 1 })).toHaveLength(1);
    expect(splitMixedScript({ text: "नमस्ते", start: 0, end: 1 })).toHaveLength(1);
    expect(splitMixedScript({ text: "₹500", start: 0, end: 1 })).toHaveLength(1);
    const r = rig([], {
      reply: () => ({
        words: [
          { text: "open", start: 0, end: 0.4 },
          { text: "reportको", start: 0.5, end: 1 },
          { text: "खोलो", start: 1.1, end: 1.5 },
        ],
      }),
    });
    r.lw.start(0);
    r.advance(2000);
    await r.lw.tick();
    expect(r.updates.at(-1)?.shown).toBe("open report को खोलो");
  });

  it("emits only partial updates: nothing final, nothing actionable", async () => {
    const r = rig(sentence("delete all my files now please"));
    r.lw.start(0);
    r.advance(2000);
    await r.lw.tick();
    r.advance(2000);
    await r.lw.tick();
    for (const u of r.updates) {
      expect(Object.keys(u).sort()).toEqual(
        ["language", "passes", "settled", "shown", "unstable"].sort(),
      );
    }
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const at = mode.indexOf("onUpdate: (update) => {");
    const body = mode.slice(at, mode.indexOf("});", at));
    expect(body).toMatch(/this\.state\.interim\s*=/);
    expect(body).not.toMatch(/submit|runCommand|handleHeard|brain/i);
  });
});

describe("livePassDeps (the request one live pass makes)", () => {
  function fakeApi(replies: Partial<LivePassReply>[]) {
    const calls: Record<string, unknown>[] = [];
    const cancels: Record<string, unknown>[] = [];
    let i = 0;
    return {
      calls,
      cancels,
      api: {
        transcribe: async (payload: Record<string, unknown>) => {
          calls.push(payload);
          const r = replies[Math.min(i, replies.length - 1)] ?? {};
          i += 1;
          return { ok: true, text: "x", ...r } as LivePassReply;
        },
        cancelTranscribe: async (payload: Record<string, unknown>) => {
          cancels.push(payload);
          return { ok: true };
        },
      },
    };
  }
  const voice = () => ({ language: "hi", speechPref: "hi-IN", sttSize: "small" });

  it("asks for a provisional, local-only, timed read with a clean utterance id", async () => {
    const f = fakeApi([{ words: [] }]);
    const deps = livePassDeps(f.api, voice);
    await deps.transcribe(new Uint8Array(4), { language: "en", utteranceId: "live-1" });
    expect(f.calls[0]).toMatchObject({
      mime: "audio/wav",
      provisional: true,
      livePass: true,
      localOnly: true,
      utteranceId: "live-1",
      language: "en",
      speechPref: "hi-IN",
      model: "small",
      sttSize: "small",
    });
  });

  it("uses the owner's language when the pass has no locked one, and none when auto", async () => {
    const f = fakeApi([{}]);
    const deps = livePassDeps(f.api, voice);
    await deps.transcribe(new Uint8Array(4), { language: "", utteranceId: "live-2" });
    expect(f.calls[0]?.["language"]).toBe("hi");
    const g = fakeApi([{}]);
    await livePassDeps(g.api, () => ({})).transcribe(new Uint8Array(4), {
      language: "",
      utteranceId: "live-3",
    });
    expect("speechPref" in g.calls[0]!).toBe(false);
    expect(g.calls[0]?.["language"]).toBeUndefined();
  });

  it("falls back to today's plain text read when the engine cannot read speculatively", async () => {
    const f = fakeApi([
      { ok: false, reason: "not-ready", unsupportedEngine: true },
      { text: "plain words" },
    ]);
    const deps = livePassDeps(f.api, voice);
    const out = await deps.transcribe(new Uint8Array(4), { language: "", utteranceId: "live-4" });
    expect(out).toMatchObject({ ok: true, text: "plain words" });
    expect(f.calls[1]?.["provisional"]).toBeUndefined();
    expect(f.calls[1]?.["localOnly"]).toBe(true);
  });

  it("a busy or not-yet-loaded worker skips the pass without a fallback read", async () => {
    for (const reason of ["busy", "not-ready"]) {
      const f = fakeApi([{ ok: false, reason }]);
      const out = await livePassDeps(f.api, voice).transcribe(new Uint8Array(4), {
        language: "",
        utteranceId: "live-5",
      });
      expect(out.ok).toBe(false);
      expect(f.calls).toHaveLength(1);
    }
  });

  it("cancels by utterance id", () => {
    const f = fakeApi([{}]);
    livePassDeps(f.api, voice).cancel?.("live-6");
    expect(f.cancels).toEqual([{ utteranceId: "live-6" }]);
  });
});
