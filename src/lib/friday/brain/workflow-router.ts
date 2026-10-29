/**
 * FRIDAY · workflow router
 *
 * Conservative keyword match against installed workflow packs. A keyword
 * index picks candidates first so the 116-pack catalog is not scored on
 * every turn. Named packs (score 1) all run up to three. "then" / "also"
 * runs them one after one; "at once" / "together" / "in parallel" runs
 * independent safe packs concurrently. Implicit chaining uses
 * considerCollaboration() — the same gate as agents. Write/exec packs are
 * never auto-picked. Test selected uses runWorkflowPack with allowDisabled
 * + dryRun instead.
 */

import { considerCollaboration } from "./multi-model";
import {
  listWorkflowPacks,
  runWorkflowPack,
  type WorkflowPackManifest,
  type WorkflowRunResult,
} from "./workflow-forge";
import { turnDone, turnMark } from "./turn-timing";

export type WorkflowChatRun = {
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
  "workflow",
  "workflows",
  "automation",
]);

const SEQUENCE = /\b(then|after that|and then|also|plus|followed by|next)\b/i;
const PARALLEL =
  /\b(at once|together|in parallel|both|all at once|simultaneously|at the same time)\b/i;
const MAX_SEQUENCE = 3;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** Prompt tokens plus hyphenated slugs (`morning-briefing`, `self-health`). */
function lookupTokens(text: string): string[] {
  const hyphenated = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? [];
  return [...words(text), ...hyphenated];
}

function idTail(id: string): string {
  return (id.split("/").pop() || id).toLowerCase();
}

