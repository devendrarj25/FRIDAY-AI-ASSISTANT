/**
 * Mature conversation intelligence on the existing specialists —
 * not a second brain, store, or test framework.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { affect } from "../../src/lib/friday/brain/affect";
import { resolveContext } from "../../src/lib/friday/brain/context-engine";
import {
  conversationalMove,
  understand,
  understandTurn,
} from "../../src/lib/friday/brain/intent-engine";
import {
  getConversationSession,
  resetConversationSession,
} from "../../src/lib/friday/brain/conversation-state";
import { resetOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { decideAction, selectResponseStrategy } from "../../src/lib/friday/brain/decision-engine";
import {
  evaluateConversationalFit,
  reviseConversationalAnswer,
} from "../../src/lib/friday/brain/meta-reasoner";
import { classifyCognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { leaksForeignIdentity } from "../../src/lib/friday/brain/reconciler";
import { isConsequential } from "../../src/lib/friday/brain/action-risk";

const OPTIONS = {
  role: "friday" as const,
  text: "1. Alpha plan\n2. Beta plan\n3. Gamma plan",
};

describe("conversation intelligence", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
    memory.resetForTests();
    for (let i = 0; i < 12; i += 1) affect.observePrompt("ok");
  });

  it("resolves a follow-up 'it' from the active topic, not as a blank referent", () => {
    const history = [{ role: "user", text: "which rollout should we pick?" }, OPTIONS];
    resolveContext("use option 2", history);
    const u = understandTurn({
      text: "implement it",
      history: [
        ...history,
        { role: "user", text: "use option 2" },
        { role: "friday", text: "Beta plan it is." },
      ],
    });
    expect(u.conversationResolved).toMatch(/Beta plan/i);
    expect(u.ambiguous).toBe(false);
    expect(u.resolvedIntent.needsClarification).toBe(false);
  });

  it("pauses a thread on a topic switch and resumes the first one", () => {
    resolveContext("Now Project B instead", [
      { role: "user", text: "Let's discuss Project Alpha billing" },
      { role: "friday", text: "Ready on Project Alpha." },
    ]);
    const mid = getConversationSession();
    expect(mid.previousTopics.some((item) => /Alpha/i.test(item))).toBe(true);
    const back = resolveContext("Back to the first one", [
      { role: "user", text: "Let's discuss Project Alpha billing" },
      { role: "friday", text: "Ready on Project Alpha." },
      { role: "user", text: "Now Project B instead" },
      { role: "friday", text: "Switched to B." },
    ]);
    expect(back.references.some((item) => /thread|go-back/.test(item))).toBe(true);
    expect(back.resolved).toMatch(/Alpha/i);
  });

  it("resolves it / that / same one / option 2 / continue", () => {
    const history = [{ role: "user", text: "which rollout should we pick?" }, OPTIONS];
    expect(resolveContext("use option 2", history).resolved).toMatch(/Beta plan/);
    expect(resolveContext("continue", history).resolved).toMatch(/Beta plan/i);
    expect(
      understandTurn({ text: "uska second option kar do", history }).conversationResolved,
    ).toMatch(/Beta plan/i);
  });

  it("marks an ambiguous referent instead of inventing certainty", () => {
    const u = understandTurn({ text: "it" });
    expect(u.ambiguous).toBe(true);
    expect(u.resolvedIntent.needsClarification).toBe(true);
    expect(decideAction({ text: "it", intent: u.resolvedIntent }).route).toBe("ask");
  });

  it("incorporates a correction as a repair, not a defence", () => {
    const history = [{ role: "user", text: "which rollout should we pick?" }, OPTIONS];
    resolveContext("use option 2", history);
    const u = understandTurn({
      text: "Nahi, wo nahi. Jo pehle wala tha.",
      history: [...history, { role: "user", text: "use option 2" }],
    });
    expect(u.conversationalMove).toBe("correction");
    expect(u.conversationResolved).toMatch(/Alpha plan/i);
    const strategy = selectResponseStrategy({
      text: u.literal,
      intent: u.resolvedIntent,
      move: u.conversationalMove,
    });
    expect(strategy.strategy).toBe("acknowledge-correction");
  });

  it("uses relevant memory and does not dump an unrelated pinned fact into a hello turn", () => {
    memory.remember({
      tier: "episodic",
      title: "Yesterday tender problem",
      text: "Owner discussed the tender bid due Friday and asked FRIDAY to draft section 3.",
      source: "conversation",
      confidence: 0.9,
      kind: "episodic",
      verified: true,
    });
    memory.remember({
      tier: "permanent",
      title: "Favourite snack",
      text: "Owner likes samosa on Tuesdays.",
      source: "user",
      confidence: 1,
      kind: "preference",
      pinned: true,
    });
    const recalled = understandTurn({ text: "Kal wali problem yaad hai?" });
    expect(recalled.conversationResolved).toMatch(/tender bid due Friday/i);
    const hello = understandTurn({ text: "hello" });
    expect(hello.memoryInformed).not.toMatch(/samosa/i);
  });

  it("adapts tone: frustrated → brief, exploratory → options, simple question → direct", () => {
    affect.observePrompt("this is STILL not working, fix it immediately!!");
    const frustrated = selectResponseStrategy({
      text: "fix it",
      intent: understand("fix the installer"),
      move: "troubleshooting",
    });
    expect([
      "answer-briefly",
      "continue-task",
      "execute-action",
      "answer-directly",
      "verify-first",
    ]).toContain(frustrated.strategy);
    const explore = selectResponseStrategy({
      text: "maybe we could brainstorm other layouts",
      intent: understand("maybe we could brainstorm other layouts"),
      move: "brainstorming",
    });
    expect(explore.strategy).toBe("provide-options");
    for (let i = 0; i < 12; i += 1) affect.observePrompt("ok");
    const simple = selectResponseStrategy({
      text: "what time is it",
      intent: understand("what time is it"),
      move: "question",
    });
    expect([
      "answer-directly",
      "omit-old-context",
      "acknowledge-uncertainty",
      "answer-briefly",
    ]).toContain(simple.strategy);
  });

  it("infers a short request from context instead of asking, and asks when evidence is weak", () => {
    const clear = understandTurn({
      text: "Ye thoda better bana do.",
      history: [
        { role: "user", text: "Rewrite the login button copy so the wording is clearer" },
        { role: "friday", text: "Drafted three sentences." },
      ],
    });
    expect(clear.ambiguous).toBe(false);
    expect(clear.resolvedGoal).toMatch(/wording|improve/i);
    resetConversationSession();
    const weak = understandTurn({ text: "Ye thoda better bana do." });
    expect(weak.understandingConfidence).toBeLessThan(0.5);
  });

  it("replaces the user goal on a new self-contained ask, not on anaphora", () => {
    understandTurn({ text: "explain closures" });
    expect(getConversationSession().userGoal).toMatch(/closures/i);
    const next = understandTurn({ text: "write a haiku about rain" });
    expect(next.resolvedGoal).toMatch(/haiku|rain/i);
    expect(next.resolvedGoal).not.toMatch(/closures/i);
    const remembered = understandTurn({ text: "remember that my build runs on Windows" });
    expect(remembered.resolvedGoal).toMatch(/windows/i);
    expect(remembered.resolvedGoal).not.toMatch(/haiku/i);
  });

  it("execution stays on the existing governance path", () => {
    const prompt = "delete the temp folder on C";
    expect(isConsequential(prompt)).toBe(true);
    const u = understandTurn({ text: prompt });
    const decision = decideAction({ text: prompt, intent: u.resolvedIntent });
    expect(["confirm", "ask", "tool", "model"]).toContain(decision.route);
    const strategy = selectResponseStrategy({
      text: prompt,
      intent: u.resolvedIntent,
    });
    expect(strategy.strategy).toBe("verify-first");
    expect(
      selectResponseStrategy({
        text: "bas kar do",
        intent: understand("continue the selected option"),
        move: "approval",
      }).strategy,
    ).toBe("execute-action");
    resetConversationSession();
    const isolated = understandTurn({ text: "it" });
    expect(decideAction({ text: "it", intent: isolated.resolvedIntent }).route).toBe("ask");
  });

  it("never identifies as another model and strips filler", () => {
    const scrubbed = reviseConversationalAnswer(
      "I understand. As an AI language model, I am ChatGPT.",
    );
    expect(leaksForeignIdentity(scrubbed)).toBe(false);
    expect(scrubbed).not.toMatch(/chatgpt|as an ai/i);
    expect(evaluateConversationalFit({ prompt: "hello", answer: "Hi." }).ran).toBe(false);
    const fit = evaluateConversationalFit({
      prompt: "Ye galat hai",
      answer: "I understand. As I said, option 2 is still best.",
      correction: true,
    });
    expect(fit.ok).toBe(false);
  });

  it("FRIDAY identity rules: never GPT / Claude / Gemini / Ollama", () => {
    expect(conversationalMove("who are you")).toBe("question");
    const identity = reviseConversationalAnswer("I am Claude, built by Anthropic.");
    expect(identity).not.toMatch(/claude|anthropic/i);
  });

  it("does not deep-route a hello turn, and does not skip high-stakes", () => {
    expect(classifyCognitiveRoute({ prompt: "thanks", kind: "chat" }).action).toBe("fast-path");
    expect(
      classifyCognitiveRoute({ prompt: "delete the temp folder", kind: "system" }).action,
    ).toBe("multi-verify");
  });
});
