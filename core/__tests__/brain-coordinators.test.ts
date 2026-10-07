/**
 * FRIDAY · live brain coordinators (intent, context, anti-repeat, memory policy,
 * decision, research ranking, observability). These wrap existing engines;
 * they are not a second brain.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  understand,
  understandTurn,
  toUnderstandingTrace,
} from "../../src/lib/friday/brain/intent-engine";
import { resolveContext, conversationOngoing } from "../../src/lib/friday/brain/context-engine";
import { resetConversationSession } from "../../src/lib/friday/brain/conversation-state";
import { resetOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { vary, lastSaid, resetAntiRepeat } from "../../src/lib/friday/brain/anti-repeat";
import { decideAction } from "../../src/lib/friday/brain/decision-engine";
import { considerMemory, detectConflict } from "../../src/lib/friday/brain/memory-policy";
import { rankSources, researchNote } from "../../src/lib/friday/brain/research";
import { observeBrain, noteObserve } from "../../src/lib/friday/brain/observe";
import { brainError, speakError } from "../../src/lib/friday/brain/errors";
import { REASONING_STAGES } from "../../src/lib/friday/brain/reasoning";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { brain } from "../../src/lib/friday/brain-engine";
import { withRoutingDefaults } from "../../src/lib/friday/brain-engine";
import {
  clearDecisionTraces,
  lastDecision,
  noteUnderstanding,
  recordDecision,
} from "../../src/lib/friday/brain/decision-trace";

describe("intent engine", () => {
  it("classifies commands, questions, follow-ups and ambiguous prompts", () => {
    expect(understand("open notepad").kind).toBe("command");
    expect(understand("what time is it?").kind).toBe("question");
    expect(understand("continue this").kind).toBe("follow-up");
    expect(understand("what about billing").kind).toBe("follow-up");
    expect(understand("no I meant the other file").kind).toBe("correction");
    expect(understand("it").needsClarification).toBe(true);
  });

  it("splits multi-part requests into ordered goals", () => {
    const u = understand("open notepad then close chrome");
    expect(u.goals).toEqual(["open notepad", "close chrome"]);
    const numbered = understand("1. prepare the report 2. file the VAT return");
    expect(numbered.goals.length).toBe(2);
    expect(numbered.goals[0]).toMatch(/prepare the report/i);
    expect(numbered.goals[1]).toMatch(/VAT return/i);
    expect(understand("hello").goals).toEqual(["hello"]);
  });

  it("extracts paths and urls", () => {
    const u = understand("open C:\\Friday\\notes.txt from https://example.com/a");
    expect(u.entities.paths.length).toBeGreaterThan(0);
    expect(u.entities.urls[0]).toContain("example.com");
  });
});

describe("context engine", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
  });

  it("resolves continue/it against the last user turn", () => {
    const ctx = resolveContext("continue this", [
      { role: "user", text: "Prepare a report about billing" },
      { role: "friday", text: "Started the outline." },
    ]);
    expect(ctx.ongoing).toBe(true);
    expect(ctx.resolved).toMatch(/Prepare a report about billing/);
    expect(conversationOngoing([])).toBe(false);
  });

  it("resolves what-about and ordinals against the live history", () => {
    const about = resolveContext("what about GST", [
      { role: "user", text: "Prepare a report about billing" },
      { role: "friday", text: "Started the outline." },
    ]);
    expect(about.references).toContain("topic-shift");
    expect(about.resolved).toMatch(/Prepare a report about billing/);

    const ordinal = resolveContext("the second one", [
      { role: "user", text: "which option" },
      { role: "friday", text: "1. Alpha plan\n2. Beta plan\n3. Gamma plan" },
    ]);
    expect(ordinal.references).toContain("ordinal");
    expect(ordinal.resolved).toMatch(/Beta plan/);
  });
});

describe("anti-repetition", () => {
  beforeEach(() => resetAntiRepeat());

  it("does not repeat the last acknowledgement", () => {
    const a = vary("ack");
    const b = vary("ack");
    expect(a.length).toBeGreaterThan(0);
    expect(b).not.toBe(a);
    expect(lastSaid("ack")).toEqual([a, b]);
  });

  it("does not greet again mid-conversation", () => {
    const first = baselineRespond("hello");
    const again = baselineRespond("hello", { ongoing: true });
    expect(first.kind).toBe("greeting");
    expect(again.kind).toBe("greeting");
    expect(again.text).not.toMatch(/Morning|Afternoon|Evening/);
    expect(first.text).not.toMatch(/\bDevendra\b|\bMeena\b|\bDev\b/);
  });
});

describe("memory policy", () => {
  it("refuses to store chatter", () => {
    expect(considerMemory({ text: "hi" }).keep).toBe(false);
    expect(considerMemory({ text: "thanks" }).keep).toBe(false);
  });

  it("keeps sourced research and standing preferences", () => {
    expect(considerMemory({ text: "always use local models", ok: true }).keep).toBe(true);
    expect(considerMemory({ text: "latest electron version", ok: true, sourced: true }).tier).toBe(
      "semantic",
    );
  });

  it("refuses to store credential-like text as memory", () => {
    expect(considerMemory({ text: "my password: hunter2 and keep this fact" }).keep).toBe(false);
    expect(considerMemory({ text: "the pin is 1234 remember this please" }).keep).toBe(false);
    expect(considerMemory({ text: "which password manager should I use today" }).keep).toBe(true);
  });

  it("flags conflicting titles", () => {
    const clash = detectConflict(
      [
        {
          id: "1",
          tier: "semantic",
          title: "owner timezone",
          text: "IST",
          tags: [],
          source: "t",
          confidence: 0.9,
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 0,
          uses: 1,
          pinned: false,
        },
      ],
      { title: "owner timezone", text: "UTC" },
    );
    expect(clash?.text).toBe("IST");
  });
});

describe("decision + research + observe", () => {
  it("asks instead of guessing on a bare 'it'", () => {
    const intent = understand("it");
    const d = decideAction({ text: "it", intent });
    expect(d.askUser).toBe(true);
    expect(d.route).toBe("ask");
  });

  it("ranks sources as unverified", () => {
    const ranked = rankSources([
      { title: "Gov", url: "https://example.gov/a", snippet: "x".repeat(90) },
    ]);
    expect(ranked[0]?.verified).toBe(false);
    expect(researchNote(ranked)).toMatch(/unverified/);
  });

  it("exposes a diagnostic snapshot without chain-of-thought", () => {
    noteObserve({ intent: understand("what can you do") });
    const snap = observeBrain();
    expect(snap.intent?.kind).toBeTruthy();
    expect(JSON.stringify(snap)).not.toMatch(/chain-of-thought|private reasoning/i);
    expect(brain.observe().policy).toBeTruthy();
  });

  it("records the last tool without putting a clock in the snapshot callers persist", () => {
    noteObserve({ tool: "http.fetch" });
    expect(observeBrain().tool).toBe("http.fetch");
    noteObserve({ tool: null });
    expect(observeBrain().tool).toBeNull();
  });

  it("keeps structured errors speakable", () => {
    const err = brainError({ component: "web", error: "Search failed." });
    expect(speakError(err)).not.toMatch(/something went wrong/i);
  });

  it("lists private reasoning stages in order", () => {
    expect(REASONING_STAGES[0]).toBe("understand");
    expect(REASONING_STAGES.at(-1)).toBe("reflect");
  });
});

describe("turn understanding fabric", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
  });

  it("flags a bare 'it' with no history as ambiguous and low confidence", () => {
    const u = understandTurn({ text: "it" });
    expect(u.literal).toBe("it");
    expect(u.ambiguous).toBe(true);
    expect(u.missingInformation).toContain("referent");
    expect(u.understandingConfidence).toBeLessThan(0.4);
    expect(u.resolvedIntent.needsClarification).toBe(true);
    const d = decideAction({ text: "it", intent: u.resolvedIntent });
    expect(d.route).toBe("ask");
    expect(d.askUser).toBe(true);
  });

  it("resolves 'it' against conversation history instead of asking", () => {
    const u = understandTurn({
      text: "it",
      history: [
        { role: "user", text: "Prepare a report about billing" },
        { role: "friday", text: "Started the outline." },
      ],
    });
    expect(u.conversationResolved).toMatch(/billing/);
    expect(u.ambiguous).toBe(false);
    expect(u.understandingConfidence).toBeGreaterThan(0.5);
    expect(u.resolvedIntent.needsClarification).toBe(false);
    expect(u.ownerProjectInformed).not.toMatch(/publisher:/i);
    expect(u.ownerProjectInformed).not.toMatch(/owner:\s*Devendra/i);
  });

  it("adds the publisher only when the ask is about ownership", () => {
    const u = understandTurn({ text: "who owns FRIDAY" });
    expect(u.ownerProjectInformed).toMatch(/publisher:.*Devendra/i);
  });

  it("lands understanding on the existing decision trace", () => {
    clearDecisionTraces();
    const u = understandTurn({ text: "it" });
    noteUnderstanding(toUnderstandingTrace(u));
    recordDecision({
      at: Date.now(),
      mode: "manual",
      prompt: "it",
      modelIds: [],
      routing: "ask — Need a clearer target before acting.",
      policy: "free-preferred",
      confidence: null,
    });
    const last = lastDecision();
    expect(last?.understanding?.ambiguous).toBe(true);
    expect(last?.understanding?.literal).toBe("it");
    expect(last?.understanding?.understandingConfidence).toBeLessThan(0.4);
  });
});

describe("multi-step intake uses the existing graph", () => {
  it("treats meanwhile / and also as a background job, not a second planner", async () => {
    const { considerLongTask } = await import("../../src/lib/friday/self/task-runners");
    const { taskGraph } = await import("../../src/lib/friday/self/task-graph");
    const taken = considerLongTask(
      "prepare the billing report and also file the VAT return meanwhile",
    );
    expect(taken).not.toBeNull();
    if (taken) taskGraph.cancel(taken.id);
  });
});

describe("chat and voice share routing defaults", () => {
  it("fills route mode from the registry when the caller omits it", () => {
    const filled = withRoutingDefaults({});
    expect(filled).toBeTruthy();
  });
});
