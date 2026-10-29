/**
 * The four skill slugs marketplace agents already list (web.search, web.read,
 * docs.extract, tender.read) must exist as real catalog packs AND as working
 * builtins that reuse electron/browser.cjs and electron/document-extract.cjs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isOnline } from "./helpers/environment";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { extractTender } from "../../src/lib/friday/owner-work-logic";
import {
  resetAgentIndex,
  setAgentInvokeHost,
  routeAgents,
} from "../../src/lib/friday/brain/agent-router";
import {
  capabilityRegistry,
  type CapabilityResource,
} from "../../src/lib/friday/brain/capability-registry";
import { packsForTree, type MarketPack } from "../../src/lib/friday/marketplace";

const ROOT = path.resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const skills = require_(path.join(ROOT, "electron/skills.cjs")) as {
  BUILTIN: { id: string; enabled?: boolean; risk: string }[];
  list: (root: string) => {
    ok: boolean;
    skills: { id: string; builtin?: boolean; enabled: boolean }[];
  };
  invoke: (
    root: string,
    id: string,
    input?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    id: string;
    value?: {
      ok?: boolean;
      text?: string;
      results?: unknown[];
      tender?: { fields?: { id: string; value: string | null }[] };
    };
    error?: string;
  }>;
};
const tenderCjs = require_(path.join(ROOT, "electron/tender-extract.cjs")) as {
  extractTender: (text: string) => {
    fields: { id: string; value: string | null }[];
    sourceChars: number;
  };
};

const TENDER = `
Tender title: Supply of LED street lamps
Issued by: Northwind Municipal Corporation
Last date: 12 October 2026
Eligibility criteria: Bidder must have GST registration and three similar works. Turnover TBD.
Scope of work: Supply and install 400 LED street lamps in Ward 4.
BOQ: 400 LED lamps, 8m poles, cabling as per schedule of rates.
Submission requirements: Upload the bid on the e-procurement portal in two covers.
Earnest money: Rs 50,000
`;

function resourceFromPack(pack: MarketPack): CapabilityResource {
  const extra = pack.manifest ?? {};
  const rawSkills = extra["skills"];
  const skillIds = Array.isArray(rawSkills) ? rawSkills.map(String) : [];
  const role = String(extra["role"] || "");
  return {
    id: `agent:${pack.tree}/${pack.segment}/${pack.slug}`,
    type: "agent",
    name: pack.name,
    ref: `${pack.tree}/${pack.segment}/${pack.slug}`,
    capabilities: [...pack.tags, pack.tree, pack.category, role, ...skillIds].filter(Boolean),
    skills: skillIds,
    workflows: [],
    role,
    available: true,
    health: "ready",
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: pack.risk === "safe" ? "open" : pack.risk === "exec" ? "owner-only" : "ask",
    detail: pack.description,
  };
}

const unsub: Array<() => void> = [];
afterEach(() => {
  setAgentInvokeHost(null);
  for (const fn of unsub.splice(0)) fn();
  capabilityRegistry.refresh();
  resetAgentIndex();
});

const ONLINE = await isOnline();

describe("missing skill slugs — catalog + builtin", () => {
  it("ships catalog packs and builtins for web.search, web.read, docs.extract, tender.read", () => {
    const ids = ["web.search", "web.read", "docs.extract", "tender.read"];
    const listed = skills.list(ROOT);
    expect(listed.ok).toBe(true);
    const byId = new Map(listed.skills.map((skill) => [skill.id, skill]));
    for (const id of ids) {
      expect(fs.existsSync(path.join(ROOT, "skills", "custom", id, "skill.json")), id).toBe(true);
      expect(fs.existsSync(path.join(ROOT, "skills", "custom", id, "skill.mjs")), id).toBe(true);
      expect(
        skills.BUILTIN.some((skill) => skill.id === id && skill.risk === "safe"),
        id,
      ).toBe(true);
      expect(byId.has(id), id).toBe(true);
    }
  });

  it("keeps the CJS tender extractor in lockstep with owner-work-logic", () => {
    const ts = extractTender(TENDER);
    const cjs = tenderCjs.extractTender(TENDER);
    expect(cjs.sourceChars).toBe(ts.sourceChars);
    expect(cjs.fields.map((field) => field.id)).toEqual(ts.fields.map((field) => field.id));
    expect(cjs.fields.find((field) => field.id === "boq")?.value).toMatch(/400 LED lamps/);
    expect(ts.fields.find((field) => field.id === "boq")?.value).toMatch(/400 LED lamps/);
  });

  it("extracts a real CSV through docs.extract and tender clauses through tender.read", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-docs-extract-"));
    const csvPath = path.join(tmp, "rows.csv");
    fs.writeFileSync(csvPath, "name,qty\nalpha,1\n", "utf8");
    const tenderPath = path.join(tmp, "nit.txt");
    fs.writeFileSync(tenderPath, TENDER, "utf8");
    try {
      const csv = await skills.invoke(ROOT, "docs.extract", {
        path: csvPath,
        filename: "rows.csv",
      });
      expect(csv.ok).toBe(true);
      expect(csv.value?.ok).not.toBe(false);
      expect(String(csv.value?.text || "")).toMatch(/alpha/);

      const fromText = await skills.invoke(ROOT, "tender.read", { text: TENDER });
      expect(fromText.ok).toBe(true);
      expect(String(fromText.value?.text || "")).toMatch(/Supply of LED street lamps/);
      expect(
        fromText.value?.tender?.fields?.find((field) => field.id === "deadline")?.value,
      ).toMatch(/12 October 2026/);
      expect(fromText.value?.tender?.fields?.find((field) => field.id === "boq")?.value).toMatch(
        /400 LED lamps/,
      );

      const fromFile = await skills.invoke(ROOT, "tender.read", {
        path: tenderPath,
        filename: "nit.txt",
      });
      expect(fromFile.ok).toBe(true);
      expect(String(fromFile.value?.text || "")).toMatch(/Northwind Municipal Corporation/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!ONLINE)(
    "accepts chat-shaped { prompt } for web.read and returns real page text",
    async () => {
      const result = await skills.invoke(ROOT, "web.read", {
        prompt: "please open https://example.com",
      });
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(String(result.value?.text || "")).toMatch(/example/i);
    },
    30_000,
  );

  it("runs web.search through the existing browser engine", async () => {
    const result = await skills.invoke(ROOT, "web.search", { prompt: "example domain", limit: 3 });
    expect(result.ok || result.value?.ok === false).toBe(true);
    if (result.ok && result.value?.ok !== false) {
      expect(Array.isArray(result.value?.results)).toBe(true);
    } else {
      expect(String(result.error || result.value)).toMatch(
        /search failed|network|fetch|ENOTFOUND|offline|abort/i,
      );
    }
  }, 30_000);

  it.skipIf(!ONLINE)(
    "lets research-agent actually invoke web.search / web.read instead of dying on missing slugs",
    async () => {
      const pack = packsForTree("agents").find((item) => item.slug === "research-agent");
      expect(pack).toBeTruthy();
      const listed = skills.list(ROOT).skills;
      unsub.push(capabilityRegistry.registerProvider(() => [resourceFromPack(pack as MarketPack)]));
      setAgentInvokeHost({
        plan: async () => ({ ok: false, error: "This agent has no index.cjs to run." }),
        listSkills: async () =>
          listed.map((skill) => ({
            id: skill.id,
            name: skill.id,
            summary: "",
            category: "web",
            capabilities: [],
            risk: "safe",
            inputs: [],
            version: 1,
            author: "friday-core",
            enabled: true,
            builtin: Boolean(skill.builtin),
            runs: 0,
            failures: 0,
          })),
        invokeSkill: async (id, input) => {
          const result = await skills.invoke(ROOT, id, (input || {}) as Record<string, unknown>);
          return {
            ok: Boolean(result.ok),
            value: result.value,
            ...(result.ok ? {} : { error: String(result.error || "skill failed") }),
          };
        },
      });
      resetAgentIndex();
      const runs = await routeAgents("use the research-agent to brief me on https://example.com");
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]!.ok).toBe(true);
      expect(runs[0]!.detail).toMatch(/ran \d+ skill/);
      const outputs =
        (runs[0]!.value as { outputs?: { id: string; ok: boolean }[] })?.outputs || [];
      expect(outputs.map((item) => item.id)).toEqual(
        expect.arrayContaining(["web.search", "web.read"]),
      );
      expect(
        outputs
          .filter((item) => item.id === "web.search" || item.id === "web.read")
          .every((item) => item.ok),
      ).toBe(true);
    },
    60_000,
  );
});
