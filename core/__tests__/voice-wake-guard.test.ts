import { describe, expect, it } from "vitest";
import { advanceVad, suppressSelfVoice } from "../../src/lib/friday/voice-audio";
import { wakeGuardRows } from "../../src/lib/friday/voice-diagnostics-rows";
import { MAX_RING_MS, PcmRing, TARGET_RATE } from "../../src/lib/friday/pcm-capture";
import {
  normalizeWakeGuardConfig,
  SCENE_ACT_AT,
  SCENE_BOOST_MAX,
  SCENE_HOLD_MS,
  WAKE_GUARD_DEFAULTS,
  WakeGuard,
  type HandsFreeState,
} from "../../src/lib/friday/wake-guard";
import { acceptsVoiceTurn } from "../../src/lib/friday/voice-session";

/* ------------------------------------------------------------ synthetic rooms (fixed seed, no real clock) */

const FRAME = 320; // 20 ms at 16 kHz
const FRAME_MS = 20;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** A voiced, syllable-modulated burst: harmonics under a 4 Hz envelope, so the level wobbles like speech. */
function speechFrame(index: number, amp: number): Float32Array {
  const out = new Float32Array(FRAME);
  for (let n = 0; n < FRAME; n += 1) {
    const t = (index * FRAME + n) / TARGET_RATE;
    const env = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 4 * t));
    const wave =
      Math.sin(2 * Math.PI * 140 * t) +
      0.5 * Math.sin(2 * Math.PI * 280 * t) +
      0.3 * Math.sin(2 * Math.PI * 560 * t);
    out[n] = amp * env * wave;
  }
  return out;
}

/** Steady broadband noise at a fixed RMS (a fan, a hum). */
function noiseFrame(next: () => number, level: number): Float32Array {
  const out = new Float32Array(FRAME);
  for (let n = 0; n < FRAME; n += 1) out[n] = (next() * 2 - 1) * level * Math.sqrt(3);
  return out;
}

/** Room tone: a real microphone is never exactly zero, and the VAD reads a zero floor as "not learned yet". */
const roomTone = prng(11);
const silenceFrame = () => noiseFrame(roomTone, 0.002);

/** The real VAD (`advanceVad`) drives the guard, frame by frame, on a fake clock. */
class Room {
  guard: WakeGuard;
  now = 100_000;
  floor = 0;
  voiceFrames = 0;
  speakingGuard = false;
  index = 0;
  lastSpeech = false;

  constructor(guard = new WakeGuard()) {
    this.guard = guard;
  }

  step(frame: Float32Array, speaking = false): void {
    this.speakingGuard = speaking;
    const level = rms(frame);
    const vad = advanceVad({
      level,
      noiseFloor: this.floor,
      voiceFrames: this.voiceFrames,
      speakingGuard: speaking,
      ducked: false,
    });
    this.floor = vad.noiseFloor;
    this.voiceFrames = vad.voiceFrames;
    this.lastSpeech = vad.speech;
    this.now += FRAME_MS;
    this.index += 1;
    this.guard.observe({ nowMs: this.now, level, speech: vad.speech, speaking });
  }

  run(ms: number, make: (i: number) => Float32Array, speaking = false): void {
    for (let t = 0; t < ms; t += FRAME_MS) this.step(make(this.index), speaking);
  }

  quiet(ms: number): void {
    this.run(ms, silenceFrame);
  }

  talk(ms: number, amp = 0.25): void {
    this.run(ms, (i) => speechFrame(i, amp));
  }

  noise(ms: number, level: number, seed = 7): void {
    const next = prng(seed + this.index);
    this.run(ms, () => noiseFrame(next, level));
  }
}

const THRESHOLD = 0.5;
const wakeAt = (room: Room, extra: Partial<Parameters<WakeGuard["consider"]>[0]> = {}) =>
  room.guard.consider({
    nowMs: room.now,
    score: 0.9,
    threshold: THRESHOLD,
    kind: "utterance",
    ownerEnergy: 0.3,
    playbackEnergy: 0,
    ...extra,
  });

/* ------------------------------------------------------------ the gates */

