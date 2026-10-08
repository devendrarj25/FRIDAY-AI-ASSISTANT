/**
 * Desktop runtime wiring: boot sequence, workspace scan on startup, hot-reload
 * notifications, provider/component detection and user-confirmed updates.
 * In the browser preview `window.friday` is absent and every call resolves to
 * a no-op so the UI still renders.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ModelSource as ModelDownloadSource } from "./model-sources";

/**
 * Billing safety record, owned by the main process. A stored paid API key is
 * never permission to spend — these flags are.
 */
export type DataClassification = "public" | "internal" | "private" | "sensitive";

/** One data-egress confirmation, as the main process reports it. */
export type EgressEvent = {
  at: number;
  label: string;
  modelId: string | null;
  destination: string | null;
  classification: DataClassification;
  reasons: string[];
  /** Absent while the prompt is still on screen. */
  allowed?: boolean;
};

export type BillingState = {
  paidAccess: boolean;
  autoPaidUsage: boolean;
  killSwitch: boolean;
  grantScope: "off" | "request" | "session" | "always";
  grantUntil: number;
  grantedAt: number;
};

export type WorkspaceScanResult = {
  root: string;
  exists: boolean;
  valid: boolean;
  present: string[];
  missing: string[];
  mapped?: Record<string, string>;
  rootFiles?: Record<string, boolean>;
  scannedAt: number;
  settings?: Record<string, unknown>;
  settingsFiles?: string[];
  workspaceManifest?: Record<string, unknown> | null;
  plugins?: { id: string; name: string; version: string | null }[];
  modules?: { id: string; name: string; version: string | null }[];
  agents?: { id: string; name: string; version: string | null }[];
  skills?: { id: string; name: string; version: string | null }[];
  workflows?: { id: string; name: string; version: string | null }[];
  tools?: { id: string; name: string; version: string | null }[];
  counts?: Record<string, number>;
  folders?: WorkspaceFolder[];
  totals?: { files: number; folders: number };
};

export type WorkspaceFolder = {
  name: string;
  path: string;
  kind: "code-root" | "docs" | "data" | "models" | "other";
  files: number;
  subfolders: number;
  indexed: boolean;
};

export type WorkspaceChange = {
  component: string;
  file: string;
  restartRequired: boolean;
  at: number;
};

export type UpdateInfo = {
  kind: string;
  id: string;
  name: string;
  current: string | null;
  available: string;
  notes: string;
  channel?: string;
  testBuild?: boolean;
  download?: string | null;
  managedByReleaseChannel?: boolean;
};

export type BootStep = {
  label: string;
  status: "ok" | "warn" | "missing";
  detail?: string;
  at: number;
};

export type DetectedModel = {
  id: string;
  name: string;
  size?: number | null;
  family?: string | null;
  parameters?: string | null;
  quantization?: string | null;
};

export type DetectedProvider = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  installed: boolean;
  running?: boolean;
  endpoint?: string;
  path?: string | null;
  configured?: boolean;
  keySource?: "stored" | "environment" | null;
  models: DetectedModel[];
  status: string;
};

/**
 * One record from the authoritative provider registry. Never carries the key
 * itself — only whether one exists and where it came from.
 */
export type ProviderRecord = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  endpoint: string | null;
  configured: boolean;
  authenticated: boolean;
  reachable: boolean;
  keySource: "stored" | "environment" | null;
  models: string[];
  modelCount: number;
  health: string;
  category: string | null;
  cooldownUntil: number;
  coolingDown: boolean;
  failures: number;
  latencyMs: number | null;
  lastChecked: number;
  lastSuccess: number;
  lastError: string | null;
};

export type DetectedComponent = {
  id: string;
  name: string;
  category: string;
  required: boolean;
  installed: boolean;
  path: string | null;
  version: string | null;
  status: string;
};

export type DetectedHardware = {
  detectedAt: number;
  platform: string;
  arch: string;
  cpu: { model: string; cores: number; speedMhz: number | null };
  memory: { totalGb: number; freeGb: number };
  gpus: {
    vendor: string;
    name: string;
    vramTotalMb: number | null;
    vramUsedMb: number | null;
    driver: string | null;
  }[];
  cuda: {
    available: boolean;
    version: string | null;
    driverAvailable?: boolean;
    toolkitAvailable?: boolean;
  };
  plan: {
    backend: "gpu" | "cpu";
    reason: string;
    threads: number;
    maxRamGb: number;
    maxVramGb: number;
    fallback: string;
    backgroundThrottle: boolean;
  };
};

/**
 * Remote (off-LAN) companion access. Uses the machine's existing Tailscale
 * (WireGuard) device network when present: end-to-end encrypted, device
 * authorised, no public port and no relay of our own. Off by default.
 */
export type CompanionRemoteState = {
  enabled: boolean;
  available: boolean;
  backend: "tailscale" | "none";
  url: string | null;
  detail: string;
  requiresPairedPhone?: boolean;
};

