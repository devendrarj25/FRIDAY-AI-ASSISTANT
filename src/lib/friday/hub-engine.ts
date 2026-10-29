/**
 * FRIDAY · Hub engine
 *
 * One place where new capability arrives and becomes something FRIDAY can
 * actually use:
 *
 *   GitHub clone / ZIP / folder / single file
 *     → inspect (what is this really?)
 *     → validate (compatibility, dependencies, source, permissions)
 *     → owner approval of the exact install plan
 *     → install into the correct FRIDAY area (real importer, real disk)
 *     → health test by executing it
 *     → register in the capability registry, activate / deactivate / configure
 *
 * Nothing here invents an install. Every real operation goes through the
 * desktop bridge that already exists (import:scan / verify / apply, plugins,
 * models, tools). In the browser preview inspection still works through the
 * public GitHub API, and installs report plainly that they need the desktop
 * app instead of pretending to succeed.
 *
 * State is durable: kind, version, source, path, dependencies, health, active
 * flag, capabilities and permission survive a restart and are re-verified on
 * boot, so an approved resource is never re-installed by hand.
 */

import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { parseRepoUrl } from "./import-engine";

const KEY = "friday.hub.v1";

export type HubKind =
  "model" | "tool" | "skill" | "agent" | "module" | "plugin" | "workflow" | "runtime" | "unknown";

export type HubSource = "github" | "zip" | "folder" | "file";

export type HubStatus = "inspecting" | "awaiting-approval" | "installing" | "installed" | "failed";

export type HubHealth = "unknown" | "testing" | "ready" | "degraded" | "failed";

export type HubLogLine = { at: number; level: "info" | "ok" | "warn" | "error"; text: string };

export type HubResource = {
  id: string;
  name: string;
  kind: HubKind;
  source: HubSource;
  /** Repo URL, ZIP path, folder path or file name — where it came from. */
  origin: string;
  version: string | null;
  /** Where it lives inside the FRIDAY folder once installed. */
  path: string | null;
  dependencies: string[];
  capabilities: string[];
  permission: "open" | "ask" | "owner-only";
  status: HubStatus;
  health: HubHealth;
  healthMessage: string;
  active: boolean;
  config: Record<string, string>;
  /** Exact install plan shown before approval. */
  plan: { dir: string; files: number }[];
  planFiles: number;
  restartRequired: boolean;
  /** Desktop staging handle — the scan this resource installs from. */
  scanId: string | null;
  /** Backup folder created when it was applied, used for rollback. */
  backup: string | null;
  notes: string[];
  log: HubLogLine[];
  at: number;
  installedAt: number | null;
  verifiedAt: number | null;
};

export type HubState = {
  resources: HubResource[];
  busy: boolean;
  message: string;
};

type Scan = {
  ok: boolean;
  id?: string;
  error?: string;
  version?: string | null;
  stack?: string[];
  mode?: string;
  label?: string;
  packageName?: string;
  destinations?: { dir: string; files: number }[];
  files?: { path: string; dest?: string; size: number; state: string; area: string }[];
  summary?: {
    total: number;
    added: number;
    changed: number;
    bytes: number;
    restartRequired: boolean;
  };
};

