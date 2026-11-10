/**
 * FRIDAY · a record of one long Auto-mode session, for the 30-minute hardware check.
 *
 * It keeps only what the check needs, in memory, and invents nothing: one memory sample a minute, the first-sound
 * time of each finished turn, how many times the supervisor had to mend a stuck state, and how many microphone
 * faults were not followed by listening again. `scripts/voice-hardware-validate.cjs soak` turns the exported JSON
 * into the numbers the scenario asks for.
 */

export type SoakRecord = {
  startedAt: number | null;
  endedAt: number | null;
  samples: Array<{ at: number; heapMb: number | null }>;
  turns: Array<{ at: number; firstSoundMs: number | null }>;
  interventions: number;
  micFaults: number;
  unrecoveredFaults: number;
};

const SAMPLE_EVERY_MS = 60_000;
const KEEP = 600; // ten hours of minute samples

export class SoakRecorder {
  private data: SoakRecord = {
    startedAt: null,
    endedAt: null,
    samples: [],
    turns: [],
    interventions: 0,
    micFaults: 0,
    unrecoveredFaults: 0,
  };
  private pendingFaults = 0;

  start(at: number): void {
    if (this.data.startedAt !== null && this.data.endedAt === null) return; // already running
    this.data = {
      startedAt: at,
      endedAt: null,
      samples: [],
      turns: [],
      interventions: 0,
      micFaults: 0,
      unrecoveredFaults: 0,
    };
    this.pendingFaults = 0;
  }

  get running(): boolean {
    return this.data.startedAt !== null && this.data.endedAt === null;
  }

  stop(at: number): void {
    if (!this.running) return;
    this.data.endedAt = at;
    this.data.unrecoveredFaults = this.pendingFaults;
  }

  /** At most one sample a minute, whatever the caller's rhythm. `heapMb` is null where the engine reports none. */
  sample(at: number, heapMb: number | null): void {
    if (!this.running) return;
    const last = this.data.samples[this.data.samples.length - 1];
    if (last && at - last.at < SAMPLE_EVERY_MS) return;
    this.data.samples.push({ at, heapMb: heapMb === null ? null : Math.round(heapMb * 10) / 10 });
    if (this.data.samples.length > KEEP) this.data.samples.shift();
  }

  turn(at: number, firstSoundMs: number | null): void {
    if (!this.running) return;
    this.data.turns.push({
      at,
      firstSoundMs: firstSoundMs === null ? null : Math.round(firstSoundMs),
    });
  }

  intervention(): void {
    if (this.running) this.data.interventions += 1;
  }

  fault(): void {
    if (!this.running) return;
    this.data.micFaults += 1;
    this.pendingFaults += 1;
  }

  /** Listening again after a fault: every fault so far counts as recovered. */
  recovered(): void {
    this.pendingFaults = 0;
  }

  record(): SoakRecord {
    return {
      ...this.data,
      samples: [...this.data.samples],
      turns: [...this.data.turns],
      unrecoveredFaults: this.running ? this.pendingFaults : this.data.unrecoveredFaults,
    };
  }
}
