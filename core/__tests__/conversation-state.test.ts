/**
 * Conversation session state: options, topic, prior-talk refs on the existing
 * memory fabric — not a second store.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolveContext } from "../../src/lib/friday/brain/context-engine";
import { understandTurn } from "../../src/lib/friday/brain/intent-engine";
import {
  getConversationSession,
  resetConversationSession,
} from "../../src/lib/friday/brain/conversation-state";
import { listOpenLoops, resetOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { currentTopic, currentSubtopics } from "../../src/lib/friday/brain/topic-state";
import { memory } from "../../src/lib/friday/self/memory-engine";

const OPTIONS_TURN = {
  role: "friday" as const,
  text: "1. Alpha plan\n2. Beta plan\n3. Gamma plan",
};

describe("conversation session state", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
    memory.resetForTests();
  });

  it("resolves turn-2 'use option 2' to the second presented option", () => {
    const history = [{ role: "user", text: "which rollout should we pick?" }, OPTIONS_TURN];
    const ctx = resolveContext("use option 2", history);
    expect(ctx.references).toContain("option");
    expect(ctx.resolved).toMatch(/Beta plan/);
    const session = getConversationSession();
    const selected = session.presentedOptions.find((item) => item.status === "selected");
    expect(selected?.text).toMatch(/Beta plan/);
    expect(session.decisions[0]?.selected).toMatch(/Beta plan/);
    expect(session.presentedOptions.filter((item) => item.status === "rejected")).toHaveLength(2);
  });

  it("resolves 'wahi jo kal discuss kiya tha' against the memory fabric", () => {
    memory.remember({
      tier: "episodic",
      title: "Yesterday tender discussion",
      text: "Owner discussed the tender bid due Friday and asked FRIDAY to draft section 3.",
      source: "conversation",
      confidence: 0.9,
      kind: "episodic",
      verified: true,
    });
    const ctx = resolveContext("wahi jo kal discuss kiya tha", [
      { role: "user", text: "let us continue the paperwork" },
      { role: "friday", text: "Ready when you are." },
    ]);
    expect(ctx.references).toContain("prior-talk");
    expect(ctx.resolved).toMatch(/tender bid due Friday/i);
  });

  it("tracks topic, subtopics and assistant questions as open loops", () => {
    resolveContext("what about GST", [
      { role: "user", text: "Prepare a report about billing" },
      { role: "friday", text: "Started the outline.\nShould I include last quarter?" },
    ]);
    expect(currentTopic()).toMatch(/billing/i);
    expect(currentSubtopics().some((item) => /GST/i.test(item))).toBe(true);
    expect(listOpenLoops().some((item) => /last quarter/i.test(item.text))).toBe(true);
  });

  it("promotes a selected option into the existing memory fabric", () => {
    resolveContext("use option 2", [
      { role: "user", text: "which rollout should we pick?" },
      OPTIONS_TURN,
    ]);
    const hits = memory.search("Beta plan", { k: 5 });
    expect(hits.some((item) => /Beta plan/.test(item.text))).toBe(true);
  });

  it("understandTurn surfaces option resolution on the shared path", () => {
    const u = understandTurn({
      text: "use option 2",
      history: [{ role: "user", text: "which rollout should we pick?" }, OPTIONS_TURN],
    });
    expect(u.context.references).toContain("option");
    expect(u.conversationResolved).toMatch(/Beta plan/);
  });
});
