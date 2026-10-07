/**
 * FRIDAY · connector router
 *
 * Connected connector actions are ordinary tools. This router only auto-picks
 * `safe` + connected actions when the prompt names the service, the same
 * conservative rule as skills/tools/modules. Write/exec never auto-runs —
 * chat still uses baseline-responder + governance for those.
 *
 * The action list comes from connectorTools() (the ONE bridge). No second
 * catalogue of what a service can do.
 */
import {
  connectorTools,
  invokeApprovedConnectorAction,
  knownConnectors,
  type ConnectorTool,
} from "../connectors";
import { turnDone, turnMark } from "./turn-timing";

export type ConnectorRun = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  value: unknown;
};

const GENERIC = new Set(["custom", "server", "cloud", "http", "google", "microsoft", "api"]);
const MAX_SEQUENCE = 2;

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/** True when the prompt clearly names this service. */
export function connectorMentioned(
  lower: string,
  connector: { id: string; name: string },
): boolean {
  const name = connector.name.toLowerCase();
  if (name && lower.includes(name)) return true;
  const slug = connector.id.replace(/-/g, " ");
  if (slug.length > 3 && lower.includes(slug)) return true;
  return name
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 4 && !GENERIC.has(token))
    .some((token) => lower.includes(token));
}

export function chooseConnectors(
  prompt: string,
  tools: ConnectorTool[] = connectorTools(),
): ConnectorTool[] {
  const lower = prompt.toLowerCase();
  const asked = new Set(words(prompt));
  const live = tools.filter(
    (tool) =>
      tool.connected &&
      tool.action.risk === "safe" &&
      connectorMentioned(lower, {
        id: tool.connectorId,
        name: tool.connectorName,
      }),
  );
  const scored = live
    .map((tool) => {
      const label = words(`${tool.action.label} ${tool.action.id}`);
      const score = label.filter((w) => asked.has(w)).length;
      return { tool, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: ConnectorTool[] = [];
  for (const row of scored) {
    if (picked.length >= MAX_SEQUENCE) break;
    if (picked.some((item) => item.tool === row.tool.tool)) continue;
    picked.push(row.tool);
  }
  return picked;
}

export function describeConnectorValue(value: unknown): string {
  if (Array.isArray(value))
    return value
      .map((line) => String(line))
      .join("\n")
      .slice(0, 4000);
  if (value && typeof value === "object" && "lines" in value) {
    const lines = (value as { lines?: unknown }).lines;
    if (Array.isArray(lines))
      return lines
        .map((line) => String(line))
        .join("\n")
        .slice(0, 4000);
  }
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

export async function routeConnectors(prompt: string): Promise<ConnectorRun[]> {
  turnMark("connector", "list");
  if (!knownConnectors().length) {
    turnDone("connector", "list", "none loaded");
    return [];
  }
  const chosen = chooseConnectors(prompt);
  turnDone("connector", "list", `${chosen.length} action(s)`);
  if (!chosen.length) return [];
  const runs: ConnectorRun[] = [];
  for (const tool of chosen) {
    turnMark("connector", "invoke");
    try {
      const result = await invokeApprovedConnectorAction(tool, { prompt, text: prompt });
      const ok = Boolean(result?.ok);
      turnDone("connector", "invoke", ok ? "ok" : "failed");
      runs.push({
        id: tool.tool,
        name: `${tool.connectorName} · ${tool.action.label}`,
        ok,
        detail: ok ? `ran in ${result?.ms ?? 0}ms` : String(result?.error ?? "connector failed"),
        value: ok ? (result.lines ?? []) : null,
      });
    } catch (error) {
      turnDone("connector", "invoke", "threw");
      runs.push({
        id: tool.tool,
        name: `${tool.connectorName} · ${tool.action.label}`,
        ok: false,
        detail: String((error as Error)?.message ?? error),
        value: null,
      });
    }
  }
  return runs;
}
