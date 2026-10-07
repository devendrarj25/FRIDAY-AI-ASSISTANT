/**
 * FRIDAY · agent router
 *
 * Same conservative keyword index as the skill router: a growing catalog is
 * not scored on every turn. The index is built from the live capability
 * registry (agents/* installs, marketplace packs that landed there, and
 * agent-forge output once installed) and rebuilt only when that agent set
 * changes.
 *
 * Explicit multi-agent naming runs those agents in sequence. Implicit
 * chaining uses considerCollaboration() from multi-model.ts — the same
 * confidence / stakes gate, not a second heuristic. Only enabled + safe
 * agents auto-run; write/exec stay behind the owner's explicit Self Core
 * request, same as skills.
 */

import { capabilityRegistry, type CapabilityResource } from "./capability-registry";
import { considerCollaboration } from "./multi-model";
import { invokeSkill, listSkills } from "./skill-forge";
import { planAgent, runAgent, type AgentInvokeResult } from "../agent-runtime";
import { runWorkflowPack, type WorkflowRunResult } from "./workflow-forge";
import { learning } from "../self/learning-engine";
import { turnDone, turnMark } from "./turn-timing";

export type AgentRecord = {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  skills: string[];
  workflows: string[];
  role: string;
  risk: "safe" | "write" | "exec";
  enabled: boolean;
};

export type AgentRun = {
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
  "agent",
  "agents",
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

const MAX_SEQUENCE = 3;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** Prompt tokens plus hyphenated slugs (`tender-analysis`, `go-no-go`). */
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
  const trimmed = tail.replace(/-agent$/, "");
  const keys = [tail];
  // Suffix-stripped form only when it stays a distinctive hyphenated slug
  // (`tender-analysis`, `go-no-go`). Single tokens like `data` / `inbox` are
  // too common for a score-1 fire.
  if (trimmed.includes("-") && trimmed !== tail) keys.push(trimmed);
  return keys;
}

type AgentIndex = {
  signature: string;
  byToken: Map<string, number[]>;
  agents: AgentRecord[];
};

let cachedIndex: AgentIndex | null = null;
let lastScored = 0;

function signatureOf(agents: AgentRecord[]): string {
  return agents
    .map(
      (agent) =>
        `${agent.id}:${agent.enabled ? 1 : 0}:${agent.risk}:${agent.role}:${agent.skills.join(",")}:${agent.workflows.join(",")}`,
    )
    .join("|");
}

function addToken(byToken: Map<string, number[]>, token: string, index: number) {
  const list = byToken.get(token);
  if (list) {
    if (list[list.length - 1] !== index) list.push(index);
  } else {
    byToken.set(token, [index]);
  }
}

function buildIndex(agents: AgentRecord[]): AgentIndex {
  const byToken = new Map<string, number[]>();
  agents.forEach((agent, index) => {
    const blob = `${agent.id} ${agent.name} ${agent.summary} ${agent.role} ${agent.tags.join(" ")} ${agent.skills.join(" ")}`;
    for (const token of words(blob)) addToken(byToken, token, index);
    for (const slug of slugKeys(agent.id)) {
      addToken(byToken, slug, index);
      for (const part of slug.split("-")) {
        if (part.length >= 3 && !STOP.has(part)) addToken(byToken, part, index);
      }
    }
  });
  return { signature: signatureOf(agents), byToken, agents };
}

export function resetAgentIndex(): void {
  cachedIndex = null;
  lastScored = 0;
}

export function lastAgentScoredCount(): number {
  return lastScored;
}

export function agentIndex(agents: AgentRecord[]): AgentIndex {
  const signature = signatureOf(agents);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;
  cachedIndex = buildIndex(agents);
  return cachedIndex;
}

function riskFromPermission(permission: CapabilityResource["permission"]): AgentRecord["risk"] {
  if (permission === "open") return "safe";
  if (permission === "owner-only") return "exec";
  return "write";
}

function looksLikeSkillId(token: string): boolean {
  return /[./]/.test(token) && token.length >= 3;
}

