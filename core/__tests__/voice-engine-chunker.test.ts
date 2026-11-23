import { describe, expect, it } from "vitest";

import { takeSpeakable } from "../../src/lib/friday/voice-session";
import {
  CLAUSE_MAX_CHARS,
  chunkClauses,
  firstClauseCut,
  type ClauseOptions,
} from "../../src/lib/friday/voice-engine/clause-chunker";

/** Feed the answer one character at a time, the way a stream grows, and collect every clause. */
function streamed(text: string, options: ClauseOptions = {}): string[] {
  const out: string[] = [];
  let consumed = 0;
  for (let size = 1; size <= text.length; size += 1) {
    const step = chunkClauses(text.slice(consumed, size), {
      ...options,
      first: out.length === 0,
      final: false,
    });
    out.push(...step.clauses);
    consumed += step.consumed;
  }
  const last = chunkClauses(text.slice(consumed), {
    ...options,
    first: out.length === 0,
    final: true,
  });
  out.push(...last.clauses);
  return out;
}

const whole = (text: string, options: ClauseOptions = {}) =>
  chunkClauses(text, { ...options, first: true, final: true }).clauses;

describe("first clause rule", () => {
  it("cuts English at the first break that fits, or at eight words", () => {
    expect(firstClauseCut("Sure thing, here is what I found, and more")?.spoken).toBe(
      "Sure thing, here is what I found,",
    );
    // the first comma is after nine words: the cut falls back to the eighth word
    expect(
      firstClauseCut("Sure, here is what I found about your request, and then more")?.spoken,
    ).toBe("Sure, here is what I found about your");
  });

  it("waits while the text is shorter than the minimum, and cuts at the next break that fits", () => {
    expect(firstClauseCut("Sure, ok, ")).toBeNull();
    expect(firstClauseCut("Okay, got it, I will check the calendar now, then")?.spoken).toBe(
      "Okay, got it, I will check the calendar",
    );
  });

  it("cuts at a sentence end, a colon, a semicolon and a dash alike", () => {
    expect(firstClauseCut("The report is ready now. Next")?.spoken).toBe(
      "The report is ready now.",
    );
    expect(firstClauseCut("Here is the plan for today: first")?.spoken).toBe(
      "Here is the plan for today:",
    );
    expect(firstClauseCut("I checked the inbox first; nothing new")?.spoken).toBe(
      "I checked the inbox first;",
    );
    expect(firstClauseCut("I looked at the tests - they pass")?.spoken).toBe(
      "I looked at the tests",
    );
    expect(firstClauseCut("I looked at the tests — they pass")?.spoken).toBe(
      "I looked at the tests",
    );
  });

  it("falls back to eight words when the text has no break", () => {
    const cut = firstClauseCut(
      "The weather in Mumbai today is quite warm and humid with rain later ",
    );
    expect(cut?.spoken).toBe("The weather in Mumbai today is quite warm");
    // the ninth word is still arriving: no cut yet at the eighth because it is not followed by a space
    expect(firstClauseCut("The weather in Mumbai today is quite warm")).toBeNull();
  });

  it("does not take a break that is too early or leaves the clause under eighteen characters", () => {
    expect(firstClauseCut("Yes, I did. Then I went home and slept well ")?.spoken).toBe(
      "Yes, I did. Then I went home and",
    );
    expect(firstClauseCut("I did it, ok so ")).toBeNull();
  });

  it("returns the consumed length including the spaces after the clause", () => {
    const text = "The report is ready now.   Next one";
    const cut = firstClauseCut(text);
    expect(cut?.spoken).toBe("The report is ready now.");
    expect(text.slice(cut?.consumed)).toBe("Next one");
  });

  it("keeps the options adjustable", () => {
    expect(
      firstClauseCut("Hello there, my friend, welcome ", { minWords: 2, minChars: 5 })?.spoken,
    ).toBe("Hello there,");
  });
});

describe("Hindi, Devanagari and Hinglish", () => {
  it("cuts at the danda with the same word count", () => {
    const text = "आज मौसम बहुत अच्छा है। कल बारिश होगी";
    expect(firstClauseCut(text)?.spoken).toBe("आज मौसम बहुत अच्छा है।");
    expect(whole(text)).toEqual(["आज मौसम बहुत अच्छा है।", "कल बारिश होगी"]);
  });

  it("cuts a Hindi clause at a comma and never inside a Devanagari word", () => {
    const text = "ठीक है, मैं आपके कैलेंडर में अभी देखता हूँ, फिर बताऊँगा";
    const cut = firstClauseCut(text);
    expect(cut?.spoken).toBe("ठीक है, मैं आपके कैलेंडर में अभी देखता हूँ,".split(" ").slice(0, 8).join(" "));
    for (const clause of whole(text)) {
      for (const word of clause.split(" ")) expect(text.split(/\s+/)).toContain(word);
    }
  });

  it("handles the double danda and a Hinglish line mixed with English words", () => {
    expect(firstClauseCut("राम का नाम लेकर चलो आगे ॥ फिर")?.spoken).toBe("राम का नाम लेकर चलो आगे ॥");
    const hinglish = "Theek hai, main aapka meeting ready kar deta hoon, thoda wait karo";
    expect(whole(hinglish)).toEqual([
      "Theek hai, main aapka meeting ready kar deta",
      "hoon, thoda wait karo",
    ]);
  });
});

