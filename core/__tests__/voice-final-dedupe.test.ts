import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ANSWER_MAX_WORDS,
  APPROVAL_COPY_MS,
  FINAL_DEDUPE_WINDOW_MS,
  createFinalDeduper,
  finalTextKey,
} from "../../src/lib/friday/voice-engine/final-dedupe";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** A small deterministic generator, so a failing property case can be replayed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v), tick: (ms: number) => (t += ms) };
}

describe("finalTextKey folds what is not a different sentence", () => {
  it("ignores case, punctuation, spacing and the danda", () => {
    const base = finalTextKey("Open Chrome");
    expect(finalTextKey("open   chrome!")).toBe(base);
    expect(finalTextKey("  OPEN, chrome. ")).toBe(base);
    expect(finalTextKey("क्रोम खोलो।")).toBe(finalTextKey("क्रोम खोलो"));
  });

  it("folds digit scripts and the Devanagari candrabindu, and removes zero-width marks", () => {
    expect(finalTextKey("कमरा १२")).toBe(finalTextKey("कमरा 12"));
    expect(finalTextKey("room ١٢")).toBe(finalTextKey("room 12"));
    expect(finalTextKey("हाँ")).toBe(finalTextKey("हां"));
    expect(finalTextKey("open​ chrome‮")).toBe(finalTextKey("open chrome"));
    expect(finalTextKey("ｏｐｅｎ ｃｈｒｏｍｅ")).toBe(finalTextKey("open chrome"));
  });

  it("keeps different words different, and gives an empty key for nothing sayable", () => {
    expect(finalTextKey("open chrome")).not.toBe(finalTextKey("close chrome"));
    expect(finalTextKey("नमस्ते")).not.toBe(finalTextKey("नमस्कार"));
    expect(finalTextKey("...?!  ।")).toBe("");
    expect(finalTextKey(undefined as unknown as string)).toBe("");
  });

  it("caps a huge transcript and still tells two long ones apart by length", () => {
    const long = "word ".repeat(5000);
    expect(finalTextKey(long).length).toBeLessThan(420);
    expect(finalTextKey(long)).not.toBe(finalTextKey(`${long}word`));
  });
});

