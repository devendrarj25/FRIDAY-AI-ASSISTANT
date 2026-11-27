/**
 * The automatic writers (learning, the experience ledger, conversation state, the document library) follow the
 * same rule as the memory policy: sensitive text is not written down, and an imported document is not trusted
 * as if the owner had said it. An explicit teach through MemoryEngine.remember is not gated here.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  getConversationSession,
  noteUserTurn,
  resetConversationSession,
  snapshotCurrentSituation,
} from "../../src/lib/friday/brain/conversation-state";
import { library } from "../../src/lib/friday/library-engine";
import { learning } from "../../src/lib/friday/self/learning-engine";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { experiences } from "../../src/lib/friday/self/task-ledger";

// Built at run time so no secret-looking literal sits in the repository.
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const PASSWORD = "pass" + "word: " + "hunter" + "2x9";

const everything = () => JSON.stringify([memory.getSnapshot().items, experiences.list(500)]);

describe("automatic writers withhold sensitive text", () => {
  beforeEach(() => {
    memory.resetForTests();
    resetConversationSession();
  });

  it("learning.evaluate writes no memory row and no experience text for a sensitive outcome", () => {
    const result = learning.evaluate({
      taskId: "t-sens-1",
      kind: "payment",
      title: `Pay with card ${CARD}`,
      success: false,
      verified: false,
      ms: 1200,
      detail: `declined for ${PASSWORD}`,
      correction: `use card ${CARD} next time`,
      cause: PASSWORD,
    });
    expect(result.learned).toBe(false);
    expect(everything()).not.toContain("4111");
    expect(everything()).not.toContain("hunter");
    // The outcome itself is still counted: only the text is withheld.
    expect(experiences.list(500).some((row) => row.taskId === "t-sens-1")).toBe(true);
  });

  it("experiences.record clips a sensitive title, detail and feedback", () => {
    const row = experiences.record({
      taskId: "t-sens-2",
      kind: "chat",
      title: `remember ${PASSWORD}`,
      success: true,
      verified: true,
      ms: 10,
      detail: CARD,
      feedback: PASSWORD,
    });
    expect(JSON.stringify(row)).not.toMatch(/hunter|4111/);
    expect(row.success).toBe(true);
    expect(row.detail).toBeUndefined();
    expect(row.feedback).toBeUndefined();
  });

  it("an ordinary outcome is still learned as before", () => {
    learning.evaluate({
      taskId: "t-ok-1",
      kind: "chat",
      title: "Summarise the notes",
      success: true,
      verified: true,
      ms: 900,
      detail: "three bullet points",
    });
    expect(memory.getSnapshot().items.some((row) => row.text.includes("three bullet points"))).toBe(
      true,
    );
    expect(experiences.list(500).find((row) => row.taskId === "t-ok-1")?.detail).toBe(
      "three bullet points",
    );
  });

  it("conversation state keeps a sensitive turn out of the topic, the goal and the situation row", () => {
    noteUserTurn(`my card number is ${CARD} please book the flight`, "chat");
    expect(getConversationSession().activeTopic).toBe("");
    expect(getConversationSession().userGoal).toBe("");
    noteUserTurn("let us plan the monthly report for the north site", "chat");
    expect(getConversationSession().activeTopic).toMatch(/monthly report/);
    snapshotCurrentSituation();
    expect(everything()).not.toContain("4111");
    noteUserTurn(`${PASSWORD} for the report portal`, "chat");
    expect(JSON.stringify(getConversationSession())).not.toContain("hunter");
  });

  it("snapshotCurrentSituation writes nothing when the topic is sensitive", () => {
    noteUserTurn("let us plan the monthly report for the north site", "chat");
    const session = getConversationSession();
    session.activeTopic = `note ${PASSWORD}`;
    const before = memory.getSnapshot().items.length;
    snapshotCurrentSituation();
    expect(memory.getSnapshot().items.length).toBe(before);
  });

  it("library chunks are imported-document rows, never verified", async () => {
    const item = await library.ingest({
      name: "site-notes.txt",
      text: "The north site delivery is due on Friday and the crane is booked for Thursday morning.",
      origin: "uploaded",
      source: "chat",
      extract: {
        text: "The north site delivery is due on Friday and the crane is booked for Thursday morning.",
      },
    });
    expect(library.teach(item.id).ok).toBe(true);
    const rows = memory
      .getSnapshot()
      .items.filter((row) => String(row.source).includes(`library:${item.id}`));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.provenance).toBe("imported-document");
      expect(row.verified).toBe(false);
    }
  });

  it("an explicit remember is still not gated by the engine", () => {
    const row = memory.remember({
      tier: "semantic",
      title: "Owner note",
      text: "the owner asked to keep this ordinary fact",
      source: "user",
    });
    expect(row.id).not.toBe("withheld");
  });
});