describe("never cuts inside what must stay whole", () => {
  it("numbers: 3.5 and 1,000 stay whole and a number list is not a break", () => {
    expect(
      firstClauseCut("The price rose by 3.5 percent to 1,000 rupees today, said")?.spoken,
    ).toBe("The price rose by 3.5 percent to 1,000");
    expect(firstClauseCut("It is 3.5 now ")).toBeNull();
    // no comma after a number is a break: the cut waits for the eighth word
    expect(firstClauseCut("The numbers are 1, 2, 3, 4, 5, 6, 7 and so on ")?.spoken).toBe(
      "The numbers are 1, 2, 3, 4, 5,",
    );
  });

  it("abbreviations and initials: Dr., Mr., e.g., i.e., vs. and J. K.", () => {
    expect(firstClauseCut("Please ask Dr. Sharma about it today. Then")?.spoken).toBe(
      "Please ask Dr. Sharma about it today.",
    );
    expect(firstClauseCut("Mr. Rao and Dr. Sharma met today, and")?.spoken).toBe(
      "Mr. Rao and Dr. Sharma met today,",
    );
    expect(firstClauseCut("Pick a tool, e.g., a hammer or a nail gun today, ok ")?.spoken).toBe(
      "Pick a tool, e.g., a hammer or a",
    );
    expect(firstClauseCut("It is cheaper, i.e. free versus paid, in general ")?.spoken).not.toMatch(
      /i\.e\.$/,
    );
    expect(firstClauseCut("J. K. Rowling wrote it well. More")?.spoken).toBe(
      "J. K. Rowling wrote it well.",
    );
    // the eighth word is an abbreviation: the cut moves on past the name
    expect(firstClauseCut("The tests passed and I told Dr. Sharma about it ")?.spoken).toBe(
      "The tests passed and I told Dr. Sharma",
    );
  });

  it("links and addresses stay whole", () => {
    const url = "Please open https://example.com/a?b=1,2 now, then go back";
    expect(firstClauseCut(url)?.spoken).toBe("Please open https://example.com/a?b=1,2 now,");
    // the address is one word, and its dot is not a break while the next character is a letter
    expect(firstClauseCut("Mail me at sam@example.com")).toBeNull();
    expect(firstClauseCut("Mail me at sam@example.com. Thanks a lot ")?.spoken).toBe(
      "Mail me at sam@example.com.",
    );
  });

  it("code spans and fences are not cut", () => {
    expect(firstClauseCut("Run `npm test, then npm run lint` now, please ")?.spoken).toBe(
      "Run `npm test, then npm run lint` now,",
    );
    expect(firstClauseCut("Run `npm test, then npm run lint and the rest of it ")).toBeNull();
    expect(
      firstClauseCut("```\nconst a = 1, b = 2, c = 3, d = 4;\nmore code here, ok "),
    ).toBeNull();
    // once the fence is closed the cut may fall after it
    expect(firstClauseCut("```\nconst a = 1;\n``` Done with that, thanks ")?.spoken).toMatch(
      /Done with that,$/,
    );
  });

  it("quotations are not cut, and a cut resumes after the closing quote", () => {
    expect(firstClauseCut('He said "stop, wait. Now" and then left, quickly ')?.spoken).toBe(
      'He said "stop, wait. Now" and then left,',
    );
    expect(firstClauseCut("She said “no, never, not now” to me, twice ")?.spoken).toBe(
      "She said “no, never, not now” to me,",
    );
    // an open quotation holds the cut, and nothing is cut inside it
    expect(firstClauseCut('He said "stop, wait for the rest of it, and then ')).toBeNull();
  });
});

