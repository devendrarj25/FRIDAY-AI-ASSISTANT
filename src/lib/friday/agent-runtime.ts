/**
 * Renderer bridge for background agents (plan / run).
 *
 * plan() is read-only. run() defaults to dryRun: true; a mutating run is
 * only requested after the owner has approved a plan.
 */
import { desktopApi, isDesktopApp, safeCall } from "./desktop";

export type AgentInvokeResult = {
  ok: boolean;
  id?: string;
  value?: unknown;
  error?: string;
  ms?: number;
};

type Api = {
  listAgents?: () => Promise<{ ok?: boolean; agents?: unknown[] }>;
  planAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<AgentInvokeResult>;
  runAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<AgentInvokeResult>;
};

const api = () => desktopApi() as unknown as Api | null;

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

export async function listAgents(): Promise<{ ok: boolean; agents: unknown[] }> {
  if (!isDesktopApp()) return { ok: false, agents: [] };
  const result = await safeCall<{ ok?: boolean; agents?: unknown[] } | null>(
    "agents:list",
    () => api()?.listAgents?.() ?? null,
    { fallback: null },
  );
  return { ok: Boolean(result?.ok), agents: result?.agents ?? [] };
}

export async function planAgent(
  id: string,
  input: Record<string, unknown> = {},
  options: { allowDisabled?: boolean } = {},
): Promise<AgentInvokeResult> {
  if (!isDesktopApp()) return { ok: false, error: DESKTOP_ONLY };
  const result = await safeCall<AgentInvokeResult | null>(
    `agents:plan:${id}`,
    () => api()?.planAgent?.(id, input, options) ?? null,
    { fallback: null },
  );
  return result ?? { ok: false, error: DESKTOP_ONLY };
}

export async function runAgent(
  id: string,
  input: Record<string, unknown> = {},
  options: { allowDisabled?: boolean } = {},
): Promise<AgentInvokeResult> {
  if (!isDesktopApp()) return { ok: false, error: DESKTOP_ONLY };
  const payload = { dryRun: true, ...input };
  const result = await safeCall<AgentInvokeResult | null>(
    `agents:run:${id}`,
    () => api()?.runAgent?.(id, payload, options) ?? null,
    { fallback: null },
  );
  return result ?? { ok: false, error: DESKTOP_ONLY };
}
