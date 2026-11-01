import { beforeEach, describe, expect, it } from "vitest";
import { analyseIntent } from "../../src/lib/friday/brain-catalog";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { resetConversationSession } from "../../src/lib/friday/brain/conversation-state";
import { resetIntentOutcomes, understandTurn } from "../../src/lib/friday/brain/intent-engine";
import {
  calibrate,
  calibrationTable,
  describeIntentMemory,
  expandShortcut,
  listPhrasings,
  noteOutcome,
  parseShortcutTeaching,
  phraseSimilarity,
  recallPhrasing,
  resetIntentMemory,
  teachShortcut,
} from "../../src/lib/friday/brain/intent-memory";
import { impliedRequest, resetSlotMemory } from "../../src/lib/friday/brain/slot-understanding";

beforeEach(() => {
  resetIntentMemory();
  resetIntentOutcomes();
  resetSlotMemory();
  resetConversationSession();
});

describe("routing on whole words, not on letters inside words", () => {
  it.each([
    ["mere program me error hai", "system"],
    ["ek essay likho", "voice"],
    ["airplane ticket book karo", "reasoning"],
    ["denote kya hota hai", "memory"],
    ["ramen recipe batao", "system"],
  ])("%s is not %s", (text, wrong) => {
    expect(analyseIntent(text).rule.id).not.toBe(wrong);
  });

  it("still finds the real words, with their endings", () => {
    expect(analyseIntent("check my ram and disk").rule.id).toBe("system");
    expect(analyseIntent("planning the architecture").rule.id).toBe("reasoning");
    expect(analyseIntent("installing the driver").rule.id).toBe("install");
  });

  it("says when nothing matched and when two types tie, instead of passing a default off as a match", () => {
    const none = analyseIntent("bhai kuch bhi");
    expect(none.novel).toBe(true);
    expect(none.rule.id).toBe("chat");
    const tie = analyseIntent("install the driver and monitor the disk");
    expect(tie.runnerUp).not.toBeNull();
    expect(tie.margin).toBe(0);
  });
});

describe("shortcuts taught in words", () => {
  it("reads the teaching sentence in Hinglish and English", () => {
    expect(
      parseShortcutTeaching(
        "jab main 'subah wala kaam' bolun to email check karo aur calendar dikhao",
      ),
    ).toEqual({
      trigger: "subah wala kaam",
      expansion: "email check karo aur calendar dikhao",
    });
    expect(
      parseShortcutTeaching('when I say "wrap up" then save my work and close the apps'),
    ).toEqual({
      trigger: "wrap up",
      expansion: "save my work and close the apps",
    });
    expect(parseShortcutTeaching("kal subah meeting hai")).toBeNull();
  });

  it("taught once, it works with a different spelling, and the full request is what she understands", () => {
    const said = baselineRespond(
      "jab main 'subah wala kaam' bolun to chrome kholo aur calendar dikhao",
    );
    expect(said.handled).toBe(true);
    expect(said.text).toMatch(/subah wala kaam/);
    expect(said.text).toMatch(/nothing runs by itself|koi kaam apne aap nahi/i);
    const u = understandTurn({ text: "subha wala kaam" });
    expect(u.resolvedIntent.rewrittenFrom).toBe("shortcut");
    expect(u.conversationResolved).toBe("chrome kholo aur calendar dikhao");
    expect(u.resolvedIntent.goals).toEqual(["chrome kholo", "calendar dikhao"]);
  });

  it("does not take a different sentence for the shortcut", () => {
    teachShortcut("subah wala kaam", "chrome kholo");
    expect(expandShortcut("subah ka mausam batao")).toBeNull();
    expect(
      expandShortcut(
        "ek bahut lamba sentence jisme subah wala kaam bhi hai par ye shortcut nahi hai",
      ),
    ).toBeNull();
  });

  it("can be listed in his words and cleared on request", () => {
    teachShortcut("wrap up", "save my work");
    expect(baselineRespond("meri shortcuts dikhao").text).toMatch(/wrap up/);
    expect(describeIntentMemory()).toMatch(/save my work/);
    baselineRespond("shortcuts bhool jao");
    expect(expandShortcut("wrap up")).toBeNull();
  });
});

