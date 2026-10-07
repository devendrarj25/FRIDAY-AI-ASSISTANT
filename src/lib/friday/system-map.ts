/**
 * FRIDAY · unified system map (one registry of her own application)
 *
 * Everything FRIDAY needs to answer "what exists, where is it, what is its
 * status, what does it depend on and when was it last verified" is folded into
 * ONE registry here. It does not probe anything itself: it reads the live
 * snapshots the existing engines already maintain (doctor, models, ops,
 * memory, governance, ledger, self-manager, environment registry) so there is
 * exactly one source of truth and no duplicated polling.
 *
 * `buildSystemMap()` is pure — it turns snapshots into entries, which makes it
 * testable without a browser. `systemMap` is the live store used by the UI and
 * by the Core Brain when it needs to reason about its own application.
 */

import { APP_BUILD, APP_VERSION } from "./version";
import { cachedEnvironment, type EnvRegistry } from "./environment";
import { doctor, type DoctorState } from "./doctor-engine";
import { models, type ModelsState } from "./models-engine";
import { ops, type OpsState } from "./ops-engine";
import { memory, type MemoryState } from "./self/memory-engine";
import { governance, type GovState } from "./self/governance";
import { ledger, type LedgerState } from "./self/task-ledger";
import { self, type SelfState } from "./self/self-manager";
import { capabilityMatrix, type CapabilityMatrixState } from "./self/capability-matrix";
import { experiences } from "./self/task-ledger";
import { privacy, type PrivacyState } from "./privacy";
import { readLocalState, writeState } from "./persist";

/**
 * "idle" means a real component that exists but was never configured or
 * started by the owner — a cloud provider without a key, a local engine that
 * is not installed. It is not a fault, so it never counts as a problem and it
 * stays out of the health denominator; it is still listed so nothing hides.
 */
export type MapStatus =
  "ready" | "running" | "degraded" | "idle" | "stopped" | "missing" | "unknown";

export type MapGroup =
  | "runtime"
  | "environment"
  | "models"
  | "memory"
  | "skills"
  | "tools"
  | "services"
  | "capability"
  | "development"
  | "governance";

export type MapEntry = {
  id: string;
  group: MapGroup;
  label: string;
  status: MapStatus;
  detail: string;
  version?: string | null;
  path?: string | null;
  dependsOn: string[];
  verifiedAt: number | null;
};

export type SystemMapSnapshot = {
  at: number;
  version: string;
  build: string;
  platform: string;
  desktop: boolean;
  entries: MapEntry[];
  /**
   * `total` counts only components the owner actually uses — configured or
   * expected ones. `idle` counts the never-configured ones alongside it, so
   * the tile can say "4/4 ready · 35 idle" instead of a false "4/39".
   */
  groups: { group: MapGroup; ready: number; total: number; idle: number; problems: number }[];
  health: { ok: boolean; errors: string[]; warnings: string[] };
};

export type SystemMapInput = {
  desktop: boolean;
  platform: string;
  version: string;
  build: string;
  env: EnvRegistry;
  doctor: DoctorState;
  models: ModelsState;
  ops: OpsState;
  memory: MemoryState;
  governance: GovState;
  ledger: LedgerState;
  self: SelfState;
  /** Live capability matrix. Optional so older callers keep working. */
  capabilities?: CapabilityMatrixState;
  /** Mirror of the data-egress firewall. Optional for older callers. */
  privacy?: PrivacyState;
  at?: number;
};

const GROUP_ORDER: MapGroup[] = [
  "runtime",
  "environment",
  "models",
  "memory",
  "skills",
  "tools",
  "services",
  "capability",

  "development",
  "governance",
];

const PROBLEM: MapStatus[] = ["missing", "stopped"];

const doctorStatus = (status: string): MapStatus => {
  switch (status) {
    case "Ready":
      return "ready";
    case "Running":
      return "running";
    case "Repairing":
      return "running";
    case "Missing":
      return "missing";
    case "Error":
      return "stopped";
    case "Outdated":
    case "Warning":
      return "degraded";
    default:
      return "unknown";
  }
};

const healthStatus = (health: string): MapStatus => {
  switch (health) {
    case "ready":
      return "ready";
    case "outdated":
      return "degraded";
    case "missing":
      return "missing";
    case "broken":
      return "stopped";
    default:
      return "unknown";
  }
};