describe("wake guard: VAD must have heard speech first", () => {
  it("does not wake on silence or on a tiny blip, wakes after real speech", () => {
    const room = new Room();
    room.quiet(1000);
    expect(wakeAt(room)).toEqual({ accept: false, reason: "no-speech" });
    room.talk(100);
    room.quiet(300);
    expect(wakeAt(room).reason).toBe("no-speech");
    room.talk(700);
    room.quiet(200);
    expect(wakeAt(room)).toEqual({ accept: true, reason: "accepted" });
    expect(room.guard.current).toBe("listening");
  });

  it("lets a speech run back a wake for a few seconds, then it is stale", () => {
    const room = new Room();
    room.quiet(400);
    room.talk(800);
    room.quiet(3000);
    expect(room.guard.speechHeardMs(room.now)).toBeGreaterThanOrEqual(240);
    room.quiet(4000);
    expect(wakeAt(room).reason).toBe("no-speech");
  });

  it("the threshold and the patience frames apply to engine scores", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    expect(wakeAt(room, { score: 0.3, kind: "frame" }).reason).toBe("below-threshold");
    expect(wakeAt(room, { kind: "frame" }).reason).toBe("patience");
    expect(wakeAt(room, { kind: "frame" }).reason).toBe("patience");
    expect(wakeAt(room, { kind: "frame" }).accept).toBe(true);
    // A dip resets the run: two good frames, a bad one, then the count starts again.
    const again = new Room();
    again.quiet(300);
    again.talk(800);
    wakeAt(again, { kind: "frame" });
    wakeAt(again, { kind: "frame" });
    expect(wakeAt(again, { score: 0.1, kind: "frame" }).reason).toBe("below-threshold");
    expect(wakeAt(again, { kind: "frame" }).reason).toBe("patience");
  });
});

describe("wake guard: her own voice never wakes or re-triggers her", () => {
  it("rejects her playback loopback while she speaks, with and without the echo reference", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800); // the owner spoke before; the wake itself is the question
    const playback = speechFrame(3, 0.4);
    const mic = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n += 1) mic[n] = 0.3 * (playback[n] ?? 0); // a room echo, attenuated
    expect(suppressSelfVoice({ mic: [...mic], playback: [...playback], speaking: true }).keep).toBe(
      false,
    );
    room.run(600, (i) => speechFrame(i, 0.4), true);
    const base = { ownerEnergy: rms(mic), playbackEnergy: rms(playback) };
    expect(wakeAt(room, { ...base }).reason).toBe("self-voice");
    expect(wakeAt(room, { ...base, echoRefLive: true }).reason).toBe("self-voice");
    expect(room.guard.current).toBe("asleep");
  });

  it("rejects her own words by text even when the level looks loud, and when the level is unknown", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    room.run(200, (i) => speechFrame(i, 0.4), true);
    expect(wakeAt(room, { selfEchoText: true, ownerEnergy: 0.9, playbackEnergy: 0.1 }).reason).toBe(
      "self-voice",
    );
    const unknown = { ...wakeAt(room, {}) };
    expect(unknown.accept).toBe(true); // a loud owner over quiet playback is a barge-in wake
    const blind = new Room();
    blind.quiet(300);
    blind.talk(800);
    blind.run(200, (i) => speechFrame(i, 0.4), true);
    expect(
      blind.guard.consider({ nowMs: blind.now, score: 1, threshold: THRESHOLD, kind: "utterance" })
        .reason,
    ).toBe("self-voice");
  });

  it("lets a close talker through while she speaks (louder than her playback by the margin)", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    room.run(200, (i) => speechFrame(i, 0.2), true);
    expect(wakeAt(room, { ownerEnergy: 0.12, playbackEnergy: 0.1 }).reason).toBe("self-voice"); // under 1.5x
    const loud = wakeAt(room, { ownerEnergy: 0.4, playbackEnergy: 0.1 });
    expect(loud.accept).toBe(true);
  });

  it("a cleaned frame (echo reference live) needs a smaller margin than a raw one", () => {
    const make = () => {
      const room = new Room();
      room.quiet(300);
      room.talk(800);
      room.run(100, (i) => speechFrame(i, 0.2), true);
      return room;
    };
    const raw = wakeAt(make(), { ownerEnergy: 0.13, playbackEnergy: 0.1 });
    const live = wakeAt(make(), { ownerEnergy: 0.13, playbackEnergy: 0.1, echoRefLive: true });
    expect(raw.reason).toBe("self-voice");
    expect(live.accept).toBe(true);
  });

  it("stays gated through her room tail, then opens", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    room.run(400, (i) => speechFrame(i, 0.3), true);
    room.quiet(300);
    expect(room.guard.speakingNow(room.now)).toBe(true);
    expect(
      wakeAt(room, { ownerEnergy: undefined as unknown as number, playbackEnergy: 0.2 }).reason,
    ).toBe("self-voice");
    room.talk(600);
    room.quiet(400);
    expect(room.guard.speakingNow(room.now)).toBe(false);
    expect(wakeAt(room).accept).toBe(true);
  });
});

