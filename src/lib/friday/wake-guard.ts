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
 * Two gates only ever ADD a requirement (a refusal that was an accept stays a refusal, never the other way for a
 * gate that existed): while a music or TV scene is on, a wake that came from the transcript alone (`source`
 * "transcript" or "personal") needs the scorer to agree (`probeScore` within `max(nearBand, 0.1)` of the threshold) or
 * a leading match with a real lead-in (`leadInMs`), else it is "uncorroborated"; quiet rooms are untouched. The second
 * chance (`nearBand`, off at 0) lets a LEADING transcript wake through when the wake scorer was just under the bar (a
 * near-miss frame earlier in the same utterance, or the candidate's own score) and every other gate passes: no scene,
 * no noise raise, the speaker not marked different, at most one per 10 s. A speaker tag never lowers a gate or
 * approves anything; it can only refuse.
 *
 * Two optional guards, both off at 0 (today's behaviour), only ever add a requirement or a second look. The second
 * pass (`secondPassMargin`) answers a frame score just under the bar (inside the margin) with `verify: true` and still
 * refuses: the caller may run one short transcript check and pass it back as an "utterance", which goes through every
 * gate as usual, so a near miss is never accepted here. It asks at most once per `VERIFY_SPACING_MS` and
 * `VERIFY_PER_MINUTE` a minute, and only after locked, cooldown, self-voice and no-speech passed. The ultrasonic flag
 * (`ultrasonicShare`, with `WakeFrame.highBandShare`, the capture's share of energy above 17 kHz, absent = unknown)
 * marks a room whose last `ULTRASONIC_FRAMES` frames all carried that share: for `SCENE_HOLD_MS` the bar rises like a
 * music scene (never more than `SCENE_BOOST_MAX`, not added to a real scene tag). While any raise is in force (a scene,
 * steady noise, the flag) no second look is asked and the second chance is off. It cannot wake, lower a bar or approve. Unverified: a 16 kHz capture cannot see above 8 kHz, so
 * the flag has no real input until a wider capture path exists; the logic is tested on synthetic frames only.
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
  /**
   * Second chance: a leading transcript wake is taken when the wake scorer read within this much under the threshold
   * (never under 0.35). 0 turns it off, which is today's behaviour. It also widens the corroboration band (D5).
   */
  nearBand: number;
  /** How long a near-miss frame stays usable for a leading transcript wake of the same utterance. */
  secondChanceMs: number;
  /** The quiet before the name that a leading match needs to corroborate a transcript-only wake in a TV or music scene. */
  leadInMs: number;
  /**
   * Second pass: a frame score within this much under the threshold gets one short transcript check (`verify: true`)
   * instead of a plain refusal; it is never an accept. 0 turns it off (today's behaviour).
   */
  secondPassMargin: number;
  /**
   * Ultrasonic flag: a capture whose share of energy above 17 kHz (`WakeFrame.highBandShare`) reaches this on three
   * frames in a row raises the bar like a music scene (a replayed recording). 0 turns it off.
   */
  ultrasonicShare: number;
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
  nearBand: 0,
  secondChanceMs: 1500,
  leadInMs: 300,
  secondPassMargin: 0,
  ultrasonicShare: 0,
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
  nearBand: [0, 0.2],
  secondChanceMs: [500, 3000],
  leadInMs: [100, 1500],
  secondPassMargin: [0, 0.2],
  ultrasonicShare: [0, 1],
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
  /** Share (0..1) of the capture's energy above 17 kHz. Absent or out of range = unknown = no effect. */
  highBandShare?: number;
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
  /** Where the wake came from. Absent means today's behaviour (no source rule applies). */
  source?: "engine" | "transcript" | "personal";
  /** The transcript match opened the utterance (`matchWakeWord(...).leading`). */
  leading?: boolean;
  /** The quiet before the wake word began, in ms. */
  leadInMs?: number;
  /** The speaker check on the wake audio. "different" can only refuse; "match" changes nothing. */
  speaker?: "match" | "different" | "unknown";
  /** The wake scorer's real reading for this utterance; null or absent means the scorer did not hear it. */
  probeScore?: number | null;
};

/** The guard's input is a candidate; the alias keeps the wiring and the tests on one name. */
export type WakeGuardInput = WakeCandidate;

export type WakeBlock =
  | "locked"
  | "cooldown"
  | "self-voice"
  | "no-speech"
  | "below-threshold"
  | "room-noise"
  | "patience"
  | "uncorroborated"
  | "second-chance-limit"
  | "speaker-different";

export type WakeVerdict = {
  accept: boolean;
  reason: WakeBlock | "accepted";
  /** Only ever with `accept: false`: one short transcript check may follow, passed back as an "utterance". */
  verify?: true;
};

export type WakeCounters = {
  accepted: number;
  falseWakes: number;
  forcedAsleep: number;
  noiseRaises: number;
  /** Turns the ears marked `needsWake` and that had no wake word while the conversation was closed. */
  heldTurns: number;
  /** Leading transcript wakes taken inside the near band (the second chance). */
  secondChances: number;
  /** Near-miss frames that were given a second look (`verify: true`). */
  verifyAsked: number;
  /** Second looks (an utterance inside `VERIFY_WINDOW_MS` of an ask) that every gate then accepted. */
  verifyAccepted: number;
  /** Ultrasonic episodes (a flagged room), counted once per hold. */
  ultrasonic: number;
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
/** The second chance never reaches below this score, whatever `nearBand` says. */
const SECOND_CHANCE_FLOOR = 0.35;
/** At most one second chance per this long. */
const SECOND_CHANCE_SPACING_MS = 10_000;
/** A transcript-only wake in a scene is corroborated by a scorer reading within at least this much of the threshold. */
const CORROBORATE_BAND = 0.1;
/** Lead values (ears.scene): the most a music or TV tag raises the wake threshold, the score it needs, how long it holds. */
export const SCENE_BOOST_MAX = 0.15;
export const SCENE_ACT_AT = 0.6;
export const SCENE_HOLD_MS = 4000;
/** The second pass: at most one ask per spacing and per minute; the utterance must follow within the window. */
export const VERIFY_SPACING_MS = 5000;
export const VERIFY_PER_MINUTE = 12;
export const VERIFY_WINDOW_MS = 1500;
/** The ultrasonic flag needs this many flagged frames in a row. */
export const ULTRASONIC_FRAMES = 3;

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
  uncorroborated: 0,
  "second-chance-limit": 0,
  "speaker-different": 0,
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
  /** Counts utterances (a gap over `UTTERANCE_GAP_MS` starts the next one): a near miss only serves its own. */
  private utterEpoch = 0;
  private nearMiss: { atMs: number; epoch: number } | null = null;
  private lastSecondChanceAt = -Infinity;
  private verifyTimes: number[] = [];
  private verifyPendingAt = -Infinity;
  private ultraRun = 0;
  private ultraUntil = -Infinity;
  private counters: WakeCounters = {
    accepted: 0,
    falseWakes: 0,
    forcedAsleep: 0,
    noiseRaises: 0,
    heldTurns: 0,
    secondChances: 0,
    verifyAsked: 0,
    verifyAccepted: 0,
    ultrasonic: 0,
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
    this.trackHighBand(frame);
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
      if (this.runMs === 0 && frame.nowMs - this.lastRunEndAt > UTTERANCE_GAP_MS) {
        this.utterMs = 0;
        this.utterEpoch += 1;
      }
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

  /** Three flagged frames in a row hold the ultrasonic flag; an unknown or clean frame ends the run. */
  private trackHighBand(frame: WakeFrame): void {
    const share = frame.highBandShare;
    const flagged =
      this.cfg.ultrasonicShare > 0 &&
      typeof share === "number" &&
      Number.isFinite(share) &&
      share >= 0 &&
      share <= 1 &&
      share >= this.cfg.ultrasonicShare;
    if (!flagged) {
      this.ultraRun = 0;
      return;
    }
    this.ultraRun += 1;
    if (this.ultraRun < ULTRASONIC_FRAMES) return;
    if (!this.ultrasonicSuspect(frame.nowMs)) {
      this.counters.ultrasonic += 1;
      this.note(frame.nowMs, "ultrasonic", `high band share ${share.toFixed(2)}`);
    }
    this.ultraUntil = frame.nowMs + SCENE_HOLD_MS;
  }

  /** A replay-like capture is flagged: the bar is raised like a music scene until the hold ends. */
  ultrasonicSuspect(nowMs: number): boolean {
    return nowMs <= this.ultraUntil;
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

  /**
   * A turn the ears marked `needsWake` was held to ambient (no wake word, conversation closed). A count for the
   * Doctor only: it asks for MORE proof and has no way to lower a gate or approve anything.
   */
  noteHeldTurn(nowMs: number): void {
    this.counters.heldTurns += 1;
    this.note(nowMs, "held", "other voice or TV, no wake word");
  }

  /** The scene raise in force at `nowMs` (0 once its hold ran out). */
  sceneRaise(nowMs: number): number {
    return nowMs <= this.sceneUntil ? this.sceneBoost : 0;
  }

  /** A music or TV tag is in force: the room may be speaking the name itself. */
  sceneActive(nowMs: number): boolean {
    return this.sceneRaise(nowMs) > 0;
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
    const verifying = this.takeVerifyWindow(input);
    const block = this.blockReason(input);
    if (block === "verify") {
      this.hits = 0;
      this.verifyTimes.push(input.nowMs);
      this.verifyPendingAt = input.nowMs;
      this.counters.verifyAsked += 1;
      this.counters.blocked["below-threshold"] += 1;
      this.note(input.nowMs, "wake-verify", `score ${input.score.toFixed(2)}`);
      return { accept: false, reason: "below-threshold", verify: true };
    }
    if (block === "second-chance") {
      this.hits = 0;
      this.counters.accepted += 1;
      if (verifying) this.counters.verifyAccepted += 1;
      this.counters.secondChances += 1;
      this.nearMiss = null;
      this.state = "listening";
      this.deadline = input.nowMs + this.cfg.listenTimeoutMs;
      this.note(input.nowMs, "wake", `second chance, score ${input.score.toFixed(2)}`);
      return { accept: true, reason: "accepted" };
    }
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
    if (verifying) this.counters.verifyAccepted += 1;
    this.state = "listening";
    this.deadline = input.nowMs + this.cfg.listenTimeoutMs;
    this.note(input.nowMs, "wake", `score ${input.score.toFixed(2)}`);
    return { accept: true, reason: "accepted" };
  }

  /**
   * An utterance inside `VERIFY_WINDOW_MS` of an ask is that ask's second look; one ask has one look, whatever its
   * outcome, and a frame candidate never uses it up. It only labels the count: no gate is skipped for it.
   */
  private takeVerifyWindow(input: WakeCandidate): boolean {
    if (input.kind !== "utterance" || this.verifyPendingAt === -Infinity) return false;
    const at = this.verifyPendingAt;
    this.verifyPendingAt = -Infinity;
    return input.nowMs >= at && input.nowMs - at <= VERIFY_WINDOW_MS;
  }

  /** The second pass may ask now: not too soon after the last ask, and not too many in the last minute. */
  private verifyAllowed(nowMs: number): boolean {
    this.verifyTimes = this.verifyTimes.filter((at) => nowMs - at < 60_000 && at <= nowMs);
    const last = this.verifyTimes[this.verifyTimes.length - 1];
    if (last !== undefined && nowMs - last < VERIFY_SPACING_MS) return false;
    return this.verifyTimes.length < VERIFY_PER_MINUTE;
  }

  private blockReason(input: WakeCandidate): WakeBlock | "second-chance" | "verify" | null {
    if (this.lockReason) return "locked";
    if (input.nowMs < this.cooldownUntil) return "cooldown";
    if (this.speakingNow(input.nowMs) && this.isSelfVoice(input)) return "self-voice";
    if (this.speechHeardMs(input.nowMs) < this.cfg.minSpeechMs) return "no-speech";
    const raise = this.boost + this.sceneLikeRaise(input.nowMs);
    const effective = Math.min(0.98, input.threshold + raise);
    if (input.score < effective) {
      const second = this.secondChance(input, raise);
      if (second) return second;
      this.recordNearMiss(input, raise);
      if (raise === 0 && this.wantsVerify(input)) return "verify";
      return raise > 0 && input.score >= input.threshold ? "room-noise" : "below-threshold";
    }
    if (this.needsCorroboration(input) && !this.corroborated(input)) return "uncorroborated";
    if (input.kind === "frame") {
      this.hits += 1;
      if (this.hits < this.cfg.patienceFrames) return "patience";
    }
    return null;
  }

  /** A frame score inside the margin under the bar (the caller checked no raise is in force) and the rate cap allows it. */
  private wantsVerify(input: WakeCandidate): boolean {
    const margin = this.cfg.secondPassMargin;
    if (margin <= 0 || input.kind !== "frame") return false;
    if (input.source === "transcript" || input.source === "personal") return false;
    // Rounded so a score exactly one margin under the bar is inside it whatever the float arithmetic says.
    if (Math.round((input.threshold - input.score) * 1e6) > Math.round(margin * 1e6)) return false;
    return this.verifyAllowed(input.nowMs);
  }

  /** The most a scene tag or the ultrasonic flag raises the bar: one raise, never the two added together. */
  private sceneLikeRaise(nowMs: number): number {
    const flagged = this.ultrasonicSuspect(nowMs) ? SCENE_BOOST_MAX : 0;
    return Math.max(this.sceneRaise(nowMs), flagged);
  }

  /** A wake that came from the transcript alone, while a music or TV scene is on, wants a second witness. */
  private needsCorroboration(input: WakeCandidate): boolean {
    return (
      (input.source === "transcript" || input.source === "personal") &&
      this.sceneActive(input.nowMs)
    );
  }

  /** The scorer read close to the bar, or the name opened the utterance after a real lead-in of quiet. */
  private corroborated(input: WakeCandidate): boolean {
    const probe = input.probeScore;
    const band = Math.max(this.cfg.nearBand, CORROBORATE_BAND);
    if (typeof probe === "number" && Number.isFinite(probe) && probe >= input.threshold - band)
      return true;
    const leadIn = input.leadInMs;
    return (
      input.leading === true &&
      typeof leadIn === "number" &&
      Number.isFinite(leadIn) &&
      leadIn >= this.cfg.leadInMs
    );
  }

  private nearFloor(input: WakeCandidate): number {
    return Math.max(SECOND_CHANCE_FLOOR, input.threshold - this.cfg.nearBand);
  }

  /** A scorer frame just under the bar (no scene, no noise raise) is remembered for the next transcript wake. */
  private recordNearMiss(input: WakeCandidate, raise: number): void {
    if (this.cfg.nearBand <= 0 || raise > 0) return;
    if (input.source === "transcript" || input.source === "personal") return;
    if (input.score < this.nearFloor(input) || input.score >= input.threshold) return;
    this.nearMiss = { atMs: input.nowMs, epoch: this.utterEpoch };
  }

  /**
   * A leading transcript wake whose scorer reading sat just under the threshold (its own score, or a near-miss frame
   * of the same utterance inside `secondChanceMs`). Null when it does not apply, so the usual refusal stands.
   */
  private secondChance(input: WakeCandidate, raise: number): WakeBlock | "second-chance" | null {
    if (this.cfg.nearBand <= 0 || raise > 0) return null;
    if (input.source !== "transcript" || input.leading !== true) return null;
    const own = input.score >= this.nearFloor(input) && input.score < input.threshold;
    const miss = this.nearMiss;
    const recorded =
      miss !== null &&
      miss.epoch === this.utterEpoch &&
      input.nowMs >= miss.atMs &&
      input.nowMs - miss.atMs <= this.cfg.secondChanceMs;
    if (!own && !recorded) return null;
    if (input.speaker === "different") return "speaker-different";
    if (input.nowMs - this.lastSecondChanceAt < SECOND_CHANCE_SPACING_MS)
      return "second-chance-limit";
    this.lastSecondChanceAt = input.nowMs;
    return "second-chance";
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
    this.nearMiss = null;
    this.verifyPendingAt = -Infinity;
    this.ultraRun = 0;
    this.ultraUntil = -Infinity;
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
