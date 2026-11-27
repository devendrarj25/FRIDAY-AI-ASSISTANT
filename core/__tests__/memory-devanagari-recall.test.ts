/**
 * Hindi in memory: a fact stored in Devanagari (or mixed script) must come back for a Devanagari query, and a
 * query with no usable words recalls nothing instead of an arbitrary row.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { parseFlowCommand } from "../../src/lib/friday/flow-graph";
import { retrievalTerms } from "../../src/lib/friday/brain/retrieval";
import { channelScores } from "../../src/lib/friday/brain/memory-fabric";
import { considerMemory } from "../../src/lib/friday/brain/memory-policy";
import {
  memoriesSimilar,
  memory,
  memoryContentTokens,
  tokenJaccard,
} from "../../src/lib/friday/self/memory-engine";

const TEA = "मुझे चाय पसंद है";
const NAME = "मेरा नाम देवेंद्र है";

describe("Devanagari memory", () => {
  beforeEach(() => {
    memory.resetForTests();
  });

  it("keeps Devanagari words whole, drops Hindi function words and the danda", () => {
    const terms = retrievalTerms("मुझे चाय पसंद है। और कॉफ़ी");
    expect(terms).toContain("चाय");
    expect(terms).toContain("पसंद");
    for (const stop of ["मुझे", "है", "और"]) expect(terms).not.toContain(stop);
    expect(terms.some((term) => term.includes("।"))).toBe(false);
    // The nukta form is one key whichever way it was typed.
    expect(retrievalTerms("क़क़")).toEqual(retrievalTerms("क़क़"));
  });

  it("keeps Latin retrieval exactly as before", () => {
    expect(retrievalTerms("Who owns the C++ project?")).toEqual(["who", "owned", "c++", "project"]);
  });

  it("stores in Devanagari and recalls in Devanagari", () => {
    memory.remember({ tier: "semantic", title: "चाय", text: TEA, source: "user" });
    memory.remember({ tier: "semantic", title: "नाम", text: NAME, source: "user" });
    const hits = memory.retrieve("मेरा नाम क्या है");
    expect(hits[0]?.item.text).toBe(NAME);
    expect(memory.retrieve("चाय")[0]?.item.text).toBe(TEA);
    expect(memory.search("चाय", { k: 3 })[0]?.text).toBe(TEA);
  });

  it("recalls across mixed script", () => {
    memory.remember({
      tier: "semantic",
      title: "meeting",
      text: "meeting कल सुबह दस बजे है",
      source: "user",
    });
    expect(memory.retrieve("सुबह meeting")[0]?.item.title).toBe("meeting");
    expect(memory.retrieve("meeting")[0]?.item.title).toBe("meeting");
  });

  it("returns nothing, not an arbitrary row, for a non-empty query with no usable word", () => {
    memory.remember({ tier: "semantic", title: "चाय", text: TEA, source: "user" });
    expect(memory.search("है", { k: 5 })).toEqual([]);
    expect(memory.search("the", { k: 5 })).toEqual([]);
    expect(memory.retrieve("है")).toEqual([]);
    // An empty query still lists the pool (recency view), as before.
    expect(memory.search("", { k: 5 }).length).toBeGreaterThan(0);
  });

  it("sees Hindi paraphrases as one fact and Hindi words as content tokens", () => {
    expect(memoryContentTokens(TEA)).toEqual(expect.arrayContaining(["चाय", "पसंद"]));
    expect(tokenJaccard(memoryContentTokens(TEA), memoryContentTokens("चाय पसंद है मुझे"))).toBe(1);
    expect(
      memoriesSimilar({ title: "चाय", text: TEA }, { title: "चाय", text: "मुझे बहुत चाय पसंद है" }),
    ).toBe(true);
    expect(memoriesSimilar({ title: "चाय", text: TEA }, { title: "नाम", text: NAME })).toBe(false);
  });

  it("scores Devanagari words in the fabric's lexical channel", () => {
    const item = memory.remember({ tier: "semantic", title: "नाम", text: NAME, source: "user" });
    const scores = channelScores("मेरा नाम क्या है", item, Date.now(), []);
    expect(scores.lexical).toBeGreaterThan(0.5);
    expect(channelScores("बिल्कुल अलग बात", item, Date.now(), []).lexical).toBe(0);
  });

  it("keeps a standing Hindi preference instead of dropping it as small talk", () => {
    expect(considerMemory({ text: "हमेशा चाय में चीनी कम डालना" }).tier).toBe("permanent");
    expect(considerMemory({ text: "मुझे चाय पसंद है" }).tier).toBe("permanent");
    expect(considerMemory({ text: "ठीक है" }).keep).toBe(false);
  });
});

describe("Devanagari flow commands", () => {
  // JS \b is ASCII-only, so a Devanagari keyword inside \b(...)\b never matched on its own.
  it("finds the feature and the action from Devanagari words alone", () => {
    expect(parseFlowCommand("मेरी आवाज flow dikhao")).toEqual({ action: "show", feature: "voice" });
    expect(parseFlowCommand("flow में याद dikhao")).toEqual({ action: "show", feature: "memory" });
    expect(parseFlowCommand("memory flow कैसे चलता है")).toEqual({
      action: "explain",
      feature: "memory",
    });
    expect(parseFlowCommand("flow में आवाज कैसे")).toEqual({ action: "explain", feature: "voice" });
  });

  it("keeps the Latin forms and the no-command answer", () => {
    expect(parseFlowCommand("show the voice flow")).toEqual({ action: "show", feature: "voice" });
    expect(parseFlowCommand("मेरी आवाज बदलो")).toEqual({ action: "none", feature: "master" });
  });
});