/** True when `slug` appears as its own token, not a prefix of a longer slug. */
function hasSlug(text: string, slug: string): boolean {
  if (slug.length < 4) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`, "i").test(text);
}

function slugKeys(id: string): string[] {
  const tail = idTail(id);
  const trimmed = tail.replace(/-workflow$/, "").replace(/-chain$/, "");
  const keys = [tail];
  if (trimmed.includes("-") && trimmed !== tail) keys.push(trimmed);
  return keys;
}

type WorkflowIndex = {
  signature: string;
  byToken: Map<string, number[]>;
  workflows: WorkflowPackManifest[];
};

let cachedIndex: WorkflowIndex | null = null;
let lastScored = 0;
let listHost: (() => Promise<WorkflowPackManifest[]>) | null = null;
let runHost: ((id: string, prompt: string) => Promise<WorkflowRunResult>) | null = null;

export function setWorkflowRouteHost(
  host: {
    list?: () => Promise<WorkflowPackManifest[]>;
    run?: (id: string, prompt: string) => Promise<WorkflowRunResult>;
  } | null,
): void {
  listHost = host?.list ?? null;
  runHost = host?.run ?? null;
}

function signatureOf(workflows: WorkflowPackManifest[]): string {
  return workflows.map((item) => `${item.id}:${item.enabled ? 1 : 0}:${item.risk}`).join("|");
}

function addToken(byToken: Map<string, number[]>, token: string, index: number) {
  const list = byToken.get(token);
  if (list) {
    if (list[list.length - 1] !== index) list.push(index);
  } else {
    byToken.set(token, [index]);
  }
}

function buildIndex(workflows: WorkflowPackManifest[]): WorkflowIndex {
  const byToken = new Map<string, number[]>();
  workflows.forEach((item, index) => {
    const tokens = words(
      `${item.id} ${item.name} ${item.description} ${item.category} ${item.schedule} ${item.steps.map((step) => step.label).join(" ")}`,
    );
    for (const token of tokens) addToken(byToken, token, index);
    for (const slug of slugKeys(item.id)) {
      addToken(byToken, slug, index);
      for (const part of slug.split("-")) {
        if (part.length >= 3 && !STOP.has(part)) addToken(byToken, part, index);
      }
    }
  });
  return { signature: signatureOf(workflows), byToken, workflows };
}

export function resetWorkflowIndex(): void {
  cachedIndex = null;
  lastScored = 0;
}

export function lastWorkflowScoredCount(): number {
  return lastScored;
}

export function workflowIndex(workflows: WorkflowPackManifest[]): WorkflowIndex {
  const signature = signatureOf(workflows);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;
  cachedIndex = buildIndex(workflows);
  return cachedIndex;
}

export function candidateWorkflows(
  prompt: string,
  workflows: WorkflowPackManifest[],
): WorkflowPackManifest[] {
  const index = workflowIndex(workflows);
  const hits = new Set<number>();
  for (const token of lookupTokens(prompt)) {
    const list = index.byToken.get(token);
    if (!list) continue;
    for (const i of list) hits.add(i);
  }
  return [...hits].map((i) => index.workflows[i]!);
}

export function scoreWorkflow(prompt: string, item: WorkflowPackManifest): number {
  const text = prompt.toLowerCase();
  const name = item.name.toLowerCase().trim();
  if (name.length >= 4 && text.includes(name)) return 1;
  const tail = idTail(item.id);
  if (tail.length >= 4 && text.includes(tail)) return 1;
  if (text.includes(item.id.toLowerCase())) return 1;
  for (const slug of slugKeys(item.id)) {
    if (hasSlug(text, slug)) return 1;
    const spaced = slug.replace(/-/g, " ");
    if (spaced !== slug && hasSlug(text, spaced)) return 1;
  }
  if (
    /\bworkflow\b/i.test(text) &&
    name
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .some((w) => text.includes(w))
  ) {
    return 0.9;
  }

  const promptWords = new Set(words(text));
  const distinctive = words(tail.replace(/-/g, " ")).filter((entry) => entry.length >= 5);
  if (distinctive.some((entry) => promptWords.has(entry))) return 0.8;

  const hay = new Set(words(text));
  const needles = words(`${item.name} ${item.description} ${item.category}`);
  if (!needles.length) return 0;
  const hits = needles.filter((word) => hay.has(word)).length;
  if (hits < 2) return 0;
  return Math.min(0.9, hits / needles.length + 0.2);
}

function scoredMatches(
  prompt: string,
  workflows: WorkflowPackManifest[],
): { item: WorkflowPackManifest; score: number }[] {
  const candidates = candidateWorkflows(prompt, workflows);
  lastScored = candidates.length;
  const scored: { item: WorkflowPackManifest; score: number }[] = [];
  for (const item of candidates) {
    if (!item.enabled || item.risk !== "safe") continue;
    const score = scoreWorkflow(prompt, item);
    if (score < 0.6) continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function firstMention(prompt: string, item: WorkflowPackManifest): number {
  const text = prompt.toLowerCase();
  const keys = [item.name.toLowerCase(), idTail(item.id), ...slugKeys(item.id)];
  let best = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key.length < 4) continue;
    const index = text.indexOf(key);
    if (index >= 0 && index < best) best = index;
  }
  return best;
}

function uniqueTake(
  scored: { item: WorkflowPackManifest; score: number }[],
  limit: number,
  prompt: string,
): WorkflowPackManifest[] {
  const ordered = [...scored].sort((a, b) => {
    if (a.score !== b.score && (a.score === 1 || b.score === 1)) return b.score - a.score;
    return firstMention(prompt, a.item) - firstMention(prompt, b.item);
  });
  const picked: WorkflowPackManifest[] = [];
  const used = new Set<string>();
  for (const entry of ordered) {
    if (picked.length >= limit) break;
    if (used.has(entry.item.id)) continue;
    picked.push(entry.item);
    used.add(entry.item.id);
  }
  return picked;
}

export function wantsParallelWorkflows(prompt: string): boolean {
  return PARALLEL.test(prompt);
}

/**
 * One, sequential, or several matching workflows. Named packs (score 1) all
 * run up to `limit`. A chained prompt ("then" / "also") or an explicit
 * parallel ask ("at once") takes complementary matches. Implicit multi uses
 * considerCollaboration(). Ordinary chat still returns [].
 */
export function chooseWorkflows(
  prompt: string,
  workflows: WorkflowPackManifest[],
  options: { limit?: number } = {},
): WorkflowPackManifest[] {
  const limit = Math.max(1, options.limit ?? MAX_SEQUENCE);
  const scored = scoredMatches(prompt, workflows);
  if (!scored.length) return [];
  const named = scored.filter((entry) => entry.score === 1);
  if (named.length >= 2) return uniqueTake(named, limit, prompt);
  if (SEQUENCE.test(prompt) || PARALLEL.test(prompt)) {
    return uniqueTake(scored, limit, prompt);
  }
  const collab = considerCollaboration(prompt);
  if (collab.warranted && scored.length > 1) {
    return uniqueTake(scored, Math.min(limit, Math.max(2, collab.count)), prompt);
  }
  return [scored[0]!.item];
}

export function describeWorkflowValue(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

async function invokeOne(item: WorkflowPackManifest, prompt: string): Promise<WorkflowChatRun> {
  turnMark("workflow", "invoke");
  try {
    const result = runHost
      ? await runHost(item.id, prompt)
      : await runWorkflowPack(item.id, { dryRun: true, prompt });
    const ok = Boolean(result?.ok);
    turnDone("workflow", "invoke", ok ? "ok" : "failed");
    const failed = result.steps?.find((step) => !step.ok);
    return {
      id: item.id,
      name: item.name,
      ok,
      detail: ok
        ? `${result.steps.length} step(s)`
        : String(result.error || failed?.detail || "workflow failed"),
      value: result.steps,
    };
  } catch (error) {
    turnDone("workflow", "invoke", "threw");
    return {
      id: item.id,
      name: item.name,
      ok: false,
      detail: String((error as Error)?.message ?? error),
      value: null,
    };
  }
}

export async function routeWorkflows(prompt: string): Promise<WorkflowChatRun[]> {
  turnMark("workflow", "list");
  let workflows: WorkflowPackManifest[];
  try {
    workflows = listHost ? await listHost() : await listWorkflowPacks();
  } catch {
    turnDone("workflow", "list", "failed");
    return [];
  }
  turnDone("workflow", "list", `${workflows.length} workflow(s)`);
  const chosen = chooseWorkflows(prompt, workflows, { limit: MAX_SEQUENCE });
  if (!chosen.length) return [];
  if (wantsParallelWorkflows(prompt) && chosen.length > 1) {
    return Promise.all(chosen.map((item) => invokeOne(item, prompt)));
  }
  const runs: WorkflowChatRun[] = [];
  for (const item of chosen) {
    const chained =
      runs.length > 0
        ? `${prompt}\n\nPrevious workflow output:\n${describeWorkflowValue(runs[runs.length - 1]!.value)}`
        : prompt;
    runs.push(await invokeOne(item, chained));
  }
  return runs;
}
