/**
 * One shared, visibility-aware poller.
 *
 * Panels that need a periodic refresh subscribe here instead of owning a
 * setInterval. Jobs with the same key share one fetch. A single timer wakes
 * for the earliest due job, nothing runs while the window is hidden, a job
 * that throws backs off (up to 8x its interval) and the timer is cleared as
 * soon as the last subscriber leaves. Nothing here touches `window` until a
 * subscription is made, so rendering on the server is safe.
 */

export type PollJob = () => void | Promise<void>;

/** Called on every run of a shared job: `error` is null on success. */
export type PollResult = (error: unknown) => void;

export type PollerEnv = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  hidden: () => boolean;
  onVisible: (fn: () => void) => () => void;
};

type Entry = {
  key: string;
  job: PollJob;
  every: number;
  due: number;
  fails: number;
  running: boolean;
  listeners: Set<PollResult>;
};

const MAX_BACKOFF = 8;

export function backoffMs(every: number, fails: number): number {
  return every * Math.min(MAX_BACKOFF, 2 ** Math.max(0, fails));
}

export function createPoller(env: PollerEnv) {
  const entries = new Map<string, Entry>();
  let handle: unknown = null;
  let offVisible: (() => void) | null = null;

  const stopTimer = () => {
    if (handle !== null) env.clearTimer(handle);
    handle = null;
  };

  const arm = () => {
    stopTimer();
    if (entries.size === 0 || env.hidden()) return;
    const next = Math.min(...[...entries.values()].map((e) => e.due));
    handle = env.setTimer(tick, Math.max(0, next - env.now()));
  };

  const run = async (e: Entry) => {
    if (e.running) return;
    e.running = true;
    let failure: unknown = null;
    try {
      await e.job();
      e.fails = 0;
    } catch (err) {
      e.fails += 1;
      failure = err ?? new Error("poll failed");
    } finally {
      for (const l of [...e.listeners]) l(failure);
      e.running = false;
      if (entries.get(e.key) === e) e.due = env.now() + backoffMs(e.every, e.fails);
      arm();
    }
  };

  function tick() {
    handle = null;
    if (env.hidden()) return;
    const now = env.now();
    for (const e of entries.values()) if (e.due <= now) void run(e);
    arm();
  }

  const ensureVisibility = () => {
    if (offVisible) return;
    offVisible = env.onVisible(() => {
      if (env.hidden()) {
        stopTimer();
        return;
      }
      // Back on screen: refresh what went stale while hidden, then resume.
      const now = env.now();
      for (const e of entries.values()) if (e.due <= now) void run(e);
      arm();
    });
  };

  return {
    /** Subscribe; the job first runs after `every` ms unless `immediate`. */
    subscribe(
      key: string,
      job: PollJob,
      every: number,
      onResult?: PollResult,
      immediate = true,
    ): () => void {
      let e = entries.get(key);
      if (!e) {
        e = {
          key,
          job,
          every,
          due: env.now() + (immediate ? 0 : every),
          fails: 0,
          running: false,
          listeners: new Set(),
        };
        entries.set(key, e);
      } else {
        e.every = Math.min(e.every, every);
      }
      const listener: PollResult = onResult ?? (() => undefined);
      e.listeners.add(listener);
      ensureVisibility();
      arm();
      let left = true;
      return () => {
        if (!left) return;
        left = false;
        const cur = entries.get(key);
        if (!cur) return;
        cur.listeners.delete(listener);
        if (cur.listeners.size === 0) entries.delete(key);
        if (entries.size === 0) {
          stopTimer();
          offVisible?.();
          offVisible = null;
        } else arm();
      };
    },
    /** Run one job now (Refresh button), keeping its schedule. */
    async refresh(key: string): Promise<void> {
      const e = entries.get(key);
      if (e) await run(e);
    },
    size: () => entries.size,
    timers: () => (handle === null ? 0 : 1),
  };
}

const browserEnv = (): PollerEnv => ({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== "undefined" && document.hidden,
  onVisible: (fn) => {
    document.addEventListener("visibilitychange", fn);
    window.addEventListener("focus", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
      window.removeEventListener("focus", fn);
    };
  },
});

let shared: ReturnType<typeof createPoller> | null = null;

/** The app's one poller, created on first use in the browser. */
export function livePoller(): ReturnType<typeof createPoller> {
  shared ??= createPoller(browserEnv());
  return shared;
}
