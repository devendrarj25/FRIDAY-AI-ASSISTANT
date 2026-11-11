/**
 * Interrupting speech: every pending playback and pause settles, every clip that will not be played gives its
 * resources back, a late chunk of a cancelled answer is refused, and the next turn can start at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgressiveAudio,
  type MediaImpl,
} from "../../src/lib/friday/voice-engine/progressive-audio";
import {
  PcmPlayback,
  type ContextLike,
} from "../../src/lib/friday/voice-engine/playback-scheduler";
import { runSpeechPipeline } from "../../src/lib/friday/voice-engine/speech-pipeline";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A browser stand-in that records what is created and what is given back. */
function fakeMedia() {
  const log = {
    revoked: [] as string[],
    created: 0,
    paused: 0,
    aborted: 0,
    ended: 0,
    appended: [] as number[],
    srcRemoved: 0,
    loaded: 0,
  };
  let openSource: (() => void) | null = null;
  class FakeBuffer {
    updating = false;
    listeners: Record<string, Array<() => void>> = {};
    addEventListener(name: string, fn: () => void) {
      (this.listeners[name] ??= []).push(fn);
    }
    appendBuffer(data: Uint8Array) {
      log.appended.push(data.length);
      this.updating = true;
    }
    abort() {
      log.aborted += 1;
      this.updating = false;
    }
    finish() {
      this.updating = false;
      for (const fn of this.listeners["updateend"] ?? []) fn();
    }
  }
  const buffers: FakeBuffer[] = [];
  class FakeSource {
    readyState = "closed";
    static isTypeSupported = () => true;
    addEventListener(_n: string, fn: () => void) {
      openSource = () => {
        this.readyState = "open";
        fn();
      };
    }
    addSourceBuffer() {
      const b = new FakeBuffer();
      buffers.push(b);
      return b;
    }
    endOfStream() {
      log.ended += 1;
      this.readyState = "ended";
    }
  }
  class FakeAudio {
    src = "";
    preload = "";
    pause() {
      log.paused += 1;
    }
    removeAttribute() {
      log.srcRemoved += 1;
    }
    load() {
      log.loaded += 1;
    }
    addEventListener() {}
  }
  const impl = {
    MediaSource: FakeSource,
    Audio: FakeAudio,
    URL: {
      createObjectURL: () => `blob:${(log.created += 1)}`,
      revokeObjectURL: (u: string) => log.revoked.push(u),
    },
  } as unknown as MediaImpl;
  return { impl, log, buffers, open: () => openSource?.() };
}

describe("ProgressiveAudio.dispose", () => {
  it("gives back the URL, drops queued pieces, ends the source and ignores everything afterwards", () => {
    const m = fakeMedia();
    const stream = new ProgressiveAudio(m.impl);
    m.open();
    stream.append(new Uint8Array(10)); // written to the buffer, which is now updating
    stream.append(new Uint8Array(20)); // queued behind it
    stream.append(new Uint8Array(30));
    expect(stream.queuedPieces).toBe(2);
    stream.dispose();
    expect(stream.isDisposed).toBe(true);
    expect(stream.queuedPieces).toBe(0);
    expect(m.log.revoked).toEqual(["blob:1"]);
    expect(m.log.aborted).toBe(1); // the append in progress was cancelled
    expect(m.log.ended).toBe(1);
    expect(m.log.paused).toBe(1);
    expect(m.log.srcRemoved).toBe(1);
    expect(m.log.loaded).toBe(1);
    // A late piece, a late end and a late update event change nothing.
    stream.append(new Uint8Array(40));
    stream.end();
    m.buffers[0]!.finish();
    expect(m.log.appended).toEqual([10]);
    expect(stream.queuedPieces).toBe(0);
  });

  it("is safe before the source opens, twice, and after the stream failed", () => {
    const m = fakeMedia();
    const early = new ProgressiveAudio(m.impl);
    early.append(new Uint8Array(5));
    early.dispose();
    early.dispose();
    expect(m.log.revoked).toEqual(["blob:1"]); // given back once
    m.open(); // the browser opens the source after the dispose: no buffer is created
    expect(m.buffers).toHaveLength(0);
    expect(m.log.appended).toEqual([]);
  });

  it("does not give the URL back twice when the clip already ended and was released", () => {
    const m = fakeMedia();
    const stream = new ProgressiveAudio(m.impl);
    m.open();
    stream.append(new Uint8Array(3));
    m.buffers[0]!.finish();
    stream.end();
    stream.dispose();
    stream.dispose();
    expect(m.log.revoked).toHaveLength(1);
  });
});

