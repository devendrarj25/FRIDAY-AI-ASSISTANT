/**
 * Provisional (speculative) decode: start at the model-confirmed end, cancel when speech resumes, adopt only when
 * the final audio is the same window, never adopt a stale one. A fake clock and a fake worker; no PC.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PROVISIONAL_MAX_DECODE_MS,
  PROVISIONAL_MAX_TAIL_MS,
  ProvisionalDecoder,
  fingerprintSamples,
  provisionalWanted,
  sameWindow,
} from "../../src/lib/friday/voice-engine/provisional-decode";

type Result = { ok: boolean; text?: string; reason?: string; cancelled?: boolean; engine?: string };

function clip(ms: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round((ms * 16000) / 1000));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((i + seed) * 0.01) * 0.2;
  return out;
}

/** Extends a clip with `ms` of near-silence, the way the ring grows while the owner is quiet. */
function withQuiet(base: Float32Array, ms: number): Float32Array {
  const extra = new Float32Array(Math.round((ms * 16000) / 1000)).fill(0.001);
  const out = new Float32Array(base.length + extra.length);
  out.set(base);
  out.set(extra, base.length);
  return out;
}

function rig() {
  let clock = 10_000;
  const asked: Array<{ utteranceId: string }> = [];
  const cancelled: string[] = [];
  const waits: Array<(value: Result) => void> = [];
  const decoder = new ProvisionalDecoder<Result>({
    now: () => clock,
    transcribe: (req) => {
      asked.push(req);
      return new Promise<Result>((resolve) => waits.push(resolve));
    },
    cancel: (id) => {
      cancelled.push(id);
    },
  });
  return {
    decoder,
    asked,
    cancelled,
    waits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("when a provisional decode is wanted", () => {
  it("only on a model score of 0.5 or more, in quiet, with the worker free and nothing already running", () => {
    const base = {
      score: 0.7,
      speech: false,
      tooLong: false,
      busy: false,
      running: false,
      keepClips: false,
      pcm: true,
    };
    expect(provisionalWanted(base)).toBe(true);
    expect(provisionalWanted({ ...base, score: 0.5 })).toBe(true);
    expect(provisionalWanted({ ...base, score: 0.49 })).toBe(false);
    expect(provisionalWanted({ ...base, score: null })).toBe(false);
    expect(provisionalWanted({ ...base, speech: true })).toBe(false);
    expect(provisionalWanted({ ...base, tooLong: true })).toBe(false);
    expect(provisionalWanted({ ...base, busy: true })).toBe(false);
    expect(provisionalWanted({ ...base, running: true })).toBe(false);
    expect(provisionalWanted({ ...base, keepClips: true })).toBe(false);
    expect(provisionalWanted({ ...base, pcm: false })).toBe(false);
  });
});

describe("the same window", () => {
  const base = clip(2000);
  const record = {
    length: base.length,
    fingerprint: fingerprintSamples(base),
    startedAt: 1000,
    quietMs: 300,
  };

  it("accepts the same audio plus the quiet that followed, with speech not resumed", () => {
    const final = withQuiet(base, 200);
    expect(sameWindow(record, final, { quietMs: 500, now: 1200 })).toBe(true);
  });

  it("rejects audio whose first part changed (a different window)", () => {
    const other = withQuiet(clip(2000, 7), 200);
    expect(sameWindow(record, other, { quietMs: 500, now: 1200 })).toBe(false);
  });

  it("rejects a shorter final, and a tail longer than the time that passed", () => {
    expect(
      sameWindow(record, base.subarray(0, base.length - 10), { quietMs: 500, now: 1200 }),
    ).toBe(false);
    expect(sameWindow(record, withQuiet(base, 900), { quietMs: 500, now: 1200 })).toBe(false);
    const tooLong = withQuiet(base, PROVISIONAL_MAX_TAIL_MS + 200);
    expect(
      sameWindow(record, tooLong, { quietMs: 5000, now: 1000 + PROVISIONAL_MAX_TAIL_MS + 500 }),
    ).toBe(false);
  });

  it("rejects when speech blipped in between: the quiet clock restarted", () => {
    const final = withQuiet(base, 200);
    expect(sameWindow(record, final, { quietMs: 90, now: 1200 })).toBe(false);
  });
});

describe("start, cancel, adopt", () => {
  it("starts once per generation and asks the worker for a provisional pass with a clean id", () => {
    const { decoder, asked } = rig();
    const audio = clip(1500);
    expect(decoder.start({ samples: audio, quietMs: 300, signature: "hi|small" })).toBe(true);
    expect(decoder.start({ samples: audio, quietMs: 300, signature: "hi|small" })).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.utteranceId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(decoder.active()).toBe(true);
  });

  it("adopts the provisional text when the sealed window equals it: no second decode is needed", async () => {
    const { decoder, waits, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    advance(250);
    const handle = decoder.seal({ samples: withQuiet(audio, 250), quietMs: 550, signature: "s" });
    expect(handle).not.toBeNull();
    expect(decoder.active()).toBe(false);
    waits[0]?.({ ok: true, text: "open chrome", engine: "faster-whisper" });
    await expect(handle?.take()).resolves.toMatchObject({ ok: true, text: "open chrome" });
    expect(decoder.stats()).toMatchObject({ started: 1, adopted: 1, cancelled: 0 });
  });

  it("waits for a decode that is still running instead of starting another", async () => {
    const { decoder, waits, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    advance(100);
    const handle = decoder.seal({ samples: withQuiet(audio, 100), quietMs: 400, signature: "s" });
    let done = false;
    const taken = handle?.take().then((value) => {
      done = true;
      return value;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    waits[0]?.({ ok: true, text: "what time is it" });
    expect((await taken)?.text).toBe("what time is it");
  });

  it("cancels the decode when speech resumes and never adopts its late answer", async () => {
    const { decoder, waits, cancelled, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    const first = cancelled.length;
    decoder.invalidate(); // speech resumed
    expect(cancelled.length).toBe(first + 1);
    expect(decoder.active()).toBe(false);
    waits[0]?.({ ok: true, text: "stale words" });
    advance(300);
    expect(
      decoder.seal({ samples: withQuiet(audio, 300), quietMs: 600, signature: "s" }),
    ).toBeNull();
    expect(decoder.stats()).toMatchObject({ cancelled: 1, adopted: 0 });
  });

  it("a stale decode from an older generation is never adopted by a newer pause", async () => {
    const { decoder, waits, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    decoder.invalidate();
    const later = clip(2600, 3);
    decoder.start({ samples: later, quietMs: 300, signature: "s" });
    advance(200);
    const handle = decoder.seal({ samples: withQuiet(later, 200), quietMs: 500, signature: "s" });
    expect(handle).not.toBeNull();
    waits[0]?.({ ok: true, text: "old pause" }); // the first decode answers last
    waits[1]?.({ ok: true, text: "new pause" });
    expect((await handle?.take())?.text).toBe("new pause");
  });

  it("a handle already handed to the queue survives the next segment opening", async () => {
    const { decoder, waits, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    advance(200);
    const handle = decoder.seal({ samples: withQuiet(audio, 200), quietMs: 500, signature: "s" });
    decoder.invalidate(); // the next utterance opens while this one waits its turn
    waits[0]?.({ ok: true, text: "send the report" });
    expect((await handle?.take())?.text).toBe("send the report");
  });

  it("does not adopt when the final audio differs, the options differ, or speech blipped", () => {
    for (const change of ["audio", "signature", "blip"] as const) {
      const { decoder, cancelled, advance } = rig();
      const audio = clip(1500);
      decoder.start({ samples: audio, quietMs: 300, signature: "s" });
      advance(200);
      const handle = decoder.seal({
        samples: change === "audio" ? withQuiet(clip(1500, 9), 200) : withQuiet(audio, 200),
        quietMs: change === "blip" ? 60 : 500,
        signature: change === "signature" ? "other" : "s",
      });
      expect(handle, change).toBeNull();
      expect(cancelled.length, change).toBe(1);
    }
  });

  it("falls back (null) for a busy, failed, empty or cancelled answer, and for a thrown one", async () => {
    const answers: Array<Result | Error> = [
      { ok: false, reason: "busy" },
      { ok: false, reason: "cancelled", cancelled: true },
      { ok: true, text: "   " },
      { ok: false, reason: "engine-failed" },
      new Error("ipc budget expired"),
    ];
    for (const answer of answers) {
      let clock = 0;
      const decoder = new ProvisionalDecoder<Result>({
        now: () => clock,
        transcribe: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
        cancel: () => {},
      });
      const audio = clip(1200);
      decoder.start({ samples: audio, quietMs: 300, signature: "s" });
      clock += 200;
      const handle = decoder.seal({ samples: withQuiet(audio, 200), quietMs: 500, signature: "s" });
      await expect(handle ? handle.take() : Promise.resolve(null)).resolves.toBeNull();
    }
  });

  it("cancelling a handle (a dropped queue entry) tells the worker once", () => {
    const { decoder, cancelled, advance } = rig();
    const audio = clip(1500);
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });
    advance(100);
    const handle = decoder.seal({ samples: withQuiet(audio, 100), quietMs: 400, signature: "s" });
    handle?.cancel();
    handle?.cancel();
    expect(cancelled).toHaveLength(1);
  });

  it("a cancel callback that throws never breaks the capture", () => {
    const decoder = new ProvisionalDecoder<Result>({
      now: () => 0,
      transcribe: () => new Promise(() => {}),
      cancel: () => {
        throw new Error("bridge gone");
      },
    });
    decoder.start({ samples: clip(1000), quietMs: 300, signature: "s" });
    expect(() => decoder.invalidate()).not.toThrow();
    expect(() => decoder.cancel()).not.toThrow();
  });

  it("an empty window or a missing bridge starts nothing", () => {
    const transcribe = vi.fn();
    const decoder = new ProvisionalDecoder<Result>({ now: () => 0, transcribe, cancel: () => {} });
    expect(decoder.start({ samples: new Float32Array(0), quietMs: 300, signature: "s" })).toBe(
      false,
    );
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("is an early read worth making", () => {
  const audio = clip(1200);
  const read = (decoder: ProvisionalDecoder<Result>) =>
    decoder.start({ samples: audio, quietMs: 300, signature: "s" });

  it("not on a decoder so slow that a cancel would cost more than the read saves", () => {
    const { decoder } = rig();
    expect(decoder.worthwhile(null)).toBe(true);
    expect(decoder.worthwhile(PROVISIONAL_MAX_DECODE_MS)).toBe(true);
    expect(decoder.worthwhile(PROVISIONAL_MAX_DECODE_MS + 1)).toBe(false);
  });

  it("pauses when most recent reads were wasted, and tries again after a few utterances", () => {
    const { decoder } = rig();
    for (let i = 0; i < 3; i += 1) {
      read(decoder);
      decoder.invalidate();
      expect(decoder.worthwhile(null)).toBe(true); // too few to judge
    }
    read(decoder);
    decoder.invalidate();
    expect(decoder.worthwhile(null)).toBe(false);
    for (let i = 0; i < 5; i += 1) decoder.openSegment();
    expect(decoder.worthwhile(null)).toBe(false);
    decoder.openSegment();
    expect(decoder.worthwhile(null)).toBe(true);
  });

  it("a quarter wasted is still worth it, half is not; adopted reads count in its favour", async () => {
    let clock = 0;
    const decoder = new ProvisionalDecoder<Result>({
      now: () => clock,
      transcribe: async () => ({ ok: true, text: "hello there" }),
      cancel: () => {},
    });
    for (let i = 0; i < 4; i += 1) {
      decoder.openSegment();
      read(decoder);
      if (i !== 3) {
        clock += 100;
        const handle = decoder.seal({
          samples: withQuiet(audio, 100),
          quietMs: 400,
          signature: "s",
        });
        await handle?.take();
      } else {
        decoder.invalidate();
      }
    }
    expect(decoder.stats()).toMatchObject({ adopted: 3, cancelled: 1 });
    expect(decoder.worthwhile(null)).toBe(true);
    decoder.openSegment();
    read(decoder);
    decoder.invalidate(); // 2 wasted of 5
    expect(decoder.worthwhile(null)).toBe(false);
  });
});
