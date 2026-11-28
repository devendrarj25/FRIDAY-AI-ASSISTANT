/**
 * Desktop runtime wiring: boot sequence, workspace scan on startup, hot-reload
 * notifications, provider/component detection and user-confirmed updates.
 * In the browser preview `window.friday` is absent and every call resolves to
 * a no-op so the UI still renders.
 */
import {
  bootGate,
  computeBootProgress,
  creepPercent,
  type BootGate,
  type BootPlan,
} from "./boot-progress";
import type { SystemPressure } from "./system-pressure";
import type { SttProgressPayload } from "./voice-download";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ModelSource as ModelDownloadSource } from "./model-sources";

/**
 * Billing safety record, owned by the main process. A stored paid API key is
 * never permission to spend — these flags are.
 */
/** The owner's own voice (Settings -> Voice): what is recorded, what was built from it, and how a clip scored. */
export type VoiceEnrollCounts = {
  total: number;
  wakeTakes: number;
  speechClips: number;
  speechSeconds: number;
  byPrompt: Record<string, number>;
};

export type VoiceProfileSummary = {
  built: boolean;
  engine: string;
  evidence: string;
  /** How the owner usually sounds in their recordings; seeds the tone reading. */
  baseline?: {
    pitchHz: number;
    pitchSpreadSemitones: number;
    energyDbfs: number;
    clips: number;
  } | null;
  speaker?: {
    ready: boolean;
    reasons: string[];
    clips: number;
    seconds?: number;
    edge?: number;
    looMax?: number;
    looMedian?: number;
    shortClipP90?: number;
  };
  wake?: {
    ready: boolean;
    reasons: string[];
    takes: number;
    threshold?: number;
    margin?: number;
    positiveMax?: number;
    negativeMin?: number;
    heldOutRefusalRate?: number;
    negativeClips?: number;
    falseAcceptsOnOwnSentences?: number;
  };
};

export type VoiceEnrollStatus = {
  ok: boolean;
  folder: string;
  encryption: boolean;
  counts: VoiceEnrollCounts;
  samples: {
    id: string;
    kind: "wake" | "speech";
    promptId: string;
    durationMs: number;
    createdAt: number;
  }[];
  profile: { built: boolean; builtAt: number; stale: boolean; summary: VoiceProfileSummary | null };
};

export type VoicePrivacyStatus = {
  ok: boolean;
  /** The time the owner agreed to store a voice sample. No name or device is kept with it. */
  consent: { given: boolean; givenAt: number };
  enrolment: { samples: number; profile: boolean };
  /** Kept utterance clips: none unless the owner turned retention on. */
  wavs: { folder: string; count: number; bytes: number };
  retention: { keep: boolean; days: number };
  limits: { minDays: number; maxDays: number; defaultDays: number };
};

export type VoicePrivacyDeleteResult = {
  ok: boolean;
  reason?: string;
  detail?: string;
  removed?: { samples: number; profile: boolean; wavs: number; consent: boolean };
  left: string[];
  status?: VoicePrivacyStatus;
};

export type VoiceMatchResult = {
  ok: boolean;
  enrolled?: boolean;
  reason?: string;
  engine?: string;
  evidence?: string;
  speaker?: {
    enrolled: boolean;
    similarity: number | null;
    distance?: number;
    edge?: number;
    match: boolean;
    reason: string;
  } | null;
  wake?: {
    ready: boolean;
    matched: boolean;
    distance?: number;
    threshold?: number;
    reason: string;
  } | null;
};

/**
 * The measured facts about this PC (electron/hardware.cjs `hardwareFacts`): one object for the speech budget, the model
 * router and the "This PC" rows. A number is null when no probe measured it; nothing is guessed.
 */
export type HardwareFacts = {
  vramGb: number | null;
  vramFreeGb: number | null;
  ramGb: number | null;
  ramFreeGb: number | null;
  diskFreeGb: number | null;
  gpuVendor: string | null;
  gpuName: string | null;
  gpus: Array<{
    vendor: string;
    name: string | null;
    vramGb: number | null;
    /** True when vramGb is null only because the sole figure was the clipped 32-bit one (a card of at least that size). */
    vramCapped: boolean;
    driver: string | null;
    driverDate?: string | null;
    integrated?: boolean | null;
    computeCap?: string | null;
  }>;
  cudaReady: boolean;
  driverVersion: string | null;
  npu: boolean;
  /** Null when no processor reading was available. */
  cpuClass: "low" | "mid" | "high" | null;
  sources: string[];
  // The wider capability probes. Absent or null while they are still measuring; a field is null when no probe read it.
  os?: {
    platform: string | null;
    build: number | null;
    buildFull: string | null;
    name: string | null;
    displayVersion: string | null;
    edition: string | null;
    windows11: boolean | null;
    is64Bit: boolean | null;
    arch: string | null;
    webview2: boolean | null;
    vcRuntimeX64: boolean | null;
  };
  cpu?: {
    model: string | null;
    physicalCores: number | null;
    logicalCores: number | null;
    baseClockMhz: number | null;
    avx: boolean | null;
    avx2: boolean | null;
    avx512: boolean | null;
    fma: boolean | null;
  };
  memory?: {
    pressure: "ok" | "high" | "critical" | null;
    commitPressure: "ok" | "high" | "critical" | null;
    commitLimitGb: number | null;
    commitFreeGb: number | null;
    pagefileGb: number | null;
  };
  drives?: Array<{
    letter: string | null;
    totalGb: number | null;
    freeGb: number | null;
    media: "ssd" | "hdd" | "scm" | null;
    bus: string | null;
    holdsDataRoot: boolean;
    holdsModelCache: boolean;
  }>;
  dataRootDrive?: string | null;
  modelCacheDrive?: string | null;
  vulkan?: boolean | null;
  cuda?: {
    driverCuda: string | null;
    cublas12: boolean | null;
    cudnn9: boolean | null;
    runtimeFilesFound: boolean | null;
  };
  network?: {
    online: boolean | null;
    type: "wifi" | "ethernet" | "cellular" | "unknown" | null;
    metered: boolean | null;
    roaming: boolean | null;
    latencyMs: number | null;
  };
  power?: {
    batteryPresent: boolean | null;
    batteryPercent: number | null;
    onAc: boolean | null;
    planName: string | null;
    batterySaver: boolean | null;
    thermal: "nominal" | "fair" | "serious" | "critical" | null;
  };
  /** Stable reason codes; the page words them. */
  health?: { level: "ok" | "tight" | "critical"; reasons: string[] };
};

