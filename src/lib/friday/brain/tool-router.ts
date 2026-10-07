/**
 * FRIDAY · tool router
 *
 * Same conservative keyword index as the skill router: a large catalog is not
 * scored on every turn. One or several enabled+safe tools run in sequence when
 * the prompt names them or chains them. Write/exec stays behind tool-authority
 * (invoke still asks); this router never auto-picks those.
 */

import { invokeToolPack, listToolPacks, type ToolPackManifest } from "./tool-forge";
import { turnDone, turnMark } from "./turn-timing";

export type ToolRun = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  value: unknown;
};

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "to",
  "of",
  "in",
  "on",
  "my",
  "me",
  "you",
  "friday",
  "please",
  "tool",
  "tools",
  "run",
  "use",
  "get",
  "make",
  "do",
  "that",
  "this",
  "it",
  "is",
  "are",
]);

const SEQUENCE = /\b(then|after that|and then|also|plus|followed by|next)\b/i;
const MAX_SEQUENCE = 3;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

type ToolIndex = {
  signature: string;
  byToken: Map<string, number[]>;
  tools: ToolPackManifest[];
};

let cachedIndex: ToolIndex | null = null;
let lastScored = 0;

function signatureOf(tools: ToolPackManifest[]): string {
  return tools.map((tool) => `${tool.id}:${tool.enabled ? 1 : 0}:${tool.risk}`).join("|");
}

function buildIndex(tools: ToolPackManifest[]): ToolIndex {
  const byToken = new Map<string, number[]>();
  tools.forEach((tool, index) => {
    const tokens = words(
      `${tool.id} ${tool.name} ${tool.description} ${tool.category} ${(tool.keywords ?? []).join(" ")}`,
    );
    for (const token of tokens) {
      const list = byToken.get(token);
      if (list) {
        if (list[list.length - 1] !== index) list.push(index);
      } else {
        byToken.set(token, [index]);
      }
    }
  });
  return { signature: signatureOf(tools), byToken, tools };
}

export function resetToolIndex(): void {
  cachedIndex = null;
  lastScored = 0;
}

export function lastToolScoredCount(): number {
  return lastScored;
}

export function toolIndex(tools: ToolPackManifest[]): ToolIndex {
  const signature = signatureOf(tools);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;
  cachedIndex = buildIndex(tools);
  return cachedIndex;
}

export function candidateTools(prompt: string, tools: ToolPackManifest[]): ToolPackManifest[] {
  const index = toolIndex(tools);
  const hits = new Set<number>();
  for (const token of words(prompt)) {
    const list = index.byToken.get(token);
    if (!list) continue;
    for (const i of list) hits.add(i);
  }
  return [...hits].map((i) => index.tools[i]!);
}

export function scoreTool(prompt: string, tool: ToolPackManifest): number {
  const text = prompt.toLowerCase();
  const name = tool.name.toLowerCase().trim();
  if (name.length >= 4 && text.includes(name)) return 1;
  const idTail = tool.id.split("/").pop() || tool.id;
  if (idTail.length >= 4 && text.includes(idTail.toLowerCase())) return 1;
  if (text.includes(tool.id.toLowerCase())) return 1;

  const keywords = (tool.keywords ?? [])
    .map((item) => item.toLowerCase().trim())
    .filter((item) => item.length >= 4);
  if (keywords.some((item) => text.includes(item))) return 0.85;

  const promptWords = new Set(words(text));
  const distinctive = words(idTail.replace(/-/g, " ")).filter((item) => item.length >= 5);
  if (distinctive.some((item) => promptWords.has(item))) return 0.8;

  const hay = new Set(words(text));
  const needles = words(`${tool.name} ${tool.description} ${(tool.keywords ?? []).join(" ")}`);
  if (!needles.length) return 0;
  const hits = needles.filter((word) => hay.has(word)).length;
  if (hits < 2) return 0;
  return Math.min(0.9, hits / needles.length + 0.2);
}

function scoredMatches(
  prompt: string,
  tools: ToolPackManifest[],
): { tool: ToolPackManifest; score: number }[] {
  const candidates = candidateTools(prompt, tools);
  lastScored = candidates.length;
  const scored: { tool: ToolPackManifest; score: number }[] = [];
  for (const tool of candidates) {
    if (!tool.enabled || tool.risk !== "safe") continue;
    if (tool.runnable === false || tool.healthy === false) continue;
    const score = scoreTool(prompt, tool);
    if (score < 0.6) continue;
    scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function chooseTools(
  prompt: string,
  tools: ToolPackManifest[],
  options: { limit?: number } = {},
): ToolPackManifest[] {
  const limit = Math.max(1, options.limit ?? MAX_SEQUENCE);
  const scored = scoredMatches(prompt, tools);
  if (!scored.length) return [];
  const named = scored.filter((item) => item.score === 1);
  if (named.length >= 2) return named.slice(0, limit).map((item) => item.tool);
  if (SEQUENCE.test(prompt)) {
    const picked: ToolPackManifest[] = [];
    const used = new Set<string>();
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (used.has(item.tool.id)) continue;
      picked.push(item.tool);
      used.add(item.tool.id);
    }
    return picked;
  }
  return [scored[0]!.tool];
}

export function describeToolValue(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

async function invokeOne(
  tool: ToolPackManifest,
  prompt: string,
  previous: ToolRun[],
): Promise<ToolRun> {
  turnMark("tool", "invoke");
  try {
    const result = await invokeToolPack(tool.id, {
      prompt,
      previous: previous.map((run) => ({ id: run.id, ok: run.ok, value: run.value })),
    });
    const ok = Boolean(result?.ok);
    turnDone("tool", "invoke", ok ? "ok" : "failed");
    return {
      id: tool.id,
      name: tool.name,
      ok,
      detail: ok ? `ran in ${result?.ms ?? 0}ms` : String(result?.error ?? "tool failed"),
      value: ok ? (result as { value?: unknown }).value : null,
    };
  } catch (error) {
    turnDone("tool", "invoke", "threw");
    return {
      id: tool.id,
      name: tool.name,
      ok: false,
      detail: String((error as Error)?.message ?? error),
      value: null,
    };
  }
}

export async function routeTools(prompt: string): Promise<ToolRun[]> {
  turnMark("tool", "list");
  let tools: ToolPackManifest[];
  try {
    tools = await listToolPacks();
  } catch {
    turnDone("tool", "list", "failed");
    return [];
  }
  turnDone("tool", "list", `${tools.length} tool(s)`);
  const chosen = chooseTools(prompt, tools, { limit: MAX_SEQUENCE });
  if (!chosen.length) return [];
  const runs: ToolRun[] = [];
  for (const tool of chosen) {
    runs.push(await invokeOne(tool, prompt, runs));
  }
  return runs;
}