describe("speech pipeline releases clips that will never play", () => {
  it("disposes the clip in hand, the ones made ahead, and ones that arrive after the pipeline ended", async () => {
    let stale = false;
    const disposed: string[] = [];
    const late: { resolve: ((v: string) => void) | null } = { resolve: null };
    const out = await runSpeechPipeline<string, string>({
      items: ["a", "b", "c", "d"],
      ahead: 3,
      stale: () => stale,
      synthesize: (item) =>
        item === "d"
          ? new Promise<string>((resolve) => {
              late.resolve = resolve; // still being made when the speech is cut off
            })
          : Promise.resolve(item),
      play: async () => {
        stale = true; // the owner interrupts while "a" plays
      },
      dispose: (clip) => disposed.push(clip),
      sleep: async () => undefined,
    });
    expect(out).toMatchObject({ played: 1, stale: true });
    await tick();
    expect(disposed.sort()).toEqual(["b", "c"]);
    late.resolve?.("d");
    await tick();
    expect(disposed.sort()).toEqual(["b", "c", "d"]);
  });

  it("disposes the clips made ahead when an earlier clip failed", async () => {
    const disposed: string[] = [];
    const out = await runSpeechPipeline<string, string>({
      items: ["a", "b", "c"],
      ahead: 3,
      stale: () => false,
      synthesize: async (item) => (item === "a" ? null : item),
      play: async () => undefined,
      dispose: (clip) => disposed.push(clip),
    });
    expect(out.failedAt).toBe(0);
    await tick();
    expect(disposed.sort()).toEqual(["b", "c"]);
  });
});

describe("gapless PCM playback refuses a cancelled answer", () => {
  function context() {
    const sources: Array<{ stopped: boolean; onended: (() => void) | null }> = [];
    const ctx = {
      currentTime: 0,
      destination: {},
      createBuffer: () => ({ copyToChannel: () => undefined }),
      createBufferSource: () => {
        const src = {
          buffer: null as unknown,
          stopped: false,
          onended: null as (() => void) | null,
          connect: () => undefined,
          start: () => undefined,
          stop() {
            this.stopped = true;
          },
        };
        sources.push(src);
        return src;
      },
    };
    return { ctx: ctx as unknown as ContextLike & { currentTime: number }, sources };
  }

  it("drops a late chunk of the flushed generation and accepts the next one", () => {
    const { ctx, sources } = context();
    const playback = new PcmPlayback(ctx, { rate: 16000 });
    const first = playback.currentGeneration;
    expect(playback.enqueue(new Int16Array(1600), first)).toBe(true);
    playback.flush();
    expect(sources[0]!.stopped).toBe(true);
    expect(playback.enqueue(new Int16Array(1600), first)).toBe(false); // the provider is still sending the old answer
    expect(playback.stats().dropped).toBe(1);
    expect(playback.enqueue(new Int16Array(1600), playback.currentGeneration)).toBe(true);
    expect(playback.enqueue(new Int16Array(1600))).toBe(true); // the older call shape still works
  });

  it("dispose stops everything and refuses every later chunk", () => {
    const { ctx, sources } = context();
    const playback = new PcmPlayback(ctx, { rate: 16000 });
    playback.enqueue(new Int16Array(1600));
    playback.dispose();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(playback.enqueue(new Int16Array(1600))).toBe(false);
    expect(playback.audible()).toBe(false);
  });
});

