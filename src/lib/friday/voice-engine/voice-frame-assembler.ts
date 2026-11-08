/**
 * FRIDAY · live wake scoring fed from the one shared capture.
 *
 * `FrameAssembler` turns captured frames of any rate into 16 kHz mono PCM16 chunks of a fixed length (a multiple
 * of the 80 ms frame the wake model scores), so the worker receives few, regular messages instead of every tiny
 * capture callback.
 *
 * `createWakeFrameFeed` listens to the capture through `subscribeCaptureFrames` (it never opens a microphone) and
 * sends chunks to the wake worker only while `allowed()` is true: hands-free wake mode on, Auto mode running, not
 * muted or paused. Nothing leaves this PC here: scoring is local, and no cloud audio is sent before the wake word.
 * The send queue is bounded; a chunk that cannot be sent is counted and dropped, never queued without limit.
 * A trigger reports the score and the capture time so the caller can take the pre-roll that holds the first word
 * after the wake phrase (`preRollFrom` in `pcm-capture.ts`).
 */
import { desktopApi } from "../desktop";
import { subscribeCaptureFrames } from "../pcm-capture";
import { StreamResampler, floatToPcm16, pcm16ToBase64 } from "./audio-format";

export const WAKE_RATE = 16_000;
export const WAKE_FRAME_SAMPLES = 1280; // 80 ms at 16 kHz

export class FrameAssembler {
  private resampler: StreamResampler | null = null;
  private fromRate = 0;
  private pending = new Int16Array(0);

  /** `chunkFrames` 80 ms frames per chunk (2 = 160 ms). */
  constructor(private readonly chunkFrames = 2) {}

  /** Add a captured frame; returns the whole chunks that are now complete (zero or more). */
  push(samples: ArrayLike<number>, fromRate: number): Int16Array[] {
    if (!(fromRate > 0) || samples.length === 0) return [];
    if (!this.resampler || this.fromRate !== fromRate) {
      this.resampler = new StreamResampler(fromRate, WAKE_RATE);
      this.fromRate = fromRate;
    }
    const pcm = floatToPcm16(this.resampler.push(samples));
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending, 0);
    joined.set(pcm, this.pending.length);
    const size = WAKE_FRAME_SAMPLES * this.chunkFrames;
    const out: Int16Array[] = [];
    let at = 0;
    while (joined.length - at >= size) {
      out.push(joined.slice(at, at + size));
      at += size;
    }
    this.pending = joined.slice(at);
    return out;
  }

  /** Samples held back, waiting for a whole chunk. */
  get held(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = new Int16Array(0);
    this.resampler = null;
    this.fromRate = 0;
  }
}

type WakeApi = Pick<NonNullable<ReturnType<typeof desktopApi>>, "scoreWakeFrames">;

export type WakeFrameFeedDeps = {
  sessionId: string;
  wakeWord: string;
  /** The saved policy: hands-free wake mode on, Auto running, microphone not muted or paused. */
  allowed: () => boolean;
  onWake: (info: { score: number; atMono: number }) => void;
  onStatus?: (status: "listening" | "blocked" | "unavailable", detail?: string) => void;
  api?: WakeApi | null;
  subscribe?: typeof subscribeCaptureFrames;
  threshold?: number;
  maxInFlight?: number;
};

export function createWakeFrameFeed(deps: WakeFrameFeedDeps) {
  const assembler = new FrameAssembler(2);
  const subscribe = deps.subscribe ?? subscribeCaptureFrames;
  const maxInFlight = deps.maxInFlight ?? 4;
  let off: (() => void) | null = null;
  let inFlight = 0;
  let dropped = 0;
  let chunks = 0;
  let wasAllowed = false;
  let lastScore = 0;
  let unavailable = false;

  const api = (): WakeApi | null => deps.api ?? (desktopApi() as WakeApi | null);

  function send(pcm: Int16Array, atMono: number) {
    const a = api();
    if (!a?.scoreWakeFrames || unavailable) return;
    if (inFlight >= maxInFlight) {
      dropped += 1;
      return;
    }
    inFlight += 1;
    chunks += 1;
    void a
      .scoreWakeFrames({
        session: deps.sessionId,
        pcmBase64: pcm16ToBase64(pcm),
        wakeWord: deps.wakeWord,
        ...(deps.threshold !== undefined ? { threshold: deps.threshold } : {}),
      })
      .then((r) => {
        if (!r.ok) {
          // No openWakeWord model, or only the clip scorer: say so once and stop sending.
          unavailable = true;
          deps.onStatus?.("unavailable", r.reason);
          return;
        }
        if (typeof r.score === "number") lastScore = r.score;
        if (r.detected && deps.allowed()) deps.onWake({ score: r.score ?? 0, atMono });
      })
      .catch(() => {
        dropped += 1;
      })
      .finally(() => {
        inFlight -= 1;
      });
  }

  return {
    start() {
      if (off) return;
      off = subscribe((samples, fromRate, atMono) => {
        const ok = deps.allowed();
        if (!ok) {
          if (wasAllowed) {
            assembler.reset();
            void api()?.scoreWakeFrames?.({ session: deps.sessionId, reset: true });
            deps.onStatus?.("blocked");
          }
          wasAllowed = false;
          return;
        }
        if (!wasAllowed) deps.onStatus?.("listening");
        wasAllowed = true;
        for (const chunk of assembler.push(samples, fromRate)) send(chunk, atMono);
      });
    },
    stop() {
      off?.();
      off = null;
      assembler.reset();
      wasAllowed = false;
      void api()?.scoreWakeFrames?.({ session: deps.sessionId, reset: true });
    },
    stats: () => ({
      chunks,
      dropped,
      inFlight,
      lastScore,
      unavailable,
      listening: off !== null && wasAllowed,
    }),
  };
}