/** Map one live registry resource onto the router record. No second catalog. */
export function agentFromResource(resource: CapabilityResource): AgentRecord {
  const declaredSkills = Array.isArray(resource.skills)
    ? resource.skills.map(String).filter(Boolean)
    : [];
  const skills = declaredSkills.length
    ? declaredSkills
    : resource.capabilities.filter((item) => looksLikeSkillId(item));
  const workflows = Array.isArray(resource.workflows)
    ? resource.workflows.map(String).filter(Boolean)
    : [];
  const role =
    (resource.role && String(resource.role)) ||
    resource.capabilities.find(
      (item) =>
        /^[a-z][a-z0-9-]+$/.test(item) &&
        !looksLikeSkillId(item) &&
        item !== "agents" &&
        item !== "agent",
    ) ||
    "";
  return {
    id: resource.ref || resource.id,
    name: resource.name,
    summary: resource.detail || "",
    tags: resource.capabilities,
    skills,
    workflows,
    role,
    risk: riskFromPermission(resource.permission),
    enabled: resource.available,
  };
}

/** Every agent currently in the live capability registry, including disabled. */
export function listAgentsFromRegistry(): AgentRecord[] {
  const snapshot = capabilityRegistry.getSnapshot();
  return snapshot.resources.filter((resource) => resource.type === "agent").map(agentFromResource);
}

export function candidateAgents(prompt: string, agents: AgentRecord[]): AgentRecord[] {
  const index = agentIndex(agents);
  const hits = new Set<number>();
  for (const token of lookupTokens(prompt)) {
    const list = index.byToken.get(token);
    if (!list) continue;
    for (const i of list) hits.add(i);
  }
  return [...hits].map((i) => index.agents[i]!);
}

/**
 * Score one agent against the prompt. A direct name or slug match wins;
 * otherwise the agent needs at least two of its distinctive words present.
 */
export function scoreAgent(prompt: string, agent: AgentRecord): number {
  const text = prompt.toLowerCase();
  const name = agent.name.toLowerCase().trim();
  if (name.length >= 4 && text.includes(name)) return 1;
  if (text.includes(agent.id.toLowerCase())) return 1;
  for (const slug of slugKeys(agent.id)) {
    if (hasSlug(text, slug)) return 1;
    const spaced = slug.replace(/-/g, " ");
    if (spaced !== slug && hasSlug(text, spaced)) return 1;
  }

  const hay = new Set(words(text));
  const needles = words(`${agent.name} ${agent.summary} ${agent.role} ${agent.tags.join(" ")}`);
  if (!needles.length) return 0;
  const hits = needles.filter((word) => hay.has(word)).length;
  if (hits < 2) return 0;
  return Math.min(0.9, hits / needles.length + 0.2);
}

