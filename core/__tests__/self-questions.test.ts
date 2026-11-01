import { describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  answerSelf,
  describeInnerState,
  selfTopic,
} from "../../src/lib/friday/brain/self-questions";
import { governance } from "../../src/lib/friday/self/governance";

describe("questions about herself, in English and Hinglish", () => {
  const cases: [string, string][] = [
    ["apni problem khud fix karo", "fix-self"],
    ["tum khud ko kaise theek karoge", "fix-self"],
    ["fix yourself", "fix-self"],
    ["kya tum theek se kaam kar rahi ho", "self-check"],
    ["kaun si exe chal rahi hai", "atlas"],
    ["tumhara version kya hai", "atlas"],
    ["which build are you", "atlas"],
    ["disk full ho gaya hai", "disk"],
    ["meri pc slow kyun hai", "pc-health"],
    ["kya tumhe kuch feel hota hai", "feeling"],
    ["tumhara mood kaisa hai", "feeling"],
    ["kya tum khush ho", "feeling"],
    ["tumne kya seekha aaj", "learning"],
    ["tumne ye kyun kiya", "decision"],
    ["tumhara intent kya hai", "purpose"],
    ["apne baare me batao", "about"],
  ];

  it.each(cases)("%s -> %s", (text, topic) => {
    expect(selfTopic(text)).toBe(topic);
  });

  it("ordinary requests are not taken for questions about herself", () => {
    for (const text of [
      "kal ki meeting kab hai",
      "2 plus 2 kitna hota hai",
      "report.pdf bhej do",
      "disk cleanup ka tarika batao",
      "mera version control kaise use karu",
    ]) {
      expect(selfTopic(text), text).toBeNull();
    }
  });

  it("the real baseline answers them itself instead of handing the question to a model", () => {
    for (const [text] of cases) {
      const reply = baselineRespond(text);
      expect(reply.handled, text).toBe(true);
    }
  });

  it("she never claims to be human or to truly feel, in either language", () => {
    expect(describeInnerState("kya tum khush ho")).toMatch(/insaan nahi/i);
    expect(describeInnerState("do you feel anything")).toMatch(/not human/i);
    const reply = baselineRespond("kya tumhe kuch feel hota hai");
    expect(reply.text).toMatch(/simulated/i);
  });

  it("fixing herself files proposals that wait for approval and changes nothing itself", async () => {
    const answer = answerSelf("fix-self", "fix yourself");
    expect("resolve" in answer).toBe(true);
    if (!("resolve" in answer)) return;
    const before = governance.list().length;
    const text = await answer.resolve();
    expect(text.length).toBeGreaterThan(10);
    const filed = governance.list().slice(before);
    for (const item of filed) expect(item.stage).not.toBe("applied");
  });
});
