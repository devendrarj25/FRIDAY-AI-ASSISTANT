/**
 * FRIDAY · live wiring probe and switch gate
 *
 * The owner flow chart (`flow-chart.ts`) is the only map of boxes → modules.
 * This file does not invent a second architecture: it probes those nodes,
 * reports whatever the live `resolve()` binding actually returned, and
 * routes every switch through the existing governance gate.
 *
 * Permission, privacy, governance, billing, and tool-authority are locked
 * in code. No UI convention can make them switchable.
 */

import { FLOW_CHART, type FlowLayerId, type FlowNode } from "./flow-chart";
import { autonomy } from "./self/autonomy";
import { governance, type GovItem } from "./self/governance";

export { looksLikeLockedWiringSwitch, looksLikeWiringQuestion } from "./wiring-ask";

export type WiringHealth = "working" | "idle" | "error";

export type WiringNodeView = {
  id: string;
  layer: FlowLayerId;
  layerTitle: string;
  label: string;
  module: string;
  /** Static role text from the chart node. */
  detail: string;
  state: WiringHealth;
  /** Real status from the bound module, or the node detail when none is exposed. */
  status: string;
  locked: boolean;
  switchable: boolean;
  /** Present only when this node has an existing owner setting. */
  switchOn?: boolean;
};

export type WiringReport = {
  at: number;
  nodes: WiringNodeView[];
  errors: WiringNodeView[];
};

export type WiringSwitchSpec = {
  nodeId: string;
  title: string;
  store: string;
  read: () => boolean;
  apply: (on: boolean) => void | Promise<void>;
  rationale: (on: boolean) => string;
};

export type WiringSwitchRequest = {
  ok: boolean;
  submitted: boolean;
  detail: string;
  itemId?: string;
};

export type WiringPanelState = {
  open: boolean;
  lastResult: {
    nodeId: string;
    detail: string;
    stage: string;
    at: number;
  } | null;
};

/** Node ids that must never grow a switch, even if a mapping is added later. */
export const LOCKED_WIRING_NODE_IDS: readonly string[] = Object.freeze([
  "permission.broker",
  "permission.privacy",
  "permission.governance",
  "permission.billing",
  "permission.authority",
]);

/**
 * Modules that are never switchable from this panel, wherever they appear
 * on the chart (owner identity, improvement approval, supervisor approval).
 */
export const LOCKED_WIRING_MODULES: readonly string[] = Object.freeze([
  "core/permissions/index.ts",
  "src/lib/friday/privacy.ts",
  "src/lib/friday/self/governance.ts",
  "kernel/router.py",
  "electron/tool-authority.cjs",
  "electron/billing-firewall.cjs",
  "src/lib/friday/brain/action-risk.ts",
]);

const SWITCH_SPECS: Record<string, WiringSwitchSpec> = {
  "owner.autonomy": {
    nodeId: "owner.autonomy",
    title: "Background autonomy",
    store: "src/lib/friday/self/autonomy.ts",
    read: () => autonomy.getSnapshot().autonomyEnabled,
    apply: (on) => {
      autonomy.update({ autonomyEnabled: on });
    },
    rationale: (on) =>
      on
        ? "Turn the existing background-autonomy setting on. Permission, privacy, governance, billing, and tool-authority stay locked."
        : "Turn the existing background-autonomy setting off. Permission, privacy, governance, billing, and tool-authority stay locked.",
  },
};

let panel: WiringPanelState = { open: false, lastResult: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const wiringPanel = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: (): WiringPanelState => panel,
  open() {
    if (panel.open) return;
    panel = { ...panel, open: true };
    emit();
  },
  close() {
    if (!panel.open) return;
    panel = { ...panel, open: false };
    emit();
  },
  setLastResult(result: WiringPanelState["lastResult"]) {
    panel = { ...panel, lastResult: result };
    emit();
  },
  /** Test helper — does not persist. */
  reset() {
    panel = { open: false, lastResult: null };
    emit();
  },
};

function normModule(path: string): string {
  return String(path || "").replace(/\\/g, "/");
}

function findChartNode(id: string): { layer: (typeof FLOW_CHART)[number]; node: FlowNode } | null {
  for (const layer of FLOW_CHART) {
    const node = layer.nodes.find((item) => item.id === id);
    if (node) return { layer, node };
  }
  return null;
}

