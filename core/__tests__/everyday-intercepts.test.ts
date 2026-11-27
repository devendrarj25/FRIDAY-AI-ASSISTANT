/**
 * The everyday intercepts answer only what they really did: no "Opening" without opening, no forgetting inside a
 * negation, no recall answer without a note, and "forget that" removes the memory it names from every copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { noteArc, resetArc, arcSnapshot } from "../../src/lib/friday/conversation-arc";
import { everydayPlan } from "../../src/lib/friday/everyday";
import { resetOpenLoops, listOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { resetMemoryFabric } from "../../src/lib/friday/brain/memory-fabric";
import { vectorIndex } from "../../src/lib/friday/brain/vector-index";
import { memory } from "../../src/lib/friday/self/memory-engine";

describe("everyday intercepts", () => {
  beforeEach(() => {
    resetArc();
    resetOpenLoops();
    memory.resetForTests();
    resetMemoryFabric();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not claim to open anything: the real tool path runs", () => {
    for (const phrase of ["chrome kholo", "open notepad", "open the folder", "क्रोम खोलो chrome"]) {
      expect(everydayPlan(phrase), phrase).toBeNull();
    }
  });

  it("does not treat a negated forget as a command", () => {
    noteArc({ topic: "the pin", feeling: "neutral", at: 5, source: "voice" });
    for (const phrase of [
      "don't forget that I have a meeting",
      "do not forget that",
      "never forget that",
      "dont forget that",
    ]) {
      expect(everydayPlan(phrase), phrase).toBeNull();
    }
    expect(arcSnapshot()).toHaveLength(1);
  });

  it("answers 'yaad hai' from the arc only when a matching note exists", () => {
    expect(everydayPlan("yaad hai")).toBeNull();
    noteArc({ topic: "the pin", feeling: "neutral", at: 5, source: "voice" });
    expect(everydayPlan("yaad hai")?.text).toMatch(/the pin/);
    expect(everydayPlan("kya tumhe pin yaad hai")?.text).toMatch(/the pin/);
    expect(everydayPlan("mera birthday kab hai yaad hai")).toBeNull();
    expect(everydayPlan("क्या तुम्हें pin याद है")?.text).toMatch(/the pin/);
  });

  it("lets 'yaad rakhna <fact>' fall through to the stage-and-confirm path", () => {
    expect(everydayPlan("yaad rakhna ki meri maa ka birthday 5 may hai")).toBeNull();
    expect(everydayPlan("yaad rakho meri chai meethi nahi hai")).toBeNull();
    expect(listOpenLoops()).toHaveLength(0);
    // A bare note request still lands on the open-loop list.
    expect(everydayPlan("yaad rakhna")?.kind).toBe("note");
    expect(everydayPlan("note this")?.kind).toBe("note");
  });

  it("forgets the memory the last retrieval returned, everywhere, and names it", async () => {
    const tea = memory.remember({
      tier: "semantic",
      title: "Tea",
      text: "owner drinks masala tea every morning",
      source: "user",
    });
    const removed = vi.spyOn(vectorIndex, "remove").mockResolvedValue(true);
    expect(memory.retrieve("masala tea morning").map((hit) => hit.item.id)).toContain(tea.id);
    const plan = everydayPlan("bhool jao");
    expect(plan?.kind).toBe("forget");
    expect(plan?.text).toMatch(/Tea/);
    expect(plan?.undo).toBe(false);
    expect(memory.getSnapshot().items.some((item) => item.id === tea.id)).toBe(false);
    expect(removed).toHaveBeenCalledWith(tea.id);
    expect(memory.retrieve("masala tea morning")).toEqual([]);
  });

  it("says nothing matched when there is nothing to forget", () => {
    const removed = vi.spyOn(vectorIndex, "remove").mockResolvedValue(true);
    const plan = everydayPlan("forget that");
    expect(plan?.kind).toBe("forget");
    expect(plan?.text).toMatch(/nothing/i);
    expect(plan?.text).not.toMatch(/^Forgot/);
    expect(removed).not.toHaveBeenCalled();
  });

  it("ignores a retrieval that is old, so 'forget that' cannot hit a stale memory", () => {
    memory.remember({
      tier: "semantic",
      title: "Tea",
      text: "owner drinks masala tea",
      source: "user",
    });
    memory.retrieve("masala tea");
    const removed = vi.spyOn(vectorIndex, "remove").mockResolvedValue(true);
    expect(everydayPlan("forget that", Date.now() + 60 * 60_000)?.text).toMatch(/nothing/i);
    expect(removed).not.toHaveBeenCalled();
    expect(memory.getSnapshot().items.some((item) => item.title === "Tea")).toBe(true);
  });

  it("falls back to the session note when no memory was just recalled", () => {
    noteArc({ topic: "the pin", feeling: "neutral", at: 5, source: "voice" });
    const plan = everydayPlan("forget that");
    expect(plan?.text).toMatch(/session note/i);
    expect(arcSnapshot()).toHaveLength(0);
  });

  it("keeps the timer, calculation and forget-all behaviour", () => {
    expect(everydayPlan("set a timer for 5 minutes")?.text).toMatch(/open loop/i);
    expect(everydayPlan("what is 12 times 8")?.text).toBe("96.");
    expect(everydayPlan("bhool jao sab")?.kind).toBe("forget");
    expect(everydayPlan("bhool jao sab")?.text).toMatch(/saved memories stay/i);
  });
});
