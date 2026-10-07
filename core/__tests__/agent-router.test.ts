/**
 * Agent router: keyword index from the live capability registry, conservative
 * matching, collaboration-gated chaining, no full-catalog scan. Extra file vs
 * the prompt's list — needed to prove selection stays fast on the 39-pack
 * marketplace catalog after a real installPack.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import {
  agentFromResource,
  candidateAgents,
  chooseAgents,
  lastAgentScoredCount,
  listAgentsFromRegistry,
  resetAgentIndex,
  scoreAgent,
  setAgentInvokeHost,
  type AgentRecord,
} from "../../src/lib/friday/brain/agent-router";
import {
  capabilityRegistry,
  type CapabilityResource,
} from "../../src/lib/friday/brain/capability-registry";
import { packsForTree, type MarketPack } from "../../src/lib/friday/marketplace";
import { considerCollaboration } from "../../src/lib/friday/brain/multi-model";
import { experiences } from "../../src/lib/friday/self/task-ledger";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; error?: string };
  list: (roots: { workspaceRoot?: string }) => {
    items: {
      id: string;
      tree: string;
      name: string;
      description: string;
      category: string;
      risk: "safe" | "write" | "exec";
      enabled: boolean;
    }[];
  };
};

const temps: string[] = [];
const unsub: Array<() => void> = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-router-"));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  setAgentInvokeHost(null);
  for (const fn of unsub.splice(0)) fn();
  capabilityRegistry.refresh();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetAgentIndex();
});

const agent = (over: Partial<AgentRecord> & Pick<AgentRecord, "id" | "name">): AgentRecord => ({
  summary: over.summary ?? over.name,
  tags: over.tags ?? ["agent"],
  skills: over.skills ?? [],
  workflows: over.workflows ?? [],
  role: over.role ?? "helper",
  risk: over.risk ?? "safe",
  enabled: over.enabled ?? true,
  ...over,
});

const tender = agent({
  id: "agents/installed/tender-analysis-agent",
  name: "Tender analysis agent",
  summary: "Extracts scope, eligibility and deadlines from a tender document",
  tags: ["construction", "tenders"],
  role: "tender-analysis",
  skills: ["tender.read"],
});

const gono = agent({
  id: "agents/installed/go-no-go-agent",
  name: "Go / no-go agent",
  summary: "Scores a tender's fit and recommends bid or skip",
  tags: ["construction", "tenders"],
  role: "go-no-go",
  skills: ["data.stats"],
});

function resourceFromPack(pack: MarketPack, available = true): CapabilityResource {
  const extra = pack.manifest ?? {};
  const rawSkills = extra["skills"];
  const skills = Array.isArray(rawSkills) ? rawSkills.map(String) : [];
  const role = String(extra["role"] || "");
  return {
    id: `agent:${pack.tree}/${pack.segment}/${pack.slug}`,
    type: "agent",
    name: pack.name,
    ref: `${pack.tree}/${pack.segment}/${pack.slug}`,
    capabilities: [...pack.tags, pack.tree, pack.category, role, ...skills].filter(Boolean),
    skills,
    workflows: [],
    role,
    available,
    health: available ? "ready" : "offline",
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: pack.risk === "safe" ? "open" : pack.risk === "exec" ? "owner-only" : "ask",
    detail: pack.description,
  };
}

describe("agent router matching", () => {
  it("fires when the owner names the agent slug", () => {
    resetAgentIndex();
    expect(scoreAgent("use the tender-analysis agent on this", tender)).toBe(1);
    expect(chooseAgents("use the tender-analysis agent on this", [tender])[0]?.id).toBe(tender.id);
  });

  it("runs two named agents in sequence", () => {
    resetAgentIndex();
    const picked = chooseAgents("use the tender-analysis and go-no-go agents on this", [
      tender,
      gono,
    ]);
    expect(picked.map((item) => item.id)).toEqual([tender.id, gono.id]);
  });

  it("stays out of ordinary conversation", () => {
    resetAgentIndex();
    expect(chooseAgents("how are you today?", [tender, gono])).toEqual([]);
  });

  it("does not treat tender-agent as a hit inside tender-analysis", () => {
    resetAgentIndex();
    const short = agent({
      id: "agents/installed/tender-agent",
      name: "Tender reader agent",
      summary: "Quotes stated tender/RFP clauses and flags gaps instead of guessing.",
      tags: ["tender", "rfp"],
      role: "tender",
    });
    expect(scoreAgent("use the tender-analysis agent on this", short)).toBeLessThan(0.6);
    expect(
      chooseAgents("use the tender-analysis agent on this", [tender, short]).map((item) => item.id),
    ).toEqual([tender.id]);
  });

  it("never auto-runs disabled or write/exec agents", () => {
    resetAgentIndex();
    expect(
      chooseAgents("use the tender-analysis agent", [agent({ ...tender, enabled: false })]),
    ).toEqual([]);
    expect(
      chooseAgents("use the recon agent", [
        agent({
          id: "agents/installed/recon-agent",
          name: "Recon agent",
          risk: "exec",
        }),
      ]),
    ).toEqual([]);
    expect(
      chooseAgents("use the pentest-report agent", [
        agent({
          id: "agents/installed/pentest-report-agent",
          name: "Pentest report agent",
          risk: "write",
        }),
      ]),
    ).toEqual([]);
  });

  it("chains complementary agents only when considerCollaboration says so", () => {
    resetAgentIndex();
    const catalog = [tender, gono];
    const ordinary = chooseAgents("tender analysis of this document", catalog);
    expect(ordinary).toHaveLength(1);
    expect(
      considerCollaboration("second opinion on this tender analysis bid skip fit").warranted,
    ).toBe(true);
    const chained = chooseAgents("second opinion on this tender analysis bid skip fit", catalog);
    expect(chained.map((item) => item.id).sort()).toEqual([tender.id, gono.id].sort());
  });
});

describe("agent router index vs full catalog scan", () => {
  it("does not score every agent when the index already has a candidate hit", () => {
    resetAgentIndex();
    const noise = Array.from({ length: 120 }, (_, i) =>
      agent({
        id: `agents/installed/noise-${i}`,
        name: `Noise Pack ${i}`,
        summary: `Garden watering interval table ${i}`,
        tags: ["home"],
        role: "noise",
      }),
    );
    const catalog = [tender, ...noise];
    expect(chooseAgents("use the tender-analysis agent please", catalog)[0]?.id).toBe(tender.id);
    expect(lastAgentScoredCount()).toBeLessThan(20);
    expect(lastAgentScoredCount()).toBeGreaterThan(0);
    expect(lastAgentScoredCount()).toBeLessThan(catalog.length);
  });

  it("reads the live capability registry instead of a second list", () => {
    const packs = packsForTree("agents");
    expect(packs.length).toBe(39);
    unsub.push(
      capabilityRegistry.registerProvider(() => packs.map((pack) => resourceFromPack(pack))),
    );
    resetAgentIndex();
    const listed = listAgentsFromRegistry();
    expect(listed.length).toBeGreaterThanOrEqual(39);
    const mapped = listed.find((item) => item.id.endsWith("tender-analysis-agent"));
    expect(mapped).toBeTruthy();
    expect(mapped?.skills).toEqual(["tender.read", "docs.extract", "csv.parse", "text.summarise"]);
    expect(mapped?.role).toBe("tender-analysis");
    expect(agentFromResource(resourceFromPack(packs[0]!)).id).toContain(packs[0]!.slug);

    const picked = chooseAgents("use the tender-analysis agent on this", listed);
    expect(picked.some((item) => item.id.includes("tender-analysis-agent"))).toBe(true);
    expect(lastAgentScoredCount()).toBeLessThan(listed.length);
    expect(candidateAgents("good morning friday", listed)).toEqual([]);
  });

  it("stays near-constant after installPack of the full marketplace agent catalog", () => {
    const workspaceRoot = temp();
    const packs = packsForTree("agents");
    expect(packs.length).toBe(39);
    for (const pack of packs) {
      const result = capabilities.installPack({ workspaceRoot }, pack, "agents");
      expect(result.ok).toBe(true);
    }
    const installed = capabilities
      .list({ workspaceRoot })
      .items.filter((item) => item.tree === "agents");
    expect(installed.length).toBe(39);

    const records: AgentRecord[] = installed.map((item) => ({
      id: item.id,
      name: item.name,
      summary: item.description,
      tags: [item.category, item.tree],
      skills: [],
      workflows: [],
      role: "",
      risk: item.risk === "write" || item.risk === "exec" ? item.risk : "safe",
      enabled: true,
    }));

    resetAgentIndex();
    const t0 = performance.now();
    const first = chooseAgents("use the tender-analysis agent on this", records);
    const firstMs = performance.now() - t0;
    const firstScored = lastAgentScoredCount();

    resetAgentIndex();
    const t1 = performance.now();
    const second = chooseAgents("use the go-no-go agent on this", records);
    const secondMs = performance.now() - t1;
    const secondScored = lastAgentScoredCount();

    expect(first).toHaveLength(1);
    expect(first[0]!.id.endsWith("tender-analysis-agent")).toBe(true);
    expect(
      first.some((item) => item.id.endsWith("/tender-agent") || item.id.endsWith("tender-agent")),
    ).toBe(false);
    expect(second).toHaveLength(1);
    expect(second[0]!.id.endsWith("go-no-go-agent")).toBe(true);
    expect(firstScored).toBeLessThan(installed.length);
    expect(secondScored).toBeLessThan(installed.length);
    expect(firstScored).toBeGreaterThan(0);
    expect(secondScored).toBeGreaterThan(0);
    expect(Math.max(firstMs, secondMs)).toBeLessThan(50);

    const evidence = {
      catalog: installed.length,
      first: { ms: firstMs, scored: firstScored, picked: first.map((item) => item.id) },
      second: { ms: secondMs, scored: secondScored, picked: second.map((item) => item.id) },
      writeExecSkipped: chooseAgents(
        "use the recon agent",
        records.map((item) =>
          item.id.includes("recon-agent") ? { ...item, risk: "exec" as const } : item,
        ),
      ).filter((item) => item.id.includes("recon")),
    };
    const stash = path.join(os.tmpdir(), "friday-agent-router-evidence");
    fs.mkdirSync(stash, { recursive: true });
    fs.writeFileSync(
      path.join(stash, "agent_router_timing.json"),
      JSON.stringify(evidence, null, 2),
    );
  });
});

describe("agent router ledger", () => {
  it("records a selection through learning / the experience store", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        resourceFromPack(
          packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
        ),
      ]),
    );
    resetAgentIndex();
    const before = experiences.getSnapshot().experiences.length;
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toContain("inbox-agent");
    expect(experiences.getSnapshot().experiences.length).toBeGreaterThan(before);
    expect(experiences.getSnapshot().experiences.some((item) => item.kind === "agent-route")).toBe(
      true,
    );
  });

  it("calls plan then dry-run when the pack has a runtime", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    const calls: string[] = [];
    setAgentInvokeHost({
      plan: async (id) => {
        calls.push(`plan:${id}`);
        return { ok: true, value: { files: 2 } };
      },
      run: async (id, input) => {
        calls.push(`run:${id}:${String((input as { dryRun?: boolean } | undefined)?.dryRun)}`);
        return { ok: true, value: { dryRun: true } };
      },
    });
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        resourceFromPack(
          packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
        ),
      ]),
    );
    resetAgentIndex();
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.detail).toMatch(/planned then dry-ran/);
    expect(calls[0]).toMatch(/^plan:/);
    expect(calls[1]).toMatch(/^run:/);
  });

  it("falls back to installed skills when plan() has no index.cjs", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    setAgentInvokeHost({
      plan: async () => ({ ok: false, error: "This agent has no index.cjs to run." }),
      listSkills: async () => [
        {
          id: "memory.digest",
          name: "digest",
          summary: "",
          category: "memory",
          capabilities: [],
          risk: "safe",
          inputs: [],
          version: 1,
          author: "test",
          enabled: true,
          builtin: false,
          runs: 0,
          failures: 0,
        },
      ],
      invokeSkill: async (id) => ({ ok: true, value: { id } }),
    });
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        resourceFromPack(
          packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
        ),
      ]),
    );
    resetAgentIndex();
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.detail).toMatch(/ran 1 skill/);
  });

  it("does not claim success when nothing actually ran", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    setAgentInvokeHost({
      plan: async () => ({ ok: false, error: "This agent has no index.cjs to run." }),
      listSkills: async () => [],
    });
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        resourceFromPack(
          packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
        ),
      ]),
    );
    resetAgentIndex();
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.detail).toMatch(/no plan\(\)\/run\(\)/);
  });

  it("dry-runs declared workflows after a successful plan", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    const flows: string[] = [];
    setAgentInvokeHost({
      plan: async () => ({ ok: true, value: { files: 1 } }),
      run: async () => ({ ok: true, value: { dryRun: true } }),
      runWorkflow: async (id) => {
        flows.push(id);
        return {
          ok: true,
          id,
          name: id,
          steps: [{ id: "s1", label: "note", kind: "note", ref: "n", ok: true, detail: "ok" }],
        };
      },
    });
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        {
          ...resourceFromPack(
            packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
          ),
          workflows: ["workflows/saved/morning-briefing"],
        },
      ]),
    );
    resetAgentIndex();
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs[0]!.ok).toBe(true);
    expect(flows).toEqual(["workflows/saved/morning-briefing"]);
    expect(runs[0]!.detail).toMatch(/workflow/);
  });

  it("fails honestly when a declared workflow is missing", async () => {
    const { routeAgents } = await import("../../src/lib/friday/brain/agent-router");
    setAgentInvokeHost({
      plan: async () => ({ ok: true, value: {} }),
      run: async () => ({ ok: true, value: {} }),
      runWorkflow: async (id) => ({
        ok: false,
        id,
        name: id,
        steps: [],
        error: "That workflow is not installed.",
      }),
    });
    unsub.push(
      capabilityRegistry.registerProvider(() => [
        {
          ...resourceFromPack(
            packsForTree("agents").find((pack) => pack.slug === "inbox-agent") as MarketPack,
          ),
          workflows: ["workflows/saved/does-not-exist"],
        },
      ]),
    );
    resetAgentIndex();
    const runs = await routeAgents("use the inbox-agent please");
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.detail).toMatch(/not installed/i);
  });
});
