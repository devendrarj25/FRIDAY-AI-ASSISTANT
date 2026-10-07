/**
 * FRIDAY · unified capability registry
 *
 * One snapshot answering "what can FRIDAY actually do right now?".
 *
 * This file does not discover anything new and it invents nothing: it reads
 * the registries that already exist (model registry, capability groups, the
 * live system map) and folds them into a single typed list with availability,
 * health, measured performance, cost class and the permission each resource
 * needs. The Core Brain routes against this, and the self-management panels
 * can read the same snapshot instead of stitching stores together themselves.
 *
 * Unavailable resources stay in the list marked unavailable — knowing a tool
 * exists but is offline is more useful than pretending it is absent.
 */

import { modelRegistry, type ModelCapabilityRecord } from "./model-registry";
import { readLocalState, restoreFromDisk, writeState } from "../persist";

const STORAGE_KEY = "friday.capability-registry.v1";

export type ResourceType =
  "model" | "tool" | "skill" | "agent" | "module" | "plugin" | "workflow" | "browser" | "system";

/**
 * Whether tapping this resource should run FRIDAY's planner (`task.run`).
 * Models are selected, not executed. Every other registry type is an action
 * (tools, skills, agents, modules, plugins, workflows, browser, system), so a
 * newly added `ResourceType` is runnable unless it is explicitly `model`.
 * The phone reads the published `runnable` flag — it must not keep a second
 * type allowlist.
 */
export function capabilityRunnable(type: ResourceType): boolean {
  return type !== "model";
}

export type ResourceHealth = "ready" | "degraded" | "offline" | "unknown";

/** What consent a resource needs before FRIDAY may use it. */
export type ResourcePermission = "open" | "ask" | "owner-only";

/** Rough cost class — local work is free, cloud work is not. */
export type ResourceCost = "free" | "local-compute" | "metered";

/**
 * Phone Use vs chat-about. Defaults to `capabilityRunnable(type)`.
 * A live status surface (system wiring) sets this false so the phone
 * asks for current state instead of firing `task.run`.
 */
export function resourceRunnable(resource: { type: ResourceType; runnable?: boolean }): boolean {
  return typeof resource.runnable === "boolean"
    ? resource.runnable
    : capabilityRunnable(resource.type);
}

export type CapabilityResource = {
  /** Stable id: `${type}:${ref}`. */
  id: string;
  type: ResourceType;
  name: string;
  /** Real underlying reference (model id, tool name, skill id …). */
  ref: string;
  /** What this resource can be used for, lower-case keywords. */
  capabilities: string[];
  /** Agent skill ids from the pack manifest, when known. */
  skills?: string[];
  /** Agent workflow ids from the pack manifest, when known. */
  workflows?: string[];
  /** Agent persona role from the pack manifest, when known. */
  role?: string;
  available: boolean;
  health: ResourceHealth;
  /** 0..1 measured success rate, or null when never measured. */
  reliability: number | null;
  /** Measured average latency in ms, or null. */
  latencyMs: number | null;
  cost: ResourceCost;
  permission: ResourcePermission;
  detail: string;
  /**
   * When set, overrides `capabilityRunnable(type)` for the phone Use vs
   * chat-about flag. Inspect-only surfaces set this false.
   */
  runnable?: boolean;
};

export type CapabilitySnapshot = {
  resources: CapabilityResource[];
  counts: Record<ResourceType, number>;
  availableCount: number;
  refreshedAt: number;
};

type PersistedSnapshot = {
  resources: CapabilityResource[];
  refreshedAt: number;
};

const EMPTY_COUNTS = (): Record<ResourceType, number> => ({
  model: 0,
  tool: 0,
  skill: 0,
  agent: 0,
  module: 0,
  plugin: 0,
  workflow: 0,
  browser: 0,
  system: 0,
});

/**
 * FRIDAY's own built-in capability path — these exist in her runtime whether
 * or not a model is installed, which is what lets her act when a model cannot.
 */
