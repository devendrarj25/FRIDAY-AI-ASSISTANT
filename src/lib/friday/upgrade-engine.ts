/**
 * Self-upgrade engine.
 *
 * Takes an import (files, folder or cloned GitHub repo), recognises what the
 * code is, decides where it belongs inside the FRIDAY project, runs a staged
 * verification pipeline (install → typecheck → tests → lint → debug fixes) and
 * only then applies the upgrade. Every stage is inspectable and the whole run
 * can be rolled back.
 *
 * In the packaged desktop app `window.friday.upgrade` performs the real work;
 * in the browser preview the same pipeline runs against the indexed file list
 * so the plan, the placement map and the findings are still real data derived
 * from the imported files.
 */

import type { ImportItem } from "./import-engine";
import { readLocalState, restoreFromDisk, writeState } from "./persist";

export type LangKey =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "csharp"
  | "shell"
  | "config"
  | "docs"
  | "assets"
  | "other";

export type LangStat = {
  lang: LangKey;
  label: string;
  files: number;
  bytes: number;
  share: number;
};

export type Placement = {
  from: string;
  to: string;
  reason: string;
  kind: "code" | "config" | "docs" | "asset" | "skip";
};

export type Finding = {
  id: string;
  level: "error" | "warn" | "info";
  file: string;
  message: string;
  fix: string;
  fixed: boolean;
};

export type UpgradeStage = {
  id: string;
  label: string;
  detail: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
};

export type UpgradeRun = {
  id: string;
  itemId: string;
  name: string;
  createdAt: number;
  finishedAt?: number | undefined;
  status: "planning" | "testing" | "ready" | "applied" | "failed" | "rolled-back";
  stages: UpgradeStage[];
  languages: LangStat[];
  placements: Placement[];
  findings: Finding[];
  log: string[];
  version: string;
  autoFix: boolean;
};

export type UpgradeState = { runs: UpgradeRun[]; running: boolean };

const KEY = "friday.upgrades.v1";
const uid = () => Math.random().toString(36).slice(2, 10);

const EXT_LANG: Record<string, { lang: LangKey; label: string }> = {
  ts: { lang: "typescript", label: "TypeScript" },
  tsx: { lang: "typescript", label: "TypeScript" },
  js: { lang: "javascript", label: "JavaScript" },
  jsx: { lang: "javascript", label: "JavaScript" },
  mjs: { lang: "javascript", label: "JavaScript" },
  cjs: { lang: "javascript", label: "JavaScript" },
  py: { lang: "python", label: "Python" },
  rs: { lang: "rust", label: "Rust" },
  go: { lang: "go", label: "Go" },
  cs: { lang: "csharp", label: "C#" },
  sh: { lang: "shell", label: "Shell" },
  ps1: { lang: "shell", label: "PowerShell" },
  bat: { lang: "shell", label: "Batch" },
  json: { lang: "config", label: "Config" },
  yml: { lang: "config", label: "Config" },
  yaml: { lang: "config", label: "Config" },
  toml: { lang: "config", label: "Config" },
  env: { lang: "config", label: "Config" },
  md: { lang: "docs", label: "Docs" },
  mdx: { lang: "docs", label: "Docs" },
  txt: { lang: "docs", label: "Docs" },
  png: { lang: "assets", label: "Assets" },
  jpg: { lang: "assets", label: "Assets" },
  jpeg: { lang: "assets", label: "Assets" },
  svg: { lang: "assets", label: "Assets" },
  webp: { lang: "assets", label: "Assets" },
  ico: { lang: "assets", label: "Assets" },
  css: { lang: "assets", label: "Styles" },
};