/** Pure fold of every engine snapshot into one registry. */
export function buildSystemMap(input: SystemMapInput): SystemMapSnapshot {
  const at = input.at ?? Date.now();
  const entries: MapEntry[] = [];
  const push = (entry: MapEntry) => entries.push(entry);

  // ------------------------------------------------------------- runtime
  push({
    id: "runtime/app",
    group: "runtime",
    label: "FRIDAY application",
    status: input.desktop ? "running" : "degraded",
    detail: input.desktop
      ? "Installed desktop runtime with full system access"
      : "Browser preview — desktop-only bridges are unavailable",
    version: input.version,
    dependsOn: [],
    verifiedAt: at,
  });
  push({
    id: "runtime/build",
    group: "runtime",
    label: "Build",
    status: "ready",
    detail: `Build ${input.build} on ${input.platform}`,
    version: input.build,
    dependsOn: ["runtime/app"],
    verifiedAt: at,
  });

  // --------------------------------------------------------- environment
  for (const component of input.env.components ?? []) {
    push({
      id: `environment/${component.id}`,
      group: "environment",
      label: component.label,
      status: healthStatus(component.health),
      detail: component.detail ?? component.kind,
      version: component.version,
      path: component.path,
      dependsOn: ["runtime/app"],
      verifiedAt: component.checkedAt ?? null,
    });
  }

  // ------------------------------------------------------------ services
  for (const check of input.doctor.checks ?? []) {
    push({
      id: `services/${check.id}`,
      group: "services",
      label: check.label,
      status: doctorStatus(check.status),
      detail: check.detail,
      dependsOn: ["runtime/app"],
      verifiedAt: input.doctor.lastScanAt,
    });
  }

  // -------------------------------------------------------------- models
  const active = new Set(input.models.active ?? []);
  for (const [id, runtime] of Object.entries(input.models.runtimes ?? {})) {
    push({
      id: `models/${id}`,
      group: "models",
      label: id,
      status:
        runtime.state === "Running"
          ? "running"
          : runtime.state === "Loading" || runtime.state === "Unloading"
            ? "degraded"
            : runtime.state === "Error"
              ? "stopped"
              : "ready",
      detail: `${runtime.state}${active.has(id) ? " · active" : " · installed, idle"}`,
      version: input.models.installed?.[id] ?? null,
      dependsOn: ["runtime/app"],
      verifiedAt: input.models.lastScanAt,
    });
  }
  for (const id of active) {
    if (entries.some((e) => e.id === `models/${id}`)) continue;
    push({
      id: `models/${id}`,
      group: "models",
      label: id,
      status: "ready",
      detail: "Activated model",
      version: input.models.installed?.[id] ?? null,
      dependsOn: ["runtime/app"],
      verifiedAt: input.models.lastScanAt,
    });
  }
  for (const [provider, state] of Object.entries(input.models.providerState ?? {})) {
    push({
      id: `models/provider/${provider}`,
      group: "models",
      label: `${provider} provider`,
      // A provider the owner never set up is idle, not broken. Only a
      // provider FRIDAY really detected and then could not reach is degraded.
      status: state.online ? "ready" : state.detected ? "degraded" : "idle",
      detail:
        state.error ??
        `${state.detected ? "detected" : "not detected"} · ${state.models} model(s) · ${state.endpoint}`,
      dependsOn: ["runtime/app"],
      verifiedAt: state.checkedAt ?? null,
    });
  }

  // Local-vs-cloud reality check: counted from model calls that actually ran,
  // so "she leans on the cloud less as she learns" is a measured claim. With no
  // calls recorded there is nothing real to report, so no entry is invented.
  const routing = experiences.routingStats(7);
  if (routing.total > 0) {
    push({
      id: "models/routing-mix",
      group: "models",
      label: "Local vs cloud mix",
      status: routing.localShare! >= 0.8 ? "ready" : "degraded",
      detail: `${Math.round(routing.localShare! * 100)}% local · ${routing.local} local / ${routing.cloud} cloud call(s) in ${routing.days} days`,
      dependsOn: ["runtime/app"],
      verifiedAt: null,
    });
  }

  // -------------------------------------------------------------- memory
  const tiers = input.memory.counts ?? ({} as MemoryState["counts"]);
  for (const [tier, count] of Object.entries(tiers)) {
    push({
      id: `memory/${tier}`,
      group: "memory",
      label: `${tier} memory`,
      status: "ready",
      detail: `${count} record${count === 1 ? "" : "s"}`,
      dependsOn: ["runtime/app"],
      verifiedAt: input.memory.lastWriteAt || null,
    });
  }

  // ----------------------------------------------------- skills & tools
  for (const skill of input.ops.skills ?? []) {
    push({
      id: `skills/${skill.name}`,
      group: "skills",
      label: skill.name,
      status: skill.status === "Offline" || skill.status === "Inactive" ? "stopped" : "ready",
      detail: `${skill.category} · ${skill.level} · last used ${skill.lastUsed}`,
      dependsOn: ["runtime/app"],
      verifiedAt: null,
    });
  }
  for (const tool of input.ops.tools ?? []) {
    push({
      id: `tools/${tool.name}`,
      group: "tools",
      label: tool.name,
      status: tool.enabled ? "ready" : "stopped",
      detail: `${tool.summary} · ${tool.risk}`,
      dependsOn: ["runtime/app"],
      verifiedAt: null,
    });
  }

  // --------------------------------------------------------- development
  const index = input.self.index;
  push({
    id: "development/index",
    group: "development",
    label: "Source index",
    status: index ? (index.totals.broken > 0 ? "degraded" : "ready") : "unknown",
    detail: index
      ? `${index.totals.files} files · ${index.totals.edges} imports · ${index.totals.broken} broken`
      : "Not indexed yet — run a scan from Self-Management",
    dependsOn: ["runtime/app"],
    verifiedAt: index?.at ?? null,
  });
  const sourceHealth = input.self.sourceHealth;
  push({
    id: "development/source-health",
    group: "development",
    label: "Source health",
    status: !sourceHealth?.inspected
      ? "unknown"
      : sourceHealth.problemCount > 0
        ? "degraded"
        : "ready",
    detail: sourceHealth?.detail ?? "Not inspected yet — ask me to find bugs in my own source",
    dependsOn: ["development/index"],
    verifiedAt: sourceHealth?.at ?? null,
  });
  push({
    id: "development/impacts",
    group: "development",
    label: "Pending change impacts",
    status: (input.self.impacts?.length ?? 0) > 0 ? "degraded" : "ready",
    detail: `${input.self.impacts?.length ?? 0} change set(s) awaiting a verdict`,
    dependsOn: ["development/index"],
    verifiedAt: at,
  });
  const failedTasks = (input.ledger.tasks ?? []).filter(
    (t) => t.status === "failed" || t.status === "timeout",
  );
  push({
    id: "development/tasks",
    group: "development",
    label: "Task ledger",
    status: failedTasks.length ? "degraded" : "ready",
    detail: `${input.ledger.tasks?.length ?? 0} tracked · ${failedTasks.length} failed`,
    dependsOn: ["runtime/app"],
    verifiedAt: at,
  });

  // ---------------------------------------------------------- capability
  // Per-domain capability scores. A domain that has never run is "idle" and
  // reports its declared baseline — it is not a fault and it is not measured.
  for (const score of input.capabilities?.scores ?? []) {
    push({
      id: `capability/${score.domain}`,
      group: "capability",
      label: `${score.label} capability`,
      status: score.provisional ? "idle" : score.score >= 50 ? "ready" : "degraded",
      detail: score.provisional
        ? `${score.score}/100 declared baseline · no measured runs yet`
        : `${score.score}/100 · ${score.successes}/${score.runs} succeeded`,
      dependsOn: ["development/tasks"],
      verifiedAt: score.lastRunAt,
    });
  }

  // ---------------------------------------------------------- governance
  push({
    id: "governance/queue",
    group: "governance",
    label: "Approval queue",
    status: (input.governance.pending?.length ?? 0) > 0 ? "degraded" : "ready",
    detail: `${input.governance.pending?.length ?? 0} waiting · ${input.governance.items?.length ?? 0} recorded`,
    dependsOn: ["runtime/app"],
    verifiedAt: input.governance.lastChangeAt || null,
  });
  if (input.privacy) {
    push({
      id: "governance/data-egress",
      group: "governance",
      label: "Data leaving this PC",
      status: input.privacy.pending ? "degraded" : "ready",
      detail: input.privacy.pending
        ? `waiting for your confirmation — ${input.privacy.pending.classification} data to ${input.privacy.pending.destination ?? "an external service"}`
        : input.privacy.last
          ? `last: ${input.privacy.last.allowed ? "you allowed" : "you blocked"} ${input.privacy.last.classification} data to ${input.privacy.last.destination ?? "an external service"}`
          : "nothing has been sent off this PC yet · every send is confirmed",
      dependsOn: ["governance/queue"],
      verifiedAt: input.privacy.last?.at ?? null,
    });
  }
  push({
    id: "governance/approvals",
    group: "governance",
    label: "Live approvals",
    status: (input.ledger.approvals?.length ?? 0) > 0 ? "degraded" : "ready",
    detail: `${input.ledger.approvals?.length ?? 0} question(s) waiting for the owner`,
    dependsOn: ["governance/queue"],
    verifiedAt: at,
  });

  const groups = GROUP_ORDER.map((group) => {
    const list = entries.filter((e) => e.group === group);
    const idle = list.filter((e) => e.status === "idle").length;
    return {
      group,
      total: list.length - idle,
      idle,
      ready: list.filter((e) => e.status === "ready" || e.status === "running").length,
      problems: list.filter((e) => PROBLEM.includes(e.status)).length,
    };
  }).filter((g) => g.total > 0 || g.idle > 0);

  const errors = entries
    .filter((e) => PROBLEM.includes(e.status))
    .map((e) => `${e.label} — ${e.detail}`);
  const warnings = entries
    .filter((e) => e.status === "degraded")
    .map((e) => `${e.label} — ${e.detail}`);

  return {
    at,
    version: input.version,
    build: input.build,
    platform: input.platform,
    desktop: input.desktop,
    entries,
    groups,
    health: { ok: errors.length === 0, errors, warnings },
  };
}

