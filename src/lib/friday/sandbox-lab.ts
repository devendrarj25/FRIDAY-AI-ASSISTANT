/**
 * FRIDAY · Sandbox Lab bridge (renderer side)
 *
 * Thin typed wrapper over the main-process sandbox runtime
 * (electron/sandbox-lab.cjs). Everything is real: real files, real commands,
 * real installs, real diffs against the actual FRIDAY source. In the web
 * preview the bridge is absent and every call reports that the sandbox is
 * desktop-only — nothing is simulated.
 */

export type SandboxRuntimeTool = {
  id: string;
  label: string;
  required: boolean;
  toolId: string;
  source: string;
  path: string | null;
  version: string | null;
  ok: boolean;
  detail: string;
};

export type SandboxRuntime = {
  ok: boolean;
  tools: SandboxRuntimeTool[];
  platform?: string;
  arch?: string;
  node?: string;
};

export type SandboxEngine = {
  id: string;
  label: string;
  kind: "process" | "runtime" | "container" | "vm";
  isolation: string;
  summary: string;
  url: string;
  image: string | null;
  builtin: boolean;
  launchOnly: boolean;
  needsRestart: boolean;
  /** Installed, but Windows has not been restarted yet — show the restart notice. */
  awaitingRestart?: boolean;
  /** FRIDAY can start this engine's background service itself. */
  canStartService?: boolean;
  /** Installing enables a Windows feature — one UAC prompt for that command only. */
  needsElevation?: boolean;
  sources: string[];
  installed: boolean;
  ready: boolean;
  version: string | null;
  detail: string;
  eligible?: boolean;
  excludedReason?: string | null;
};

export type SandboxEngineSelection = {
  ok: boolean;
  id: string;
  label: string;
  isolated: boolean;
  source: string;
  cached: boolean;
  detail: string;
  warning?: string | null;
  attempts?: { id: string; ok: boolean; error?: string }[];
};

export type SandboxWindowsEdition = {
  platform: string;
  editionId: string | null;
  productName: string | null;
  home: boolean;
  windowsSandboxEligible: boolean;
  source?: string;
};

export type SandboxEngineReport = {
  ok: boolean;
  platform?: string;
  arch?: string;
  engines: SandboxEngine[];
  usable: string[];
  selected?: SandboxEngineSelection | null;
  edition?: SandboxWindowsEdition;
};

export type SandboxProject = {
  id: string;
  name: string;
  template: string;
  /** Isolation engine this project runs under. */
  engine?: string;
  createdAt: number;
  updatedAt: number;
  origin?: string | null;
  dir: string;
  exists: boolean;
};

export type SandboxCheck = { id: string; label: string; command: string };

export type SandboxFile = { path: string; dir: boolean; size?: number };

export type SandboxHistoryEntry = {
  at: number;
  kind: string;
  projectId?: string;
  applyId?: string;
  detail?: string;
  ok?: boolean;
  ms?: number;
  files?: string[];
};

export type SandboxApply = {
  applyId: string;
  projectId: string;
  sourceRoot: string;
  files: string[];
  backupDir: string;
  note?: string;
  at: number;
};

export type SandboxChange = {
  path: string;
  status: "added" | "modified";
  bytes: number;
  sandboxHash: string;
  sourceHash: string | null;
  preview: string;
  current: string | null;
};

export type SandboxSummary = {
  ok: boolean;
  error?: string;
  base?: string;
  sourceRoot?: string | null;
  projects: SandboxProject[];
  history: SandboxHistoryEntry[];
  applies: SandboxApply[];
  active: string[];
};

export type SandboxRunResult = {
  ok: boolean;
  error?: string;
  runId?: string;
  projectId?: string;
  command?: string;
  engine?: string;
  isolated?: boolean;
  warning?: string | null;
  code?: number | null;
  output?: string;
  ms?: number;
  timedOut?: boolean;
};

export type SandboxOutputEvent = {
  runId: string;
  projectId: string;
  phase: "start" | "output" | "done";
  engine?: string;
  isolated?: boolean;
  note?: string;
  line?: string;
  command?: string;
  ok?: boolean;
  code?: number | null;
  ms?: number;
};

