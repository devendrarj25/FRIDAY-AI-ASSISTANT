/** Idle study rides the one idle cycle: it files practice items for the owner and never applies. */
import { beforeEach, describe, expect, it } from "vitest";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { autonomousCore } from "../../src/lib/friday/self/autonomous-core";
import { governance } from "../../src/lib/friday/self/governance";
import { ledger } from "../../src/lib/friday/self/task-ledger";

const failOnce = async () => {
  await ledger
    .run({ kind: "report", title: "weekly report", key: `k-${Math.random()}` }, async () => {
      throw new Error("boom");
    })
    .promise.catch(() => undefined);
};

describe("idle study", () => {
  beforeEach(() => {
    governance.resetForTests();
    ledger.clearHistory();
    autonomy.reset();
    autonomy.update({ autonomyEnabled: true, halted: false });
  });

  it("files a practice item for a task that failed, always for the owner to approve", async () => {
    await failOnce();
    await autonomousCore.cycle();
    const item = governance.list().find((row) => row.title.startsWith("Practise:"));
    expect(item).toBeTruthy();
    expect(item?.stage).toBe("waiting-approval");
    expect(item?.stage).not.toBe("applied");
    expect(autonomousCore.appliesDirectly()).toBe(false);
  });

  it("does nothing while the kill switch is on", async () => {
    await failOnce();
    autonomy.update({ halted: true });
    await autonomousCore.cycle();
    expect(governance.list().some((row) => row.title.startsWith("Practise:"))).toBe(false);
  });
});
