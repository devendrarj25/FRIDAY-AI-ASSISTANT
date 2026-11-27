/**
 * FRIDAY · the echo reference in live capture (setting `voice.echoReference`, default off).
 *
 * One `EchoReference` per Auto session listens to what the raw-sample player (`PcmClipPlayer`, setting
 * `voice.pcmPlayback`) schedules, and the one microphone capture (`pcm-capture.ts`) hands each frame here before
 * the VAD level and the STT ring read it. FRIDAY's own voice is taken out of the frame with `cancelMicFrame`
 * (`audio-aec.ts` under `echo-reference.ts`), so the words she speaks are not heard as the owner talking.
 *
 *   · Off, no reference, nothing played lately, the analyser fallback, or any error: the frame is left exactly as it
 *     was (`process` returns null), so today's `isSelfEcho` and echo-window filters stay the only defence.
 *   · No second microphone is opened. The playback clock and the capture clock are two audio contexts, so both are
 *     placed on the one `performance.now` timeline with a minimum filter (a late delivery only ever makes a
 *     candidate larger); the bulk delay that remains is the canceller's delay search, and the reference is read
 *     `LIVE_MARGIN_MS` ahead so it is never negative.
 *   · Only the page audio element path has no tap (Chromium plays it and cancels its own echo): no reference for
 *     it, the browser's own cancellation stays the only help there.
 *   · Memory only: one fixed ring and one canceller, cleared at stop (after the room's tail), when the microphone
 *     closes (leave Auto, Stop, pause), when the setting goes off, and after 5 s without playback. Nothing is
 *     persisted and no reference sample leaves the page. The only thing sent out is the measurement chunk below.
 *   · Measurement (setting on): at most once per 160 ms, while she is audible, one 160 ms chunk of the raw
 *     microphone and its aligned reference go to the local main process (`echoShadow`) and on to the local worker.
 *     It returns levels only (`reductionDb`), never gates anything and never goes to a cloud.
 *
 * The clocks, the context and the timers are injected, so the logic is tested on simulated rooms without a
 * speaker. A real room, the browser's own echo cancellation and a real device clock are not measured.
 */
import { preferences } from "../preferences";
import {
  captureLatencySeconds,
  setCaptureProcessor,
  workletCapturing,
  type CaptureProcessor,
} from "../pcm-capture";
import { EchoCanceller, MAX_AEC_FAILURES, type EchoStats } from "./audio-aec";
import { floatToPcm16, pcm16ToBase64, StreamSincResampler } from "./audio-format";
import {
  cancelMicFrame,
  contextLatencySeconds,
  ECHO_RATE,
  echoReferenceForMicFrame,
  EchoReference,
  LIVE_MARGIN_MS,
  type EchoReferenceStats,
} from "./echo-reference";
import type { PcmContext } from "./pcm-clip-player";
import type { ScheduledListener } from "./playback-scheduler";

/** What the live hook needs from the player: its clock and its two listener lists. */
export type EchoPlayerLike = {
  clock: PcmContext;
  addScheduledListener: (listener: ScheduledListener) => () => void;
  addStopListener: (listener: (atSeconds: number) => void) => () => void;
};

export type EchoShadowResult = {
  ok?: boolean;
  ready?: boolean;
  reductionDb?: number | null;
  delayMs?: number;
  reason?: string;
};

export type EchoShadowSend = (payload: {
  mic: string;
  ref?: string;
  reset?: boolean;
  seq?: number;
}) => Promise<EchoShadowResult> | EchoShadowResult;

export type EchoLiveDeps = {
  enabled?: () => boolean;
  /** The capture clock in milliseconds (`performance.now`). */
  nowMs?: () => number;
  /** The measurement bridge, or null when there is none (no desktop, or the setting is off). */
  shadow?: () => EchoShadowSend | null;
  captureLatency?: () => number;
  capturing?: () => boolean;
  /** Lower the echo a converged filter leaves (the residual suppressor). Read when the session attaches; default off. */
  suppressor?: () => boolean;
};

