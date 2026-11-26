/**
 * Hands-free robustness: one small state machine and the gates that keep a wake honest.
 *
 *   asleep -> listening -> thinking -> speaking -> follow-up window -> asleep
 *
 * A wake (a score from the wake engine, or a transcript that matched the wake word) is accepted only when all of
 * these hold, in this order (the first that fails is the reason that is counted):
 *   locked        Mute, the tray pause or Stop everything forced her asleep and nothing has released it.
 *   cooldown      A wake was just reported false; nothing wakes her for `cooldownMs`.
 *   self-voice    She is speaking (or her room tail has not died away): her own voice must never wake or
 *                 re-trigger her. The text gate (`selfEchoText`) always applies; the energy gate wants the owner's
 *                 level above the playback by a margin (0.8 when the echo reference cleans the frame, 1.5 when it
 *                 does not, with a floor), the same shape as `shouldCutPlayback` in speech-vad.ts.
 *   no-speech     The VAD must have heard `minSpeechMs` of speech lately (the wake engine alone is not enough).
 *   below-threshold / room-noise
 *                 The score must clear the threshold. Long steady non-speech-like audio (a fan, a TV hum) or a
 *                 very long run of unbroken speech (a TV talking) raises the threshold for a while instead of
 *                 waking her; it decays back when the room is quiet.
 *   patience      A frame-level score must clear it for `patienceFrames` frames in a row (an utterance-level
 *                 transcript match is one decision and skips this).
 *
 * The ears' scene tag (`observeScene`, from the kernel's `env {kind, score}` on a turn note) may RAISE the threshold
 * while music or a TV is read at 0.6 or more, by up to `SCENE_BOOST_MAX`, for `SCENE_HOLD_MS` after the last tag; any
 * other kind, a low score or junk raises nothing and nothing here ever lowers it. A speaker tag has no way in:
 * "owner" is a label, never a reason to wake sooner or to skip a gate.
 *
 * Hands-free stays what the owner saved: `handsFree` starts false, and while it is false a wake is required in
 * the asleep state. Time is always passed in (`nowMs`), no timers, so every rule is tested on a fake clock.
 * Unverified until the owner's PC: the thresholds against a real room, a real TV and a real speaker.
 */

export type HandsFreeState = "asleep" | "listening" | "thinking" | "speaking" | "follow-up";

export type WakeGuardConfig = {
  /** Speech the VAD must have heard before a wake counts. */
  minSpeechMs: number;
  /** Consecutive frames above the threshold for a frame-level score. */
  patienceFrames: number;
  /** Quiet period after a false wake. */
  cooldownMs: number;
  /** How long she stays awake for a follow-up after she finished speaking. */
  followUpMs: number;
  /** A wake with no command after this much silence goes back to sleep. */
  listenTimeoutMs: number;
  /** Her room tail: wake stays gated this long after playback ends. */
  speakTailMs: number;
  /** Steady non-speech-like audio for this long raises the threshold. */
  steadyMs: number;
  /** How much the threshold rises (and the most it ever rises). */
  steadyBoost: number;
  /** The raise decays to nothing over this long once the room is quiet. */
  steadyDecayMs: number;
  /** Unbroken speech for this long is a TV or a radio, not a person calling her. */
  longSpeechMs: number;
  /** A speech run that ended this long ago still counts for a wake. */
  speechRecencyMs: number;
  /**
   * The longest one spoken reply (one speak call) is trusted to last. Past it the speaking state ends by itself, so a
   * reply whose end was never reported (a failed voice) cannot lock the owner out of waking her.
   */
  speakMaxMs: number;
};

export const WAKE_GUARD_DEFAULTS: WakeGuardConfig = {
  minSpeechMs: 240,
  patienceFrames: 3,
  cooldownMs: 5000,
  followUpMs: 8000,
  listenTimeoutMs: 12_000,
  speakTailMs: 700,
  steadyMs: 6000,
  steadyBoost: 0.2,
  steadyDecayMs: 10_000,
  longSpeechMs: 20_000,
  speechRecencyMs: 5000,
  speakMaxMs: 20_000,
};

/** Each value is kept inside a sane range; junk or a missing value falls back to the default. */
const BOUNDS: { [K in keyof WakeGuardConfig]: [number, number] } = {
  minSpeechMs: [80, 2000],
  patienceFrames: [1, 12],
  cooldownMs: [500, 60_000],
  followUpMs: [1000, 60_000],
  listenTimeoutMs: [2000, 60_000],
  speakTailMs: [100, 3000],
  steadyMs: [2000, 60_000],
  steadyBoost: [0.05, 0.4],
  steadyDecayMs: [2000, 120_000],
  longSpeechMs: [8000, 120_000],
  speechRecencyMs: [1000, 20_000],
  speakMaxMs: [5000, 120_000],
};

