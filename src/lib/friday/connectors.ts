/**
 * FRIDAY · renderer view of her external service connectors.
 *
 * The registry, the credentials and the verification all live in the main
 * process (electron/connectors.cjs) — this file only reflects that state and
 * routes calls. Two rules are enforced here rather than in the UI:
 *
 *   • a connector is "connected" only because a real authenticated call to the
 *     provider succeeded; nothing here ever infers it from a saved token,
 *   • any action that is not read-only goes through the SAME governance gate
 *     the rest of FRIDAY uses, so chat, voice and auto mode all pause and ask
 *     before she writes into an external service.
 */
import { useCallback, useEffect, useState } from "react";
import { deferEffect } from "./defer-effect";
import { desktopApi, isDesktopApp, safeCall } from "./desktop";
import { governance } from "./self/governance";
import { capabilityRegistry } from "./brain/capability-registry";

export type ConnectorRisk = "safe" | "write" | "exec";
export type ConnectorAuthType = "oauth" | "apiKey" | "phone" | "mcp";

export interface ConnectorField {
  id: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  /** Non-secret fields round-trip their stored value; secrets never do. */
  value: string;
}

export interface ConnectorAction {
  id: string;
  label: string;
  risk: ConnectorRisk;
  inputs: string[];
}

export interface Connector {
  id: string;
  name: string;
  category: string;
  description: string;
  help: string;
  authType?: ConnectorAuthType;
  fields: ConnectorField[];
  actions: ConnectorAction[];
  configured: boolean;
  connected: boolean;
  account: string;
  lastVerifiedAt: number;
  lastError: string;
}

export interface ConnectorCall {
  ok: boolean;
  error?: string;
  label?: string;
  lines?: string[];
  data?: unknown;
  ms?: number;
}

type Api = {
  listConnectors?: () => Promise<{ ok: boolean; connectors: Connector[] }>;
  connectConnector?: (
    id: string,
    values: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string; account?: string }>;
  disconnectConnector?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  verifyConnector?: (id: string) => Promise<{ ok: boolean; error?: string; account?: string }>;
  callConnector?: (
    id: string,
    action: string,
    params: Record<string, unknown>,
  ) => Promise<ConnectorCall>;
  startOAuthConnector?: (
    id: string,
    values: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string; account?: string }>;
  sendConnectorPhoneCode?: (
    id: string,
    values: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string; pending?: boolean }>;
  confirmConnectorPhoneCode?: (
    id: string,
    values: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string; account?: string }>;
  onConnectorsChanged?: (cb: (info: unknown) => void) => () => void;
};

const api = () => desktopApi() as unknown as Api | null;

export const connectorsSupported = () => isDesktopApp() && Boolean(api()?.listConnectors);

/**
 * Last known connector list. The capability registry reads this so the Core
 * Brain can reason about external services from the same one snapshot the
 * rest of FRIDAY uses, instead of a second hardcoded list.
 */
let cache: Connector[] = [];

export const knownConnectors = (): Connector[] => cache;

// Connectors show up in the shared capability snapshot as tools, marked
// unavailable until a real authenticated call has verified them.
capabilityRegistry.registerProvider(() =>
  cache.map((connector) => ({
    id: `tool:connector.${connector.id}`,
    type: "tool" as const,
    name: `${connector.name} connector`,
    ref: `connector:${connector.id}`,
    capabilities: [connector.category, ...connector.actions.map((a) => a.id)],
    available: connector.connected,
    health: connector.connected ? ("ready" as const) : ("offline" as const),
    reliability: null,
    latencyMs: null,
    cost: "free" as const,
    permission: "ask" as const,
    detail: connector.connected
      ? `Connected${connector.account ? ` as ${connector.account}` : ""}.`
      : connector.lastError || "Not connected yet.",
  })),
);

export async function listConnectors(): Promise<Connector[]> {
  const result = await safeCall<{ connectors: Connector[] } | null>(
    "connectors:list",
    () => api()?.listConnectors?.() ?? null,
    { fallback: null },
  );
  cache = result?.connectors ?? [];
  try {
    capabilityRegistry.refresh();
  } catch {
    /* registry refresh must never block the connector list */
  }
  return cache;
}

export async function connectConnector(id: string, values: Record<string, string>) {
  const result = await safeCall<{ ok: boolean; error?: string; account?: string } | null>(
    `connectors:connect:${id}`,
    () => api()?.connectConnector?.(id, values) ?? null,
    { fallback: null },
  );
  await listConnectors();
  return result;
}

export async function disconnectConnector(id: string) {
  const result = await safeCall<{ ok: boolean; error?: string } | null>(
    `connectors:disconnect:${id}`,
    () => api()?.disconnectConnector?.(id) ?? null,
    { fallback: null },
  );
  await listConnectors();
  return result;
}

export async function verifyConnector(id: string) {
  const result = await safeCall<{ ok: boolean; error?: string; account?: string } | null>(
    `connectors:verify:${id}`,
    () => api()?.verifyConnector?.(id) ?? null,
    { fallback: null },
  );
  await listConnectors();
  return result;
}