export type EchoLiveDiagnostics = {
  enabled: boolean;
  attached: boolean;
  /**
   * Frames the canceller cleaned and the filter is trusted for, and frames passed through unchanged or not yet
   * trusted (warm-up, settling), and failures (which also pass through).
   */
  cancelledFrames: number;
  passedFrames: number;
  errors: number;
  /** Times the memory was cleared, and why the last time. */
  clears: number;
  lastClear: string;
  /** The last measurement from the local canceller: dB removed from the microphone chunk, null until it ran. */
  reductionDb: number | null;
  delayMs: number | null;
  shadowReady: boolean | null;
  shadowReason: string;
  shadowSent: number;
  /** The canceller failed five frames in a row (or switched itself to passthrough): every frame passes untouched. */
  fellBack?: boolean;
  reference: EchoReferenceStats | null;
  canceller: EchoStats | null;
};

/** After a stop the room still returns what was played: the reference is kept this long, then dropped. */
export const STOP_HOLD_S = 1.5;
/** Without playback for this long the reference is dropped. */
export const IDLE_CLEAR_S = 5;
/** One measurement chunk is 160 ms of 16 kHz samples; the main process refuses a closer one. */
export const SHADOW_CHUNK = 2560;
export const SHADOW_GAP_MS = 170;
/** How fast a clock offset estimate may rise per second (a real clock drift is far below this). */
const DRIFT_PER_S = 150e-6;
/** A candidate this much above the estimate is a real jump (a suspended context), not a late delivery. */
const JUMP_S = 0.25;

/**
 * A frame counts as cleaned only once the filter has really been removing her voice for this long. The canceller
 * flags itself converged before the residual falls, and the VAD holds a voice for 250 ms, so the barge-in ladder
 * (which reads a cleaned-frame count as "the echo is gone") would take her own echo for the owner at the end of
 * her first second. The signal itself is cleaned from the first frame the canceller changes; only the count waits.
 */
export const SETTLE_MS = 250;
/** The least dB the canceller must report removing before the settling clock runs. */
export const TRUST_ERLE_DB = 3;

/**
 * The offset between a source clock and the common timeline. Every observation is "the source clock reads t, the
 * common clock reads T": the candidate T - t can be too large (the source value was stale, the delivery was late)
 * but never too small, so the smallest candidate is the best estimate. It may rise slowly (drift) and jumps at once
 * when a context was suspended. A `frozen` observation changes nothing: while an answer plays, the microphone
 * frames must stay on one steady clock, because a step of even a millisecond in the middle of an answer moves
 * the room's echo against the reference faster than the canceller's filter follows.
 */
export class OffsetFilter {
  private value: number | null = null;
  private at = 0;

  observe(candidate: number, nowSeconds: number, frozen = false): number {
    if (this.value === null) {
      if (!Number.isFinite(candidate)) return 0;
      this.value = candidate;
    } else if (!frozen && Number.isFinite(candidate)) {
      if (candidate - this.value > JUMP_S) {
        this.value = candidate;
      } else {
        const leak = Math.max(0, nowSeconds - this.at) * DRIFT_PER_S;
        this.value = Math.min(this.value + leak, candidate);
      }
    }
    this.at = nowSeconds;
    return this.value;
  }

  get current(): number | null {
    return this.value;
  }
}

/** The microphone clock: native samples counted since the capture started, and where they sit on the common timeline. */
type MicClock = { rate: number; native: number; anchor: OffsetFilter };

/** The 16 kHz stream of the frames that are being cleaned; it starts when the first answer chunk arrives. */
type MicState = {
  resample: StreamSincResampler;
  /** Native samples counted before this stream began. */
  base: number;
  out: number;
};

const realNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function realShadow(): EchoShadowSend | null {
  if (typeof window === "undefined") return null;
  const send = (window as unknown as { friday?: { echoShadow?: EchoShadowSend } }).friday
    ?.echoShadow;
  return typeof send === "function" ? send : null;
}

