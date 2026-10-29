/**
 * Run work after the effect's synchronous turn.
 * A state update from an external read then happens on a later turn, which is
 * what a subscription or a fetch is for. The returned function cancels work
 * that has not started.
 */
export function deferEffect(work: () => void): () => void {
  let cancelled = false;
  void Promise.resolve().then(() => {
    if (!cancelled) work();
  });
  return () => {
    cancelled = true;
  };
}

/** Skeleton bar width in the 50–90% band. Stable for one id, no clock or random. */
export function skeletonWidth(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash + ch.charCodeAt(0)) % 41;
  return `${50 + hash}%`;
}
