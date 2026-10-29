/**
 * FRIDAY · real network connectivity + speed meter.
 *
 * No simulation: reachability and throughput are measured by actually moving
 * bytes. A tiny HEAD/GET probe measures latency every few seconds, and a
 * larger download sample measures real Mbps on a slower cadence so the meter
 * never becomes a bandwidth hog itself.
 *
 * One shared store — the title strip, status page and anything else read the
 * same live sample instead of each running their own probe.
 */

export type NetworkSample = {
  online: boolean;
  /** Round-trip latency in ms, -1 when unknown. */
  latencyMs: number;
  /** Measured download throughput in Mbps, -1 until the first sample lands. */
  downMbps: number;
  /** Live machine download rate from the OS adapter counters, -1 when unknown. */
  liveDownMbps: number;
  /** Live machine upload rate from the OS adapter counters, -1 when unknown. */
  liveUpMbps: number;
  /** What FRIDAY's own window is pulling right now, in Mbps (0 when idle). */
  appMbps: number;
  /** Short label for compact UI slots. */
  label: string;
  /** Where the numbers came from. */
  source: "desktop" | "measured" | "navigator" | "offline";
  /** Main-process reachability detail used by the model router. */
  detail: string;
  /**
   * Why the whole-machine adapter counters are unavailable, straight from the
   * OS probe (e.g. "PowerShell access blocked by execution policy: …").
   * Empty when the counters are being read normally.
   */
  machineDetail: string;
  at: number;
};

const LATENCY_URLS = [
  "https://cloudflare.com/cdn-cgi/trace",
  "https://www.gstatic.com/generate_204",
];
const SPEED_URL = "https://speed.cloudflare.com/__down?bytes=";
const SPEED_BYTES = 300_000;

const LATENCY_EVERY = 5_000;
const SPEED_EVERY = 60_000;
/** Rolling window used to turn FRIDAY's own transfers into a live rate. */
const APP_WINDOW_MS = 4_000;
const APP_TICK = 1_000;

const EMPTY: NetworkSample = {
  online: true,
  latencyMs: -1,
  downMbps: -1,
  liveDownMbps: -1,
  liveUpMbps: -1,
  appMbps: 0,
  label: "…",
  source: "navigator",
  detail: "not checked yet",
  machineDetail: "",
  at: 0,
};

function navigatorDownlink(): number {
  const conn = (
    globalThis.navigator as unknown as { connection?: { downlink?: number } } | undefined
  )?.connection;
  return typeof conn?.downlink === "number" ? conn.downlink : -1;
}