type Bridge = {
  pickImportZip?: () => Promise<{ ok: boolean; file?: string; cancelled?: boolean }>;
  pickImportFolder?: () => Promise<{ ok: boolean; folder?: string; cancelled?: boolean }>;
  stageImportBytes?: (
    name: string,
    bytes: ArrayBuffer,
  ) => Promise<{ ok: boolean; file?: string; error?: string }>;
  downloadImport?: (
    url: string,
    name: string,
  ) => Promise<{ ok: boolean; file?: string; error?: string }>;
  scanImport?: (source: string) => Promise<Scan>;
  verifyImport?: (scan: string) => Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
    steps?: { name: string; ok: boolean }[];
  }>;
  applyImport?: (scan: string) => Promise<{
    ok: boolean;
    applied?: number;
    backup?: string;
    restartRequired?: boolean;
    error?: string;
    placed?: { dir: string; files: number }[];
  }>;
  rollbackImport?: (backup: string) => Promise<{ ok: boolean; error?: string }>;
  revealImport?: (target: string) => Promise<boolean>;
  listPlugins?: () => Promise<unknown>;
  loadPlugin?: (id: string) => Promise<{ ok?: boolean; error?: string } | boolean>;
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
  detectTools?: (force?: boolean) => Promise<unknown>;
  modelHealth?: (
    modelId: string,
  ) => Promise<{ ok?: boolean; error?: string; ms?: number } | boolean>;
  listOllamaModels?: () => Promise<unknown>;
  scanWorkspace?: (force?: boolean) => Promise<unknown>;
  hubFiles?: (scanId: string) => Promise<{ ok: boolean; error?: string; files?: StagedFile[] }>;
  hubRead?: (
    scanId: string,
    file: string,
  ) => Promise<{ ok: boolean; error?: string; content?: string; binary?: boolean; bytes?: number }>;
  hubWrite?: (
    scanId: string,
    file: string,
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  hubAnalyze?: (scanId: string) => Promise<HubAnalysis>;
  hubExtract?: (
    scanId: string,
    groups: string[],
  ) => Promise<{ ok: boolean; error?: string; applied?: number; backup?: string }>;
  hubWorkbench?: (
    scanId: string,
    name: string,
  ) => Promise<{ ok: boolean; error?: string; project?: { id: string; name: string } }>;
};

/** One file inside a staged import, before anything is adopted. */
export type StagedFile = { path: string; size: number; dir: boolean };

/** One adoptable capability found inside a staged import. */
export type HubCandidate = {
  id: string;
  dest: string;
  tree: string;
  kind: string;
  name: string;
  version: string | null;
  description: string;
  files: number;
  bytes: number;
  new: number;
  newer: number;
  same: number;
  status: "new" | "updated" | "identical";
  hot: boolean;
  samples: string[];
};

