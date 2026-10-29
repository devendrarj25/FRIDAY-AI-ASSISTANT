/**
 * FRIDAY · core/discovery
 *
 * One canonical, manifest-driven discovery layer for every capability tree
 * (agents, skills, tools, modules, plugins, workflows, models).
 *
 * A capability is a folder holding a manifest file, or a flat `*.json`
 * manifest inside the tree's `manifests/` folder. Nothing here invents data:
 * every entry corresponds to a file that exists on disk right now. Enabled
 * state is persisted to `<root>/config/capabilities.json` so a toggle survives
 * a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { FridayModule, ModuleContext } from "./types";
import { bus } from "./event-bus";

export type CapabilityTree =
  "agents" | "skills" | "tools" | "modules" | "plugins" | "workflows" | "models";

export interface CapabilityEntry {
  /** `<tree>/<segment>/<folder>` — stable and unique across the app. */
  id: string;
  tree: CapabilityTree;
  /** Sub-folder the entry was discovered in (core, custom, installed, …). */
  segment: string;
  name: string;
  version: string | null;
  summary: string;
  description: string;
  category: string;
  /** Absolute path of the folder (or manifest file for flat manifests). */
  path: string;
  manifestFile: string | null;
  entry: string | null;
  permissions: string[];
  inputs: string[];
  /** Manifest `approvalPrompt` when declared; empty when the pack has none. */
  approvalPrompt: string;
  /** Agent persona role when declared; empty otherwise. */
  role: string;
  /** Agent skill ids when declared; empty otherwise. */
  skills: string[];
  /** Agent workflow ids when declared; empty otherwise. */
  workflows: string[];
  risk: "safe" | "write" | "exec";
  enabled: boolean;
  source: "manifest" | "folder";
  /** Set when this entry replaced an earlier source's entry with the same id. */
  shadows?: { path: string; version: string | null } | null;
  discoveredAt: number;
}

/**
 * ONE structure contract, shared with the Electron discovery pass
 * (electron/capabilities.cjs) and the path resolver — so a tree, a segment or
 * a manifest filename is never defined twice.
 */
const contract = createRequire(import.meta.url)("../electron/friday-contract.cjs") as {
  TREES: Record<CapabilityTree, { segments: string[]; names: string[] }>;
  resolveScanRoot: () => string;
};

export const TREES = contract.TREES;

const MANIFEST_NAMES: Record<CapabilityTree, string[]> = Object.fromEntries(
  (Object.keys(contract.TREES) as CapabilityTree[]).map((tree) => [
    tree,
    contract.TREES[tree].names,
  ]),
) as Record<CapabilityTree, string[]>;

const RISKS = new Set(["safe", "write", "exec"]);

/**
 * Root of the running FRIDAY installation, resolved by the one canonical
 * resolver (never assume a drive letter, never invent a home folder).
 */
export function resolveRoot(): string {
  // Read-only discovery scan root: the selected FRIDAY root when one exists,
  // otherwise the source checkout while developing. Never a write target.
  return contract.resolveScanRoot();
}

export function readJsonSafe<T = Record<string, unknown>>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function toEntry(
  tree: CapabilityTree,
  segment: string,
  id: string,
  target: string,
  manifestFile: string | null,
  manifest: Record<string, unknown> | null,
  source: CapabilityEntry["source"],
): CapabilityEntry {
  const m = manifest ?? {};
  const risk = String(m["risk"] ?? "safe");
  return {
    id,
    tree,
    segment,
    name: String(m["name"] ?? path.basename(target, path.extname(target))),
    version: m["version"] == null ? null : String(m["version"]),
    summary: String(m["summary"] ?? ""),
    description: String(m["description"] ?? ""),
    category: String(m["category"] ?? segment),
    path: target,
    manifestFile,
    entry: m["entry"] == null ? null : String(m["entry"]),
    permissions: Array.isArray(m["permissions"]) ? (m["permissions"] as string[]).map(String) : [],
    inputs: Array.isArray(m["inputs"]) ? (m["inputs"] as unknown[]).map(String) : [],
    approvalPrompt: m["approvalPrompt"] == null ? "" : String(m["approvalPrompt"]),
    role: m["role"] == null ? "" : String(m["role"]),
    skills: Array.isArray(m["skills"]) ? (m["skills"] as unknown[]).map(String) : [],
    workflows: Array.isArray(m["workflows"]) ? (m["workflows"] as unknown[]).map(String) : [],
    risk: (RISKS.has(risk) ? risk : "safe") as CapabilityEntry["risk"],
    enabled: m["enabled"] !== false,
    source,
    discoveredAt: Date.now(),
  };
}

/** Folder-per-capability scan: `<root>/<tree>/<segment>/<name>/manifest.json`.
 * Nested packs (for example tools/devices/bluetooth/bluetooth-list) are
 * discovered too — a grouping folder without a manifest is walked, not listed.
 */
export function scanSegment(
  root: string,
  tree: CapabilityTree,
  segment: string,
): CapabilityEntry[] {
  const dir = path.join(root, tree, segment);
  const out: CapabilityEntry[] = [];
  const skip = new Set(["node_modules", ".git", "__pycache__"]);

  const walk = (base: string, relParts: string[]) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      if (!dirent.isDirectory() || skip.has(dirent.name)) continue;
      const target = path.join(base, dirent.name);
      const rel = [...relParts, dirent.name];
      let manifestFile: string | null = null;
      let manifest: Record<string, unknown> | null = null;
      for (const candidate of MANIFEST_NAMES[tree]) {
        const file = path.join(target, candidate);
        const parsed = fs.existsSync(file) ? readJsonSafe(file) : null;
        if (parsed) {
          manifestFile = file;
          manifest = parsed;
          break;
        }
      }
      if (manifest) {
        out.push(
          toEntry(
            tree,
            segment,
            `${tree}/${segment}/${rel.join("/")}`,
            target,
            manifestFile,
            manifest,
            "manifest",
          ),
        );
        continue;
      }
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        children = [];
      }
      const subdirs = children.filter((child) => child.isDirectory() && !skip.has(child.name));
      if (subdirs.length) {
        walk(target, rel);
        continue;
      }
      // A leaf folder without a manifest is still reported as unconfigured.
      out.push(
        toEntry(tree, segment, `${tree}/${segment}/${rel.join("/")}`, target, null, null, "folder"),
      );
    }
  };

  walk(dir, []);
  return out;
}

