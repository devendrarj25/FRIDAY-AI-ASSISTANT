import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPlaybook,
  normalizeWorkflowSteps,
  playbookMayRun,
} from "../../src/lib/friday/brain/workflow-forge";

describe("daily desk playbooks", () => {
  it("moves with an undo, never deletes, and sends only after approval", () => {
    const file = path.join(process.cwd(), "workflows/saved/daily-desk-playbooks/workflow.json");
    const pack = JSON.parse(fs.readFileSync(file, "utf8")) as { enabled: boolean; steps: unknown };
    expect(pack.enabled).toBe(false);
    const steps = normalizeWorkflowSteps(pack.steps);
    expect(steps.map((step) => step.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(checkPlaybook(steps)).toEqual({ ok: true, reasons: [] });
    expect(steps[0]?.undo).toMatch(/Move the files back/);
    expect(steps[4]?.risk).toBe("write");
    expect(steps[4]?.approvesSelf).toBeUndefined();
    const broken = checkPlaybook([
      {
        id: "bad",
        label: "Delete the downloads",
        kind: "note",
        ref: "delete",
        risk: "write",
        postcondition: "The files are gone.",
      },
    ]);
    expect(broken.ok).toBe(false);
    expect(broken.reasons).toContain("bad:delete");
  });

  it("checks every step, refuses a delete at Full, and still waits before a send", () => {
    const file = path.join(process.cwd(), "workflows/saved/daily-desk-playbooks/workflow.json");
    const pack = JSON.parse(fs.readFileSync(file, "utf8")) as { steps: unknown };
    const steps = normalizeWorkflowSteps(pack.steps);
    expect(steps.every((step) => step.postcondition && step.postcondition.length > 0)).toBe(true);
    expect(steps[0]?.postcondition).toMatch(/still exists/);
    expect(steps[1]?.postcondition).toMatch(/no file is removed/);
    expect(steps[3]?.postcondition).toMatch(/not sent/);
    expect(steps[4]?.postcondition).toMatch(/approved/);
    expect(steps[0]?.undo).toMatch(/back/);
    expect(playbookMayRun(steps[0]!, "full", false)).toBe("run");
    expect(playbookMayRun(steps[0]!, "balanced", false)).toBe("ask");
    expect(playbookMayRun(steps[1]!, "balanced", false)).toBe("run");
    expect(playbookMayRun(steps[1]!, "strict", false)).toBe("ask");
    expect(playbookMayRun(steps[3]!, "full", false)).toBe("run");
    expect(playbookMayRun(steps[4]!, "full", false)).toBe("ask");
    expect(playbookMayRun(steps[4]!, "full", true)).toBe("refuse");
    const remove = {
      id: "rm",
      label: "Remove the file",
      kind: "note" as const,
      ref: "rm",
      risk: "write" as const,
      postcondition: "The file is gone.",
    };
    expect(checkPlaybook([remove]).reasons).toContain("rm:delete");
    expect(playbookMayRun(remove, "full", false)).toBe("refuse");
    const send = {
      id: "go",
      label: "Send the draft",
      kind: "note" as const,
      ref: "send",
      risk: "write" as const,
      approvesSelf: true,
      postcondition: "It went out.",
    };
    expect(checkPlaybook([send]).reasons).toContain("go:approval");
  });
});
