import { beforeEach, describe, expect, it } from "vitest";
import {
  describeWorkflow,
  renderWorkflow,
  workflowSnapshot,
  WORKFLOW_ASK,
} from "../../src/lib/friday/brain/workflow-introspection";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  clearPendingChange,
  pendingChange,
  readSettingsIntent,
} from "../../src/lib/friday/brain/settings-intents";
import { preferences } from "../../src/lib/friday/preferences";
import { attentionWindowSeconds } from "../../src/lib/friday/attention-window";

describe("FRIDAY live workflow introspection", () => {
  it("recognises the real questions the owner asks", () => {
    expect(WORKFLOW_ASK.test("what's your current workflow")).toBe(true);
    expect(WORKFLOW_ASK.test("how do you decide which model to use")).toBe(true);
    expect(WORKFLOW_ASK.test("what happens when I send a message")).toBe(true);
    expect(WORKFLOW_ASK.test("write me a poem")).toBe(false);
  });

  it("routes the question through the shared brain, not a canned string", () => {
    const reply = baselineRespond("what is your current workflow");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("workflow");
    // The answer is produced by a live read, so the static text is empty.
    expect(reply.text).toBe("");
    expect(typeof reply.resolve).toBe("function");
  });

  it("reads the live state rather than a hardcoded description", async () => {
    const snapshot = await workflowSnapshot();
    expect(Array.isArray(snapshot.localModels)).toBe(true);
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(snapshot.voice.wakeWord).toBe(preferences.getSnapshot().voice.wakeWord);
    expect(snapshot.voice.attentionWindowSec).toBe(attentionWindowSeconds());
    expect(["free-only", "free-preferred", "allow-paid", "paid-only"]).toContain(snapshot.policy);
  });

  it("renders the answer from the snapshot it was given", () => {
    const text = renderWorkflow({
      providers: [{ id: "github", name: "GitHub", connected: true }],
      cloudModelProviders: ["Groq"],
      policy: "free-only",
      policyLine: "paid models are excluded — usage policy is free only",
      routeMode: "auto",
      pinned: [],
      localModels: [{ id: "ollama:llama3.2", label: "llama3.2", ready: true }],
      voice: {
        wakeWord: "friday",
        handsFree: false,
        attentionWindowSec: 45,
        state: "LISTENING",
        speakReplies: true,
      },
      privacyLine: "nothing has been sent off this PC yet",
      privacyTiers: { safeTools: true, workspaceWrites: false, execApproval: true },
      health: { at: 1, checks: 12, problems: 0, warnings: 1, note: "" },
    });
    expect(text).toMatch(/free only/);
    expect(text).toMatch(/llama3\.2/);
    expect(text).toMatch(/GitHub/);
    expect(text).toMatch(/wake word "friday"/);
    expect(text).toMatch(/12 items — 0 problem\(s\), 1 warning\(s\)/);
  });

  it("answers identically however it was asked (chat vs voice go one path)", async () => {
    const typed = await describeWorkflow();
    const spoken = await (baselineRespond("how do you decide which model to use").resolve?.() ??
      Promise.resolve(""));
    expect(spoken.split("\n")[0]).toBe(typed.split("\n")[0]);
    expect(spoken).toMatch(/usage policy/);
  });
});

describe("FRIDAY conversational settings changes", () => {
  beforeEach(() => clearPendingChange());

  it("confirms before applying, then applies through the real store", async () => {
    const before = attentionWindowSeconds();
    const staged = readSettingsIntent("keep listening for 90 seconds");
    expect(staged?.kind).toBe("staged");
    expect(staged?.message).toMatch(/90 seconds/);
    // Nothing has changed yet — it is only staged.
    expect(attentionWindowSeconds()).toBe(before);
    expect(pendingChange()).not.toBeNull();

    const applied = readSettingsIntent("yes");
    expect(applied?.kind).toBe("applied");
    await new Promise((r) => setTimeout(r, 0));
    expect(attentionWindowSeconds()).toBe(90);
    expect(preferences.getSnapshot().fields["attentionWindow"]).toBe("90");
    // Restore the default so the rest of the suite sees a clean store.
    preferences.setField("attentionWindow", "45");
  });

  it("can be cancelled and then leaves the setting untouched", () => {
    const before = preferences.getSnapshot().voice.wakeWord;
    expect(readSettingsIntent('change the wake word to "jarvis"')?.kind).toBe("staged");
    expect(readSettingsIntent("no")?.kind).toBe("cancelled");
    expect(preferences.getSnapshot().voice.wakeWord).toBe(before);
    expect(pendingChange()).toBeNull();
  });

  it("stages hands-free from a spoken phrase", () => {
    const staged = readSettingsIntent("switch to hands-free");
    expect(staged?.kind).toBe("staged");
    expect(staged && "change" in staged && staged.change.key).toBe("hands-free voice");
  });

  it("refuses security/permission tiers and points at the governance path", () => {
    const refused = readSettingsIntent("turn off exec approval");
    expect(refused?.kind).toBe("refused");
    expect(refused?.message).toMatch(/Settings|governance/i);
    expect(pendingChange()).toBeNull();
  });

  it("never fires on ordinary conversation", () => {
    expect(readSettingsIntent("write me a haiku about rain")).toBeNull();
    expect(readSettingsIntent("what is the time")).toBeNull();
  });

  it("is reachable from the same brain entry point chat and voice both use", () => {
    const reply = baselineRespond("switch to hands-free");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("settings");
    expect(reply.text).toMatch(/hands-free/i);
    clearPendingChange();
  });
});