/** Flat manifest scan: `<root>/<tree>/manifests/*.json`. */
export function scanManifestFolder(root: string, tree: CapabilityTree): CapabilityEntry[] {
  const dir = path.join(root, tree, "manifests");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CapabilityEntry[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    const full = path.join(dir, file);
    const manifest = readJsonSafe(full);
    if (!manifest) continue;
    const id = String(manifest["id"] ?? `${tree}/manifests/${path.basename(file, ".json")}`);
    out.push(toEntry(tree, "manifests", id, full, full, manifest, "manifest"));
  }
  return out;
}

type EnabledState = Record<string, boolean>;

/**
 * Process-wide capability registry. Sources register their scan function once
 * (keyed by module id) so a module can never register twice.
 */
export class CapabilityRegistry {
  private sources = new Map<string, () => CapabilityEntry[]>();
  private cache = new Map<string, CapabilityEntry[]>();
  private overrides: EnabledState | null = null;
  private root = resolveRoot();

  setRoot(root: string): void {
    if (root && root !== this.root) {
      this.root = root;
      this.overrides = null;
      this.cache.clear();
    }
  }

  getRoot(): string {
    return this.root;
  }

  register(sourceId: string, scan: () => CapabilityEntry[]): () => void {
    this.sources.set(sourceId, scan);
    this.refresh(sourceId);
    return () => {
      this.sources.delete(sourceId);
      this.cache.delete(sourceId);
    };
  }

  refresh(sourceId?: string): CapabilityEntry[] {
    const ids = sourceId ? [sourceId] : [...this.sources.keys()];
    for (const id of ids) {
      const scan = this.sources.get(id);
      if (!scan) continue;
      try {
        this.cache.set(id, scan());
      } catch {
        this.cache.set(id, []);
      }
    }
    const all = this.list();
    bus.emit("capabilities:changed", { sourceId: sourceId ?? "all", total: all.length });
    return all;
  }

  /**
   * ONE authoritative registry: the same precedence rule the Electron pass
   * (electron/capabilities.cjs) uses — sources are merged in registration
   * order and a later source with the same id replaces (shadows) the earlier
   * one, so an id can never be active twice.
   */
  list(tree?: CapabilityTree): CapabilityEntry[] {
    const overrides = this.readOverrides();
    const merged = new Map<string, CapabilityEntry>();
    for (const sourceId of this.sources.keys()) {
      for (const entry of this.cache.get(sourceId) ?? []) {
        if (tree && entry.tree !== tree) continue;
        const previous = merged.get(entry.id);
        const override = overrides[entry.id];
        merged.set(entry.id, {
          ...entry,
          ...(override === undefined ? {} : { enabled: override }),
          shadows: previous ? { path: previous.path, version: previous.version } : null,
        });
      }
    }
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): CapabilityEntry | null {
    return this.list().find((entry) => entry.id === id) ?? null;
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.list()) counts[entry.tree] = (counts[entry.tree] ?? 0) + 1;
    return counts;
  }

  /** Persisted toggle — survives restarts, mirrors what the UI shows. */
  setEnabled(id: string, enabled: boolean): boolean {
    const overrides = { ...this.readOverrides(), [id]: enabled };
    const file = path.join(this.root, "config", "capabilities.json");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
      this.overrides = overrides;
      bus.emit("capabilities:toggled", { id, enabled });
      return true;
    } catch {
      return false;
    }
  }

  private readOverrides(): EnabledState {
    if (this.overrides) return this.overrides;
    const file = path.join(this.root, "config", "capabilities.json");
    this.overrides = readJsonSafe<EnabledState>(file) ?? {};
    return this.overrides;
  }

  clear(): void {
    this.sources.clear();
    this.cache.clear();
    this.overrides = null;
  }
}

/** The single registry for the whole application. */
export const capabilities = new CapabilityRegistry();

export interface TreeSourceModule extends FridayModule {
  readonly tree: CapabilityTree;
  readonly segment: string;
  scan(): CapabilityEntry[];
}

/**
 * Builds the FridayModule that owns one `<tree>/<segment>` folder. This is the
 * single implementation behind every capability-tree module; the per-folder
 * files keep their own id and contract and delegate here.
 */
export function createTreeSource(tree: CapabilityTree, segment: string): TreeSourceModule {
  const id = `${tree}/${segment}`;
  let unregister: (() => void) | null = null;
  const scan = () =>
    segment === "manifests"
      ? scanManifestFolder(capabilities.getRoot(), tree)
      : scanSegment(capabilities.getRoot(), tree, segment);

  return {
    id,
    tree,
    segment,
    scan,
    init(ctx: ModuleContext) {
      capabilities.setRoot(ctx.root || capabilities.getRoot());
      unregister = capabilities.register(id, scan);
      ctx.log("info", `${id}: ${scan().length} discovered`);
    },
    dispose() {
      unregister?.();
      unregister = null;
    },
  };
}
