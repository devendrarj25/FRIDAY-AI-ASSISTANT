import { describe, expect, it } from "vitest";
import { promisesIn } from "../../src/lib/friday/brain/commitments";
import { understand } from "../../src/lib/friday/brain/intent-engine";
import {
  addSessionFact,
  getConversationSession,
  noteCommitment,
} from "../../src/lib/friday/brain/conversation-state";

describe("promises and limits are kept in the conversation", () => {
  it("finds first-person promises in English and Hinglish, and ignores code and quotes", () => {
    expect(promisesIn("Sure. I'll remind you about the invoice tomorrow morning.")).toEqual([
      "I'll remind you about the invoice tomorrow morning",
    ]);
    expect(promisesIn("Theek hai, main kal report bhejungi aapko.")[0]).toMatch(/bhejungi/);
    expect(promisesIn("```\nI'll do it later in code\n```\nDone.")).toEqual([]);
    expect(promisesIn("> I will quote this\nNothing else.")).toEqual([]);
    expect(promisesIn("Here is the answer.")).toEqual([]);
  });

  it("keeps a promise as a commitment of the session", () => {
    noteCommitment("I'll remind you about the invoice tomorrow morning");
    expect(getConversationSession().commitments.join(" ")).toMatch(/remind you about the invoice/);
    expect(addSessionFact).toBeTypeOf("function");
  });

  it("reads a limit the owner named as a constraint and holds it for the session", async () => {
    expect(understand("summarise it without using any cloud model").constraints.length).toBe(1);
    expect(understand("summarise it").constraints).toEqual([]);
    const { understandTurn } = await import("../../src/lib/friday/brain/intent-engine");
    understandTurn({ text: "write the report but do not touch the old folder" });
    expect(getConversationSession().constraints.join(" ")).toMatch(/do not touch the old folder/);
  });
});