describe("wake guard: cooldown after a false wake", () => {
  it("counts the false wake, sleeps, and refuses until the cooldown is over", () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    expect(wakeAt(room).accept).toBe(true);
    room.guard.reportFalseWake(room.now);
    expect(room.guard.current).toBe("asleep");
    room.talk(800);
    expect(wakeAt(room).reason).toBe("cooldown");
    room.quiet(WAKE_GUARD_DEFAULTS.cooldownMs);
    room.talk(800);
    expect(wakeAt(room).accept).toBe(true);
    const snap = room.guard.snapshot(room.now);
    expect(snap.counters.falseWakes).toBe(1);
    expect(snap.counters.blocked.cooldown).toBe(1);
    expect(snap.counters.accepted).toBe(2);
  });

  it("reports the cooldown that is left", () => {
    const guard = new WakeGuard({ cooldownMs: 4000 });
    guard.reportFalseWake(10_000);
    expect(guard.snapshot(11_000).cooldownLeftMs).toBe(3000);
    expect(guard.snapshot(20_000).cooldownLeftMs).toBe(0);
  });
});

describe("wake guard: TV and room noise raise the threshold instead of waking", () => {
  it("steady noise for a while raises the bar; a borderline score is refused, a strong one passes", () => {
    const room = new Room();
    room.quiet(500);
    room.noise(8000, 0.06);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBeGreaterThan(0.1);
    room.talk(800, 0.5);
    const weak = wakeAt(room, { score: 0.6 });
    expect(weak).toEqual({ accept: false, reason: "room-noise" });
    expect(wakeAt(room, { score: 0.95 }).accept).toBe(true);
    expect(room.guard.snapshot(room.now).counters.noiseRaises).toBe(1);
  });

  it("the raise fades once the room is quiet again", () => {
    const room = new Room();
    room.noise(8000, 0.06);
    const raised = room.guard.snapshot(room.now).thresholdBoost;
    expect(raised).toBeGreaterThan(0.1);
    room.quiet(WAKE_GUARD_DEFAULTS.steadyDecayMs + 2000);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBe(0);
    room.talk(800);
    expect(wakeAt(room, { score: 0.6 }).accept).toBe(true);
  });

  it("a short noise (a door, a cough) raises nothing", () => {
    const room = new Room();
    room.quiet(500);
    room.noise(2500, 0.06);
    room.quiet(2000);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBe(0);
  });

  it("a TV that talks without a pause raises the bar even after the VAD floor caught up with it", () => {
    const room = new Room();
    room.quiet(500);
    room.talk(WAKE_GUARD_DEFAULTS.longSpeechMs + 2000, 0.3);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBeGreaterThan(0.1);
    expect(room.guard.snapshot(room.now).counters.noiseRaises).toBe(1);
  });

  it("a person who pauses between phrases does not look like a TV", () => {
    const room = new Room();
    room.quiet(500);
    for (let phrase = 0; phrase < 8; phrase += 1) {
      room.talk(4000, 0.3);
      room.quiet(600);
    }
    expect(room.guard.snapshot(room.now).thresholdBoost).toBe(0);
  });

  it("her own playback is not counted as room noise", () => {
    const room = new Room();
    room.quiet(500);
    room.run(30_000, (i) => speechFrame(i, 0.3), true);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBe(0);
  });
});