export function normalizeWakeGuardConfig(
  input?: Partial<Record<string, unknown>>,
): WakeGuardConfig {
  const out = { ...WAKE_GUARD_DEFAULTS };
  for (const key of Object.keys(BOUNDS) as (keyof WakeGuardConfig)[]) {
    const value = input?.[key];
    const [lo, hi] = BOUNDS[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(hi, Math.max(lo, value));
    }
  }
  out.patienceFrames = Math.round(out.patienceFrames);
  return out;
}

/** The kernel's room reading of a turn note (`env`). Only `music` and `tv` at or above `SCENE_ACT_AT` count. */
export type SceneTag = { kind: string; score: number };

export type WakeFrame = {
  nowMs: number;
  /** The level the VAD judged (after the echo reference, when it cleans the frame), 0..1. */
  level: number;
  /** The VAD verdict for this frame. */
  speech: boolean;
  /** FRIDAY is speaking now (playback is audible). */
  speaking: boolean;
};

export type WakeCandidate = {
  nowMs: number;
  /** Engine score 0..1, or 1 for a transcript that matched the wake word. */
  score: number;
  /** The base threshold for this room (`wakeThreshold` in wake-room.ts). */
  threshold: number;
  /** "frame" scores go through patience; an "utterance" match is one decision. */
  kind: "frame" | "utterance";
  /** The owner's level (after the echo reference when it is live) and the playback level, both 0..1. */
  ownerEnergy?: number;
  playbackEnergy?: number;
  /** The echo reference is cleaning the microphone frames right now. */
  echoRefLive?: boolean;
  /** The transcript is her own words (from `isSelfEchoTranscript`). */
  selfEchoText?: boolean;
};

export type WakeBlock =
  | "locked"
  | "cooldown"
  | "self-voice"
  | "no-speech"
  | "below-threshold"
  | "room-noise"
  | "patience";

export type WakeVerdict = { accept: boolean; reason: WakeBlock | "accepted" };

export type WakeCounters = {
  accepted: number;
  falseWakes: number;
  forcedAsleep: number;
  noiseRaises: number;
  blocked: Record<WakeBlock, number>;
};

export type WakeTraceRow = { atMs: number; event: string; detail: string };

export type WakeGuardSnapshot = {
  state: HandsFreeState;
  handsFree: boolean;
  locked: string;
  thresholdBoost: number;
  cooldownLeftMs: number;
  counters: WakeCounters;
  trace: WakeTraceRow[];
};

const TRACE_MAX = 24;
/** A frame step is never counted longer than this, so a stalled page cannot fake a long speech run. */
const MAX_STEP_MS = 100;
/** Runs closer together than this belong to one utterance ("Friday ... ok"). */
const UTTERANCE_GAP_MS = 1500;
/** A gap this long ends a speech run (a short dip inside a word does not). */
const RUN_GAP_MS = 150;
/** A quiet gap this long ends an unbroken-loudness run (a person addressing her pauses). */
const LONG_GAP_MS = 400;
/** Below this the input is quiet room, not noise worth guarding against. */
const STEADY_MIN_LEVEL = 0.02;
/** A relative level wobble under this is steady (a hum); speech wobbles far more. */
const STEADY_WOBBLE = 0.25;
const PLAYBACK_AUDIBLE = 0.02;
/** Lead values (ears.scene): the most a music or TV tag raises the wake threshold, the score it needs, how long it holds. */
export const SCENE_BOOST_MAX = 0.15;
export const SCENE_ACT_AT = 0.6;
export const SCENE_HOLD_MS = 4000;

/** 0 for anything but a music or TV tag with a finite score at or above the bar; else up to `SCENE_BOOST_MAX`. */
function raiseForTag(tag: unknown): number {
  if (!tag || typeof tag !== "object") return 0;
  const { kind, score } = tag as Partial<SceneTag>;
  if (kind !== "music" && kind !== "tv") return 0;
  if (typeof score !== "number" || !Number.isFinite(score) || score < SCENE_ACT_AT) return 0;
  return Math.round(SCENE_BOOST_MAX * Math.min(1, score) * 1000) / 1000;
}