type Bridge = {
  sandboxSummary?: () => Promise<SandboxSummary>;
  sandboxDetectRuntime?: () => Promise<SandboxRuntime>;
  sandboxInstallRuntime?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string; tool?: SandboxRuntimeTool }>;
  sandboxCreateProject?: (options: {
    name: string;
    template: string;
  }) => Promise<{ ok: boolean; error?: string; project?: SandboxProject }>;
  sandboxRemoveProject?: (id: string, keepFiles?: boolean) => Promise<{ ok: boolean }>;
  sandboxListFiles?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string; files: SandboxFile[]; dir?: string }>;
  sandboxPlanChecks?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string; checks: SandboxCheck[]; dir?: string }>;
  sandboxReadFile?: (
    id: string,
    file: string,
  ) => Promise<{ ok: boolean; error?: string; content?: string }>;
  sandboxWriteFile?: (
    id: string,
    file: string,
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  sandboxDeleteFile?: (id: string, file: string) => Promise<{ ok: boolean; error?: string }>;
  sandboxImportFolder?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string; cancelled?: boolean; files?: number }>;
  sandboxExec?: (options: {
    id: string;
    command: string;
    runId?: string;
    cwd?: string;
    engine?: string;
    network?: boolean;
    image?: string | null;
  }) => Promise<SandboxRunResult>;
  sandboxCancel?: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  sandboxEngines?: () => Promise<SandboxEngineReport>;
  sandboxInstallEngine?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    engine?: SandboxEngine;
    source?: string;
    restartRequired?: boolean;
    /** The Administrator (UAC) prompt was refused. */
    declined?: boolean;
  }>;
  sandboxStartEngine?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    detail?: string;
    engine?: SandboxEngine;
  }>;
  sandboxSetEngine?: (
    id: string,
    engine: string,
  ) => Promise<{ ok: boolean; error?: string; project?: SandboxProject }>;
  sandboxLaunchEngine?: (
    id: string,
    dir?: string,
  ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  sandboxLog?: (id: string) => Promise<string>;
  sandboxDiff?: (
    id: string,
  ) => Promise<{ ok: boolean; error?: string; changes?: SandboxChange[]; sourceRoot?: string }>;
  sandboxApply?: (options: {
    id: string;
    files: string[];
    note?: string | undefined;
    expect?: Record<string, string | null> | undefined;
  }) => Promise<{
    ok: boolean;
    error?: string;
    rolledBack?: boolean;
    applied?: SandboxApply;
    regression?: {
      ok: boolean;
      checks?: { id: string; label: string; ok: boolean; detail: string }[];
      error?: string;
    };
  }>;
  sandboxRollback?: (
    applyId: string,
  ) => Promise<{ ok: boolean; error?: string; restored?: string[] }>;
  sandboxReveal?: (target: string) => Promise<{ ok: boolean; path?: string }>;
  sandboxConfig?: (patch?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onSandboxOutput?: (cb: (event: SandboxOutputEvent) => void) => () => void;
  onSandboxRuntime?: (
    cb: (event: { id: string; phase: string; line?: string; ok?: boolean }) => void,
  ) => () => void;
  onSandboxApplyProgress?: (cb: (event: { step: string }) => void) => () => void;
};

const api = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

const DESKTOP_ONLY = "The FRIDAY Sandbox runs in the desktop app.";

export const sandboxAvailable = (): boolean => Boolean(api()?.sandboxSummary);

const EMPTY: SandboxSummary = {
  ok: false,
  error: DESKTOP_ONLY,
  projects: [],
  history: [],
  applies: [],
  active: [],
};

export const loadSummary = async (): Promise<SandboxSummary> =>
  (await api()?.sandboxSummary?.()) ?? EMPTY;

export const detectRuntime = async (): Promise<SandboxRuntime> =>
  (await api()?.sandboxDetectRuntime?.()) ?? { ok: false, tools: [] };

export const installRuntime = async (id: string) =>
  (await api()?.sandboxInstallRuntime?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const createProject = async (name: string, template: string) =>
  (await api()?.sandboxCreateProject?.({ name, template })) ?? { ok: false, error: DESKTOP_ONLY };

export const removeProject = async (id: string, keepFiles = false) =>
  (await api()?.sandboxRemoveProject?.(id, keepFiles)) ?? { ok: false };

export const listFiles = async (id: string) =>
  (await api()?.sandboxListFiles?.(id)) ?? {
    ok: false,
    error: DESKTOP_ONLY,
    files: [] as SandboxFile[],
  };

export const planChecks = async (id: string) =>
  (await api()?.sandboxPlanChecks?.(id)) ?? {
    ok: false,
    error: DESKTOP_ONLY,
    checks: [] as SandboxCheck[],
  };

export const readFile = async (id: string, file: string) =>
  (await api()?.sandboxReadFile?.(id, file)) ?? { ok: false, error: DESKTOP_ONLY };

export const writeFile = async (id: string, file: string, content: string) =>
  (await api()?.sandboxWriteFile?.(id, file, content)) ?? { ok: false, error: DESKTOP_ONLY };

export const deleteFile = async (id: string, file: string) =>
  (await api()?.sandboxDeleteFile?.(id, file)) ?? { ok: false, error: DESKTOP_ONLY };

export const importFolder = async (id: string) =>
  (await api()?.sandboxImportFolder?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const execCommand = async (options: {
  id: string;
  command: string;
  runId?: string;
  cwd?: string;
  engine?: string;
  network?: boolean;
}) => (await api()?.sandboxExec?.(options)) ?? { ok: false, error: DESKTOP_ONLY };

export const listEngines = async (): Promise<SandboxEngineReport> =>
  (await api()?.sandboxEngines?.()) ?? { ok: false, engines: [], usable: [] };

export const installEngine = async (id: string) =>
  (await api()?.sandboxInstallEngine?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

/** Start an installed-but-not-running engine service and wait for it. */
export const startEngineService = async (id: string) =>
  (await api()?.sandboxStartEngine?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const setProjectEngine = async (id: string, engine: string) =>
  (await api()?.sandboxSetEngine?.(id, engine)) ?? { ok: false, error: DESKTOP_ONLY };

export const launchEngineSession = async (id: string, dir?: string) =>
  (await api()?.sandboxLaunchEngine?.(id, dir)) ?? { ok: false, error: DESKTOP_ONLY };

export const cancelRun = async (runId: string) =>
  (await api()?.sandboxCancel?.(runId)) ?? { ok: false, error: DESKTOP_ONLY };

export const readLog = async (id: string): Promise<string> => (await api()?.sandboxLog?.(id)) ?? "";

export const diffToSource = async (id: string) =>
  (await api()?.sandboxDiff?.(id)) ?? { ok: false, error: DESKTOP_ONLY };

export const applyApproved = async (
  id: string,
  files: string[],
  note?: string,
  /** Source hashes exactly as reviewed — a stale preview is refused. */
  expected?: Record<string, string | null>,
) =>
  (await api()?.sandboxApply?.({ id, files, note, expect: expected })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const rollbackApply = async (applyId: string) =>
  (await api()?.sandboxRollback?.(applyId)) ?? { ok: false, error: DESKTOP_ONLY };

export const reveal = async (target: string) => api()?.sandboxReveal?.(target);

export const onOutput = (cb: (event: SandboxOutputEvent) => void) =>
  api()?.onSandboxOutput?.(cb) ?? (() => {});
export const onRuntimeEvent = (
  cb: (event: { id: string; phase: string; line?: string; ok?: boolean }) => void,
) => api()?.onSandboxRuntime?.(cb) ?? (() => {});
export const onApplyProgress = (cb: (event: { step: string }) => void) =>
  api()?.onSandboxApplyProgress?.(cb) ?? (() => {});

/** Templates offered by the main process, mirrored for the picker. */
export const SANDBOX_TEMPLATES = [
  { id: "blank", label: "Blank workspace" },
  { id: "node", label: "Node script" },
  { id: "python", label: "Python script" },
  { id: "pytest", label: "Python pytest" },
  { id: "go", label: "Go module" },
  { id: "rust", label: "Rust crate" },
  { id: "linux", label: "Linux / Make checks" },
  { id: "java", label: "Java" },
  { id: "cmake", label: "CMake / C" },
  { id: "container", label: "Container project" },
  { id: "deno", label: "Deno (permissioned)" },
  { id: "friday", label: "FRIDAY source copy" },
] as const;

/** Command presets shown in the runner — same Button group, checks first. */
export const SANDBOX_PRESETS = [
  { id: "test", label: "Run tests", command: "npm test" },
  { id: "typecheck", label: "Typecheck", command: "npm run typecheck" },
  { id: "lint", label: "Lint", command: "npm run lint" },
  { id: "tsc", label: "tsc --noEmit", command: "tsc --noEmit" },
  { id: "prettier", label: "Prettier check", command: "prettier --check ." },
  { id: "pytest", label: "pytest", command: "python -m pytest -q" },
  { id: "ruff", label: "Ruff", command: "ruff check ." },
  { id: "compileall", label: "Python compile", command: "python -m compileall -q ." },
  { id: "gotest", label: "Go test", command: "go test ./..." },
  { id: "govet", label: "Go vet", command: "go vet ./..." },
  { id: "cargocheck", label: "Cargo check", command: "cargo check" },
  { id: "cargotest", label: "Cargo test", command: "cargo test" },
  { id: "denotest", label: "Deno test", command: "deno test" },
  { id: "buntest", label: "Bun test", command: "bun test" },
  { id: "make", label: "make test", command: "make test" },
  { id: "cmake", label: "CMake configure", command: "cmake -S . -B build" },
  { id: "javac", label: "javac Main.java", command: "javac Main.java" },
  { id: "dotnettest", label: "dotnet test", command: "dotnet test" },
  { id: "gitstatus", label: "git status", command: "git status --short" },
  { id: "gitdiff", label: "git diff", command: "git diff --stat" },
  { id: "install", label: "Install npm deps", command: "npm install" },
  { id: "pip", label: "Install pip reqs", command: "pip install -r requirements.txt" },
  { id: "build", label: "Build", command: "npm run build" },
  { id: "compose", label: "Compose config", command: "docker compose config" },
  { id: "docker", label: "Docker build", command: "docker build ." },
  { id: "start", label: "Start", command: "npm start" },
  { id: "python", label: "Run main.py", command: "python main.py" },
] as const;