describe("wake guard: the ears' scene tag only ever raises the bar", () => {
  const talked = () => {
    const room = new Room();
    room.quiet(500);
    room.talk(800, 0.5);
    return room;
  };

  it("music or a TV at 0.6 or more refuses a borderline wake and a strong one still passes", () => {
    const room = talked();
    room.guard.observeScene({ kind: "music", score: 0.9 }, room.now);
    const raise = room.guard.sceneRaise(room.now);
    expect(raise).toBeGreaterThan(0);
    expect(raise).toBeLessThanOrEqual(SCENE_BOOST_MAX);
    expect(wakeAt(room, { score: THRESHOLD + 0.05 })).toEqual({
      accept: false,
      reason: "room-noise",
    });
    expect(wakeAt(room, { score: THRESHOLD + raise + 0.01 }).accept).toBe(true);
  });

  it("a score between the base and the raised threshold is refused as room-noise", () => {
    const room = talked();
    room.guard.observeScene({ kind: "tv", score: 1 }, room.now);
    const verdict = wakeAt(room, { score: THRESHOLD + 0.05 });
    expect(verdict).toEqual({ accept: false, reason: "room-noise" });
    expect(wakeAt(room, { score: 0.95 }).accept).toBe(true);
    expect(room.guard.snapshot(room.now).thresholdBoost).toBe(0); // the steady-noise boost is a separate thing
  });

  it("speech, noise, junk, a low score or a missing tag raises nothing", () => {
    const room = talked();
    for (const tag of [
      { kind: "speech", score: 1 },
      { kind: "noise", score: 1 },
      { kind: "music", score: SCENE_ACT_AT - 0.01 },
      { kind: "music", score: Number.NaN },
      { kind: "music", score: "0.9" },
      { kind: "music" },
      { tag: "other", score: 1 },
      null,
      undefined,
      "tv",
      7,
    ]) {
      room.guard.observeScene(tag, room.now);
      expect(room.guard.sceneRaise(room.now)).toBe(0);
    }
    expect(wakeAt(room, { score: THRESHOLD + 0.01 }).accept).toBe(true);
  });

  it("the raise holds for a while after the last tag and then lets go", () => {
    const room = talked();
    room.guard.observeScene({ kind: "music", score: 0.8 }, room.now);
    expect(room.guard.sceneRaise(room.now + SCENE_HOLD_MS)).toBeGreaterThan(0);
    expect(room.guard.sceneRaise(room.now + SCENE_HOLD_MS + 1)).toBe(0);
  });

  it("a calmer tag ends the raise at once, and a mute or forced sleep forgets it", () => {
    const room = talked();
    room.guard.observeScene({ kind: "tv", score: 0.9 }, room.now);
    room.guard.observeScene({ kind: "speech", score: 0.9 }, room.now + 100);
    expect(room.guard.sceneRaise(room.now + 100)).toBe(0);
    room.guard.observeScene({ kind: "tv", score: 0.9 }, room.now);
    room.guard.forceAsleep("mute", room.now);
    expect(room.guard.sceneRaise(room.now)).toBe(0);
  });

  it("with no tag the verdicts are exactly the old ones", () => {
    for (const score of [0.3, 0.49, 0.5, 0.51, 0.7, 1]) {
      const plain = talked();
      const tagged = talked();
      tagged.guard.observeScene(undefined, tagged.now);
      expect(wakeAt(tagged, { score })).toEqual(wakeAt(plain, { score }));
    }
  });

  it("a speaker tag has no way in: the guard takes no speaker input and never lowers a score bar", () => {
    const room = talked();
    room.guard.observeScene(
      { kind: "music", score: 0.9, speaker: { tag: "owner", score: 0.99 } },
      room.now,
    );
    const before = room.guard.sceneRaise(room.now);
    expect(before).toBeGreaterThan(0);
    room.guard.observeScene({ speaker: { tag: "owner", score: 0.99 } }, room.now + 3000);
    room.guard.observeScene({ tag: "owner", score: 0.99 }, room.now + 3000);
    expect(room.guard.sceneRaise(room.now + 3000)).toBe(before); // neither changed it, held it longer nor cleared it
    expect(room.guard.sceneRaise(room.now + SCENE_HOLD_MS + 1)).toBe(0);
    expect(wakeAt(room, { score: 0.1 })).toEqual({ accept: false, reason: "below-threshold" });
  });

  it("the scene raise stacks on the noise raise and the cap of 0.98 still lets a spoken wake word through", () => {
    const room = new Room();
    room.quiet(500);
    room.noise(8000, 0.06);
    room.talk(800, 0.5);
    room.guard.observeScene({ kind: "tv", score: 1 }, room.now);
    expect(wakeAt(room, { score: 1, kind: "utterance" }).accept).toBe(true);
  });
});

