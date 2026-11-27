import { describe, expect, it } from "vitest";

import { takeSpeakable } from "../../src/lib/friday/voice-session";
import { spokenSummary } from "../../src/lib/friday/voice-library";
import { stripMarkup } from "../../src/lib/friday/voice-engine/text-normalizer";
import { guardBoilerplate, boilerplateHits } from "../../src/lib/friday/conversation-style";

/** Feed a reply in small pieces, the way a stream arrives, and collect what would be spoken. */
function streamSpoken(full: string, step: number): string[] {
  const said: string[] = [];
  let voiced = 0;
  for (let at = 0; at < full.length; at += step) {
    const text = full.slice(0, at + step);
    const final = at + step >= full.length;
    const chunk = takeSpeakable(text.slice(voiced), final);
    if (chunk.spoken) {
      said.push(chunk.spoken);
      voiced += chunk.consumed;
    }
  }
  return said;
}

describe("a streamed code fence is never read aloud", () => {
  it("holds an open fence until it closes, then drops the fenced span", () => {
    const reply =
      "Here is the fix. ```ts\nconst a = 1. const b = 2.\nrun(a). done.\n``` That is all.";
    for (const step of [1, 3, 7, 16, 400]) {
      const said = streamSpoken(reply, step).join(" ");
      expect(said, `step ${step}`).not.toMatch(/const|run\(a\)|```/);
      expect(said, `step ${step}`).toMatch(/Here is the fix\./);
      expect(said, `step ${step}`).toMatch(/That is all\./);
    }
  });

  it("speaks text before an open fence but never the fence itself", () => {
    const open = takeSpeakable("Look at this. Then ```js\nfoo. bar. baz. ", false);
    expect(open.spoken).toBe("Look at this.");
    expect(open.spoken).not.toMatch(/foo|bar/);
    const nothing = takeSpeakable("```js\nfoo. bar. ", false);
    expect(nothing).toEqual({ spoken: "", consumed: 0 });
  });

  it("drops an unclosed fence when the turn is final", () => {
    const end = takeSpeakable("Done. ```js\nfoo. bar.", true);
    expect(end.spoken).toBe("Done.");
    expect(end.consumed).toBe("Done. ```js\nfoo. bar.".length);
    expect(takeSpeakable("```js\nfoo.", true).spoken).toBe("");
  });

  it("leaves fence-free text exactly as before", () => {
    expect(takeSpeakable("The build is fine. The tests are still", false)).toEqual({
      spoken: "The build is fine.",
      consumed: "The build is fine. ".length,
    });
    expect(takeSpeakable("Whole text", true).spoken).toBe("Whole text");
  });

  it("spokenSummary also drops a fence that never closed", () => {
    expect(spokenSummary("Try this. ```sh\nrm -rf x. now")).toBe("Try this.");
  });
});

describe("boilerplate guard only cuts stock filler", () => {
  it("does not treat a count in an answer as filler", () => {
    expect(boilerplateHits("12 memories saved hain")).toEqual([]);
    expect(boilerplateHits("3 agents are running")).toEqual([]);
    expect(guardBoilerplate("I have 120 memories saved.")).toBe("I have 120 memories saved.");
    expect(boilerplateHits("Agents standing by.")).not.toEqual([]);
  });
});

describe("emoji and symbols are never spoken", () => {
  it("removes flags, clocks, stars, arrows, variation selectors and joined sequences", () => {
    expect(stripMarkup("Done \u{1F1EE}\u{1F1F3} today")).toBe("Done today");
    expect(stripMarkup("Alarm \u23F0 set")).toBe("Alarm set");
    expect(stripMarkup("Rated \u2B50 five")).toBe("Rated five");
    expect(stripMarkup("Go \u2192 next")).toBe("Go next");
    expect(stripMarkup("Heart \u2764\uFE0F ok")).toBe("Heart ok");
    expect(stripMarkup("Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} home")).toBe("Family home");
  });

  it("keeps ordinary words, digits and Devanagari", () => {
    expect(stripMarkup("Room 42 hai, ठीक है")).toBe("Room 42 hai, ठीक है");
  });
});
