/**
 * Intelligence/Brain audit: per-stage timing, de-dupe, gold check,
 * governance/overclaim, Auto Mode + companion handshake (source).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { recentStageOutcomes, resetStageOutcomes } from "../../src/lib/friday/brain/turn-timing";
import { installCognitiveBaseline } from "../../src/lib/friday/brain/cognitive-baseline";
import { currentPolicy, allowedModelIds } from "../../src/lib/friday/brain/cost-policy";
import { reasonAbout } from "../../src/lib/friday/brain/reasoning";
import { runIntelligenceBenchmark } from "../../src/lib/friday/self/intelligence-benchmark";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const WATCHDOG_MS = 140_000;
const TOOL_TIMEOUT_MS = 8_000;
const TOOL_BUDGET_MS = 20_000;

const LIGHT = "write a haiku about rain";
const DEEP = "how is FRIDAY related to Devendra and why would the kernel fail";

function cognizeStages() {
  return recentStageOutcomes(80).filter((row) => row.runId === "cognize" || row.runId === "verify");
}

describe("Part A — per-stage cognition timing", () => {
  it("records distinct stages for a light prompt and stays inside existing budgets", async () => {
    resetStageOutcomes();
    const t0 = Date.now();
    const cognition = await coreBrain.cognize(LIGHT, { mode: "manual", allowTools: false });
    const wall = Date.now() - t0;
    const notes = cognition.notes.join(" ");
    expect(notes).toMatch(/fabric: light/);
    expect(notes).not.toMatch(/world state:/);
    expect(notes).not.toMatch(/^reasoning:/m);
    const stages = cognizeStages();
    const names = stages.map((row) => row.stage);
    expect(names).toEqual(
      expect.arrayContaining(["vector-index", "knowledge-recall", "knowledge-graph"]),
    );
    expect(names).not.toContain("world-insight");
    expect(names).not.toContain("meta-review");
    expect(names).not.toContain("reason");
    for (const row of stages) {
      expect(row.ms, `${row.stage} ${row.ms}ms`).toBeLessThan(TOOL_TIMEOUT_MS);
    }
    expect(wall).toBeLessThan(TOOL_BUDGET_MS);
    expect(wall).toBeLessThan(WATCHDOG_MS);
  });

  it("records world / meta / reason on a deep prompt and stays inside existing budgets", async () => {
    resetStageOutcomes();
    const t0 = Date.now();
    const cognition = await coreBrain.cognize(DEEP, { mode: "manual", allowTools: false });
    const wall = Date.now() - t0;
    const notes = cognition.notes.join(" ");
    expect(notes).toMatch(/fabric: deep/);
    expect(notes).toMatch(/world state:/);
    expect(notes).toMatch(/meta:/);
    expect(cognition.reasoning?.publicNote ?? "").toMatch(/^reasoning:/);
    const stages = cognizeStages();
    const names = stages.map((row) => row.stage);
    expect(names).toEqual(
      expect.arrayContaining([
        "world-insight",
        "meta-review",
        "vector-index",
        "knowledge-recall",
        "knowledge-graph",
        "reason",
      ]),
    );
    for (const row of stages) {
      expect(row.ms, `${row.stage} ${row.ms}ms`).toBeLessThan(TOOL_TIMEOUT_MS);
    }
    expect(wall).toBeLessThan(TOOL_BUDGET_MS);
    expect(wall).toBeLessThan(WATCHDOG_MS);
  });
});

describe("Part B — de-duplication", () => {
  it("does not double-flag an unmentioned tool failure when evaluateAnswer ran", async () => {
    const cognition = await coreBrain.cognize("delete the temp folder on this machine", {
      mode: "manual",
      allowTools: false,
    });
    cognition.tools.push({ tool: "tool", query: "files.delete", ok: false, detail: "denied" });
    const verification = coreBrain.verify(cognition, "The weather is lovely today.", true);
    const toolIssues = verification.issues.filter((issue) =>
      /tool failed|execution failed/i.test(issue),
    );
    expect(toolIssues.length).toBeLessThanOrEqual(1);
  });

  it("does not let installCognitiveBaseline shadow cost policy or allowed models", () => {
    const beforePolicy = currentPolicy();
    const beforeAllowed = allowedModelIds(["local:llama", "openai:gpt-4o"]);
    installCognitiveBaseline();
    expect(currentPolicy()).toBe(beforePolicy);
    expect(allowedModelIds(["local:llama", "openai:gpt-4o"])).toEqual(beforeAllowed);
  });
});

describe("Part C — governance and overclaim", () => {
  it("keeps specialists analytical: no tool.exec / governance.submit in the new files", () => {
    const files = [
      "src/lib/friday/brain/world-model.ts",
      "src/lib/friday/brain/meta-reasoner.ts",
      "src/lib/friday/brain/reasoning.ts",
      "src/lib/friday/brain/knowledge-graph.ts",
      "src/lib/friday/brain/cognitive-baseline.ts",
    ];
    for (const rel of files) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/governance\.submit/);
      expect(src, rel).not.toMatch(/tool\.exec/);
      expect(src, rel).not.toMatch(/invokeSkill/);
    }
    expect(read("src/lib/friday/brain/reasoning.ts")).toContain(
      "reasoning does not execute actions — planning and governance stay in their modules",
    );
  });

  it("does not invent a browser capability in public reasoning notes", () => {
    const note = reasonAbout({
      prompt: "how is FRIDAY related to Devendra",
      evidence: "- FRIDAY is owned by Devendra Singh Meena",
    }).publicNote;
    expect(note).toMatch(/^reasoning:/);
    expect(note).not.toMatch(/I can browse|browser tool|search the web for you/i);
  });
});

describe("Part D — benchmark gold answer", () => {
  it("anchors the score with a fixed owner-identity check", () => {
    const report = runIntelligenceBenchmark();
    expect(report.scoreKind).toBe("directional-plus-gold");
    const gold = report.checks.find((check) => check.id === "owner-identity-gold");
    expect(gold).toBeDefined();
    expect(gold?.ok).toBe(true);
    expect(gold?.detail).toMatch(/Devendra Singh Meena/);
  });
});

describe("Part E — Auto Mode and companion share Core Brain", () => {
  it("runs the deep fabric when cognize is called with Auto Mode", async () => {
    const cognition = await coreBrain.cognize(DEEP, { mode: "auto", allowTools: false });
    expect(cognition.mode).toBe("auto");
    expect(cognition.notes.join(" ")).toMatch(/fabric: deep/);
    expect(cognition.notes.join(" ")).toMatch(/world state:/);
  });

  it("wires phone turns through desktop ask() when a desktop client is connected", () => {
    const kernel = read("kernel/main.py");
    const engine = read("src/lib/friday/brain-engine.ts");
    const companion = kernel.slice(
      kernel.indexOf("async def companion_chat"),
      kernel.indexOf("async def companion_speak"),
    );
    expect(companion).toContain("companion.cognize");
    expect(companion).toContain("DESKTOP_CLIENTS");
    expect(companion).toContain("kernel_stream");
    expect(engine).toContain("onCompanionCognize");
    expect(engine).toContain("askFromPhone");
    expect(engine).toContain("this.send(prompt");
    expect(engine).toMatch(/mode:\s*this\.autoMode \? "auto" : "manual"/);
  });
});