export class EchoLive {
  private readonly deps: Required<EchoLiveDeps>;
  private player: EchoPlayerLike | null = null;
  private reference: EchoReference | null = null;
  private canceller: EchoCanceller | null = null;
  private unsubscribe: Array<() => void> = [];
  private readonly playOffset = new OffsetFilter();
  private mic: MicState | null = null;
  private clock: MicClock | null = null;
  private clearAt: number | null = null;
  private failStreak = 0;
  private fellBack = false;
  private trusted = false;
  private settledSamples = 0;
  private counts = { cancelled: 0, passed: 0, errors: 0, clears: 0, shadowSent: 0 };
  private lastClear = "";
  private shadow = {
    buf: new Float32Array(SHADOW_CHUNK),
    fill: 0,
    start: 0,
    busy: false,
    at: -Infinity,
    seq: 0,
    first: true,
    reductionDb: null as number | null,
    delayMs: null as number | null,
    ready: null as boolean | null,
    reason: "",
  };
  private readonly processor: CaptureProcessor = {
    process: (samples, fromRate, atMono) => this.processFrame(samples, fromRate, atMono),
    clear: () => this.clear("microphone closed", true),
  };

  constructor(deps: EchoLiveDeps = {}) {
    this.deps = {
      enabled: deps.enabled ?? (() => preferences.getSnapshot().voice.echoReference === true),
      nowMs: deps.nowMs ?? realNow,
      shadow: deps.shadow ?? realShadow,
      captureLatency: deps.captureLatency ?? captureLatencySeconds,
      capturing: deps.capturing ?? workletCapturing,
      suppressor: deps.suppressor ?? (() => false),
    };
  }

  /**
   * Start listening to a player: builds the session's reference and installs the capture processor. Replaces an
   * earlier attachment. Never throws.
   */
  attach(player: EchoPlayerLike): void {
    try {
      this.detach();
      this.player = player;
      const clock = player.clock;
      this.reference = new EchoReference({
        latencySeconds: () => contextLatencySeconds(clock),
        marginMs: LIVE_MARGIN_MS,
      });
      this.canceller = new EchoCanceller({
        rate: ECHO_RATE,
        suppressor: this.deps.suppressor() === true,
      });
      this.failStreak = 0;
      this.fellBack = false;
      this.trusted = false;
      this.settledSamples = 0;
      this.unsubscribe = [
        player.addScheduledListener((when, pcm) => this.onScheduled(when, pcm)),
        player.addStopListener((at) => this.onStop(at)),
      ];
      setCaptureProcessor(this.processor);
    } catch {
      this.detach();
    }
  }

