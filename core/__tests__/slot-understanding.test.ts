import { beforeEach, describe, expect, it } from "vitest";
import { resetConversationSession } from "../../src/lib/friday/brain/conversation-state";
import { decideAction } from "../../src/lib/friday/brain/decision-engine";
import { splitGoals, understandTurn } from "../../src/lib/friday/brain/intent-engine";
import {
  pendingQuestion,
  readSlots,
  resetSlotMemory,
} from "../../src/lib/friday/brain/slot-understanding";

type Turn = { role: "user" | "assistant"; text: string };

function talk(...lines: string[]) {
  const history: Turn[] = [];
  let last = understandTurn({ text: "" });
  for (const text of lines) {
    last = understandTurn({ text, history });
    history.push({ role: "user", text }, { role: "assistant", text: "ok" });
  }
  return last;
}

beforeEach(() => {
  resetConversationSession();
  resetSlotMemory();
});

describe("asking for the one missing piece, and only when the action needs it", () => {
  it.each([
    ["email bhej do", "Kisko bhejna hai?"],
    ["file bhej do", "Kisko bhejna hai?"],
    ["reminder laga do", "Kis baare me aur kab yaad dilaun?"],
    ["kholo", "Kya kholun?"],
    ["delete kar do", "Kya hataun?"],
    ["call kar do", "Kisko call karun?"],
  ])("%s -> %s", (text, question) => {
    const u = talk(text);
    expect(u.resolvedIntent.needsClarification).toBe(true);
    expect(u.resolvedIntent.ask).toBe(question);
    expect(decideAction({ text, intent: u.resolvedIntent }).route).toBe("ask");
  });

  it("asks in the language it was spoken in", () => {
    expect(talk("send the file").resolvedIntent.ask).toBe("Who should I send it to?");
    resetSlotMemory();
    expect(talk("फ़ाइल भेजो").resolvedIntent.needsClarification).toBe(false);
  });

  it("does not ask when the request already has what it needs", () => {
    for (const text of [
      "Rahul ko report bhej do",
      "kal subah 9 baje meeting ka reminder laga do",
      "Chrome kholo",
      "invoice.pdf delete kar do",
      "call Mom",
    ]) {
      resetSlotMemory();
      const u = talk(text);
      expect(u.resolvedIntent.needsClarification, text).toBe(false);
      expect(u.resolvedIntent.action, text).toBeTruthy();
    }
  });

  it("a pointer to something just talked about counts as the thing: nothing is asked", () => {
    const u = talk("sales report banao", "usko Rahul ko bhej do");
    expect(u.resolvedIntent.needsClarification).toBe(false);
    expect(u.resolvedIntent.slots?.recipient).toBe("Rahul");
  });

  it("questions about an action are not requests for it", () => {
    for (const text of [
      "email kaise bhejte hain",
      "what is a reminder",
      "kya tum call kar sakti ho?",
      "how do I delete a file",
      "call the API again",
    ]) {
      resetSlotMemory();
      const u = talk(text);
      expect(u.resolvedIntent.needsClarification, text).toBe(false);
    }
  });

  it("never invents a recipient, a time or a file", () => {
    const read = readSlots("email bhej do");
    expect(read.slots).toEqual({});
    expect(read.missing).toEqual(["recipient"]);
    expect(readSlots("reminder laga do").missing).toEqual(["when", "what"]);
  });
});

describe("the next short answer fills the piece", () => {
  it("'Rahul ko' after 'file bhej do' becomes one full request", () => {
    const first = talk("file bhej do");
    expect(first.resolvedIntent.ask).toBe("Kisko bhejna hai?");
    expect(pendingQuestion()).toEqual({ action: "send", missing: ["recipient"] });
    const second = understandTurn({ text: "Rahul ko" });
    expect(second.resolvedIntent.rewrittenFrom).toBe("filled");
    expect(second.conversationResolved).toContain("Rahul ko file bhej do");
    expect(second.resolvedIntent.needsClarification).toBe(false);
    expect(second.resolvedIntent.slots?.recipient).toBe("Rahul");
    expect(pendingQuestion()).toBeNull();
  });

  it("a time answers a pending 'when', and a name does not", () => {
    talk("meeting ka reminder laga do");
    const answer = understandTurn({ text: "kal subah 9 baje" });
    expect(answer.resolvedIntent.rewrittenFrom).toBe("filled");
    expect(answer.resolvedIntent.needsClarification).toBe(false);
  });

  it("an answer that does not fit is not forced in, and a third ask is not made", () => {
    talk("email bhej do");
    const off = understandTurn({ text: "pata nahi yaar kya karun abhi" });
    expect(off.resolvedIntent.rewrittenFrom).toBeUndefined();
    const again = understandTurn({ text: "email bhej do" });
    expect(again.resolvedIntent.needsClarification).toBe(true);
    const third = understandTurn({ text: "email bhej do" });
    expect(third.resolvedIntent.needsClarification).toBe(true);
    const fourth = understandTurn({ text: "email bhej do" });
    expect(fourth.resolvedIntent.needsClarification).toBe(true);
  });
});

describe("cut-short follow-ups and corrections", () => {
  it("'aur YouTube bhi' reuses the last action with the new object", () => {
    const u = talk("Chrome kholo", "aur YouTube bhi");
    expect(u.resolvedIntent.rewrittenFrom).toBe("expanded");
    expect(u.conversationResolved).toBe("YouTube kholo");
  });

  it("English follow-ups work the same way, verb first", () => {
    const u = talk("open Notepad", "and Calculator too");
    expect(u.conversationResolved).toBe("open Calculator");
  });

  it("'aur parso ka bhi' swaps only the day", () => {
    const u = talk("kal ka mausam batao", "aur parso ka bhi");
    expect(u.conversationResolved).toBe("parso ka mausam batao");
  });

  it("a correction in passing is linked to the request it corrects", () => {
    const u = talk("report ko pdf me bhej do Rahul ko", "nahi nahi, sirf PDF nahi, excel bhi");
    expect(u.resolvedIntent.rewrittenFrom).toBe("amended");
    expect(u.conversationResolved).toContain("report ko pdf me bhej do Rahul ko");
    expect(u.conversationResolved).toContain("excel bhi");
  });

  it("a follow-up with nothing before it is left as it was", () => {
    const u = talk("aur YouTube bhi");
    expect(u.resolvedIntent.rewrittenFrom).toBeUndefined();
  });

  it("an old action is not reused after a long gap", () => {
    talk("Chrome kholo");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 30 * 60_000;
      const u = understandTurn({ text: "aur YouTube bhi" });
      expect(u.resolvedIntent.rewrittenFrom).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it("more pointer words are understood: usme, isme, isko", () => {
    const u = talk("python ka script likho jo csv merge kare", "ab usme error handling bhi daalo");
    expect(u.conversationResolved).toContain("python ka script");
  });
});

describe("one request with several actions", () => {
  it("splits on 'aur' when every part is an action, and keeps a plain 'aur' together", () => {
    expect(splitGoals("report banao aur Rahul ko bhej do aur calendar me daal do")).toEqual([
      "report banao",
      "Rahul ko bhej do",
      "calendar me daal do",
    ]);
    expect(splitGoals("chai aur biscuit")).toEqual(["chai aur biscuit"]);
    expect(splitGoals("dal aur chawal ka rate batao")).toEqual(["dal aur chawal ka rate batao"]);
  });
});
