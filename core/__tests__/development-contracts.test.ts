import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { resolveKnowledgeClash } from "../../src/lib/friday/self/memory-engine";
import {
  acceptRuntimeEvent,
  argumentHash,
  bindApproval,
  capabilityMayRun,
  childStaysInsideParent,
  consumeApproval,
  durableOutcome,
  resetRuntimeEvents,
  revalidateApproval,
  scoreEvaluation,
  sealRuntimeEvent,
} from "../../src/lib/friday/self/run-receipt";

const ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const docs = require(path.join(ROOT, "scripts/docs-engine.cjs")) as {
  DOCUMENTS: { file: string }[];
  UNREGISTERED_OK: RegExp[];
  markdownFiles: () => string[];
};
const scope = require(path.join(ROOT, "scripts/pr-scope.cjs")) as {
  isDocsOnly: (files: string[]) => boolean;
  isDocPath: (file: string) => boolean;
};

const NOW = 1_700_000_000_000;

describe("development contracts", () => {
  it("seals a versioned event and refuses a secret payload", () => {
    resetRuntimeEvents();
    const sealed = sealRuntimeEvent({
      eventType: "task.succeeded",
      now: NOW,
      requestId: "req_1",
      sessionId: "ses_1",
      taskId: "task_1",
      runId: "run_1",
      producer: "task-graph",
      payload: { title: "file the pack", password: "hunter2", note: "password=hunter2" },
    });
    expect(sealed.schema_version).toBe(1);
    expect(sealed.event_id).toMatch(/^evt_/);
    expect(sealed.occurred_at).toBe("2023-11-14T22:13:20.000Z");
    expect(sealed.payload["password"]).toBeUndefined();
    expect(String(sealed.payload["note"])).not.toContain("hunter2");
    const accepted = acceptRuntimeEvent({ ...sealed, trace_id: "extra" });
    expect(accepted.ok).toBe(true);
    expect(acceptRuntimeEvent({ ...sealed, payload: { api_key: "sk" } }).ok).toBe(false);
    expect(acceptRuntimeEvent({ event_type: "task.succeeded" }).ok).toBe(false);
  });

  it("does not treat a model success as a finished task", () => {
    expect(
      durableOutcome({
        modelSaidDone: true,
        observation: "the file is there",
        postconditionChecked: false,
        attempts: 1,
        maxAttempts: 2,
      }).claimed,
    ).toBe(false);
    expect(
      durableOutcome({
        modelSaidDone: true,
        observation: "",
        postconditionChecked: false,
        attempts: 2,
        maxAttempts: 2,
      }).phase,
    ).toBe("quarantined");
    const done = durableOutcome({
      modelSaidDone: true,
      observation: "the file is there",
      postconditionChecked: true,
      attempts: 1,
      maxAttempts: 2,
    });
    expect(done).toEqual({ phase: "succeeded", claimed: true });
  });

  it("binds an approval and refuses a late or changed yes", () => {
    const grant = bindApproval({
      taskId: "task_1",
      action: "click",
      args: "Save",
      target: "Save",
      dataClass: "write",
      risk: "write",
      now: NOW,
      approver: "owner",
    });
    const current = {
      action: "click",
      target: "Save",
      argumentHash: argumentHash("Save"),
    };
    expect(revalidateApproval(grant, NOW + 1000, current).ok).toBe(true);
    expect(revalidateApproval(grant, NOW + 8001, current).reason).toMatch(/Dobara poochho/);
    expect(revalidateApproval(grant, NOW, { ...current, target: "Send" }).reason).toBe(
      "target changed",
    );
    expect(
      revalidateApproval(grant, NOW, { ...current, argumentHash: argumentHash("Delete") }).reason,
    ).toBe("arguments changed");
    expect(revalidateApproval(consumeApproval(grant), NOW, current).reason).toBe("already used");
  });

  it("keeps a child inside the parent and a capability behind health and authorization", () => {
    const parent = { capabilities: ["files"], network: false, spend: 0 };
    expect(childStaysInsideParent(parent, { ...parent }).ok).toBe(true);
    expect(
      childStaysInsideParent(parent, { capabilities: ["files", "mail"], network: false, spend: 0 })
        .reason,
    ).toBe("child expanded capabilities");
    expect(
      childStaysInsideParent(parent, { capabilities: ["files"], network: true, spend: 0 }).reason,
    ).toBe("child expanded network");
    expect(capabilityMayRun("registered", false, false).reason).toBe("registration is not health");
    expect(capabilityMayRun("healthy", true, false).reason).toBe("health is not authorization");
    expect(capabilityMayRun("authorized", true, true).reason).toBe(
      "authorization is not execution",
    );
    expect(capabilityMayRun("available", true, true).ok).toBe(true);
  });

  it("scores a run without calling a provider, and keeps a knowledge clash", () => {
    const held = scoreEvaluation({
      completed: true,
      factual: false,
      toolCorrect: true,
      authorized: true,
      verified: true,
      latencyMs: 10,
      latencyBudgetMs: 100,
      tokens: 1,
      tokenBudget: 10,
      cost: 0,
      costBudget: 0,
      recovered: true,
      userHeldControl: true,
    });
    expect(held.pass).toBe(false);
    expect(held.failed).toEqual(["factual correctness"]);
    expect(
      resolveKnowledgeClash({
        clashes: true,
        explicit: false,
        protectedSource: false,
        kindAllows: true,
      }),
    ).toBe("keep-both");
    expect(
      resolveKnowledgeClash({
        clashes: true,
        explicit: true,
        protectedSource: true,
        kindAllows: true,
      }),
    ).toBe("keep-both");
    expect(
      resolveKnowledgeClash({
        clashes: true,
        explicit: true,
        protectedSource: false,
        kindAllows: true,
      }),
    ).toBe("supersede");
  });

  it("keeps the product and the docs registry valid with the working layer removed", () => {
    const registered = new Set(docs.DOCUMENTS.map((doc) => doc.file));
    expect(registered.has("docs/FRIDAY_CHANGE_CONTROL.md")).toBe(true);
    const productMarkdown = docs
      .markdownFiles()
      .filter((rel) => !rel.startsWith("FRIDAY-DEVELOPMENT & VISION/"));
    const orphans = productMarkdown.filter(
      (rel) => !registered.has(rel) && !docs.UNREGISTERED_OK.some((rule) => rule.test(rel)),
    );
    expect(orphans).toEqual([]);
    expect(scope.isDocsOnly(["docs/FRIDAY_CHANGE_CONTROL.md"])).toBe(true);
    expect(scope.isDocPath("src/lib/friday/self/run-receipt.ts")).toBe(false);
    const kernel = fs.readFileSync(path.join(ROOT, "config/kernel.yaml"), "utf8");
    expect(kernel).toMatch(/auto_approve_exec:\s*false/);
    const graph = fs.readFileSync(path.join(ROOT, "src/lib/friday/self/task-graph.ts"), "utf8");
    expect(graph).toContain("sealRuntimeEvent(");
    expect(graph).toContain("durableOutcome(");
    const desktop = fs.readFileSync(path.join(ROOT, "src/lib/friday/self/computer-use.ts"), "utf8");
    expect(desktop).toContain("revalidateApproval(");
    const scheduler = fs.readFileSync(
      path.join(ROOT, "src/lib/friday/self/agent-scheduler.ts"),
      "utf8",
    );
    expect(scheduler).toContain("childStaysInsideParent(");
  });
});