/** Can this PC run a catalogue row (electron/engine-fit.cjs `classify`). */
export type EngineFit = {
  state: "supported" | "limited" | "unsupported";
  /** Stable codes (the UI words them) with a short human text; `level` says whether it blocks, limits or informs. */
  reasons: { code: string; text: string; level: "block" | "limit" | "info" }[];
  needs: {
    ramGb: number | null;
    vramGb: number | null;
    diskGb: number | null;
    cuda: boolean;
    driverMin: string | null;
    vulkan: boolean;
    avx2: boolean;
    network: boolean;
    downloadGb: number | null;
  };
  recommended: boolean;
  /** The row to use instead when this one is limited or unsupported. */
  alternative?: string;
};

export type InstallerUpdateStatus = "current" | "update" | "unknown" | "error";

/** One Install Manager row in the catalogue (electron/installer-catalog.cjs `snapshot`). */
export type InstallerCatalogRow = {
  id: string;
  kind: "tool" | "engine" | "runtime-pack" | "voice-model" | "model";
  name: string;
  category: string;
  optional: boolean;
  /** Null while the scan has not looked yet. */
  installed: boolean | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateStatus: InstallerUpdateStatus;
  /** Voice rows: which source served the installed files ("FRIDAY release" or "official source"); absent or null when unknown. */
  servedFrom?: string | null;
  /** A matching copy found in a local build of FRIDAY (Install Manager shows it); absent when there is none. */
  localSource?: { origin: string; dir: string };
  /** A row derived from a release asset that is not published yet: nothing to download until it is. */
  needsRelease?: boolean;
  /** Plain words for the row when needsRelease is true. */
  note?: string;
  /** The official source that answered (github-api, github-atom, pypi-json, pypi-simple, hf-api, npm, feed, pinned). */
  source: string | null;
  checkedAt: number | null;
  /** True when the version is the last cached answer and the sources could not be reached. */
  stale: boolean;
  /** The version is the catalogue's own pin, not a fresh answer. */
  pinnedAnswer: boolean;
  error?: string;
  /** Where a tool lives: friday-root, machine, npm-global (others are shown by nobody). */
  home?: string;
  /** The row only shows a newer version; FRIDAY never updates it. */
  notifyOnly?: boolean;
  /** Tool rows: false until the catalogue holds a published checksum, so FRIDAY cannot install it itself. */
  downloadReady?: boolean;
  /** How the newest version was reached, when the row says so. */
  via?: "primary" | "fallback" | "cache" | "pinned";
  /** The model host's newest revision when it differs from the pinned one FRIDAY installs. */
  upstreamVersion?: string;
  fit: EngineFit;
  /** llama.cpp and stable-diffusion.cpp: the builds this PC would use, best first, and the installed one. */
  engine?: {
    chain: ("cuda" | "rocm" | "vulkan" | "cpu")[];
    skipped: { backend: string; reason: string }[];
    active: {
      installed: boolean;
      version?: string;
      backend?: string | null;
      fellBack?: { backend: string; stage: string; reason: string }[];
    } | null;
  };
};

export type InstallerDoctorRow = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  repair: { id: string; action: "install" | "repair" } | null;
};

/** One item setup could not finish (<root>/runtime/setup-notices.json), with the catalogue row or Doctor row that finishes it. */
export type SetupNoticeRow = {
  id: string;
  kind: string;
  label: string;
  reason: string;
  /** The row id the notice names: `voice:<id>`, `model:ollama:<tag>`, `pack:...`, or a Doctor id (`cuda-libs`). */
  installManagerId: string;
  /** The terminal command that repairs it. */
  repair: string;
  at: string;
  /** The catalogue row with `installManagerId`, or null. */
  rowId: string | null;
  /** The Doctor row with `installManagerId`, or null. */
  doctorId: string | null;
};

export type InstallerCatalog = {
  ok: boolean;
  generatedAt: number;
  refreshing: boolean;
  lastRefreshAt: number | null;
  /** Milliseconds until a manual refresh is allowed again (0 now). */
  nextManualRefreshInMs: number;
  online: boolean | null;
  privacy: boolean;
  /** False until a hardware probe answered; every fit reads "limited (unknown)" until then. */
  hardwareKnown: boolean;
  oldestCheckedAt: number | null;
  lastError: string | null;
  rows: InstallerCatalogRow[];
  /** Row ids by fit state, for the three lists the page shows. */
  split: { supported: string[]; limited: string[]; unsupported: string[] };
  counts: { rows: number; updates: number; errors: number; stale: number };
  doctor: InstallerDoctorRow[];
  /** What setup could not finish and is still open; an installed item is cleared before this is sent. */
  setupNotices?: SetupNoticeRow[];
};

export type InstallerRefreshResult = {
  started: boolean;
  running?: boolean;
  reason?: string;
  retryInMs?: number;
};

export type InstallerUpdateRequest = {
  id: string;
  /** The autonomy dial: Ask every time, Balanced or Full. Anything else reads as Ask. */
  autonomy: "ask" | "balanced" | "full";
  /** The owner's yes for this one update. */
  consent?: { granted: boolean };
};

export type InstallerUpdateResult = {
  ok: boolean;
  allowed?: boolean;
  needsConsent?: boolean;
  reason?: string;
  via?: "consent" | "full-autonomy";
  error?: string;
};

