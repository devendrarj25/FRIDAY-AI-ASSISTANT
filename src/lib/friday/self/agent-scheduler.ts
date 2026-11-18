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
  argumentHash,
  authorityFromConnection,
  capabilityLifecycleRecord,
  capabilityMayRun,
  childStaysInsideParent,
  completeHandoff,
  controlPlaneAllows,
  mustSerialize,
  policyRootAllows,
  policyRootSnapshot,
  routeCapability,
  type CapabilityLife,
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

/** The names an agent's plan lists, whichever of name or path it gives. */
function candidateNames(plan: AgentPlanValue | undefined): Set<string> {
  const out = new Set<string>();
  for (const candidate of Array.isArray(plan?.candidates) ? (plan?.candidates ?? []) : []) {
    const raw = String(candidate?.name || candidate?.path || "").trim();
    if (raw) out.add(raw.split(/[\\/]/).pop() || raw);
  }
  return out;
}

/** What an agent's own result says went wrong: items it could not do, or an error it reports. */
function reportedFailures(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(record["failed"])) {
    for (const row of record["failed"]) {
      if (row && typeof row === "object") {
        const item = row as { name?: unknown; error?: unknown };
        lines.push(`${String(item.name ?? "an item")}: ${String(item.error ?? "failed")}`);
      } else lines.push(String(row));
    }
  }
  if (typeof record["error"] === "string" && record["error"].trim()) lines.push(record["error"]);
  if (record["ok"] === false && !lines.length)
    lines.push("the agent reported that it did not succeed");
  return lines;
}

/** The names an agent's result says it removed. */
function claimedRemoved(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const removed = (value as Record<string, unknown>)["deleted"];
  return Array.isArray(removed) ? removed.map((item) => String(item)).filter(Boolean) : [];
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
    // An item already filed today is not filed again, except one the owner approved after a restart: that yes was
    // recorded on the item and is used when the same item comes round again.
    const existing = host.getItem(id);
    if (
      existing &&
      !(existing.stage === "proposed" && typeof existing.ownerApprovedAt === "number")
    )
      continue;
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

    // What the owner is shown and says yes to. The run is held to it, and what it claims is looked at again after.
    const approvedTargets = new Set(writes);
    let removedClaims: string[] = [];
    const lookAgain = async (): Promise<AgentPlanValue | null> => {
      try {
        const fresh = await host.planAgent(agent.id, input);
        return fresh.ok && fresh.value ? fresh.value : null;
      } catch {
        return null;
      }
    };

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
            {
              capabilities: parent.capabilities,
              network: parent.network,
              spend: parent.budget,
              risk: agent.risk,
            },
            {
              capabilities: childCapabilities,
              network: plan["network"] === true,
              spend: typeof plan["spend"] === "number" ? plan["spend"] : 0,
              ...(plan["risk"] === "safe" || plan["risk"] === "write" || plan["risk"] === "exec"
                ? { risk: plan["risk"] }
                : {}),
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
          const root = policyRootSnapshot();
          if (!root.ok) return { ok: false, detail: root.reason };
          const control = controlPlaneAllows({
            controlReady: root.ok,
            privileged: true,
            policyVersion: root.version,
            capabilityId: agent.id,
            capabilityVersion: "1",
            scope: "owner",
            risk: agent.risk,
            approval: "approved",
            idempotencyKey: id,
            resourceLimit: "1",
          });
          if (!control.ok) return { ok: false, detail: control.reason };
          const policy = policyRootAllows({
            privileged: true,
            policyVersion: root.version,
            citedHash: root.hash,
            selfChange: plan["selfChange"] === true,
            sandboxed: plan["sandboxed"] === true,
          });
          if (!policy.ok) return { ok: false, detail: policy.reason };
          const rawPhase = plan["phase"];
          const phase: CapabilityLife =
            rawPhase === "retired" || rawPhase === "quarantined" ? rawPhase : "active";
          const life = capabilityLifecycleRecord({
            id: agent.id,
            phase,
            version: "1",
            manifestHash: argumentHash(agent.id),
            healthEvidence: agent.enabled ? "enabled" : "",
            authority: "owner",
            retirementReason:
              phase === "retired" ? String(plan["retirementReason"] ?? "retired") : "",
          });
          if (!life.ok || !life.keepHistory) return { ok: false, detail: life.reason };
          const routed = routeCapability(plan["phase"] === "retired" ? "retired" : "available");
          if (!routed.ok) return { ok: false, detail: routed.reason };
          const rawArtifact = plan["artifact"];
          if (rawArtifact && typeof rawArtifact === "object") {
            const artifact = acceptArtifact(rawArtifact as Record<string, unknown>);
            if (!artifact.ok) return { ok: false, detail: artifact.reason };
          }
          // The yes was for the targets shown. Look once more right before acting: anything that was not in that
          // list (a file that appeared since) is not covered by it, and nothing is changed.
          if (approvedTargets.size > 0) {
            const fresh = await lookAgain();
            if (!fresh) {
              return {
                ok: false,
                detail: "could not look at the targets again before acting, so nothing was changed",
              };
            }
            const extra = writeTargets(fresh).filter((target) => !approvedTargets.has(target));
            if (extra.length) {
              return {
                ok: false,
                detail: `${extra.length} new item(s) appeared since you looked (for example ${extra[0]}); nothing was changed, ask again`,
              };
            }
          }
          const result = await host.runAgent(agent.id, { ...input, dryRun: false, approved: true });
          const failures = result.ok ? reportedFailures(result.value) : [];
          removedClaims = result.ok ? claimedRemoved(result.value) : [];
          const packet = completeHandoff({
            result: result.ok ? "agent run applied after owner approval" : "failed",
            evidence: result.ok ? "owner-approved run" : "",
            confidence: result.ok ? 1 : 0,
            unresolved: result.ok ? [] : [result.error || "agent run failed"],
            artifacts: [],
            checked: result.ok && failures.length === 0,
          });
          if (failures.length) {
            // A partial result is not a success: say what was done and what was not.
            return {
              ok: false,
              detail: `partly done: ${removedClaims.length} done, ${failures.length} failed (${failures.slice(0, 3).join("; ")})`,
            };
          }
          if (!result.ok || packet.verification !== "passed") {
            return { ok: false, detail: packet.unresolved[0] || "agent run failed" };
          }
          return { ok: true, detail: packet.result };
        },
        // The proof is an observation, not the agent's own word: look at the same place again and check that
        // what it says it removed is gone.
        verify: async () => {
          if (!removedClaims.length) {
            return { ok: true, detail: "the agent did not claim to remove anything" };
          }
          const fresh = await lookAgain();
          if (!fresh) return { ok: false, detail: "could not look again to confirm the removal" };
          const names = candidateNames(fresh);
          const still = removedClaims.filter((name) => names.has(name));
          return still.length
            ? {
                ok: false,
                detail: `${still.length} item(s) the agent said it removed are still there`,
              }
            : { ok: true, detail: `${removedClaims.length} removal(s) confirmed by looking again` };
        },
      })
      .catch(() => undefined);
    queued += 1;
  }
  return queued;
}
