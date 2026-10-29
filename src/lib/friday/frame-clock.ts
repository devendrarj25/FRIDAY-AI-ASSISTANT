/**
 * One animation clock for the voice stage and the companion.
 *
 * Jobs share a single requestAnimationFrame. The clock does not fire while
 * the window is hidden, so a minimised FRIDAY does not keep drawing. Age
 * labels use the one-second clock and write text directly, which keeps the
 * neural graphic from rendering on a timer.
 */

type Tick = (now: number) => void;

const frameJobs = new Set<Tick>();
const secondJobs = new Set<Tick>();
let raf = 0;
let secondTimer = 0;
let listening = false;
let hiddenRead = (): boolean => typeof document !== "undefined" && Boolean(document.hidden);

function hidden(): boolean {
  return hiddenRead();
}

function ensureVisibility(): void {
  if (listening || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (hidden()) {
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0;
      stopSecond();
      return;
    }
    armFrame();
    armSecond();
  });
  listening = true;
}

function frameLoop(now: number): void {
  raf = 0;
  if (hidden() || frameJobs.size === 0) return;
  for (const job of frameJobs) job(now);
  if (frameJobs.size && !hidden()) armFrame();
}

function armFrame(): void {
  if (raf || hidden() || frameJobs.size === 0) return;
  if (typeof requestAnimationFrame !== "function") return;
  raf = requestAnimationFrame(frameLoop);
}

function stopSecond(): void {
  if (secondTimer && typeof window !== "undefined") window.clearInterval(secondTimer);
  secondTimer = 0;
}

function armSecond(): void {
  if (secondTimer || hidden() || secondJobs.size === 0) return;
  if (typeof window === "undefined") return;
  secondTimer = window.setInterval(() => {
    if (hidden()) {
      stopSecond();
      return;
    }
    const now = Date.now();
    for (const job of secondJobs) job(now);
  }, 1000);
}

/** Draw callback. Paused while the document is hidden. */
export function onVisibleFrame(job: Tick): () => void {
  ensureVisibility();
  frameJobs.add(job);
  armFrame();
  return () => {
    frameJobs.delete(job);
    if (!frameJobs.size && raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** One-second callback for text that must move without a React render. */
export function onVisibleSecond(job: Tick): () => void {
  ensureVisibility();
  secondJobs.add(job);
  armSecond();
  return () => {
    secondJobs.delete(job);
    if (!secondJobs.size) stopSecond();
  };
}

/** Tests replace the visibility read. Production uses document.hidden. */
export function setFrameClockHidden(read: () => boolean): void {
  hiddenRead = read;
}

/** Run one visible frame. Returns 0 while hidden or while nobody is drawing. */
export function pumpFrameClock(now: number): number {
  if (hidden() || frameJobs.size === 0) return 0;
  for (const job of frameJobs) job(now);
  return frameJobs.size;
}

/** Run one visible second. Returns 0 while hidden. */
export function pumpSecondClock(now: number): number {
  if (hidden() || secondJobs.size === 0) return 0;
  for (const job of secondJobs) job(now);
  return secondJobs.size;
}

export function frameClockJobCount(): number {
  return frameJobs.size;
}

export function resetFrameClock(): void {
  if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  raf = 0;
  stopSecond();
  frameJobs.clear();
  secondJobs.clear();
  hiddenRead = () => typeof document !== "undefined" && Boolean(document.hidden);
}
