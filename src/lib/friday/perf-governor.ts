/**
 * Keeps FRIDAY smooth on any PC, and quiet while something else has the screen.
 *
 * Two jobs, both small and both off the hot path:
 *
 *  1. While the window is not the one the owner is using (a game, another app, the browser tab inside FRIDAY),
 *     the decorative loops hold still (`html.friday-unfocused`). Chromium's occlusion detection is switched off for
 *     the voice timers (electron/main.cjs), so a covered window would otherwise keep drawing its animated glass at
 *     full rate beside a game. Voice, timers and background work are not touched: only CSS animation is paused.
 *
 *  2. While the window IS in use, a short frame sample every few seconds measures how smooth it really is. If the
 *     page keeps missing frames or blocking the thread, the decoration steps down a tier (`friday-perf-balanced`,
 *     then `friday-perf-lean`) and comes back after it has been smooth for a while. A PC that copes never leaves the
 *     full look; the owner's own settings are never changed, only held back for the moment.
 *
 * The decision logic is pure (`judgeSample`, `createGovernor`) so a test can read it; `installPerfGovernor` is the
 * only part that touches the page.
 */

export type PerfTier = "full" | "balanced" | "lean";
export type Verdict = "good" | "bad" | "idle";

export const TIER_CLASS: Record<Exclude<PerfTier, "full">, string> = {
  balanced: "friday-perf-balanced",
  lean: "friday-perf-lean",
};
export const UNFOCUSED_CLASS = "friday-unfocused";

/** A frame later than this (ms) is a visible hitch (about 25 fps). */
export const SLOW_FRAME_MS = 40;
/** A task this long (ms) blocks input and animation. */
export const LONG_TASK_MS = 120;
export const MIN_FRAMES = 30;

export type Sample = { frameMs: number[]; longTaskMs: number[] };

/** Turns one sample window into a verdict. Too few frames (a hidden or throttled page) says nothing. */
export function judgeSample(sample: Sample): Verdict {
  if (sample.frameMs.length < MIN_FRAMES) return "idle";
  const sorted = [...sample.frameMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const blocking = sample.longTaskMs.filter((ms) => ms >= LONG_TASK_MS).length;
  const huge = sample.longTaskMs.some((ms) => ms >= 400);
  return p95 > SLOW_FRAME_MS || blocking >= 3 || huge ? "bad" : "good";
}

const ORDER: PerfTier[] = ["full", "balanced", "lean"];
/** Two bad windows in a row step down; eight good ones in a row step back up (a slow, steady return). */
export const BAD_TO_STEP_DOWN = 2;
export const GOOD_TO_STEP_UP = 8;

export function createGovernor(start: PerfTier = "full") {
  let tier: PerfTier = start;
  let bad = 0;
  let good = 0;
  return {
    tier: () => tier,
    /** Feed one verdict; returns the tier to use now. "idle" changes nothing. */
    push(verdict: Verdict): PerfTier {
      if (verdict === "idle") return tier;
      if (verdict === "bad") {
        good = 0;
        bad += 1;
        if (bad >= BAD_TO_STEP_DOWN) {
          bad = 0;
          tier = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + 1)] ?? tier;
        }
      } else {
        bad = 0;
        good += 1;
        if (good >= GOOD_TO_STEP_UP) {
          good = 0;
          tier = ORDER[Math.max(0, ORDER.indexOf(tier) - 1)] ?? tier;
        }
      }
      return tier;
    },
  };
}

type Env = {
  root: {
    classList: { add(c: string): void; remove(c: string): void };
    dataset: Record<string, string | undefined>;
  };
  focused: () => boolean;
  visible: () => boolean;
  onFocusChange: (fn: () => void) => () => void;
  onLongTask: (fn: (ms: number) => void) => () => void;
  sampleFrames: (ms: number) => Promise<number[]>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
};

/** Frame gaps over `ms`, measured with one short requestAnimationFrame loop that stops by itself. */
function sampleFramesInPage(ms: number): Promise<number[]> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = 0;
    const start = performance.now();
    const step = (now: number) => {
      if (last) gaps.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(step);
      else resolve(gaps);
    };
    requestAnimationFrame(step);
  });
}

function pageEnv(): Env | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    root: document.documentElement as unknown as Env["root"],
    focused: () => document.hasFocus(),
    visible: () => !document.hidden,
    onFocusChange: (fn) => {
      window.addEventListener("focus", fn);
      window.addEventListener("blur", fn);
      document.addEventListener("visibilitychange", fn);
      return () => {
        window.removeEventListener("focus", fn);
        window.removeEventListener("blur", fn);
        document.removeEventListener("visibilitychange", fn);
      };
    },
    onLongTask: (fn) => {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) fn(entry.duration);
        });
        observer.observe({ entryTypes: ["longtask"] });
        return () => observer.disconnect();
      } catch {
        return () => undefined;
      }
    },
    sampleFrames: sampleFramesInPage,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

const SAMPLE_MS = 2000;
const EVERY_MS = 10_000;

export function installPerfGovernor(env: Env | null = pageEnv()): () => void {
  if (!env) return () => undefined;
  const e = env;
  const governor = createGovernor();
  let stopped = false;
  let handle: unknown = null;
  let longTasks: number[] = [];
  let applied: PerfTier = "full";

  const applyTier = (tier: PerfTier) => {
    if (tier === applied) return;
    for (const name of Object.values(TIER_CLASS)) e.root.classList.remove(name);
    if (tier !== "full") e.root.classList.add(TIER_CLASS[tier]);
    e.root.dataset["fridayPerf"] = tier;
    applied = tier;
  };

  // 1. Not the window in use: the decorative loops hold still.
  const syncFocus = () => {
    if (e.focused() && e.visible()) e.root.classList.remove(UNFOCUSED_CLASS);
    else e.root.classList.add(UNFOCUSED_CLASS);
  };
  syncFocus();
  const offFocus = e.onFocusChange(syncFocus);
  const offLong = e.onLongTask((ms) => {
    longTasks.push(ms);
    if (longTasks.length > 200) longTasks = longTasks.slice(-100);
  });

  // 2. Window in use: a short frame sample every few seconds.
  const round = async () => {
    handle = null;
    if (stopped) return;
    if (e.focused() && e.visible()) {
      longTasks = [];
      const frameMs = await e.sampleFrames(SAMPLE_MS);
      if (stopped) return;
      applyTier(governor.push(judgeSample({ frameMs, longTaskMs: longTasks })));
    }
    if (!stopped) handle = e.setTimer(() => void round(), EVERY_MS);
  };
  handle = e.setTimer(() => void round(), EVERY_MS);

  return () => {
    stopped = true;
    if (handle !== null) e.clearTimer(handle);
    offFocus();
    offLong();
    e.root.classList.remove(UNFOCUSED_CLASS);
    applyTier("full");
  };
}
