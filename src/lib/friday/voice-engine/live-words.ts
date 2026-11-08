/**
 * FRIDAY · live words while the owner is still speaking.
 *
 * The local recogniser is not a streaming engine: it reads a finished piece of audio. This turns it into one the way
 * the Whisper streaming work does: every hop it reads the audio spoken so far (the last `maxWindowMs` of it),
 * and a word is shown as settled only once two passes in a row agree on it (LocalAgreement-2, see
 * `transcript-stabilizer.ts`). The words after the settled ones are shown as provisional. Nothing here may start
 * an action: the final transcript, from the normal path, is the only one that does.
 *
 * Cost control: one pass at a time (a pass still running is never joined by another), a bounded number of
 * passes per utterance, and it stops the moment speech stops so the final reading is not delayed by it.
 * Opt-in (`voice.liveWords`), off by default, because every pass is a real recognition on this PC's CPU.
 */
import { TranscriptStabilizer } from "./transcript-stabilizer";

export type LiveWordsUpdate = {
  /** Words two passes agreed on. */
  settled: string;
  /** Everything heard so far, settled and provisional. */
  shown: string;
  passes: number;
};

export type LiveWordsDeps = {
  /** The audio spoken since `fromMono` (ms clock), mono at `rate`, newest `maxMs` only. */
  audioSince: (fromMono: number, maxMs: number) => { samples: Float32Array; rate: number };
  /** One recognition of a WAV clip. */
  transcribe: (wav: Uint8Array) => Promise<{ ok: boolean; text?: string }>;
  encodeWav: (samples: Float32Array, rate: number) => Uint8Array;
  /** True while speech is still being heard. */
  speaking: () => boolean;
  onUpdate: (update: LiveWordsUpdate) => void;
  now?: () => number;
  hopMs?: number;
  maxWindowMs?: number;
  minAudioMs?: number;
  maxPasses?: number;
};

export class LiveWords {
  private from = 0;
  private active = false;
  private busy = false;
  private passes = 0;
  private lastPassAt: number | null = null;
  private stabilizer = new TranscriptStabilizer({ minActionWords: 9_999 });
  private readonly now: () => number;

  constructor(private readonly deps: LiveWordsDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** Start following an utterance that began at `fromMono`. */
  start(fromMono: number): void {
    this.from = fromMono;
    this.active = true;
    this.busy = false;
    this.passes = 0;
    this.lastPassAt = null;
    this.stabilizer = new TranscriptStabilizer({ minActionWords: 9_999 });
  }

  stop(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Call often (a timer). Does a pass only when one is due and none is running. */
  async tick(): Promise<void> {
    if (!this.active || this.busy) return;
    const hop = this.deps.hopMs ?? 1200;
    const max = this.deps.maxPasses ?? 14;
    if (this.passes >= max) return;
    if (!this.deps.speaking()) {
      this.active = false; // speech ended: the normal final reading takes over, undisturbed
      return;
    }
    const t = this.now();
    if (this.lastPassAt !== null && t - this.lastPassAt < hop) return;
    const { samples, rate } = this.deps.audioSince(this.from, this.deps.maxWindowMs ?? 12_000);
    if ((samples.length / rate) * 1000 < (this.deps.minAudioMs ?? 900)) return;
    this.busy = true;
    this.lastPassAt = t;
    try {
      const out = await this.deps.transcribe(this.deps.encodeWav(samples, rate));
      if (!this.active || !out.ok) return;
      const text = (out.text ?? "").trim();
      if (!text) return;
      this.passes += 1;
      const snapshot = this.stabilizer.push(text);
      // Words that settled stay put even when the window later slides past their audio.
      this.stabilizer.commit(snapshot.stable);
      this.deps.onUpdate({
        settled: snapshot.stable,
        shown: snapshot.partial,
        passes: this.passes,
      });
    } catch {
      // A failed pass is skipped; the normal final reading is unaffected.
    } finally {
      this.busy = false;
    }
  }
}
