import { describe, expect, it } from "vitest";
import {
  LocalAgreementStabilizer,
  type TimedWord,
} from "../../src/lib/friday/voice-engine/transcript-stabilizer";

/** Words at 0.4 s each, starting at `from` (seconds, in the pass's own clock). */
function say(text: string, from = 0, step = 0.4): TimedWord[] {
  return text
    .split(" ")
    .filter(Boolean)
    .map((w, i) => ({ text: w, start: from + i * step, end: from + (i + 1) * step - 0.05 }));
}
const text = (ws: TimedWord[]) => ws.map((w) => w.text).join(" ");

describe("LocalAgreementStabilizer", () => {
  it("commits nothing on the first pass and shows every word as unstable", () => {
    const s = new LocalAgreementStabilizer();
    const out = s.push(say("turn on the light"));
    expect(text(out.committed)).toBe("");
    expect(text(out.unstable)).toBe("turn on the light");
    expect(out.lastCommittedTime).toBe(0);
  });

  it("commits the longest common word prefix of two passes in a row", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("turn on the light"));
    const out = s.push(say("turn on the lights please"));
    expect(text(out.newlyCommitted)).toBe("turn on the");
    expect(text(out.committed)).toBe("turn on the");
    expect(text(out.unstable)).toBe("lights please");
    expect(out.lastCommittedTime).toBeCloseTo(1.15, 5); // end of "the" (0.8 + 0.4 - 0.05)
  });

  it("two identical passes commit everything and leave nothing unstable", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("aaj ka weather"));
    const out = s.push(say("aaj ka weather"));
    expect(text(out.committed)).toBe("aaj ka weather");
    expect(out.unstable).toEqual([]);
  });

  it("a word that flips between passes is never committed until two passes agree on it", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("call mom now"));
    let out = s.push(say("call tom now")); // flipped
    expect(text(out.committed)).toBe("call");
    out = s.push(say("call tom now please"));
    expect(text(out.committed)).toBe("call tom now");
    expect(out.committed.map((w) => w.text)).not.toContain("mom");
  });

  it("never rewrites a committed word when a later pass hears it differently", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("open the file"));
    s.push(say("open the file now")); // commits open the file
    const out = s.push(say("open a file now please")); // starts at 0: before the committed end
    expect(text(out.committed.slice(0, 3))).toBe("open the file");
    // the re-heard words are older than the committed time, so they are dropped, not substituted
    expect(out.committed.map((w) => w.text)).not.toContain("a");
  });

  it("drops words that start at or before the last committed time minus 0.1 s", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("one two three"));
    s.push(say("one two three four")); // commits one two three; last committed end 1.15
    // a window that starts earlier re-hears the committed words plus new ones
    const out = s.push([
      { text: "three", start: 0.8, end: 1.15 }, // 0.8 <= 1.15 - 0.1 -> dropped
      { text: "four", start: 1.1, end: 1.4 }, // 1.1 > 1.05 -> kept
      { text: "five", start: 1.5, end: 1.9 },
    ]);
    expect(text(out.committed)).toBe("one two three four");
    expect(text(out.unstable)).toBe("five");
  });

  it("keeps a word that starts exactly 0.1 s before the committed end out, and one just after in", () => {
    const s = new LocalAgreementStabilizer();
    s.push([{ text: "a", start: 0, end: 1 }]);
    s.push([{ text: "a", start: 0, end: 1 }]); // committed to 1.0
    const out = s.push([
      { text: "b", start: 0.9, end: 1.2 }, // exactly last - 0.1: dropped
      { text: "c", start: 0.91, end: 1.3 }, // just after: kept
    ]);
    expect(text(out.unstable)).toBe("c");
  });

  it("strips an n-gram overlap with the committed tail when the first new word is within 1 s", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("please open the front door"));
    s.push(say("please open the front door now")); // commits the first five
    // the next window re-reads the last two committed words with slightly later times
    const out = s.push([
      { text: "front", start: 1.5, end: 1.9 },
      { text: "door", start: 1.95, end: 2.2 },
      { text: "now", start: 2.3, end: 2.6 },
      { text: "quickly", start: 2.7, end: 3.1 },
    ]);
    // "front door" is stripped, "now" agrees with the previous pass's unstable word, "quickly" is new
    expect(text(out.committed)).toBe("please open the front door now");
    expect(text(out.unstable)).toBe("quickly");
  });

  it("does not strip an overlap when the new words start more than 1 s after the committed end", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("say it"));
    s.push(say("say it")); // committed to 0.75
    const out = s.push([
      { text: "it", start: 3, end: 3.3 }, // a real repeat, far later
      { text: "again", start: 3.4, end: 3.8 },
    ]);
    expect(text(out.unstable)).toBe("it again");
  });

  it("strips an overlap of five words but not of six", () => {
    const six = say("a b c d e f");
    const five = new LocalAgreementStabilizer();
    five.push(six);
    five.push(six); // committed a..f, last end 2.35
    const stripped = five.push(say("b c d e f g", 2.3));
    expect(text(stripped.unstable)).toBe("g");
    const long = new LocalAgreementStabilizer();
    long.push(six);
    long.push(six);
    const kept = long.push(say("a b c d e f g", 2.3));
    expect(text(kept.unstable)).toBe("a b c d e f g"); // a six-word repeat is past the cap: left alone
  });

  it("shifts a pass by the buffer offset into absolute time", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("hello there friend"), 10);
    const out = s.push(say("hello there friend ok"), 10);
    expect(out.committed[0]).toMatchObject({ text: "hello", start: 10 });
    expect(out.lastCommittedTime).toBeCloseTo(11.15, 5);
  });

  it("agrees across a buffer trim: a later pass at a new offset continues the same clock", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("one two three four"), 0);
    s.push(say("one two three four five"), 0); // committed to 1.55
    // the buffer is trimmed at 1.6 s: word times are now relative to 1.6
    s.push(say("five six", 0), 1.6);
    const out = s.push(say("five six seven", 0), 1.6);
    expect(text(out.committed)).toBe("one two three four five six");
  });

  it("compares words without case, punctuation or Unicode form, and keeps Devanagari", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("आज मौसम Kaisa hai"));
    const out = s.push(say("आज मौसम kaisa, hai?"));
    expect(out.committed).toHaveLength(4);
    expect(out.committed[0]?.text).toBe("आज");
  });

  it("ignores empty or blank words, and an empty pass changes nothing", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("a b"));
    const out = s.push([{ text: "  ", start: 0, end: 0.1 }]);
    expect(out.committed).toEqual([]);
    expect(text(out.unstable)).toBe("a b");
    expect(() => s.push([])).not.toThrow();
  });

  it("reset forgets everything", () => {
    const s = new LocalAgreementStabilizer();
    s.push(say("a b c"));
    s.push(say("a b c"));
    s.reset();
    const out = s.push(say("x y"));
    expect(out.committed).toEqual([]);
    expect(out.lastCommittedTime).toBe(0);
  });

  it("a huge pass is bounded and still agrees", () => {
    const s = new LocalAgreementStabilizer();
    const big = say(Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" "));
    s.push(big);
    const out = s.push(big);
    expect(out.committed.length).toBeLessThanOrEqual(400);
    expect(out.committed.length).toBeGreaterThan(0);
  });
});