function scoredMatches(
  prompt: string,
  agents: AgentRecord[],
): { agent: AgentRecord; score: number }[] {
  const candidates = candidateAgents(prompt, agents);
  lastScored = candidates.length;
  const scored: { agent: AgentRecord; score: number }[] = [];
  for (const agent of candidates) {
    if (!agent.enabled || agent.risk !== "safe") continue;
    const score = scoreAgent(prompt, agent);
    if (score < 0.6) continue;
    scored.push({ agent, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function uniqueTake(scored: { agent: AgentRecord; score: number }[], limit: number): AgentRecord[] {
  const picked: AgentRecord[] = [];
  const used = new Set<string>();
  for (const item of scored) {
    if (picked.length >= limit) break;
    if (used.has(item.agent.id)) continue;
    picked.push(item.agent);
    used.add(item.agent.id);
  }
  return picked;
}

/**
 * One or several matching agents. Named agents (score 1) all run up to
 * `limit`. Implicit chaining is gated by considerCollaboration() — the same
 * confidence / owner-request / stakes decision as multi-model, not a second
 * "then/also" parser.
 */
export function chooseAgents(
  prompt: string,
  agents: AgentRecord[],
  options: { limit?: number } = {},
): AgentRecord[] {
  const limit = Math.max(1, options.limit ?? MAX_SEQUENCE);
  const scored = scoredMatches(prompt, agents);
  if (!scored.length) return [];
  const named = scored.filter((item) => item.score === 1);
  if (named.length >= 2) return uniqueTake(named, limit);
  const collab = considerCollaboration(prompt);
  if (collab.warranted && scored.length > 1) {
    return uniqueTake(scored, Math.min(limit, Math.max(2, collab.count)));
  }
  return [scored[0]!.agent];
}

export function describeAgentValue(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

/**
 * Skill-router has no ledger write. Agent runs do: `orchestrator.recordStep`
 * no-ops when `modelId` is null and a real model id would pollute model
 * stats, so the existing non-model loop is `learning.evaluate` →
 * `experiences.record` (task ledger + capability matrix).
 */
function recordOutcome(agent: AgentRecord, ok: boolean, ms: number, detail: string) {
  learning.evaluate({
    taskId: `agent-route-${agent.id}-${Date.now().toString(36)}`,
    kind: "agent-route",
    title: agent.name,
    success: ok,
    verified: ok,
    ms,
    tools: [agent.id],
    detail,
  });
}

export type AgentInvokeHost = {
  plan?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<AgentInvokeResult>;
  run?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<AgentInvokeResult>;
  listSkills?: typeof listSkills;
  invokeSkill?: typeof invokeSkill;
  runWorkflow?: (
    id: string,
    options?: { allowDisabled?: boolean; dryRun?: boolean; prompt?: string },
  ) => Promise<WorkflowRunResult>;
};

let invokeHost: AgentInvokeHost = {};

/** Tests inject plan/run. Production uses `agent-runtime` → `agents:plan` / `agents:run`. */
export function setAgentInvokeHost(host: AgentInvokeHost | null): void {
  invokeHost = host ?? {};
}

function missingRunnable(error?: string): boolean {
  const text = String(error || "");
  if (!text) return true;
  return (
    /desktop app/i.test(text) ||
    /no index\.cjs/i.test(text) ||
    /does not export plan/i.test(text) ||
    /Agent not found/i.test(text)
  );
}

async function runDeclaredWorkflows(
  agent: AgentRecord,
  prompt: string,
  previous: AgentRun[],
): Promise<{ id: string; ok: boolean; error?: string; value: unknown }[]> {
  const ids = agent.workflows.filter(Boolean);
  if (!ids.length) return [];
  const chained =
    previous.length > 0
      ? `${prompt}\n\nPrevious agent output:\n${String((previous[previous.length - 1] as AgentRun).detail)}`
      : prompt;
  const runFlow = invokeHost.runWorkflow ?? runWorkflowPack;
  const outputs: { id: string; ok: boolean; error?: string; value: unknown }[] = [];
  for (const workflowId of ids) {
    const result = await runFlow(workflowId, {
      dryRun: true,
      prompt: chained,
    });
    const ok = Boolean(result?.ok);
    outputs.push({
      id: workflowId,
      ok,
      value: ok ? result.steps : null,
      ...(ok ? {} : { error: String(result?.error || `workflow ${workflowId} failed`) }),
    });
  }
  return outputs;
}

async function invokeOne(
  agent: AgentRecord,
  prompt: string,
  previous: AgentRun[],
): Promise<AgentRun> {
  turnMark("agent", "invoke");
  const started = Date.now();
  const fail = (detail: string, value: unknown = null): AgentRun => {
    const ms = Date.now() - started;
    turnDone("agent", "invoke", "failed");
    recordOutcome(agent, false, ms, detail);
    return { id: agent.id, name: agent.name, ok: false, detail, value };
  };
  try {
    const input: Record<string, unknown> = {
      prompt,
      previous: previous.map((run) => ({ id: run.id, ok: run.ok, value: run.value })),
    };
    const planFn = invokeHost.plan ?? planAgent;
    const runFn = invokeHost.run ?? runAgent;
    const planned = await planFn(agent.id, input);
    if (planned.ok) {
      const ran = await runFn(agent.id, { ...input, plan: planned.value, dryRun: true });
      const flowRuns = await runDeclaredWorkflows(agent, prompt, previous);
      const ok = Boolean(ran.ok) && flowRuns.every((item) => item.ok);
      const ms = Date.now() - started;
      const detail = ok
        ? flowRuns.length
          ? `planned then dry-ran in ${ms}ms, then ${flowRuns.length} workflow(s)`
          : `planned then dry-ran in ${ms}ms`
        : String(ran.error || flowRuns.find((item) => !item.ok)?.error || "agent run failed");
      turnDone("agent", "invoke", ok ? "ok" : "failed");
      recordOutcome(agent, ok, ms, detail);
      return {
        id: agent.id,
        name: agent.name,
        ok,
        detail,
        value: {
          role: agent.role,
          plan: planned.value,
          run: ran.ok ? ran.value : null,
          workflows: flowRuns,
        },
      };
    }
    if (!missingRunnable(planned.error)) {
      return fail(String(planned.error ?? "agent plan failed"));
    }

    const listFn = invokeHost.listSkills ?? listSkills;
    const skillFn = invokeHost.invokeSkill ?? invokeSkill;
    const installed = new Set((await listFn()).map((skill) => skill.id));
    const skillIds = agent.skills.filter((id) => installed.has(id));
    const outputs: { id: string; ok: boolean; value: unknown; error?: string }[] = [];
    for (const skillId of skillIds) {
      const result = await skillFn(skillId, {
        prompt,
        agent: agent.id,
        previous: previous.map((run) => ({ id: run.id, ok: run.ok, value: run.value })),
      });
      const ok = Boolean(result?.ok);
      outputs.push({
        id: skillId,
        ok,
        value: ok ? (result as { value?: unknown }).value : null,
        ...(ok ? {} : { error: String((result as { error?: string })?.error ?? "skill failed") }),
      });
    }
    const flowRuns = await runDeclaredWorkflows(agent, prompt, previous);
    const ms = Date.now() - started;
    if (!outputs.length && !flowRuns.length) {
      return fail(
        `selected ${agent.name} (${ms}ms) — no plan()/run() and no installed skills or workflows to invoke`,
        { role: agent.role, skills: agent.skills, workflows: agent.workflows, outputs },
      );
    }
    const ok = outputs.every((item) => item.ok) && flowRuns.every((item) => item.ok);
    const detail = ok
      ? flowRuns.length
        ? `ran ${outputs.length} skill(s) and ${flowRuns.length} workflow(s) in ${ms}ms`
        : `ran ${outputs.length} skill(s) in ${ms}ms`
      : [
          ...outputs.filter((item) => !item.ok).map((item) => item.error ?? item.id),
          ...flowRuns.filter((item) => !item.ok).map((item) => item.error ?? item.id),
        ].join("; ");
    turnDone("agent", "invoke", ok ? "ok" : "failed");
    recordOutcome(agent, ok, ms, detail);
    return {
      id: agent.id,
      name: agent.name,
      ok,
      detail,
      value: {
        role: agent.role,
        skills: agent.skills,
        outputs,
        workflows: flowRuns,
      },
    };
  } catch (error) {
    return fail(String((error as Error)?.message ?? error));
  }
}

/** Run every matching agent in sequence. Empty when nothing matched. */
export async function routeAgents(prompt: string): Promise<AgentRun[]> {
  turnMark("agent", "list");
  let agents: AgentRecord[];
  try {
    agents = listAgentsFromRegistry();
  } catch {
    turnDone("agent", "list", "failed");
    return [];
  }
  turnDone("agent", "list", `${agents.length} agent(s)`);
  const chosen = chooseAgents(prompt, agents, { limit: MAX_SEQUENCE });
  if (!chosen.length) return [];
  const runs: AgentRun[] = [];
  for (const agent of chosen) {
    runs.push(await invokeOne(agent, prompt, runs));
  }
  return runs;
}
