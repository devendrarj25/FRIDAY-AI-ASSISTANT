import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LiveWords, type LiveWordsUpdate } from "../../src/lib/friday/voice-engine/live-words";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

function rig(
  texts: (string | null)[],
  opts: { speaking?: () => boolean; maxPasses?: number } = {},
) {
  let t = 0;
  const updates: LiveWordsUpdate[] = [];
  const calls: number[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  let i = 0;
  const lw = new LiveWords({
    audioSince: () => ({ samples: new Float32Array(16_000 * 2), rate: 16_000 }),
    encodeWav: (s) => new Uint8Array(s.length),
    transcribe: async () => {
      calls.push(t);
      if (hold) await new Promise<void>((r) => (release = r));
      const text = texts[Math.min(i, texts.length - 1)];
      i += 1;
      return text === null ? { ok: false } : { ok: true, text: text! };
    },
    speaking: opts.speaking ?? (() => true),
    onUpdate: (u) => updates.push(u),
    now: () => t,
    hopMs: 1000,
    ...(opts.maxPasses ? { maxPasses: opts.maxPasses } : {}),
  });
  return {
    lw,
    updates,
    calls,
    advance: (ms: number) => (t += ms),
    hold: (v: boolean) => (hold = v),
    release: () => release?.(),
  };
}

describe("LiveWords", () => {
  it("settles a word only after two passes agree, and shows the rest as provisional", async () => {
    const r = rig(["aaj ka", "aaj ka weather", "aaj ka weather batao"]);
    r.lw.start(0);
    await r.lw.tick();
    expect(r.updates.at(-1)).toMatchObject({ settled: "", shown: "aaj ka", passes: 1 });
    r.advance(1000);
    await r.lw.tick();
    expect(r.updates.at(-1)).toMatchObject({
      settled: "aaj ka",
      shown: "aaj ka weather",
      passes: 2,
    });
    r.advance(1000);
    await r.lw.tick();
    expect(r.updates.at(-1)).toMatchObject({
      settled: "aaj ka weather",
      shown: "aaj ka weather batao",
    });
  });

  it("does a pass only once per hop and never two at once", async () => {
    const r = rig(["one two three"]);
    r.lw.start(0);
    r.hold(true);
    const first = r.lw.tick();
    await r.lw.tick();
    await r.lw.tick();
    expect(r.calls).toHaveLength(1);
    r.release();
    await first;
    r.hold(false);
    await r.lw.tick(); // inside the hop
    expect(r.calls).toHaveLength(1);
    r.advance(1000);
    await r.lw.tick();
    expect(r.calls).toHaveLength(2);
  });

  it("stops by itself the moment speech stops, so the final reading is not delayed", async () => {
    let speaking = true;
    const r = rig(["hello there friend"], { speaking: () => speaking });
    r.lw.start(0);
    await r.lw.tick();
    speaking = false;
    r.advance(1000);
    await r.lw.tick();
    expect(r.lw.isActive()).toBe(false);
    expect(r.calls).toHaveLength(1);
  });

  it("drops a result that arrives after stop, skips empty and failed passes, and bounds the passes", async () => {
    const r = rig([null, "", "ok fine then"], { maxPasses: 1 });
    r.lw.start(0);
    await r.lw.tick();
    r.advance(1000);
    await r.lw.tick();
    r.advance(1000);
    await r.lw.tick();
    expect(r.updates).toHaveLength(1);
    r.advance(1000);
    await r.lw.tick();
    expect(r.calls).toHaveLength(3); // the fourth is refused: one counted pass is the bound
    const late = rig(["late words here"]);
    late.lw.start(0);
    late.hold(true);
    const pending = late.lw.tick();
    late.lw.stop();
    late.release();
    await pending;
    expect(late.updates).toEqual([]);
  });

  it("waits for enough audio before the first pass", async () => {
    const lw = new LiveWords({
      audioSince: () => ({ samples: new Float32Array(1000), rate: 16_000 }),
      encodeWav: () => new Uint8Array(),
      transcribe: async () => {
        throw new Error("must not be called");
      },
      speaking: () => true,
      onUpdate: () => undefined,
      now: () => 0,
    });
    lw.start(0);
    await expect(lw.tick()).resolves.toBeUndefined();
  });
});

describe("live words wiring", () => {
  it("is off by default and switched in Settings, and only Auto mode follows an utterance", () => {
    expect(DEFAULT_PREFERENCES.voice.liveWords).toBe(false);
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toContain("voice.liveWords === true");
    expect(mode).toContain("this.liveWords.start(");
    expect(readFileSync("src/components/friday/settings/VoiceSettings.tsx", "utf8")).toContain(
      "liveWords",
    );
  });
});