const STORAGE_KEY = "friday.system-map.v1";

const EMPTY: SystemMapSnapshot = {
  at: 0,
  version: APP_VERSION,
  build: APP_BUILD,
  platform: "unknown",
  desktop: false,
  entries: [],
  groups: [],
  health: { ok: true, errors: [], warnings: [] },
};

class SystemMapStore {
  private snapshot: SystemMapSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private wired = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (fn: () => void) => {
    this.wire();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): SystemMapSnapshot => {
    this.wire();
    return this.snapshot;
  };

  /** Rebuild from the engines right now. Cheap: it only folds snapshots. */
  refresh(): SystemMapSnapshot {
    const env = cachedEnvironment();
    this.snapshot = buildSystemMap({
      desktop:
        typeof window !== "undefined" &&
        Boolean((window as { friday?: { isDesktop?: boolean } }).friday?.isDesktop),
      platform:
        env.platform ||
        (typeof navigator === "undefined" ? "node" : navigator.platform || "browser"),
      version: APP_VERSION,
      build: APP_BUILD,
      env,
      doctor: doctor.getSnapshot(),
      models: models.getSnapshot(),
      ops: ops.getSnapshot(),
      memory: memory.getSnapshot(),
      governance: governance.getSnapshot(),
      ledger: ledger.getSnapshot(),
      self: self.getSnapshot(),
      capabilities: capabilityMatrix.getSnapshot(),
      privacy: privacy.getSnapshot(),
    });
    writeState(STORAGE_KEY, { at: this.snapshot.at, health: this.snapshot.health });
    this.listeners.forEach((fn) => fn());
    return this.snapshot;
  }

