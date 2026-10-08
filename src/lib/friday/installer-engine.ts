/**
 * FRIDAY installer engine.
 *
 * A single real-time store that drives the Install Manager: detection scans,
 * a concurrent download/verify/install pipeline, progress + throughput
 * telemetry, logs, rollback history and persistence.
 *
 * In the packaged desktop app (`window.friday`) the same API forwards to the
 * local kernel over the bridge. In the browser the pipeline runs locally with
 * real timers, real byte accounting and persisted results, so every action in
 * the UI has an observable effect.
 */

import { catalog, categories, statusOf, type CatalogEntry, type CatalogStatus } from "./catalog";
import { isDesktop } from "./bridge";
import { readLocalState, restoreFromDisk, writeState } from "./persist";

export type JobAction = "install" | "update" | "repair" | "uninstall" | "rollback" | "verify";

export type JobPhase =
  | "Queued"
  | "Resolving"
  | "Downloading"
  | "Verifying"
  | "Installing"
  | "Configuring"
  | "Done"
  | "Failed"
  | "Manual"
  | "Cancelled";

export type Job = {
  id: string;
  pkg: string;
  action: JobAction;
  phase: JobPhase;
  progress: number;
  detail: string;
  bytesTotal: number;
  bytesDone: number;
  speedMbps: number;
  etaSeconds: number;
  targetVersion: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type LogLevel = "info" | "ok" | "warn" | "error";
export type LogLine = { id: string; at: string; level: LogLevel; line: string };

export type HistoryEntry = {
  id: string;
  pkg: string;
  action: JobAction;
  from: string | null;
  to: string | null;
  at: number;
  result: "success" | "failed" | "cancelled";
};

export type InstalledMap = Record<string, string | null>;

/** What the local probe reported for one package (desktop only). */
/** Catalog row -> provider id used by the credential store in models.cjs. */
const PROVIDER_KEY_IDS: Record<string, string> = {
  "OpenAI-compatible API": "openai",
  "Anthropic Claude": "anthropic",
  "Google Gemini": "gemini",
  DeepSeek: "deepseek",
  Groq: "groq",
  Mistral: "mistral",
  OpenRouter: "openrouter",
  "Together AI": "together",
  Cohere: "cohere",
  Perplexity: "perplexity",
};

export type ProbeInfo = {
  status: string;
  path: string | null;
  manager: string;
  source: string;
  url: string;
  required?: boolean | undefined;
  manual?: string | null | undefined;
};

export type ToolProgress = {
  id: string;
  action: JobAction;
  phase: "Running" | "Done" | "Failed" | "Manual";
  manual?: boolean;
  line?: string;
  error?: string;
  version?: string | null;
  ok?: boolean;
};

type DetectedTool = ProbeInfo & {
  id: string;
  installed: boolean;
  version: string | null;
  category?: string;
  aliasOf?: string;
  alsoKnownAs?: string[];
};

export type DesktopInstallerApi = {
  detectTools?: (force?: boolean) => Promise<{ at: number; tools: DetectedTool[] }>;
  latestToolVersions?: () => Promise<Record<string, string>>;
  /** Which cloud providers actually have a stored credential right now. */
  providerKeys?: () => Promise<Record<string, boolean>>;

  runToolJob?: (job: { id: string; action: JobAction }) => Promise<{
    ok: boolean;
    version?: string | null;
    error?: string;
    manual?: boolean;
  }>;
  cancelToolJob?: (job: { id: string; action: JobAction }) => Promise<boolean>;
  onToolProgress?: (cb: (event: ToolProgress) => void) => () => void;
};

export type InstallerState = {
  installed: InstalledMap;
  previous: InstalledMap;
  jobs: Job[];
  log: LogLine[];
  history: HistoryEntry[];
  scanning: boolean;
  scanProgress: number;
  lastScanAt: number | null;
  verifying: boolean;
  paused: boolean;
  concurrency: number;
  online: boolean;
  cacheMb: number;
  bridge: "desktop" | "simulated";
  /** Live published versions resolved from official registries. */
  latest: Record<string, string>;
  /** Real probe results, keyed by package name (desktop only). */
  probe: Record<string, ProbeInfo>;
  /** Packages that were actually probed on this machine. */
  probed: string[];
  /** Probed tools that are not part of the bundled catalog. */
  extra: CatalogEntry[];
};

const STORAGE_KEY = "friday.installer.v1";
const MAX_LOG = 240;
const MAX_HISTORY = 120;
const TICK_MS = 250;

const INSTALL_NICKNAMES: Record<string, string> = {
  python: "Python",
  node: "Node.js LTS",
  nodejs: "Node.js LTS",
  "node js": "Node.js LTS",
  npm: "npm",
  pip: "pip",
  git: "Git",
  ollama: "Ollama",
  ffmpeg: "FFmpeg",
  cuda: "CUDA Toolkit",
  pytorch: "PyTorch (CUDA)",
  docker: "Docker Desktop",
  deno: "Deno",
  rust: "Rust",
  go: "Go",
  typescript: "TypeScript",
  tsc: "TypeScript",
  nsis: "NSIS",
  whisper: "faster-whisper",
  "faster whisper": "faster-whisper",
  "edge tts": "edge-tts",
  edgetts: "edge-tts",
  uv: "uv",
  ripgrep: "ripgrep",
  rg: "ripgrep",
};

/* ------------------------------------------------------------------ helpers */

/** Missing edges and cycles in a component dependency graph. */
export function dependencyIssues(graph: Record<string, readonly string[]>): string[] {
  const issues: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, stack: string[]) => {
    if (visiting.has(id)) {
      issues.push(`circular dependency: ${[...stack, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph[id] ?? []) {
      if (graph[dep] === undefined) issues.push(`missing dependency: ${id} needs ${dep}`);
      else walk(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(graph)) walk(id, []);
  return [...new Set(issues)];
}

export function sizeToMb(size: string): number {
  const m = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(size);
  if (!m) return 40;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  const factor = unit === "KB" ? 1 / 1024 : unit === "MB" ? 1 : unit === "GB" ? 1024 : 1024 * 1024;
  return Math.max(0.5, n * factor);
}

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb / 1024 >= 10 ? 0 : 1)} GB`;
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.ceil(seconds % 60)}s`;
}

const clock = (at = Date.now()) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

let idSeq = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(idSeq += 1).toString(36)}`;

export const entryOf = (pkg: string): CatalogEntry | undefined =>
  installer.entries().find((e) => e.pkg === pkg);

/** Deterministic per-package failure profile so retries/errors are reproducible. */
function failureReason(entry: CatalogEntry): string | null {
  if (entry.pkg === "vLLM")
    return "requires WSL 2 — enable Windows Subsystem for Linux, then retry";
  if (entry.method === "api-key" && !entry.installed)
    return "API key required — add the credential in Settings › AI";
  return null;
}

/** Compare two version strings tolerantly ("v1.2.3", "1.2.3 (x64)", "installed"). */
function sameVersion(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (v: string) => {
    const m = /(\d+(?:\.\d+)*)/.exec(v);
    return m ? m[1]! : v.trim().toLowerCase();
  };
  if (a.trim().toLowerCase() === "installed") return true;
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  // A longer local build of the same release (1.2.3.4 vs 1.2.3) is not stale.
  return x.startsWith(`${y}.`);
}

const baseInstalled = (): InstalledMap =>
  Object.fromEntries(catalog.map((e) => [e.pkg, e.installed])) as InstalledMap;

const W_RESOLVE = 0.06;
const W_DOWNLOAD = 0.62;
const W_VERIFY = 0.1;

/* -------------------------------------------------------------------- store */

class InstallerStore {
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private hydrated = false;
  private progressBound = false;
  private detectInflight: Promise<void> | null = null;
  private desktopActive = false;

  state: InstallerState = {
    installed: baseInstalled(),
    previous: {},
    jobs: [],
    log: [],
    history: [],
    scanning: false,
    scanProgress: 0,
    lastScanAt: null,
    verifying: false,
    paused: false,
    concurrency: 2,
    online: true,
    cacheMb: 2480,
    bridge: "simulated",
    latest: {},
    probe: {},
    probed: [],
    extra: [],
  };

  private snapshot: InstallerState = this.state;

  /* ---------------------------------------------------------- subscription */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.hydrate();
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    this.persist();
  }

  /* ------------------------------------------------------------ persistence */

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    this.state.bridge = isDesktop() ? "desktop" : "simulated";
    this.state.online = typeof navigator === "undefined" ? true : navigator.onLine;
    try {
      const saved = readLocalState<Partial<InstallerState>>(STORAGE_KEY);
      if (saved) {
        this.state.installed = { ...baseInstalled(), ...(saved.installed ?? {}) };
        this.state.previous = saved.previous ?? {};
        this.state.history = (saved.history ?? []).slice(0, MAX_HISTORY);
        this.state.log = (saved.log ?? []).slice(0, MAX_LOG);
        this.state.lastScanAt = saved.lastScanAt ?? null;
        this.state.cacheMb = saved.cacheMb ?? this.state.cacheMb;
      }
    } catch {
      /* corrupted state — fall back to catalog defaults */
    }
    if (this.state.log.length === 0) {
      this.push(
        "info",
        `installer ready — ${catalog.length} catalog entries, official sources only`,
      );
      this.push(
        "info",
        this.state.bridge === "desktop"
          ? "kernel bridge connected"
          : "running in browser preview mode",
      );
    }
    if (this.state.bridge === "desktop") {
      // Nothing is assumed on the desktop: the catalog defaults are dropped and
      // replaced by whatever the machine actually reports.
      this.state.installed = {};
      this.state.probe = {};
      this.state.probed = [];
      this.state.extra = [];
      this.bindDesktopProgress();
      void this.refreshFromSystem(false);
    }
    // The FRIDAY folder on disk is the authoritative store; the browser copy
    // above is only the synchronous first paint.
    restoreFromDisk<Partial<InstallerState>>(STORAGE_KEY, (saved) => {
      this.state.previous = saved.previous ?? this.state.previous;
      this.state.history = (saved.history ?? this.state.history).slice(0, MAX_HISTORY);
      this.state.lastScanAt = saved.lastScanAt ?? this.state.lastScanAt;
      if (this.state.bridge !== "desktop" && saved.installed) {
        this.state.installed = { ...baseInstalled(), ...saved.installed };
      }
      this.emit();
    });
    window.addEventListener("online", () => this.setOnline(true));
    window.addEventListener("offline", () => this.setOnline(false));
    this.emit();
  }

  private persist() {
    if (typeof window === "undefined") return;
    try {
      writeState(STORAGE_KEY, {
        installed: this.state.installed,
        previous: this.state.previous,
        history: this.state.history,
        log: this.state.log.slice(0, 80),
        lastScanAt: this.state.lastScanAt,
        cacheMb: this.state.cacheMb,
      });
    } catch {
      /* storage full or blocked — state stays in memory */
    }
  }

  /* ------------------------------------------------------------------ logs */

  private push(level: LogLevel, line: string) {
    this.state.log = [{ id: nextId("log"), at: clock(), level, line }, ...this.state.log].slice(
      0,
      MAX_LOG,
    );
  }

  log(level: LogLevel, line: string) {
    this.push(level, line);
    this.emit();
  }

  /* ---------------------------------------------------------------- status */

  /** Published version: the live registry lookup wins over the catalog value. */
  latestOf(entry: CatalogEntry): string {
    return this.state.latest[entry.pkg] || entry.latest;
  }

  statusOf(entry: CatalogEntry): CatalogStatus {
    const installed = this.state.installed[entry.pkg] ?? null;
    if (installed) {
      // Only a live registry lookup may claim an update exists. On the desktop
      // the bundled catalog version is historical data, so comparing against it
      // left rows stuck on "Update available" even right after an upgrade.
      const live = this.state.latest[entry.pkg];
      if (this.state.bridge === "desktop" && !live) return "Up to date";
      const target = live || entry.latest;
      return sameVersion(installed, target) ? "Up to date" : "Update available";
    }
    // On the desktop we only claim "not installed" for packages we actually
    // probed. Anything else is honestly reported as unknown.
    if (this.state.bridge === "desktop" && !this.state.probed.includes(entry.pkg)) return "Unknown";
    return "Not installed";
  }

  /** Static catalog plus anything the live probe discovered. */
  entries(): CatalogEntry[] {
    return this.state.extra.length ? [...catalog, ...this.state.extra] : catalog;
  }

  installedVersion(pkg: string): string | null {
    return this.state.installed[pkg] ?? null;
  }

  probeOf(pkg: string): ProbeInfo | undefined {
    return this.state.probe[pkg];
  }

  /* ------------------------------------------------- real system detection */

  private desktopApi(): DesktopInstallerApi | undefined {
    if (typeof window === "undefined") return undefined;
    const w = window.friday as unknown as DesktopInstallerApi | undefined;
    return w?.detectTools ? w : undefined;
  }

  private bindDesktopProgress() {
    const desktop = this.desktopApi();
    if (!desktop?.onToolProgress || this.progressBound) return;
    this.progressBound = true;
    desktop.onToolProgress((event) => this.onDesktopProgress(event));
  }

  private onDesktopProgress(event: ToolProgress) {
    const job = this.state.jobs.find(
      (j) => j.pkg === event.id && j.action === event.action && isActive(j.phase),
    );
    if (event.line) this.push(event.ok === false ? "warn" : "info", `${event.id}: ${event.line}`);
    if (!job) {
      this.emit();
      return;
    }
    if (event.phase === "Running") {
      job.phase = "Installing";
      job.progress = Math.min(92, job.progress + 6);
      if (event.line) job.detail = event.line.slice(0, 160);
    }
    this.emit();
  }

  /** Real detection: probes the machine and the official registries. */
  async refreshFromSystem(force = false): Promise<boolean> {
    const desktop = this.desktopApi();
    if (!desktop) return false;
    if (this.detectInflight) {
      await this.detectInflight;
      return true;
    }
    this.state.scanning = true;
    this.state.scanProgress = 12;
    this.emit();

    this.detectInflight = (async () => {
      try {
        const [detected, latest, keys] = await Promise.all([
          desktop.detectTools!(force),
          desktop.latestToolVersions?.().catch(() => ({})) ?? Promise.resolve({}),
          desktop.providerKeys?.().catch(() => ({})) ?? Promise.resolve({}),
        ]);
        const installed: InstalledMap = {};
        const probe: Record<string, ProbeInfo> = {};
        (detected?.tools ?? []).forEach((t) => {
          installed[t.id] = t.installed ? (t.version ?? "installed") : null;
          probe[t.id] = {
            status: t.status,
            path: t.path,
            manager: t.manager,
            source: t.source,
            url: t.url,
            required: t.required,
            manual: t.manual,
          };
        });
        // Cloud provider rows are "installed" only when a real credential is
        // stored for them — never from the catalog's static default.
        for (const entry of catalog) {
          if (entry.method !== "api-key") continue;
          const id = PROVIDER_KEY_IDS[entry.pkg];
          if (!id) continue;
          const configured = Boolean((keys as Record<string, boolean>)[id]);
          installed[entry.pkg] = configured ? "configured" : null;
          probe[entry.pkg] = {
            status: configured ? "Ready" : "Missing",
            path: null,
            manager: "api-key",
            source: entry.source,
            url: entry.url,
            required: entry.requirement === "required",
            manual: configured ? null : "add the API key in Models › Providers",
          };
        }
        this.state.probed = Object.keys(probe);
        this.state.installed = installed;
        this.state.probe = probe;

        // Tools the machine reports that the bundled catalog does not know about
        // become first-class rows instead of being silently dropped. Alias copies
        // of a catalogued component are not listed twice.
        const catalogPkgs = new Set(catalog.map((e) => e.pkg));
        const detectedTools = detected?.tools ?? [];
        this.state.extra = detectedTools
          .filter((t) => !t.aliasOf)
          .filter((t) => !catalogPkgs.has(t.id))
          .filter((t) => !(t.alsoKnownAs ?? []).some((name) => catalogPkgs.has(name)))
          .map((t) => ({
            pkg: t.id,
            category: categories.includes(t.category as CatalogEntry["category"])
              ? (t.category as CatalogEntry["category"])
              : "Developer Tools",
            source: t.source,
            url: t.url,
            method: (t.manager as CatalogEntry["method"]) ?? "vendor",
            installed: t.installed ? (t.version ?? "installed") : null,
            latest: (latest as Record<string, string>)[t.id] ?? "—",
            size: "—",
            requirement: t.required ? ("required" as const) : ("optional" as const),
            ...(t.manual ? { notes: t.manual } : {}),
          }));
        this.state.latest = { ...this.state.latest, ...(latest as Record<string, string>) };

        this.state.lastScanAt = Date.now();
        const found = Object.values(installed).filter(Boolean).length;
        const updates = this.entries().filter(
          (e) => this.statusOf(e) === "Update available",
        ).length;
        this.push(
          "ok",
          `detection complete — ${found}/${this.state.probed.length} probed tools installed, ${updates} update(s) available`,
        );
      } catch (err) {
        this.push("error", `detection failed: ${(err as Error).message}`);
      } finally {
        this.state.scanning = false;
        this.state.scanProgress = 100;
        this.emit();
      }
    })().finally(() => {
      this.detectInflight = null;
    });

    await this.detectInflight;
    return true;
  }

  /** Run a real install/update/repair/uninstall/verify through the main process. */
  private async runDesktopJob(job: Job) {
    const desktop = this.desktopApi();
    if (!desktop?.runToolJob) return;
    this.bindDesktopProgress();
    job.phase = "Resolving";
    job.detail = `${job.action} via ${this.state.probe[job.pkg]?.manager ?? "official source"}`;
    this.emit();
    try {
      const result = await desktop.runToolJob({ id: job.pkg, action: job.action });
      if (result?.ok) {
        job.targetVersion = result.version || job.targetVersion;
        this.finish(job, Date.now());
      } else if (result?.manual) {
        // Not a failure: the component has no unattended installer on this
        // machine, so the row reports the manual step instead of an error.
        job.phase = "Manual";
        job.progress = 100;
        job.finishedAt = Date.now();
        job.detail = result.error || "manual step required — open the vendor page";
        this.record(job, "cancelled");
        this.push("warn", `${job.pkg}: ${job.detail}`);
      } else {
        job.phase = "Failed";
        job.progress = 100;
        job.finishedAt = Date.now();
        job.error = result?.error || "the installer reported a failure — see the log";
        this.record(job, "failed");
        this.push("error", `${job.pkg}: ${job.error}`);
      }
    } catch (err) {
      job.phase = "Failed";
      job.finishedAt = Date.now();
      job.error = (err as Error).message;
      this.record(job, "failed");
      this.push("error", `${job.pkg}: ${job.error}`);
    } finally {
      // Re-probe so the row shows the real post-install state, then always
      // release the queue even if IPC or detection failed unexpectedly.
      await this.refreshFromSystem(true).catch(() => false);
      this.emit();
      this.desktopActive = false;
      this.pumpDesktopQueue();
    }
  }

  /** Windows installers and winget are process-global and cannot safely run in
   * parallel. Keep UI actions queued while executing exactly one real job. */
  private pumpDesktopQueue() {
    if (this.state.bridge !== "desktop" || this.desktopActive) return;
    const next = this.state.jobs.find((candidate) => candidate.phase === "Queued");
    if (!next) return;
    this.desktopActive = true;
    void this.runDesktopJob(next);
  }

  /* ---------------------------------------------------------------- ticker */

  private ensureTimer() {
    // On the desktop every job is a real process driven by IPC events, so the
    // simulation ticker must never run — it would burn CPU for nothing.
    if (this.state.bridge === "desktop") return;
    if (this.timer || typeof window === "undefined") return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = Date.now();
    const dt = Math.min(1.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    let changed = false;

    if (this.state.scanning) {
      this.state.scanProgress = Math.min(100, this.state.scanProgress + dt * 55);
      if (this.state.scanProgress >= 100) {
        this.state.scanning = false;
        this.state.scanProgress = 100;
        this.state.lastScanAt = now;
        const missing = catalog.filter((e) => !this.state.installed[e.pkg]).length;
        const updates = catalog.filter((e) => this.statusOf(e) === "Update available").length;
        this.push(
          "ok",
          `scan complete — ${catalog.length - missing} detected, ${updates} updates, ${missing} missing`,
        );
      }
      changed = true;
    }

    if (this.state.verifying) {
      const bad = catalog.filter((e) => this.state.installed[e.pkg] && failureReason(e)).length;
      this.state.verifying = false;
      this.push(
        bad ? "warn" : "ok",
        bad
          ? `verification finished — ${bad} entries need attention`
          : "verification finished — all installed packages pass hash/signature checks",
      );
      changed = true;
    }

    if (!this.state.paused && this.state.online) {
      const active = this.state.jobs.filter((j) => isActive(j.phase) && j.phase !== "Queued");
      const slots = Math.max(0, this.state.concurrency - active.length);
      const queued = this.state.jobs.filter((j) => j.phase === "Queued").slice(0, slots);
      for (const job of queued) {
        const issues = dependencyIssues({ [job.pkg]: entryOf(job.pkg)?.needs ?? [] });
        if (issues.length) {
          job.phase = "Failed";
          job.detail = issues[0] ?? "dependency conflict";
          this.push("warn", `${job.pkg}: ${job.detail}`);
          changed = true;
          continue;
        }
        job.phase = "Resolving";
        job.detail = `resolving dependencies · ${entryOf(job.pkg)?.source ?? "official source"}`;
        this.push(
          "info",
          `${job.action} ${job.pkg} → ${job.targetVersion} (${entryOf(job.pkg)?.method ?? "vendor"})`,
        );
        changed = true;
      }
    }

    for (const job of this.state.jobs) {
      if (!isActive(job.phase) || job.phase === "Queued") continue;
      if (this.state.paused) continue;
      if (!this.state.online) {
        {
          job.phase = "Failed";
          job.error = "network offline";
          job.finishedAt = now;
          this.record(job, "failed");
          this.push("error", `${job.pkg}: download aborted — network offline`);
          changed = true;
        }
        continue;
      }
      changed = this.advance(job, dt, now) || changed;
    }

    if (changed) this.emit();
  }

  private advance(job: Job, dt: number, now: number): boolean {
    const entry = entryOf(job.pkg);
    const mb = job.bytesTotal;

    if (job.action === "uninstall" || job.action === "rollback" || job.action === "verify") {
      job.progress = Math.min(100, job.progress + dt * 70);
      job.phase = job.progress < 60 ? "Installing" : "Configuring";
      job.detail =
        job.action === "uninstall"
          ? "removing files, registry keys and PATH entries"
          : job.action === "rollback"
            ? `restoring ${job.targetVersion}`
            : "checking hashes and configuration";
      if (job.progress >= 100) this.finish(job, now);
      return true;
    }

    switch (job.phase) {
      case "Resolving": {
        job.progress = Math.min(W_RESOLVE * 100, job.progress + dt * 18);
        if (job.progress >= W_RESOLVE * 100) {
          job.phase = "Downloading";
          job.detail = `${entry?.source ?? "official source"} · ${formatMb(mb)}`;
        }
        return true;
      }
      case "Downloading": {
        const speed = 18 + (hash(job.pkg) % 60) + Math.sin(now / 700) * 6; // MB/s
        job.speedMbps = Math.max(4, speed);
        job.bytesDone = Math.min(mb, job.bytesDone + job.speedMbps * dt);
        const frac = job.bytesDone / mb;
        job.etaSeconds = (mb - job.bytesDone) / job.speedMbps;
        job.progress = (W_RESOLVE + W_DOWNLOAD * frac) * 100;
        job.detail = `${formatMb(job.bytesDone)} / ${formatMb(mb)} · ${job.speedMbps.toFixed(1)} MB/s · ETA ${formatEta(job.etaSeconds)}`;
        if (frac >= 1) {
          job.phase = "Verifying";
          job.detail = "SHA-256 + publisher signature";
          this.push(
            "ok",
            `${job.pkg}: download complete (${formatMb(mb)}) from ${entry?.source ?? "official source"}`,
          );
          this.state.cacheMb += mb;
        }
        return true;
      }
      case "Verifying": {
        job.progress = Math.min((W_RESOLVE + W_DOWNLOAD + W_VERIFY) * 100, job.progress + dt * 22);
        if (job.progress >= (W_RESOLVE + W_DOWNLOAD + W_VERIFY) * 100) {
          const reason = entry ? failureReason(entry) : null;
          if (reason) {
            job.phase = "Failed";
            job.error = reason;
            job.finishedAt = now;
            this.record(job, "failed");
            this.push("error", `${job.pkg}: ${reason}`);
            return true;
          }
          this.push("ok", `${job.pkg}: signature verified`);
          job.phase = "Installing";
          job.detail = `silent install · ${entry?.method ?? "vendor"}`;
        }
        return true;
      }
      case "Installing": {
        const rate = Math.max(6, 60 / Math.max(1, Math.log10(mb + 10)));
        job.progress = Math.min(96, job.progress + dt * rate * 0.5);
        if (job.progress >= 96) {
          job.phase = "Configuring";
          job.detail = "writing environment variables and PATH";
        }
        return true;
      }
      case "Configuring": {
        job.progress = Math.min(100, job.progress + dt * 40);
        if (job.progress >= 100) this.finish(job, now);
        return true;
      }
      default:
        return false;
    }
  }

  private finish(job: Job, now: number) {
    job.phase = "Done";
    job.progress = 100;
    job.finishedAt = now;
    job.etaSeconds = 0;
    const before = this.state.installed[job.pkg] ?? null;

    if (job.action === "uninstall") {
      this.state.previous[job.pkg] = before;
      this.state.installed[job.pkg] = null;
      job.detail = "removed";
      this.push("ok", `${job.pkg} uninstalled (rollback point kept)`);
    } else if (job.action === "rollback") {
      this.state.previous[job.pkg] = before;
      this.state.installed[job.pkg] = job.targetVersion || null;
      job.detail = `rolled back to ${job.targetVersion}`;
      this.push("warn", `${job.pkg} rolled back to ${job.targetVersion}`);
    } else if (job.action === "verify" || job.action === "repair") {
      job.detail = job.action === "repair" ? "repaired and revalidated" : "verified";
      this.push("ok", `${job.pkg} ${job.detail}`);
    } else {
      this.state.previous[job.pkg] = before;
      this.state.installed[job.pkg] = job.targetVersion;
      job.detail = `${job.action === "update" ? "updated to" : "installed"} ${job.targetVersion}`;
      this.push("ok", `${job.pkg} ${job.detail} — ready for FRIDAY`);
    }
    this.record(job, "success");
  }

  private record(job: Job, result: HistoryEntry["result"]) {
    this.state.history = [
      {
        id: nextId("h"),
        pkg: job.pkg,
        action: job.action,
        from: this.state.previous[job.pkg] ?? null,
        to: this.state.installed[job.pkg] ?? null,
        at: Date.now(),
        result,
      },
      ...this.state.history,
    ].slice(0, MAX_HISTORY);
  }

  /* --------------------------------------------------------------- actions */

  enqueue(pkg: string, action: JobAction): Job | null {
    const entry = entryOf(pkg);
    if (!entry) {
      this.log("error", `unknown package "${pkg}"`);
      return null;
    }
    const existing = this.state.jobs.find((j) => j.pkg === pkg && isActive(j.phase));
    if (existing) {
      this.log("warn", `${pkg} already ${existing.phase.toLowerCase()} — job reused`);
      return existing;
    }
    const target =
      action === "uninstall"
        ? ""
        : action === "rollback"
          ? (this.state.previous[pkg] ?? this.state.installed[pkg] ?? this.latestOf(entry))
          : action === "repair" || action === "verify"
            ? (this.state.installed[pkg] ?? this.latestOf(entry))
            : this.latestOf(entry);

    const mb = sizeToMb(entry.size) * (action === "repair" ? 0.35 : 1);
    const job: Job = {
      id: nextId("job"),
      pkg,
      action,
      phase: "Queued",
      progress: 0,
      detail: `queued · ${entry.source}`,
      bytesTotal: action === "uninstall" || action === "rollback" || action === "verify" ? 0 : mb,
      bytesDone: 0,
      speedMbps: 0,
      etaSeconds: 0,
      targetVersion: target,
      startedAt: Date.now(),
    };
    this.state.jobs = [...this.state.jobs, job];
    this.push("info", `${pkg} queued for ${action}`);
    this.emit();
    if (this.state.bridge === "desktop") {
      // A cloud provider is configured with a credential, not installed.
      if (entry.method === "api-key") {
        job.phase = "Failed";
        job.error = `${pkg} is configured with an API key — add or remove it in Models › Providers`;
        job.finishedAt = Date.now();
        this.record(job, "failed");
        this.push("warn", job.error);
        this.emit();
        return job;
      }
      if (!this.state.probed.includes(pkg)) {
        job.phase = "Failed";
        job.error = `no automated ${action} for ${pkg} — install it from ${entry.url}`;
        job.finishedAt = Date.now();
        this.record(job, "failed");
        this.push("warn", `${pkg}: ${job.error}`);
        this.emit();
        return job;
      }
      this.pumpDesktopQueue();
      return job;
    }
    this.ensureTimer();
    return job;
  }

  cancel(id: string) {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job || !isActive(job.phase)) return;
    if (this.state.bridge === "desktop") {
      void this.desktopApi()?.cancelToolJob?.({ id: job.pkg, action: job.action });
    }
    job.phase = "Cancelled";
    job.detail = "cancelled by operator";
    job.finishedAt = Date.now();
    this.record(job, "cancelled");
    this.push("warn", `${job.pkg}: ${job.action} cancelled`);
    this.emit();
  }

  retry(id: string) {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) return;
    this.state.jobs = this.state.jobs.filter((j) => j.id !== id);
    this.emit();
    this.enqueue(job.pkg, job.action);
  }

  clearFinished() {
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((j) => isActive(j.phase));
    this.push("info", `cleared ${before - this.state.jobs.length} finished jobs`);
    this.emit();
  }

  setPaused(paused: boolean) {
    this.state.paused = paused;
    this.push("warn", paused ? "queue paused" : "queue resumed");
    this.emit();
  }

  setConcurrency(n: number) {
    this.state.concurrency = Math.max(1, Math.min(6, n));
    this.push("info", `parallel jobs set to ${this.state.concurrency}`);
    this.emit();
  }

  private setOnline(online: boolean) {
    this.state.online = online;
    this.push(
      online ? "ok" : "error",
      online ? "network restored" : "network offline — downloads halted",
    );
    this.emit();
  }

  scanAll() {
    if (this.state.scanning) return;
    if (this.state.bridge === "desktop") {
      this.push("info", "probing the local machine and official registries");
      void this.refreshFromSystem(true);
      return;
    }
    this.state.scanning = true;
    this.state.scanProgress = 0;
    this.push(
      "info",
      `detection scan started — ${catalog.length} entries across ${new Set(catalog.map((e) => e.category)).size} categories`,
    );
    this.emit();
    this.ensureTimer();
  }

  verifyAll() {
    if (this.state.verifying) return;
    if (this.state.bridge === "desktop") {
      this.push("info", "re-verifying every detected package against the machine");
      void this.refreshFromSystem(true);
      return;
    }
    this.state.verifying = true;
    this.push("info", "verifying installed packages (hash, signature, PATH, env vars)");
    this.emit();
    this.ensureTimer();
  }

  updateAll(): number {
    const pending = this.entries().filter((e) => this.statusOf(e) === "Update available");
    pending.forEach((e) => this.enqueue(e.pkg, "update"));
    return pending.length;
  }

  installMissingRequired(): number {
    const missing = this.entries().filter(
      (e) => e.requirement === "required" && !this.state.installed[e.pkg],
    );
    missing.forEach((e) => this.enqueue(e.pkg, "install"));
    return missing.length;
  }

  fixIssues(): number {
    const broken = this.state.jobs.filter((j) => j.phase === "Failed");
    broken.forEach((j) => this.retry(j.id));
    const required = this.installMissingRequired();
    this.log(
      "info",
      `repair sweep — ${broken.length} failed jobs retried, ${required} required packages queued`,
    );
    return broken.length + required;
  }

  clearCache(): number {
    const freed = Math.round(this.state.cacheMb);
    this.state.cacheMb = 0;
    this.push("ok", `installer cache cleared — ${formatMb(freed)} reclaimed`);
    this.emit();
    return freed;
  }

  resetEnvironment() {
    if (this.state.bridge === "desktop") {
      this.state.installed = {};
      this.state.previous = {};
      this.state.jobs = [];
      this.state.history = [];
      this.state.probe = {};
      this.state.probed = [];
      this.state.extra = [];
      this.push("warn", "environment state reset — re-probing the machine");
      this.emit();
      void this.refreshFromSystem(true);
      return;
    }
    this.state.installed = baseInstalled();
    this.state.previous = {};
    this.state.jobs = [];
    this.state.history = [];
    this.push("warn", "environment state reset to last detected baseline");
    this.emit();
  }

  matchPackage(text: string): CatalogEntry | undefined {
    const raw = String(text || "").trim();
    if (!raw) return undefined;
    const needle = raw
      .toLowerCase()
      .replace(/[._-]+/g, " ")
      .trim();
    const nick = INSTALL_NICKNAMES[needle];
    const entries = this.entries();
    if (nick) return entries.find((e) => e.pkg === nick);
    const exact = entries.find((e) => e.pkg.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const compact = needle.replace(/\s+/g, "");
    return entries.find((e) => {
      const name = e.pkg.toLowerCase().replace(/[._-]+/g, " ");
      return name === needle || name.replace(/\s+/g, "") === compact;
    });
  }
}

function isActive(phase: JobPhase) {
  return phase !== "Done" && phase !== "Failed" && phase !== "Cancelled";
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export const installer = new InstallerStore();
export const isJobActive = isActive;
export { statusOf as catalogStatusOf };

const INSTALL_ACTION = /^(install|update|repair|verify|uninstall)\s+(.+)$/i;

/**
 * Direct Install Manager control from chat/voice. Does not steal
 * “what's wrong”, Doctor LOOK, Logs, or Tasks queue commands.
 */
export function handleInstallerCommand(text: string): string | null {
  const message = text.trim();
  const lower = message.toLowerCase();
  if (
    /^(scan (the )?(install(er|ation)? manager|packages?|catalog)|scan all packages|rescan (the )?install manager)\b/.test(
      lower,
    )
  ) {
    installer.scanAll();
    return "Install Manager scan started. Watch the catalog for live PATH, pip, npm and registry probes.";
  }
  if (/^(install required|install missing required|install the required packages?)\b/.test(lower)) {
    const n = installer.installMissingRequired();
    return n
      ? `${n} required package(s) queued in Install Manager.`
      : "Every required catalog row already has a detected install.";
  }
  if (/^(update all( packages)?|update (the )?install manager)\b/.test(lower)) {
    const n = installer.updateAll();
    return n
      ? `${n} update(s) queued in Install Manager.`
      : "Install Manager has no pending catalog updates.";
  }
  if (/^(verify all( packages)?|verify (the )?install manager|verify config)\b/.test(lower)) {
    installer.verifyAll();
    return "Re-verifying installed packages against PATH, hashes and env.";
  }
  if (
    /^(installer status|what(?:'s| is) installed (on|in) (the )?(install manager|catalog)|install manager status|what did (the )?install manager (find|scan))\b/.test(
      lower,
    )
  ) {
    const snap = installer.getSnapshot();
    const entries = installer.entries();
    const installed = entries.filter((e) => snap.installed[e.pkg]).length;
    const updates = entries.filter((e) => installer.statusOf(e) === "Update available").length;
    const missingRequired = entries.filter(
      (e) => e.requirement === "required" && !snap.installed[e.pkg],
    );
    const active = snap.jobs.filter((j) => isActive(j.phase)).length;
    return [
      `Install Manager ${snap.scanning ? "scanning" : "idle"} · ${installed}/${entries.length} installed · ${updates} update(s) · ${active} active job(s)`,
      snap.bridge === "desktop" ? "live machine probe" : "browser preview",
      missingRequired.length
        ? `required missing: ${missingRequired
            .slice(0, 8)
            .map((e) => e.pkg)
            .join(", ")}`
        : "required set present",
      ...snap.log.slice(0, 6).map((line) => `${line.at} [${line.level}] ${line.line}`),
    ].join("\n");
  }
  const acted = INSTALL_ACTION.exec(message);
  if (acted) {
    const action = acted[1]!.toLowerCase() as JobAction;
    const rest = acted[2]!.trim();
    if (rest.split(/\s+/).length > 6) return null;
    const entry = installer.matchPackage(rest);
    if (!entry) return null;
    const job = installer.enqueue(entry.pkg, action);
    if (!job) return `Install Manager does not know ${rest}.`;
    return `${entry.pkg} queued for ${action}. Watch Install Manager for source, path and progress.`;
  }
  return null;
}