describe("the streaming voice on an interruption", () => {
  it("disposes the clause that was still arriving and lets the next clause start at once", async () => {
    const { createStreamingSpeak } =
      await import("../../src/lib/friday/voice-engine/streaming-speak");
    const m = fakeMedia();
    const events: Array<(p: { id: string; event: { type: string } }) => void> = [];
    const opened: Array<(p: { id: string }) => void> = [];
    const sent: Array<Record<string, unknown>> = [];
    const opens: string[] = [];
    const closes: string[] = [];
    const api = {
      voiceStreamOpen: async (id: string) => (opens.push(id), { ok: true, opened: true }),
      voiceStreamSend: async (_id: string, msg: Record<string, unknown>) => (
        sent.push(msg),
        { ok: true }
      ),
      voiceStreamClose: async (id: string) => (closes.push(id), { ok: true }),
      onVoiceStreamOpened: (cb: (p: { id: string }) => void) => (opened.push(cb), () => undefined),
      onVoiceStreamEvent: (cb: (p: { id: string; event: { type: string } }) => void) => (
        events.push(cb),
        () => undefined
      ),
      onVoiceStreamClosed: () => () => undefined,
    };
    const rest = vi.fn(async () => ({ ok: true, audioBase64: "REST", mime: "audio/wav" }));
    const speaker = createStreamingSpeak({ api: api as never, rest, media: m.impl });
    const request = { text: "लंबा वाक्य।", language: "hi-IN", speaker: "aparna_hi_customer" };
    const first = speaker.speak("sarvam", request);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    const emit = (event: Record<string, unknown>, id = opens[opens.length - 1]!) =>
      events.forEach((f) => f({ id, event: event as never }));
    emit({ type: "audio", audioBase64: btoa("AB"), mime: "audio/mpeg" });
    const early = await first;
    expect(early.ok).toBe(true);
    expect(typeof early.release).toBe("function");
    expect(m.log.revoked).toEqual([]);
    speaker.cancel(); // the owner interrupts mid-clause
    expect(m.log.revoked).toEqual(["blob:1"]);
    emit({ type: "audio", audioBase64: btoa("LATE"), mime: "audio/mpeg" }, opens[0]); // a late frame goes nowhere
    expect(m.log.appended.length).toBeLessThanOrEqual(1);
    // The provider is still making the cancelled sentence and answers in order: the next turn does not wait behind
    // it. The old connection is closed and a new one carries the new sentence at once.
    const next = speaker.speak("sarvam", { ...request, text: "नया वाक्य।" });
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    expect(closes).toEqual([opens[0]]);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(4));
    emit({ type: "audio", audioBase64: btoa("CD"), mime: "audio/mpeg" }, opens[1]);
    expect((await next).ok).toBe(true);
    expect(rest).not.toHaveBeenCalled();
    // Releasing the first clip again (the player does so when it drops it) changes nothing.
    early.release?.();
    expect(m.log.revoked).toHaveLength(1);
  });
});

