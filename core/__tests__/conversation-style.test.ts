import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { identity } from "../../src/lib/friday/brain/identity";
import {
  boilerplateHits,
  conversationCorpus,
  guardBoilerplate,
  openingLine,
  preferSpoken,
  resetSocialLines,
  scoreSocial,
  socialLine,
  SOCIAL_CHAR_CAP,
  styleContract,
} from "../../src/lib/friday/conversation-style";
import { shapeReply } from "../../src/lib/friday/response-policy";

const NOW = Date.UTC(2026, 0, 15, 15, 0, 0);
const MORNING = Date.UTC(2026, 0, 15, 9, 0, 0);

describe("conversation style", () => {
  it("keeps an empty-thread opening short and free of status", () => {
    resetSocialLines();
    const line = openingLine(MORNING);
    expect(line.length).toBeGreaterThan(0);
    expect(line.length).toBeLessThanOrEqual(SOCIAL_CHAR_CAP);
    expect(boilerplateHits(line)).toEqual([]);
    expect(line).not.toMatch(/Morning|agents|memor/i);
    const source = readFileSync("src/lib/friday/brain-engine.ts", "utf8");
    expect(source).not.toMatch(/Brain core is active/);
    expect(source).not.toMatch(/brain online/);
  });

  it("scores at least 250 English, Hindi, and Hinglish social cases", () => {
    resetSocialLines();
    const cases = conversationCorpus(NOW);
    expect(cases.length).toBeGreaterThanOrEqual(250);
    const langs = new Set(cases.map((item) => item.lang));
    expect(langs).toEqual(new Set(["en", "hi", "hinglish"]));
    const failures: string[] = [];
    const seen = new Map<string, Set<string>>();
    for (const item of cases) {
      const spoken = socialLine({
        kind: item.kind,
        prompt: item.prompt,
        now: item.now,
        salt: item.salt,
      });
      const reasons = scoreSocial({ prompt: item.prompt, text: spoken.text, lang: item.lang });
      if (reasons.length) failures.push(`${item.id}: ${reasons.join(",")}`);
      const key = `${item.kind}:${item.lang}:${item.prompt}`;
      const bag = seen.get(key) ?? new Set<string>();
      bag.add(spoken.text);
      seen.set(key, bag);
    }
    expect(failures).toEqual([]);
    const hello = seen.get("greeting:en:hello");
    expect(hello && hello.size).toBeGreaterThan(1);
  });

  it("strips stock intros and keeps the answer", () => {
    expect(guardBoilerplate("As an AI, I'm here to help. The file is saved.")).toBe(
      "The file is saved.",
    );
    expect(preferSpoken("First point. Second point. Third point stays off the voice path.")).toBe(
      "First point. Second point.",
    );
    const shaped = shapeReply({
      prompt: "save the file",
      text: "As an AI, I'm here to help. The file is saved.",
      warmth: "plain",
    });
    expect(shaped.text).toMatch(/file is saved/i);
    expect(shaped.text).not.toMatch(/as an ai/i);
    expect(
      shapeReply({ prompt: "that's wrong", text: "Here is the file.", warmth: "plain" }).text,
    ).toMatch(/That was wrong/);
  });

  it("puts the style contract on the model prompt", () => {
    expect(styleContract()).toMatch(/one short sentence/i);
    expect(identity.compile()).toMatch(/one short sentence/i);
    expect(identity.compile()).toMatch(/Never claim to be human/i);
  });

  it("mirrors Hindi and Hinglish without a proactive status dump", () => {
    resetSocialLines();
    const hi = baselineRespond("नमस्ते", { now: NOW });
    expect(hi.kind).toBe("greeting");
    expect(hi.text).toMatch(/[\u0900-\u097F]/);
    expect(hi.text.length).toBeLessThanOrEqual(SOCIAL_CHAR_CAP);
    expect(boilerplateHits(hi.text)).toEqual([]);
    const mix = baselineRespond("namaste", { now: NOW });
    expect(mix.text).toMatch(/[A-Za-z]/);
    expect(mix.text).not.toMatch(/[\u0900-\u097F]/);
    const bye = baselineRespond("good night", { now: NOW });
    expect(bye.text).toMatch(/night/i);
    expect(bye.text).not.toMatch(/tray|agents|standing by/i);
    const thanks = baselineRespond("शुक्रिया", { now: NOW });
    expect(thanks.text).toMatch(/[\u0900-\u097F]/);
    const mood = baselineRespond("kya chal raha hai", { now: NOW });
    expect(mood.text.length).toBeLessThanOrEqual(SOCIAL_CHAR_CAP);
    expect(mood.text).not.toMatch(/running normally|tasks are still/i);
    const morning = baselineRespond("good morning", { now: NOW });
    expect(morning.text).toMatch(/Morning/);
    const plain = baselineRespond("hello", { now: MORNING });
    expect(plain.text).not.toMatch(/Morning/);
  });
});