const emptyBlocked = (): Record<WakeBlock, number> => ({
  locked: 0,
  cooldown: 0,
  "self-voice": 0,
  "no-speech": 0,
  "below-threshold": 0,
  "room-noise": 0,
  patience: 0,
});

export class WakeGuard {
  private cfg: WakeGuardConfig;
  private state: HandsFreeState = "asleep";
  private handsFreeOn = false;
  private lockReason = "";
  private boost = 0;
  private sceneBoost = 0;
  private sceneUntil = -Infinity;
  private cooldownUntil = 0;
  private hits = 0;
  private lastObs = 0;
  private lastSpeakingAt = -Infinity;
  private runMs = 0;
  private gapMs = 0;
  private lastRunMs = 0;
  /** Speech of the runs that ended inside the current utterance (a gap under `UTTERANCE_GAP_MS` joins runs). */
  private utterMs = 0;
  private lastRunEndAt = -Infinity;
  private longMs = 0;
  private longGapMs = 0;
  private steadyAccum = 0;
  private emaLevel = 0;
  private wobble = 1;
  private deadline = 0;
  private counters: WakeCounters = {
    accepted: 0,
    falseWakes: 0,
    forcedAsleep: 0,
    noiseRaises: 0,
    blocked: emptyBlocked(),
  };
  private trace: WakeTraceRow[] = [];
  private lastNow = 0;

  constructor(config?: Partial<Record<string, unknown>>) {
    this.cfg = normalizeWakeGuardConfig(config);
  }

  get config(): WakeGuardConfig {
    return this.cfg;
  }

  /** New values from settings; each is bounded, junk keeps the default. */
  configure(config?: Partial<Record<string, unknown>>): void {
    this.cfg = normalizeWakeGuardConfig(config);
  }

  /* ------------------------------------------------------------ audio */

  /** One VAD frame. Safe to call from the capture loop at any rate. */
  observe(frame: WakeFrame): void {
    if (this.lockReason) return;
    const dt =
      this.lastObs > 0 ? Math.min(MAX_STEP_MS, Math.max(0, frame.nowMs - this.lastObs)) : 0;
    this.lastObs = frame.nowMs;
    this.lastNow = frame.nowMs;
    if (frame.speaking) this.lastSpeakingAt = frame.nowMs;
    this.trackSpeech(frame, dt);
    this.trackNoise(frame, dt);
    this.expire(frame.nowMs);
  }

  private trackSpeech(frame: WakeFrame, dt: number): void {
    // Unbroken loudness (any signal over the quiet floor, even when the VAD's floor has caught up with a
    // talking TV) is timed apart from the speech run the VAD vouches for.
    if (!frame.speaking && frame.level >= STEADY_MIN_LEVEL) {
      this.longMs += dt;
      this.longGapMs = 0;
    } else {
      this.longGapMs += dt;
      if (this.longGapMs >= LONG_GAP_MS) this.longMs = 0;
    }
    if (frame.speech && !frame.speaking) {
      // A run that begins long after the last one ended is a new utterance: the count starts again.
      if (this.runMs === 0 && frame.nowMs - this.lastRunEndAt > UTTERANCE_GAP_MS) this.utterMs = 0;
      this.runMs += dt;
      this.gapMs = 0;
      return;
    }
    this.gapMs += dt;
    if (this.gapMs > RUN_GAP_MS && this.runMs > 0) {
      this.lastRunMs = this.runMs;
      this.utterMs += this.runMs;
      this.lastRunEndAt = frame.nowMs - this.gapMs;
      this.runMs = 0;
    }
  }

  private trackNoise(frame: WakeFrame, dt: number): void {
    // Her own voice is not room noise; it is handled by the self-voice gate.
    if (frame.speaking) {
      this.decay(dt);
      return;
    }
    const base = Math.max(this.emaLevel, 1e-4);
    const dev = Math.abs(frame.level - this.emaLevel) / base;
    this.emaLevel = this.emaLevel === 0 ? frame.level : this.emaLevel * 0.9 + frame.level * 0.1;
    this.wobble = this.wobble * 0.9 + Math.min(2, dev) * 0.1;
    const steady = frame.level >= STEADY_MIN_LEVEL && this.wobble < STEADY_WOBBLE;
    this.steadyAccum = steady ? this.steadyAccum + dt : Math.max(0, this.steadyAccum - dt * 2);
    const tv = this.longMs >= this.cfg.longSpeechMs;
    if (this.steadyAccum >= this.cfg.steadyMs || tv) {
      if (this.boost < this.cfg.steadyBoost) {
        if (this.boost === 0) {
          this.counters.noiseRaises += 1;
          this.note(frame.nowMs, "noise", tv ? "long unbroken speech" : "steady noise");
        }
        this.boost = this.cfg.steadyBoost;
      }
      return;
    }
    this.decay(dt);
  }

