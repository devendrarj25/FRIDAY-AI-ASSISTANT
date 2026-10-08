import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { memory, resolveKnowledgeClash } from "../../src/lib/friday/self/memory-engine";
import {
  acceptActionReceipt,
  acceptCapabilityRecord,
  acceptEvidenceRecord,
  acceptObservation,
  acceptProviderRecord,
  acceptRequest,
  acceptRunRecord,
  acceptRuntimeEvent,
  acceptTaskRecord,
  acceptVerification,
  argumentHash,
  backendInvariants,
  bindApproval,
  capabilityMayRun,
  childStaysInsideParent,
  consumeApproval,
  durableOutcome,
  resetRuntimeEvents,
  revalidateApproval,
  scoreEvaluation,
  agentManifest,
  authorityFromConnection,
  completeHandoff,
  mustSerialize,
  observationCurrent,
  retrievalTier,
  sealRuntimeEvent,
  traceSpan,
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
    expect(graph).toContain("acceptRequest(");
    expect(graph).toContain("backendInvariants(");
    const memorySource = fs.readFileSync(
      path.join(ROOT, "src/lib/friday/self/memory-engine.ts"),
      "utf8",
    );
    expect(memorySource).toContain("secretStaysOutOfMemory(");
    const database = fs.readFileSync(path.join(ROOT, "kernel/db.py"), "utf8");
    expect(database).toContain('self.set_setting("schema_version", SCHEMA_VERSION)');
    expect(database).toContain("idempotency_key");
    const flow = fs.readFileSync(path.join(ROOT, "src/lib/friday/flow-chart.ts"), "utf8");
    for (let order = 1; order <= 17; order += 1) expect(flow).toContain(`order: ${order},`);
    const version = JSON.parse(
      fs.readFileSync(path.join(ROOT, "config/friday-version.json"), "utf8"),
    ) as { major: number; minor: number; patch: number; revision: number };
    expect([version.major, version.minor, version.patch, version.revision]).toEqual([1, 0, 1, 2]);
    const control = fs.readFileSync(path.join(ROOT, "docs/FRIDAY_CHANGE_CONTROL.md"), "utf8");
    expect(control).toContain("src/lib/friday/flow-chart.ts");
    expect(control).toContain("kernel/planner.py");
    expect(control).toContain("exact, then high, then medium, then a broad search");
    expect(
      fs.existsSync(path.join(ROOT, "FRIDAY-DEVELOPMENT & VISION/DOCUMENT-MANIFEST.json")),
    ).toBe(false);
  });

  it("accepts the backend records and refuses a broken one", () => {
    const at = "2023-11-14T22:13:20.000Z";
    const request = acceptRequest({
      request_id: "req_1",
      session_id: "local",
      channel: "chat",
      input: "note the meeting",
      received_at: at,
      policy_context_id: "balanced",
    });
    expect(request.ok).toBe(true);
    expect(
      acceptRequest({
        request_id: "req_1",
        session_id: "local",
        channel: "chat",
        input: "  ",
        received_at: at,
        policy_context_id: "balanced",
      }).ok,
    ).toBe(false);
    expect(
      acceptTaskRecord({
        task_id: "task_1",
        request_id: "req_1",
        goal: "note the meeting",
        status: "running",
        parent_task_id: "",
        dependencies: [],
        created_at: at,
        updated_at: at,
        retry_budget: 2,
        side_effect: true,
        idempotency_key: "note-1",
        async: true,
        cancellable: true,
      }).ok,
    ).toBe(true);
    expect(
      acceptTaskRecord({
        task_id: "task_1",
        request_id: "req_1",
        goal: "note the meeting",
        status: "running",
        dependencies: [],
        created_at: at,
        updated_at: at,
        retry_budget: 2,
        side_effect: true,
        idempotency_key: "note-1",
        async: true,
        cancellable: false,
      }).reason,
    ).toMatch(/cancellation/);
    expect(
      acceptRunRecord({
        run_id: "run_1",
        task_id: "task_1",
        run_type: "tool",
        status: "running",
        started_at: at,
        worker_id: "desktop",
      }).ok,
    ).toBe(true);
    expect(
      acceptCapabilityRecord({
        capability_id: "files",
        version: "1",
        kind: "tool",
        owner_registry: "tools",
        risk: "low",
        authority: "scoped",
        privacy: { network: false, data_classes: ["internal"] },
        verification: { required: true, strategy: "postcondition" },
      }).ok,
    ).toBe(true);
    expect(
      acceptProviderRecord({
        provider_id: "local",
        model_id: "local",
        capabilities: ["text"],
        availability: "healthy",
        privacy_profile: "local",
      }).ok,
    ).toBe(true);
    expect(acceptProviderRecord({ provider_id: "", model_id: "" }).reason).toMatch(/provider/);
    expect(
      acceptActionReceipt({
        action_id: "act_1",
        task_id: "task_1",
        capability_id: "files",
        arguments_hash: "abcd1234",
        result: "success",
        external_effect: "unknown",
        started_at: at,
        side_effect: true,
      }).reason,
    ).toMatch(/idempotency/);
    expect(
      acceptObservation({
        observation_id: "obs_1",
        source: "tool",
        captured_at: at,
        fresh_until: at,
        confidence: 0.9,
        content_ref: "local:obs_1",
        sensitivity: "internal",
      }).ok,
    ).toBe(true);
    expect(
      acceptObservation({
        observation_id: "obs_1",
        source: "tool",
        content_ref: "local:obs_1",
        sensitivity: "internal",
        confidence: 0.9,
      }).reason,
    ).toMatch(/freshness/);
    expect(
      acceptVerification({
        verification_id: "ver_1",
        action_id: "act_1",
        strategy: "postcondition",
        status: "passed",
        verified_at: at,
      }).ok,
    ).toBe(true);
    expect(
      acceptEvidenceRecord({
        evidence_id: "ev_1",
        kind: "verification",
        source_ref: "ver_1",
        captured_at: at,
        content_hash: "abcd",
        sensitivity: "secret",
      }).reason,
    ).toMatch(/secret/);
    const broken = backendInvariants({
      taskStatus: "succeeded",
      verificationRequired: true,
      verificationPassed: false,
      approval: "expired",
      scopeMatches: false,
      toolSaidSuccess: true,
      externalEffect: "unknown",
      observationFreshUntil: "2020-01-01T00:00:00.000Z",
      nowIso: at,
      sensitivity: "secret",
      promotedToMemory: true,
      sideEffect: true,
      idempotencyKey: "",
      cancellable: false,
      providerId: "",
      modelId: "",
      externalFact: true,
      provenance: "",
    });
    expect(broken.ok).toBe(false);
    expect(broken.failed).toContain("succeeded without verification");
    expect(broken.failed).toContain("tool success is not proof");
    expect(broken.failed).toContain("secret entered memory");
    const marker = "schema-probe";
    memory.remember({
      tier: "working",
      title: marker,
      text: "visible fact",
      sensitivity: "public",
    });
    memory.remember({
      tier: "working",
      title: marker,
      text: "api_key=hidden",
      sensitivity: "secret",
    });
    const rows = memory.getSnapshot().items.filter((item) => item.title === marker);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("visible fact");
  });

  it("returns a checked handoff, serializes shared writes, and ignores a bare connection", () => {
    const packet = completeHandoff({
      result: "applied",
      evidence: "file removed",
      confidence: 0.9,
      unresolved: [],
      artifacts: ["notes.txt"],
      checked: true,
    });
    expect(packet.verification).toBe("passed");
    expect(
      completeHandoff({
        result: "done",
        evidence: "",
        confidence: 1,
        unresolved: [],
        artifacts: [],
        checked: true,
      }).verification,
    ).toBe("unchecked");
    expect(mustSerialize({ writes: ["C:/notes"] }, { writes: ["C:/notes"] })).toBe(true);
    expect(mustSerialize({ writes: ["C:/notes"] }, { writes: ["C:/other"] })).toBe(false);
    expect(authorityFromConnection(true, false)).toBe(false);
    expect(authorityFromConnection(true, true)).toBe(true);
    expect(agentManifest({ id: "files", risk: "exec" }).network).toBe(false);
    expect(agentManifest({ id: "files", risk: "exec" }).authority).toBe("scoped");
    expect(observationCurrent(true)).toBe(false);
    expect(observationCurrent(false, 1000)).toBe(true);
    expect(observationCurrent(false, 9000)).toBe(false);
    expect(retrievalTier("task")).toBeLessThan(retrievalTier("external"));
    expect(traceSpan("task.verifying")).toBe("verification");
    resetRuntimeEvents();
    const sealed = sealRuntimeEvent({
      eventType: "task.succeeded",
      now: NOW,
      requestId: "req_span",
      sessionId: "local",
      taskId: "task_span",
      runId: "run_span",
      producer: "task-graph",
    });
    expect(sealed.payload["span"]).toBe("task");
    const versions = JSON.parse(
      fs.readFileSync(path.join(ROOT, "config/toolchain-versions.json"), "utf8"),
    ) as { nodeMinimum: string; pythonMinimum: string };
    expect(versions.nodeMinimum).toBe("22.19.0");
    expect(versions.pythonMinimum).toBe("3.12.10");
    const scheduler = fs.readFileSync(
      path.join(ROOT, "src/lib/friday/self/agent-scheduler.ts"),
      "utf8",
    );
    expect(scheduler).toContain("completeHandoff(");
    expect(scheduler).toContain("mustSerialize(");
    const planner = fs.readFileSync(path.join(ROOT, "kernel/planner.py"), "utf8");
    expect(planner).toContain("shortlist(");
    const control = fs.readFileSync(path.join(ROOT, "docs/FRIDAY_CHANGE_CONTROL.md"), "utf8");
    expect(control).toContain("SOURCE_READY");
    expect(control).toContain("BUILD_READY");
  });
});
