/**
 * Import, GitHub and local-factory engine.
 *
 * Intake and packaging stay on this page. FRIDAY's GitHub repository is never
 * pushed or edited here — that belongs on Friday Hub. Desktop builds:
 * - identity `friday` → `window.friday.startBuild` → scripts\\build-windows.cmd
 * - identity `other` → local factory (ZIP always; EXE only if that project has
 *   its own electron-builder.yml on Windows)
 * The browser preview does not fake a finished installer.
 */
import { APP_VERSION } from "./version";
import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { governance } from "./self/governance";

export type ImportSource = "upload" | "folder" | "github" | "url" | "clipboard";

export type ImportedFile = { path: string; size: number; type?: string | undefined };

export type ImportItem = {
  id: string;
  name: string;
  target: string;
  source: ImportSource;
  origin: string;
  files: ImportedFile[];
  fileCount: number;
  bytes: number;
  stack: string[];
  branch?: string | undefined;
  stars?: number | undefined;
  license?: string | undefined;
  status: "importing" | "ready" | "installed" | "error";
  message?: string | undefined;
  at: number;
  /** Desktop only: id of the staged scan this item can be installed from. */
  scanId?: string | undefined;
  /** Desktop only: backup folder created when the import was applied. */
  backup?: string | undefined;
  restartRequired?: boolean | undefined;
  /** How FRIDAY recognised this package (FRIDAY package, plugin, project, …). */
  kind?: string | undefined;
  /** Where the content will land inside the FRIDAY folder. */
  destinations?: { dir: string; files: number }[] | undefined;
  /** Sandbox verification result for this import. */
  verified?: "pending" | "passed" | "failed" | "skipped" | undefined;
  verifyMessage?: string | undefined;
  /** Per-pack forge-style verify (capability-verify) before install. */
  packVerify?: {
    ok: boolean;
    packs: { id: string; kind: string; ok: boolean; skipped?: boolean; detail: string }[];
  };
  /** Recognised areas from the last scan (for chat + selective install). */
  areas?: { area: string; files: number; reason?: string }[];
  /** Per-file classify preview (path → dest) so chat answers stay grounded. */
  placements?: { path: string; dest: string; area: string; reason?: string; extract?: boolean }[];
};

export type BuildIdentity = "friday" | "other";

export type BuildOptions = {
  identity?: BuildIdentity;
  name?: string;
  version?: string;
  sourceDir?: string;
  scanId?: string;
  actor?: "owner" | "friday";
  /** Renderer job id. Main stamps it on every `build:progress` event so a fast
   *  ZIP cannot finish before `startBuild` resolves. */
  clientId?: string;
};

export type BuildJob = {
  id: string;
  kind: "exe" | "zip" | "portable";
  label: string;
  identity?: BuildIdentity;
  productName?: string;
  productVersion?: string;
  progress: number;
  step: string;
  status: "queued" | "running" | "done" | "error";
  artifact?: string | undefined;
  startedAt: number;
  finishedAt?: number | undefined;
  log: string[];
};

export type ImportActivity = {
  at: number;
  actor: "owner" | "friday";
  text: string;
};

export type FactoryInspect = {
  ok: boolean;
  root?: string;
  identity?: BuildIdentity;
  name?: string;
  version?: string | null;
  electron?: boolean;
  hasBuilder?: boolean;
  exeReady?: boolean;
  friday?: boolean;
  warnings?: string[];
  error?: string;
  cancelled?: boolean;
};

export type FactoryArtifact = {
  name: string;
  path: string;
  bytes: number;
  at: number;
  kept?: boolean;
};

/** Where real builds will run from, and whether that folder is buildable. */
export type BuildRootInfo = {
  ok: boolean;
  root?: string | null;
  saved?: string | null;
  ready?: boolean;
  missing?: string[];
  warnings?: string[];
  version?: string | null;
  error?: string;
};

export type ImportState = {
  items: ImportItem[];
  builds: BuildJob[];
  activity: ImportActivity[];
  busy: boolean;
};

// Desktop bridge — absent in the browser preview, where the flow is simulated.
type ScanResult = {
  ok: boolean;
  id?: string;
  error?: string;
  version?: string | null;
  stack?: string[];
  mode?: string;
  label?: string;
  packageName?: string;
  destinations?: { dir: string; files: number }[];
  areas?: {
    area: string;
    files: number;
    added: number;
    changed: number;
    hot: boolean;
    reason?: string;
  }[];
  files?: {
    path: string;
    dest?: string;
    size: number;
    state: string;
    area: string;
    reason?: string;
    extract?: boolean;
    needsApproval?: boolean;
  }[];
  summary?: {
    total: number;
    added: number;
    changed: number;
    identical: number;
    bytes: number;
    restartRequired: boolean;
  };
};