  private decay(dt: number): void {
    if (this.boost <= 0) return;
    this.boost = Math.max(0, this.boost - (this.cfg.steadyBoost * dt) / this.cfg.steadyDecayMs);
  }

  /**
   * The ears' room reading. Music or TV at `SCENE_ACT_AT` or more raises the wake threshold by up to
   * `SCENE_BOOST_MAX` (scaled by the score) until `SCENE_HOLD_MS` after this tag; a calmer scene tag ends the raise.
   * Anything without a scene `kind` (a speaker tag, junk) is ignored; another kind or a score below the bar never
   * raises, and nothing here can lower the threshold.
   */
  observeScene(tag: unknown, nowMs: number): void {
    if (!tag || typeof tag !== "object" || typeof (tag as Partial<SceneTag>).kind !== "string")
      return;
    const raise = raiseForTag(tag);
    const was = this.sceneRaise(nowMs);
    this.sceneBoost = raise;
    this.sceneUntil = raise > 0 ? nowMs + SCENE_HOLD_MS : -Infinity;
    if (raise > 0 && was === 0)
      this.note(nowMs, "scene", `${(tag as SceneTag).kind} +${raise.toFixed(2)}`);
  }

  /** The scene raise in force at `nowMs` (0 once its hold ran out). */
  sceneRaise(nowMs: number): number {
    return nowMs <= this.sceneUntil ? this.sceneBoost : 0;
  }

  /** Speech the VAD heard that can still back a wake: the live run, or a run that ended recently. */
  speechHeardMs(nowMs: number): number {
    const earlier = nowMs - this.lastRunEndAt <= this.cfg.speechRecencyMs ? this.utterMs : 0;
    return this.runMs + earlier;
  }

  /** The room is audibly carrying her playback: speaking now, or inside her room tail. */
  speakingNow(nowMs: number): boolean {
    this.expire(nowMs);
    return this.state === "speaking" || nowMs - this.lastSpeakingAt <= this.cfg.speakTailMs;
  }

  /* ------------------------------------------------------------ wake */

  consider(input: WakeCandidate): WakeVerdict {
    this.lastNow = input.nowMs;
    const block = this.blockReason(input);
    if (block) {
      this.counters.blocked[block] += 1;
      if (block !== "below-threshold" && block !== "patience") {
        this.note(input.nowMs, "wake-blocked", block);
      }
      if (block !== "patience") this.hits = 0;
      return { accept: false, reason: block };
    }
    this.hits = 0;
    this.counters.accepted += 1;
    this.state = "listening";
    this.deadline = input.nowMs + this.cfg.listenTimeoutMs;
    this.note(input.nowMs, "wake", `score ${input.score.toFixed(2)}`);
    return { accept: true, reason: "accepted" };
  }

  private blockReason(input: WakeCandidate): WakeBlock | null {
    if (this.lockReason) return "locked";
    if (input.nowMs < this.cooldownUntil) return "cooldown";
    if (this.speakingNow(input.nowMs) && this.isSelfVoice(input)) return "self-voice";
    if (this.speechHeardMs(input.nowMs) < this.cfg.minSpeechMs) return "no-speech";
    const raise = this.boost + this.sceneRaise(input.nowMs);
    const effective = Math.min(0.98, input.threshold + raise);
    if (input.score < effective) {
      return raise > 0 && input.score >= input.threshold ? "room-noise" : "below-threshold";
    }
    if (input.kind === "frame") {
      this.hits += 1;
      if (this.hits < this.cfg.patienceFrames) return "patience";
    }
    return null;
  }

  private isSelfVoice(input: WakeCandidate): boolean {
    if (input.selfEchoText) return true;
    const owner = input.ownerEnergy;
    if (owner === undefined || !Number.isFinite(owner)) return true;
    const playback = input.playbackEnergy ?? 0;
    if (playback < PLAYBACK_AUDIBLE) return owner < (input.echoRefLive ? 0.03 : 0.05);
    const bar = input.echoRefLive ? Math.max(0.03, playback * 0.8) : Math.max(0.05, playback * 1.5);
    return owner <= bar;
  }

