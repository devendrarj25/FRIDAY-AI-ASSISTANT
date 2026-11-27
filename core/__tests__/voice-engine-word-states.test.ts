import { describe, expect, it } from "vitest";
import {
  isAppendOnly,
  WordStateStabilizer,
  type TimedWord,
  type WordStreamSnapshot,
} from "../../src/lib/friday/voice-engine/transcript-stabilizer";

/** Words at 0.4 s each, starting at `from` seconds. */
function say(text: string, from = 0, step = 0.4): TimedWord[] {
  return text
    .split(" ")
    .filter(Boolean)
    .map((w, i) => ({ text: w, start: from + i * step, end: from + (i + 1) * step - 0.05 }));
}
const text = (ws: TimedWord[]) => ws.map((w) => w.text).join(" ");

/** A small deterministic generator, so the flicker run is the same on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("WordStateStabilizer states", () => {
  it("the first pass is all volatile, nothing committed, revision 0", () => {
    const s = new WordStateStabilizer();
    const out = s.push(say("turn on the light"));
    expect(text(out.volatile)).toBe("turn on the light");
    expect(out.committed).toEqual([]);
    expect(out.revision).toBe(0);
    expect(out.words.every((w) => w.state === "volatile")).toBe(true);
  });

  it("commits the agreed prefix, keeps the same word at the same place as stable, new words as volatile", () => {
    const s = new WordStateStabilizer();
    s.push(say("turn on the light now"));
    const out = s.push(say("turn on the light now please"));
    // every word of the first pass is agreed (prefix) except what the second pass extends
    expect(text(out.committed)).toBe("turn on the light now");
    expect(text(out.volatile)).toBe("please");
    expect(out.words.map((w) => w.state)).toEqual([
      "committed",
      "committed",
      "committed",
      "committed",
      "committed",
      "volatile",
    ]);
  });

  it("a word that repeats at its place after a flipped word is stable, not committed", () => {
    const s = new WordStateStabilizer();
    s.push(say("call mom right now"));
    const out = s.push(say("call tom right now")); // `tom` flips: the prefix stops there
    expect(text(out.committed)).toBe("call");
    expect(text(out.stable)).toBe("right now");
    expect(text(out.volatile)).toBe("tom");
    // the order shown is committed, stable, volatile only when words keep their order; states are exact
    expect(out.words.filter((w) => w.state === "committed").map((w) => w.text)).toEqual(["call"]);
  });

  it("an empty pass changes nothing", () => {
    const s = new WordStateStabilizer();
    s.push(say("a b c"));
    const before = s.push(say("a b c d"));
    const after = s.push([]);
    expect(after.committed).toEqual(before.committed);
    expect(after.revision).toBe(before.revision);
  });
});

describe("revision and append-only", () => {
  it("never changes committed words without a revision, and counts one when it must", () => {
    const s = new WordStateStabilizer();
    s.push(say("open the file"));
    const settled = s.push(say("open the file now"));
    expect(text(settled.committed)).toBe("open the file");
    const revised = s.revise(1, [{ text: "a", start: 0.4, end: 0.75 }], "owner fix");
    expect(revised.revision).toBe(1);
    expect(revised.revised?.reason).toBe("owner fix");
    expect(revised.revised?.fromIndex).toBe(1);
    expect(text(revised.revised?.removed ?? [])).toBe("the file");
    expect(text(revised.committed)).toBe("open a");
    expect(isAppendOnly(settled, revised)).toBe(true); // a revision is allowed to change words
    expect(revised.revised).not.toBeNull();
    expect(s.push(say("open a")).revised).toBeNull(); // announced once only
  });

  it("a revision to the same words is a no-op: no counter bump", () => {
    const s = new WordStateStabilizer();
    s.push(say("one two three"));
    s.push(say("one two three"));
    const out = s.revise(1, say("two three", 0.4));
    expect(out.revision).toBe(0);
    expect(out.revised).toBeNull();
  });

  it("finalize only appends when the final reading extends what was committed", () => {
    const s = new WordStateStabilizer();
    s.push(say("aaj ka weather"));
    const mid = s.push(say("aaj ka weather batao"));
    const out = s.finalize(say("aaj ka weather batao please"));
    expect(out.revision).toBe(mid.revision);
    expect(text(out.committed)).toBe("aaj ka weather batao please");
    expect(isAppendOnly(mid, out)).toBe(true);
    expect(out.words.every((w) => w.state === "committed")).toBe(true);
  });

  it("finalize that disagrees is an explicit revision from the first difference", () => {
    const s = new WordStateStabilizer();
    s.push(say("call mom now"));
    const mid = s.push(say("call mom now"));
    const out = s.finalize(say("call tom now"));
    expect(out.revision).toBe(mid.revision + 1);
    expect(out.revised?.reason).toBe("final");
    expect(out.revised?.fromIndex).toBe(1);
    expect(text(out.committed)).toBe("call tom now");
  });

  it("isAppendOnly is false when committed words change under the same revision", () => {
    const a = new WordStateStabilizer();
    a.push(say("x y"));
    const one = a.push(say("x y"));
    const b = new WordStateStabilizer();
    b.push(say("x z"));
    const two = b.push(say("x z"));
    expect(isAppendOnly(one, two)).toBe(false);
    expect(isAppendOnly(one, { ...one, committed: one.committed.slice(0, 1) })).toBe(false);
  });

  it("restarts cleanly: reset forgets words and revisions", () => {
    const s = new WordStateStabilizer();
    s.push(say("a b"));
    s.push(say("a b"));
    s.revise(0, say("z"));
    s.reset();
    const out = s.push(say("fresh start"));
    expect(out.revision).toBe(0);
    expect(out.committed).toEqual([]);
  });
});

describe("trimAt", () => {
  it("is clamped to settled audio and never moves back", () => {
    const s = new WordStateStabilizer();
    s.push(say("one two three four"));
    const mid = s.push(say("one two three four five"));
    expect(mid.lastCommittedTime).toBeCloseTo(1.55, 5);
    expect(s.trimAt(99)).toBeCloseTo(1.55, 5);
    expect(s.trimAt(0.5)).toBeCloseTo(1.55, 5);
    expect(s.trimAt(Number.NaN)).toBeCloseTo(1.55, 5);
    expect(s.push([]).trimmedAt).toBeCloseTo(1.55, 5);
  });

  it("agrees across a cut: later passes at a new buffer offset keep appending", () => {
    const s = new WordStateStabilizer();
    s.push(say("alpha beta gamma delta"));
    s.push(say("alpha beta gamma delta epsilon"));
    const cut = s.trimAt(1.2); // the audio before 1.2 s leaves the buffer
    expect(cut).toBeCloseTo(1.2, 5);
    // the buffer now starts at 1.2 s: epsilon sits at 0.4 s inside it
    s.push(say("delta epsilon zeta", 0.0), 1.2 - 0.0);
    const out = s.push(say("delta epsilon zeta eta", 0.0), 1.2 - 0.0);
    expect(text(out.committed)).toBe("alpha beta gamma delta epsilon zeta");
    expect(out.trimmedAt).toBeCloseTo(1.2, 5);
  });

  it("drops unsettled words that ended before the cut", () => {
    const s = new WordStateStabilizer();
    s.push(say("one two three"));
    s.push(say("one two three four five"));
    s.trimAt(10);
    const out = s.push([]);
    expect(out.volatile.every((w) => w.end > out.trimmedAt)).toBe(true);
  });
});

describe("flicker properties", () => {
  const TRUTH =
    "friday aaj ka weather batao aur kal ka forecast bhi dikhao phir meeting ke notes bhejo".split(
      " ",
    );

  function run(seed: number): WordStreamSnapshot[] {
    const random = rng(seed);
    const s = new WordStateStabilizer();
    const out: WordStreamSnapshot[] = [];
    let noise = 0;
    for (let pass = 1; pass <= 60; pass += 1) {
      const heard = Math.min(TRUTH.length, 1 + Math.floor(pass / 2));
      const words = TRUTH.slice(0, heard).map((w, i) => ({ text: w, i }));
      // the last two words are unreliable: a unique wrong word never repeats, so it can never be agreed on
      const shaped = words.map(({ text: w, i }) =>
        i >= heard - 2 && random() < 0.4 ? `wrong${(noise += 1)}` : w,
      );
      if (random() < 0.15) shaped.pop(); // a shorter reading
      const timed = shaped.map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
      out.push(s.push(timed));
      if (pass % 9 === 0) s.trimAt(s.push([]).lastCommittedTime);
    }
    return out;
  }

  it("committed words never change and never shrink without a revision, over many seeds", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const snaps = run(seed);
      for (let i = 1; i < snaps.length; i += 1) {
        const before = snaps[i - 1] as WordStreamSnapshot;
        const after = snaps[i] as WordStreamSnapshot;
        expect(after.revision, `seed ${seed} pass ${i}`).toBe(before.revision);
        expect(isAppendOnly(before, after), `seed ${seed} pass ${i}`).toBe(true);
      }
    }
  });

  it("a committed word is always a true word: noise is never committed, and every pass reports exact states", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      for (const snap of run(seed)) {
        expect(snap.committed.some((w) => w.text.startsWith("wrong"))).toBe(false);
        const states = snap.words.map((w) => w.state);
        expect(states.filter((x) => x === "committed")).toHaveLength(snap.committed.length);
        expect(states.filter((x) => x === "stable")).toHaveLength(snap.stable.length);
        expect(states.filter((x) => x === "volatile")).toHaveLength(snap.volatile.length);
        // committed words come first, in order, then the others
        const firstOther = states.findIndex((x) => x !== "committed");
        if (firstOther >= 0) expect(states.slice(firstOther)).not.toContain("committed");
      }
    }
  });

  it("makes progress: with truthful passes the committed text is a prefix of the truth and reaches its end", () => {
    const s = new WordStateStabilizer();
    let last: WordStreamSnapshot | null = null;
    for (let n = 1; n <= TRUTH.length + 1; n += 1) {
      last = s.push(say(TRUTH.slice(0, Math.min(n, TRUTH.length)).join(" ")));
      expect(TRUTH.join(" ").startsWith(text(last.committed))).toBe(true);
    }
    expect(last && text(last.committed)).toBe(TRUTH.join(" "));
  });
});