describe("the voice library on an interruption", () => {
  type Win = { friday?: unknown; speechSynthesis?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  const played: Array<{ paused: boolean; ended: boolean }> = [];

  beforeEach(() => {
    played.length = 0;
    class HangingAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      state = { paused: false, ended: false };
      constructor(public src: string) {
        played.push(this.state);
      }
      play() {
        return Promise.resolve(); // a clip that plays for a long time: it never ends by itself
      }
      pause() {
        this.state.paused = true; // pausing fires no "ended" event, as in a browser
      }
    }
    g.Audio = HangingAudio;
  });
  afterEach(() => {
    g.window = saved.window;
    g.Audio = saved.Audio;
  });

  const tuning = {
    voiceName: "",
    lang: "en-IN",
    rate: 1,
    pitch: 1,
    volume: 1,
    kind: "neural" as const,
  };
  const neural = (calls: string[]) => ({
    friday: {
      speakNeural: async (req: { text: string }) => {
        calls.push(req.text);
        return {
          ok: true,
          audioBase64: Buffer.from(req.text).toString("base64"),
          mime: "audio/mpeg",
          engine: "local",
        };
      },
    },
  });

  it("settles a clip that is playing the moment speech is stopped, and the next turn starts at once", async () => {
    const lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    const calls: string[] = [];
    g.window = neural(calls);
    const events: string[] = [];
    const speaking = lib.speakText("First sentence here. Second sentence follows.", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    await vi.waitFor(() => expect(played.length).toBe(1));
    expect(lib.pendingSpeechOperations()).toBe(1);
    lib.stopSpeaking(); // the owner interrupts
    const how = await Promise.race([speaking, tick(500).then(() => "HUNG")]);
    expect(how).toBe("none"); // settled, and not "HUNG": nothing is left waiting for an event that never comes
    expect(played[0]!.paused).toBe(true);
    expect(lib.pendingSpeechOperations()).toBe(0);
    // The next turn begins immediately and is not mistaken for the old one.
    const second = lib.speakText("Fresh reply.", tuning);
    await vi.waitFor(() => expect(played.length).toBe(2));
    expect(played[1]!.paused).toBe(false);
    lib.stopSpeaking();
    expect(await Promise.race([second, tick(500).then(() => "HUNG")])).toBe("none");
    expect(lib.pendingSpeechOperations()).toBe(0);
  });

  it("gives back the stream of a playing cloud clip and of a clause made ahead that never played", async () => {
    const lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    g.window = neural([]);
    const released: string[] = [];
    const clip = (name: string) => ({
      audioBase64: "",
      mime: "audio/mpeg",
      engine: "sarvam",
      audio: new (g.Audio as new (s: string) => unknown)(name),
      release: () => void released.push(name),
    });
    let n = 0;
    const speaking = lib.speakText(
      "Namaste, kaise hain aap. The report is ready now. Aap ka din shubh ho.",
      {
        ...tuning,
        cloudClip: async () => clip(`clip${(n += 1)}`),
      },
    );
    await vi.waitFor(() => expect(played.length).toBeGreaterThanOrEqual(2)); // clip1 plays, others were made ahead
    lib.stopSpeaking();
    await speaking;
    await tick(5);
    // Every clip that was made is given back exactly once: the one playing and the ones that never played.
    expect(released.sort()).toEqual(["clip1", "clip2", "clip3"].slice(0, released.length).sort());
    expect(new Set(released).size).toBe(released.length);
    expect(released.length).toBeGreaterThanOrEqual(2);
    expect(lib.pendingSpeechOperations()).toBe(0);
  });

  it("cuts the pause between two clauses short", async () => {
    const lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    g.window = neural([]);
    // This clip ends by itself, so the pipeline moves on to the pause that follows a sentence.
    let started = 0;
    class QuickAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        started += 1;
        setTimeout(() => this.onended?.(), 1);
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = QuickAudio;
    const speaking = lib.speakText("Namaste, kaise hain aap. The report is ready now.", {
      ...tuning,
      expressive: true,
    });
    // The first clause ends after 1 ms; the pause that follows a sentence is 150 ms.
    await vi.waitFor(() => expect(lib.pendingSpeechOperations()).toBe(1), { interval: 2 });
    await tick(10); // past the 1 ms clip: what is waiting now is the pause
    expect(started).toBe(1);
    lib.stopSpeaking();
    expect(await Promise.race([speaking, tick(1000).then(() => "HUNG")])).toBe("none");
    expect(lib.pendingSpeechOperations()).toBe(0);
    // Judged by what happened, not by a clock: had the pause run its course, the second clause would have started.
    await tick(400);
    expect(started).toBe(1);
  });
});