describe("wake guard: the flow asleep, listening, thinking, speaking, follow-up", () => {
  const talked = () => {
    const room = new Room();
    room.quiet(300);
    room.talk(800);
    return room;
  };

  it("walks the whole flow and goes back to sleep when the follow-up window ends", () => {
    const room = talked();
    const guard = room.guard;
    expect(guard.current).toBe("asleep");
    expect(guard.wakeRequired(room.now)).toBe(true);
    expect(wakeAt(room).accept).toBe(true);
    expect(guard.current).toBe("listening");
    guard.turnAccepted(room.now);
    expect(guard.current).toBe("thinking");
    guard.speakStart(room.now);
    expect(guard.current).toBe("speaking");
    guard.speakEnd(room.now);
    expect(guard.current).toBe("follow-up");
    expect(guard.wakeRequired(room.now)).toBe(false);
    expect(guard.snapshot(room.now + WAKE_GUARD_DEFAULTS.followUpMs - 1).state).toBe("follow-up");
    expect(guard.snapshot(room.now + WAKE_GUARD_DEFAULTS.followUpMs).state).toBe("asleep");
    expect(guard.wakeRequired(room.now + WAKE_GUARD_DEFAULTS.followUpMs)).toBe(true);
  });

  it("a follow-up needs no wake word inside the window and none after it", () => {
    const room = talked();
    const guard = room.guard;
    wakeAt(room);
    guard.turnAccepted(room.now);
    guard.speakStart(room.now);
    guard.speakEnd(room.now);
    expect(guard.followUpSpeech(room.now + 3000)).toBe(true);
    expect(guard.current).toBe("listening");
    guard.speakStart(room.now);
    guard.speakEnd(room.now);
    expect(guard.followUpSpeech(room.now + WAKE_GUARD_DEFAULTS.followUpMs + 1)).toBe(false);
    expect(guard.current).toBe("asleep");
  });

  it("a wake with no command falls asleep after the listen timeout", () => {
    const room = talked();
    wakeAt(room);
    expect(room.guard.snapshot(room.now + WAKE_GUARD_DEFAULTS.listenTimeoutMs - 1).state).toBe(
      "listening",
    );
    expect(room.guard.snapshot(room.now + WAKE_GUARD_DEFAULTS.listenTimeoutMs).state).toBe(
      "asleep",
    );
  });

  it("hands-free starts off, a wake is required, and the saved choice only changes the need", () => {
    const guard = new WakeGuard();
    expect(guard.handsFree).toBe(false);
    expect(guard.wakeRequired(1000)).toBe(true);
    guard.turnAccepted(1000); // no wake and no hands-free: nothing starts
    expect(guard.current).toBe("asleep");
    guard.setHandsFree(true);
    expect(guard.wakeRequired(1000)).toBe(false);
    guard.turnAccepted(1000);
    expect(guard.current).toBe("thinking");
    // The existing turn rule agrees: the wake word stays required unless hands-free is on.
    const turn = (handsFree: boolean) =>
      acceptsVoiceTurn({
        mode: "auto",
        paused: false,
        wakeMatched: false,
        awake: false,
        handsFree,
        wakeWordRequired: true,
        words: 5,
        stop: false,
      });
    expect(turn(false)).toBe(false);
    expect(turn(true)).toBe(true);
  });
});

describe("wake guard: Mute, the tray pause and Stop everything force asleep from every state", () => {
  const states: HandsFreeState[] = ["asleep", "listening", "thinking", "speaking", "follow-up"];

  function inState(target: HandsFreeState): Room {
    const room = new Room();
    room.guard.setHandsFree(true);
    room.quiet(300);
    room.talk(800);
    if (target === "asleep") return room;
    wakeAt(room);
    if (target === "listening") return room;
    room.guard.turnAccepted(room.now);
    if (target === "thinking") return room;
    room.guard.speakStart(room.now);
    if (target === "speaking") return room;
    room.guard.speakEnd(room.now);
    return room;
  }

  for (const target of states) {
    it(`from ${target}: asleep at once, locked, and no wake or window until released`, () => {
      const room = inState(target);
      expect(room.guard.current).toBe(target);
      room.guard.forceAsleep("muted", room.now);
      expect(room.guard.current).toBe("asleep");
      const snap = room.guard.snapshot(room.now);
      expect(snap.locked).toBe("muted");
      expect(snap.counters.forcedAsleep).toBe(1);
      room.talk(800);
      expect(wakeAt(room)).toEqual({ accept: false, reason: "locked" });
      room.guard.turnAccepted(room.now);
      room.guard.speakStart(room.now);
      room.guard.speakEnd(room.now);
      expect(room.guard.followUpSpeech(room.now)).toBe(false);
      expect(room.guard.current).toBe("asleep");
      room.guard.release(room.now);
      room.talk(800);
      expect(wakeAt(room).accept).toBe(true);
    });
  }

  it("forgets the noise raise and the speech it had heard, so nothing carries over a mute", () => {
    const room = new Room();
    room.noise(8000, 0.06);
    room.talk(800);
    room.guard.forceAsleep("paused", room.now);
    room.guard.release(room.now);
    const snap = room.guard.snapshot(room.now);
    expect(snap.thresholdBoost).toBe(0);
    expect(room.guard.speechHeardMs(room.now)).toBe(0);
  });

  it("a microphone that closes only drops what the audio showed; the state and the lock are not touched", () => {
    const room = inState("follow-up");
    room.guard.resetAudio();
    expect(room.guard.current).toBe("follow-up");
    expect(room.guard.snapshot(room.now).locked).toBe("");
  });
});

