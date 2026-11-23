import { describe, expect, it } from "vitest";
import {
  SpeechArbiter,
  type SpeechPriority,
  type SpeechRequest,
} from "../../src/lib/friday/voice-engine/speech-arbiter";

const makeClock = (start = 1_000_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    set: (v: number) => void (t = v),
  };
};
const make = (over: { maxQueue?: number } = {}) => {
  const clock = makeClock();
  const arbiter = new SpeechArbiter({ now: clock.now, ...over });
  return { arbiter, clock };
};
const req = (
  text: string,
  priority: SpeechPriority,
  rest: Partial<SpeechRequest> = {},
): SpeechRequest => ({
  text,
  priority,
  ...rest,
});
/** Take the next item and finish it, as a player that plays every clause to its end. */
const play = (arbiter: SpeechArbiter): string | null => {
  const item = arbiter.next();
  if (!item) return null;
  arbiter.finish(item.id);
  return item.text;
};
const drain = (arbiter: SpeechArbiter): string[] => {
  const out: string[] = [];
  for (let line = play(arbiter); line !== null; line = play(arbiter)) out.push(line);
  return out;
};

/** A small seeded generator so the property test is the same on every machine. */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

describe("same priority is a plain first-in first-out queue", () => {
  for (const priority of ["approval", "direct", "progress", "chatter"] as const) {
    it(`matches a string array for ${priority} over random operations`, () => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const random = lcg(seed);
        const { arbiter } = make({ maxQueue: 10_000 });
        const model: string[] = [];
        const heard: string[] = [];
        const expected: string[] = [];
        let n = 0;
        for (let step = 0; step < 300; step += 1) {
          if (random() < 0.55) {
            const text = `line ${seed}-${(n += 1)}`;
            expect(arbiter.enqueue(req(text, priority)).accepted).toBe(true);
            model.push(text);
          } else {
            const got = play(arbiter);
            const want = model.shift() ?? null;
            if (got !== null) heard.push(got);
            if (want !== null) expected.push(want);
            expect(got).toBe(want);
          }
        }
        expect(drain(arbiter)).toEqual(model);
        expect(heard).toEqual(expected);
        expect(arbiter.stats().dropped).toEqual({
          overflow: 0,
          expired: 0,
          coalesced: 0,
          chatter: 0,
          flushed: 0,
        });
      }
    });
  }

  it("keeps the order of text it was given, byte for byte", () => {
    const { arbiter } = make();
    const lines = ["नमस्ते, कैसे हैं?", "  spaced  out  ", "50% & <done>", "it's fine"];
    for (const text of lines) arbiter.enqueue(req(text, "direct"));
    expect(drain(arbiter)).toEqual(lines);
  });
});

describe("priority", () => {
  it("serves approval, then direct, then progress", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("p1", "progress"));
    arbiter.enqueue(req("d1", "direct"));
    arbiter.enqueue(req("a1", "approval"));
    arbiter.enqueue(req("d2", "direct"));
    expect(drain(arbiter)).toEqual(["a1", "d1", "d2", "p1"]);
  });

  it("an approval waits for the clause in play, then jumps ahead of the rest of the reply", () => {
    const { arbiter } = make();
    for (const text of ["c1", "c2", "c3"]) arbiter.enqueue(req(text, "direct"));
    const first = arbiter.next();
    expect(first?.text).toBe("c1");
    arbiter.enqueue(req("Shall I delete the folder?", "approval"));
    expect(arbiter.next()).toBeNull(); // c1 is still being said: never cut mid-word
    expect(arbiter.playing()?.id).toBe(first?.id);
    arbiter.finish(first?.id ?? "");
    expect(play(arbiter)).toBe("Shall I delete the folder?");
    expect(drain(arbiter)).toEqual(["c2", "c3"]);
  });

  it("a flush never touches the clause in play", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("working on it", "progress"));
    const item = arbiter.next();
    arbiter.flush(["progress", "chatter"]);
    expect(arbiter.playing()?.text).toBe("working on it");
    arbiter.finish(item?.id ?? "");
    expect(arbiter.playing()).toBeNull();
  });
});