type DesktopApi = {
  isDesktop: true;
  /** Publish the nav/feature registry so the phone companion mirrors it. */
  publishCompanionFeatures?: (
    payload: unknown[] | { features: unknown[]; capabilities: unknown[]; live?: unknown },
  ) => Promise<{ ok: boolean; count?: number }>;
  companionRemote?: () => Promise<CompanionRemoteState>;
  setCompanionRemote?: (enabled: boolean) => Promise<CompanionRemoteState>;
  paths?: () => Promise<{ install: string; userData: string; workspace: string | null }>;

  getBootSteps?: () => Promise<BootStep[]>;
  onBootStep?: (cb: (s: BootStep) => void) => () => void;
  scanWorkspace?: (force?: boolean) => Promise<WorkspaceScanResult | null>;
  pickFolder?: () => Promise<string | null>;
  getWorkspaceRoot?: () => Promise<string | null>;
  setWorkspaceRoot?: (path: string) => Promise<string>;
  repairWorkspace?: (path?: string) => Promise<WorkspaceScanResult>;
  revealWorkspaceFolder?: (relative?: string) => Promise<boolean>;
  libraryList?: () => Promise<{ ok: boolean; items: unknown[]; dir?: string; error?: string }>;
  libraryIngest?: (payload: unknown) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  libraryGet?: (
    id: string,
  ) => Promise<{ ok: boolean; item?: unknown; text?: string; error?: string }>;
  libraryDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  libraryReveal?: (id: string) => Promise<boolean>;
  libraryZip?: (ids: string[]) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  libraryScan?: () => Promise<{ ok: boolean; items: unknown[]; error?: string }>;
  libraryWrite?: (payload: unknown) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  libraryPin?: (payload: {
    id: string;
    pinned: boolean;
  }) => Promise<{ ok: boolean; item?: unknown }>;
  libraryPatch?: (payload: {
    id: string;
    pinnedForAuto?: boolean;
    hisabLinked?: boolean;
    memoryIds?: string[];
  }) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  projectList?: () => Promise<{
    ok: boolean;
    items: unknown[];
    activeId?: string | null;
    dir?: string;
    error?: string;
  }>;
  projectSave?: (payload: unknown) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  projectGet?: (id: string) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  projectSetActive?: (
    id: string | null,
  ) => Promise<{ ok: boolean; activeId?: string | null; items?: unknown[] }>;
  projectDuplicate?: (id: string) => Promise<{ ok: boolean; item?: unknown; error?: string }>;
  projectArchive?: (payload: {
    id: string;
    archived: boolean;
  }) => Promise<{ ok: boolean; item?: unknown }>;
  projectDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  projectReveal?: (id: string) => Promise<boolean>;
  projectWriteFile?: (
    payload: unknown,
  ) => Promise<{ ok: boolean; item?: unknown; file?: string; error?: string }>;
  projectListFiles?: (id: string) => Promise<{ ok: boolean; files?: string[]; error?: string }>;
  projectReadFile?: (payload: {
    id: string;
    name: string;
  }) => Promise<{ ok: boolean; content?: string; size?: number; error?: string; name?: string }>;
  projectPickFolder?: () => Promise<string | null>;
  extractDocument?: (payload: unknown) => Promise<unknown>;
  onWorkspaceScan?: (cb: (s: WorkspaceScanResult) => void) => () => void;
  onWorkspaceChange?: (cb: (c: WorkspaceChange) => void) => () => void;
  onSenseEvent?: (
    cb: (event: {
      sense?: string;
      at?: number;
      text?: string;
      path?: string;
      hour?: number;
    }) => void,
  ) => () => void;
  onWorkspaceMigrate?: (
    cb: (e: {
      phase: "start" | "copy" | "done" | "failed";
      folder?: string;
      from?: string;
      to?: string;
      copied?: string[];
      failed?: { folder: string; error: string }[];
    }) => void,
  ) => () => void;
  detectProviders?: () => Promise<{ detectedAt: number; providers: DetectedProvider[] }>;
  listOllamaModels?: () => Promise<{ running: boolean; models: unknown[] }>;
  detectComponents?: () => Promise<{ detectedAt: number; components: DetectedComponent[] }>;
  detectHardware?: () => Promise<DetectedHardware>;
  checkUpdates?: () => Promise<{ checkedAt: number; updates: UpdateInfo[] }>;
  applyUpdate?: (update: UpdateInfo) => Promise<UpdateApplyResult>;
  rollbackUpdate?: (entry: {
    backup: string;
    target: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onUpdateProgress?: (cb: (p: UpdateProgress) => void) => () => void;
  confirmRestart?: (reason: string) => Promise<boolean>;
  restartApp?: (reason?: string) => Promise<boolean>;
  restartState?: () => Promise<RestartState>;
  onRestartRequired?: (cb: (state: RestartState) => void) => () => void;
  kernel?: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  listPlugins?: () => Promise<DesktopPlugin[]>;
  checkPluginUpdates?: () => Promise<PluginUpdatesResult>;
  loadPlugin?: (id: string) => Promise<PluginResult>;
  reloadPlugin?: (id: string) => Promise<PluginResult>;
  unloadPlugin?: (id: string) => Promise<{ ok: boolean }>;
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<PluginResult>;
  removePlugin?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  installPlugin?: () => Promise<PluginResult & { cancelled?: boolean }>;
  invokePlugin?: <T = unknown>(
    id: string,
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: T; error?: string }>;
  pluginTools?: () => Promise<{ plugin: string; name: string }[]>;
  telemetrySnapshot?: () => Promise<TelemetrySnapshot>;
  telemetryClear?: () => Promise<{ ok: boolean }>;
  telemetryFiles?: () => Promise<TelemetryFiles>;
  telemetryReadFile?: (
    rel: string,
  ) => Promise<{ ok: boolean; rel?: string; text?: string; error?: string }>;
  onKernelLog?: (cb: (p: { level: string; text: string }) => void) => () => void;
  onTelemetryLog?: (cb: (entry: TelemetryLogEntry) => void) => () => void;
  onTelemetryIpc?: (cb: (entry: TelemetryIpcEntry) => void) => () => void;
  onTelemetryCleared?: (cb: (p: { at: number }) => void) => () => void;
  onKernelExit?: (cb: (p: { code: number }) => void) => () => void;
  onKernelRecover?: (
    cb: (p: {
      phase: "trying" | "recovered" | "failed";
      attempt?: number;
      attempts?: number;
      maxAttempts?: number;
      delayMs?: number;
      code?: number | null;
      message: string;
      steps?: string[];
    }) => void,
  ) => () => void;

  // Models manager — real operations against Ollama, local servers and clouds.
  modelsInventory?: () => Promise<ModelInventory>;
  searchModels?: (
    query: string,
    options?: { sort?: "downloads" | "latest"; limit?: number } | null,
  ) => Promise<DiscoveryResult>;
  /** AI-assisted catalogue refresh, verified against the real repos. */
  aiSuggestModels?: (payload?: {
    query?: string;
    system?: { vramGb?: number; ramGb?: number; gpu?: string };
  }) => Promise<{ ok: boolean; items: OnlineModel[]; via?: string; error?: string | null }>;
  testModelProvider?: (
    id: string,
    apiKey?: string | null,
    options?: { chat?: boolean; modelId?: string } | null,
  ) => Promise<ProviderProbe | ProviderChatProbe>;
  syncModelKnowledge?: () => Promise<{
    due: Array<{ id: string; source: string; expired: boolean }>;
  }>;
  healModelProviders?: () => Promise<{ ok: boolean; disabled: string[]; note: string }>;
  previewModelRoute?: (prompt: string) => Promise<{
    task: string;
    source: string;
    preset: string | null;
    strategy: string | null;
    candidates: string[];
    why: string;
  }>;
  setProviderKey?: (
    id: string,
    apiKey: string | null,
  ) => Promise<{ ok: boolean; stored: boolean; encrypted: boolean }>;
  providerKeys?: () => Promise<Record<string, boolean>>;
  /** Custom base URL for a provider — replaces the built-in default for real. */
  setProviderEndpoint?: (
    id: string,
    endpoint: string | null,
  ) => Promise<{ ok: boolean; id?: string; endpoint?: string | null; error?: string }>;
  providerEndpoints?: () => Promise<Record<string, string>>;
  showModel?: (model: string) => Promise<Record<string, unknown>>;
  runningModels?: () => Promise<{ ok: boolean; models: RunningModel[] }>;
  pullModel?: (
    model: string,
    jobId?: string,
  ) => Promise<{ jobId: string; ok: boolean; error?: string }>;
  /** Multi-source download: tries each real source until one delivers. */
  downloadModel?: (payload: {
    modelId: string;
    sources: ModelDownloadSource[];
    jobId?: string;
  }) => Promise<{
    jobId?: string;
    ok: boolean;
    via?: string;
    path?: string;
    source?: string;
    error?: string;
    attempts?: { source: string; error: string }[];
  }>;
  cancelModelJob?: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
  removeModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  unloadModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  probeModel?: (model: string, prompt?: string) => Promise<ModelProbeRun>;
  /** Models this machine can actually route to right now, best first. */
  routableModels?: (force?: boolean) => Promise<{ at: number; models: RoutableModel[] }>;
  /** Dynamic model registry for the selector: free/paid classified, live health. */
  modelRegistry?: (force?: boolean) => Promise<{
    at: number;
    policy: string;
    models: unknown[];
  }>;
  modelUsagePolicy?: () => Promise<{ policy: string }>;
  setModelUsagePolicy?: (policy: string) => Promise<{ policy: string }>;
  /** Billing safety — paid AI usage is locked in the main process by default. */
  billingPolicy?: () => Promise<{
    billing: BillingState;
    policy: string;
    requestedPolicy?: string;
    summary: string;
  }>;
  setBillingPolicy?: (
    patch: Partial<BillingState>,
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  grantPaidUsage?: (
    scope: "off" | "request" | "session" | "always",
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  setPaidKillSwitch?: (
    on: boolean,
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  /** Privacy / data-egress firewall — every external send is confirmed live. */
  privacyLastEgress?: () => Promise<EgressEvent | null>;
  classifyContent?: (
    text: string,
  ) => Promise<{ level: DataClassification; reasons: string[]; sample: number }>;
  onEgressPending?: (fn: (event: EgressEvent) => void) => () => void;
  onEgressDecided?: (fn: (event: EgressEvent) => void) => () => void;
  providerAccessTiers?: () => Promise<Record<string, "free" | "paid">>;
  setProviderAccessTier?: (
    id: string,
    tier: "auto" | "free" | "paid",
    declaration?: {
      ownerFreeTier?: boolean;
      modelId?: string;
      mark?: "free" | "paid" | "auto";
    } | null,
  ) => Promise<{ ok: boolean; id: string; tier: string }>;

  /** Where inference may run: auto | local-only | cloud-only | hybrid | multi. */
  /** On-device speech-to-text (faster-whisper) run by the main process. */
  sttStatus?: (
    force?: boolean,
    localOnly?: boolean,
    warm?: boolean,
  ) => Promise<{
    available: boolean;
    ready?: boolean;
    engine: string;
    model?: string;
    reason?: string | null;
    dependency?: string;
    worker?: string;
    inference?: string;
    loadCount?: number;
  }>;
  installStt?: () => Promise<{ ok: boolean; error?: string }>;
  transcribe?: (payload: {
    audioBase64: string;
    mime?: string;
    language?: string | undefined;
    model?: string;
    localOnly?: boolean;
    initialPrompt?: string;
    speechPref?: string;
    sttSize?: string;
  }) => Promise<{
    ok: boolean;
    text?: string;
    error?: string;
    language?: string;
    noSpeechProb?: number;
    turnProbability?: number | null;
    engine?: string;
  }>;
  scoreTurn?: (payload: {
    audioBase64: string;
    mime?: string;
  }) => Promise<{ ok: boolean; ready?: boolean; probability?: number | null; reason?: string }>;
  duckAudio?: (payload: {
    on: boolean;
  }) => Promise<{ ok: boolean; ducked?: boolean; reason?: string }>;
  meetingStatus?: () => Promise<{
    ok?: boolean;
    meeting?: boolean;
    names?: string[];
    reason?: string;
  }>;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  voiceprintStatus?: () => Promise<{ ok?: boolean; enrolled?: boolean; reason?: string }>;
  clearVoiceprint?: () => Promise<{ ok?: boolean; enrolled?: boolean }>;
  onVoicePartial?: (cb: (payload: { text?: string }) => void) => () => void;
  /** Low-latency wake detection (openWakeWord) — the real engine when present. */
  wakeEngineStatus?: (payload: { wakeWord?: string; force?: boolean }) => Promise<{
    engine: "openwakeword" | "friday-linear" | "transcript";
    installed: boolean;
    ready: boolean;
    model?: string | null;
    modelDir?: string | null;
    models?: string[];
    wakeWord: string;
    reason?: string | null;
  }>;
  installWakeEngine?: () => Promise<{ ok: boolean; ready?: boolean; error?: string }>;
  detectWakeWord?: (payload: {
    audioBase64: string;
    mime?: string;
    wakeWord?: string;
    threshold?: number;
  }) => Promise<{
    ok: boolean;
    engine: string;
    detected?: boolean;
    score?: number;
    model?: string;
    reason?: string;
  }>;
  /** Real post-install probes for faster-whisper / edge-tts. */
  verifyVoiceRuntime?: (payload?: { loadModel?: boolean }) => Promise<{
    ok: boolean;
    python: string | null;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }>;

  modelRouteMode?: () => Promise<{ mode: string }>;
  setModelRouteMode?: (mode: string) => Promise<{ mode: string }>;
  modelQualityTarget?: () => Promise<{ qualityTarget: string }>;
  setModelQualityTarget?: (value: string) => Promise<{ qualityTarget: string }>;
  modelRouteStrategy?: () => Promise<{ strategy: string }>;
  setModelRouteStrategy?: (value: string) => Promise<{ strategy: string }>;
  modelSelection?: () => Promise<{ ids: string[] }>;
  setModelSelection?: (ids: string[]) => Promise<{ ids: string[] }>;
  /** The one authoritative provider registry (configured/reachable/health). */
  providerRegistry?: () => Promise<{
    at: number;
    providers: ProviderRecord[];
    totals: Record<string, number>;
  }>;
  providerModeReadiness?: (
    mode: string,
  ) => Promise<{ mode: string; ready: boolean; providers: string[]; reason: string | null }>;
  modelHealthState?: () => Promise<
    { modelId: string; status: string; cooldownUntil: number; coolingDown: boolean }[]
  >;
  onModelRegistryChanged?: (cb: (p: { at: number; provider?: string }) => void) => () => void;
  onModelHealthChanged?: (
    cb: (p: { modelId: string; status: string; cooldownUntil: number }) => void,
  ) => () => void;
  onModelPolicy?: (cb: (p: { policy: string }) => void) => () => void;
  /** FRIDAY's own installed skills — listed and run straight from the brain. */
  listSkills?: () => Promise<{ skills?: unknown[] } | unknown[]>;
  invokeSkill?: (id: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Background agents — plan() is read-only; run() stays dry-run unless approved. */
  listAgents?: () => Promise<{ ok?: boolean; agents?: unknown[] }>;
  planAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<Record<string, unknown>>;
  runAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<Record<string, unknown>>;
  listModulePacks?: () => Promise<{ ok?: boolean; modules?: unknown[] }>;
  invokeModulePack?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<Record<string, unknown>>;
  dispatchPluginHooks?: (
    hook: string,
    payload?: Record<string, unknown>,
    options?: { allowDisabled?: boolean; pluginId?: string },
  ) => Promise<Record<string, unknown>>;
  /** Register the routable catalogue with the AI kernel (idempotent). */
  syncKernelModels?: (force?: boolean) => Promise<{
    ok: boolean;
    registered?: number;
    removed?: string[];
    total?: number;
    error?: string;
  }>;
  /** Auto mode: ordered candidates for a task. */
  selectModels?: (
    task: string,
    preferred?: string[],
  ) => Promise<{ task: string; candidates: (RoutableModel & RoutableMeta)[] }>;
  modelHealth?: (
    modelId: string,
  ) => Promise<ModelProbeRun & { modelId?: string; provider?: string }>;
  modelEngines?: () => Promise<EngineStatus[]>;
  startModelEngine?: (id: string, selectedModel?: string) => Promise<EngineResult>;
  stopModelEngine?: (id: string) => Promise<EngineResult>;
  onModelPullProgress?: (cb: (p: ModelPullProgress) => void) => () => void;
  onModelPullDone?: (
    cb: (p: {
      jobId: string;
      model: string;
      ok: boolean;
      error?: string;
      /** Real post-install test prompt: true only when the model answered. */
      verified?: boolean;
      state?: "ready" | "installed-not-responding";
      latencyMs?: number | null;
      tokensPerSec?: number | null;
    }) => void,
  ) => () => void;
};

export type RoutableMeta = {
  providerId: string;
  kind: "local" | "cloud";
  modelName: string;
  resident: boolean;
  sizeGb: number;
};

export type RoutableModel = {
  id: string;
  label: string;
  provider: string;
  endpoint: string;
  role: "brain" | "coder" | "fast" | "researcher" | "embed";
  params: string;
  contextK: number;
  status: string;
  options: { model: string };
  meta: RoutableMeta;
};

export type EngineStatus = {
  id: string;
  name: string;
  running: boolean;
  canStart: boolean;
  canStop: boolean;
  hint: string | null;
};

export type EngineResult = {
  ok: boolean;
  id: string;
  running?: boolean;
  detail?: string;
  error?: string;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  provider: string;
  kind: "local" | "cloud";
  sizeGb: number;
  format?: string;
  family?: string | null;
  parameters?: string | null;
  quantization?: string | null;
  installedAt?: string | null;
  path?: string;
};

export type DiscoveredProvider = {
  id: string;
  name?: string;
  kind: "local" | "cloud";
  endpoint: string | null;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  configured?: boolean;
  models: DiscoveredModel[];
};

export type RunningModel = {
  id: string;
  sizeGb: number;
  vramGb: number;
  expiresAt: string | null;
};

export type OnlineModel = {
  id: string;
  name: string;
  vendor: string;
  provider: string;
  kind: "local" | "cloud";
  category: string;
  format: string;
  params: string;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  url: string;
  pullRef: string | null;
  source: string;
  installedLocally?: boolean;
  /** Real download routes resolved by the desktop discovery layer. */
  sources?: ModelDownloadSource[];
  note?: string;
};

export type DiscoveryResult = {
  at: number;
  items: OnlineModel[];
  cached?: boolean;
  offline?: boolean;
  error?: string;
};

export type ModelInventory = {
  at: number;
  providers: DiscoveredProvider[];
  running: RunningModel[];
  roots: string[];
  totals: { providersOnline: number; models: number; localModels: number };
};

export type ProviderProbe = {
  id: string;
  online: boolean;
  latencyMs: number | null;
  error: string | null;
  models: number;
};

/** Streamed one-token chat through the same router the chat window uses. */
export type ProviderChatProbe = {
  ok: boolean;
  id: string;
  category: string;
  detail: string;
  latencyMs: number | null;
  stream?: boolean;
  usable?: number;
  display?: string;
  modelId?: string;
  list?: number;
};

export type ModelProbeRun = {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  firstTokenMs?: number | null;
  tokensPerSec?: number | null;
  promptTokensPerSec?: number | null;
  response?: string;
};

export type ModelPullProgress = {
  jobId: string;
  model: string;
  status: string;
  digest?: string | null;
  gbTotal?: number;
  gbDone?: number;
  progress?: number | null;
  speedMbps?: number;
  etaSeconds?: number;
};

export type DesktopPlugin = {
  id: string;
  name: string;
  version: string | null;
  description: string;
  permissions: string[];
  hooks: string[];
  enabled: boolean;
  loaded: boolean;
  tools: string[];
  commands: string[];
  error: string | null;
  path: string;
  github?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
};

export type PluginUpdatesResult = {
  ok: boolean;
  plugins?: DesktopPlugin[];
  updates?: DesktopPlugin[];
  error?: string;
};

export type PluginResult = { ok: boolean; plugin?: DesktopPlugin; error?: string };

export type UpdateProgress = {
  id?: string;
  phase: string;
  percent?: number;
  received?: number;
  total?: number;
  state?: string;
};

export type UpdateApplyResult = {
  ok: boolean;
  error?: string;
  kind?: string;
  id?: string;
  version?: string;
  backup?: string | null;
  target?: string;
  installer?: string;
  file?: string;
  sha256?: string;
  verified?: boolean;
  requiresApproval?: boolean;
  testBuild?: boolean;
  manual?: boolean;
  restartRequired?: boolean;
};

export type TelemetryLogEntry = {
  id?: string;
  at: number;
  level: string;
  source: string;
  message: string;
};

export type TelemetryIpcEntry = {
  id?: string;
  at: number;
  channel: string;
  ok: boolean;
  ms: number;
  error?: string;
  bytes?: number;
};

export type TelemetryFileInfo = {
  rel: string;
  size: number;
  mtime: number;
};

export type TelemetryFiles = {
  ok: boolean;
  dir?: string;
  files: TelemetryFileInfo[];
  error?: string;
};

export type TelemetrySnapshot = {
  at: number;
  logs: TelemetryLogEntry[];
  ipc: TelemetryIpcEntry[];
  perf: { at: number; rssMb: number; heapMb: number; uptimeSec: number; freeMemMb: number }[];
  counts: { logs: number; ipc: number; perf: number };
  file?: string | null;
};

const api = (): DesktopApi | undefined =>
  typeof window !== "undefined" ? (window.friday as unknown as DesktopApi | undefined) : undefined;

export const isDesktopApp = () => Boolean(api()?.isDesktop);

/** Raw bridge accessor for engines that need the real desktop operations. */
export const desktopApi = api;

/**
 * Single shared entry point for every bridge call the UI makes.
 *
 * A main-process handler that never settles used to leave the calling section
 * spinning forever, which looks exactly like a frozen window. Every call now
 * has a deadline, and identical in-flight calls share one round trip instead of
 * queueing duplicates behind a slow handler.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function safeCall<T>(
  key: string,
  run: () => Promise<T> | T | undefined,
  options: { timeoutMs?: number; fallback?: T } = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? 20000;
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T | null>;

  const call = (async (): Promise<T | null> => {
    try {
      const started = run();
      if (started === undefined) return (options.fallback ?? null) as T | null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guarded = await Promise.race([
        Promise.resolve(started),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${key} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      return (guarded ?? options.fallback ?? null) as T | null;
    } catch {
      return (options.fallback ?? null) as T | null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, call);
  return call;
}

export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const result = await api()?.checkUpdates?.();
  return result?.updates ?? [];
}

export function onUpdateProgress(cb: (p: UpdateProgress) => void): () => void {
  return api()?.onUpdateProgress?.(cb) ?? (() => {});
}

export async function restartApp(reason?: string): Promise<boolean> {
  return (await api()?.restartApp?.(reason)) ?? false;
}

/** Non-streaming call into the Python kernel; resolves null off the desktop. */
export async function kernelCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  const call = api()?.kernel;
  if (!call) return null;
  // Kernel unavailable or stalled: callers fall back to their local state
  // instead of leaving the section stuck on a loading placeholder.
  return safeCall<T>(`kernel:${method}:${JSON.stringify(params ?? {})}`, () =>
    call<T>(method, params),
  );
}

export async function listPlugins(): Promise<DesktopPlugin[]> {
  return (await api()?.listPlugins?.()) ?? [];
}

export async function checkPluginUpdates(): Promise<PluginUpdatesResult> {
  return (await api()?.checkPluginUpdates?.()) ?? { ok: false, plugins: [], updates: [] };
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  return (await api()?.setPluginEnabled?.(id, enabled)) ?? { ok: false, error: "Desktop only" };
}

export async function reloadPlugin(id: string) {
  return (await api()?.reloadPlugin?.(id)) ?? { ok: false, error: "Desktop only" };
}

export async function installPluginFolder() {
  return (await api()?.installPlugin?.()) ?? { ok: false, error: "Desktop only" };
}

export async function invokePlugin<T = unknown>(
  id: string,
  command: string,
  args?: Record<string, unknown>,
) {
  return (
    (await api()?.invokePlugin?.<T>(id, command, args)) ?? { ok: false, error: "Desktop only" }
  );
}

export async function applyUpdate(update: UpdateInfo): Promise<UpdateApplyResult> {
  return (await api()?.applyUpdate?.(update)) ?? { ok: false, error: "Desktop only" };
}

export async function rollbackUpdate(entry: { backup: string; target: string }) {
  return (await api()?.rollbackUpdate?.(entry)) ?? { ok: false, error: "Desktop only" };
}

export async function telemetrySnapshot(): Promise<TelemetrySnapshot | null> {
  return (await api()?.telemetrySnapshot?.()) ?? null;
}

export async function telemetryClear(): Promise<{ ok: boolean }> {
  return (await api()?.telemetryClear?.()) ?? { ok: false };
}

export async function telemetryFiles(): Promise<TelemetryFiles> {
  return (await api()?.telemetryFiles?.()) ?? { ok: false, files: [] };
}

export async function telemetryReadFile(rel: string) {
  return (await api()?.telemetryReadFile?.(rel)) ?? { ok: false, error: "Desktop only" };
}

export function onTelemetryLog(cb: (entry: TelemetryLogEntry) => void): () => void {
  return api()?.onTelemetryLog?.(cb) ?? (() => {});
}

export function onTelemetryIpc(cb: (entry: TelemetryIpcEntry) => void): () => void {
  return api()?.onTelemetryIpc?.(cb) ?? (() => {});
}

export function onTelemetryCleared(cb: (payload: { at: number }) => void): () => void {
  return api()?.onTelemetryCleared?.(cb) ?? (() => {});
}

export function onKernelLog(cb: (payload: { level: string; text: string }) => void): () => void {
  return api()?.onKernelLog?.(cb) ?? (() => {});
}

export function onKernelExit(cb: (payload: { code: number }) => void): () => void {
  return api()?.onKernelExit?.(cb) ?? (() => {});
}

export function onKernelRecover(
  cb: (payload: {
    phase: "trying" | "recovered" | "failed";
    attempt?: number;
    attempts?: number;
    maxAttempts?: number;
    delayMs?: number;
    code?: number | null;
    message: string;
    steps?: string[];
  }) => void,
): () => void {
  return api()?.onKernelRecover?.(cb) ?? (() => {});
}

export async function detectProviders(): Promise<DetectedProvider[]> {
  const result = await api()?.detectProviders?.();
  return result?.providers ?? [];
}

export async function detectComponents(): Promise<DetectedComponent[]> {
  const result = await api()?.detectComponents?.();
  return result?.components ?? [];
}

export async function repairWorkspace(): Promise<WorkspaceScanResult | null> {
  return (await api()?.repairWorkspace?.()) ?? null;
}

export function revealWorkspaceFolder(relative?: string) {
  void api()?.revealWorkspaceFolder?.(relative);
}

export async function libraryReveal(id: string) {
  return (await api()?.libraryReveal?.(id)) ?? false;
}

/** Native folder picker. Does not change the Folders / FRIDAY_ROOT pointer. */
export async function pickFolder(): Promise<string | null> {
  return (await api()?.pickFolder?.()) ?? null;
}

/** Project Open folder. Same native dialog family, never calls workspace:set. */
export async function pickProjectFolder(): Promise<string | null> {
  const desktop = api();
  if (desktop?.projectPickFolder) return desktop.projectPickFolder();
  return pickFolder();
}

/** Detected CPU/GPU/RAM and the acceleration plan (desktop only). */
export function useHardware() {
  const [hardware, setHardware] = useState<DetectedHardware | null>(null);

  useEffect(() => {
    let active = true;
    void api()
      ?.detectHardware?.()
      .then((hw) => {
        if (active && hw) setHardware(hw);
      });
    return () => {
      active = false;
    };
  }, []);

  return hardware;
}

/** Pending-restart state owned by the main process (deduplicated reasons). */
export type RestartState = {
  required: boolean;
  reasons: { reason: string; at: number }[];
};

/** One WMI-backed sensor reading; `available: false` means "unavailable", not an error. */
export type SensorReading = { available: boolean; value: string | null; reason: string | null };

export type SystemSensors = {
  detectedAt: number;
  motherboard: SensorReading;
  bios: SensorReading;
  battery: SensorReading;
  temperature: SensorReading;
  uptime: SensorReading;
};

/**
 * Motherboard / BIOS / battery / temperature. Windows-only (WMI); anywhere
 * else every field comes back unavailable so the UI can grey it out instead of
 * inventing a value.
 */
export function useSystemSensors(): SystemSensors | null {
  const [sensors, setSensors] = useState<SystemSensors | null>(null);

  useEffect(() => {
    let active = true;
    const read = () =>
      void (api() as unknown as { detectSensors?: () => Promise<SystemSensors | null> } | null)
        ?.detectSensors?.()
        .then((data) => {
          if (active && data) setSensors(data);
        })
        .catch(() => {});
    read();
    // Uptime/battery move slowly — one refresh a minute is enough and keeps
    // the UI thread free.
    const timer = setInterval(read, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return sensors;
}

export type SecurityItem = {
  id: string;
  label: string;
  state: "on" | "off" | "partial" | "unknown";
  detail: string | null;
};

export type WindowsSecurity = {
  detectedAt: number;
  supported: boolean;
  items: SecurityItem[];
};

type SecurityApi = {
  detectSecurity?: () => Promise<WindowsSecurity | null>;
  openWindowsSecurity?: () => Promise<{ ok: boolean }>;
};

/**
 * Real Windows Security posture (Defender, firewall, SmartScreen, BitLocker,
 * Hello). Anything the OS refuses to report stays "unknown" — never a
 * decorative "Enabled".
 */
export function useWindowsSecurity() {
  const [security, setSecurity] = useState<WindowsSecurity | null>(null);

  useEffect(() => {
    let active = true;
    const read = () =>
      void (api() as unknown as SecurityApi | null)
        ?.detectSecurity?.()
        .then((data) => {
          if (active && data) setSecurity(data);
        })
        .catch(() => {});
    read();
    // Security posture changes rarely; a slow refresh keeps PowerShell idle.
    const timer = setInterval(read, 300_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const open = useCallback(() => {
    void (api() as unknown as SecurityApi | null)?.openWindowsSecurity?.();
  }, []);

  return { security, open, supported: isDesktopApp() };
}

/** Boot sequence steps streamed by the main process (desktop only). */
let bootDismissed = false;

export function useBootSequence() {
  const [steps, setSteps] = useState<BootStep[]>([]);
  // Shown once per launch — navigating between sections must never re-open it.
  const [done, setDone] = useState(() => bootDismissed || !isDesktopApp());

  useEffect(() => {
    const desktop = api();
    if (!desktop) return;
    void desktop.getBootSteps?.().then((s) => s?.length && setSteps(s));
    const off = desktop.onBootStep?.((step) =>
      setSteps((prev) => (prev.some((p) => p.at === step.at) ? prev : [...prev, step])),
    );
    if (bootDismissed) return () => off?.();
    const timer = setTimeout(() => {
      bootDismissed = true;
      setDone(true);
    }, 2600);
    return () => {
      off?.();
      clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    bootDismissed = true;
    setDone(true);
  };

  return { steps, done, dismiss };
}

/* -------------------------------------------------------- workspace store */
/**
 * One workspace scan per launch, shared by every screen. Scanning walks the
 * whole workspace, so remounting the shell (which happens on every navigation)
 * must not trigger a new one — that was the source of the click-to-click
 * freezes. Refreshes are explicit, or pushed by the main process.
 */
let scanState: WorkspaceScanResult | null = null;
let scanRequested = false;
const scanListeners = new Set<() => void>();

function publishScan(next: WorkspaceScanResult | null) {
  scanState = next;
  scanListeners.forEach((l) => l());
}

const subscribeScan = (listener: () => void) => {
  scanListeners.add(listener);
  return () => scanListeners.delete(listener);
};

/** Non-React access to the same shared scan (used by the capability registry). */
export function getWorkspaceScan(): WorkspaceScanResult | null {
  return scanState;
}

/** Non-React subscription to the same shared scan. */
export function onWorkspaceScanChange(listener: () => void): () => void {
  scanListeners.add(listener);
  return () => scanListeners.delete(listener);
}

/** Ask the main process for a fresh scan of the current workspace. */
export async function refreshWorkspaceScan(force = true): Promise<WorkspaceScanResult | null> {
  const result = (await api()?.scanWorkspace?.(force)) ?? null;
  if (result) publishScan(result);
  return result;
}

/** Read-only access to the shared scan — never starts one on its own. */
export function useWorkspaceScan(): WorkspaceScanResult | null {
  return useSyncExternalStore(
    subscribeScan,
    () => scanState,
    () => null,
  );
}

/** Live workspace state + hot-reload toasts. Mount once, in the app shell. */
export function useDesktopRuntime() {
  const scan = useWorkspaceScan();

  useEffect(() => {
    const desktop = api();
    if (!desktop) return;

    if (!scanRequested) {
      scanRequested = true;
      void desktop.scanWorkspace?.(false).then((s) => s && publishScan(s));
    }
    const offScan = desktop.onWorkspaceScan?.(publishScan);

    // One persistent notice for restarts (id: "restart-required") instead of a
    // prompt per file event — the main process keeps the authoritative set of
    // reasons, so navigating away never loses or duplicates it.
    const showRestartNotice = (state: RestartState) => {
      if (!state?.required) return;
      const first = state.reasons[0]?.reason ?? "a startup file changed";
      toast("Restart needed to finish applying changes", {
        id: "restart-required",
        duration: Infinity,
        description:
          state.reasons.length > 1 ? `${first} +${state.reasons.length - 1} more` : first,
        action: {
          label: "Restart now",
          onClick: () => void (desktop.restartApp ?? desktop.confirmRestart)?.(first),
        },
      });
    };
    void desktop.restartState?.().then(showRestartNotice);
    const offRestart = desktop.onRestartRequired?.(showRestartNotice);

    const offChange = desktop.onWorkspaceChange?.((change) => {
      if (change.restartRequired) return; // handled by the restart notice above
      // Hot reloads are routine while FRIDAY runs; report them quietly and
      // collapse repeats for the same component into one toast.
      toast.success(`${change.component} reloaded`, {
        id: `reloaded-${change.component}`,
        description: change.file || "Refreshed without restarting.",
      });
    });

    // Copying an existing folder to a new one is a real disk operation: the
    // user sees it progress and is told where the old copy was left.
    const offMigrate = desktop.onWorkspaceMigrate?.((event) => {
      if (event.phase === "start") {
        toast.loading("Moving your FRIDAY data to the new folder…", {
          id: "workspace-migrate",
          description: `${event.from} -> ${event.to}`,
        });
      } else if (event.phase === "copy") {
        toast.loading(`Copying ${event.folder}…`, {
          id: "workspace-migrate",
          description: `${event.from} -> ${event.to}`,
        });
      } else if (event.phase === "done") {
        toast.success("Your FRIDAY data was copied to the new folder", {
          id: "workspace-migrate",
          duration: 12000,
          description: `Copied ${(event.copied || []).join(", ")}. The old folder ${event.from} was left in place — delete it yourself once the new one looks right.`,
        });
      } else {
        toast.error("Some data could not be copied", {
          id: "workspace-migrate",
          duration: 20000,
          description: `${(event.failed || []).map((f) => `${f.folder}: ${f.error}`).join("; ")}. Your old folder ${event.from} is untouched.`,
        });
      }
    });

    // Unexpected kernel crash: auto-restart with backoff. Same toast id so
    // retries collapse into one notice instead of stacking alarms.
    const offKernelRecover = desktop.onKernelRecover?.((event) => {
      if (event.phase === "trying") {
        toast("Local AI service stopped — restarting…", {
          id: "kernel-recover",
          description: event.message,
        });
      } else if (event.phase === "recovered") {
        toast.success("Local AI service recovered", {
          id: "kernel-recover",
          description: event.message,
        });
      } else {
        void import("./doctor-engine").then(({ formatGuidance, guidanceFor }) => {
          const check = {
            id: "kernel",
            label: "Python kernel bridge",
            group: "Services",
            status: "Error" as const,
            detail: event.message,
            cause: event.message,
            fixable: true,
            tried: true,
            ...(event.steps?.length ? { steps: event.steps } : {}),
          };
          const guidance = guidanceFor(check);
          toast.error("Local AI service could not restart", {
            id: "kernel-recover",
            duration: 20000,
            description: guidance
              ? formatGuidance(guidance)
              : `${event.message} Open Setup & Doctor to repair it.`,
          });
        });
      }
    });

    return () => {
      offScan?.();
      offChange?.();
      offMigrate?.();
      offRestart?.();
      offKernelRecover?.();
    };
  }, []);

  return scan;
}

/* ------------------------------------------------------- first-run gating */
let rootState: string | null | undefined;
const rootListeners = new Set<() => void>();

const publishRoot = (next: string | null) => {
  rootState = next;
  rootListeners.forEach((l) => l());
};

/**
 * The workspace root, or null when FRIDAY has not been pointed at a folder
 * yet. `undefined` means "still asking the main process", so the UI can wait
 * instead of flashing the setup screen.
 */
export function useWorkspaceRootState(): string | null | undefined {
  const value = useSyncExternalStore(
    (l) => {
      rootListeners.add(l);
      return () => rootListeners.delete(l);
    },
    () => rootState,
    () => undefined,
  );

  useEffect(() => {
    if (rootState !== undefined) return;
    const desktop = api();
    if (!desktop?.getWorkspaceRoot) {
      publishRoot(
        typeof window === "undefined" ? null : window.localStorage.getItem("friday.workspaceRoot"),
      );
      return;
    }
    void desktop.getWorkspaceRoot().then((r) => publishRoot(r ?? null));
  }, []);

  return value;
}

/** Persist a newly chosen root and refresh everything that depends on it. */
export async function applyWorkspaceRoot(path: string): Promise<string> {
  const desktop = api();
  const saved = desktop?.setWorkspaceRoot ? await desktop.setWorkspaceRoot(path) : path;
  if (!desktop?.setWorkspaceRoot && typeof window !== "undefined") {
    window.localStorage.setItem("friday.workspaceRoot", saved);
  }
  publishRoot(saved);
  scanRequested = true;
  // The main process starts the scan in a worker. Do not hold the first-run
  // screen hostage while a very large workspace is being indexed.
  void refreshWorkspaceScan(true).catch(() => undefined);
  return saved;
}