describe("growing from what the owner did not correct", () => {
  it("a wording that went through is remembered, and one he corrected is not", () => {
    understandTurn({ text: "mera disk space check kar do" });
    understandTurn({ text: "thanks, ab ek aur kaam hai" });
    expect(listPhrasings().some((row) => row.phrase.includes("disk space"))).toBe(true);
    understandTurn({ text: "browser history saaf kar do" });
    understandTurn({ text: "nahi, maine kaha tha wo nahi" });
    expect(listPhrasings().some((row) => row.phrase.includes("browser history"))).toBe(false);
  });

  it("a remembered wording decides when the words alone do not", () => {
    understandTurn({ text: "mera laptop ka hisaab dekho" });
    understandTurn({ text: "achha ab agla" });
    const again = recallPhrasing("mera laptop ka hisab dekho");
    expect(again).not.toBeNull();
    const u = understandTurn({ text: "mera laptop ka hisab dekho" });
    expect(u.resolvedIntent.routing?.recalled?.uses).toBeGreaterThanOrEqual(1);
  });

  it("different spellings sit close, different sentences do not", () => {
    expect(phraseSimilarity("subah wala kaam", "subha wala kaam")).toBeGreaterThanOrEqual(0.75);
    expect(phraseSimilarity("subah wala kaam", "kal ka mausam batao")).toBeLessThan(0.3);
  });

  it("is capped and can be read back", () => {
    for (let i = 0; i < 320; i += 1)
      (understandTurn({ text: `kaam number ${i} please kar do abhi` }),
        understandTurn({ text: "ok aage" }));
    expect(listPhrasings().length).toBeLessThanOrEqual(300);
  });
});

describe("a confidence that is pulled toward what actually happened", () => {
  it("is returned as it was with no record, and moves down after corrections in its band", () => {
    expect(calibrate(0.8)).toBe(0.8);
    for (let i = 0; i < 12; i += 1) noteOutcome(0.82, false);
    expect(calibrate(0.82)).toBeLessThan(0.5);
    expect(calibrate(0.3)).toBe(0.3);
  });

  it("moves up when a band keeps being right, and never past 1 or below 0", () => {
    for (let i = 0; i < 30; i += 1) noteOutcome(0.45, true);
    expect(calibrate(0.45)).toBeGreaterThan(0.8);
    expect(calibrate(0.45)).toBeLessThanOrEqual(1);
    expect(calibrationTable().find((row) => row.band === "40-50%")?.total).toBe(30);
  });

  it("learns from the owner's corrections in a real conversation", () => {
    understandTurn({ text: "report banao aur Rahul ko bhej do" });
    understandTurn({ text: "nahi, maine kaha tha wo nahi" });
    expect(calibrationTable().reduce((sum, row) => sum + row.total, 0)).toBe(1);
    expect(calibrationTable().reduce((sum, row) => sum + row.right, 0)).toBe(0);
  });
});

describe("what his words imply but he did not ask", () => {
  it.each([
    ["meri pc slow hai", "troubleshoot"],
    ["chrome nahi chal raha", "troubleshoot"],
    ["kal exam hai", "remind"],
    ["interview hai parso", "remind"],
    ["disk full ho gaya hai", "free-space"],
  ])("%s -> %s", (text, kind) => {
    expect(impliedRequest(text)?.kind).toBe(kind);
  });

  it("is only an offer, and a question or a plain statement implies nothing", () => {
    expect(impliedRequest("meri pc slow kyun hai?")).toBeNull();
    expect(impliedRequest("aaj mausam achha hai")).toBeNull();
    const u = understandTurn({ text: "kal exam hai" });
    expect(u.resolvedIntent.implied?.offer).toMatch(/reminder/);
    expect(u.resolvedIntent.needsClarification).toBe(false);
  });
});
