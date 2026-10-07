import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlaybook, normalizeWorkflowSteps } from "../../src/lib/friday/brain/workflow-forge";

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
});
