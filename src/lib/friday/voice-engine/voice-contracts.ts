/**
 * FRIDAY · the small shapes the streaming speech paths share.
 *
 * A transcript or an audio chunk is only ever acted on when its session, turn and generation are still the
 * current ones. A partial transcript is provisional and never actionable; a final one is acted on once.
 */

export type VoiceTranscriptEvent =
  | {
      type: "partial";
      sessionId: string;
      turnId: string;
      revision: number;
      text: string;
      language?: string;
      atMonoMs: number;
    }
  | {
      type: "final";
      sessionId: string;
      turnId: string;
      revision: number;
      text: string;
      language?: string;
      atMonoMs: number;
    };

export type VoiceTtsEvent =
  | { type: "request-started"; sessionId: string; turnId: string; generationId: number }
  | {
      type: "audio-chunk";
      sessionId: string;
      turnId: string;
      generationId: number;
      sequence: number;
      mime: string;
      audioBase64: string;
    }
  | { type: "utterance-complete"; sessionId: string; turnId: string; generationId: number }
  | { type: "cancelled"; sessionId: string; turnId: string; generationId: number }
  | {
      type: "error";
      sessionId: string;
      turnId: string;
      generationId: number;
      category: "auth" | "quota" | "config" | "network" | "provider";
      retryable: boolean;
      message: string;
    };

/** One turn becomes one Brain request: the second `finalizeOnce` for the same turn answers false. */
export class TurnFinalizer {
  private readonly done = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly keep = 64) {}

  finalizeOnce(sessionId: string, turnId: string): boolean {
    const key = `${sessionId}:${turnId}`;
    if (this.done.has(key)) return false;
    this.done.add(key);
    this.order.push(key);
    while (this.order.length > this.keep) this.done.delete(this.order.shift()!);
    return true;
  }

  reset(): void {
    this.done.clear();
    this.order.length = 0;
  }
}

/**
 * One speech generation at a time may be heard. Cancelling moves to a new number, so a late chunk of the old
 * generation is recognised and dropped whatever order things arrive in.
 */
export class GenerationGuard {
  private current = 0;

  next(): number {
    this.current += 1;
    return this.current;
  }

  get id(): number {
    return this.current;
  }

  isCurrent(generationId: number): boolean {
    return generationId === this.current;
  }

  /** Invalidate the running generation. Returns the number that was cancelled. */
  cancel(): number {
    const old = this.current;
    this.current += 1;
    return old;
  }
}