describe("createFinalDeduper", () => {
  it("lets one run and holds back the same words inside the window (a retried IPC, a provisional adopt)", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(deduper.check({ text: "Open Chrome." }).pass).toBe(true);
    c.tick(300);
    const second = deduper.check({ text: "open chrome" });
    expect(second.pass).toBe(false);
    if (!second.pass) {
      expect(second.reason).toBe("same-text-in-window");
      expect(second.ageMs).toBe(300);
    }
  });

  it("lets a deliberate repeat after the window through", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    deduper.check({ text: "what time is it" });
    c.tick(FINAL_DEDUPE_WINDOW_MS - 1);
    expect(deduper.check({ text: "what time is it" }).pass).toBe(false);
    c.tick(1);
    expect(deduper.check({ text: "what time is it" }).pass).toBe(true);
  });

  it("lets a repeat through once a reply has begun to sound after the first copy", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    deduper.check({ text: "play music" });
    c.tick(1500);
    expect(deduper.check({ text: "play music", replyStartedAt: c.now() - 800 }).pass).toBe(true);
    // A reply that began before the first copy says nothing about the second one.
    c.tick(500);
    expect(deduper.check({ text: "play music", replyStartedAt: c.now() - 5000 }).pass).toBe(false);
  });

  it("does not let a suppressed copy extend the window", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    deduper.check({ text: "stop the timer" });
    for (let i = 0; i < 4; i += 1) {
      c.tick(900);
      expect(deduper.check({ text: "stop the timer" }).pass).toBe(false);
    }
    // 4100 ms after the first copy, more than the window, though copies kept arriving.
    c.tick(500);
    expect(deduper.check({ text: "stop the timer" }).pass).toBe(true);
  });

  it("holds back the same utterance id from one source however late, but not another id", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(
      deduper.check({ text: "set a reminder", source: "sarvam", utteranceId: "t1" }).pass,
    ).toBe(true);
    c.tick(20_000);
    const late = deduper.check({
      text: "set a reminder please",
      source: "sarvam",
      utteranceId: "t1",
    });
    expect(late.pass).toBe(false);
    if (!late.pass) expect(late.reason).toBe("same-utterance-id");
    // Another id from the same source is another utterance even with the same words.
    c.tick(-19_000);
    expect(
      deduper.check({ text: "set a reminder", source: "sarvam", utteranceId: "t2" }).pass,
    ).toBe(true);
    // An id means nothing to another source.
    expect(deduper.check({ text: "open notes", source: "local", utteranceId: "t1" }).pass).toBe(
      true,
    );
  });

  it("holds back a cloud caption final and the local final of the same words (no id on one side)", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(deduper.check({ text: "मेरा कैलेंडर दिखाओ", source: "sarvam", utteranceId: "a" }).pass).toBe(
      true,
    );
    c.tick(900);
    expect(deduper.check({ text: "मेरा कैलेंडर दिखाओ।", source: "local" }).pass).toBe(false);
  });

  it("never holds back an approval answer, and passes the same answer to a later prompt", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    deduper.check({ text: "yes" });
    c.tick(100);
    const answer = deduper.check({ text: "Yes.", approvalOpen: true });
    expect(answer.pass).toBe(true);
    if (answer.pass) expect(answer.approval).toBe(true);
    c.tick(100);
    expect(deduper.check({ text: "haan", approvalOpen: true }).pass).toBe(true);
    // A second prompt takes longer than a blink to sound: the same answer to it is a new answer.
    c.tick(APPROVAL_COPY_MS);
    expect(deduper.check({ text: "haan", approvalOpen: true }).pass).toBe(true);
  });

  it("holds back only a blink-fast copy of an approval answer, and not after a reply began", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(deduper.check({ text: "yes", approvalOpen: true }).pass).toBe(true);
    c.tick(APPROVAL_COPY_MS - 1);
    expect(deduper.check({ text: "yes", approvalOpen: true }).pass).toBe(false);
    c.tick(500);
    expect(
      deduper.check({ text: "yes", approvalOpen: true, replyStartedAt: c.now() - 100 }).pass,
    ).toBe(true);
  });

  it("passes an approval answer once per id: a retried copy of the same id is the same utterance", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(
      deduper.check({ text: "no", approvalOpen: true, source: "ipc", utteranceId: "9" }).pass,
    ).toBe(true);
    expect(
      deduper.check({ text: "no", approvalOpen: true, source: "ipc", utteranceId: "9" }).pass,
    ).toBe(false);
  });

  it("treats a long line under an open approval as an ordinary line", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    const long = Array.from({ length: APPROVAL_ANSWER_MAX_WORDS + 1 }, () => "yes").join(" ");
    expect(deduper.check({ text: long, approvalOpen: true }).pass).toBe(true);
    c.tick(100);
    expect(deduper.check({ text: long, approvalOpen: true }).pass).toBe(false);
  });

  it("never holds back a line the caller marks alwaysPass (a stop word said again)", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    expect(deduper.check({ text: "stop", alwaysPass: true }).pass).toBe(true);
    c.tick(50);
    const again = deduper.check({ text: "Stop!", alwaysPass: true });
    expect(again.pass).toBe(true);
    if (again.pass) expect(again.exempt).toBe(true);
  });

  it("passes text with nothing sayable and an empty line (other gates drop them)", () => {
    const deduper = createFinalDeduper({ now: () => 5 });
    expect(deduper.check({ text: "" }).pass).toBe(true);
    expect(deduper.check({ text: "  ...  " }).pass).toBe(true);
    expect(deduper.size()).toBe(0);
  });

  it("survives a clock that steps back and stays bounded", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    for (let i = 0; i < 200; i += 1) {
      c.tick(10);
      deduper.check({ text: `line number ${i} here` });
    }
    expect(deduper.size()).toBeLessThanOrEqual(24);
    c.tick(-600_000);
    expect(deduper.check({ text: "line number 199 here" }).pass).toBe(true);
  });

  it("reset forgets everything", () => {
    const c = clock();
    const deduper = createFinalDeduper({ now: c.now });
    deduper.check({ text: "good night" });
    deduper.reset();
    expect(deduper.check({ text: "good night" }).pass).toBe(true);
  });
});