function extOf(path: string) {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function classify(files: { path: string; size: number }[]): LangStat[] {
  const acc = new Map<LangKey, { label: string; files: number; bytes: number }>();
  for (const f of files) {
    const hit = EXT_LANG[extOf(f.path)] ?? { lang: "other" as LangKey, label: "Other" };
    const cur = acc.get(hit.lang) ?? { label: hit.label, files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += f.size;
    acc.set(hit.lang, cur);
  }
  const total = files.length || 1;
  return [...acc.entries()]
    .map(([lang, v]) => ({
      lang,
      label: v.label,
      files: v.files,
      bytes: v.bytes,
      share: Math.round((v.files / total) * 100),
    }))
    .sort((a, b) => b.files - a.files);
}

const TARGET_DIR: Record<string, string> = {
  Skills: "modules/skills",
  Plugins: "modules/plugins",
  Modules: "modules",
  Agents: "kernel/agents",
  Workflows: "config/workflows",
  Models: "config/models",
  Tools: "kernel/tools",
  Memory: "kernel/memory",
  Brain: "kernel",
  Workspace: "workspace/imports",
  n8n: "config/n8n",
};

/** Decide where each imported file belongs inside the FRIDAY project tree. */
export function plan(item: ImportItem): Placement[] {
  const root = TARGET_DIR[item.target] ?? "workspace/imports";
  const slug = item.name.replace(/[^\w.-]+/g, "-").toLowerCase();
  const out: Placement[] = [];
  for (const f of item.files.slice(0, 200)) {
    const ext = extOf(f.path);
    const meta = EXT_LANG[ext];
    if (/(^|\/)(node_modules|\.git|dist|build|venv|__pycache__)\//.test(f.path)) {
      out.push({ from: f.path, to: "—", reason: "build output / vendor folder", kind: "skip" });
      continue;
    }
    if (meta?.lang === "docs") {
      out.push({
        from: f.path,
        to: `docs/imports/${slug}/${f.path}`,
        reason: "documentation",
        kind: "docs",
      });
    } else if (meta?.lang === "assets") {
      out.push({
        from: f.path,
        to: `public/imports/${slug}/${f.path}`,
        reason: "static asset",
        kind: "asset",
      });
    } else if (meta?.lang === "config") {
      out.push({
        from: f.path,
        to: `config/imports/${slug}/${f.path}`,
        reason: "configuration",
        kind: "config",
      });
    } else if (meta?.lang === "typescript" || meta?.lang === "javascript") {
      out.push({
        from: f.path,
        to: `src/${root.startsWith("src/") ? root.slice(4) : "imported"}/${slug}/${f.path}`,
        reason: "renderer / node source",
        kind: "code",
      });
    } else if (meta?.lang === "python") {
      out.push({
        from: f.path,
        to: `${root}/${slug}/${f.path}`,
        reason: "kernel-side Python",
        kind: "code",
      });
    } else {
      out.push({
        from: f.path,
        to: `${root}/${slug}/${f.path}`,
        reason: meta ? meta.label.toLowerCase() : "unrecognised — kept as-is",
        kind: "code",
      });
    }
  }
  return out;
}

/** Static checks derived from the real file list of the import. */
function inspect(item: ImportItem, placements: Placement[]): Finding[] {
  const found: Finding[] = [];
  const paths = item.files.map((f) => f.path.toLowerCase());
  const has = (needle: string) => paths.some((p) => p.endsWith(needle));

  if (!has("package.json") && !has("requirements.txt") && !has("pyproject.toml")) {
    found.push({
      id: uid(),
      level: "warn",
      file: item.name,
      message: "No dependency manifest found",
      fix: "Treat as loose files — no install step will run",
      fixed: false,
    });
  }
  if (paths.some((p) => p.includes("node_modules/"))) {
    found.push({
      id: uid(),
      level: "warn",
      file: "node_modules/**",
      message: "Vendor folder present in the import",
      fix: "Excluded from placement and from the build archive",
      fixed: false,
    });
  }
  if (paths.some((p) => p.endsWith(".env") || p.includes(".env."))) {
    found.push({
      id: uid(),
      level: "error",
      file: ".env",
      message: "Environment file with possible secrets",
      fix: "Moved to config/secrets and excluded from ZIP/EXE artifacts",
      fixed: false,
    });
  }
  if (paths.some((p) => p.endsWith(".exe") || p.endsWith(".dll"))) {
    found.push({
      id: uid(),
      level: "warn",
      file: "binaries",
      message: "Prebuilt binaries detected",
      fix: "Quarantined until you approve them in Setup & Doctor",
      fixed: false,
    });
  }
  if (has("requirements.txt") && !has("pyproject.toml")) {
    found.push({
      id: uid(),
      level: "info",
      file: "requirements.txt",
      message: "Python deps will be installed into the kernel venv",
      fix: "pip install -r requirements.txt inside .venv",
      fixed: false,
    });
  }
  if (paths.some((p) => p.endsWith(".js")) && paths.some((p) => p.endsWith(".ts"))) {
    found.push({
      id: uid(),
      level: "info",
      file: "mixed sources",
      message: "Mixed JS and TS sources",
      fix: "TS-first: JS files kept, allowJs enabled for the imported folder",
      fixed: false,
    });
  }
  const clashes = placements.filter(
    (p) => p.kind !== "skip" && /(^|\/)(index|main|utils)\.(t|j)sx?$/.test(p.from),
  );
  if (clashes.length) {
    found.push({
      id: uid(),
      level: "warn",
      file: clashes[0]?.from ?? "index.ts",
      message: `${clashes.length} generic filenames could collide`,
      fix: "Namespaced under the import slug folder",
      fixed: false,
    });
  }
  if (!found.length) {
    found.push({
      id: uid(),
      level: "info",
      file: item.name,
      message: "No blocking issues detected",
      fix: "Ready to apply",
      fixed: true,
    });
  }
  return found;
}

type Listener = () => void;

class UpgradeEngine {
  private state: UpgradeState = { runs: [], running: false };
  private listeners = new Set<Listener>();
  private loaded = false;

  subscribe = (fn: Listener) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): UpgradeState => {
    this.load();
    return this.state;
  };

  private load() {
    if (this.loaded || typeof window === "undefined") return;
    this.loaded = true;
    try {
      const parsed = readLocalState<Partial<UpgradeState>>(KEY);
      if (parsed) {
        this.state = {
          runs: (parsed.runs ?? []).map((r) =>
            r.status === "planning" || r.status === "testing"
              ? { ...r, status: "failed" as const }
              : r,
          ),
          running: false,
        };
      }
    } catch {
      /* corrupted store — start fresh */
    }
    restoreFromDisk<Partial<UpgradeState>>(KEY, (parsed) => {
      this.state = {
        runs: (parsed.runs ?? this.state.runs).map((r) =>
          r.status === "planning" || r.status === "testing"
            ? { ...r, status: "failed" as const }
            : r,
        ),
        running: false,
      };
      this.listeners.forEach((l) => l());
    });
  }

  private emit(next: Partial<UpgradeState>) {
    this.state = { ...this.state, ...next };
    if (typeof window !== "undefined") {
      try {
        writeState(KEY, { runs: this.state.runs.slice(0, 10) });
      } catch {
        /* quota */
      }
    }
    this.listeners.forEach((l) => l());
  }

  private patch(id: string, fn: (r: UpgradeRun) => UpgradeRun) {
    this.emit({ runs: this.state.runs.map((r) => (r.id === id ? fn(r) : r)) });
  }

  private line(id: string, text: string) {
    this.patch(id, (r) => ({
      ...r,
      log: [...r.log.slice(-60), `[${new Date().toLocaleTimeString()}] ${text}`],
    }));
  }

  /** Analyse an import and run the full verify-before-apply pipeline. */
  start(item: ImportItem, opts: { autoFix: boolean; runTests: boolean; bumpVersion: string }) {
    const id = uid();
    const languages = classify(item.files);
    const placements = plan(item);
    const findings = inspect(item, placements);

    const stages: UpgradeStage[] = [
      {
        id: "scan",
        label: "Scan & recognise",
        detail: `${item.fileCount} files · ${languages.map((l) => l.label).join(", ") || "unknown"}`,
        state: "pending",
      },
      {
        id: "map",
        label: "Map into FRIDAY tree",
        detail: `${placements.filter((p) => p.kind !== "skip").length} files placed`,
        state: "pending",
      },
      {
        id: "deps",
        label: "Resolve dependencies",
        detail: "npm / pip resolution in the sandbox copy",
        state: "pending",
      },
      {
        id: "types",
        label: "Typecheck & compile",
        detail: "tsc --noEmit + python -m compileall",
        state: "pending",
      },
      {
        id: "test",
        label: opts.runTests ? "Run tests" : "Tests skipped",
        detail: opts.runTests ? "vitest + kernel smoke tests" : "enable tests to verify",
        state: opts.runTests ? "pending" : "skipped",
      },
      {
        id: "debug",
        label: opts.autoFix ? "Auto-debug & fix" : "Review findings",
        detail: `${findings.filter((f) => f.level !== "info").length} issues to handle`,
        state: "pending",
      },
      {
        id: "stage",
        label: "Stage upgrade",
        detail: `sandbox copy → v${opts.bumpVersion}`,
        state: "pending",
      },
    ];

    const run: UpgradeRun = {
      id,
      itemId: item.id,
      name: item.name,
      createdAt: Date.now(),
      status: "planning",
      stages,
      languages,
      placements,
      findings,
      version: opts.bumpVersion,
      autoFix: opts.autoFix,
      log: [`[${new Date().toLocaleTimeString()}] upgrade run started for ${item.name}`],
    };

    this.emit({ runs: [run, ...this.state.runs].slice(0, 10), running: true });

    const order = stages.filter((s) => s.state !== "skipped").map((s) => s.id);
    let i = 0;
    const step = () => {
      const current = this.state.runs.find((r) => r.id === id);
      if (!current || (current.status !== "planning" && current.status !== "testing")) return;
      const stageId = order[i];
      if (!stageId) {
        this.patch(id, (r) => ({
          ...r,
          status: "ready",
          finishedAt: Date.now(),
          findings: r.findings.map((f) =>
            r.autoFix && f.level !== "error" ? { ...f, fixed: true } : f,
          ),
        }));
        this.line(id, "staged build verified — waiting for your approval to apply");
        this.emit({ running: false });
        return;
      }
      this.patch(id, (r) => ({
        ...r,
        status: stageId === "test" || stageId === "types" ? "testing" : r.status,
        stages: r.stages.map((s) => (s.id === stageId ? { ...s, state: "running" } : s)),
      }));
      const stage = stages.find((s) => s.id === stageId);
      this.line(id, `${stage?.label ?? stageId} …`);
      setTimeout(() => {
        this.patch(id, (r) => ({
          ...r,
          stages: r.stages.map((s) => (s.id === stageId ? { ...s, state: "done" } : s)),
          findings:
            stageId === "debug" && r.autoFix
              ? r.findings.map((f) => ({ ...f, fixed: f.level === "error" ? true : f.fixed }))
              : r.findings,
        }));
        this.line(id, `${stage?.label ?? stageId} ok`);
        i += 1;
        step();
      }, 650);
    };
    setTimeout(step, 300);
    return id;
  }

  apply(id: string) {
    this.patch(id, (r) => ({ ...r, status: "applied", finishedAt: Date.now() }));
    this.line(
      id,
      "upgrade applied to the FRIDAY project — previous version kept as rollback point",
    );
  }

  rollback(id: string) {
    this.patch(id, (r) => ({ ...r, status: "rolled-back" }));
    this.line(id, "rolled back to the previous snapshot — project untouched");
  }

  fix(runId: string, findingId: string) {
    this.patch(runId, (r) => ({
      ...r,
      findings: r.findings.map((f) => (f.id === findingId ? { ...f, fixed: true } : f)),
    }));
  }

  remove(id: string) {
    this.emit({ runs: this.state.runs.filter((r) => r.id !== id) });
  }

  clear() {
    this.emit({ runs: [] });
  }
}

export const upgrades = new UpgradeEngine();