  /** Entries matching a free-text query — used by the brain and the console. */
  find(query: string): MapEntry[] {
    const q = query.trim().toLowerCase();
    const entries = this.getSnapshot().entries;
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.id} ${e.label} ${e.detail} ${e.group}`.toLowerCase().includes(q),
    );
  }

  /** Short plain-language digest the Core Brain can put into a prompt. */
  digest(limit = 8): string {
    const map = this.getSnapshot();
    const lines = [
      `FRIDAY ${map.version} (build ${map.build}) · ${map.desktop ? "desktop" : "browser preview"}`,
      ...map.groups.map(
        (g) =>
          `${g.group}: ${g.ready}/${g.total} ready${g.problems ? `, ${g.problems} problem(s)` : ""}`,
      ),
      ...map.health.errors.slice(0, limit).map((e) => `problem · ${e}`),
    ];
    return lines.join("\n");
  }

  private wire() {
    if (this.wired) return;
    this.wired = true;
    const last = readLocalState<{ at: number }>(STORAGE_KEY);
    if (last?.at) this.snapshot = { ...this.snapshot, at: last.at };
    this.refresh();
    if (typeof window === "undefined") return;
    const bump = () => {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh();
      }, 400);
    };
    for (const store of [
      doctor,
      models,
      ops,
      memory,
      governance,
      ledger,
      self,
      capabilityMatrix,
      privacy,
    ]) {
      (store as { subscribe: (fn: () => void) => unknown }).subscribe(bump);
    }
  }
}

export const systemMap = new SystemMapStore();