export async function startOAuthConnector(id: string, values: Record<string, string>) {
  const result = await safeCall<{ ok: boolean; error?: string; account?: string } | null>(
    `connectors:oauth-start:${id}`,
    () => api()?.startOAuthConnector?.(id, values) ?? null,
    { fallback: null, timeoutMs: 190_000 },
  );
  await listConnectors();
  return result;
}

export async function sendConnectorPhoneCode(id: string, values: Record<string, string>) {
  const result = await safeCall<{ ok: boolean; error?: string; pending?: boolean } | null>(
    `connectors:phone-send:${id}`,
    () => api()?.sendConnectorPhoneCode?.(id, values) ?? null,
    { fallback: null },
  );
  await listConnectors();
  return result;
}

export async function confirmConnectorPhoneCode(id: string, values: Record<string, string>) {
  const result = await safeCall<{ ok: boolean; error?: string; account?: string } | null>(
    `connectors:phone-confirm:${id}`,
    () => api()?.confirmConnectorPhoneCode?.(id, values) ?? null,
    { fallback: null },
  );
  await listConnectors();
  return result;
}

const invoke = async (
  connector: Connector,
  action: ConnectorAction,
  params: Record<string, unknown>,
): Promise<ConnectorCall> => {
  const result = await safeCall<ConnectorCall | null>(
    `connectors:call:${connector.id}:${action.id}`,
    () => api()?.callConnector?.(connector.id, action.id, params) ?? null,
    { fallback: null },
  );
  return result ?? { ok: false, error: "The desktop bridge did not answer." };
};

/**
 * Run one connector action. Read-only actions run straight away; anything that
 * writes into the owner's external account goes through the same governance
 * gate as every other irreversible action — `kind: "system"` is in
 * ALWAYS_ASK_KINDS, so chat, voice and auto mode all pause and ask first.
 */
export async function runConnectorAction(
  connector: Connector,
  action: ConnectorAction,
  params: Record<string, unknown> = {},
): Promise<ConnectorCall> {
  if (!connector.connected) return { ok: false, error: `${connector.name} is not connected.` };
  if (action.risk === "safe") return invoke(connector, action, params);

  let outcome: ConnectorCall = { ok: false, error: "The action never ran." };
  const item = await governance.submit({
    kind: "system",
    title: `${connector.name} · ${action.label}`,
    rationale: `Writes into your ${connector.name} account: ${action.label.toLowerCase()}.`,
    risk: action.risk === "exec" ? "risky" : "review",
    evidence: [`connector:${connector.id}`, `action:${action.id}`],
    apply: async () => {
      outcome = await invoke(connector, action, params);
      return {
        ok: Boolean(outcome.ok),
        detail: outcome.ok ? (outcome.lines?.[0] ?? "done") : (outcome.error ?? "failed"),
      };
    },
  });
  if (item.stage === "rejected") return { ok: false, error: "You did not approve this action." };
  return outcome;
}

/**
 * One connector action, flattened so the rest of FRIDAY can treat it as an
 * ordinary tool. This is the single list the brain matches against — no second
 * hardcoded catalogue of what a service can do.
 */
export interface ConnectorTool {
  /** Stable tool name used by the run log and the approval prompt. */
  tool: string;
  connectorId: string;
  connectorName: string;
  action: ConnectorAction;
  connected: boolean;
}

export function connectorTools(connectors: Connector[] = knownConnectors()): ConnectorTool[] {
  return connectors.flatMap((connector) =>
    connector.actions.map((action) => ({
      tool: `connector.${connector.id}.${action.id}`,
      connectorId: connector.id,
      connectorName: connector.name,
      action,
      connected: connector.connected,
    })),
  );
}

/**
 * Run a connector action whose approval was ALREADY decided by the caller.
 *
 * The only caller is the brain's tool-execution step, which gates every action
 * through brain/action-risk.ts before it gets here — the same gate that guards
 * kernel tools and skills. UI callers must keep using runConnectorAction(),
 * which carries its own governance submission.
 */
export async function invokeApprovedConnectorAction(
  tool: ConnectorTool,
  params: Record<string, unknown> = {},
): Promise<ConnectorCall> {
  if (!tool.connected) return { ok: false, error: `${tool.connectorName} is not connected.` };
  return invoke(
    { id: tool.connectorId, name: tool.connectorName } as Connector,
    tool.action,
    params,
  );
}

/** One-line summary the Core Brain uses when it reasons about outside data. */
export function connectorDigest(connectors: Connector[]): string {
  const live = connectors.filter((c) => c.connected);
  if (!live.length) return "No external services are connected yet.";
  return `Connected services: ${live.map((c) => `${c.name}${c.account ? ` (${c.account})` : ""}`).join(", ")}.`;
}

/** Live connector list, refreshed whenever the main process changes one. */
export function useConnectors() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(connectorsSupported());

  const refresh = useCallback(async () => {
    if (!connectorsSupported()) {
      setLoading(false);
      return;
    }
    setConnectors(await listConnectors());
    setLoading(false);
  }, []);

  useEffect(() => {
    const stop = deferEffect(() => void refresh());
    const off = api()?.onConnectorsChanged?.(() => void refresh());
    return () => {
      stop();
      off?.();
    };
  }, [refresh]);

  return { connectors, loading, supported: connectorsSupported(), refresh };
}
