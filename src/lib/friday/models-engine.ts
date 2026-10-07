/**
 * FRIDAY models engine.
 *
 * A single real-time store behind the Models Manager: hardware probe + support
 * checks, provider detection, a download/install pipeline with byte accounting,
 * load/unload with live VRAM + tokens/sec telemetry, benchmarking, routing
 * assignment, cloud key connection and manual model import.
 *
 * In the packaged desktop app the same API forwards to the local kernel over
 * the bridge; in the browser it runs locally on real timers with persisted
 * state so every control has an observable effect.
 */

import { isDesktop } from "./bridge";
import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { desktopApi, type ModelPullProgress, type OnlineModel } from "./desktop";
import {
  checkSupport,
  modelById,
  modelByTag,
  registryTag,
  modelCatalog,
  providerById,
  providers,
  routingTasks,
  type ModelSpec,
  type ProviderId,
  type RoutingTask,
  type SystemProfile,
} from "./model-catalog";
import { downloadSources } from "./model-sources";
import { modelIdleMs, shouldKeepModelsWarm, shouldUnloadIdleModels } from "./settings-runtime";

export type JobKind = "download" | "update" | "remove" | "benchmark" | "import";
export type JobPhase =
  | "Queued"
  | "Resolving"
  | "Downloading"
  | "Verifying"
  | "Installing"
  | "Benchmarking"
  | "Done"
  | "Failed"
  | "Cancelled";

export type Job = {
  id: string;
  modelId: string;
  kind: JobKind;
  phase: JobPhase;
  progress: number;
  detail: string;
  gbTotal: number;
  gbDone: number;
  speedMbps: number;
  etaSeconds: number;
  error?: string;
  startedAt: number;
  /** True when a real desktop operation drives this job (never the ticker). */
  remote?: boolean;
};

export type RunState = "Idle" | "Loading" | "Running" | "Unloading" | "Error";

export type Runtime = {
  modelId: string;
  state: RunState;
  loadedAt: number;
  vramGb: number;
  ramGb: number;
  cpuPct: number;
  gpuPct: number;
  tokensPerSec: number;
  latencyMs: number;
  requests: number;
  lastUsed: number;
};

export type Benchmark = {
  modelId: string;
  tokensPerSec: number;
  firstTokenMs: number;
  promptTokensPerSec: number;
  scoreQuality: number;
  peakVramGb: number;
  at: number;
};

export type ProviderState = {
  id: ProviderId;
  detected: boolean;
  online: boolean;
  endpoint: string;
  apiKey: string | null;
  models: number;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number | null;
};

export type LogLevel = "info" | "ok" | "warn" | "error";
export type LogLine = { id: string; at: string; level: LogLevel; line: string };

export type ImportedModel = {
  id: string;
  name: string;
  path: string;
  format: string;
  sizeGb: number;
  provider: ProviderId;
  at: number;
};

export type ModelsState = {
  system: SystemProfile;
  /** Models the user activated — restored automatically on every start. */
  active: string[];
  /** Newly released models found online (Hugging Face + Ollama library). */
  discovered: OnlineModel[];
  discovering: boolean;
  discoveryAt: number | null;
  discoveryError: string | null;
  probing: boolean;
  scanning: boolean;
  scanProgress: number;
  lastScanAt: number | null;
  installed: Record<string, string | null>;
  jobs: Job[];
  runtimes: Record<string, Runtime>;
  benchmarks: Record<string, Benchmark>;
  providerState: Record<string, ProviderState>;
  routing: Record<RoutingTask, string | null>;
  multiModel: string[];
  parallel: boolean;
  device: "auto" | "gpu" | "cpu";
  imported: ImportedModel[];
  log: LogLine[];
  bridge: "desktop" | "simulated";
};

const STORAGE_KEY = "friday.models.v1";
const TICK_MS = 400;
const MAX_LOG = 200;

const clock = (at = Date.now()) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

export const formatGb = (gb: number) =>
  gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(gb * 1024)} MB`;
export const formatEta = (s: number) =>
  !Number.isFinite(s) || s <= 0
    ? "—"
    : s < 60
      ? `${Math.ceil(s)}s`
      : `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
export const isJobActive = (p: JobPhase) => p !== "Done" && p !== "Failed" && p !== "Cancelled";

const defaultSystem: SystemProfile = {
  os: "unknown",
  cpu: "unknown",
  cores: 0,
  ramGb: 0,
  gpu: "not probed",
  vramGb: 0,
  cuda: null,
  diskFreeGb: 0,
  probedAt: null,
};

const baseInstalled = (): Record<string, string | null> =>
  Object.fromEntries(modelCatalog.map((m) => [m.id, m.installed ?? null]));

const baseProviders = (): Record<string, ProviderState> =>
  Object.fromEntries(
    providers.map((p) => [
      p.id,
      {
        id: p.id,
        detected: ["ollama", "llamacpp", "lmstudio"].includes(p.id),
        online: false,
        endpoint: p.endpoint,
        apiKey: null,
        models: 0,
        latencyMs: null,
        error: null,
        checkedAt: null,
      } satisfies ProviderState,
    ]),
  );

const baseRouting = (): Record<RoutingTask, string | null> => ({
  brain: "qwen2.5-32b",
  coding: "deepseek-coder-v2",
  research: null,
  reasoning: "deepseek-r1-32b",
  vision: null,
  fast: "llama3.2-3b",
  speech: "whispercpp-base",
  voice: "piper-en",
  image: null,
  embedding: "bge-m3",
  rerank: null,
});

/** Deterministic per-model failure profile so errors are reproducible. */
function failureReason(model: ModelSpec, state: ModelsState): string | null {
  if (model.kind === "cloud") {
    const ps = state.providerState[model.provider];
    if (!ps?.apiKey)
      return `API key required — connect ${providerById.get(model.provider)?.name} first`;
    return null;
  }
  if (model.provider === "vllm")
    return "vLLM needs Linux or WSL 2 with CUDA — install it from Install Manager, then retry";
  const support = checkSupport(model, state.system);
  if (support.level === "Unsupported") return support.reason;
  return null;
}

class ModelsStore {
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private hydrated = false;
  private restored = false;
  private desktopBound = false;
  private lastTick = 0;

  state: ModelsState = {
    system: { ...defaultSystem },
    probing: false,
    scanning: false,
    scanProgress: 0,
    lastScanAt: null,
    installed: baseInstalled(),
    jobs: [],
    runtimes: {},
    benchmarks: {},
    providerState: baseProviders(),
    routing: baseRouting(),
    multiModel: ["qwen2.5-32b", "deepseek-coder-v2"],
    parallel: true,
    device: "auto",
    active: [],
    discovered: [],
    discovering: false,
    discoveryAt: null,
    discoveryError: null,
    imported: [],
    log: [],
    bridge: "simulated",
  };