type DesktopBridge = {
  pickImportZip?: () => Promise<{ ok: boolean; file?: string; cancelled?: boolean }>;
  pickImportFolder?: () => Promise<{ ok: boolean; folder?: string; cancelled?: boolean }>;
  stageImportBytes?: (
    name: string,
    bytes: ArrayBuffer,
  ) => Promise<{ ok: boolean; file?: string; error?: string }>;
  stageImportFile?: (
    id: string,
    relative: string,
    bytes: ArrayBuffer,
  ) => Promise<{ ok: boolean; id?: string; dir?: string; error?: string }>;
  downloadImport?: (
    url: string,
    name: string,
    token?: string,
  ) => Promise<{ ok: boolean; file?: string; error?: string }>;
  scanImport?: (source: string) => Promise<ScanResult>;
  verifyImport?: (scan: string) => Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
    steps?: { name: string; ok: boolean }[];
  }>;
  verifyImportPacks?: (scan: string) => Promise<{
    ok: boolean;
    error?: string;
    packs?: { id: string; kind: string; ok: boolean; skipped?: boolean; detail: string }[];
  }>;
  applyImport?: (
    scan: string,
    options?: { areas?: string[] },
  ) => Promise<{
    ok: boolean;
    applied?: number;
    backup?: string;
    restartRequired?: boolean;
    error?: string;
    placed?: { dir: string; files: number }[];
  }>;
  rollbackImport?: (backup: string) => Promise<{ ok: boolean; error?: string }>;
  revealImport?: (target: string) => Promise<boolean>;
  startBuild?: (
    kind: string,
    options?: BuildOptions,
  ) => Promise<{ ok: boolean; id?: string; error?: string }>;
  cancelBuild?: (id: string) => Promise<{ ok: boolean }>;
  buildArtifacts?: () => Promise<FactoryArtifact[]>;
  revealArtifact?: (file: string) => Promise<boolean>;
  buildRoot?: () => Promise<BuildRootInfo>;
  pickBuildRoot?: () => Promise<BuildRootInfo & { cancelled?: boolean }>;
  factoryInspect?: (dir: string) => Promise<FactoryInspect>;
  factoryPickSource?: () => Promise<FactoryInspect>;
  factoryKeep?: (file: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  factorySaveAs?: (file: string) => Promise<{
    ok: boolean;
    path?: string;
    cancelled?: boolean;
    error?: string;
  }>;
  factoryInstallExe?: (file: string) => Promise<{ ok: boolean; file?: string; error?: string }>;
  factoryListKept?: () => Promise<FactoryArtifact[]>;
  onBuildProgress?: (
    fn: (e: {
      id: string;
      clientId?: string;
      progress: number;
      step: string;
      line?: string;
      status: string;
      artifact?: string | null;
    }) => void,
  ) => () => void;
};

const bridge = (): DesktopBridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: DesktopBridge }).friday ?? null);

const KEY = "friday.imports.v1";
const uid = () => Math.random().toString(36).slice(2, 10);

const STACK_HINTS: { file: string; stack: string }[] = [
  { file: "package.json", stack: "Node" },
  { file: "bun.lockb", stack: "Bun" },
  { file: "pnpm-lock.yaml", stack: "pnpm" },
  { file: "requirements.txt", stack: "Python" },
  { file: "pyproject.toml", stack: "Python" },
  { file: "cargo.toml", stack: "Rust" },
  { file: "go.mod", stack: "Go" },
  { file: "dockerfile", stack: "Docker" },
  { file: "electron-builder.yml", stack: "Electron" },
  { file: ".csproj", stack: ".NET" },
];

function detectStack(paths: string[]): string[] {
  const lower = paths.map((p) => p.toLowerCase());
  const found = new Set<string>();
  for (const hint of STACK_HINTS) {
    if (lower.some((p) => p.endsWith(hint.file) || p.split("/").pop() === hint.file)) {
      found.add(hint.stack);
    }
  }
  return [...found];
}

const KIND_TO_AREA: Record<string, string> = {
  skill: "skills",
  tool: "tools",
  agent: "agents",
  module: "modules",
  plugin: "plugins",
  workflow: "workflows",
};

function packMatchesAreas(kind: string, areas?: string[]) {
  if (!areas?.length) return true;
  const area = KIND_TO_AREA[kind] || `${kind}s`;
  return areas.includes(area);
}

export function parseRepoUrl(
  input: string,
): { owner: string; repo: string; branch?: string | undefined } | null {
  const trimmed = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const m = trimmed.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/,
  );
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", branch: m[3] };
}

type Listener = () => void;

class ImportEngine {
  private state: ImportState = { items: [], builds: [], activity: [], busy: false };
  private listeners = new Set<Listener>();
  private loaded = false;
  /** UI job id → real desktop build id, so Cancel reaches the child process. */
  private buildIds = new Map<string, string>();
  private cancelledBuilds = new Set<string>();
  private buildStops = new Map<string, () => void>();

  subscribe = (fn: Listener) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ImportState => {
    this.load();
    return this.state;
  };

  list(): ImportItem[] {
    return this.getSnapshot().items;
  }

  private load() {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try {
      const parsed = readLocalState<Partial<ImportState>>(KEY);
      if (parsed) {
        this.state = {
          items: parsed.items ?? [],
          builds: (parsed.builds ?? []).map((b) => ({
            ...b,
            status: b.status === "running" || b.status === "queued" ? "error" : b.status,
          })),
          activity: parsed.activity ?? [],
          busy: false,
        };
      }
    } catch {
      /* corrupted store — start fresh */
    }
    // FRIDAY_ROOT on disk is authoritative; the cache above is only for paint.
    restoreFromDisk<Partial<ImportState>>(KEY, (parsed) => {
      this.state = {
        items: parsed.items ?? this.state.items,
        builds: (parsed.builds ?? this.state.builds).map((b) => ({
          ...b,
          status: b.status === "running" || b.status === "queued" ? "error" : b.status,
        })),
        activity: parsed.activity ?? this.state.activity,
        busy: false,
      };
      this.listeners.forEach((l) => l());
    });
  }

