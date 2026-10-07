/**
 * Skill-forge uses the same PipelineStep.reused guard the orchestrator
 * already proves: an equivalent coder result is not sent to a model again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeCode } from "../../src/lib/friday/brain/skill-forge";
import { planPipeline } from "../../src/lib/friday/brain/orchestrator";
import kernelApi from "../../src/lib/friday/kernel-api";
import { experiences, ledger, rememberSubTask } from "../../src/lib/friday/self/task-ledger";

const GOAL = "write a skill that returns the workspace file count";
const CODE = "async function run() {\n  return { ok: true, files: 3 };\n}";

describe("skill-forge reuses a known coder step", () => {
  beforeEach(() => {
    experiences.clear();
    ledger.clearHistory();
  });

  it("skips chat.complete when planPipeline marked the coder step reused", async () => {
    rememberSubTask({
      taskId: "forge-1",
      role: "coder",
      prompt: GOAL,
      result: CODE,
      modelId: "llama-local",
    });
    const spy = vi.spyOn(kernelApi.chat, "complete").mockResolvedValue({
      ok: true,
      text: "should not be asked",
    });
    const pipeline = planPipeline({ prompt: GOAL, needsCode: true, taskId: "forge-1" });
    expect(pipeline.steps.find((step) => step.role === "coder")?.reused).toBe(true);
    const written = await writeCode(GOAL, pipeline);
    expect(written.generated).toBe(true);
    expect(written.code).toContain("function run");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
