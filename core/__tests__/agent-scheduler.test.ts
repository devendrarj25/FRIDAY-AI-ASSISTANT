/**
 * Background-agent scheduler: the existing autonomous-core idle cycle plans
 * enabled agents. Destructive run() does not fire without an approved plan.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { autonomousCore } from "../../src/lib/friday/self/autonomous-core";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import {
  isPlanActionable,
  reviewEnabledAgents,
  type AgentSchedulerHost,
  type ScheduledAgent,
} from "../../src/lib/friday/self/agent-scheduler";
import type { GovAction, GovItem } from "../../src/lib/friday/self/governance";

const require_ = createRequire(import.meta.url);
const cleanup = require_(
  path.resolve(__dirname, "../../agents/core/downloads-cleanup/index.cjs"),
) as {
  plan: (input?: Record<string, unknown>) => {
    ok: boolean;
    actionable?: boolean;
    candidates?: { path: string; name: string }[];
  };
  run: (input?: Record<string, unknown>) => Promise<{
    ok: boolean;
    dryRun?: boolean;
    deleted?: string[];
    error?: string;
  }>;
};

function memoryHost(opts: {
  agents: ScheduledAgent[];
  plan: AgentSchedulerHost["planAgent"];
  run?: AgentSchedulerHost["runAgent"];
}): { host: AgentSchedulerHost; submitted: (GovAction & { id?: string })[]; planned: string[] } {
  const items = new Map<string, GovItem>();
  const submitted: (GovAction & { id?: string })[] = [];
  const planned: string[] = [];
  const host: AgentSchedulerHost = {
    listEnabledAgents: async () => opts.agents,
    planAgent: async (id, input) => {
      planned.push(id);
      return opts.plan(id, input);
    },
    runAgent: opts.run ?? (async () => ({ ok: true, value: { dryRun: false } })),
    getItem: (id) => items.get(id),
    discover: (input) => {
      const item = {
        id: input.id || "gov-x",
        kind: input.kind,
        title: input.title,
        rationale: input.rationale,
        risk: input.risk,
        evidence: input.evidence ?? [],
        stage: "discovered" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        logs: [],
      };
      items.set(item.id, item);
      return item;
    },
    submit: async (action) => {
      submitted.push(action);
      const item = host.discover(action);
      items.set(item.id, { ...item, stage: "waiting-approval" });
      return items.get(item.id) as GovItem;
    },
  };
  return { host, submitted, planned };
}

describe("Agent scheduler", () => {
  afterEach(() => {
    autonomousCore.setAgentHost(null);
    autonomy.reset();
  });

  it("treats a downloads-cleanup plan with candidates as actionable", () => {
    expect(isPlanActionable({ ok: true, actionable: true, candidates: [{ name: "a" }] })).toBe(
      true,
    );
    expect(isPlanActionable({ ok: true, actionable: false, scanned: 3 })).toBe(false);
  });

  it("plans enabled downloads-cleanup on a scratch folder and does not delete without approval", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-sched-"));
    const stale = path.join(tmp, "old.bin");
    fs.writeFileSync(stale, "x");
    const past = new Date(Date.now() - 90 * 86400000);
    fs.utimesSync(stale, past, past);
    try {
      const preview = cleanup.plan({ folder: tmp, olderThanDays: 1 });
      expect(preview.ok).toBe(true);
      expect(preview.actionable).toBe(true);
      expect(preview.candidates?.some((f) => f.name === "old.bin")).toBe(true);

      const refused = await cleanup.run({
        folder: tmp,
        olderThanDays: 1,
        dryRun: false,
        approved: false,
      });
      expect(refused.dryRun).toBe(true);
      expect(refused.deleted || []).toEqual([]);
      expect(fs.existsSync(stale)).toBe(true);

      const dry = await cleanup.run({ folder: tmp, olderThanDays: 1 });
      expect(dry.dryRun).toBe(true);
      expect(fs.existsSync(stale)).toBe(true);

      const { host, submitted, planned } = memoryHost({
        agents: [
          {
            id: "agents/core/downloads-cleanup",
            name: "Downloads cleanup agent",
            category: "maintenance",
            risk: "write",
            enabled: true,
            approvalPrompt: "FRIDAY wants to DELETE {count} file(s) from “{folder}”.",
          },
        ],
        plan: async (_id, input) => ({ ok: true, value: cleanup.plan(input) }),
        run: async (_id, input) => ({ ok: true, value: await cleanup.run(input) }),
      });
      const queued = await reviewEnabledAgents({
        ...host,
        inputFor: () => ({ folder: tmp, olderThanDays: 1 }),
      });
      expect(planned).toEqual(["agents/core/downloads-cleanup"]);
      expect(queued).toBe(1);
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.kind).toBe("system");
      expect(fs.existsSync(stale)).toBe(true);

      const apply = submitted[0]?.apply;
      expect(apply).toBeTypeOf("function");
      // Apply is what governance calls after owner approval — not the scheduler itself.
      const applied = await apply!();
      expect(applied.ok).toBe(true);
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the autonomous-core idle cycle calls plan() even when autonomy is off", async () => {
    autonomy.update({ autonomyEnabled: false });
    const planned: string[] = [];
    const { host } = memoryHost({
      agents: [
        {
          id: "agents/core/process-health-snapshot",
          name: "Process health snapshot",
          category: "monitoring",
          risk: "safe",
          enabled: true,
        },
      ],
      plan: async (id) => {
        planned.push(id);
        return { ok: true, value: { ok: true, actionable: false, count: 1 } };
      },
    });
    autonomousCore.setAgentHost(host);
    const cycle = await autonomousCore.cycle();
    expect(cycle).not.toBeNull();
    expect(planned).toEqual(["agents/core/process-health-snapshot"]);
    expect(cycle?.discovered).toBe(0);
  });
});
