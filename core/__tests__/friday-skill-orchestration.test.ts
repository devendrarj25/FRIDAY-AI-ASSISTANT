/**
 * How FRIDAY and her agents use many skills at once: several strong matches run together, a skill that answers
 * "not for this request" never reaches the answer, and an agent can own a whole shelf of skills ("category:career")
 * or all of them ("*"), with the skill router choosing the best few for each prompt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "../..");
type Out = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function manifests() {
  const out: Out[] = [];
  for (const segment of ["core", "custom"]) {
    const dir = path.join(ROOT, "skills", segment);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, "skill.json");
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      out.push({
        ...JSON.parse(fs.readFileSync(file, "utf8")),
        enabled: true,
        builtin: false,
        runs: 0,
        failures: 0,
        segment,
      });
    }
  }
  return out;
}
const ALL = manifests();
const dirOf = (id: string) => path.join(ROOT, "skills", ALL.find((m) => m.id === id)!.segment, id);
async function runSkillFile(id: string, input: Record<string, unknown>) {
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(path.join(dirOf(id), "skill.mjs")).href
  );
  return mod.run(input);
}

vi.mock("../../src/lib/friday/brain/skill-forge", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/friday/brain/skill-forge")>(
    "../../src/lib/friday/brain/skill-forge",
  );
  return {
    ...actual,
    listSkills: async () => ALL,
    invokeSkill: async (id: string, input: Record<string, unknown>) => {
      const value = await runSkillFile(id, input);
      return { ok: true, value, ms: 1 };
    },
  };
});

import { chooseSkills, routeSkills } from "../../src/lib/friday/brain/skill-router";
import {
  agentFromResource,
  pickAgentSkills,
  resetAgentIndex,
  routeAgents,
  setAgentInvokeHost,
} from "../../src/lib/friday/brain/agent-router";
import {
  capabilityRegistry,
  type CapabilityResource,
} from "../../src/lib/friday/brain/capability-registry";

const unsub: Array<() => void> = [];
afterEach(() => {
  setAgentInvokeHost(null);
  while (unsub.length) unsub.pop()?.();
  resetAgentIndex();
});

describe("several skills in one request", () => {
  it("two clearly different asks run two skills, best first, without needing the word 'then'", () => {
    const picked = chooseSkills("scan this text for secrets and what is my bmi", ALL, {
      limit: 3,
    }).map((s) => s.id);
    expect(picked).toEqual(expect.arrayContaining(["saf-content-scan", "health-calc"]));
  });

  it("one clear ask still runs exactly one skill", () => {
    expect(chooseSkills("what is my bmi", ALL, { limit: 3 }).map((s) => s.id)).toEqual([
      "health-calc",
    ]);
  });

  it("a skill that says 'not for this request' is left out of the turn, one that works stays", async () => {
    // "emi" and "bmi" both match by trigger; only the second has the numbers it needs.
    const runs = await routeSkills("emi and bmi 70 kg 175 cm");
    const ids = runs.map((r) => r.id);
    expect(ids).toContain("health-calc");
    expect(ids).not.toContain("in-finance-calc");
    expect(runs.every((r) => !r.notApplicable)).toBe(true);
  });

  it("when nothing applies the turn carries on as normal chat", async () => {
    expect(await routeSkills("use the calculator")).toEqual([]);
  });
});

describe("agents that own a shelf of skills", () => {
  const enabled = ALL;
  const installed = new Set(ALL.map((m) => m.id));

  it("a plain list runs every skill in it, a category selector lets the router choose", () => {
    expect(pickAgentSkills(["health-calc", "life-calc"], enabled, installed, "anything")).toEqual([
      "health-calc",
      "life-calc",
    ]);
    const career = pickAgentSkills(
      ["category:career"],
      enabled,
      installed,
      "write a cover letter for a data analyst role",
    );
    expect(career).toContain("car-cover-letter");
    expect(career.length).toBeLessThanOrEqual(3);
    for (const id of career) expect(ALL.find((m) => m.id === id)?.category).toBe("career");
  });

  it("'*' reaches any skill, and a prompt that fits nothing picks nothing", () => {
    const any = pickAgentSkills(
      ["*"],
      enabled,
      installed,
      "what is my bmi and write a cover letter",
    );
    expect(any).toEqual(expect.arrayContaining(["health-calc", "car-cover-letter"]));
    expect(pickAgentSkills(["*"], enabled, installed, "good morning")).toEqual([]);
  });

  it("every selector agent ships enabled, safe, and points at a category that has skills", () => {
    const dir = path.join(ROOT, "agents", "system");
    const selectorAgents = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "manifest.json")))
      .map((e) => ({
        slug: e.name,
        m: JSON.parse(fs.readFileSync(path.join(dir, e.name, "manifest.json"), "utf8")),
      }))
      .filter(({ m }) => m.skills.some((s: string) => s === "*" || s.startsWith("category:")));
    expect(selectorAgents.length).toBe(14);
    const categories = new Set(ALL.map((m) => m.category));
    for (const { slug, m } of selectorAgents) {
      expect(m.enabled, slug).toBe(true);
      expect(m.risk, slug).toBe("safe");
      expect(m.permissions, slug).toEqual([]);
      for (const s of m.skills as string[]) {
        if (s.startsWith("category:"))
          expect(categories.has(s.slice(9)), `${slug} ${s}`).toBe(true);
      }
    }
  });

  const resource = (slug: string): CapabilityResource => {
    const m = JSON.parse(
      fs.readFileSync(path.join(ROOT, "agents", "system", slug, "manifest.json"), "utf8"),
    );
    return {
      id: `agent:agents/system/${slug}`,
      type: "agent",
      name: m.name,
      ref: `agents/system/${slug}`,
      capabilities: [m.category, m.role],
      skills: m.skills,
      workflows: [],
      role: m.role,
      available: true,
      health: "ready",
      reliability: null,
      latencyMs: null,
      cost: "free",
      permission: "open",
      detail: m.description,
    };
  };
  const host = {
    plan: async () => ({ ok: false, error: "This agent has no index.cjs to run." }),
    listSkills: async () => ALL,
    invokeSkill: async (id: string, input: Record<string, unknown>) => ({
      ok: true,
      value: await runSkillFile(id, input),
      ms: 1,
    }),
  };

  it("the Career desk answers from the career skill that fits the request", async () => {
    unsub.push(capabilityRegistry.registerProvider(() => [resource("career-desk")]));
    resetAgentIndex();
    setAgentInvokeHost(host as never);
    expect(agentFromResource(resource("career-desk")).skills).toEqual(["category:career"]);
    const runs = await routeAgents(
      "use the career desk agent: write a cover letter for a data analyst role",
    );
    expect(runs[0]).toMatchObject({ ok: true });
    const outputs = (runs[0]!.value as { outputs: { id: string }[] }).outputs.map((o) => o.id);
    expect(outputs).toContain("car-cover-letter");
  });

  it("the Skill desk uses skills from different shelves for one request", async () => {
    unsub.push(capabilityRegistry.registerProvider(() => [resource("skill-desk")]));
    resetAgentIndex();
    setAgentInvokeHost(host as never);
    const runs = await routeAgents(
      "use the skill desk agent: what is my bmi 70 kg 175 cm, and scan this text for secrets: password = Zx9!kQ2#mV7pLw",
    );
    expect(runs[0]).toMatchObject({ ok: true });
    const outputs = (runs[0]!.value as { outputs: { id: string }[] }).outputs.map((o) => o.id);
    expect(outputs).toEqual(expect.arrayContaining(["health-calc", "saf-content-scan"]));
  });
});
