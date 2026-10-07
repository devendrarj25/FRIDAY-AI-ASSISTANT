/**
 * FRIDAY · module router
 *
 * Same conservative keyword index as the tool router: a large catalog is not
 * scored on every turn. One or several enabled+safe modules run in sequence
 * when the prompt names them or chains them. Write/exec stays behind
 * tool-authority (invoke still asks); this router never auto-picks those.
 */

import {
  invokeModulePack,
  listModulePacks,
  type ModuleInvokeResult,
  type ModulePackManifest,
} from "./module-forge";
import { turnDone, turnMark } from "./turn-timing";

export type ModuleRun = {
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
  "module",
  "modules",
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

type ModuleIndex = {
  signature: string;
  byToken: Map<string, number[]>;
  modules: ModulePackManifest[];
};

let cachedIndex: ModuleIndex | null = null;
let lastScored = 0;

type ModuleInvokeHost = {
  list?: () => Promise<ModulePackManifest[]>;
  invoke?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<ModuleInvokeResult>;
};

let invokeHost: ModuleInvokeHost | null = null;

export function setModuleInvokeHost(host: ModuleInvokeHost | null): void {
  invokeHost = host;
}

function signatureOf(modules: ModulePackManifest[]): string {
  return modules.map((item) => `${item.id}:${item.enabled ? 1 : 0}:${item.risk}`).join("|");
}

function buildIndex(modules: ModulePackManifest[]): ModuleIndex {
  const byToken = new Map<string, number[]>();
  modules.forEach((item, index) => {
    const tokens = words(
      `${item.id} ${item.name} ${item.description} ${item.category} ${(item.keywords ?? []).join(" ")}`,
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
  return { signature: signatureOf(modules), byToken, modules };
}

export function resetModuleIndex(): void {
  cachedIndex = null;
  lastScored = 0;
}

export function lastModuleScoredCount(): number {
  return lastScored;
}

export function moduleIndex(modules: ModulePackManifest[]): ModuleIndex {
  const signature = signatureOf(modules);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;
  cachedIndex = buildIndex(modules);
  return cachedIndex;
}

export function candidateModules(
  prompt: string,
  modules: ModulePackManifest[],
): ModulePackManifest[] {
  const index = moduleIndex(modules);
  const hits = new Set<number>();
  for (const token of words(prompt)) {
    const list = index.byToken.get(token);
    if (!list) continue;
    for (const i of list) hits.add(i);
  }
  return [...hits].map((i) => index.modules[i]!);
}

export function scoreModule(prompt: string, item: ModulePackManifest): number {
  const text = prompt.toLowerCase();
  const name = item.name.toLowerCase().trim();
  if (name.length >= 4 && text.includes(name)) return 1;
  const idTail = item.id.split("/").pop() || item.id;
  if (idTail.length >= 4 && text.includes(idTail.toLowerCase())) return 1;
  if (text.includes(item.id.toLowerCase())) return 1;

  const keywords = (item.keywords ?? [])
    .map((entry) => entry.toLowerCase().trim())
    .filter((entry) => entry.length >= 4);
  if (keywords.some((entry) => text.includes(entry))) return 0.85;

  const promptWords = new Set(words(text));
  const distinctive = words(idTail.replace(/-/g, " ")).filter((entry) => entry.length >= 5);
  if (distinctive.some((entry) => promptWords.has(entry))) return 0.8;

  const hay = new Set(words(text));
  const needles = words(`${item.name} ${item.description} ${(item.keywords ?? []).join(" ")}`);
  if (!needles.length) return 0;
  const hits = needles.filter((word) => hay.has(word)).length;
  if (hits < 2) return 0;
  return Math.min(0.9, hits / needles.length + 0.2);
}

function scoredMatches(
  prompt: string,
  modules: ModulePackManifest[],
): { item: ModulePackManifest; score: number }[] {
  const candidates = candidateModules(prompt, modules);
  lastScored = candidates.length;
  const scored: { item: ModulePackManifest; score: number }[] = [];
  for (const item of candidates) {
    if (!item.enabled || item.risk !== "safe") continue;
    if (item.runnable === false || item.healthy === false) continue;
    const score = scoreModule(prompt, item);
    if (score < 0.6) continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function chooseModules(
  prompt: string,
  modules: ModulePackManifest[],
  options: { limit?: number } = {},
): ModulePackManifest[] {
  const limit = Math.max(1, options.limit ?? MAX_SEQUENCE);
  const scored = scoredMatches(prompt, modules);
  if (!scored.length) return [];
  const named = scored.filter((entry) => entry.score === 1);
  if (named.length >= 2) return named.slice(0, limit).map((entry) => entry.item);
  if (SEQUENCE.test(prompt)) {
    const picked: ModulePackManifest[] = [];
    const used = new Set<string>();
    for (const entry of scored) {
      if (picked.length >= limit) break;
      if (used.has(entry.item.id)) continue;
      picked.push(entry.item);
      used.add(entry.item.id);
    }
    return picked;
  }
  return [scored[0]!.item];
}

export function describeModuleValue(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

async function invokeOne(
  item: ModulePackManifest,
  prompt: string,
  previous: ModuleRun[],
): Promise<ModuleRun> {
  turnMark("module", "invoke");
  const invoke = invokeHost?.invoke ?? invokeModulePack;
  try {
    const result = await invoke(item.id, {
      prompt,
      previous: previous.map((run) => ({ id: run.id, ok: run.ok, value: run.value })),
    });
    const ok = Boolean(result?.ok);
    turnDone("module", "invoke", ok ? "ok" : "failed");
    return {
      id: item.id,
      name: item.name,
      ok,
      detail: ok ? `ran in ${result?.ms ?? 0}ms` : String(result?.error ?? "module failed"),
      value: ok ? result.value : null,
    };
  } catch (error) {
    turnDone("module", "invoke", "threw");
    return {
      id: item.id,
      name: item.name,
      ok: false,
      detail: String((error as Error)?.message ?? error),
      value: null,
    };
  }
}

export async function routeModules(prompt: string): Promise<ModuleRun[]> {
  turnMark("module", "list");
  let modules: ModulePackManifest[];
  try {
    modules = invokeHost?.list ? await invokeHost.list() : await listModulePacks();
  } catch {
    turnDone("module", "list", "failed");
    return [];
  }
  turnDone("module", "list", `${modules.length} module(s)`);
  const chosen = chooseModules(prompt, modules, { limit: MAX_SEQUENCE });
  if (!chosen.length) return [];
  const runs: ModuleRun[] = [];
  for (const item of chosen) {
    runs.push(await invokeOne(item, prompt, runs));
  }
  return runs;
}
