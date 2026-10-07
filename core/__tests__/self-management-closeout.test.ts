/**
 * Self-Management closeout: live diagnosis, waiting approvals first,
 * restorable backups on applied runs, existing Button controls.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { approvalFirst } from "../../src/lib/friday/self/self-section";
import { self } from "../../src/lib/friday/self/self-manager";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Self-Management page wiring", () => {
  const page = read("src/routes/self-management.tsx");
  const panels = read("src/components/friday/SelfAutonomyPanels.tsx");
  const pipeline = read("src/lib/friday/self/dev-pipeline.ts");
  const helper = read("src/lib/friday/self/self-section.ts");
  const manager = read("src/lib/friday/self/self-manager.ts");

  it("Diagnose writes through doctor + inspectSelfComplete and pulses live", () => {
    expect(page).toContain("diagnoseNow");
    expect(page).toContain("self.pulse()");
    expect(page).toContain("systemMap.refresh()");
    expect(page).toContain("Open Doctor");
    expect(page).toContain("Copy report");
    expect(page).toContain("Cancel all");
    expect(page).toContain("Last diagnosis");
    expect(page).toContain("currentDiagnosis()");
    expect(page).toContain("Open Tasks");
    expect(page).toContain("Dismiss all");
    expect(page).toContain("taskGraph.interrupt");
    expect(helper).toContain("inspectSelfComplete");
    expect(helper).toContain("doctor.scan");
  });

  it("governance lists waiting-approval first and maintenance can rollback", () => {
    expect(panels).toContain("approvalFirst");
    expect(panels).toContain("selfVerify");
    expect(panels).toContain("self.undoLastApply");
    expect(panels).toContain("Rollback last");
    expect(panels).toContain("Verify workspace");
    expect(panels).toContain("Copy waiting");
    expect(pipeline).toContain("async rollback(");
    expect(pipeline).toContain("result.backup");
    expect(pipeline).toContain("self.rememberApplyBackup");
    expect(page).toContain("devPipeline.rollback");
    expect(manager).toContain("rememberApplyBackup");
    expect(manager).toContain("async undoLastApply");
  });
});

describe("approvalFirst", () => {
  it("does not bury a waiting decision behind settled history", () => {
    const rows = approvalFirst([
      { stage: "completed", id: "old" },
      { stage: "waiting-approval", id: "need" },
      { stage: "failed", id: "mid" },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["need", "old", "mid"]);
  });
});

describe("last apply backup", () => {
  it("stores a backup and keeps it when desktop rollback is unavailable", async () => {
    self.clearApplyBackup();
    self.rememberApplyBackup({ dir: "/tmp/friday-backup-test", entries: ["a.ts"] });
    expect(self.getSnapshot().lastApplyBackup?.dir).toBe("/tmp/friday-backup-test");
    const undone = await self.undoLastApply();
    expect(undone.ok).toBe(false);
    expect(undone.error).toMatch(/Desktop app required/i);
    expect(self.getSnapshot().lastApplyBackup?.dir).toBe("/tmp/friday-backup-test");
    self.clearApplyBackup();
    expect(self.getSnapshot().lastApplyBackup).toBeNull();
    const empty = await self.undoLastApply();
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/No restorable backup/i);
  });
});