  private emit(next: Partial<ImportState>) {
    this.state = { ...this.state, ...next };
    if (typeof window !== "undefined") {
      try {
        writeState(KEY, {
          items: this.state.items.map((i) => ({ ...i, files: i.files.slice(0, 400) })),
          builds: this.state.builds.slice(0, 20),
          activity: this.state.activity.slice(0, 40),
        });
      } catch {
        /* quota — keep in memory only */
      }
    }
    this.listeners.forEach((l) => l());
  }

  private upsert(item: ImportItem) {
    const items = [item, ...this.state.items.filter((i) => i.id !== item.id)].slice(0, 60);
    this.emit({ items });
  }

  /** What the owner or FRIDAY just did on this page — shown so the owner can watch. */
  note(actor: "owner" | "friday", text: string) {
    const line: ImportActivity = { at: Date.now(), actor, text };
    this.emit({ activity: [line, ...this.state.activity].slice(0, 40) });
  }

  /** Merge a desktop scan result into an item so the UI shows real placement. */
  private fromScan(item: ImportItem, scan: ScanResult): ImportItem {
    return {
      ...item,
      status: "ready",
      scanId: scan.id,
      kind: scan.label,
      destinations: scan.destinations ?? [],
      areas: (scan.areas ?? []).map((a) => ({
        area: a.area,
        files: a.files,
        ...(a.reason ? { reason: a.reason } : {}),
      })),
      restartRequired: scan.summary?.restartRequired,
      fileCount: scan.summary?.total ?? item.fileCount,
      bytes: scan.summary?.bytes ?? item.bytes,
      stack: scan.stack?.length ? scan.stack : item.stack,
      files: (scan.files ?? [])
        .slice(0, 400)
        .map((f) => ({ path: f.dest ?? f.path, size: f.size })),
      placements: (scan.files ?? []).slice(0, 80).map((f) => ({
        path: f.path,
        dest: f.dest ?? f.path,
        area: f.area,
        ...(f.reason ? { reason: f.reason } : {}),
        extract: Boolean(f.extract),
      })),
      message: `${scan.label ?? "content"} · ${scan.summary?.added ?? 0} new · ${
        scan.summary?.changed ?? 0
      } changed · ${scan.summary?.identical ?? 0} unchanged`,
    };
  }

  /** Stage a batch of files on disk and scan the result (desktop only). */
  private async stageAndScan(item: ImportItem, files: File[], api: DesktopBridge) {
    const zip = files.length === 1 && /\.zip$/i.test(files[0]?.name ?? "") ? files[0] : null;
    let source: string | null = null;
    if (zip && api.stageImportBytes) {
      const staged = await api.stageImportBytes(zip.name, await zip.arrayBuffer());
      if (!staged.ok || !staged.file)
        throw new Error(staged.error || "Could not stage the archive");
      source = staged.file;
    } else if (api.stageImportFile) {
      const batch = uid();
      let dir: string | null = null;
      for (const file of files) {
        const relative =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const staged = await api.stageImportFile(batch, relative, await file.arrayBuffer());
        if (!staged.ok) throw new Error(staged.error || `Could not stage ${relative}`);
        dir = staged.dir ?? dir;
      }
      source = dir;
    }
    if (!source) throw new Error("Nothing could be staged for import");
    if (!api.scanImport) throw new Error("This build cannot scan imports");
    const scan = await api.scanImport(source);
    if (!scan.ok) throw new Error(scan.error || "The import could not be scanned");
    return scan;
  }

  /** Import local files or a whole folder (input[webkitdirectory]). */
  async importFiles(fileList: FileList | File[], target: string, source: ImportSource = "upload") {
    const files = Array.from(fileList);
    if (!files.length) return null;
    const folderish =
      source === "folder" ||
      files.some((f) =>
        Boolean((f as File & { webkitRelativePath?: string }).webkitRelativePath?.includes("/")),
      );
    if (!folderish && files.length > 1) {
      let last: ImportItem | null = null;
      for (const file of files) {
        last = await this.importOneBatch([file], target, source);
      }
      return last;
    }
    return this.importOneBatch(files, target, source);
  }