  private snapshot: ModelsState = this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    // Do not publish a new snapshot synchronously from React's subscription
    // commit. That can cause a production-only commit loop in Electron.
    if (!this.hydrated && typeof window !== "undefined") {
      window.setTimeout(() => this.hydrate(), 0);
    }
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stopTimer();
    };
  };

  getSnapshot = () => this.snapshot;

  private emit(persist = true) {
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    if (persist) this.persist();
  }

  /* -------------------------------------------------------------- lifecycle */

  private applySaved(saved: Partial<ModelsState>) {
    this.state.installed = { ...baseInstalled(), ...(saved.installed ?? {}) };
    this.state.routing = { ...baseRouting(), ...(saved.routing ?? {}) };
    this.state.benchmarks = saved.benchmarks ?? {};
    this.state.imported = saved.imported ?? [];
    this.state.active = saved.active ?? this.state.active;
    this.state.discovered = saved.discovered ?? [];
    this.state.discoveryAt = saved.discoveryAt ?? null;
    this.state.multiModel = saved.multiModel ?? this.state.multiModel;
    this.state.parallel = saved.parallel ?? true;
    this.state.device = saved.device ?? "auto";
    this.state.log = (saved.log ?? []).slice(0, MAX_LOG);
    if (saved.providerState) {
      for (const [id, ps] of Object.entries(saved.providerState)) {
        const current = this.state.providerState[id];
        if (current) this.state.providerState[id] = { ...current, ...ps };
      }
    }
  }

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    this.state.bridge = isDesktop() ? "desktop" : "simulated";
    const saved = readLocalState<Partial<ModelsState>>(STORAGE_KEY);
    if (saved) this.applySaved(saved);
    // Fresh install / cleared cache: recover the durable desktop copy.
    restoreFromDisk<Partial<ModelsState>>(STORAGE_KEY, (disk) => {
      this.applySaved(disk);
      this.emit(false);
    });
    // Hardware probing creates a WebGL context and can stall focus/hit-testing
    // on some Windows GPU drivers. Run it only from the Models page's explicit
    // probe control (desktop hardware detection uses the main process).
    if (this.state.log.length === 0) {
      this.push(
        "info",
        `models manager ready — ${modelCatalog.length} catalog entries across ${providers.length} providers`,
      );
      this.push(
        "info",
        this.state.bridge === "desktop"
          ? "kernel bridge connected"
          : "browser preview — pipeline simulated locally",
      );
    }
    if (this.state.bridge === "desktop") {
      this.bindDesktopEvents();
      window.setTimeout(() => {
        void this.refreshFromDesktop().then(() => {
          this.emit();
          this.restoreActive();
        });
      }, 0);
    } else {
      window.setTimeout(() => this.restoreActive(), 0);
    }
    this.emit(false);
  }

  private persist() {
    if (typeof window === "undefined") return;
    writeState(STORAGE_KEY, {
      installed: this.state.installed,
      routing: this.state.routing,
      benchmarks: this.state.benchmarks,
      imported: this.state.imported,
      active: this.state.active,
      discovered: this.state.discovered.slice(0, 60),
      discoveryAt: this.state.discoveryAt,
      multiModel: this.state.multiModel,
      parallel: this.state.parallel,
      device: this.state.device,
      providerState: this.state.providerState,
      log: this.state.log.slice(0, 60),
    });
  }

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

  /* ------------------------------------------------------- real desktop I/O */

  /**
   * Pull the real inventory from the main process: Ollama tags, local
   * OpenAI-compatible servers, cloud key validation and local model folders.
   * Everything written back into state here comes from a live service.
   */
  private async refreshFromDesktop(): Promise<boolean> {
    const api = desktopApi();
    if (!api?.modelsInventory) return false;
    let inventory;
    try {
      inventory = await api.modelsInventory();
    } catch (err) {
      this.push("error", `provider scan failed — ${String((err as Error).message ?? err)}`);
      return false;
    }
    if (!inventory) return false;

    const installedTags = new Set<string>();
    for (const provider of inventory.providers) {
      const ps = this.state.providerState[provider.id];
      if (ps) {
        ps.detected = provider.online;
        ps.online = provider.online;
        ps.latencyMs = provider.latencyMs;
        ps.error = provider.error;
        ps.models = provider.models.length;
        ps.checkedAt = inventory.at;
        if (provider.endpoint) ps.endpoint = provider.endpoint;
        if (provider.kind === "cloud" && provider.configured && !ps.apiKey) ps.apiKey = "stored";
      }
      if (provider.kind !== "local") continue;
      for (const model of provider.models) {
        installedTags.add(model.id);
        const spec = modelByTag(model.id);
        if (spec) this.state.installed[spec.id] = spec.version;
      }
    }

    // Catalog entries the daemon no longer has are genuinely not installed.
    for (const spec of modelCatalog) {
      if (spec.kind !== "local" || spec.provider !== "ollama") continue;
      const tag = registryTag(spec);
      if (!tag) continue;
      const present = [...installedTags].some(
        (t) => t === tag || t.replace(/:latest$/, "") === tag.split(":")[0],
      );
      if (!present && this.state.installed[spec.id]) this.state.installed[spec.id] = null;
    }

    // Resident models reported by /api/ps are the only real runtimes.
    const resident = new Set<string>();
    for (const running of inventory.running) {
      const spec = modelByTag(running.id);
      if (!spec) continue;
      resident.add(spec.id);
      const rt = this.state.runtimes[spec.id];
      if (rt) {
        rt.state = "Running";
        rt.vramGb = running.vramGb;
        rt.ramGb = Math.max(0, running.sizeGb - running.vramGb);
      } else {
        this.state.runtimes[spec.id] = {
          modelId: spec.id,
          state: "Running",
          loadedAt: Date.now(),
          vramGb: running.vramGb,
          ramGb: Math.max(0, running.sizeGb - running.vramGb),
          cpuPct: 0,
          gpuPct: 0,
          tokensPerSec: 0,
          latencyMs: 0,
          requests: 0,
          lastUsed: Date.now(),
        };
      }
    }
    for (const id of Object.keys(this.state.runtimes)) {
      const spec = modelById.get(id);
      if (spec?.provider === "ollama" && !resident.has(id)) delete this.state.runtimes[id];
    }

    this.state.lastScanAt = inventory.at;
    this.push(
      "ok",
      `scan complete — ${inventory.totals.providersOnline}/${inventory.providers.length} providers online, ` +
        `${inventory.totals.localModels} local model(s) present`,
    );
    void this.syncKernel();
    return true;
  }

  /**
   * Hand the freshly detected inventory to the AI kernel so Auto mode and chat
   * route to models that really answered. Never blocks the UI.
   */
  private async syncKernel() {
    const api = desktopApi();
    if (!api?.syncKernelModels) return;
    try {
      const result = await api.syncKernelModels(true);
      if (result?.ok) {
        this.push(
          "ok",
          `AI router updated — ${result.registered ?? 0} model(s) available for chat`,
        );
      } else if (result?.error) {
        this.push("warn", `AI router not updated — ${result.error}`);
      }
      this.emit();
    } catch (err) {
      this.push("warn", `AI router sync failed — ${String((err as Error).message ?? err)}`);
      this.emit();
    }
  }

  /** Live progress for a real `ollama pull`, straight from the daemon. */
  private applyPullProgress(event: ModelPullProgress) {
    const job = this.state.jobs.find((j) => j.id === event.jobId);
    if (!job) return;
    job.phase = /verif|digest/i.test(event.status)
      ? "Verifying"
      : /writing|success/i.test(event.status)
        ? "Installing"
        : /pulling/i.test(event.status)
          ? "Downloading"
          : job.phase;
    if (typeof event.gbTotal === "number" && event.gbTotal > 0) job.gbTotal = event.gbTotal;
    if (typeof event.gbDone === "number") job.gbDone = event.gbDone;
    if (typeof event.progress === "number") job.progress = event.progress;
    job.speedMbps = event.speedMbps ?? job.speedMbps;
    job.etaSeconds = event.etaSeconds ?? job.etaSeconds;
    job.detail =
      job.gbTotal > 0
        ? `${event.status} · ${formatGb(job.gbDone)} / ${formatGb(job.gbTotal)} · ${job.speedMbps} MB/s`
        : event.status;
    this.emit(false);
  }

  private bindDesktopEvents() {
    const api = desktopApi();
    if (!api || this.desktopBound) return;
    this.desktopBound = true;
    api.onModelPullProgress?.((event) => this.applyPullProgress(event));
    api.onModelPullDone?.((event) => {
      // "Downloaded" is not "working": the main process test-prompts every
      // freshly installed local model, and only a real answer earns Ready.
      const broken = event.ok && event.verified === false;
      const job = this.state.jobs.find((j) => j.id === event.jobId);
      if (job) {
        job.phase = event.ok && !broken ? "Done" : "Failed";
        job.progress = event.ok ? 100 : job.progress;
        job.detail = broken
          ? `installed but not responding — ${event.error ?? "no answer to the test prompt"}`
          : event.ok
            ? `installed and verified — ${event.model} answered the test prompt`
            : (event.error ?? "pull failed");
        if (!event.ok || broken) job.error = event.error ?? "pull failed";
      }
      this.push(
        event.ok && !broken ? "ok" : broken ? "warn" : "error",
        broken
          ? `${event.model} installed but not responding — ${event.error ?? "empty test response"}`
          : event.ok
            ? `${event.model} installed and verified`
            : `${event.model} — ${event.error}`,
      );

      void this.refreshFromDesktop().then(() => this.emit());
    });
    // A key, endpoint or access-tier change rewrites what is routable, so the
    // provider/model view refreshes from the same event the chat selector uses
    // instead of waiting for the next manual scan.
    api.onModelRegistryChanged?.(() => {
      void this.refreshFromDesktop().then(() => this.emit());
    });
    // Same for a live health change, so this page never shows a provider as
    // reachable that the chat selector has already dropped (and vice versa).
    api.onModelHealthChanged?.(() => {
      void this.refreshFromDesktop().then(() => this.emit());
    });
  }

  /* --------------------------------------------------------- system profile */

  probeSystem() {
    if (typeof window === "undefined") return;
    this.state.probing = true;
    this.emit();
    // On the desktop the machine profile comes from the real main-process
    // probes (CPU/RAM/GPU/CUDA from hardware:detect, free disk from the live
    // system metrics). The WebGL/navigator path below stays as the browser
    // preview fallback only.
    if (this.state.bridge === "desktop") {
      void this.probeSystemDesktop().catch(() => this.probeSystemBrowser());
      return;
    }
    this.probeSystemBrowser();
  }

  private async probeSystemDesktop() {
    const api = desktopApi() as
      | (ReturnType<typeof desktopApi> & {
          systemMetrics?: () => Promise<{ disks?: { freeGb: number }[] } | null>;
        })
      | null;
    const hw = await api?.detectHardware?.();
    if (!hw) throw new Error("hardware probe unavailable");
    const metrics = await api?.systemMetrics?.().catch(() => null);
    const cores = hw.cpu?.cores || 1;
    const gpu = hw.gpus?.[0] ?? null;
    const vramMb = Number(gpu?.vramTotalMb ?? 0);
    const diskFreeGb = Math.round(
      (metrics?.disks ?? []).reduce((sum, d) => sum + (Number(d.freeGb) || 0), 0),
    );
    this.state.system = {
      os: `${hw.platform} · ${cores} threads`,
      cpu: hw.cpu?.model || `${cores}-thread host CPU`,
      cores,
      ramGb: Math.round(hw.memory?.totalGb || 0),
      gpu: gpu?.name || "GPU not detected",
      vramGb: vramMb ? Math.round(vramMb / 1024) : 0,
      cuda: hw.cuda?.available ? `CUDA ${hw.cuda.version ?? "detected"}` : null,
      diskFreeGb,
      probedAt: Date.now(),
    };
    this.state.probing = false;
    this.push(
      "ok",
      `hardware probe — ${this.state.system.gpu}, ${this.state.system.vramGb} GB VRAM, ${this.state.system.ramGb} GB RAM, ${cores} threads, ${diskFreeGb} GB free disk`,
    );
    this.emit();
  }

  private probeSystemBrowser() {
    const nav = window.navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency || 0;
    const ramGb =
      typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : 0;
    let gpu = "not detected";
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const raw = dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
      if (raw) {
        gpu = raw
          .replace(/^ANGLE \(/, "")
          .replace(/\)$/, "")
          .split(",")
          .slice(0, 2)
          .join(" ·")
          .trim();
      }
    } catch {
      /* WebGL blocked — the GPU stays not detected */
    }
    const platform = navigator.platform || "unknown";
    const os = /win/i.test(platform)
      ? "Windows"
      : /mac/i.test(platform)
        ? "macOS"
        : /linux/i.test(platform)
          ? "Linux"
          : platform;
    this.state.system = {
      os: cores ? `${os} · ${cores} threads` : os,
      cpu: cores ? `${cores}-thread host CPU` : "unknown",
      cores,
      ramGb,
      gpu,
      vramGb: 0,
      cuda: null,
      diskFreeGb: 0,
      probedAt: Date.now(),
    };
    this.state.probing = false;
    this.push(
      "ok",
      `hardware probe — ${this.state.system.gpu}, VRAM unknown, ${ramGb || "unknown"} GB RAM, ${cores || "unknown"} threads`,
    );
    this.emit();
  }

  setDevice(device: ModelsState["device"]) {
    this.state.device = device;
    this.push("info", `execution device set to ${device}`);
    this.emit();
  }

  /* -------------------------------------------------------------- detection */

  scan() {
    if (this.state.scanning) return;
    this.state.scanning = true;
    this.state.scanProgress = 0;
    this.push(
      "info",
      "scanning providers — Ollama, LM Studio, llama.cpp, GGUF folders, Hugging Face cache…",
    );
    // On the desktop the scan is a real probe of every provider; the browser
    // preview keeps its local pipeline so the page stays reviewable.
    if (this.state.bridge === "desktop") {
      this.bindDesktopEvents();
      this.state.scanProgress = 12;
      this.emit();
      void this.refreshFromDesktop().finally(() => {
        this.state.scanning = false;
        this.state.scanProgress = 100;
        this.emit();
      });
      return;
    }
    this.ensureTimer();
    this.emit();
  }

  private finishScan() {
    const now = Date.now();
    for (const p of providers) {
      const ps = this.state.providerState[p.id]!;
      const count = modelCatalog.filter(
        (m) => m.provider === p.id && this.state.installed[m.id],
      ).length;
      const hasKey = Boolean(ps.apiKey);
      ps.models =
        p.kind === "cloud"
          ? hasKey
            ? modelCatalog.filter((m) => m.provider === p.id).length
            : 0
          : count;
      ps.detected =
        p.kind === "cloud"
          ? hasKey
          : count > 0 || ["ollama", "llamacpp", "lmstudio"].includes(p.id);
      ps.online = ps.detected;
      ps.latencyMs = ps.detected
        ? Math.round(6 + Math.random() * (p.kind === "cloud" ? 260 : 20))
        : null;
      ps.error = ps.detected
        ? null
        : p.kind === "cloud"
          ? "no API key connected"
          : "service not reachable on its default port";
      ps.checkedAt = now;
    }
    const detected = providers.filter((p) => this.state.providerState[p.id]!.detected).length;
    const local = modelCatalog.filter(
      (m) => m.kind === "local" && this.state.installed[m.id],
    ).length;
    this.state.lastScanAt = now;
    this.push(
      "ok",
      `scan complete — ${detected}/${providers.length} providers online, ${local} local models detected`,
    );
  }

  /* ------------------------------------------------------------- providers */

  connectProvider(id: ProviderId, apiKey: string, endpoint?: string) {
    const ps = this.state.providerState[id];
    const p = providerById.get(id);
    if (!ps || !p) return;
    ps.apiKey = apiKey.trim() || null;
    const customEndpoint = endpoint?.trim() ? endpoint.trim() : null;
    if (customEndpoint) ps.endpoint = customEndpoint;
    const bridge = desktopApi();
    if (this.state.bridge === "desktop" && bridge?.setProviderKey) {
      // The owner's endpoint has to reach the real request, so it is stored
      // before the key test runs against it.
      if (customEndpoint && bridge.setProviderEndpoint)
        void bridge.setProviderEndpoint(id, customEndpoint);
      // No invented status while the real probe is in flight.
      ps.online = false;
      ps.latencyMs = null;
      ps.error = null;
      ps.checkedAt = Date.now();
      this.push("info", `${p.name} — validating key against ${ps.endpoint}`);
      this.emit();
      void bridge
        .setProviderKey(id, ps.apiKey)
        .then(() => bridge.testModelProvider?.(id, ps.apiKey))
        .then((probe) => {
          if (!probe || !("online" in probe)) return;
          ps.online = probe.online;
          ps.detected = probe.online;
          ps.latencyMs = probe.latencyMs;
          ps.error = probe.error;
          ps.models = probe.models;
          ps.checkedAt = Date.now();
          this.push(
            probe.online ? "ok" : "error",
            `${p.name} — ${probe.online ? `key accepted · ${probe.models} model(s)` : probe.error}`,
          );
          this.emit();
        })
        .catch((err: Error) => this.log("error", `${p.name} — ${err.message}`));
      return;
    }
    // Browser preview only — the desktop path above returns before this.
    ps.detected = Boolean(ps.apiKey) || p.kind === "local";
    ps.online = ps.detected;
    ps.error = ps.detected ? null : "no API key connected";
    ps.models = ps.detected ? modelCatalog.filter((m) => m.provider === id).length : 0;
    ps.latencyMs = ps.detected ? Math.round(40 + Math.random() * 200) : null;
    ps.checkedAt = Date.now();
    this.push(
      ps.detected ? "ok" : "warn",
      `${p.name} ${ps.detected ? "connected" : "disconnected"} — ${ps.endpoint}`,
    );
    this.emit();
  }

  disconnectProvider(id: ProviderId) {
    const ps = this.state.providerState[id];
    if (!ps) return;
    if (this.state.bridge === "desktop") void desktopApi()?.setProviderKey?.(id, null);
    ps.apiKey = null;
    ps.detected = providerById.get(id)?.kind === "local" ? ps.detected : false;
    ps.online = ps.detected;
    ps.models = 0;
    ps.error = "no API key connected";
    this.push("warn", `${providerById.get(id)?.name} credentials removed`);
    this.emit();
  }

  syncKnowledge() {
    const api = desktopApi();
    if (this.state.bridge === "desktop" && api?.syncModelKnowledge) {
      this.push("info", "Knowledge sync started");
      this.emit();
      void api
        .syncModelKnowledge()
        .then((plan) => {
          const due = Array.isArray(plan?.due) ? plan.due.length : 0;
          this.push("ok", `Knowledge sync: ${due} source(s) due`);
          this.emit();
        })
        .catch((err: Error) => {
          this.push("error", `Knowledge sync failed — ${err.message}`);
          this.emit();
        });
      return;
    }
    this.push("warn", "Knowledge sync runs in the desktop app. Nothing was invented.");
    this.emit();
  }

  healProviders() {
    const api = desktopApi();
    if (this.state.bridge === "desktop" && api?.healModelProviders) {
      this.push("info", "Heal started");
      this.emit();
      void api
        .healModelProviders()
        .then((result) => {
          const disabled = Array.isArray(result?.disabled) ? result.disabled.length : 0;
          this.push("ok", `Heal finished · ${disabled} model(s) disabled`);
          this.emit();
        })
        .catch((err: Error) => {
          this.push("error", `Heal failed — ${err.message}`);
          this.emit();
        });
      return;
    }
    this.push("warn", "Heal runs in the desktop app. No model was marked dead.");
    this.emit();
  }

  previewPrompt(prompt: string): Promise<string> {
    const text = String(prompt || "").trim();
    if (!text) {
      const line = "Type a prompt before the dry run. No model was called.";
      this.push("warn", line);
      this.emit();
      return Promise.resolve(line);
    }
    const api = desktopApi();
    if (this.state.bridge === "desktop" && api?.previewModelRoute) {
      this.push("info", "Route dry run started. No model was called.");
      this.emit();
      return api
        .previewModelRoute(text)
        .then((plan) => {
          const ids = Array.isArray(plan?.candidates) ? plan.candidates.join(", ") : "";
          const line = `${plan?.task || "unknown"} · ${plan?.strategy || "unknown"} · ${plan?.why || "unknown"}${ids ? ` · ${ids}` : ""}`;
          this.push("ok", line);
          this.emit();
          return line;
        })
        .catch((err: Error) => {
          const line = `Route dry run failed — ${err.message}`;
          this.push("error", line);
          this.emit();
          return line;
        });
    }
    const line = "Route preview runs in the desktop app. No model was called.";
    this.push("warn", line);
    this.emit();
    return Promise.resolve(line);
  }

  testProvider(id: ProviderId) {
    const ps = this.state.providerState[id];
    const p = providerById.get(id);
    if (!ps || !p) return;
    const api = desktopApi();
    if (this.state.bridge === "desktop" && api?.testModelProvider) {
      this.push("info", `${p.name} health check — contacting ${ps.endpoint}`);
      this.emit();
      void api
        .testModelProvider(id, ps.apiKey === "stored" ? null : ps.apiKey)
        .then((probe) => {
          if (!("online" in probe)) return;
          ps.online = probe.online;
          ps.detected = probe.online;
          ps.latencyMs = probe.latencyMs;
          ps.error = probe.error;
          ps.models = probe.models;
          ps.checkedAt = Date.now();
          this.push(
            probe.online ? "ok" : "error",
            `${p.name} — ${probe.online ? `${probe.latencyMs} ms · ${probe.models} model(s)` : probe.error}`,
          );
          this.emit();
        })
        .catch((err: Error) => {
          ps.online = false;
          ps.error = err.message;
          this.push("error", `${p.name} health check failed — ${err.message}`);
          this.emit();
        });
      return;
    }
    const ok = p.kind === "local" ? ps.detected : Boolean(ps.apiKey);
    ps.latencyMs = ok ? Math.round(6 + Math.random() * (p.kind === "cloud" ? 260 : 20)) : null;
    ps.online = ok;
    ps.error = ok
      ? null
      : p.kind === "cloud"
        ? "no API key connected"
        : `no response from ${ps.endpoint}`;
    ps.checkedAt = Date.now();
    this.push(
      ok ? "ok" : "error",
      `${p.name} health check — ${ok ? `${ps.latencyMs} ms via ${p.detect}` : ps.error}`,
    );
    this.emit();
  }

  /** One streamed token through the same router the chat window uses. */
  testProviderChat(id: ProviderId) {
    const ps = this.state.providerState[id];
    const p = providerById.get(id);
    if (!ps || !p) return;
    const api = desktopApi();
    if (this.state.bridge === "desktop" && api?.testModelProvider) {
      this.push("info", `${p.name} test chat — one token through the router`);
      this.emit();
      void api
        .testModelProvider(id, ps.apiKey === "stored" ? null : ps.apiKey, { chat: true })
        .then((probe) => {
          if (!("category" in probe)) return;
          const mark = probe.ok ? "ok" : "error";
          const name = probe.display || probe.modelId || "no model";
          this.push(
            mark,
            `${p.name} test chat — ${name} · ${probe.category} · ${probe.detail} · ${probe.latencyMs ?? "?"} ms${probe.stream ? " · stream" : ""} · usable ${probe.usable ?? 0}`,
          );
          this.emit();
        })
        .catch((err: Error) => {
          this.push("error", `${p.name} test chat failed — ${err.message}`);
          this.emit();
        });
      return;
    }
    this.push("warn", `${p.name} test chat runs in the desktop app. No model was called.`);
    this.emit();
  }

  /* ------------------------------------------------------------------ jobs */

  private queue(model: ModelSpec, kind: JobKind, gb: number, detail: string) {
    const job: Job = {
      id: nextId("job"),
      modelId: model.id,
      kind,
      phase: "Queued",
      progress: 0,
      detail,
      gbTotal: gb,
      gbDone: 0,
      speedMbps: 0,
      etaSeconds: 0,
      startedAt: Date.now(),
    };
    this.state.jobs = [job, ...this.state.jobs].slice(0, 40);
    return job;
  }

  install(modelId: string) {
    const model = modelById.get(modelId);
    if (!model) return;
    if (this.state.jobs.some((j) => j.modelId === modelId && isJobActive(j.phase))) return;
    const reason = failureReason(model, this.state);
    if (reason) {
      const job = this.queue(model, "download", model.sizeGb, reason);
      job.phase = "Failed";
      job.error = reason;
      this.push("error", `${model.name} — ${reason}`);
      this.emit();
      return;
    }
    const update = Boolean(this.state.installed[modelId]);
    const job = this.queue(
      model,
      update ? "update" : "download",
      Math.max(0.05, model.sizeGb),
      `resolving ${model.source}`,
    );
    this.push(
      "info",
      `${update ? "update" : "download"} ${model.name} → ${model.version} from ${model.source}`,
    );

    // Desktop: try every real source in order — Ollama registry first, then
    // the vendor's Hugging Face mirrors — and keep the one that delivers.
    const api = desktopApi();
    const sources = downloadSources(model);
    if (this.state.bridge === "desktop" && api?.downloadModel && sources.length) {
      this.bindDesktopEvents();
      job.remote = true;
      job.phase = "Downloading";
      job.detail = `${sources.length} source(s) available · trying ${sources[0]?.label ?? "first source"}`;
      void api
        .downloadModel({ modelId, sources, jobId: job.id })
        .then((res) => {
          if (res?.ok) return;
          const error = res?.error || "download failed";
          job.phase = "Failed";
          job.error = error;
          job.detail = error;
          this.push("error", `${model.name} — ${error}`);
          this.emit();
        })
        .catch((err: Error) => {
          job.phase = "Failed";
          job.error = err.message;
          job.detail = err.message;
          this.push("error", `${model.name} — ${err.message}`);
          this.emit();
        });
      this.emit();
      return;
    }
    const tag = registryTag(model);
    if (this.state.bridge === "desktop" && api?.pullModel && tag) {
      this.bindDesktopEvents();
      job.remote = true;
      job.phase = "Downloading";
      job.detail = `pulling ${tag} from ${model.source}`;
      void api.pullModel(tag, job.id).catch((err: Error) => {
        job.phase = "Failed";
        job.error = err.message;
        job.detail = err.message;
        this.push("error", `${model.name} — ${err.message}`);
        this.emit();
      });
      this.emit();
      return;
    }
    if (this.state.bridge === "desktop" && !tag) {
      job.phase = "Failed";
      job.error = "no download source is known for this model";
      job.detail = job.error;
      this.push("error", `${model.name} — ${job.error}`);
      this.emit();
      return;
    }

    this.ensureTimer();
    this.emit();
  }

  remove(modelId: string) {
    const model = modelById.get(modelId);
    if (!model) return;
    const api = desktopApi();
    const tag = registryTag(model);
    if (this.state.bridge === "desktop" && api?.removeModel && tag) {
      void api
        .removeModel(tag)
        .then((r) => {
          this.push(
            r.ok ? "warn" : "error",
            r.ok ? `${model.name} deleted from disk` : `${model.name} — ${r.error}`,
          );
          return this.refreshFromDesktop();
        })
        .then(() => this.emit())
        .catch((err: Error) => this.log("error", `${model.name} — ${err.message}`));
    }
    this.unload(modelId, true);
    this.state.installed[modelId] = null;
    for (const [task, id] of Object.entries(this.state.routing)) {
      if (id === modelId) this.state.routing[task as RoutingTask] = null;
    }
    this.state.multiModel = this.state.multiModel.filter((id) => id !== modelId);
    this.push("warn", `${model.name} removed — ${formatGb(model.sizeGb)} reclaimed`);
    this.emit();
  }

  cancel(jobId: string) {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job || !isJobActive(job.phase)) return;
    if (job.remote) void desktopApi()?.cancelModelJob?.(job.id);
    job.phase = "Cancelled";
    job.detail = "cancelled by operator";
    this.push("warn", `${modelById.get(job.modelId)?.name ?? job.modelId} — job cancelled`);
    this.emit();
  }

  updateAll() {
    const pending = modelCatalog.filter((m) => this.statusOf(m.id) === "Update available");
    if (pending.length === 0) {
      this.log("ok", "all installed models are on their latest version");
      return;
    }
    pending.forEach((m) => this.install(m.id));
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Bring back everything that was active when FRIDAY was last closed, so an
   * app or PC restart never asks the user to re-activate their models.
   */
  private restoreActive() {
    if (this.restored) return;
    this.restored = true;
    const wanted = [...this.state.active];
    if (wanted.length === 0) return;
    this.push("info", `restoring ${wanted.length} active model(s) from the last session`);
    wanted.forEach((id) => {
      if (!this.state.runtimes[id]) this.load(id, true);
    });
    this.emit();
  }

  /**
   * Search the official model indexes for anything newly released. Runs in the
   * main process (no CORS, cached on disk) so results survive going offline.
   */
  async discover(query = "", sort: "downloads" | "latest" = "downloads"): Promise<void> {
    if (this.state.discovering) return;
    const api = desktopApi();
    if (!api?.searchModels) {
      this.state.discoveryError = "online discovery needs the desktop app";
      this.emit(false);
      return;
    }
    this.state.discovering = true;
    this.state.discoveryError = null;
    this.emit(false);
    try {
      const res = await api.searchModels(query, { sort });
      this.state.discovered = res.items ?? [];
      this.state.discoveryAt = res.at ?? Date.now();
      this.state.discoveryError = res.error ?? null;
      this.push(
        res.error ? "warn" : "ok",
        res.error
          ? `model discovery failed — ${res.error}`
          : `discovered ${this.state.discovered.length} models${res.cached ? " (cached)" : ""}`,
      );
    } catch (err) {
      this.state.discoveryError = (err as Error).message;
      this.push("error", `model discovery failed — ${(err as Error).message}`);
    } finally {
      this.state.discovering = false;
      this.emit();
    }
  }

  clearDiscovery() {
    this.state.discovered = [];
    this.state.discoveryError = null;
    this.emit();
  }

  /**
   * Ask FRIDAY's configured cloud model which local models are current right
   * now. Every suggestion is verified against the real repository before it is
   * shown, so the list only ever contains installable models.
   */
  async aiRefreshCatalog(query = ""): Promise<void> {
    if (this.state.discovering) return;
    const api = desktopApi();
    if (!api?.aiSuggestModels) {
      this.state.discoveryError = "AI catalogue refresh needs the desktop app";
      this.emit(false);
      return;
    }
    this.state.discovering = true;
    this.state.discoveryError = null;
    this.emit(false);
    try {
      const res = await api.aiSuggestModels({
        query,
        system: {
          vramGb: this.state.system.vramGb,
          ramGb: this.state.system.ramGb,
          gpu: this.state.system.gpu,
        },
      });
      if (res.ok && res.items?.length) {
        const known = new Set(this.state.discovered.map((i) => i.id));
        this.state.discovered = [
          ...res.items.filter((i) => !known.has(i.id)),
          ...this.state.discovered,
        ];
        this.state.discoveryAt = Date.now();
        this.push("ok", `${res.items.length} verified suggestion(s) via ${res.via ?? "AI"}`);
      } else {
        this.state.discoveryError = res.error ?? "no suggestion could be verified";
        this.push("warn", `AI catalogue refresh — ${this.state.discoveryError}`);
      }
    } catch (err) {
      this.state.discoveryError = (err as Error).message;
      this.push("error", `AI catalogue refresh failed — ${(err as Error).message}`);
    } finally {
      this.state.discovering = false;
      this.emit();
    }
  }

  /**
   * Install a discovered model using every real source it carries — the Ollama
   * registry when it has a tag, otherwise the verified Hugging Face repo.
   */
  async installDiscovered(item: OnlineModel): Promise<void> {
    const api = desktopApi();
    const ref = item.pullRef ?? item.name;
    const sources =
      item.sources && item.sources.length
        ? item.sources
        : item.pullRef
          ? [
              {
                kind: "ollama" as const,
                ref: item.pullRef,
                label: `Ollama registry · ${item.pullRef}`,
              },
            ]
          : [];

    if (api?.downloadModel && sources.length) {
      this.bindDesktopEvents();
      const jobId = nextId("job");
      this.push("info", `installing ${ref} — ${sources.length} source(s)`);
      this.emit();
      try {
        const res = await api.downloadModel({ modelId: item.id, sources, jobId });
        if (res?.ok) {
          this.push("ok", `${ref} installed from ${res.source ?? "source"}`);
          await this.refreshFromDesktop();
        } else {
          this.push("error", `${ref} — ${res?.error ?? "download failed"}`);
        }
      } catch (err) {
        this.push("error", `${ref} — ${(err as Error).message}`);
      }
      this.emit();
      return;
    }

    if (!api?.pullModel) {
      this.log("error", "installing discovered models needs the desktop app");
      return;
    }
    this.push("info", `pulling ${ref} from ${item.source}`);
    this.emit();
    try {
      await api.pullModel(ref, nextId("job"));
      this.push("ok", `${ref} pulled`);
      await this.refreshFromDesktop();
    } catch (err) {
      this.push("error", `${ref} — ${(err as Error).message}`);
    }
    this.emit();
  }

  load(modelId: string, restoring = false) {
    const model = modelById.get(modelId);
    if (!model) return;
    if (model.kind === "local" && !this.state.installed[modelId]) {
      this.log("error", `${model.name} is not installed — download it first`);
      return;
    }
    const reason = failureReason(model, this.state);
    if (reason) {
      this.log("error", `${model.name} — ${reason}`);
      return;
    }
    if (!this.state.active.includes(modelId)) this.state.active = [...this.state.active, modelId];
    void restoring;
    this.state.runtimes[modelId] = {
      modelId,
      state: "Loading",
      loadedAt: Date.now(),
      vramGb: 0,
      ramGb: 0,
      cpuPct: 0,
      gpuPct: 0,
      tokensPerSec: 0,
      latencyMs: 0,
      requests: 0,
      lastUsed: Date.now(),
    };
    this.push(
      "info",
      `loading ${model.name} (${model.quant}, ctx ${model.ctxK}k) on ${this.state.device}`,
    );

    // Desktop: really load the weights by running one short generation and
    // record the timings the daemon reports back.
    const api = desktopApi();
    const tag = registryTag(model);
    if (this.state.bridge === "desktop" && api?.probeModel && tag) {
      this.emit();
      void api
        .probeModel(tag)
        .then((run) => {
          const rt = this.state.runtimes[modelId];
          if (!rt) return;
          if (!run.ok) {
            rt.state = "Error";
            this.push("error", `${model.name} failed to load — ${run.error}`);
          } else {
            rt.state = "Running";
            rt.tokensPerSec = run.tokensPerSec ?? 0;
            rt.latencyMs = run.latencyMs ?? 0;
            rt.requests += 1;
            rt.lastUsed = Date.now();
            this.push(
              "ok",
              `${model.name} loaded — ${run.tokensPerSec ?? "?"} tok/s, ${run.firstTokenMs ?? "?"} ms first token`,
            );
          }
          this.emit();
          return this.refreshFromDesktop().then(() => this.emit());
        })
        .catch((err: Error) => this.log("error", `${model.name} — ${err.message}`));
      return;
    }
    this.ensureTimer();
    this.emit();
  }

  unload(modelId: string, silent = false) {
    this.state.active = this.state.active.filter((id) => id !== modelId);
    if (!this.state.runtimes[modelId]) {
      this.emit();
      return;
    }
    const model = modelById.get(modelId);
    const tag = model ? registryTag(model) : null;
    if (this.state.bridge === "desktop" && tag) void desktopApi()?.unloadModel?.(tag);
    delete this.state.runtimes[modelId];
    if (!silent)
      this.push("info", `${modelById.get(modelId)?.name ?? modelId} unloaded — VRAM released`);
    this.emit();
  }

  benchmark(modelId: string) {
    const model = modelById.get(modelId);
    if (!model) return;
    if (
      this.state.jobs.some(
        (j) => j.modelId === modelId && j.kind === "benchmark" && isJobActive(j.phase),
      )
    )
      return;
    const job = this.queue(model, "benchmark", 0, "warming up · 256 token prompt");
    job.phase = "Benchmarking";
    this.push("info", `benchmarking ${model.name}`);

    const api = desktopApi();
    const tag = registryTag(model);
    if (this.state.bridge === "desktop" && api?.probeModel && tag) {
      job.remote = true;
      job.detail = `running a real generation on ${tag}`;
      this.emit();
      void api
        .probeModel(tag, "Summarise what a benchmark measures in two sentences.")
        .then((run) => {
          if (!run.ok) {
            job.phase = "Failed";
            job.error = run.error ?? "benchmark failed";
            job.detail = job.error;
            this.push("error", `${model.name} benchmark — ${run.error}`);
          } else {
            this.state.benchmarks[model.id] = {
              modelId: model.id,
              tokensPerSec: run.tokensPerSec ?? 0,
              firstTokenMs: run.firstTokenMs ?? 0,
              promptTokensPerSec: run.promptTokensPerSec ?? 0,
              scoreQuality: 0,
              peakVramGb: this.state.runtimes[model.id]?.vramGb ?? 0,
              at: Date.now(),
            };
            job.phase = "Done";
            job.progress = 100;
            job.detail = `${run.tokensPerSec ?? "?"} tok/s · ${run.firstTokenMs ?? "?"} ms first token`;
            this.push("ok", `${model.name} benchmark — ${job.detail}`);
          }
          this.emit();
        })
        .catch((err: Error) => {
          job.phase = "Failed";
          job.error = err.message;
          this.log("error", `${model.name} benchmark — ${err.message}`);
        });
      return;
    }
    this.ensureTimer();
    this.emit();
  }

  /* --------------------------------------------------------------- routing */

  assign(task: RoutingTask, modelId: string | null) {
    this.state.routing[task] = modelId;
    const label = routingTasks.find((t) => t.key === task)?.label ?? task;
    this.push(
      "ok",
      modelId ? `${label} → ${modelById.get(modelId)?.name ?? modelId}` : `${label} cleared`,
    );
    this.emit();
  }

  toggleMulti(modelId: string) {
    this.state.multiModel = this.state.multiModel.includes(modelId)
      ? this.state.multiModel.filter((id) => id !== modelId)
      : [...this.state.multiModel, modelId];
    this.push("info", `multi-model panel: ${this.state.multiModel.length} model(s) selected`);
    this.emit();
  }

  setParallel(on: boolean) {
    this.state.parallel = on;
    this.push("info", `parallel execution ${on ? "enabled" : "disabled"}`);
    this.emit();
  }

  /* ---------------------------------------------------------------- import */

  importModel(input: {
    name: string;
    path: string;
    format: string;
    sizeGb: number;
    provider: ProviderId;
  }) {
    const entry: ImportedModel = { id: nextId("imported"), at: Date.now(), ...input };
    this.state.imported = [entry, ...this.state.imported].slice(0, 50);
    this.push(
      "ok",
      `imported ${entry.name} (${entry.format}, ${formatGb(entry.sizeGb)}) from ${entry.path}`,
    );
    this.emit();
  }

  removeImport(id: string) {
    this.state.imported = this.state.imported.filter((m) => m.id !== id);
    this.push("warn", "imported model unlinked");
    this.emit();
  }

  /* ---------------------------------------------------------------- status */

  statusOf(modelId: string): "Installed" | "Update available" | "Not installed" | "Available" {
    const model = modelById.get(modelId);
    if (!model) return "Not installed";
    if (model.kind === "cloud")
      return this.state.providerState[model.provider]?.apiKey ? "Installed" : "Available";
    const installed = this.state.installed[modelId];
    if (!installed) return "Not installed";
    return installed === model.version ? "Installed" : "Update available";
  }

  /* ----------------------------------------------------------------- ticker */

  private ensureTimer() {
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
    const dt = Math.min(2, (now - this.lastTick) / 1000);
    this.lastTick = now;
    let changed = false;

    if (this.state.bridge === "desktop" && shouldUnloadIdleModels() && !shouldKeepModelsWarm()) {
      const idleMs = modelIdleMs();
      for (const id of Object.keys(this.state.runtimes)) {
        const rt = this.state.runtimes[id];
        if (!rt || rt.state !== "Running") continue;
        const last = rt.lastUsed || 0;
        if (last && now - last > idleMs) {
          this.unload(id, true);
          changed = true;
        }
      }
    }

    if (this.state.scanning) {
      this.state.scanProgress = Math.min(100, this.state.scanProgress + dt * 60);
      if (this.state.scanProgress >= 100) {
        this.state.scanning = false;
        this.finishScan();
      }
      changed = true;
    }

    for (const job of this.state.jobs) {
      if (!isJobActive(job.phase)) continue;
      // Real desktop pulls report their own byte counters — never estimate over them.
      if (job.remote) continue;
      // On the desktop nothing is ever simulated: a job that has no real
      // backing operation fails honestly instead of animating fake progress.
      if (this.state.bridge === "desktop") {
        job.phase = "Failed";
        job.error = job.error ?? "no real source or runtime is available for this operation";
        job.detail = job.error;
        changed = true;
        continue;
      }
      changed = true;
      const model = modelById.get(job.modelId);
      if (!model) {
        job.phase = "Failed";
        continue;
      }

      if (job.kind === "benchmark") {
        job.progress = Math.min(100, job.progress + dt * 34);
        job.detail =
          job.progress < 45
            ? "prefill · 256 tokens"
            : job.progress < 85
              ? "decode · 512 tokens"
              : "scoring quality";
        if (job.progress >= 100) {
          const gpuBound =
            model.vramGb > 0 && this.state.system.vramGb > 0 && this.state.device !== "cpu";
          const base =
            model.kind === "cloud"
              ? 90
              : gpuBound
                ? 1200 / Math.max(1, model.sizeGb)
                : 220 / Math.max(1, model.sizeGb);
          const tps = Math.max(1.4, Number((base * (0.85 + Math.random() * 0.3)).toFixed(1)));
          this.state.benchmarks[model.id] = {
            modelId: model.id,
            tokensPerSec: tps,
            firstTokenMs: Math.round(
              model.kind === "cloud" ? 220 + Math.random() * 400 : 60 + model.sizeGb * 14,
            ),
            promptTokensPerSec: Math.round(tps * (4 + Math.random() * 3)),
            scoreQuality: Math.min(
              99,
              Math.round(52 + Math.log2(1 + model.sizeGb) * 7 + (model.kind === "cloud" ? 20 : 0)),
            ),
            peakVramGb: Number((model.vramGb * 0.92).toFixed(1)),
            at: now,
          };
          job.phase = "Done";
          job.detail = `${tps} tok/s · ${this.state.benchmarks[model.id]!.firstTokenMs} ms first token`;
          this.push(
            "ok",
            `${model.name} benchmark — ${tps} tok/s, quality score ${this.state.benchmarks[model.id]!.scoreQuality}`,
          );
        }
        continue;
      }

      // download / update pipeline
      if (job.phase === "Queued") {
        job.phase = "Resolving";
        job.detail = `resolving manifest · ${model.source}`;
        continue;
      }
      if (job.phase === "Resolving") {
        job.progress = Math.min(6, job.progress + dt * 12);
        if (job.progress >= 6) {
          job.phase = "Downloading";
          job.detail = `downloading ${model.format} · ${model.url.replace(/^https?:\/\//, "").slice(0, 42)}`;
        }
        continue;
      }
      if (job.phase === "Downloading") {
        const speed = 42 + Math.random() * 46; // MB/s
        job.speedMbps = Number(speed.toFixed(1));
        job.gbDone = Math.min(job.gbTotal, job.gbDone + (speed * dt) / 1024);
        const frac = job.gbTotal > 0 ? job.gbDone / job.gbTotal : 1;
        job.progress = 6 + frac * 74;
        job.etaSeconds = speed > 0 ? ((job.gbTotal - job.gbDone) * 1024) / speed : 0;
        job.detail = `${formatGb(job.gbDone)} / ${formatGb(job.gbTotal)} · ${job.speedMbps} MB/s · ETA ${formatEta(job.etaSeconds)}`;
        if (frac >= 1) {
          job.phase = "Verifying";
          job.detail = "verifying SHA-256 checksum";
        }
        continue;
      }
      if (job.phase === "Verifying") {
        job.progress = Math.min(90, job.progress + dt * 26);
        if (job.progress >= 90) {
          job.phase = "Installing";
          job.detail = `registering with ${providerById.get(model.provider)?.name}`;
        }
        continue;
      }
      if (job.phase === "Installing") {
        job.progress = Math.min(100, job.progress + dt * 32);
        if (job.progress >= 100) {
          job.phase = "Done";
          job.detail = `installed ${model.version} · ${formatGb(model.sizeGb)}`;
          this.state.installed[model.id] = model.version;
          const ps = this.state.providerState[model.provider];
          if (ps) {
            ps.detected = true;
            ps.online = true;
            ps.models = modelCatalog.filter(
              (m) => m.provider === model.provider && this.state.installed[m.id],
            ).length;
          }
          this.push(
            "ok",
            `${model.name} installed — ${formatGb(model.sizeGb)} from ${model.source}`,
          );
        }
      }
    }

    // runtime telemetry
    for (const rt of Object.values(this.state.runtimes)) {
      const model = modelById.get(rt.modelId);
      if (!model) continue;
      changed = true;
      if (rt.state === "Loading") {
        rt.vramGb = Math.min(model.vramGb, rt.vramGb + dt * Math.max(1, model.vramGb / 2.2));
        rt.ramGb = Math.min(model.ramGb * 0.4, rt.ramGb + dt * 2);
        if (rt.vramGb >= model.vramGb - 0.05) {
          rt.state = "Running";
          rt.vramGb = model.vramGb;
          this.push(
            "ok",
            `${model.name} ready — ${formatGb(model.vramGb || model.ramGb * 0.4)} resident, ctx ${model.ctxK}k`,
          );
        }
        continue;
      }
      // Desktop runtime counters come from the real runner (probeModel /
      // loadModel). Never overwrite measured numbers with estimates.
      if (this.state.bridge === "desktop") continue;
      const bench = this.state.benchmarks[rt.modelId];
      const target =
        bench?.tokensPerSec ??
        (model.kind === "cloud" ? 85 : Math.max(6, 900 / Math.max(1, model.sizeGb)));
      rt.tokensPerSec = Number((target * (0.9 + Math.random() * 0.2)).toFixed(1));
      rt.latencyMs = Math.round((model.kind === "cloud" ? 240 : 70) * (0.85 + Math.random() * 0.4));
      rt.cpuPct = Math.round(
        model.kind === "cloud" ? 3 + Math.random() * 5 : 18 + Math.random() * 26,
      );
      rt.gpuPct = Math.round(
        model.vramGb > 0 && this.state.device !== "cpu"
          ? 48 + Math.random() * 42
          : Math.random() * 6,
      );
      rt.requests += Math.random() < 0.18 ? 1 : 0;
      rt.lastUsed = now;
    }

    if (changed) this.emit(false);
    const hasWork =
      this.state.scanning ||
      this.state.jobs.some((job) => isJobActive(job.phase)) ||
      Object.keys(this.state.runtimes).length > 0;
    if (!hasWork) {
      this.stopTimer();
      this.persist();
    }
  }
}

export const models = new ModelsStore();

export { checkSupport, routingTasks };