  /** The wake turned out wrong (nothing followed, or it was her own voice): sleep and stay quiet for a while. */
  reportFalseWake(nowMs: number): void {
    this.counters.falseWakes += 1;
    this.cooldownUntil = nowMs + this.cfg.cooldownMs;
    this.hits = 0;
    this.state = "asleep";
    this.deadline = 0;
    this.lastNow = nowMs;
    this.note(nowMs, "false-wake", `cooldown ${this.cfg.cooldownMs} ms`);
  }

  /* ------------------------------------------------------------ flow */

  /** Hands-free as the owner saved it; the default is off and a wake is then required. */
  setHandsFree(on: boolean): void {
    this.handsFreeOn = on;
  }

  get handsFree(): boolean {
    return this.handsFreeOn;
  }

  /** True when the next utterance needs the wake word first. */
  wakeRequired(nowMs: number): boolean {
    this.expire(nowMs);
    return !this.handsFreeOn && this.state === "asleep";
  }

  /** The owner's command was accepted and goes to the brain. */
  turnAccepted(nowMs: number): void {
    if (this.lockReason) return;
    this.expire(nowMs);
    if (this.state === "asleep" && !this.handsFreeOn) return;
    this.state = "thinking";
    this.deadline = 0;
  }

  /** Playback of her answer started. */
  speakStart(nowMs: number): void {
    if (this.lockReason) return;
    this.state = "speaking";
    this.lastSpeakingAt = nowMs;
    // The reply is trusted to end by `speakMaxMs`; its real end (`speakEnd`) normally comes first.
    this.deadline = nowMs + this.cfg.speakMaxMs;
  }

  /** Playback ended: the follow-up window opens, then she sleeps. */
  speakEnd(nowMs: number): void {
    if (this.lockReason || this.state !== "speaking") return;
    this.state = "follow-up";
    this.lastSpeakingAt = nowMs;
    this.deadline = nowMs + this.cfg.followUpMs;
  }

  /** The owner spoke inside the follow-up window: no wake word needed, she listens. */
  followUpSpeech(nowMs: number): boolean {
    this.expire(nowMs);
    if (this.lockReason || this.state !== "follow-up") return false;
    this.state = "listening";
    this.deadline = nowMs + this.cfg.listenTimeoutMs;
    return true;
  }

  private expire(nowMs: number): void {
    if (this.deadline > 0 && nowMs >= this.deadline) {
      this.note(nowMs, "sleep", `${this.state} window ended`);
      this.state = "asleep";
      this.deadline = 0;
    }
  }

  /**
   * Mute, the tray pause and Stop everything: asleep from any state, at once, and locked (no wake, no window)
   * until `release`. The room tail and the noise raise are forgotten with it.
   */
  forceAsleep(reason: string, nowMs = this.lastNow): void {
    this.state = "asleep";
    this.lockReason = reason || "forced";
    this.deadline = 0;
    this.resetAudio();
    this.counters.forcedAsleep += 1;
    this.note(nowMs, "force-asleep", this.lockReason);
  }

  /** The microphone closed or was reopened: what the audio showed so far no longer applies. State stays. */
  resetAudio(): void {
    this.hits = 0;
    this.boost = 0;
    this.sceneBoost = 0;
    this.sceneUntil = -Infinity;
    this.steadyAccum = 0;
    this.emaLevel = 0;
    this.wobble = 1;
    this.runMs = 0;
    this.gapMs = 0;
    this.longMs = 0;
    this.longGapMs = 0;
    this.lastRunMs = 0;
    this.utterMs = 0;
    this.lastRunEndAt = -Infinity;
    this.lastSpeakingAt = -Infinity;
    this.lastObs = 0;
  }

  /** Unmute, resume: she is asleep and listening for a wake again. */
  release(nowMs = this.lastNow): void {
    if (!this.lockReason) return;
    this.note(nowMs, "release", this.lockReason);
    this.lockReason = "";
  }

  get current(): HandsFreeState {
    return this.state;
  }

  snapshot(nowMs = this.lastNow): WakeGuardSnapshot {
    this.expire(nowMs);
    return {
      state: this.state,
      handsFree: this.handsFreeOn,
      locked: this.lockReason,
      thresholdBoost: Math.round(this.boost * 1000) / 1000,
      cooldownLeftMs: Math.max(0, this.cooldownUntil - nowMs),
      counters: { ...this.counters, blocked: { ...this.counters.blocked } },
      trace: this.trace.map((row) => ({ ...row })),
    };
  }

  private note(atMs: number, event: string, detail: string): void {
    this.trace.push({ atMs, event, detail });
    if (this.trace.length > TRACE_MAX) this.trace.shift();
  }
}