  /** Stop listening, forget everything and give the capture back unchanged. */
  detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.player) {
      this.clear("detached");
      setCaptureProcessor(null);
    }
    this.player = null;
    this.reference = null;
    this.canceller = null;
  }

  /** Forget the reference, the canceller and the microphone state at once (memory only). */
  clear(reason: string, closed = false): void {
    this.reference?.reset();
    this.canceller?.reset();
    this.mic = null;
    if (closed) this.clock = null;
    this.clearAt = null;
    this.trusted = false;
    this.settledSamples = 0;
    this.shadow.fill = 0;
    this.shadow.first = true;
    this.counts.clears += 1;
    this.lastClear = reason;
  }

  private monoSeconds(): number {
    return this.deps.nowMs() / 1000;
  }

  /** The playback context time `t` on the common timeline. */
  private toCommon(contextTime: number): number {
    const ctx = this.player?.clock;
    if (!ctx) return contextTime;
    const offset = this.playOffset.observe(
      this.monoSeconds() - ctx.currentTime,
      this.monoSeconds(),
    );
    return contextTime + offset;
  }

  private onScheduled(when: number, pcm: Int16Array): void {
    const reference = this.reference;
    const ctx = this.player?.clock;
    if (!reference || !ctx) return;
    if (!this.deps.enabled()) {
      if (reference.stats().chunks > 0) this.clear("setting off");
      return;
    }
    this.clearAt = null; // a new answer started: what was queued to be forgotten is the next answer's now
    reference.tap(this.toCommon(when), pcm, ctx.sampleRate);
  }

  private onStop(atSeconds: number): void {
    const reference = this.reference;
    if (!reference) return;
    reference.truncate(this.toCommon(atSeconds));
    if (!this.deps.capturing()) {
      this.clear("stopped");
      return;
    }
    // The room still returns what was played a moment ago, so the reference stays that long and is then dropped.
    this.clearAt = this.monoSeconds() + STOP_HOLD_S;
  }

  private housekeeping(nowSeconds: number): void {
    const reference = this.reference;
    if (!reference) return;
    if (this.clearAt !== null && nowSeconds >= this.clearAt) {
      this.clear("stopped");
    } else if (reference.stats().chunks > 0 && !reference.activeAt(nowSeconds, IDLE_CLEAR_S)) {
      this.clear("idle");
    }
  }

  private processFrame(
    samples: ArrayLike<number>,
    fromRate: number,
    atMono: number,
  ): Float32Array | null {
    try {
      const reference = this.reference;
      const canceller = this.canceller;
      if (this.fellBack) return null;
      if (!reference || !canceller || !(fromRate > 0) || !this.deps.capturing()) return null;
      if (!this.deps.enabled()) {
        if (reference.stats().chunks > 0 || this.mic) this.clear("setting off");
        this.clock = null;
        return null;
      }
      const nowSeconds = atMono / 1000;
      // The clock is learned all the time (cheap), so a steady estimate is ready when the first answer starts.
      if (!this.clock || this.clock.rate !== fromRate) {
        this.clock = {
          rate: fromRate,
          native: 0,
          anchor: new OffsetFilter(),
        };
        this.mic = null;
      }
      const clock = this.clock;
      clock.native += samples.length;
      this.housekeeping(nowSeconds);
      const playing = reference.stats().chunks > 0;
      const anchor = clock.anchor.observe(
        nowSeconds - clock.native / fromRate,
        nowSeconds,
        playing,
      );
      if (!playing) {
        // Nothing was played in this session (or it was dropped): no resampling, nothing kept.
        this.mic = null;
        return null;
      }
      if (!this.mic) {
        this.mic = {
          resample: new StreamSincResampler(fromRate, ECHO_RATE),
          base: clock.native - samples.length,
          out: 0,
        };
      }
      const mic = this.mic;
      const raw = mic.resample.push(samples);
      if (raw.length === 0) return null;
      const startTime = anchor + mic.base / fromRate + mic.out / ECHO_RATE;
      mic.out += raw.length;
      const latency = this.deps.captureLatency();
      const cleaned = cancelMicFrame(reference, canceller, raw, {
        deliveredAt: startTime + raw.length / ECHO_RATE,
        inputLatencySeconds: latency,
      });
      this.measure(raw, startTime - latency);
      this.failStreak = 0;
      if (canceller.isPassthrough()) {
        // the canceller gave up on its own (five failed frames): the frame goes on exactly as it came in
        this.fellBack = true;
        this.counts.passed += 1;
        return null;
      }
      if (cleaned === raw) {
        this.counts.passed += 1;
        return null;
      }
      if (!this.trusted) {
        // searching, warming up or settling: the frame went through the filter but is not counted as cleaned yet
        const st = canceller.stats();
        const removing = st.converged && st.erleDb !== null && st.erleDb >= TRUST_ERLE_DB;
        this.settledSamples = removing ? this.settledSamples + raw.length : 0;
        if (this.settledSamples >= (SETTLE_MS / 1000) * ECHO_RATE) this.trusted = true;
        else {
          this.counts.passed += 1;
          return cleaned;
        }
      }
      this.counts.cancelled += 1;
      return cleaned;
    } catch {
      this.counts.errors += 1;
      this.failStreak += 1;
      if (this.failStreak >= MAX_AEC_FAILURES) {
        this.fellBack = true;
        this.clear("failed");
      }
      return null;
    }
  }

  /** Feed the measurement: raw microphone samples whose first sample was in the air at `airStart`. */
  private measure(raw: Float32Array, airStart: number): void {
    const send = this.deps.shadow();
    const shadow = this.shadow;
    if (!send) {
      shadow.fill = 0;
      return;
    }
    let at = 0;
    while (at < raw.length) {
      if (shadow.fill === 0) shadow.start = airStart + at / ECHO_RATE;
      const take = Math.min(raw.length - at, SHADOW_CHUNK - shadow.fill);
      shadow.buf.set(raw.subarray(at, at + take), shadow.fill);
      shadow.fill += take;
      at += take;
      if (shadow.fill === SHADOW_CHUNK) {
        shadow.fill = 0;
        this.sendChunk(send);
      }
    }
  }

  private sendChunk(send: EchoShadowSend): void {
    const reference = this.reference;
    const shadow = this.shadow;
    const nowMs = this.deps.nowMs();
    if (!reference || shadow.busy || nowMs - shadow.at < SHADOW_GAP_MS) return;
    const ref = echoReferenceForMicFrame(reference, {
      deliveredAt: shadow.start + SHADOW_CHUNK / ECHO_RATE,
      frameLen: SHADOW_CHUNK,
    });
    if (!ref) return; // she is not audible in this chunk: nothing to measure
    shadow.busy = true;
    shadow.at = nowMs;
    shadow.seq += 1;
    const first = shadow.first;
    shadow.first = false;
    this.counts.shadowSent += 1;
    const done = (result: EchoShadowResult | null) => {
      shadow.busy = false;
      if (result?.ok === true) {
        shadow.ready = result.ready === true;
        shadow.reductionDb =
          typeof result.reductionDb === "number" && Number.isFinite(result.reductionDb)
            ? result.reductionDb
            : null;
        shadow.delayMs =
          typeof result.delayMs === "number" && Number.isFinite(result.delayMs)
            ? result.delayMs
            : null;
        shadow.reason = "";
      } else {
        shadow.ready = result?.ready === true ? true : null;
        shadow.reason = String(result?.reason || "no answer").slice(0, 80);
      }
    };
    try {
      const reply = send({
        mic: pcm16ToBase64(floatToPcm16(shadow.buf)),
        ref: pcm16ToBase64(ref),
        seq: shadow.seq,
        ...(first ? { reset: true } : {}),
      });
      if (reply && typeof (reply as Promise<EchoShadowResult>).then === "function") {
        void (reply as Promise<EchoShadowResult>).then(done, () => done(null));
      } else {
        done(reply as EchoShadowResult);
      }
    } catch {
      done(null);
    }
  }

  diagnostics(): EchoLiveDiagnostics {
    const shadow = this.shadow;
    return {
      enabled: this.deps.enabled(),
      attached: this.player !== null,
      cancelledFrames: this.counts.cancelled,
      passedFrames: this.counts.passed,
      errors: this.counts.errors,
      clears: this.counts.clears,
      lastClear: this.lastClear,
      reductionDb: shadow.reductionDb,
      delayMs: shadow.delayMs,
      shadowReady: shadow.ready,
      shadowReason: shadow.reason,
      shadowSent: this.counts.shadowSent,
      fellBack: this.fellBack,
      reference: this.reference?.stats() ?? null,
      canceller: this.canceller?.stats() ?? null,
    };
  }
}

/** The one live echo reference of this page. */
export const echoLive = new EchoLive();

/** What Voice diagnostics reads: counters and the last measured reduction. Read-only; no audio. */
export const echoDiagnostics = (): EchoLiveDiagnostics => echoLive.diagnostics();

/** Forget the reference now (memory only): pause, mute, Stop everything, leaving Auto. */
export const clearEchoReference = (reason = "cleared"): void => echoLive.clear(reason);
