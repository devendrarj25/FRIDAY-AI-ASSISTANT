/**
 * Wall-clock helper for "fast enough" tests. One timing is noise on a loaded box, so a timing
 * test takes the best of several runs and compares it with a bound that is at least ten times
 * the idle median. The test must also keep a non-timing assertion on the same work.
 */
export function bestOfMs(work: () => void, runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
