/**
 * FRIDAY · background-agent pass on the existing autonomous-core idle timer.
 *
 * This is not a second scheduler. AutonomousCore.cycle() calls
 * reviewEnabledAgents() on the same interval used for health / project /
 * research. Enabled agents are planned (inspect only). Actionable plans are
 * filed through the existing governance queue. Mutating run() is only the
 * apply() after the owner approves a kind:"system" item (always-ask).
 */
import { governance, type GovAction, type GovItem } from "./governance";
import { ledger } from "./task-ledger";
import { personalDesk } from "../personal-desk";
import { listCapabilities } from "../capability-trees";
import { planAgent, runAgent } from "../agent-runtime";
import {
  acceptArtifact,
  acceptRouteDecision,
  agentManifest,
  authorityFromConnection,
  capabilityMayRun,
  childStaysInsideParent,
  completeHandoff,
  mustSerialize,
  policyRootAllows,
  routeCapability,
} from "./run-receipt";
import { projectWorkspaces } from "../project-workspace-engine";

export type ScheduledAgent = {
  id: string;
  name: string;
  category: string;
  risk: "safe" | "write" | "exec";
  enabled: boolean;
  approvalPrompt?: string;
};

export type AgentPlanValue = {
  ok?: boolean;
  actionable?: boolean;
  error?: string;
  folder?: string;
  reclaim?: string;
  size?: string | number;
  scanned?: number;
  candidates?: { name?: string; path?: string }[];
  count?: number;
  overdue?: unknown[];
  usedPct?: number | null;
  olderThanDays?: number | string;
  [key: string]: unknown;
};

export type AgentSchedulerHost = {
  listEnabledAgents: () => Promise<ScheduledAgent[]>;
  planAgent: (
    id: string,
    input: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    value?: AgentPlanValue;
    error?: string;
  }>;
  runAgent: (
    id: string,
    input: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }>;
  getItem: (id: string) => GovItem | undefined;
  discover: (input: Parameters<typeof governance.discover>[0]) => GovItem;
  submit: (action: GovAction & { id?: string }) => Promise<GovItem>;
  recordPlan?: (agent: ScheduledAgent, result: unknown) => Promise<void> | void;
  inputFor?: (agent: ScheduledAgent) => Record<string, unknown>;
};

export function isPlanActionable(plan: AgentPlanValue | undefined | null): boolean {
  if (!plan || plan.ok === false) return false;
  if (plan.actionable === true) return true;
  if (plan.actionable === false) return false;
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  if (candidates.length > 0) return true;
  const overdue = Array.isArray(plan.overdue) ? plan.overdue : [];
  if (overdue.length > 0) return true;
  if (typeof plan.usedPct === "number" && plan.usedPct >= 90) return true;
  return false;
}

export function fillApprovalPrompt(template: string, plan: AgentPlanValue): string {
  const count = Array.isArray(plan.candidates)
    ? plan.candidates.length
    : Array.isArray(plan.overdue)
      ? plan.overdue.length
      : Number(plan.count ?? 0);
  return String(template || "")
    .replaceAll("{count}", String(count))
    .replaceAll("{size}", String(plan.reclaim || plan.size || ""))
    .replaceAll("{folder}", String(plan.folder || ""))
    .replaceAll("{olderThanDays}", String(plan.olderThanDays ?? ""));
}

function fingerprint(plan: AgentPlanValue): string {
  if (Array.isArray(plan.candidates) && plan.candidates.length) {
    return plan.candidates
      .map((item) => String(item.path || item.name || ""))
      .filter(Boolean)
      .sort()
      .slice(0, 12)
      .join("|");
  }
  if (Array.isArray(plan.overdue) && plan.overdue.length) {
    return plan.overdue
      .map((item) => {
        if (item && typeof item === "object" && "id" in item)
          return String((item as { id?: string }).id || "");
        return JSON.stringify(item);
      })
      .sort()
      .join("|");
  }
  try {
    return JSON.stringify({
      usedPct: plan.usedPct,
      count: plan.count,
      scanned: plan.scanned,
      folder: plan.folder,
    });
  } catch {
    return "plan";
  }
}