/** One item of "Use local builds": what happened to a file or folder a build on this PC holds. */
export type InstallerAdoptItem = {
  id: string;
  origin: string;
  result: "adopted" | "in-place" | "skipped";
  reason?: string;
};

/** The answer of `installer:adopt-local` (electron/main.cjs): the per-item rows, the sources read and what was swept. */
export type InstallerAdoptResult = {
  ok: boolean;
  off?: boolean;
  error?: string;
  items: InstallerAdoptItem[];
  sources: string[];
  swept?: string[];
  failed?: { item: string; error: string }[];
};

/** The resource governor's read-only status (electron/resource-governor.cjs `status`). */
export type GovernorStatus = {
  ok: boolean;
  error?: string;
  level: "ok" | "high" | "critical";
  notice: string | null;
  memory: { freeMb: number; totalMb: number; level: string } | null;
  vram: { freeMb: number; totalMb: number; level: string } | null;
  lag: { p99Ms: number; maxMs: number; paused: boolean };
  power: { stress: "none" | "battery" | "saver" | "thermal"; preferSmall: boolean };
  holds: string[];
  leases: Array<{
    id: string;
    owner: string;
    kind: string;
    priority: "voice" | "chat" | "background" | "prefetch";
    state: string;
    vramMb: number;
    ramMb: number;
    ageMs: number;
  }>;
  queued: Array<{ owner: string; priority: string; reason?: string; resume?: boolean }>;
  jobs: Record<
    string,
    { running: number; queued: number; cap: number; maxQueue: number; saturated: boolean }
  >;
  actions: Array<{ at: number; kind: string; detail: string }>;
};

/** What this PC can carry for speech (electron/voice-weights.cjs `budgetForProbe`). */
export type VoiceBudget = {
  ok: boolean;
  profile: string;
  sttSize: string;
  sttDevice: string;
  maxResidentModels: number;
  speechBudgetGb: number;
  idleUnloadMs: number;
  notes: string[];
  /** Present when an NVIDIA driver was found but the speech kernel did not confirm cuBLAS 12 and cuDNN 9. */
  gpuUpgrade?: { needs: "cuda-runtime"; vramGb: number; detail: string };
};