describe("later clauses and the stream", () => {
  it("cuts later clauses at sentence ends and splits a long one like splitLongSpeech", () => {
    const out = chunkClauses("The report is ready now. Please open it. Thanks for waiting! More", {
      first: true,
    });
    expect(out.clauses).toEqual([
      "The report is ready now.",
      "Please open it.",
      "Thanks for waiting!",
    ]);
    expect(out.rest).toBe("More");
    const long = `First short sentence is here now. ${"word ".repeat(80)}end.`;
    const parts = whole(long);
    expect(parts[0]).toBe("First short sentence is here now.");
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(CLAUSE_MAX_CHARS + 40);
  });

  it("a sentence end needs the space after it, so 3.5 and v1.2 are not ends while the text grows", () => {
    expect(
      chunkClauses("Version v1.2 is the one we use here today.", { first: false }).clauses,
    ).toEqual([]);
    expect(chunkClauses("Version v1.2 is out. ", { first: false }).clauses).toEqual([
      "Version v1.2 is out.",
    ]);
  });

  it("final text is always spoken, even without an end mark, and empty text gives nothing", () => {
    expect(whole("ok")).toEqual(["ok"]);
    expect(whole("Yes. Okay.")).toEqual(["Yes.", "Okay."]);
    expect(chunkClauses("", { first: true, final: true })).toEqual({
      clauses: [],
      rest: "",
      consumed: 0,
    });
    expect(chunkClauses("   \n ", { first: true, final: true }).clauses).toEqual([]);
    expect(chunkClauses("   ", { first: true }).clauses).toEqual([]);
  });

  it("an undecided first clause waits, and the rest is handed back untouched", () => {
    const out = chunkClauses("Sure, I will ", { first: true });
    expect(out).toEqual({ clauses: [], rest: "Sure, I will ", consumed: 0 });
  });

  const samples = [
    "Sure, here is what I found about your request, and then some more detail follows. Another sentence comes next! And a last one?",
    "आज मौसम बहुत अच्छा है। कल बारिश होगी, इसलिए छाता ले जाना। ठीक है॥ चलो",
    "Theek hai, main aapka meeting ready kar deta hoon, thoda wait karo. Phir bataunga.",
    "Please ask Dr. Sharma about 3.5 percent of 1,000 rupees, e.g. today. Visit https://example.com/x?y=1. Done",
    'He said "stop, wait. Now" and then left, quickly. Run `a, b. c` now, ok? Yes.',
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.",
    "Yes. No. Maybe, so, ok now, then",
    "  leading space, and a long first clause here: with a colon; and a semicolon - and a dash  ",
  ];

  it("feeding the text one character at a time gives the same clauses as all at once", () => {
    for (const text of samples) expect(streamed(text), text).toEqual(whole(text));
  });

  it("re-chunking the clauses gives the clauses back (idempotence), and the same call twice agrees", () => {
    for (const text of samples) {
      const once = whole(text);
      expect(whole(text)).toEqual(once);
      expect(whole(once.join(" ")), text).toEqual(once);
    }
  });

  it("every clause is a slice of the original words in order and nothing is lost", () => {
    for (const text of samples) {
      const joined = whole(text).join(" ").replace(/\s+/g, " ");
      expect(joined, text).toBe(text.replace(/\s+/g, " ").trim());
    }
  });

  it("stays fast on a very long answer (linear in the tokens read)", () => {
    const big = `${"This is a fairly ordinary sentence of words. ".repeat(2000)}`;
    const started = performance.now();
    const out = whole(big);
    expect(out.length).toBe(2000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("the live path: the small first clause, then takeSpeakable as before", () => {
  /** The same order the assistant uses for a growing answer: first clause once, then whole sentences. */
  function live(text: string, step: number): string[] {
    const spoken: string[] = [];
    let voiced = 0;
    const turn = (upTo: number, final: boolean) => {
      const seen = text.slice(0, upTo);
      if (voiced === 0) {
        const cut = firstClauseCut(seen, { final });
        if (cut) {
          spoken.push(cut.spoken);
          voiced += cut.consumed;
        }
      }
      const chunk = takeSpeakable(seen.slice(voiced), final);
      if (chunk.spoken) {
        spoken.push(chunk.spoken);
        voiced += chunk.consumed;
      }
    };
    for (let at = step; at < text.length; at += step) turn(at, false);
    turn(text.length, true);
    return spoken;
  }

  const answers = [
    "Sure, I checked your calendar for tomorrow, and you are free after lunch. Shall I book the call? Tell me the time.",
    "आज मौसम बहुत अच्छा है, इसलिए बाहर घूमने जाओ। कल बारिश होगी।",
    "Theek hai, main aapka meeting ready kar deta hoon. Phir bataunga ki kya hua.",
    "Yes. That works.",
    "Okay then",
  ];

  it("speaks every word once and in order, whatever the size of the growth steps", () => {
    for (const answer of answers) {
      for (const step of [1, 3, 7, 1000]) {
        const joined = live(answer, step).join(" ").replace(/\s+/g, " ");
        expect(joined, `${answer} / ${step}`).toBe(answer.replace(/\s+/g, " ").trim());
      }
    }
  });

  it("the first clause is spoken before the first sentence ends, the rest as whole sentences", () => {
    const answer = answers[0] ?? "";
    const parts = live(answer, 1);
    expect(parts[0]).toBe("Sure, I checked your calendar for tomorrow,");
    expect(parts[1]).toBe("and you are free after lunch.");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]?.length).toBeLessThan(answer.indexOf(".") + 1);
  });
});
