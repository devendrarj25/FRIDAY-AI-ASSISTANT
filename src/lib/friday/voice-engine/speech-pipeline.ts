/**
 * FRIDAY · pipelined speech: start talking after the first clip, not after the last.
 *
 * A reply is several clips (clauses, each in its own language). Making every clip first and playing afterwards
 * makes the first sound wait for the slowest part of the whole reply. Here synthesis of the next clips runs
 * while the current one plays: at most `ahead` clips are being made at any time, they are played strictly in
 * order, and a clip that failed ends the pipeline at that point so the caller can finish the rest another way.
 * Pure orchestration: making and playing a clip are injected, so it is tested without audio.
 */

export type PipelineResult = {
  /** Clips that were played in full. */
  played: number;
  /** Index of the first clip that could not be made, or null when all were. */
  failedAt: number | null;
  /** True when the speech was dropped (barge-in or a newer reply) before it finished. */
  stale: boolean;
};

export type PipelineOptions<Item, Clip> = {
  items: readonly Item[];
  /** Make one clip; null or a throw means this clip could not be made. */
  synthesize: (item: Item, index: number) => Promise<Clip | null>;
  /** Play one clip to its end. */
  play: (clip: Clip, item: Item, index: number) => Promise<void>;
  stale: () => boolean;
  /** How many clips may be in the making at once, counting the one about to play. */
  ahead?: number;
  /** Called once, just before the first clip is played, with that clip. */
  onFirstClip?: (clip: Clip, item: Item) => void;
  /** Silence after a clip, in ms, before the next one (not after the last). */
  gapAfter?: (item: Item, index: number) => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSpeechPipeline<Item, Clip>(
  options: PipelineOptions<Item, Clip>,
): Promise<PipelineResult> {
  const { items, stale } = options;
  const ahead = Math.max(1, options.ahead ?? 2);
  const sleep = options.sleep ?? defaultSleep;
  const pending = new Map<number, Promise<Clip | null>>();
  let started = 0;

  const launch = (upTo: number) => {
    while (started < items.length && started < upTo) {
      const index = started;
      started += 1;
      pending.set(
        index,
        options.synthesize(items[index] as Item, index).catch(() => null),
      );
    }
  };

  launch(ahead);
  let played = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (stale()) return { played, failedAt: null, stale: true };
    const clip = await pending.get(index);
    pending.delete(index);
    if (stale()) return { played, failedAt: null, stale: true };
    if (clip === null || clip === undefined) return { played, failedAt: index, stale: false };
    // Start making the clip after the next while this one is about to play.
    launch(index + 1 + ahead);
    if (played === 0) options.onFirstClip?.(clip, items[index] as Item);
    await options.play(clip, items[index] as Item, index);
    played += 1;
    if (stale()) return { played, failedAt: null, stale: true };
    const gap =
      index < items.length - 1 ? (options.gapAfter?.(items[index] as Item, index) ?? 0) : 0;
    if (gap > 0) await sleep(gap);
  }
  return { played, failedAt: null, stale: false };
}