const BUILTIN: Omit<CapabilityResource, "id" | "available" | "health">[] = [
  {
    type: "browser",
    name: "Web search",
    ref: "web-search",
    capabilities: ["search", "research", "news", "current-facts"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "live search through the shared FRIDAY Browser session (owner engine + DuckDuckGo/Bing/Brave/Wikipedia fallback)",
  },
  {
    type: "browser",
    name: "Page interact",
    ref: "web-interact",
    capabilities: ["click", "scroll", "fill", "navigate", "read"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    detail:
      "click, scroll and fill in the shared Chromium session; submitting, logging in or purchasing still goes through owner approval",
  },
  {
    type: "browser",
    name: "Page open & extract",
    ref: "web-open",
    capabilities: ["navigate", "read", "extract", "verify-source"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail: "open a page in the shared Chromium session and read its content",
  },
  {
    type: "tool",
    name: "Skill forge (gap draft)",
    ref: "skill-forge",
    capabilities: ["skill", "forge", "learn", "draft"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "ask",
    detail:
      "when no skill covers a request, file a forge draft; sandbox verify and install wait for owner approval",
  },
  {
    type: "tool",
    name: "Module forge (gap draft)",
    ref: "module-forge",
    capabilities: ["module", "forge", "learn", "draft"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "ask",
    detail:
      "when a request needs a full module, file a module-forge draft; sandbox verify and install wait for owner approval",
  },
  {
    type: "tool",
    name: "Plugin forge (gap draft)",
    ref: "plugin-forge",
    capabilities: ["plugin", "forge", "learn", "draft", "hooks"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "ask",
    detail:
      "when a request needs a lifecycle plugin, file a plugin-forge draft; sandbox verify and install wait for owner approval",
  },
  {
    type: "tool",
    name: "Catalog tools",
    ref: "tool-catalog",
    capabilities: ["tools", "catalog", "packs"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "enabled+safe tool.json packs from the Tools page, routed by the keyword tool-router; write/exec still asks",
  },
  {
    type: "module",
    name: "Catalog modules",
    ref: "module-catalog",
    capabilities: ["modules", "catalog", "packs"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "enabled+safe module packs from the Modules page, routed by the keyword module-router; write/exec still asks",
  },
  {
    type: "plugin",
    name: "Catalog plugins",
    ref: "plugin-catalog",
    capabilities: ["plugins", "catalog", "packs", "hooks"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "enabled plugin packs from the Plugins page; declared hooks fire at real lifecycle moments through the one plugin host",
  },
  {
    type: "tool",
    name: "Workflow forge (gap draft)",
    ref: "workflow-forge",
    capabilities: ["workflow", "forge", "learn", "draft", "steps"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "ask",
    detail:
      "when a request needs a multi-step workflow, file a workflow-forge draft; sandbox verify and install wait for owner approval",
  },
  {
    type: "workflow",
    name: "Catalog workflows",
    ref: "workflow-catalog",
    capabilities: ["workflows", "catalog", "packs", "steps"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "enabled+safe workflow.json packs from the Workflows page, routed by the keyword workflow-router (one, sequential, or parallel); write/exec stays dry-run unless approved",
  },
  {
    type: "tool",
    name: "Real-data stage chart",
    ref: "stage-chart",
    capabilities: ["chart", "diagram", "visualise", "visualize"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail:
      "show a chart or table on the existing stage from real numbers only — never invented values",
  },
  {
    type: "tool",
    name: "File system",
    ref: "filesystem",
    capabilities: ["read", "write", "import", "workspace"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    detail: "read and write inside the FRIDAY workspace",
  },
  {
    type: "tool",
    name: "Shell command",
    ref: "shell",
    capabilities: ["execute", "install", "build", "system", "terminal", "cmd", "powershell"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "owner-only",
    detail:
      "run a real command in the FRIDAY workspace terminal (cmd, PowerShell, pwsh, WSL, Git Bash, Node, Python venv) — confined to the FRIDAY root. Auto Mode runs checks and tests itself; installs, deletes, and other exec-tier lines still wait for the owner",
  },
  {
    type: "tool",
    name: "Sandbox lab",
    ref: "sandbox",
    capabilities: ["experiment", "test", "debug", "build", "verify"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "open",
    detail:
      "isolated project runtime the owner and FRIDAY share; Auto Mode runs checks/tests herself; installs, docker build, and apply-to-source still wait. Apply stays owner-gated on the Sandbox page",
  },
  {
    type: "system",
    name: "Logs stream",
    ref: "logs",
    capabilities: ["diagnose", "debug", "logs", "telemetry", "ipc"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail:
      "live kernel / main / plugin ring synced to logs/main.log; Ask FRIDAY sees the same buffer; apply/clear of disk files stays owner-gated",
  },
  {
    type: "system",
    name: "Task graph",
    ref: "task-graph",
    capabilities: ["plan", "queue", "background", "approve", "tasks"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail:
      "live durable task graph + ledger on the Tasks page; interrupt/resume/pause/cancel/retry; Ask FRIDAY sees the same queue; idle self-work pauses when the owner talks",
  },
  {
    type: "system",
    name: "Setup & Doctor",
    ref: "doctor",
    capabilities: ["diagnose", "repair", "setup", "health", "doctor"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail:
      "live diagnostics on Setup & Doctor; quick/deep/auto scan, safe repair, rollback, Ask FRIDAY sees the same checks; owner-only steps stay numbered",
  },
  {
    type: "system",
    name: "Install Manager",
    ref: "install-manager",
    capabilities: ["install", "update", "toolchain", "catalog", "repair"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail:
      "live toolchain catalog on the Install Manager page; scan/install/update/repair from official sources; Ask FRIDAY sees the same queue, paths and log",
  },
  {
    type: "system",
    name: "Source health",
    ref: "source-health",
    capabilities: ["diagnose", "debug", "source", "lint", "typecheck", "self-inspection"],
    reliability: null,
    latencyMs: null,
    cost: "local-compute",
    permission: "open",
    detail:
      "read-only inspection of FRIDAY's own source via the architecture index, sandbox verify, and tracked AUDIT.md issues; code fixes stay approval-gated",
  },
  {
    type: "system",
    name: "System wiring",
    ref: "system-wiring",
    capabilities: ["status", "diagnose", "wiring", "flow", "self-inspection"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail:
      "live diagram of every FLOW_CHART node against its real module; switches go through owner approval; permission, privacy, governance, billing, and tool-authority cannot be switched",
  },
  {
    type: "tool",
    name: "Read a flow",
    ref: "flow.read",
    capabilities: ["flow", "read", "explain"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail: "reads the open Flow Studio graph",
  },
  {
    type: "tool",
    name: "Search a flow",
    ref: "flow.search",
    capabilities: ["flow", "search"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail: "finds a box on the open flow",
  },
  {
    type: "tool",
    name: "Patch a flow",
    ref: "flow.patch",
    capabilities: ["flow", "rewire"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    runnable: false,
    detail: "rewires two boxes through the existing binding host",
  },
  {
    type: "tool",
    name: "Create a flow",
    ref: "flow.create",
    capabilities: ["flow", "create"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    runnable: false,
    detail: "draws a disabled flow on the canvas",
  },
  {
    type: "tool",
    name: "Run a flow",
    ref: "flow.run",
    capabilities: ["flow", "run"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    runnable: false,
    detail: "dry-runs the open flow and executes nothing",
  },
  {
    type: "tool",
    name: "Explain a flow",
    ref: "flow.explain",
    capabilities: ["flow", "explain"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail: "explains the last recorded run",
  },
  {
    type: "tool",
    name: "Diff a flow",
    ref: "flow.diff",
    capabilities: ["flow", "diff"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    runnable: false,
    detail: "lists the wire journal",
  },
  {
    type: "tool",
    name: "Roll back a flow",
    ref: "flow.rollback",
    capabilities: ["flow", "rollback"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    runnable: false,
    detail: "restores the last applied wire",
  },
  {
    type: "system",
    name: "System information",
    ref: "system-info",
    capabilities: ["status", "hardware", "processes", "network", "time"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail: "real OS and app state from the desktop bridge",
  },
  {
    type: "system",
    name: "App & window control",
    ref: "app-control",
    capabilities: ["open", "close", "focus", "launch"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    detail: "launch or control applications on the machine",
  },
  {
    type: "tool",
    name: "Memory operations",
    ref: "memory",
    capabilities: ["recall", "remember", "forget", "preferences"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail: "six-tier persistent memory plus the knowledge base",
  },
  {
    type: "tool",
    name: "Scheduling",
    ref: "scheduler",
    capabilities: ["schedule", "remind", "recurring", "background"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "open",
    detail: "background jobs owned by the autonomous core",
  },
  {
    type: "tool",
    name: "Model management",
    ref: "model-manager",
    capabilities: ["install", "search", "activate", "route"],
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: "ask",
    detail: "install, activate and route local and cloud models",
  },
];

/** Roles a model record advertises, as plain capability keywords. */
function modelCapabilities(record: ModelCapabilityRecord): string[] {
  const roles = Array.isArray((record as { roles?: unknown }).roles)
    ? ((record as { roles?: string[] }).roles as string[])
    : [];
  const out = new Set<string>(["generate", "reason"]);
  for (const role of roles) out.add(String(role));
  return [...out];
}

function healthOf(
  available: boolean,
  reliability: number | null,
  coolingDown?: boolean,
): ResourceHealth {
  if (coolingDown) return "degraded";
  if (!available) return "offline";
  if (reliability === null) return "unknown";
  return reliability >= 0.6 ? "ready" : "degraded";
}

class CapabilityRegistry {
  private snapshot: CapabilitySnapshot = {
    resources: [],
    counts: EMPTY_COUNTS(),
    availableCount: 0,
    refreshedAt: 0,
  };
  private loaded = false;
  private listeners = new Set<() => void>();
  /** Subsystems that own extra resources (Friday Hub, future registries). */
  private providers = new Set<() => CapabilityResource[]>();

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): CapabilitySnapshot => {
    this.load();
    if (!this.snapshot.refreshedAt) this.refresh();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<PersistedSnapshot>(STORAGE_KEY);
    if (local?.resources) this.apply(local.resources, local.refreshedAt ?? 0);
    restoreFromDisk<PersistedSnapshot>(STORAGE_KEY, (disk) => {
      if (!disk?.resources) return;
      this.apply(disk.resources, disk.refreshedAt ?? 0);
      this.listeners.forEach((fn) => fn());
    });
  }

  private apply(resources: CapabilityResource[], refreshedAt: number) {
    const counts = EMPTY_COUNTS();
    let availableCount = 0;
    for (const resource of resources) {
      counts[resource.type] = (counts[resource.type] ?? 0) + 1;
      if (resource.available) availableCount += 1;
    }
    this.snapshot = { resources, counts, availableCount, refreshedAt };
  }

  /** Rebuild the snapshot from the registries that are live right now. */
  refresh(): CapabilitySnapshot {
    this.load();
    const seen = new Set<string>();
    const resources: CapabilityResource[] = [];
    const push = (resource: CapabilityResource) => {
      if (seen.has(resource.id)) return;
      seen.add(resource.id);
      resources.push(resource);
    };

    // Models — real records, with the reliability and speed already measured.
    let records: ModelCapabilityRecord[];
    try {
      records = modelRegistry.list();
    } catch {
      records = [];
    }
    const availableIds = new Set<string>();
    try {
      for (const record of modelRegistry.available()) availableIds.add(record.id);
    } catch {
      /* registry not hydrated yet — every model stays marked unavailable */
    }
    for (const record of records) {
      const available = availableIds.has(record.id);
      const reliability = typeof record.reliability === "number" ? record.reliability : null;
      const latencyMs = record.performance?.avgMs ?? null;
      const cooling = Boolean(record.coolingDown);
      push({
        id: `model:${record.id}`,
        type: "model",
        name: record.name,
        ref: record.id,
        capabilities: modelCapabilities(record),
        available,
        health: healthOf(available, reliability, cooling),
        reliability,
        latencyMs: typeof latencyMs === "number" ? latencyMs : null,
        cost: record.kind === "cloud" ? "metered" : "local-compute",
        permission: record.kind === "cloud" ? "ask" : "open",
        detail: cooling
          ? `${record.kind} model · cooling down${record.healthCategory ? ` (${record.healthCategory})` : ""}`
          : `${record.kind} model${record.performance?.runs ? ` · ${record.performance.runs} run(s)` : ""}`,
      });
    }

    // FRIDAY's own capability path — always present, availability from the bridge.
    const bridge = typeof window === "undefined" ? undefined : window.friday;
    for (const builtin of BUILTIN) {
      const needsDesktop = builtin.type !== "browser";
      const available = needsDesktop ? Boolean(bridge) : true;
      push({
        ...builtin,
        id: `${builtin.type}:${builtin.ref}`,
        available,
        health: available ? "ready" : "offline",
      });
    }

    // Resources contributed by other subsystems (Friday Hub installs).
    for (const provider of this.providers) {
      try {
        for (const resource of provider()) push(resource);
      } catch {
        /* a provider must never break the snapshot */
      }
    }

    this.apply(resources, Date.now());

    writeState(STORAGE_KEY, {
      resources: this.snapshot.resources,
      refreshedAt: this.snapshot.refreshedAt,
    } satisfies PersistedSnapshot);
    this.listeners.forEach((fn) => fn());
    return this.snapshot;
  }

  /** Everything usable right now, optionally narrowed to one type. */
  available(type?: ResourceType): CapabilityResource[] {
    const snapshot = this.getSnapshot();
    return snapshot.resources.filter(
      (resource) => resource.available && (!type || resource.type === type),
    );
  }

  /**
   * Best-first resources for a need. Ranks by measured reliability, then by
   * cheaper cost, then by lower latency — so a healthy local resource beats a
   * metered one when both can do the job.
   */
  best(need: string, options: { type?: ResourceType; limit?: number } = {}): CapabilityResource[] {
    const term = need.trim().toLowerCase();
    const pool = this.available(options.type).filter(
      (resource) =>
        !term ||
        resource.capabilities.some((cap) => cap.includes(term) || term.includes(cap)) ||
        resource.name.toLowerCase().includes(term),
    );
    const costRank: Record<ResourceCost, number> = { free: 0, "local-compute": 1, metered: 2 };
    const ranked = [...pool].sort((a, b) => {
      const rel = (b.reliability ?? 0.5) - (a.reliability ?? 0.5);
      if (Math.abs(rel) > 0.01) return rel;
      const cost = costRank[a.cost] - costRank[b.cost];
      if (cost !== 0) return cost;
      return (a.latencyMs ?? 0) - (b.latencyMs ?? 0);
    });
    return options.limit ? ranked.slice(0, options.limit) : ranked;
  }

  /**
   * Extension point: other subsystems (the Friday Hub) contribute the
   * resources they own, so anything the owner installs and activates becomes
   * routable by the Core Brain without this file knowing about it.
   */
  registerProvider(fn: () => CapabilityResource[]): () => void {
    this.providers.add(fn);
    this.refresh();
    return () => {
      this.providers.delete(fn);
    };
  }

  /** Compact line for prompts and logs. */
  digest(limit = 10): string {
    const snapshot = this.getSnapshot();
    if (!snapshot.resources.length) return "";
    const lines = snapshot.resources
      .filter((resource) => resource.available)
      .slice(0, limit)
      .map((resource) => `- ${resource.type}: ${resource.name} (${resource.health})`);
    return [`Available capabilities (${snapshot.availableCount}):`, ...lines].join("\n");
  }

  /**
   * What she can/can't do right now — same registry, not a second matrix.
   * Distinguishes enabled, unavailable, approval-gated, failing, unverified.
   */
  selfKnowledge(): {
    enabled: number;
    unavailable: number;
    degraded: number;
    needsApproval: number;
    unverified: number;
    digest: string;
  } {
    const snapshot = this.getSnapshot();
    const unavailable = snapshot.resources.filter((row) => !row.available).length;
    const degraded = snapshot.resources.filter(
      (row) => row.health === "degraded" || row.health === "offline",
    ).length;
    const needsApproval = snapshot.resources.filter((row) => row.permission === "ask").length;
    const unverified = snapshot.resources.filter((row) => row.reliability === null).length;
    const digest = [
      `enabled ${snapshot.availableCount}`,
      `unavailable ${unavailable}`,
      `degraded/offline ${degraded}`,
      `needs approval ${needsApproval}`,
      `unverified ${unverified}`,
    ].join(" · ");
    return {
      enabled: snapshot.availableCount,
      unavailable,
      degraded,
      needsApproval,
      unverified,
      digest,
    };
  }
}

export const capabilityRegistry = new CapabilityRegistry();