  private async importOneBatch(files: File[], target: string, source: ImportSource) {
    const paths = files.map(
      (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    );
    const bytes = files.reduce((n, f) => n + f.size, 0);
    const rootName =
      source === "folder" && paths[0]?.includes("/")
        ? (paths[0].split("/")[0] ?? "folder")
        : (files[0]?.name ?? "upload");

    const item: ImportItem = {
      id: uid(),
      name: rootName,
      target,
      source,
      origin: source === "folder" ? `local folder · ${paths.length} files` : "local upload",
      files: paths.slice(0, 400).map((p, i) => ({
        path: p,
        size: files[i]?.size ?? 0,
        type: files[i]?.type,
      })),
      fileCount: files.length,
      bytes,
      stack: detectStack(paths),
      status: "ready",
      at: Date.now(),
    };
    this.upsert(item);

    // Desktop: everything (a ZIP, a folder, loose files) is written to disk,
    // recognised by type and diffed so "Install" can place it for real.
    const api = bridge();
    if (api?.scanImport && (api.stageImportFile || api.stageImportBytes)) {
      this.emit({ busy: true });
      this.upsert({ ...item, status: "importing", message: "Staging and recognising…" });
      try {
        const scanned = this.fromScan(item, await this.stageAndScan(item, files, api));
        this.upsert(scanned);
        this.emit({ busy: false });
        this.note("owner", `Imported ${scanned.name} · ${scanned.fileCount} files`);
        return scanned;
      } catch (err) {
        const failed: ImportItem = {
          ...item,
          status: "error",
          message: err instanceof Error ? err.message : "Import failed",
        };
        this.upsert(failed);
        this.emit({ busy: false });
        this.note("owner", failed.message || "Import failed");
        return failed;
      }
    }
    return item;
  }

  /** Native picker for a ZIP package (desktop only). */
  async importPickedZip(target: string): Promise<ImportItem | "cancelled" | null> {
    const api = bridge();
    if (!api?.pickImportZip || !api.scanImport) return null;
    const picked = await api.pickImportZip();
    if (!picked.ok || !picked.file) return "cancelled";
    return this.importPath(picked.file, target, "upload");
  }

  /** Native picker for a folder (desktop only). */
  async importPickedFolder(target: string): Promise<ImportItem | "cancelled" | null> {
    const api = bridge();
    if (!api?.pickImportFolder || !api.scanImport) return null;
    const picked = await api.pickImportFolder();
    if (!picked.ok || !picked.folder) return "cancelled";
    return this.importPath(picked.folder, target, "folder");
  }

  /** Scan an absolute path already on disk. */
  private async importPath(source: string, target: string, kind: ImportSource) {
    const api = bridge();
    if (!api?.scanImport) return null;
    const name = source.split(/[\\/]/).pop() ?? source;
    const item: ImportItem = {
      id: uid(),
      name,
      target,
      source: kind,
      origin: source,
      files: [],
      fileCount: 0,
      bytes: 0,
      stack: [],
      status: "importing",
      message: "Unpacking and recognising…",
      at: Date.now(),
    };
    this.upsert(item);
    this.emit({ busy: true });
    try {
      const scan = await api.scanImport(source);
      if (!scan.ok) throw new Error(scan.error || "The import could not be scanned");
      const scanned = this.fromScan(item, scan);
      this.upsert(scanned);
      this.note("owner", `Imported ${scanned.name} · ${scanned.fileCount} files`);
      return scanned;
    } catch (err) {
      const failed: ImportItem = {
        ...item,
        status: "error",
        message: err instanceof Error ? err.message : "Import failed",
      };
      this.upsert(failed);
      return failed;
    } finally {
      this.emit({ busy: false });
    }
  }

  /** Clone / import a public GitHub repository through the GitHub REST API. */
  async importGitHub(url: string, target: string, token?: string) {
    const parsed = parseRepoUrl(url);
    if (!parsed) {
      throw new Error(
        "Not a GitHub repository URL. Use owner/repo or https://github.com/owner/repo",
      );
    }
    const { owner, repo } = parsed;
    const id = uid();
    const pending: ImportItem = {
      id,
      name: `${owner}/${repo}`,
      target,
      source: "github",
      origin: `https://github.com/${owner}/${repo}`,
      files: [],
      fileCount: 0,
      bytes: 0,
      stack: [],
      status: "importing",
      at: Date.now(),
    };
    this.upsert(pending);
    this.emit({ busy: true });

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!metaRes.ok) {
        throw new Error(
          metaRes.status === 404
            ? "Repository not found (private repos need a token)"
            : `GitHub responded ${metaRes.status}`,
        );
      }
      const meta = (await metaRes.json()) as {
        default_branch: string;
        stargazers_count: number;
        license?: { spdx_id?: string } | null;
        size: number;
        description?: string;
      };
      const branch = parsed.branch ?? meta.default_branch;

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers },
      );
      if (!treeRes.ok) throw new Error(`Could not read branch "${branch}"`);
      const tree = (await treeRes.json()) as {
        tree: { path: string; type: string; size?: number }[];
        truncated?: boolean;
      };
      const blobs = tree.tree.filter((t) => t.type === "blob");

      let done: ImportItem = {
        ...pending,
        branch,
        stars: meta.stargazers_count,
        license: meta.license?.spdx_id ?? "none",
        files: blobs.slice(0, 400).map((b) => ({ path: b.path, size: b.size ?? 0 })),
        fileCount: blobs.length,
        bytes: meta.size * 1024,
        stack: detectStack(blobs.map((b) => b.path)),
        status: "ready",
        message: meta.description ?? "",
        at: Date.now(),
      };

      // Desktop: actually download the branch archive and recognise it, so the
      // repository can be installed rather than only inspected.
      const api = bridge();
      if (api?.downloadImport && api.scanImport) {
        this.upsert({ ...done, status: "importing", message: "Downloading repository…" });
        const archive = await api.downloadImport(
          `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`,
          `${owner}-${repo}`,
          token,
        );
        if (!archive.ok || !archive.file) throw new Error(archive.error || "Download failed");
        const scan = await api.scanImport(archive.file);
        if (!scan.ok) throw new Error(scan.error || "The repository could not be scanned");
        done = this.fromScan(done, scan);
      }

      this.upsert(done);
      this.emit({ busy: false });
      return done;
    } catch (err) {
      const failed: ImportItem = {
        ...pending,
        status: "error",
        message: err instanceof Error ? err.message : "Import failed",
      };
      this.upsert(failed);
      this.emit({ busy: false });
      throw err;
    }
  }

  /** Direct URL: GitHub repos reuse importGitHub; anything else is a real HTTP download. */
  async importUrl(url: string, target: string, token?: string) {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("Paste a URL first.");
    if (parseRepoUrl(trimmed)) return this.importGitHub(trimmed, target, token);
    const api = bridge();
    const name = trimmed.split("?")[0]?.split("/").filter(Boolean).pop() || "download";
    if (api?.downloadImport && api.scanImport) {
      return this.importDownloaded(trimmed, name, target, token);
    }
    const response = await fetch(trimmed, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const buffer = await response.arrayBuffer();
    const file = new File([buffer], name, {
      type: response.headers.get("content-type") || "application/octet-stream",
    });
    return this.importFiles([file], target, "url");
  }

  private async importDownloaded(url: string, name: string, target: string, token?: string) {
    const api = bridge();
    if (!api?.downloadImport || !api.scanImport) {
      throw new Error("URL import needs the FRIDAY desktop app.");
    }
    const item: ImportItem = {
      id: uid(),
      name,
      target,
      source: "url",
      origin: url,
      files: [],
      fileCount: 0,
      bytes: 0,
      stack: [],
      status: "importing",
      message: "Downloading…",
      at: Date.now(),
    };
    this.upsert(item);
    this.emit({ busy: true });
    try {
      const archive = await api.downloadImport(url, name, token);
      if (!archive.ok || !archive.file) throw new Error(archive.error || "Download failed");
      const scan = await api.scanImport(archive.file);
      if (!scan.ok) throw new Error(scan.error || "The download could not be scanned");
      const scanned = this.fromScan(item, scan);
      this.upsert(scanned);
      this.emit({ busy: false });
      return scanned;
    } catch (err) {
      const failed: ImportItem = {
        ...item,
        status: "error",
        message: err instanceof Error ? err.message : "Download failed",
      };
      this.upsert(failed);
      this.emit({ busy: false });
      throw err;
    }
  }

  /** Paste a JSON manifest or code snippet as a one-file import. */
  async importClipboard(text: string, target: string) {
    const body = text.trim();
    if (!body) throw new Error("Clipboard is empty.");
    const json = body.startsWith("{") || body.startsWith("[");
    const name = json ? "clipboard.json" : "clipboard.txt";
    const file = new File([body], name, { type: json ? "application/json" : "text/plain" });
    const item = await this.importFiles([file], target, "clipboard");
    if (item) this.upsert({ ...item, source: "clipboard", origin: "clipboard paste" });
    return item;
  }

  install(id: string, options: { areas?: string[]; actor?: "owner" | "friday" } = {}) {
    void this.installNow(id, options);
  }

  /**
   * Verify each pack with capability-verify (the forge sandbox), file the
   * existing governance install gate, apply only after approval, then drop
   * the item from this page so it lives only in its real section.
   */
  async installNow(id: string, options: { areas?: string[]; actor?: "owner" | "friday" } = {}) {
    const actor = options.actor === "friday" ? "friday" : "owner";
    const item = this.state.items.find((i) => i.id === id);
    const api = bridge();
    if (!item) return { ok: false, error: "That import is gone." };
    if (!item.scanId || !api?.applyImport) {
      this.upsert({
        ...item,
        status: "error",
        message: "Install needs the FRIDAY desktop app — nothing was copied.",
      });
      return { ok: false, error: "desktop only" };
    }

    this.emit({ busy: true });
    this.upsert({ ...item, status: "importing", message: "Verifying packs in the sandbox…" });
    try {
      const packs = api.verifyImportPacks
        ? await api.verifyImportPacks(item.scanId)
        : { ok: true, packs: [] };
      const packVerify = {
        ok: Boolean(packs.ok),
        packs: (packs.packs ?? []).map((p) => ({
          id: p.id,
          kind: p.kind,
          ok: Boolean(p.ok),
          skipped: Boolean(p.skipped),
          detail: p.detail || "",
        })),
      };
      this.upsert({
        ...item,
        packVerify,
        verified: packVerify.ok ? "passed" : "failed",
        verifyMessage: packVerify.ok
          ? packVerify.packs.length
            ? "Pack sandbox checks passed"
            : "No capability packs to sandbox-verify"
          : packs.error ||
            packVerify.packs
              .filter((p) => !p.ok && !p.skipped)
              .map((p) => `${p.id}: ${p.detail}`)
              .join("; ") ||
            "Pack verify failed",
      });

      const latest = this.state.items.find((i) => i.id === id) ?? item;
      const relevant = packVerify.packs.filter((p) => packMatchesAreas(p.kind, options.areas));
      const verifyOk = relevant.every((p) => p.ok || p.skipped);
      if (!verifyOk) {
        this.upsert({
          ...latest,
          packVerify,
          status: "ready",
          message: "Sandbox verify failed — nothing installed. See pack results before retrying.",
        });
        this.emit({ busy: false });
        this.note(actor, `Sandbox verify failed for ${latest.name} — nothing installed.`);
        return { ok: false, error: latest.verifyMessage || "verify failed" };
      }
      const gate = await governance.submit({
        kind: "install",
        title: `Install import “${latest.name}”`,
        rationale: `Place ${latest.fileCount} recognised file(s) into their real FRIDAY homes${
          options.areas?.length ? ` (only ${options.areas.join(", ")})` : ""
        }. Chat and Connectors stay parked until you confirm those surfaces.`,
        risk: "review",
        evidence: [
          latest.origin,
          ...(latest.destinations ?? []).map((d) => `${d.dir} (${d.files})`),
          ...packVerify.packs.map((p) => `${p.kind}:${p.id} ${p.ok ? "pass" : p.detail}`),
        ],
        dryRun: async () => ({
          ok: verifyOk,
          detail: latest.verifyMessage || (verifyOk ? "sandbox passed" : "sandbox failed"),
        }),
        apply: async () => {
          const result = await api.applyImport!(latest.scanId!, {
            ...(options.areas?.length ? { areas: options.areas } : {}),
          });
          if (!result.ok) return { ok: false, detail: result.error || "Install failed" };
          return {
            ok: true,
            detail: `${result.applied ?? 0} files placed`,
            ...(result.backup ? { checkpoint: result.backup } : {}),
          };
        },
        ...(latest.backup
          ? {
              rollback: async () => {
                const undone = await api.rollbackImport?.(latest.backup || "");
                return {
                  ok: Boolean(undone?.ok),
                  detail: undone?.ok ? "rolled back" : undone?.error || "rollback failed",
                };
              },
            }
          : {}),
      });

      if (gate.stage === "waiting-approval") {
        this.upsert({
          ...latest,
          packVerify,
          status: "ready",
          message: "Waiting for approval in Self-management — nothing copied yet.",
        });
        this.emit({ busy: false });
        this.note(actor, `Install of ${latest.name} waiting for Self-management approval.`);
        return { ok: true, pending: true };
      }
      if (gate.stage !== "completed") {
        this.upsert({
          ...latest,
          packVerify,
          status: "error",
          message: gate.error || `Install ${gate.stage}`,
        });
        this.emit({ busy: false });
        return { ok: false, error: gate.error || gate.stage };
      }
      this.remove(id);
      this.emit({ busy: false });
      this.note(actor, `Installed ${latest.name} into its real section — it left this page.`);
      return { ok: true };
    } catch (err) {
      this.upsert({
        ...item,
        status: "error",
        message: err instanceof Error ? err.message : "Install failed",
      });
      this.emit({ busy: false });
      return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
    }
  }

  async verifyPacks(id: string) {
    const item = this.state.items.find((i) => i.id === id);
    const api = bridge();
    if (!item?.scanId || !api?.verifyImportPacks) {
      return { ok: false, error: "Pack verify needs the desktop app.", packs: [] };
    }
    this.upsert({ ...item, verified: "pending", verifyMessage: "Verifying packs in the sandbox…" });
    try {
      const result = await api.verifyImportPacks(item.scanId);
      const packVerify = {
        ok: Boolean(result.ok),
        packs: (result.packs ?? []).map((p) => ({
          id: p.id,
          kind: p.kind,
          ok: Boolean(p.ok),
          skipped: Boolean(p.skipped),
          detail: p.detail || "",
        })),
      };
      this.upsert({
        ...item,
        packVerify,
        verified: packVerify.ok ? "passed" : "failed",
        verifyMessage: packVerify.ok
          ? "Pack sandbox checks passed"
          : result.error || "Pack verify failed",
      });
      this.note("owner", `Pack verify ${packVerify.ok ? "passed" : "failed"} for ${item.name}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed";
      this.upsert({ ...item, verified: "failed", verifyMessage: message });
      return { ok: false, error: message, packs: [] };
    }
  }

  /** Undo an applied desktop import from its backup. */
  async rollback(id: string) {
    const item = this.state.items.find((i) => i.id === id);
    const api = bridge();
    if (!item?.backup || !api?.rollbackImport) return { ok: false };
    const result = await api.rollbackImport(item.backup);
    this.upsert({
      ...item,
      status: result.ok ? "ready" : "error",
      message: result.ok
        ? "Rolled back to the previous version"
        : result.error || "Rollback failed",
    });
    return result;
  }

  /** Run the sandbox (typecheck + tests) against a staged import. */
  async verify(id: string) {
    const item = this.state.items.find((i) => i.id === id);
    const api = bridge();
    if (!item?.scanId || !api?.verifyImport) {
      return { ok: false, error: "Sandbox verification is only available in the desktop app." };
    }
    this.upsert({ ...item, verified: "pending", verifyMessage: "Running sandbox checks…" });
    try {
      const result = await api.verifyImport(item.scanId);
      const failed = (result.steps ?? []).filter((s) => !s.ok).map((s) => s.name);
      this.upsert({
        ...item,
        verified: result.skipped ? "skipped" : result.ok ? "passed" : "failed",
        verifyMessage: result.skipped
          ? result.error || "Sandbox not available here"
          : result.ok
            ? "Sandbox checks passed"
            : `Failed: ${failed.join(", ") || result.error || "unknown"}`,
      });
      this.note(
        "owner",
        result.skipped
          ? `Sandbox skipped for ${item.name}`
          : `Sandbox ${result.ok ? "passed" : "failed"} for ${item.name}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed";
      this.upsert({ ...item, verified: "failed", verifyMessage: message });
      return { ok: false, error: message };
    }
  }

  /** Open an installed destination (or artifact) in the file manager. */
  reveal(target: string) {
    const api = bridge();
    if (api?.revealImport) void api.revealImport(target);
    else if (api?.revealArtifact) void api.revealArtifact(target);
  }

  /** Artifacts already present in release/ and releases/installers. */
  async artifacts() {
    const api = bridge();
    if (!api?.buildArtifacts) return [];
    try {
      return await api.buildArtifacts();
    } catch {
      return [];
    }
  }

  /** Which folder real builds will run from (desktop only). */
  async buildRoot(): Promise<BuildRootInfo> {
    const api = bridge();
    if (!api?.buildRoot) {
      return { ok: false, error: "Builds run in the FRIDAY desktop app." };
    }
    try {
      return await api.buildRoot();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Build root unavailable" };
    }
  }

  /** Let the owner point FRIDAY at its source project once; it is remembered. */
  async pickBuildRoot(): Promise<BuildRootInfo & { cancelled?: boolean }> {
    const api = bridge();
    if (!api?.pickBuildRoot) {
      return { ok: false, error: "Builds run in the FRIDAY desktop app." };
    }
    try {
      return await api.pickBuildRoot();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Could not open the picker" };
    }
  }

  remove(id: string) {
    this.emit({ items: this.state.items.filter((i) => i.id !== id) });
  }

  clear() {
    this.buildStops.forEach((stop) => stop());
    this.buildStops.clear();
    this.buildIds.clear();
    this.cancelledBuilds.clear();
    this.emit({ items: [], builds: [], activity: [], busy: false });
  }

  /** Download the source archive for a GitHub import. */
  archiveUrl(item: ImportItem) {
    if (item.source !== "github") return null;
    const parsed = parseRepoUrl(item.origin);
    if (!parsed) return null;
    return `https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip/refs/heads/${item.branch ?? "main"}`;
  }

  /** Queue an EXE / ZIP / portable build. Never fakes a finished installer. */
  build(kind: BuildJob["kind"], label: string, options: BuildOptions = {}) {
    const identity: BuildIdentity = options.identity === "other" ? "other" : "friday";
    const actor = options.actor === "friday" ? "friday" : "owner";
    const productName = identity === "friday" ? "FRIDAY" : (options.name || "app").trim() || "app";
    const productVersion =
      identity === "friday" ? APP_VERSION : (options.version || "0.0.1").trim() || "0.0.1";
    const id = uid();
    const steps =
      identity === "other"
        ? kind === "zip"
          ? ["copy source (skip vendor folders)", "write local ZIP into downloads/kept-builds"]
          : [
              "copy source (skip vendor folders)",
              "run this project's own electron-builder",
              "copy installer into downloads/kept-builds",
            ]
        : kind === "exe"
          ? [
              "vite build — renderer bundle",
              "compiling kernel resources",
              "electron-builder — packing app.asar",
              "NSIS — writing installer",
              "signing & checksum",
            ]
          : kind === "portable"
            ? [
                "vite build — renderer bundle",
                "copying kernel + modules",
                "packing portable folder",
              ]
            : ["collecting project files", "excluding node_modules / venv", "writing archive"];

    const job: BuildJob = {
      id,
      kind,
      label,
      identity,
      productName,
      productVersion,
      progress: 0,
      step: steps[0] ?? "starting",
      status: "running",
      startedAt: Date.now(),
      log: [`[${new Date().toLocaleTimeString()}] ${actor} queued ${identity} ${kind} — ${label}`],
    };
    this.emit({ builds: [job, ...this.state.builds].slice(0, 20) });
    this.note(actor, `Queued ${identity} ${kind}: ${label}`);

    const api = bridge();
    if (!api?.startBuild || !api.onBuildProgress) {
      const step =
        "Real packaging runs in the FRIDAY desktop app. This preview will not fake a finished installer.";
      this.emit({
        builds: this.state.builds.map((b) =>
          b.id === id
            ? { ...b, status: "error", step, finishedAt: Date.now(), log: [...b.log, step] }
            : b,
        ),
      });
      this.note(actor, step);
      return id;
    }

    const patch = (next: Partial<BuildJob>) => {
      if (this.cancelledBuilds.has(id)) return;
      this.emit({
        builds: this.state.builds.map((b) => (b.id === id ? { ...b, ...next } : b)),
      });
    };
    let stop: (() => void) | null = null;
    let realId: string | null = null;
    const pending: Array<{
      id: string;
      clientId?: string;
      progress: number;
      step: string;
      line?: string;
      status: string;
      artifact?: string | null;
    }> = [];
    const applyEvent = (event: (typeof pending)[number]) => {
      if (this.cancelledBuilds.has(id)) return;
      const current = this.state.builds.find((b) => b.id === id);
      const next: Partial<BuildJob> = {
        progress: event.progress,
        step: event.step,
        status: event.status === "done" ? "done" : event.status === "error" ? "error" : "running",
        log: [
          ...(current?.log ?? []).slice(-60),
          `[${new Date().toLocaleTimeString()}] ${event.line ?? event.step}`,
        ],
      };
      const artifact = event.artifact ?? current?.artifact;
      if (artifact) next.artifact = artifact;
      if (event.status !== "running" && event.status !== "queued") next.finishedAt = Date.now();
      patch(next);
      if (event.status !== "running" && event.status !== "queued") {
        stop?.();
        this.buildStops.delete(id);
      }
    };
    const mine = (event: (typeof pending)[number]) =>
      event.clientId === id || (Boolean(realId) && event.id === realId);
    stop = api.onBuildProgress((event) => {
      if (this.cancelledBuilds.has(id)) return;
      if (!mine(event)) {
        if (!realId) pending.push(event);
        return;
      }
      applyEvent(event);
    });
    this.buildStops.set(id, () => {
      stop?.();
      this.buildStops.delete(id);
    });
    const startOpts: BuildOptions = {
      identity,
      name: productName,
      version: productVersion,
      clientId: id,
    };
    if (options.sourceDir) startOpts.sourceDir = options.sourceDir;
    if (options.scanId) startOpts.scanId = options.scanId;
    void api
      .startBuild(kind, startOpts)
      .then((started) => {
        if (this.cancelledBuilds.has(id)) {
          if (started.ok && started.id && api.cancelBuild) void api.cancelBuild(started.id);
          stop?.();
          this.buildStops.delete(id);
          return;
        }
        if (!started.ok || !started.id) {
          stop?.();
          this.buildStops.delete(id);
          const step = started.error || "Build could not be started";
          patch({
            status: "error",
            step,
            finishedAt: Date.now(),
          });
          this.note(actor, step);
          return;
        }
        realId = started.id;
        this.buildIds.set(id, started.id);
        for (const event of pending) {
          if (mine(event)) applyEvent(event);
        }
        pending.length = 0;
      })
      .catch((err: unknown) => {
        stop?.();
        this.buildStops.delete(id);
        if (this.cancelledBuilds.has(id)) return;
        const step = err instanceof Error ? err.message : "Build failed to start";
        patch({
          status: "error",
          step,
          finishedAt: Date.now(),
        });
        this.note(actor, step);
      });
    return id;
  }

  async keepArtifact(file: string, actor: "owner" | "friday" = "owner") {
    const api = bridge();
    if (!api?.factoryKeep) {
      return { ok: false as const, error: "Keeping artifacts needs the FRIDAY desktop app." };
    }
    const result = await api.factoryKeep(file);
    this.note(
      actor,
      result.ok ? `Kept ${result.path || file}` : result.error || "Could not keep that artifact",
    );
    return result;
  }

  async saveArtifact(file: string, actor: "owner" | "friday" = "owner") {
    const api = bridge();
    if (!api?.factorySaveAs) {
      return { ok: false as const, error: "Download / save-as needs the FRIDAY desktop app." };
    }
    const result = await api.factorySaveAs(file);
    if (!result.cancelled) {
      this.note(actor, result.ok ? `Saved copy to ${result.path}` : result.error || "Save failed");
    }
    return result;
  }

  async installExe(file: string, actor: "owner" | "friday" = "owner") {
    const api = bridge();
    const launch = api?.factoryInstallExe;
    if (!launch) {
      return {
        ok: false as const,
        error: "Launching an installer needs the FRIDAY desktop app on Windows.",
      };
    }
    this.note(actor, `Asked to install ${file.split(/[\\/]/).pop()}`);
    const gate = await governance.submit({
      kind: "install",
      title: `Install built EXE “${file.split(/[\\/]/).pop() ?? "app"}”`,
      rationale:
        "Launch the local Windows installer produced on Import & Build. This does not push FRIDAY's GitHub repository.",
      risk: "review",
      evidence: [file],
      apply: async () => {
        const result = await launch(file);
        if (!result.ok) return { ok: false, detail: result.error || "installer did not start" };
        return { ok: true, detail: result.file || file };
      },
    });
    if (gate.stage === "waiting-approval") {
      this.note(actor, "Installer waiting for approval in Self-management.");
      return { ok: true as const, pending: true };
    }
    if (gate.stage !== "completed") {
      const error = gate.error || `Install ${gate.stage}`;
      this.note(actor, error);
      return { ok: false as const, error };
    }
    this.note(actor, "Installer launched.");
    return { ok: true as const };
  }

  /** Re-scan a kept zip/folder so it can be installed into a real FRIDAY section. */
  async stageArtifact(source: string, target = "Workspace", actor: "owner" | "friday" = "owner") {
    const item = await this.importPath(source, target, "upload");
    if (!item) {
      const error = "Installing into FRIDAY needs the desktop app.";
      this.note(actor, error);
      return { ok: false as const, error };
    }
    if (item.status === "error") {
      this.note(actor, item.message || "Scan failed");
      return { ok: false as const, error: item.message || "Scan failed" };
    }
    this.note(actor, `Staged ${item.name} — Install places it in its real section.`);
    return { ok: true as const, id: item.id };
  }

  async inspectSource(dir: string): Promise<FactoryInspect> {
    const api = bridge();
    if (!api?.factoryInspect) {
      return { ok: false, error: "Source inspect needs the FRIDAY desktop app." };
    }
    return api.factoryInspect(dir);
  }

  async pickFactorySource(): Promise<FactoryInspect> {
    const api = bridge();
    if (!api?.factoryPickSource) {
      return { ok: false, error: "Choosing a project folder needs the FRIDAY desktop app." };
    }
    return api.factoryPickSource();
  }

  async listKept(): Promise<FactoryArtifact[]> {
    const api = bridge();
    if (!api?.factoryListKept && !api?.buildArtifacts) return [];
    try {
      if (api.factoryListKept) return await api.factoryListKept();
      return (await api.buildArtifacts?.()) ?? [];
    } catch {
      return [];
    }
  }

  cancelBuild(id: string) {
    this.cancelledBuilds.add(id);
    this.buildStops.get(id)?.();
    const realId = this.buildIds.get(id);
    const api = bridge();
    if (realId && api?.cancelBuild) void api.cancelBuild(realId);
    this.emit({
      builds: this.state.builds.map((b) =>
        b.id === id && (b.status === "running" || b.status === "queued")
          ? { ...b, status: "error", step: "cancelled by user", finishedAt: Date.now() }
          : b,
      ),
    });
    this.note("owner", "Build cancelled");
    this.buildIds.delete(id);
  }
}

export const imports = new ImportEngine();

export function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
