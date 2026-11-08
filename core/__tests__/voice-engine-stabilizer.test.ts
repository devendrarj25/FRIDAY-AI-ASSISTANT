import { describe, expect, it } from "vitest";
import {
  mergeOverlap,
  TranscriptStabilizer,
} from "../../src/lib/friday/voice-engine/transcript-stabilizer";

describe("mergeOverlap", () => {
  it("drops words repeated across a chunk boundary", () => {
    expect(mergeOverlap("aaj ka weather", "ka weather batao")).toBe("aaj ka weather batao");
  });
  it("ignores case and punctuation in the overlap", () => {
    expect(mergeOverlap("Open the file,", "the FILE now")).toBe("Open the file, now");
  });
  it("handles Devanagari overlap", () => {
    expect(mergeOverlap("मेरी बात सुनो", "बात सुनो फिर")).toBe("मेरी बात सुनो फिर");
  });
  it("joins text with no overlap and handles empty sides", () => {
    expect(mergeOverlap("one two", "three")).toBe("one two three");
    expect(mergeOverlap("", "hello there")).toBe("hello there");
    expect(mergeOverlap("hello", "")).toBe("hello");
  });
  it("does not treat a punctuation-only word as an overlap", () => {
    expect(mergeOverlap("a -", "- b")).toBe("a - - b");
  });
});

describe("TranscriptStabilizer", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("makes words stable only after two hypotheses agree", () => {
    const c = clock();
    const s = new TranscriptStabilizer({ now: c.now });
    expect(s.push("open the").stable).toBe("");
    expect(s.push("open the file").stable).toBe("open the");
    expect(s.push("open the files now").stable).toBe("open the");
  });

  it("never lets a partial act", () => {
    const c = clock();
    const s = new TranscriptStabilizer({ now: c.now });
    expect(s.push("delete all my files", { confidence: 0.99 }).actionable).toBe(false);
    s.push("delete all my files", { confidence: 0.99 });
    c.advance(5000);
    expect(s.push("delete all my files", { confidence: 0.99 }).actionable).toBe(true);
    const fresh = new TranscriptStabilizer({ now: c.now });
    expect(fresh.push("delete all my files", { confidence: 0.99 }).actionable).toBe(false);
  });

  it("needs enough words, time and confidence before a stable run acts", () => {
    const c = clock();
    const s = new TranscriptStabilizer({ now: c.now });
    s.push("open the file now", { confidence: 0.9 });
    expect(s.push("open the file now", { confidence: 0.9 }).actionable).toBe(false); // held too briefly
    c.advance(700);
    expect(s.push("open the file now", { confidence: 0.9 }).actionable).toBe(true);
    const unsure = new TranscriptStabilizer({ now: c.now });
    unsure.push("open the file now", { confidence: 0.3 });
    c.advance(700);
    expect(unsure.push("open the file now", { confidence: 0.3 }).actionable).toBe(false);
    const unknown = new TranscriptStabilizer({ now: c.now });
    unknown.push("open the file now");
    c.advance(700);
    expect(unknown.push("open the file now").actionable).toBe(false);
  });

  it("treats a final transcript as actionable and starts clean afterwards", () => {
    const s = new TranscriptStabilizer();
    const done = s.push("aaj ka weather batao", { final: true });
    expect(done.final).toBe(true);
    expect(done.actionable).toBe(true);
    expect(s.push("ruko").partial).toBe("ruko");
  });

  it("merges a window against committed text without repeating words", () => {
    const s = new TranscriptStabilizer();
    s.commit("friday meri baat");
    expect(s.push("meri baat suno").partial).toBe("friday meri baat suno");
  });

  it("restarts the hold timer when the stable words change", () => {
    const c = clock();
    const s = new TranscriptStabilizer({ now: c.now });
    s.push("one two three", { confidence: 0.9 });
    s.push("one two three", { confidence: 0.9 });
    c.advance(700);
    expect(s.push("one two three", { confidence: 0.9 }).actionable).toBe(true);
    expect(s.push("one two four five", { confidence: 0.9 }).actionable).toBe(false);
  });
});