describe("coalescing", () => {
  it("keeps only the newest progress line of a task, in the slot of the old one", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("A 25", "progress", { taskId: "a", coalesceKey: "progress:a" }));
    arbiter.enqueue(req("B 25", "progress", { taskId: "b", coalesceKey: "progress:b" }));
    arbiter.enqueue(req("A 50", "progress", { taskId: "a", coalesceKey: "progress:a" }));
    expect(drain(arbiter)).toEqual(["A 50", "B 25"]);
    expect(arbiter.stats().dropped.coalesced).toBe(1);
  });

  it("does not merge different keys or lines without a key", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("x", "progress"));
    arbiter.enqueue(req("x", "progress"));
    expect(drain(arbiter)).toEqual(["x", "x"]);
  });

  it("the newest line restarts the expiry clock", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("old", "progress", { coalesceKey: "k" }));
    clock.advance(25_000);
    arbiter.enqueue(req("new", "progress", { coalesceKey: "k" }));
    clock.advance(25_000);
    expect(drain(arbiter)).toEqual(["new"]);
  });
});

describe("expiry", () => {
  it("progress lines expire after 30 seconds", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("stale", "progress"));
    clock.advance(30_000);
    expect(arbiter.size()).toBe(1); // exactly at the limit is still alive
    clock.advance(1);
    expect(arbiter.next()).toBeNull();
    expect(arbiter.stats().dropped.expired).toBe(1);
  });

  it("an explicit time to live wins over the default", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("short", "direct", { ttlMs: 1_000 }));
    arbiter.enqueue(req("long", "direct", { ttlMs: 60_000 }));
    clock.advance(2_000);
    expect(drain(arbiter)).toEqual(["long"]);
  });

  it("a done line lives ten minutes and then becomes a digest", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("Report is ready.", "direct", { done: true, taskId: "t1" }));
    arbiter.enqueue(
      req("Notes are saved.", "direct", { done: true, taskId: "t2", sensitive: true }),
    );
    clock.advance(9 * 60_000);
    expect(arbiter.takeDigest()).toBeNull();
    clock.advance(61_000);
    expect(arbiter.next()).toBeNull();
    expect(arbiter.takeDigest()).toEqual({ count: 2, sensitive: 1, taskIds: ["t1", "t2"] });
    expect(arbiter.takeDigest()).toBeNull();
    expect(arbiter.stats().digested).toBe(2);
    expect(arbiter.stats().dropped.expired).toBe(0);
  });

  it("a spoken done line leaves no digest", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("Done.", "direct", { done: true }));
    expect(play(arbiter)).toBe("Done.");
    clock.advance(11 * 60_000);
    expect(arbiter.takeDigest()).toBeNull();
  });

  it("an approval line outlives progress by default", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("Delete it?", "approval"));
    arbiter.enqueue(req("working", "progress"));
    clock.advance(60_000);
    expect(drain(arbiter)).toEqual(["Delete it?"]);
  });
});

describe("chatter and bounds", () => {
  it("chatter is refused while anything else is queued", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("real", "direct"));
    expect(arbiter.enqueue(req("hmm", "chatter")).accepted).toBe(false);
    expect(drain(arbiter)).toEqual(["real"]);
    expect(arbiter.stats().dropped.chatter).toBe(1);
  });

  it("chatter already queued is dropped when something real arrives", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("hmm", "chatter"));
    arbiter.enqueue(req("real", "progress"));
    expect(drain(arbiter)).toEqual(["real"]);
    expect(arbiter.stats().dropped.chatter).toBe(1);
  });

  it("chatter alone is spoken", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("mm-hm", "chatter"));
    expect(drain(arbiter)).toEqual(["mm-hm"]);
  });

  it("a bounded queue drops the lowest priority, oldest first, and counts it", () => {
    const { arbiter } = make({ maxQueue: 3 });
    arbiter.enqueue(req("p1", "progress"));
    arbiter.enqueue(req("d1", "direct"));
    arbiter.enqueue(req("p2", "progress"));
    arbiter.enqueue(req("d2", "direct")); // p1 goes
    arbiter.enqueue(req("a1", "approval")); // p2 goes
    expect(drain(arbiter)).toEqual(["a1", "d1", "d2"]);
    expect(arbiter.stats().dropped.overflow).toBe(2);
  });

  it("a new low-priority line is the one refused when the queue is full of better ones", () => {
    const { arbiter } = make({ maxQueue: 2 });
    arbiter.enqueue(req("a1", "approval"));
    arbiter.enqueue(req("d1", "direct"));
    const out = arbiter.enqueue(req("p1", "progress"));
    expect(out.accepted).toBe(false);
    expect(drain(arbiter)).toEqual(["a1", "d1"]);
    expect(arbiter.stats().dropped.overflow).toBe(1);
  });

  it("a full queue of equals drops the oldest", () => {
    const { arbiter } = make({ maxQueue: 2 });
    for (const text of ["1", "2", "3"]) arbiter.enqueue(req(text, "direct"));
    expect(drain(arbiter)).toEqual(["2", "3"]);
  });
});