describe("wake guard: config, bounds and diagnostics", () => {
  it("keeps every value inside its bounds and falls back for junk", () => {
    const cfg = normalizeWakeGuardConfig({
      minSpeechMs: -5,
      patienceFrames: 2.6,
      cooldownMs: "x",
      followUpMs: 9e9,
      steadyBoost: Number.NaN,
    });
    expect(cfg.minSpeechMs).toBe(80);
    expect(cfg.patienceFrames).toBe(3);
    expect(cfg.cooldownMs).toBe(WAKE_GUARD_DEFAULTS.cooldownMs);
    expect(cfg.followUpMs).toBe(60_000);
    expect(cfg.steadyBoost).toBe(WAKE_GUARD_DEFAULTS.steadyBoost);
    expect(normalizeWakeGuardConfig()).toEqual(WAKE_GUARD_DEFAULTS);
  });

  it("a configured guard uses the values (stricter minimum speech)", () => {
    const room = new Room(new WakeGuard({ minSpeechMs: 1500 }));
    room.quiet(300);
    room.talk(800);
    expect(wakeAt(room).reason).toBe("no-speech");
    room.guard.configure({ minSpeechMs: 240 });
    expect(wakeAt(room).accept).toBe(true);
  });

  it("keeps the trace bounded and shows counters as diagnostics rows", () => {
    const guard = new WakeGuard();
    for (let n = 0; n < 200; n += 1) guard.reportFalseWake(1000 + n);
    const snap = guard.snapshot(2000);
    expect(snap.trace.length).toBeLessThanOrEqual(24);
    expect(snap.counters.falseWakes).toBe(200);
    const rows = wakeGuardRows(snap);
    const falseRow = rows.find((row) => row.label.startsWith("wakes (accepted"));
    expect(falseRow?.value).toBe("0 accepted · 200 false");
    expect(falseRow?.bad).toBe(true);
    expect(rows.find((row) => row.label === "hands-free state")?.value).toContain("hands-free off");
  });

  it("is quiet when nothing happened", () => {
    const rows = wakeGuardRows(new WakeGuard().snapshot(0));
    expect(rows.find((row) => row.label === "wakes blocked")?.value).toBe("none");
    expect(rows.every((row) => !row.bad)).toBe(true);
  });
});

describe("capture rings stay bounded", () => {
  it("never grows past the maximum, whatever a caller asks for, and wraps instead of growing", () => {
    expect(new PcmRing(500, 1e12).capacity).toBe((TARGET_RATE * MAX_RING_MS) / 1000);
    expect(new PcmRing(500, Number.NaN).capacity).toBe(TARGET_RATE * 30);
    const ring = new PcmRing(100, 1000);
    const chunk = new Float32Array(TARGET_RATE / 2).fill(0.1);
    for (let n = 0; n < 40; n += 1) ring.push(chunk, n * 500);
    expect(ring.capacity).toBe(TARGET_RATE);
    expect(ring.takeSince(0).length).toBe(TARGET_RATE);
    expect(ring.framesPerSecond(20_000)).toBeLessThanOrEqual(80);
  });

  it("the voice gate owns the guard and feeds it from the one capture loop", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/friday/voice-audio.ts", "utf8");
    expect(source).toContain("readonly wake = new WakeGuard()");
    expect(source).toMatch(
      /this\.wake\.observe\(\{\s*nowMs: performance\.now\(\),\s*level,\s*speech,\s*speaking: this\.speakingGuard,/,
    );
    expect(source).toContain("this.wake.resetAudio()");
  });
});