const rate = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}`;

function label(sample: Omit<NetworkSample, "label">): string {
  if (!sample.online) return "offline";
  // What FRIDAY is actually moving right now wins the compact slot: that is the
  // number the owner asked to see live, not a periodic capacity probe.
  if (sample.appMbps > 0.05) return `↕ ${rate(sample.appMbps)} Mbps`;
  if (sample.liveDownMbps >= 0 || sample.liveUpMbps >= 0) {
    const down = sample.liveDownMbps >= 0 ? sample.liveDownMbps : 0;
    const up = sample.liveUpMbps >= 0 ? sample.liveUpMbps : 0;
    if (down > 0.05 || up > 0.05) return `↓${rate(down)} ↑${rate(up)} Mbps`;
  }
  if (sample.downMbps >= 0) return `${sample.downMbps.toFixed(1)} Mbps`;
  if (sample.latencyMs >= 0) return `${Math.round(sample.latencyMs)} ms`;
  return "online";
}

class NetworkMeter {
  private listeners = new Set<() => void>();
  private state: NetworkSample = EMPTY;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  private speedTimer: ReturnType<typeof setInterval> | null = null;
  private teardown: (() => void) | null = null;
  private probing = false;
  private measuring = false;
  /** Once available, desktop reachability is the same truth model routing uses. */
  private desktopReachability = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<Omit<NetworkSample, "label">>) {
    const next = { ...this.state, ...patch, at: Date.now() };
    this.state = { ...next, label: label(next) };
    this.listeners.forEach((l) => l());
  }

  private start() {
    if (typeof window === "undefined") return;
    const wake = () => {
      void this.probeLatency();
    };
    const sleep = () => {
      if (!this.desktopReachability) {
        this.set({ online: false, source: "offline", detail: "browser reports no network" });
      }
    };
    window.addEventListener("online", wake);
    window.addEventListener("offline", sleep);
    const stopApp = this.watchOwnTraffic();
    const stopMachine = this.watchMachineThroughput();
    const stopReachability = this.watchDesktopReachability();
    // Listeners are owned by the meter and removed in stop(), so subscribing
    // and unsubscribing repeatedly never accumulates handlers.
    this.teardown = () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", sleep);
      stopApp();
      stopMachine();
      stopReachability();
    };
    void this.probeLatency();
    void this.measureSpeed();
    this.latencyTimer = setInterval(() => {
      if (!document.hidden) void this.probeLatency();
    }, LATENCY_EVERY);
    this.speedTimer = setInterval(() => {
      if (!document.hidden) void this.measureSpeed();
    }, SPEED_EVERY);
  }

  /**
   * FRIDAY's own traffic, measured — every resource this window transfers is
   * reported by the browser's resource timing, so the rate is real bytes over
   * real time. The meter's own probes are excluded so it never measures itself.
   */
  private watchOwnTraffic(): () => void {
    if (typeof PerformanceObserver === "undefined") return () => {};
    const samples: { at: number; bytes: number }[] = [];
    const mine = (name: string) =>
      name.startsWith(SPEED_URL) || LATENCY_URLS.some((url) => name.startsWith(url));
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const now = Date.now();
        for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
          const bytes = entry.transferSize || entry.encodedBodySize || 0;
          if (bytes > 0 && !mine(entry.name)) samples.push({ at: now, bytes });
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      return () => {};
    }
    const tick = setInterval(() => {
      const cutoff = Date.now() - APP_WINDOW_MS;
      while (samples.length && samples[0]!.at < cutoff) samples.shift();
      const bytes = samples.reduce((total, s) => total + s.bytes, 0);
      const mbps = (bytes * 8) / (APP_WINDOW_MS / 1000) / 1_000_000;
      if (Math.abs(mbps - this.state.appMbps) > 0.01) this.set({ appMbps: mbps });
    }, APP_TICK);
    return () => {
      clearInterval(tick);
      observer?.disconnect();
    };
  }

  /**
   * Whole-machine throughput from the OS adapter counters the main process
   * already samples — one shared sampler, no extra polling of its own.
   */
  private watchMachineThroughput(): () => void {
    const api = (
      window as unknown as {
        friday?: {
          subscribeSystemMetrics?: () => Promise<unknown>;
          unsubscribeSystemMetrics?: () => Promise<unknown>;
          onSystemMetrics?: (
            cb: (sample: {
              network?: {
                downMbps: number | null;
                upMbps: number | null;
                available?: boolean;
                reason?: string | null;
              };
            }) => void,
          ) => () => void;
        };
      }
    ).friday;
    if (!api?.onSystemMetrics) return () => {};
    const off = api.onSystemMetrics((sample) => {
      const net = sample?.network;
      if (!net) return;
      this.set({
        liveDownMbps: typeof net.downMbps === "number" ? net.downMbps : -1,
        liveUpMbps: typeof net.upMbps === "number" ? net.upMbps : -1,
        // A failed OS probe must say why, not leave the slot blank.
        machineDetail: typeof net.downMbps === "number" ? "" : (net.reason ?? ""),
      });
    });

    void api.subscribeSystemMetrics?.();
    return () => {
      off();
      void api.unsubscribeSystemMetrics?.();
    };
  }

  /**
   * The main process performs the authoritative TCP reachability check used by
   * model routing. The title strip must show that same result, not a second
   * browser-only opinion that can disagree behind a proxy or captive portal.
   */
  private watchDesktopReachability(): () => void {
    const api = (
      window as unknown as {
        friday?: {
          networkStatus?: (force?: boolean) => Promise<{
            online: boolean;
            detail?: string;
            checkedAt?: number;
          }>;
          onNetworkStatus?: (
            cb: (sample: { online: boolean; detail?: string; checkedAt?: number }) => void,
          ) => () => void;
        };
      }
    ).friday;
    if (!api?.networkStatus) return () => {};

    const apply = (sample: { online: boolean; detail?: string; checkedAt?: number }) => {
      this.desktopReachability = true;
      this.set({
        online: Boolean(sample.online),
        source: sample.online ? "desktop" : "offline",
        detail: sample.detail || (sample.online ? "internet reachable" : "no internet route"),
      });
    };
    const off = api.onNetworkStatus?.(apply) ?? (() => {});
    void api
      .networkStatus(true)
      .then(apply)
      .catch(() => undefined);
    return off;
  }

  private stop() {
    this.teardown?.();
    this.teardown = null;
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    if (this.speedTimer) clearInterval(this.speedTimer);
    this.latencyTimer = null;
    this.speedTimer = null;
  }

  /** Real reachability: a byte-level request that has to complete. */
  async probeLatency(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (!this.desktopReachability) {
          this.set({
            online: false,
            latencyMs: -1,
            downMbps: -1,
            source: "offline",
            detail: "browser reports no network",
          });
        }
        return;
      }
      for (const url of LATENCY_URLS) {
        const started = performance.now();
        try {
          const controller = new AbortController();
          const abort = setTimeout(() => controller.abort(), 6000);
          await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
            cache: "no-store",
            mode: "no-cors",
            signal: controller.signal,
          });
          clearTimeout(abort);
          this.set({
            ...(!this.desktopReachability
              ? { online: true, source: "measured" as const, detail: "internet reachable" }
              : {}),
            latencyMs: performance.now() - started,
          });
          return;
        } catch {
          /* try the next endpoint */
        }
      }
      // Nothing answered: fall back to the browser's own verdict rather than
      // claiming offline on a single blocked endpoint.
      const downlink = navigatorDownlink();
      const online = typeof navigator === "undefined" ? true : navigator.onLine;
      this.set({
        ...(!this.desktopReachability
          ? {
              online,
              source: online ? ("navigator" as const) : ("offline" as const),
              detail: online ? "browser reports online" : "browser reports no network",
            }
          : {}),
        latencyMs: -1,
        downMbps: downlink,
      });
    } finally {
      this.probing = false;
    }
  }

  /** Real throughput: download a known payload and time it. */
  async measureSpeed(): Promise<void> {
    if (this.measuring) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    this.measuring = true;
    try {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 20_000);
      const started = performance.now();
      const response = await fetch(`${SPEED_URL}${SPEED_BYTES}&t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const blob = await response.blob();
      clearTimeout(abort);
      const seconds = (performance.now() - started) / 1000;
      if (seconds > 0 && blob.size > 0) {
        this.set({
          ...(!this.desktopReachability
            ? { online: true, source: "measured" as const, detail: "internet reachable" }
            : {}),
          downMbps: (blob.size * 8) / seconds / 1_000_000,
        });
      }
    } catch {
      const downlink = navigatorDownlink();
      if (downlink >= 0) {
        this.set({
          downMbps: downlink,
          ...(!this.desktopReachability ? { source: "navigator" as const } : {}),
        });
      }
    } finally {
      this.measuring = false;
    }
  }
}

export const networkMeter = new NetworkMeter();