export function defaultInputFor(agent: ScheduledAgent): Record<string, unknown> {
  if (agent.id.endsWith("/recurring-task-nudger") || agent.id.includes("recurring-task-nudger")) {
    return { tasks: personalDesk.getSnapshot().tasks };
  }
  return {};
}

export function desktopAgentHost(): AgentSchedulerHost {
  return {
    listEnabledAgents: async () => {
      const index = await listCapabilities();
      return (index?.items ?? [])
        .filter((item) => item.tree === "agents" && item.enabled)
        .map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category,
          risk: item.risk,
          enabled: item.enabled,
          approvalPrompt: item.approvalPrompt,
        }));
    },
    planAgent: async (id, input) => {
      const result = await planAgent(id, input);
      const value =
        result.value && typeof result.value === "object"
          ? (result.value as AgentPlanValue)
          : result.ok
            ? ({ ok: true, ...(result as unknown as AgentPlanValue) } as AgentPlanValue)
            : undefined;
      return {
        ok: Boolean(result.ok),
        ...(value ? { value } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
    runAgent: (id, input) => runAgent(id, input),
    getItem: (id) => governance.get(id),
    discover: (input) => governance.discover(input),
    submit: (action) => governance.submit(action),
    recordPlan: async (agent, result) => {
      const { promise } = ledger.run(
        { kind: agent.id, title: `${agent.name} plan`, key: `${agent.id}:plan` },
        async () => result,
      );
      await promise;
    },
    inputFor: defaultInputFor,
  };
}

function evidenceFrom(plan: AgentPlanValue): string[] {
  const lines: string[] = [];
  if (plan.folder) lines.push(`folder:${plan.folder}`);
  if (Array.isArray(plan.candidates)) {
    for (const file of plan.candidates.slice(0, 8)) {
      lines.push(String(file.path || file.name || ""));
    }
    if (plan.candidates.length > 8) lines.push(`… ${plan.candidates.length - 8} more`);
  }
  if (typeof plan.usedPct === "number") lines.push(`usedPct:${plan.usedPct}`);
  if (typeof plan.scanned === "number") lines.push(`scanned:${plan.scanned}`);
  if (plan.reclaim) lines.push(`reclaim:${plan.reclaim}`);
  if (Array.isArray(plan.overdue)) lines.push(`overdue:${plan.overdue.length}`);
  return lines.filter(Boolean).slice(0, 12);
}

/**
 * Plan every enabled agent. File actionable write/exec work through
 * governance.submit (always-ask `system` kind). Read-only findings are
 * discovered into the same queue without an apply that mutates.
 */
function writeTargets(plan: AgentPlanValue): string[] {
  const targets: string[] = [];
  if (typeof plan.folder === "string" && plan.folder.trim()) targets.push(plan.folder.trim());
  if (Array.isArray(plan.candidates)) {
    for (const candidate of plan.candidates) {
      const path = String(candidate?.path || candidate?.name || "").trim();
      if (path) targets.push(path);
    }
  }
  return targets;
}

export async function reviewEnabledAgents(host: AgentSchedulerHost): Promise<number> {
  const agents = await host.listEnabledAgents();
  let queued = 0;
  const writesThisPass: { writes: string[] }[] = [];
  for (const agent of agents) {
    if (!agent.enabled) continue;
    const input = host.inputFor?.(agent) ?? {};
    let planned: { ok: boolean; value?: AgentPlanValue; error?: string };
    try {
      planned = await host.planAgent(agent.id, input);
    } catch (error) {
      planned = { ok: false, error: String((error as Error)?.message ?? error) };
    }
    const plan: AgentPlanValue = {
      ok: planned.ok,
      ...(planned.value && typeof planned.value === "object" ? planned.value : {}),
      ...(planned.error ? { error: planned.error } : {}),
    };
    try {
      await host.recordPlan?.(agent, plan);
    } catch {
      /* ledger is observational — a failed record must not skip the gate */
    }
    if (!isPlanActionable(plan)) continue;

    const blocked = projectWorkspaces.skipAutoPlan({
      ...(plan.folder ? { folder: plan.folder } : {}),
      ...(Array.isArray(plan.candidates) ? { candidates: plan.candidates } : {}),
    });
    if (blocked.block) continue;

    const day = new Date().toISOString().slice(0, 10);
    const id = `gov:agent:${agent.id}:${fingerprint(plan)}:${day}`;
    if (host.getItem(id)) continue;
    const writes = writeTargets(plan);
    if (agent.risk !== "safe" && writesThisPass.some((prior) => mustSerialize(prior, { writes }))) {
      continue;
    }

    const prompt = fillApprovalPrompt(agent.approvalPrompt || "", plan);
    const rationale =
      prompt ||
      `${agent.name} planned an actionable change. Review the evidence before anything is applied.`;
    const title = `Agent — ${agent.name}`;
    const evidence = evidenceFrom(plan);

    if (agent.risk !== "safe") writesThisPass.push({ writes });
    if (agent.risk === "safe") {
      host.discover({
        id,
        kind: "system",
        title,
        rationale,
        risk: "review",
        evidence,
      });
      queued += 1;
      continue;
    }
    void host
      .submit({
        id,
        kind: "system",
        title,
        rationale,
        risk: agent.risk === "exec" ? "risky" : "review",
        evidence,
        dryRun: async () => ({
          ok: plan.ok !== false,
          detail:
            prompt || `${Array.isArray(plan.candidates) ? plan.candidates.length : 0} candidate(s)`,
        }),
        apply: async () => {
          const parent = agentManifest(agent);
          const childCapabilities = Array.isArray(plan["capabilities"])
            ? plan["capabilities"].map((item) => String(item))
            : parent.capabilities;
          const bound = childStaysInsideParent(
            { capabilities: parent.capabilities, network: parent.network, spend: parent.budget },
            {
              capabilities: childCapabilities,
              network: plan["network"] === true,
              spend: typeof plan["spend"] === "number" ? plan["spend"] : 0,
            },
          );
          if (!bound.ok) return { ok: false, detail: bound.reason };
          const runnable = capabilityMayRun(
            "available",
            authorityFromConnection(plan["peer"] === true, agent.enabled),
            true,
          );
          if (!runnable.ok) return { ok: false, detail: runnable.reason };
          const route = acceptRouteDecision({
            routeId: agent.id,
            taskId: id,
            selected: [{ kind: "agent", id: agent.id }],
            alternatives: Array.isArray(plan["alternatives"])
              ? plan["alternatives"].map((item) => String(item))
              : [],
            policyVersion: "1",
            confidence: 1,
            rationale: rationale.slice(0, 180),
          });
          if (!route.ok) return { ok: false, detail: route.reason };
          const policy = policyRootAllows({
            privileged: true,
            policyVersion: "1",
            selfChange: plan["selfChange"] === true,
            sandboxed: plan["sandboxed"] === true,
          });
          if (!policy.ok) return { ok: false, detail: policy.reason };
          const routed = routeCapability(plan["phase"] === "retired" ? "retired" : "available");
          if (!routed.ok) return { ok: false, detail: routed.reason };
          const rawArtifact = plan["artifact"];
          if (rawArtifact && typeof rawArtifact === "object") {
            const artifact = acceptArtifact(rawArtifact as Record<string, unknown>);
            if (!artifact.ok) return { ok: false, detail: artifact.reason };
          }
          const result = await host.runAgent(agent.id, { ...input, dryRun: false, approved: true });
          const packet = completeHandoff({
            result: result.ok ? "agent run applied after owner approval" : "failed",
            evidence: result.ok ? "owner-approved run" : "",
            confidence: result.ok ? 1 : 0,
            unresolved: result.ok ? [] : [result.error || "agent run failed"],
            artifacts: [],
            checked: result.ok,
          });
          if (!result.ok || packet.verification !== "passed") {
            return { ok: false, detail: packet.unresolved[0] || "agent run failed" };
          }
          return { ok: true, detail: packet.result };
        },
      })
      .catch(() => undefined);
    queued += 1;
  }
  return queued;
}