/** Fail-closed: unknown ids and every permission-layer / locked-module node. */
export function wiringNodeLocked(id: string): boolean {
  const found = findChartNode(id);
  if (!found) return true;
  if (LOCKED_WIRING_NODE_IDS.includes(id)) return true;
  if (found.layer.id === "permission") return true;
  const modulePath = normModule(found.node.module);
  return LOCKED_WIRING_MODULES.some(
    (locked) => modulePath === locked || modulePath.endsWith(`/${locked}`),
  );
}

export function wiringSwitchSpec(id: string): WiringSwitchSpec | null {
  if (wiringNodeLocked(id)) return null;
  return SWITCH_SPECS[id] ?? null;
}

export function wiringSwitchable(id: string): boolean {
  return wiringSwitchSpec(id) !== null;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Read real fields the bound module already exposes. Unknown shapes stay
 * idle with the chart's own detail — never a fabricated "healthy" line.
 */
function describeResolved(
  value: unknown,
  fallback: string,
): { state: WiringHealth; status: string } {
  if (value === undefined || value === null) {
    return { state: "error", status: "resolved to nothing" };
  }
  if (isThenable(value) || typeof value === "function") {
    return { state: "idle", status: fallback };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { state: "idle", status: `${fallback} Current: ${String(value)}.` };
  }
  if (Array.isArray(value)) {
    return { state: "idle", status: `${fallback} Current: ${value.length} item(s).` };
  }
  if (typeof value !== "object") {
    return { state: "idle", status: fallback };
  }

  const rec = value as Record<string, unknown>;
  const field = (key: string): unknown => rec[key];
  const err = field("error") ?? field("lastError");
  if (typeof err === "string" && err.trim()) {
    return { state: "error", status: err };
  }

  const checks = field("checks");
  if (Array.isArray(checks)) {
    const bad = checks.filter((check) => {
      if (!check || typeof check !== "object") return false;
      const status = String((check as Record<string, unknown>)["status"] ?? "");
      return status === "Error" || status === "Missing";
    }) as Array<Record<string, unknown>>;
    if (bad.length) {
      const first = bad[0] ?? {};
      const text = [first["label"], first["detail"], first["cause"]].filter(Boolean).join(" — ");
      return {
        state: "error",
        status: text || `${String(first["id"] ?? "check")} reported ${bad.length} problem(s)`,
      };
    }
  }

  if (field("connected") === false) {
    const detail = field("detail");
    return {
      state: "error",
      status: typeof detail === "string" && detail.trim() ? detail : "not connected",
    };
  }

  const status = field("status");
  const active =
    field("listening") === true ||
    field("scanning") === true ||
    field("running") === true ||
    field("busy") === true;
  if (typeof status === "string" && status.trim()) {
    const lower = status.toLowerCase();
    if (/\b(error|fail|unavailable|denied)\b/.test(lower)) {
      return { state: "error", status };
    }
    if (active) return { state: "working", status };
    return { state: "idle", status };
  }

  if (active) {
    const extra = field("detail");
    return { state: "working", status: typeof extra === "string" ? extra : fallback };
  }

  const pending = field("pending");
  if (Array.isArray(pending) && pending.length) {
    return { state: "working", status: `${pending.length} waiting approval` };
  }
  if (pending && typeof pending === "object") {
    return { state: "working", status: "confirmation pending" };
  }

  const mode = field("mode");
  if (typeof mode === "string" && mode.trim()) {
    return { state: "idle", status: `${fallback} Current mode: ${mode}.` };
  }
  const policy = field("policy");
  if (typeof policy === "string" && policy.trim()) {
    return { state: "idle", status: `${fallback} Current policy: ${policy}.` };
  }
  const autonomyEnabled = field("autonomyEnabled");
  if (typeof autonomyEnabled === "boolean") {
    return {
      state: "idle",
      status: `${fallback} Current: ${autonomyEnabled ? "on" : "off"}.`,
    };
  }
  const detail = field("detail");
  if (typeof detail === "string" && detail.trim()) {
    return { state: "idle", status: detail };
  }

  return { state: "idle", status: fallback };
}

function probeNode(layer: (typeof FLOW_CHART)[number], node: FlowNode): WiringNodeView {
  const locked = wiringNodeLocked(node.id);
  const spec = locked ? null : (SWITCH_SPECS[node.id] ?? null);
  let state: WiringHealth;
  let status: string;
  try {
    const value = node.resolve();
    const described = describeResolved(value, node.detail);
    state = described.state;
    status = described.status;
  } catch (error) {
    state = "error";
    status = error instanceof Error ? error.message : String(error);
  }
  const view: WiringNodeView = {
    id: node.id,
    layer: layer.id,
    layerTitle: layer.title,
    label: node.label,
    module: node.module,
    detail: node.detail,
    state,
    status,
    locked,
    switchable: spec !== null,
  };
  if (spec) view.switchOn = spec.read();
  return view;
}

/** Probe every FLOW_CHART node against its live binding. Never invents status. */
export function probeWiring(): WiringReport {
  const nodes: WiringNodeView[] = [];
  for (const layer of FLOW_CHART) {
    for (const node of layer.nodes) nodes.push(probeNode(layer, node));
  }
  return {
    at: Date.now(),
    nodes,
    errors: nodes.filter((node) => node.state === "error"),
  };
}

export function probeWiringNode(id: string): WiringNodeView | null {
  const found = findChartNode(id);
  if (!found) return null;
  return probeNode(found.layer, found.node);
}

/** Open the panel and return the live probe as speakable/on-screen text. */
export function describeWiringLive(): string {
  wiringPanel.open();
  const report = probeWiring();
  const errors = report.errors;
  const working = report.nodes.filter((node) => node.state === "working");
  const lines = [
    `Live wiring from FLOW_CHART — ${report.nodes.length} nodes probed.`,
    `${working.length} working, ${report.nodes.length - working.length - errors.length} idle, ${errors.length} error.`,
    "Permission, privacy, governance, billing, and tool-authority are locked and have no switch.",
  ];
  if (errors.length) {
    lines.push("Problems (exact node, real module text):");
    for (const node of errors) {
      lines.push(`• ${node.id} (${node.label}, ${node.module}): ${node.status}`);
    }
  } else {
    lines.push("No node reported an error on this probe.");
  }
  return lines.join("\n");
}

function rememberItem(nodeId: string, item: GovItem) {
  const verified = [...item.logs].reverse().find((log) => log.line.startsWith("verified"));
  const detail = item.error || verified?.line || item.logs.at(-1)?.line || item.stage;
  wiringPanel.setLastResult({
    nodeId,
    detail,
    stage: item.stage,
    at: Date.now(),
  });
}

/**
 * File a wiring switch through the existing governance gate (`kind: "system"`
 * always asks). Apply uses the real settings store; verify re-probes the node
 * and reads the store again — success is never assumed from the click.
 */
export function requestWiringSwitch(nodeId: string, enable: boolean): WiringSwitchRequest {
  if (wiringNodeLocked(nodeId)) {
    const detail = `${nodeId} is locked. Permission, privacy, governance, billing, and tool-authority cannot be switched.`;
    wiringPanel.setLastResult({ nodeId, detail, stage: "rejected", at: Date.now() });
    return { ok: false, submitted: false, detail };
  }
  const spec = wiringSwitchSpec(nodeId);
  if (!spec) {
    const detail = `${nodeId} has no existing owner setting bound to it — status only.`;
    wiringPanel.setLastResult({ nodeId, detail, stage: "rejected", at: Date.now() });
    return { ok: false, submitted: false, detail };
  }

  void governance
    .submit({
      kind: "system",
      title: `Wiring: ${spec.title} ${enable ? "on" : "off"}`,
      rationale: spec.rationale(enable),
      risk: "review",
      evidence: [nodeId, spec.store],
      dryRun: async () => {
        const now = spec.read();
        if (now === enable) {
          return { ok: false, detail: `Already ${enable ? "on" : "off"} — nothing to change.` };
        }
        return {
          ok: true,
          detail: `Would set ${spec.title} from ${now ? "on" : "off"} to ${enable ? "on" : "off"} via ${spec.store}.`,
        };
      },
      apply: async () => {
        await spec.apply(enable);
        return {
          ok: true,
          detail: `Applied ${spec.title} ${enable ? "on" : "off"} through ${spec.store}.`,
        };
      },
      verify: async () => {
        const now = spec.read();
        const probe = probeWiringNode(nodeId);
        if (now !== enable) {
          return {
            ok: false,
            detail: `${spec.title} is still ${now ? "on" : "off"} after apply.${probe ? ` Re-probe: ${probe.state} — ${probe.status}` : ""}`,
          };
        }
        if (probe?.state === "error") {
          return { ok: false, detail: `${nodeId} re-probe error: ${probe.status}` };
        }
        return {
          ok: true,
          detail: `${spec.title} is now ${enable ? "on" : "off"}. ${nodeId} re-probe: ${probe?.state ?? "n/a"} — ${probe?.status ?? spec.store}`,
        };
      },
    })
    .then((item) => rememberItem(nodeId, item));

  return {
    ok: true,
    submitted: true,
    detail: `Proposed ${spec.title} ${enable ? "on" : "off"} — waiting for owner approval.`,
  };
}
