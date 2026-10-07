/**
 * Cross-chat continuity on the existing conversation / memory / task path —
 * not a second store or a giant prompt dump.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveContext } from "../../src/lib/friday/brain/context-engine";
import { conversationalMove, understandTurn } from "../../src/lib/friday/brain/intent-engine";
import { selectResponseStrategy } from "../../src/lib/friday/brain/decision-engine";
import {
  bindActiveGraph,
  compactSituation,
  getConversationSession,
  persistAndResetConversation,
  resetConversationSession,
  snapshotCurrentSituation,
} from "../../src/lib/friday/brain/conversation-state";
import { resetOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { learning } from "../../src/lib/friday/self/learning-engine";
import { taskGraph } from "../../src/lib/friday/self/task-graph";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelOpenGraphs(): void {
  for (const graph of taskGraph.list()) {
    if (graph.state === "queued" || graph.state === "running" || graph.state === "paused") {
      taskGraph.cancel(graph.id);
    }
  }
}

describe("conversation continuity", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
    memory.resetForTests();
    cancelOpenGraphs();
  });

  afterEach(() => {
    cancelOpenGraphs();
  });

  it("continues the same topic and a follow-up without asking what we were discussing", () => {
    const first = understandTurn({ text: "Is GST billing bug ko fix karte hain" });
    expect(first.ambiguous).toBe(false);
    const follow = understandTurn({
      text: "Ab next kya?",
      history: [
        { role: "user", text: "Is GST billing bug ko fix karte hain" },
        { role: "friday", text: "I will start with the GST calculator." },
      ],
    });
    expect(follow.ambiguous).toBe(false);
    expect(follow.resolvedGoal).toMatch(/GST|billing|next/i);
    expect(follow.conversationalMove).toBe("decision-support");
    expect(
      selectResponseStrategy({
        text: follow.literal,
        intent: follow.resolvedIntent,
        move: follow.conversationalMove,
      }).strategy,
    ).toBe("recommend-one");
  });

  it("resolves Hindi and English referents against the active task", () => {
    const history = [
      { role: "user", text: "Is GST billing bug ko fix karte hain" },
      { role: "friday", text: "Working on the GST billing bug." },
    ];
    resolveContext("Is GST billing bug ko fix karte hain", []);
    const same = resolveContext("wahi bug", history);
    expect(same.resolved).toMatch(/GST|billing/i);
    const extra = understandTurn({
      text: "Achha isme ye bhi kar do.",
      history,
    });
    expect(extra.conversationalMove).toBe("continuation");
    expect(extra.ambiguous).toBe(false);
  });

  it("treats a correction as repair, not a new topic", () => {
    understandTurn({ text: "We'll use approach B for the billing rewrite" });
    const u = understandTurn({
      text: "Nahi, woh purani baat thi. Ab aisa karna hai — approach C.",
      history: [
        { role: "user", text: "We'll use approach B for the billing rewrite" },
        { role: "friday", text: "Approach B noted." },
      ],
    });
    expect(u.conversationalMove).toBe("correction");
    expect(
      selectResponseStrategy({
        text: u.literal,
        intent: u.resolvedIntent,
        move: u.conversationalMove,
      }).strategy,
    ).toBe("acknowledge-correction");
  });

  it("pauses and resumes a bound task graph without dropping the thread", async () => {
    taskGraph.registerRunner("goal", async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
      return { result: "" };
    });
    const { id } = taskGraph.submit("fix the GST billing bug then patch the invoice export");
    bindActiveGraph(id);
    await sleep(20);
    understandTurn({ text: "Is GST billing bug ko fix karte hain" });
    const pause = understandTurn({ text: "Isko pause karo" });
    expect(pause.conversationalMove).toBe("task-pause");
    expect(taskGraph.get(id)?.state).toBe("paused");
    expect(getConversationSession().threads.some((item) => item.status === "paused")).toBe(true);
    const resume = understandTurn({ text: "jahan chhoda tha wahi se" });
    expect(resume.conversationalMove).toBe("task-resume");
    expect(["queued", "running", "paused"]).toContain(taskGraph.get(id)?.state);
    taskGraph.cancel(id);
  });

  it("retrieves a previous decision after the session is reset", () => {
    memory.remember({
      tier: "episodic",
      title: "Billing rewrite decision",
      text: "Owner decided we will use approach B for the billing rewrite.",
      source: "user",
      kind: "decision",
      verified: true,
      confidence: 0.95,
    });
    persistAndResetConversation();
    expect(getConversationSession().activeTopic).toBe("");
    const u = understandTurn({ text: "Jo decision humne liya tha uske according." });
    expect(u.conversationResolved).toMatch(/approach B/i);
    expect(u.ambiguous).toBe(false);
  });

  it("retrieves a prior project after a new chat starts", () => {
    memory.remember({
      tier: "semantic",
      title: "Project Alpha billing",
      text: "Owner is rewriting Project Alpha billing using approach B.",
      source: "user",
      kind: "project",
      verified: true,
      confidence: 0.9,
      context: "Project Alpha billing",
    });
    resetConversationSession();
    const hello = understandTurn({ text: "hello" });
    expect(getConversationSession().activeTopic).toBe("");
    expect(hello.conversationResolved).not.toMatch(/Project Alpha/i);
    const u = understandTurn({ text: "Friday, us project ko continue karo." });
    expect(u.conversationResolved).toMatch(/Alpha|billing|approach B/i);
    expect(u.ambiguous).toBe(false);
  });

  it("lets the latest explicit correction supersede older durable memory", () => {
    const older = memory.remember({
      tier: "episodic",
      title: "Billing rewrite decision",
      text: "Owner decided we will use approach B for the billing rewrite.",
      source: "user",
      kind: "decision",
      verified: true,
      confidence: 0.9,
      tags: ["decision"],
    });
    memory.remember({
      tier: "episodic",
      title: "Billing rewrite decision",
      text: "Correction: use approach C for the billing rewrite, not B.",
      source: "user",
      kind: "decision",
      verified: true,
      confidence: 1,
      tags: ["correction", "decision"],
    });
    const stored = memory.getSnapshot().items.find((item) => item.id === older.id);
    expect(stored?.supersededAt || stored?.tier === "archived").toBeTruthy();
    const hits = memory.retrieve("billing rewrite approach", 4);
    expect(hits.some((hit) => /approach C/i.test(hit.item.text))).toBe(true);
    expect(hits.every((hit) => !hit.item.supersededAt)).toBe(true);
    expect(
      hits.every((hit) => !/approach B/i.test(hit.item.text) || /not B/i.test(hit.item.text)),
    ).toBe(true);
  });

  it("does not inherit project context on an unrelated new topic", () => {
    understandTurn({ text: "Is GST billing bug ko fix karte hain" });
    const next = understandTurn({ text: "write a haiku about rain" });
    expect(next.resolvedGoal).toMatch(/haiku|rain/i);
    expect(next.resolvedGoal).not.toMatch(/GST|billing/i);
  });

  it("keeps a paused thread and restores it instead of merging", () => {
    understandTurn({ text: "Let's discuss FRIDAY development billing" });
    understandTurn({ text: "Now talk about weekend personal planning" });
    const mid = getConversationSession();
    expect(mid.threads.some((item) => item.status === "paused" && /FRIDAY/i.test(item.topic))).toBe(
      true,
    );
    const back = understandTurn({ text: "Achha, wapas Friday wale kaam par aao." });
    expect(back.conversationResolved).toMatch(/FRIDAY|billing/i);
    expect(getConversationSession().activeTopic).toMatch(/FRIDAY|billing/i);
  });

  it("keeps a standing language preference and does not promote one-time bullets", () => {
    const before = memory.getSnapshot().items.filter((item) => item.kind === "preference").length;
    learning.observeConversationalOutcome({
      prompt: "Default Hinglish mein baat karna.",
    });
    learning.observeConversationalOutcome({
      prompt: "Is answer mein bullets use karo.",
      styleCue: "brief",
    });
    const prefs = memory
      .getSnapshot()
      .items.filter((item) => item.kind === "preference" && item.source !== "first-run");
    expect(prefs.some((item) => /Hinglish/i.test(item.text))).toBe(true);
    expect(prefs.some((item) => /bullets/i.test(item.text))).toBe(false);
    expect(prefs.length).toBeGreaterThanOrEqual(before);
    resetConversationSession();
    const recalled = memory.search("Hinglish", { k: 6 });
    expect(recalled.some((item) => /Hinglish/i.test(item.text))).toBe(true);
  });

  it("shares one session and one memory fabric across turn surfaces", () => {
    understandTurn({ text: "Is GST billing bug ko fix karte hain" });
    snapshotCurrentSituation();
    const compact = compactSituation();
    expect(compact).toMatch(/GST|billing/i);
    expect(compact.length).toBeLessThan(400);
    const row = memory
      .getSnapshot()
      .items.find((item) => item.title === "Continuity — current situation");
    expect(row?.kind).toBe("project");
    persistAndResetConversation();
    expect(getConversationSession().activeTopic).toBe("");
    const again = understandTurn({ text: "us project ko continue karo" });
    expect(again.conversationResolved).toMatch(/GST|billing/i);
    expect(conversationalMove("chhodo")).toBe("task-pause");
    expect(conversationalMove("ye wala part complete ho gaya")).toBe("task-complete");
  });

  it("asks instead of inventing a project when nothing is stored", () => {
    const u = understandTurn({ text: "Friday, us project ko continue karo." });
    expect(u.ambiguous).toBe(true);
    expect(u.conversationResolved).toMatch(/which one|don't have a stored project/i);
  });
});