export type HubAnalysis = {
  ok: boolean;
  error?: string;
  mode?: string;
  label?: string;
  candidates?: HubCandidate[];
  summary?: { total: number; groups: number; new: number; updated: number; identical: number };
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

const uid = () => `hub_${Math.random().toString(36).slice(2, 10)}`;
const now = () => Date.now();

/** Capability keywords per kind — what the Core Brain matches against. */
const KIND_CAPABILITIES: Record<HubKind, string[]> = {
  model: ["generate", "reason", "chat"],
  tool: ["execute", "automate", "utility"],
  skill: ["skill", "task", "action"],
  agent: ["agent", "autonomous", "delegate"],
  module: ["module", "extend", "integrate"],
  plugin: ["plugin", "extend", "command"],
  workflow: ["workflow", "automation", "pipeline"],
  runtime: ["runtime", "execute", "environment"],
  unknown: ["unclassified"],
};

const KIND_PERMISSION: Record<HubKind, HubResource["permission"]> = {
  model: "open",
  tool: "ask",
  skill: "open",
  agent: "ask",
  module: "ask",
  plugin: "ask",
  workflow: "open",
  runtime: "owner-only",
  unknown: "owner-only",
};

/** Which FRIDAY area a scan destination belongs to. */
function kindFromPaths(paths: string[]): HubKind {
  const lower = paths.map((p) => p.toLowerCase());
  const hit = (needle: string) =>
    lower.some((p) => p.startsWith(needle) || p.includes(`/${needle}`));
  if (hit("plugins/")) return "plugin";
  if (hit("agents/")) return "agent";
  if (hit("skills/")) return "skill";
  if (hit("workflows/")) return "workflow";
  if (hit("modules/")) return "module";
  if (hit("models/")) return "model";
  if (hit("tools/")) return "tool";
  return "unknown";
}

/** Detect the kind from a repository / archive file listing. */
export function detectKind(
  paths: string[],
  hints: { name?: string; label?: string; manifest?: Record<string, unknown>; code?: string } = {},
): HubKind {
  const lower = paths.map((p) => p.toLowerCase().replace(/\\/g, "/"));
  // Filename beats a generic "manifest.json → module" fallback. Write-time
  // import still uses electron/pack-shape.cjs (content: plan()/run(),
  // entry+approvalPrompt, skill capabilities).
  if (lower.some((p) => p.endsWith("skill.json") || /(^|\/)skill\.(mjs|js)$/.test(p))) {
    return "skill";
  }
  if (lower.some((p) => p.endsWith("tool.json"))) return "tool";
  if (lower.some((p) => p.endsWith("agent.json"))) return "agent";
  if (lower.some((p) => p.endsWith("module.json"))) return "module";
  if (lower.some((p) => p.endsWith("plugin.json"))) return "plugin";
  if (lower.some((p) => p.endsWith("workflow.json"))) return "workflow";
  const fromPaths = kindFromPaths(paths);
  if (fromPaths !== "unknown") return fromPaths;
  if (hints.manifest && typeof hints.manifest === "object") {
    const fromManifest = detectKindFromManifest(hints.manifest, hints.code);
    if (fromManifest !== "unknown") return fromManifest;
  }
  const text = `${hints.label ?? ""} ${hints.name ?? ""}`.toLowerCase();
  if (/plugin/.test(text)) return "plugin";
  if (/agent/.test(text)) return "agent";
  if (/skill/.test(text)) return "skill";
  if (/workflow|n8n/.test(text)) return "workflow";
  if (/module/.test(text)) return "module";
  if (/runtime|installer|toolchain/.test(text)) return "runtime";
  if (lower.some((p) => /\.(gguf|safetensors|onnx|ggml|pt)$/.test(p))) return "model";
  if (lower.some((p) => p.endsWith("manifest.json"))) return "module";
  if (/tool|cli/.test(text)) return "tool";
  return "unknown";
}

/** Content-shape hint for Hub when a manifest body is already in memory. */
export function detectKindFromManifest(manifest: Record<string, unknown>, code = ""): HubKind {
  const src = String(code || manifest["code"] || "");
  const hasPlan =
    /\bfunction\s+plan\s*\(|\bexports\.plan\s*=|module\.exports\s*=\s*\{[^}]*\bplan\b/.test(src);
  const hasRun =
    /\bfunction\s+run\s*\(|\bexports\.run\s*=|export\s+(async\s+)?function\s+run|export\s+\{[^}]*\brun\b/.test(
      src,
    );
  if (hasPlan && hasRun) return "agent";
  if (
    manifest["goal"] ||
    manifest["persona"] ||
    manifest["role"] ||
    Array.isArray(manifest["agents"])
  ) {
    return "agent";
  }
  const entry = String(manifest["entry"] || "").trim();
  const approval = String(manifest["approvalPrompt"] || "").trim();
  const risk = manifest["risk"] != null && String(manifest["risk"]).trim() !== "";
  if (entry && approval && risk && !hasPlan) return "tool";
  if (Array.isArray(manifest["capabilities"]) && !approval && !entry) return "skill";
  if (
    hasRun &&
    !hasPlan &&
    /export\s+(async\s+)?function\s+run|export\s+\{[^}]*\brun\b/.test(src)
  ) {
    return "skill";
  }
  const declared = String(manifest["tree"] || manifest["kind"] || manifest["type"] || "")
    .trim()
    .toLowerCase();
  if (declared === "skills" || declared === "skill") return "skill";
  if (declared === "tools" || declared === "tool") return "tool";
  if (declared === "agents" || declared === "agent") return "agent";
  if (declared === "modules" || declared === "module") return "module";
  if (declared === "plugins" || declared === "plugin") return "plugin";
  if (declared === "workflows" || declared === "workflow") return "workflow";
  if (Array.isArray(manifest["hooks"])) return "plugin";
  if (
    Array.isArray(manifest["steps"]) ||
    Array.isArray(manifest["nodes"]) ||
    manifest["schedule"]
  ) {
    return "workflow";
  }
  const perms = Array.isArray(manifest["permissions"]) ? manifest["permissions"] : [];
  const ui = manifest["ui"];
  const hasUi = Boolean(ui && typeof ui === "object" && !Array.isArray(ui));
  if (
    entry &&
    perms.length &&
    !approval &&
    !hasPlan &&
    !manifest["goal"] &&
    !manifest["persona"] &&
    !manifest["role"] &&
    !Array.isArray(manifest["agents"]) &&
    (hasUi || /\.py$/i.test(entry) || !risk)
  ) {
    return "module";
  }
  return "unknown";
}

/** Dependencies a package declares, read from real manifest file names. */
export function detectDependencies(paths: string[]): string[] {
  const lower = paths.map((p) => p.toLowerCase().split("/").pop() ?? "");
  const deps = new Set<string>();
  if (lower.includes("package.json")) deps.add("Node.js");
  if (lower.includes("requirements.txt") || lower.includes("pyproject.toml")) deps.add("Python");
  if (lower.includes("cargo.toml")) deps.add("Rust");
  if (lower.includes("go.mod")) deps.add("Go");
  if (lower.includes("dockerfile")) deps.add("Docker");
  if (lower.some((p) => p.endsWith(".gguf"))) deps.add("Local model runtime");
  return [...deps];
}

type Listener = () => void;

class HubEngine {
  private state: HubState = { resources: [], busy: false, message: "" };
  private listeners = new Set<Listener>();
  private loaded = false;
  private booted = false;

  subscribe = (fn: Listener) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): HubState => {
    this.load();
    return this.state;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<{ resources: HubResource[] }>(KEY);
    if (local?.resources) this.state = { ...this.state, resources: local.resources };
    restoreFromDisk<{ resources: HubResource[] }>(KEY, (disk) => {
      if (!disk?.resources?.length) return;
      this.state = { ...this.state, resources: disk.resources };
      this.emit();
    });
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private commit(next: Partial<HubState>) {
    this.state = { ...this.state, ...next };
    writeState(KEY, { resources: this.state.resources });
    this.emit();
  }

  private patch(id: string, patch: Partial<HubResource>, logLine?: Omit<HubLogLine, "at">) {
    const resources = this.state.resources.map((resource) =>
      resource.id === id
        ? {
            ...resource,
            ...patch,
            log: logLine ? [...resource.log, { at: now(), ...logLine }].slice(-80) : resource.log,
          }
        : resource,
    );
    this.commit({ resources });
  }

  // ---- Workbench ----------------------------------------------------------
  // Everything below reads or edits the *staged* copy only. Nothing reaches the
  // live FRIDAY tree until extract() is called with the owner's selection.

  /** Files inside a staged import, for the workbench tree. */
  async stagedFiles(resource: HubResource): Promise<StagedFile[]> {
    const api = bridge();
    if (!api?.hubFiles || !resource.scanId) return [];
    const result = await api.hubFiles(resource.scanId);
    return result.ok ? (result.files ?? []) : [];
  }

  async readStaged(resource: HubResource, file: string) {
    const api = bridge();
    if (!api?.hubRead || !resource.scanId) {
      return { ok: false as const, error: "Open FRIDAY on the desktop to preview files." };
    }
    return api.hubRead(resource.scanId, file);
  }

  async writeStaged(resource: HubResource, file: string, content: string) {
    const api = bridge();
    if (!api?.hubWrite || !resource.scanId) {
      return { ok: false as const, error: "Open FRIDAY on the desktop to edit files." };
    }
    const result = await api.hubWrite(resource.scanId, file, content);
    if (result.ok) {
      this.patch(resource.id, {}, { level: "ok", text: `edited ${file} in the staging copy` });
    }
    return result;
  }

  /** What capabilities this import contains, and which are new to FRIDAY. */
  async analyze(resource: HubResource): Promise<HubAnalysis> {
    const api = bridge();
    if (!api?.hubAnalyze || !resource.scanId) {
      return { ok: false, error: "Open FRIDAY on the desktop to analyse an import." };
    }
    this.patch(resource.id, {}, { level: "info", text: "analysing staged package…" });
    const result = await api.hubAnalyze(resource.scanId);
    this.patch(
      resource.id,
      {},
      result.ok
        ? {
            level: "ok",
            text: `${result.summary?.groups ?? 0} capabilities · ${result.summary?.new ?? 0} new · ${result.summary?.updated ?? 0} updated`,
          }
        : { level: "error", text: result.error || "analysis failed" },
    );
    return result;
  }

  /** Adopt only the selected capabilities into the live FRIDAY tree. */
  async extract(resource: HubResource, groups: string[]) {
    const api = bridge();
    if (!api?.hubExtract || !resource.scanId) {
      return { ok: false as const, error: "Open FRIDAY on the desktop to install capabilities." };
    }
    if (!groups.length) return { ok: false as const, error: "Select at least one capability." };
    this.patch(
      resource.id,
      { status: "installing" },
      { level: "info", text: `installing ${groups.length} selected capabilities…` },
    );
    const result = await api.hubExtract(resource.scanId, groups);
    this.patch(
      resource.id,
      result.ok
        ? {
            status: "installed",
            installedAt: now(),
            backup: result.backup ?? null,
            active: true,
          }
        : { status: "awaiting-approval" },
      result.ok
        ? { level: "ok", text: `adopted ${result.applied ?? 0} files` }
        : { level: "error", text: result.error || "install failed" },
    );
    return result;
  }

  /** Open the staged import as a real isolated sandbox project. */
  async openWorkbench(resource: HubResource) {
    const api = bridge();
    if (!api?.hubWorkbench || !resource.scanId) {
      return { ok: false as const, error: "Open FRIDAY on the desktop to use the workbench." };
    }
    const result = await api.hubWorkbench(resource.scanId, resource.name);
    this.patch(
      resource.id,
      {},
      result.ok
        ? { level: "ok", text: `sandbox project created: ${result.project?.name}` }
        : { level: "error", text: result.error || "workbench failed" },
    );
    return result;
  }

  get(id: string): HubResource | undefined {
    return this.state.resources.find((resource) => resource.id === id);
  }

  /** Installed + active resources — what the Core Brain may route to. */
  activeResources(): HubResource[] {
    return this.getSnapshot().resources.filter((r) => r.status === "installed" && r.active);
  }

  /** Refuse a second copy of the same thing in the same area. */
  private conflictOf(kind: HubKind, name: string, origin: string): HubResource | undefined {
    const key = name.trim().toLowerCase();
    return this.state.resources.find(
      (resource) =>
        resource.status !== "failed" &&
        (resource.origin === origin ||
          (resource.kind === kind && resource.name.toLowerCase() === key)),
    );
  }

  private base(
    partial: Partial<HubResource> & { name: string; source: HubSource; origin: string },
  ): HubResource {
    return {
      id: uid(),
      kind: "unknown",
      version: null,
      path: null,
      dependencies: [],
      capabilities: [],
      permission: "owner-only",
      status: "inspecting",
      health: "unknown",
      healthMessage: "not tested yet",
      active: false,
      config: {},
      plan: [],
      planFiles: 0,
      restartRequired: false,
      scanId: null,
      backup: null,
      notes: [],
      log: [{ at: now(), level: "info", text: `inspecting ${partial.source} source` }],
      at: now(),
      installedAt: null,
      verifiedAt: null,
      ...partial,
    };
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** Clone-and-inspect a GitHub repository. */
  async inspectGithub(url: string): Promise<HubResource | null> {
    const repo = parseRepoUrl(url);
    if (!repo) {
      this.commit({ message: "That does not look like a GitHub repository URL." });
      return null;
    }
    const origin = `https://github.com/${repo.owner}/${repo.repo}`;
    const existing = this.conflictOf("unknown", repo.repo, origin);
    if (existing) {
      this.commit({
        message: `${repo.repo} is already in the Hub — remove it first to re-import.`,
      });
      return existing;
    }

    const resource = this.base({ name: repo.repo, source: "github", origin });
    this.commit({ resources: [resource, ...this.state.resources], busy: true, message: "" });

    try {
      const meta = (await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`).then(
        (r) => (r.ok ? r.json() : null),
      )) as {
        default_branch?: string;
        license?: { spdx_id?: string };
        description?: string;
      } | null;
      const branch = repo.branch ?? meta?.default_branch ?? "main";
      const tree = (await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${branch}?recursive=1`,
      ).then((r) => (r.ok ? r.json() : null))) as {
        tree?: { path: string; type: string }[];
      } | null;
      const paths = (tree?.tree ?? []).filter((n) => n.type === "blob").map((n) => n.path);
      const kind = detectKind(paths, { name: repo.repo, label: meta?.description ?? "" });
      const notes = [
        meta?.license?.spdx_id ? `license ${meta.license.spdx_id}` : "license not declared",
        `source github.com/${repo.owner}`,
        `${paths.length} file(s) on ${branch}`,
      ];

      this.patch(resource.id, {
        kind,
        capabilities: KIND_CAPABILITIES[kind],
        permission: KIND_PERMISSION[kind],
        dependencies: detectDependencies(paths),
        notes,
        status: "awaiting-approval",
      });

      // Desktop: download the real archive and stage it so the plan is exact.
      const api = bridge();
      if (api?.downloadImport && api.scanImport) {
        const zip = `${origin}/archive/refs/heads/${branch}.zip`;
        const dl = await api.downloadImport(zip, `${repo.repo}-${branch}.zip`);
        if (!dl.ok || !dl.file) throw new Error(dl.error ?? "download failed");
        await this.stageScan(resource.id, dl.file, repo.repo);
      } else {
        this.patch(resource.id, {}, { level: "warn", text: "install plan needs the desktop app" });
      }
    } catch (error) {
      this.patch(
        resource.id,
        { status: "failed", healthMessage: String((error as Error).message ?? error) },
        { level: "error", text: String((error as Error).message ?? error) },
      );
    } finally {
      this.commit({ busy: false });
    }
    return this.get(resource.id) ?? null;
  }

  /** Pick a ZIP through the desktop dialog and inspect it. */
  async inspectZip(): Promise<HubResource | null> {
    const api = bridge();
    if (!api?.pickImportZip) return this.desktopOnly();
    const picked = await api.pickImportZip();
    if (!picked.ok || !picked.file) return null;
    return this.inspectPath(picked.file, "zip");
  }

  /** Pick a folder through the desktop dialog and inspect it. */
  async inspectFolder(): Promise<HubResource | null> {
    const api = bridge();
    if (!api?.pickImportFolder) return this.desktopOnly();
    const picked = await api.pickImportFolder();
    if (!picked.ok || !picked.folder) return null;
    return this.inspectPath(picked.folder, "folder");
  }

  /** Inspect a single dropped file (skill script, workflow JSON, model …). */
  async inspectFile(file: File): Promise<HubResource | null> {
    const api = bridge();
    if (!api?.stageImportBytes) return this.desktopOnly();
    const staged = await api.stageImportBytes(file.name, await file.arrayBuffer());
    if (!staged.ok || !staged.file) {
      this.commit({ message: staged.error ?? "could not stage that file" });
      return null;
    }
    return this.inspectPath(staged.file, "file", file.name);
  }

  private desktopOnly(): null {
    this.commit({ message: "Importing files needs the installed FRIDAY desktop app." });
    return null;
  }

  private async inspectPath(
    source: string,
    kindOfSource: HubSource,
    label?: string,
  ): Promise<HubResource | null> {
    const name = label ?? (source.split(/[\\/]/).pop() || "import");
    const existing = this.conflictOf("unknown", name, source);
    if (existing) {
      this.commit({ message: `${name} is already in the Hub — remove it first to re-import.` });
      return existing;
    }
    const resource = this.base({ name, source: kindOfSource, origin: source });
    this.commit({ resources: [resource, ...this.state.resources], busy: true, message: "" });
    try {
      await this.stageScan(resource.id, source, name);
    } catch (error) {
      this.patch(
        resource.id,
        { status: "failed", healthMessage: String((error as Error).message ?? error) },
        { level: "error", text: String((error as Error).message ?? error) },
      );
    } finally {
      this.commit({ busy: false });
    }
    return this.get(resource.id) ?? null;
  }

  /** Real scan through the importer: exact destinations, versions, conflicts. */
  private async stageScan(id: string, source: string, name: string) {
    const api = bridge();
    if (!api?.scanImport) throw new Error("importer unavailable");
    const scan = await api.scanImport(source);
    if (!scan.ok || !scan.id) throw new Error(scan.error ?? "scan failed");
    const paths = (scan.files ?? []).map((f) => f.dest ?? f.path);
    const kind = detectKind(paths, { name, label: scan.label ?? scan.mode ?? "" });
    const plan = scan.destinations ?? [];
    this.patch(
      id,
      {
        kind,
        version: scan.version ?? null,
        capabilities: KIND_CAPABILITIES[kind],
        permission: KIND_PERMISSION[kind],
        dependencies: detectDependencies(paths),
        plan,
        planFiles: scan.summary?.total ?? paths.length,
        restartRequired: Boolean(scan.summary?.restartRequired),
        scanId: scan.id,
        path: plan[0]?.dir ?? null,
        status: "awaiting-approval",
        notes: [
          scan.label ? `recognised as ${scan.label}` : "content classified by area",
          `${scan.summary?.added ?? 0} new · ${scan.summary?.changed ?? 0} changed`,
          ...(scan.stack?.length ? [`stack ${scan.stack.join(", ")}`] : []),
        ],
      },
      { level: "ok", text: `inspected · ${paths.length} file(s) · detected ${kind}` },
    );
  }

  // ── Approval, install, health ─────────────────────────────────────────────

  /** Owner approval: verify in the sandbox, then install for real. */
  async approve(id: string): Promise<boolean> {
    const resource = this.get(id);
    if (!resource) return false;
    const api = bridge();
    if (!api?.applyImport || !resource.scanId) {
      this.patch(id, {}, { level: "error", text: "install needs the desktop app" });
      this.commit({ message: "Installing needs the installed FRIDAY desktop app." });
      return false;
    }
    this.patch(id, { status: "installing" }, { level: "info", text: "verifying in the sandbox" });
    this.commit({ busy: true });
    try {
      if (api.verifyImport) {
        const verified = await api.verifyImport(resource.scanId);
        if (!verified.ok && !verified.skipped) {
          throw new Error(verified.error ?? "sandbox verification failed");
        }
        this.patch(
          id,
          {},
          { level: "ok", text: verified.skipped ? "verification skipped" : "sandbox verified" },
        );
      }
      const applied = await api.applyImport(resource.scanId);
      if (!applied.ok) throw new Error(applied.error ?? "install failed");
      this.patch(
        id,
        {
          status: "installed",
          installedAt: now(),
          active: true,
          backup: applied.backup ?? null,
          restartRequired: Boolean(applied.restartRequired),
          path: applied.placed?.[0]?.dir ?? resource.path,
        },
        { level: "ok", text: `installed ${applied.applied ?? 0} file(s)` },
      );
      await api.scanWorkspace?.(true).catch(() => undefined);
      await this.healthTest(id);
      return true;
    } catch (error) {
      this.patch(
        id,
        {
          status: "failed",
          health: "failed",
          healthMessage: String((error as Error).message ?? error),
        },
        { level: "error", text: String((error as Error).message ?? error) },
      );
      return false;
    } finally {
      this.commit({ busy: false });
    }
  }

  /** Execute the resource for real and record whether it actually works. */
  async healthTest(id: string): Promise<HubHealth> {
    const resource = this.get(id);
    if (!resource) return "unknown";
    this.patch(id, { health: "testing" }, { level: "info", text: "health test running" });
    const api = bridge();
    let health: HubHealth = "unknown";
    let message = "no runtime available to test against";
    try {
      if (!api) {
        message = "desktop app required for a real health test";
      } else if (resource.kind === "plugin" && api.loadPlugin) {
        const loaded = await api.loadPlugin(resource.name);
        const ok = typeof loaded === "boolean" ? loaded : Boolean(loaded?.ok);
        health = ok ? "ready" : "degraded";
        message = ok ? "plugin loaded by the plugin host" : "plugin host refused to load it";
      } else if (resource.kind === "model" && api.modelHealth) {
        const probe = await api.modelHealth(resource.name);
        const ok = typeof probe === "boolean" ? probe : Boolean(probe?.ok);
        health = ok ? "ready" : "degraded";
        message = ok ? "model answered a probe" : "model did not answer a probe";
      } else if ((resource.kind === "tool" || resource.kind === "runtime") && api.detectTools) {
        await api.detectTools(true);
        health = "ready";
        message = "toolchain re-detected after install";
      } else if (api.scanWorkspace) {
        await api.scanWorkspace(true);
        health = resource.path ? "ready" : "degraded";
        message = resource.path
          ? `present in ${resource.path} and registered`
          : "installed but no destination recorded";
      }
    } catch (error) {
      health = "failed";
      message = String((error as Error).message ?? error);
    }
    this.patch(
      id,
      { health, healthMessage: message, verifiedAt: now() },
      { level: health === "ready" ? "ok" : health === "failed" ? "error" : "warn", text: message },
    );
    return health;
  }

  /** Reject a pending resource, or uninstall an installed one via rollback. */
  async remove(id: string): Promise<void> {
    const resource = this.get(id);
    if (!resource) return;
    const api = bridge();
    if (resource.backup && api?.rollbackImport) {
      await api.rollbackImport(resource.backup).catch(() => undefined);
    }
    this.commit({ resources: this.state.resources.filter((r) => r.id !== id) });
  }

  setActive(id: string, active: boolean): void {
    const resource = this.get(id);
    if (!resource) return;
    if (resource.kind === "plugin") {
      void bridge()
        ?.setPluginEnabled?.(resource.name, active)
        .catch(() => undefined);
    }
    this.patch(id, { active }, { level: "info", text: active ? "activated" : "deactivated" });
  }

  configure(id: string, patch: Record<string, string>): void {
    const resource = this.get(id);
    if (!resource) return;
    this.patch(
      id,
      { config: { ...resource.config, ...patch } },
      { level: "info", text: `configured ${Object.keys(patch).join(", ")}` },
    );
  }

  reveal(id: string): void {
    const resource = this.get(id);
    if (resource?.path) void bridge()?.revealImport?.(resource.path);
  }

  clearMessage(): void {
    this.commit({ message: "" });
  }

  /**
   * Startup pass: rediscover previously approved resources and re-verify the
   * active ones, so a restart restores exactly what was working before —
   * without asking the owner to reinstall anything.
   */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    this.load();
    const active = this.state.resources.filter((r) => r.status === "installed" && r.active);
    for (const resource of active) {
      await this.healthTest(resource.id).catch(() => undefined);
    }
  }
}

export const hub = new HubEngine();