/** The speech worker's own account of what it holds (electron/stt.cjs `workerCacheOf`). */
export type SttWorkerCache = {
  loadedModels: Array<{ name: string; engine: string; loadMs: number | null }>;
  idleSec: number | null;
  unloadCount: number;
  memory: {
    level: "ok" | "high" | "critical";
    known: boolean;
    availableMb: number | null;
    totalMb: number | null;
  };
  fallbacks: { total: number; byKind: Record<string, number> };
};

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
  /** The boot-plan stage this step finishes (electron/boot-plan.cjs); a detail line has none. */
  stage?: string | null;
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
  /** Free space on the drive models are stored on; null when it could not be read. */
  disk?: { path: string; freeGb: number; totalGb: number } | null;
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
  /** Stop everything, told to the main process in the same tick: true when it took the signal, false when refused. */
  signalHalted?: (halted: boolean) => boolean;
  /** Publish the nav/feature registry so the phone companion mirrors it. */
  publishCompanionFeatures?: (
    payload: unknown[] | { features: unknown[]; capabilities: unknown[]; live?: unknown },
  ) => Promise<{ ok: boolean; count?: number }>;
  companionRemote?: () => Promise<CompanionRemoteState>;
  setCompanionRemote?: (enabled: boolean) => Promise<CompanionRemoteState>;
  paths?: () => Promise<{
    install: string;
    userData: string;
    workspace: string | null;
    checkout?: { checkout: boolean; message: string };
    kernelPort?: number;
    /** True for the portable EXE: no start at sign-in, no tray or background after its window is closed. */
    portable?: boolean;
    /** The portable EXE's own settings and data folder; empty for an installed FRIDAY. */
    portableHome?: string;
  }>;

  getBootSteps?: () => Promise<BootStep[]>;
  getBootPlan?: () => Promise<BootPlan>;
  onBootStep?: (cb: (s: BootStep) => void) => () => void;
  scanWorkspace?: (force?: boolean) => Promise<WorkspaceScanResult | null>;
  pickFolder?: () => Promise<string | null>;
  realtimeOpen?: (id: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  realtimeSend?: (id: string, event: unknown) => Promise<{ ok: boolean; error?: string }>;
  realtimeClose?: (id: string) => Promise<{ ok: boolean }>;
  onRealtimeOpened?: (cb: (payload: { id: string }) => void) => () => void;
  onRealtimeEvent?: (cb: (payload: { id: string; event: { type: string } }) => void) => () => void;
  onRealtimeClosed?: (cb: (payload: { id: string; reason: string }) => void) => () => void;
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
  hardwareFacts?: (
    force?: boolean,
  ) => Promise<{ ok: boolean; facts?: HardwareFacts; error?: string }>;
  installerCatalog?: () => Promise<InstallerCatalog>;
  refreshInstallerCatalog?: () => Promise<InstallerRefreshResult>;
  adoptLocalBuilds?: () => Promise<InstallerAdoptResult>;
  updateInstallerRow?: (request: InstallerUpdateRequest) => Promise<InstallerUpdateResult>;
  governorStatus?: () => Promise<GovernorStatus>;
  onGovernorNotice?: (cb: (notice: { line: string }) => void) => () => void;
  checkUpdates?: () => Promise<{ checkedAt: number; updates: UpdateInfo[] }>;
  applyUpdate?: (update: UpdateInfo) => Promise<UpdateApplyResult>;
  rollbackUpdate?: (entry: {
    backup: string;
    target: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onUpdateProgress?: (cb: (p: UpdateProgress) => void) => () => void;
  confirmRestart?: (reason: string) => Promise<boolean>;
  restartApp?: (reason?: string) => Promise<boolean>;
  shutdownApp?: (reason?: string) => Promise<boolean>;
  lifecyclePreview?: () => Promise<{
    tasks?: number;
    downloads?: number;
    listening?: boolean;
    auto?: boolean;
    agents?: number;
  }>;
  restartState?: () => Promise<RestartState>;
  onRestartRequired?: (cb: (state: RestartState) => void) => () => void;
  kernel?: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  listPlugins?: () => Promise<DesktopPlugin[]>;
  checkPluginUpdates?: () => Promise<PluginUpdatesResult>;
  pluginInsights?: () => Promise<PluginInsight[]>;
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
    refresh?: {
      skipped?: string | null;
      applied?: string[];
      kept?: Array<{ id: string; reason: string }>;
    };
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
  /** Cloud speech (Sarvam, Azure Speech). The main process makes the request; no key reaches the renderer. */
  voiceCloudSpeak?: (
    provider: string,
    request: {
      text: string;
      language: string;
      speaker?: string;
      pace?: number;
      sensitiveReply?: boolean;
    },
  ) => Promise<{ ok: boolean; error?: string; audioBase64?: string; mime?: string }>;
  voiceCloudTranscribe?: (
    provider: string,
    request: { audioBase64: string; language?: string; hinglish?: boolean },
  ) => Promise<{ ok: boolean; error?: string; text?: string; language?: string | null }>;
  voiceCloudKeyStatus?: () => Promise<Record<string, boolean>>;
  /** Streaming speech (Sarvam realtime STT and TTS). The main process owns the socket and the key. */
  voiceStreamOpen?: (
    id: string,
    kind: "stt" | "tts",
    options: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string; opened?: boolean }>;
  voiceStreamSend?: (
    id: string,
    message: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  voiceStreamClose?: (id: string) => Promise<{ ok: boolean }>;
  onVoiceStreamOpened?: (cb: (payload: { id: string }) => void) => () => void;
  onVoiceStreamEvent?: (
    cb: (payload: { id: string; event: { type: string } }) => void,
  ) => () => void;
  onVoiceStreamClosed?: (
    cb: (payload: { id: string; code: number; retry: boolean; reason: string }) => void,
  ) => () => void;
  voiceCloudSaveKey?: (
    provider: string,
    key: string,
  ) => Promise<{ ok: boolean; error?: string; stored?: boolean }>;
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
  /** A file picker for model files (or a folder of them), not the workspace folder picker. */
  pickModelFiles?: (mode?: "file" | "folder") => Promise<{
    ok: boolean;
    cancelled?: boolean;
    paths: string[];
  }>;
  /** Check, store and register a model the owner already has; ready only after a test answer. */
  importModel?: (payload: {
    id: string;
    path: string;
    name?: string;
  }) => Promise<ModelImportResult>;
  onModelImportProgress?: (cb: (event: ModelImportProgress) => void) => () => void;
  /** The real disk path of a dropped File. */
  pathForFile?: (file: File) => string;
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
  checkLauncherRelease?: (id: string) => Promise<{
    ok: boolean;
    updateAvailable?: boolean;
    label?: string;
    ageDays?: number | null;
    storedSha256?: string | null;
    offeredSha256?: string | null;
    wouldReplaceSha256?: boolean;
    autoInstall?: boolean;
    canRun?: boolean;
    reason?: string;
  }>;
  listTransfers?: () => Promise<{
    ok: boolean;
    jobs: Array<{
      id: string;
      modelId: string;
      status: string;
      sourceUrl: string;
      bytes: number;
      done: number;
      error: string;
    }>;
  }>;
  transferModel?: (
    jobId: string,
    action: "pause" | "resume" | "cancel",
  ) => Promise<{ ok: boolean; status?: string; error?: string }>;
  removeModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  unloadModel?: (model: string) => Promise<{ ok: boolean; error?: string }>;
  probeModel?: (model: string, prompt?: string) => Promise<ModelProbeRun>;
  /** Models this machine can actually route to right now, best first. */
  routableModels?: (force?: boolean) => Promise<{ at: number; models: RoutableModel[] }>;
  catalogueStatus?: () => Promise<{
    summary: string;
    freshness: string;
    changes: string[];
    notes: string[];
    providers: string[];
    privacy: boolean;
  }>;
  catalogueRefresh?: () => Promise<{
    refreshed: boolean;
    plan?: { reason?: string };
    knowledge?: {
      skipped?: string | null;
      applied?: string[];
      kept?: Array<{ id?: string; reason?: string }>;
    };
  }>;
  knowledgeStatus?: () => Promise<KnowledgeStatusRow[]>;
  verifyCapabilities?: (
    modelId?: string,
  ) => Promise<{ ok: boolean; reason?: string; refused?: boolean }>;
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
  /** On-device speech-to-text (FRIDAY Ear) run by the main process. */
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
    moonshineReady?: boolean;
    windowsSpeech?: boolean;
    hinglishEarTrelisReady?: boolean;
    hinglishEarSkipped?: string;
    dependency?: string;
    worker?: string;
    inference?: string;
    loadCount?: number;
    /** What the speech worker holds right now; null while no worker is up or an older worker sends none. */
    cache?: SttWorkerCache | null;
  }>;
  onSttProgress?: (cb: (payload: SttProgressPayload) => void) => () => void;
  installStt?: (options?: { upgrade?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    skippedInstall?: boolean;
    updateAvailable?: boolean;
  }>;
  restartKernel?: () => Promise<{ ok: boolean }>;
  transcribe?: (payload: {
    audioBase64?: string;
    audioBytes?: Uint8Array;
    mime?: string;
    language?: string | undefined;
    model?: string;
    localOnly?: boolean;
    initialPrompt?: string;
    hotwords?: string;
    multilingual?: boolean;
    /** The opt-in large Hinglish ear; nothing is sent when it is off. */
    hinglishEar?: "trelis";
    speechPref?: string;
    sttSize?: string;
    keepWav?: boolean;
    /** A not-final read of the audio so far: never counted or recorded, and it alone can be cancelled. */
    provisional?: boolean;
    utteranceId?: string;
  }) => Promise<{
    ok: boolean;
    text?: string;
    error?: string;
    reason?: string;
    cancelled?: boolean;
    final?: boolean;
    language?: string;
    noSpeechProb?: number;
    turnProbability?: number | null;
    engine?: string;
    emptyReason?: string;
    audio?: {
      durationMs?: number;
      rmsDbfs?: number | null;
      peakDbfs?: number | null;
      denoisedRmsDbfs?: number | null;
      denoisedPeakDbfs?: number | null;
      vadMs?: number | null;
      noSpeechProb?: number | null;
      model?: string;
      device?: string;
      compute?: string;
      language?: string;
      promptUsed?: boolean;
      emptyReason?: string;
      denoiseNote?: string;
    } | null;
  }>;
  /** Cancel a provisional decode (no id: all). The worker keeps running; only the speculative read stops. */
  cancelTranscribe?: (payload: {
    utteranceId?: string;
  }) => Promise<{ ok: boolean; cancelled?: boolean; signalled?: boolean }>;
  scoreTurn?: (payload: {
    audioBytes?: Uint8Array;
    audioBase64?: string;
    mime?: string;
  }) => Promise<{ ok: boolean; ready?: boolean; probability?: number | null; reason?: string }>;
  /**
   * FRIDAY's own streaming ear (voice.streamEngine). Local only, one stream at a time, three quick calls, no push
   * channel. Every refusal is `{ ok: false, fallback: true, reason }` and never a throw; a reply with `fallback`
   * means the stream is over, so use `transcribe`. Reasons: off, bad-engine, busy, worker, no-stream, bad-audio,
   * too-large, aborted, plus the worker's own (weights-missing, locale-unsupported, open-failed, ...).
   */
  openSttStream?: (payload: {
    streamId?: string;
    streamEngine: "off" | "auto" | "nemotron" | "stream-ear-nemotron";
    locale: "hi" | "en" | "hi-en" | "";
    hotwords?: string[];
    endpoint?: boolean;
    localOnly?: boolean;
  }) => Promise<{
    ok: boolean;
    streamId?: string;
    engine?: string;
    locale?: string;
    chunkMs?: number;
    loadMs?: number;
    fallback?: boolean;
    reason?: string;
  }>;
  /** `pcm` is base64 of int16 little-endian 16 kHz mono, one chunk of 80 to 320 ms. */
  feedSttStream?: (payload: { streamId: string; pcm: string }) => Promise<{
    ok: boolean;
    streamId?: string;
    /** partial: text, committed, stable, volatile, newlyCommitted, revision, audioMs; endpoint: event, reason, silenceMs. */
    events?: { type: "partial" | "endpoint"; [key: string]: unknown }[];
    text?: string;
    committed?: string;
    audioMs?: number;
    /** The endpointer's current verdict: `event` is null until the turn is judged over. */
    endpoint?: {
      event?: string | null;
      requiredWaitMs?: number;
      reason?: string;
      inTurn?: boolean;
      audioMs?: number;
    };
    fallback?: boolean;
    reason?: string;
  }>;
  closeSttStream?: (payload: { streamId: string; finalize?: boolean }) => Promise<{
    ok: boolean;
    streamId?: string;
    final?: boolean;
    text?: string;
    committed?: string;
    words?: { text: string; startMs?: number; endMs?: number }[];
    audioMs?: number;
    rtf?: number;
    fallback?: boolean;
    reason?: string;
  }>;
  duckAudio?: (payload: {
    on: boolean;
  }) => Promise<{ ok: boolean; ducked?: boolean; reason?: string }>;
  /** Echo-canceller measurement for one 160 ms chunk (base64 int16 mono 16 kHz). Levels only, never audio. */
  echoShadow?: (payload: { mic: string; ref?: string; reset?: boolean; seq?: number }) => Promise<{
    ok: boolean;
    ready?: boolean;
    playing?: boolean;
    cancelled?: boolean;
    micDb?: number;
    residualDb?: number;
    reductionDb?: number | null;
    delayMs?: number;
    confidence?: number;
    gate?: false;
    seq?: number;
    reason?: string;
  }>;
  /** Drop a hung local speaker so the next clause starts a fresh one. `error` is short and path-free. */
  restartTts?: () => Promise<{
    ok: boolean;
    state: "restarted" | "not-running" | "breaker-open" | "error";
    error?: string;
  }>;
  /** Windows' own microphone privacy answer for this app (`unknown` when the platform cannot say). */
  micAccessStatus?: () => Promise<{
    ok: boolean;
    status: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  }>;
  /** Opens the microphone privacy page in Windows Settings (that one page only). */
  openMicPrivacySettings?: () => Promise<{ ok: boolean; error?: "refused" | "open-failed" }>;
  meetingStatus?: () => Promise<{
    ok?: boolean;
    meeting?: boolean;
    names?: string[];
    reason?: string;
  }>;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  voiceprintStatus?: () => Promise<{ ok?: boolean; enrolled?: boolean; reason?: string }>;
  clearVoiceprint?: () => Promise<{
    ok?: boolean;
    enrolled?: boolean;
    removed?: number;
    bytes?: number;
    failed?: number;
  }>;
  voiceEnrollStatus?: () => Promise<VoiceEnrollStatus>;
  voiceEnrollSaveSample?: (payload: {
    id: string;
    kind: "wake" | "speech";
    promptId: string;
    text: string;
    language: string;
    wavBytes: Uint8Array;
  }) => Promise<{ ok: boolean; reason?: string; detail?: string; counts?: VoiceEnrollCounts }>;
  voiceEnrollDeleteSample?: (id: string) => Promise<{ ok: boolean; counts?: VoiceEnrollCounts }>;
  voiceEnrollReadSample?: (id: string) => Promise<{ ok: boolean; bytes?: Uint8Array }>;
  voiceEnrollBuild?: () => Promise<{
    ok: boolean;
    reason?: string;
    error?: string;
    summary?: VoiceProfileSummary;
  }>;
  voiceEnrollScore?: (payload: {
    audioBytes: Uint8Array;
    mime?: string;
  }) => Promise<VoiceMatchResult>;
  voiceEnrollClearRecordings?: () => Promise<{ ok: boolean; counts?: VoiceEnrollCounts }>;
  voiceEnrollForget?: () => Promise<VoiceEnrollStatus>;
  voicePrivacyStatus?: () => Promise<VoicePrivacyStatus>;
  voicePrivacyConsent?: () => Promise<{
    ok: boolean;
    reason?: string;
    detail?: string;
    consent?: { givenAt: number; notice: number };
  }>;
  voicePrivacySetRetention?: (payload: { keep: boolean; days: number }) => Promise<{
    ok: boolean;
    reason?: string;
    detail?: string;
    removed?: number;
    count?: number;
    bytes?: number;
  }>;
  voicePrivacyDeleteAll?: () => Promise<VoicePrivacyDeleteResult>;
  onVoicePartial?: (cb: (payload: { text?: string }) => void) => () => void;
  onSystemResume?: (cb: () => void) => () => void;
  onSystemSuspend?: (cb: () => void) => () => void;
  onSystemPressure?: (cb: (snapshot: SystemPressure) => void) => () => void;
  getSystemPressure?: () => Promise<SystemPressure | null>;
  /** Low-latency wake detection (the FRIDAY wake engine) — the real engine when present. */
  wakeEngineStatus?: (payload: { wakeWord?: string; force?: boolean }) => Promise<{
    engine: "openwakeword" | "friday-linear" | "friday-embed" | "transcript";
    installed: boolean;
    ready: boolean;
    model?: string | null;
    modelDir?: string | null;
    models?: string[];
    embedModel?: string | null;
    wakeWord: string;
    reason?: string | null;
  }>;
  installWakeEngine?: () => Promise<{ ok: boolean; ready?: boolean; error?: string }>;
  detectWakeWord?: (payload: {
    audioBytes?: Uint8Array;
    audioBase64?: string;
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
  /** Live wake scoring: a chunk of 16 kHz mono PCM16 from the one shared capture, scored by a streaming session. */
  scoreWakeFrames?: (payload: {
    session?: string;
    pcmBase64?: string;
    wakeWord?: string;
    threshold?: number;
    reset?: boolean;
    minFrames?: number;
    cooldownMs?: number;
  }) => Promise<{
    ok: boolean;
    engine: string;
    detected?: boolean;
    score?: number;
    frames?: number;
    reason?: string;
  }>;
  /** Real post-install probes for FRIDAY Ear / edge-tts. */
  verifyVoiceRuntime?: (payload?: { loadModel?: boolean; model?: string }) => Promise<{
    ok: boolean;
    python: string | null;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }>;
  /** The speech budget of this PC: profile, the size of the primary ear, the resident cap, the memory it may use. */
  voiceBudget?: () => Promise<VoiceBudget>;
  /** The Doctor repair: put the previous verified revision of a voice model back. */
  restoreVoiceModel?: (id: string) => Promise<{ ok: boolean; revision: string; error?: string }>;

  modelRouteMode?: () => Promise<{ mode: string }>;
  setModelRouteMode?: (mode: string) => Promise<{ mode: string }>;
  modelQualityTarget?: () => Promise<{ qualityTarget: string }>;
  setModelQualityTarget?: (value: string) => Promise<{ qualityTarget: string }>;
  modelRouteStrategy?: () => Promise<{ strategy: string }>;
  setModelRouteStrategy?: (value: string) => Promise<{ strategy: string }>;
  modelSelection?: () => Promise<{ ids: string[] }>;
  setModelSelection?: (ids: string[]) => Promise<{ ids: string[] }>;
  modelAllowlist?: () => Promise<{ saved: boolean; ids: string[]; paidEnabled: boolean } | null>;
  setModelAllowlist?: (value: {
    ids?: string[];
    paidEnabled?: boolean;
  }) => Promise<{ ids: string[]; paidEnabled: boolean; cleared?: boolean }>;
  modelBudget?: () => Promise<{ allows: boolean; reason: string; configured: boolean }>;
  setModelBudget?: (value: {
    perRequestUsd?: number | null;
    perDayUsd?: number | null;
    perMonthUsd?: number | null;
  }) => Promise<{ allows: boolean; reason: string; configured: boolean }>;
  recordSpend?: (event: {
    usd: number;
    at: string;
    modelId: string;
  }) => Promise<{ ok: boolean; allows?: boolean; reason?: string }>;
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
  /** Usage so far plus the router's health for every model it has touched. */
  modelLiveStatus?: () => Promise<ModelLiveStatus>;
  resetModelUsage?: (modelId?: string | null) => Promise<{ ok: boolean }>;
  onModelUsageChanged?: (cb: (p: { at: number }) => void) => () => void;
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
    options?: { allowDisabled?: boolean; pluginId?: string; test?: boolean },
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
  localModelStatus?: () => Promise<LocalModelStatus>;
  /** FRIDAY Core status for the Brain settings. It never carries the launch key, the port or the endpoint. */
  brainCoreStatus?: () => Promise<CoreStatus>;
  /** Draw a picture with a connected cloud provider (privacy and billing gates apply). */
  generateImage?: (payload: {
    prompt: string;
    modelId?: string;
    size?: string;
  }) => Promise<
    | { ok: true; file: string; dataUrl: string; model: string; access?: string }
    | { ok: false; error: string }
  >;
  comfyuiStatus?: () => Promise<{
    online: boolean;
    endpoint: string;
    version?: string;
    device?: string;
    reason: string;
  }>;
  comfyuiRun?: (
    workflow: unknown,
  ) => Promise<{ ok: boolean; files: string[]; promptId?: string; reason: string }>;
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
      /** A runner FRIDAY must install before this model can answer. */
      needsRunner?: string;
    }) => void,
  ) => () => void;
  mcpDesk?: (payload: Record<string, unknown>) => Promise<unknown>;
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

export type KnowledgeStatusRow = {
  id: string;
  source: string;
  sourceName?: string;
  basis: string;
  checkedAt: number;
  ageMs: number | null;
  state: "fresh" | "cached" | "no-proof";
};

export type LocalRunnerState =
  "serving" | "not-loaded" | "runner-stopped" | "runner-not-installed" | "failed";

/** FRIDAY Core as the Brain settings see it. No key, port or endpoint is ever part of it. */
export type CoreStatus = {
  variant: string;
  fridayName: string;
  installed: boolean;
  running: boolean;
  ready: boolean;
};

export type LocalModelStatus = {
  at: number;
  runners: Array<{
    id: string;
    name: string;
    running: boolean;
    canStart: boolean;
    servable: number;
    models: number;
    state: LocalRunnerState;
    line: string;
  }>;
  models: Array<{ id: string; runner: string; state: LocalRunnerState; line: string }>;
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

export type ModelLiveRow = {
  modelId: string;
  providerId: string | null;
  requests: number;
  answered: number;
  failed: number;
  blocked: number;
  promptTokens: number;
  completionTokens: number;
  todayTokens: number;
  /** True when any count is an estimate (about four characters a token). */
  estimated: boolean;
  lastAt: number;
  lastOutcome: "answered" | "failed" | "blocked" | null;
  status: string;
  category: string | null;
  coolingDown: boolean;
  cooldownUntil: number;
  quarantined: boolean;
  breaker: string;
  failures: number;
  lastError: string | null;
  nextStep: string;
  latencyMs: number | null;
  lastOkAt: number;
};

export type ModelLiveStatus = {
  at: number;
  totals: { requests: number; tokens: number; todayTokens: number };
  models: ModelLiveRow[];
  decisions: {
    at: number;
    modelId: string;
    why: string;
    latencyMs: number | null;
    outcome: string;
  }[];
};

export type ModelInventory = {
  at: number;
  providers: DiscoveredProvider[];
  running: RunningModel[];
  /** Voice weights on disk (speech, turn, VAD, neural voice), by catalog id. */
  voice?: { catalogId: string; path: string; kind: string }[];
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

export type ModelImportState = "ready" | "stored" | "not-responding" | "failed";

export type ModelImportResult = {
  id?: string;
  ok: boolean;
  state: ModelImportState;
  error?: string;
  note?: string;
  name?: string;
  format?: string;
  bytes?: number;
  path?: string;
  linked?: boolean;
  registered?: boolean;
  registeredAs?: string;
  /** The engine that serves it, when it is not the default one. */
  engine?: string;
  /** A runner FRIDAY must install before this model can answer. */
  needsRunner?: string;
};

export type ModelImportProgress = {
  id: string;
  status: string;
  progress?: number;
  done?: boolean;
  result?: ModelImportResult;
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
  speedBps?: number;
  speedMbps?: number;
  etaSeconds?: number | null;
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

/** Long IPC work waits on the main-process budget, not this 20s guard. */
function bridgeDeadline(key: string, requested?: number): number {
  if (typeof requested === "number") return requested;
  if (
    key.startsWith("capabilities:install") ||
    key.startsWith("tools:") ||
    key.startsWith("import:") ||
    key.startsWith("doctor:") ||
    key.startsWith("finetune:") ||
    key.startsWith("build:") ||
    key.startsWith("updater:") ||
    key === "voice:stt-install" ||
    key === "voice:transcribe" ||
    key === "chat:parallel" ||
    key === "agents:run" ||
    key === "toolpacks:invoke" ||
    key === "models:pull" ||
    key === "models:download" ||
    key === "models:test-provider" ||
    key === "updates:apply" ||
    key === "updates:rollback" ||
    key === "sandbox-lab:exec" ||
    key === "sandbox-lab:install-runtime" ||
    key === "github:pull" ||
    key.startsWith("github:download")
  ) {
    return 0;
  }
  return 20000;
}

export function safeCall<T>(
  key: string,
  run: () => Promise<T> | T | undefined,
  options: { timeoutMs?: number; fallback?: T } = {},
): Promise<T | null> {
  const timeoutMs = bridgeDeadline(key, options.timeoutMs);
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T | null>;

  const call = (async (): Promise<T | null> => {
    try {
      const started = run();
      if (started === undefined) return (options.fallback ?? null) as T | null;
      if (timeoutMs === 0)
        return ((await Promise.resolve(started)) ?? options.fallback ?? null) as T | null;
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

export async function shutdownApp(reason?: string): Promise<boolean> {
  return (await api()?.shutdownApp?.(reason)) ?? false;
}

export async function lifecyclePreview(): Promise<{
  tasks: number;
  downloads: number;
  listening: boolean;
  auto: boolean;
  agents: number;
}> {
  const preview = await api()?.lifecyclePreview?.();
  return {
    tasks: preview?.tasks ?? 0,
    downloads: preview?.downloads ?? 0,
    listening: Boolean(preview?.listening),
    auto: Boolean(preview?.auto),
    agents: preview?.agents ?? 0,
  };
}

/** Non-streaming call into the Python kernel; resolves null off the desktop. */
const KERNEL_OPEN_WAIT = new Set([
  "chat.complete",
  "chat.stream",
  "task.run",
  "task.resume",
  "task.approve",
  "runtime.install",
  "project.run",
  "code.run",
]);

export async function kernelCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  const call = api()?.kernel;
  if (!call) return null;
  // Kernel unavailable or stalled: callers fall back to their local state
  // instead of leaving the section stuck on a loading placeholder.
  // Model and install methods wait on the main-process budget.
  return safeCall<T>(
    `kernel:${method}:${JSON.stringify(params ?? {})}`,
    () => call<T>(method, params),
    KERNEL_OPEN_WAIT.has(method) ? { timeoutMs: 0 } : {},
  );
}

export async function listPlugins(): Promise<DesktopPlugin[]> {
  return (await api()?.listPlugins?.()) ?? [];
}

/** One thing a plugin noticed (its `insight.json`), as the Plugins page and FRIDAY read it. */
export type PluginInsight = {
  id: string;
  name: string;
  enabled: boolean;
  level: "info" | "good" | "warn";
  title: string;
  text: string;
  metrics: Record<string, unknown>;
  at: number;
};

export async function pluginInsights(): Promise<PluginInsight[]> {
  return (await api()?.pluginInsights?.()) ?? [];
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

/**
 * Boot sequence (desktop only): the plan and the steps the main process streams, the clock, and the moment the boot
 * screen may leave, in one small store. Nothing here runs unless the boot screen is mounted, and a remount (moving
 * between sections) joins the same store, so the screen is shown once per launch and its clock never restarts.
 */
let bootDismissed = false;

type BootSnapshot = {
  steps: BootStep[];
  plan: BootPlan | null;
  progress: ReturnType<typeof computeBootProgress> | null;
  shownPercent: number;
  elapsedMs: number;
  gate: BootGate;
  done: boolean;
  leaving: boolean;
};

const bootStore = (() => {
  let steps: BootStep[] = [];
  let plan: BootPlan | null = null;
  let done = false;
  let leaving = false;
  let started = false;
  let shownAt = 0;
  let readyAt = 0;
  let stageKey = "";
  let stageAt = 0;
  let tick: ReturnType<typeof setInterval> | null = null;
  let legacy: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const compute = (): BootSnapshot => {
    const now = Date.now();
    const progress = plan ? computeBootProgress(plan, steps) : null;
    if (progress) {
      const key = `${progress.percent}|${progress.currentLabel}`;
      if (key !== stageKey) {
        stageKey = key;
        stageAt = now;
      }
      if (progress.ready && !readyAt) readyAt = now;
    }
    const elapsedMs = shownAt ? Math.max(0, now - shownAt) : 0;
    return {
      steps,
      plan,
      progress,
      shownPercent: progress ? creepPercent(progress, now - stageAt) : 0,
      elapsedMs,
      gate: progress ? bootGate(progress, elapsedMs, readyAt ? now - readyAt : 0) : "wait",
      done,
      leaving,
    };
  };
  let ready = false;
  let snap: BootSnapshot = {
    steps,
    plan,
    progress: null,
    shownPercent: 0,
    elapsedMs: 0,
    gate: "wait",
    done: true,
    leaving: false,
  };
  // The first render already knows whether the screen is shown, so there is no blank frame before the store starts.
  const read = () => {
    if (!ready) {
      ready = true;
      done = bootDismissed || !isDesktopApp();
      snap = compute();
    }
    return snap;
  };

  const finish = () => {
    if (done || leaving) return;
    bootDismissed = true;
    leaving = true;
    emit();
    setTimeout(() => {
      done = true;
      leaving = false;
      stop();
      emit();
    }, 260);
  };

  function emit() {
    snap = compute();
    for (const listener of listeners) listener();
    if (snap.gate === "leave" && !done && !leaving) finish();
  }

  function stop() {
    started = false;
    if (tick) clearInterval(tick);
    if (legacy) clearTimeout(legacy);
    tick = legacy = null;
    off?.();
    off = null;
  }

  function start() {
    if (started) return;
    started = true;
    done = bootDismissed || !isDesktopApp();
    if (done) {
      snap = compute();
      return;
    }
    const desktop = api();
    if (!desktop) {
      done = true;
      snap = compute();
      return;
    }
    if (!shownAt) shownAt = Date.now();
    void desktop.getBootSteps?.().then((s) => {
      if (s?.length) {
        steps = s;
        emit();
      }
    });
    void desktop.getBootPlan?.().then((p) => {
      if (p?.stages?.length) {
        plan = p;
        emit();
      }
    });
    off =
      desktop.onBootStep?.((step) => {
        if (steps.some((p) => p.at === step.at)) return;
        steps = [...steps, step];
        emit();
      }) ?? null;
    // Four readings a second keep the elapsed time and the easing alive without a frame loop.
    tick = setInterval(emit, 250);
    // An older shell without a boot plan keeps the fixed hold it always had.
    legacy = setTimeout(() => {
      if (!plan) finish();
    }, 2600);
    emit();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !done) stop();
      };
    },
    get: read,
    finish,
  };
})();

/**
 * True while the boot screen is up in the desktop app. Nothing may listen or speak behind it: FRIDAY started talking
 * while the boot screen still showed "Restoring your state", because Auto mode comes back from the saved mode the
 * moment the page mounts. The browser preview has no boot screen, so it never holds.
 */
export function isBootHolding(): boolean {
  return !bootStore.get().done;
}

/** Calls `fn` once the boot screen has gone (at once when it already has). Returns a function that cancels the wait. */
export function whenBootDone(fn: () => void): () => void {
  if (!isBootHolding()) {
    fn();
    return () => undefined;
  }
  let fired = false;
  let off: (() => void) | null = null;
  const check = () => {
    if (fired || !bootStore.get().done) return;
    fired = true;
    // Unsubscribing inside the notification would change the listener set while it is walked.
    queueMicrotask(() => off?.());
    fn();
  };
  off = bootStore.subscribe(check);
  return () => {
    fired = true;
    off?.();
  };
}

export function useBootSequence() {
  const snapshot = useSyncExternalStore(bootStore.subscribe, bootStore.get, bootStore.get);
  return { ...snapshot, dismiss: bootStore.finish };
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