describe("createFinalDeduper properties (fixed seeds)", () => {
  const WORDS = ["open", "close", "chrome", "notes", "खोलो", "बंद", "कैलेंडर", "yes", "time", "रुको"];
  const phrase = (rand: () => number) => {
    const n = 1 + Math.floor(rand() * 3);
    return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
  };

  for (const seed of [1, 7, 42, 2026, 31337]) {
    it(`seed ${seed}: the first copy always passes, no decision depends on punctuation or case`, () => {
      const rand = seeded(seed);
      const c = clock();
      const plain = createFinalDeduper({ now: c.now });
      const noisy = createFinalDeduper({ now: c.now });
      for (let i = 0; i < 300; i += 1) {
        c.tick(Math.floor(rand() * 3000));
        const text = phrase(rand);
        const a = plain.check({ text });
        const b = noisy.check({ text: ` ${text.toUpperCase()}!! ` });
        expect(b.pass).toBe(a.pass);
      }
    });

    it(`seed ${seed}: never holds back anything after the window, an approval answer, or a different text`, () => {
      const rand = seeded(seed);
      const c = clock();
      const deduper = createFinalDeduper({ now: c.now });
      const passedAt = new Map<string, number>();
      const approvedAt = new Map<string, number>();
      for (let i = 0; i < 400; i += 1) {
        c.tick(Math.floor(rand() * 7000));
        const text = phrase(rand);
        const approval = rand() < 0.2 && text.split(" ").length <= APPROVAL_ANSWER_MAX_WORDS;
        const key = finalTextKey(text);
        const before = passedAt.get(key);
        const insideWindow = before !== undefined && c.now() - before < FINAL_DEDUPE_WINDOW_MS;
        const approvedBefore = approvedAt.get(key);
        const blinkCopy =
          approvedBefore !== undefined && c.now() - approvedBefore < APPROVAL_COPY_MS;
        const verdict = deduper.check({ text, approvalOpen: approval });
        // The exact oracle: an approval answer is held back only as a blink-fast copy of an approval answer;
        // any other line only when the same words passed inside the window.
        expect(verdict.pass).toBe(approval ? !blinkCopy : !insideWindow);
        if (verdict.pass) {
          passedAt.set(key, c.now());
          if (approval) approvedAt.set(key, c.now());
        }
      }
    });

    it(`seed ${seed}: one utterance sent N times runs exactly one turn`, () => {
      const rand = seeded(seed);
      const c = clock();
      const deduper = createFinalDeduper({ now: c.now });
      for (let round = 0; round < 40; round += 1) {
        c.tick(FINAL_DEDUPE_WINDOW_MS + 1);
        const text = `${phrase(rand)} ${round}`;
        const copies = 1 + Math.floor(rand() * 6);
        let passed = 0;
        for (let k = 0; k < copies; k += 1) {
          c.tick(Math.floor(rand() * 500));
          if (deduper.check({ text }).pass) passed += 1;
        }
        expect(passed).toBe(1);
      }
    });
  }
});

describe("the single accept point in the conductor", () => {
  const source = read("src/lib/friday/assistant-mode.ts");
  const accept = source.slice(
    source.indexOf("private acceptFinalUtterance("),
    source.indexOf("private captionStt:"),
  );

  it("asks the deduper there, with a trace line, and keeps the older exact-repeat gate", () => {
    expect(accept).toContain("this.finalDeduper.check(");
    expect(accept).toContain("duplicateFinalUtterance");
    expect(accept).toMatch(/trace\(\s*"dropped",[^;]*duplicate finalized utterance/);
  });

  it("exempts a short answer while an approval is open, and passes the reply start time", () => {
    expect(accept).toMatch(/approvalOpen/);
    expect(accept).toContain("alwaysPass: this.isStopHeard(");
    expect(accept).toContain("replyStartedAt");
    expect(source).toMatch(/this\.replyStartedAt = Date\.now\(\)/);
  });

  it("is not reachable from a provisional transcript", () => {
    const from = source.indexOf("onVoicePartial?.(");
    expect(from).toBeGreaterThan(0);
    const provisional = source.slice(from, source.indexOf("this.startDraftRun(command);", from));
    expect(provisional.length).toBeGreaterThan(500);
    expect(provisional).not.toContain("finalDeduper");
    expect(provisional).not.toContain("acceptFinalUtterance");
  });
});