describe("flush on a barge-in", () => {
  it("drops progress and chatter and keeps approvals and direct answers", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("p", "progress"));
    arbiter.enqueue(req("a", "approval"));
    arbiter.enqueue(req("d", "direct"));
    arbiter.enqueue(req("p2", "progress"));
    expect(arbiter.flush(["progress", "chatter"])).toBe(2);
    expect(drain(arbiter)).toEqual(["a", "d"]);
    expect(arbiter.stats().dropped.flushed).toBe(2);
  });

  it("bargeIn is that flush", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("p", "progress"));
    arbiter.enqueue(req("a", "approval"));
    expect(arbiter.bargeIn()).toBe(1);
    expect(drain(arbiter)).toEqual(["a"]);
  });

  it("flushing nothing is harmless", () => {
    const { arbiter } = make();
    expect(arbiter.flush([])).toBe(0);
    expect(arbiter.flush(["progress"])).toBe(0);
  });
});

describe("the owner speaking", () => {
  it("never releases while the owner is speaking", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("hello", "direct"));
    expect(arbiter.next({ ownerSpeaking: true })).toBeNull();
    expect(arbiter.size()).toBe(1);
  });

  it("waits a 600 ms quiet grace after the owner stops", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("hello", "direct"));
    arbiter.setOwnerSpeaking(true);
    clock.advance(5_000);
    arbiter.setOwnerSpeaking(false);
    clock.advance(599);
    expect(arbiter.next()).toBeNull();
    expect(arbiter.waitMs()).toBe(1);
    clock.advance(1);
    expect(arbiter.waitMs()).toBe(0);
    expect(arbiter.next()?.text).toBe("hello");
  });

  it("applies the grace to an approval as well", () => {
    const { arbiter, clock } = make();
    arbiter.setOwnerSpeaking(true);
    arbiter.setOwnerSpeaking(false);
    arbiter.enqueue(req("Delete it?", "approval"));
    clock.advance(300);
    expect(arbiter.next()).toBeNull();
    clock.advance(300);
    expect(arbiter.next()?.text).toBe("Delete it?");
  });

  it("the first owner utterance of the session has no grace to wait for", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("hello", "direct"));
    expect(arbiter.next()?.text).toBe("hello");
  });

  it("lines that expire while the owner talks are not said afterwards", () => {
    const { arbiter, clock } = make();
    arbiter.enqueue(req("progress", "progress"));
    arbiter.setOwnerSpeaking(true);
    clock.advance(40_000);
    arbiter.setOwnerSpeaking(false);
    clock.advance(700);
    expect(arbiter.next()).toBeNull();
  });
});

describe("one player", () => {
  it("hands out one item at a time", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("a", "direct"));
    arbiter.enqueue(req("b", "direct"));
    const first = arbiter.next();
    expect(arbiter.next()).toBeNull();
    arbiter.finish("not-the-one");
    expect(arbiter.next()).toBeNull();
    arbiter.finish(first?.id ?? "");
    expect(arbiter.next()?.text).toBe("b");
  });

  it("gives every item a distinct id and carries the fields through", () => {
    const { arbiter } = make();
    const a = arbiter.enqueue(
      req("a", "progress", { taskId: "t1", sensitive: true, whisper: true }),
    );
    const b = arbiter.enqueue(req("b", "progress"));
    expect(a.id).not.toBe(b.id);
    expect(arbiter.next()).toMatchObject({
      id: a.id,
      text: "a",
      priority: "progress",
      taskId: "t1",
      sensitive: true,
      whisper: true,
      ttlMs: 30_000,
    });
  });

  it("drops an empty line without queueing it", () => {
    const { arbiter } = make();
    expect(arbiter.enqueue(req("   ", "direct")).accepted).toBe(false);
    expect(arbiter.size()).toBe(0);
  });

  it("clear empties the queue but not the one in play", () => {
    const { arbiter } = make();
    arbiter.enqueue(req("a", "direct"));
    arbiter.enqueue(req("b", "direct"));
    arbiter.next();
    arbiter.clear();
    expect(arbiter.size()).toBe(0);
    expect(arbiter.playing()?.text).toBe("a");
  });
});
