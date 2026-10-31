import { describe, expect, it } from "vitest";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import {
  MEASURABLE_STAGES,
  stageOff,
  withStagesOff,
} from "../../src/lib/friday/brain/stage-switches";
import { runGateSuite } from "../../src/lib/friday/self/eval-suites";
import { PROTECTED_POLICY_FILES } from "../../src/lib/friday/self/governance";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const kernelYaml = readFileSync(resolve(__dirname, "../../config/kernel.yaml"), "utf8");

describe("security release gates", () => {
  it("passes on the shipped code and config, with one gate per protected file", () => {
    const { report, gates, notChecked } = runGateSuite({ kernelYaml });
    expect(report.misses).toEqual([]);
    expect(report.passed).toBe(report.tasks);
    expect(notChecked).toEqual([]);
    expect(gates.filter((gate) => gate.id.startsWith("protected-file:"))).toHaveLength(
      PROTECTED_POLICY_FILES.length,
    );
  });

  it("fails the report when auto-approval is shipped on, and says so", () => {
    const flipped = kernelYaml.replace(/auto_approve_exec:\s*false/, "auto_approve_exec: true");
    expect(flipped).not.toBe(kernelYaml);
    const { report, gates } = runGateSuite({ kernelYaml: flipped });
    expect(report.passed).toBeLessThan(report.tasks);
    expect(gates.find((gate) => gate.id === "kernel-auto-approve-exec-false")?.ok).toBe(false);
    expect(report.misses.join(" ")).toMatch(/auto_approve_exec is true/);
  });

  it("lists a gate it could not read as not checked instead of passing it", () => {
    const { gates, notChecked } = runGateSuite();
    expect(notChecked).toEqual(["kernel-auto-approve-exec-false"]);
    expect(gates.some((gate) => gate.id === "kernel-auto-approve-exec-false")).toBe(false);
  });
});

describe("measurement switches", () => {
  it("are all on by default and are put back after a run, even after a throw", async () => {
    for (const stage of MEASURABLE_STAGES) expect(stageOff(stage)).toBe(false);
    await withStagesOff(["meta-review"], () => {
      expect(stageOff("meta-review")).toBe(true);
      expect(stageOff("world-insight")).toBe(false);
    });
    await expect(
      withStagesOff(["world-insight"], () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    for (const stage of MEASURABLE_STAGES) expect(stageOff(stage)).toBe(false);
  });

  it("change nothing about a normal turn and skip only the named stage", async () => {
    const prompt = "explain why a database index speeds up reads, step by step";
    const normal = await coreBrain.cognize(prompt, { mode: "manual", allowTools: false });
    expect(normal.notes.join(" ")).not.toMatch(/switched off for a measurement/);

    const cut = await withStagesOff(["knowledge-recall", "vector-index", "meta-review"], () =>
      coreBrain.cognize(prompt, { mode: "manual", allowTools: false }),
    );
    const notes = cut.notes.join(" ");
    expect(notes).toMatch(/knowledge: switched off for a measurement/);
    expect(cut.system).toContain("FRIDAY");
    expect(cut.tools).toHaveLength(0);

    const again = await coreBrain.cognize(prompt, { mode: "manual", allowTools: false });
    expect(again.notes.join(" ")).not.toMatch(/switched off for a measurement/);
  });
});
