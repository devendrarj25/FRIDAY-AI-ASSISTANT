/**
 * The backchannel gate (voice-engine/interruption-controller.ts): while FRIDAY speaks, the owner's voice only
 * lowers her volume until the recogniser's words show a real interruption. Pure rules, driven by a fake clock:
 * the table below is every case that matters (a nod, a real interruption, a stop word, a bare yes to an open
 * question, her own voice coming back, speech that resumes, noise, no words at all).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isFollowingAlong } from "../../src/lib/friday/voice-session";
import {
  DEFAULT_INTERRUPT_GATE,
  BACKCHANNEL_PHRASES,
  BACKCHANNEL_WORDS,
  InterruptGate,
  isBackchannel,
  isImmediateStop,
  sanitizeInterruptGate,
  type GateInput,
  type GateVerdict,
} from "../../src/lib/friday/voice-engine/interruption-controller";

const T0 = 10_000;

/** A gate begun at T0 whose VAD heard speech until `speechUntil`; returns the verdict at `at` for the given words. */
function verdictAt(
  at: number,
  rest: Partial<GateInput> & { speechUntil?: number },
  prefs = DEFAULT_INTERRUPT_GATE,
): GateVerdict {
  const gate = new InterruptGate(() => prefs);
  gate.begin(T0);
  const until = rest.speechUntil ?? T0;
  // The VAD is polled every 100 ms, as the live timer does; the last speech frame is recorded as it passes.
  for (let t = T0; t <= Math.min(until, at); t += 100) {
    gate.evaluate({ t, speechActive: true, text: null });
  }
  const { speechUntil: _unused, ...input } = rest;
  void _unused;
  return gate.evaluate({
    t: at,
    speechActive: at <= until,
    text: null,
    ...input,
  });
}

describe("the gate verdict table (fake clock, no audio)", () => {
  const cases: Array<{
    name: string;
    at: number;
    speechUntil?: number;
    input?: Partial<GateInput>;
    expected: GateVerdict;
  }> = [
    {
      name: "a bare voice with no words yet waits (volume stays down, nothing stops)",
      at: T0 + 300,
      speechUntil: T0 + 300,
      expected: { kind: "wait" },
    },
    {
      name: "a nod ('haan') heard as a partial waits; it is not counted as words",
      at: T0 + 600,
      speechUntil: T0 + 600,
      input: { text: "haan" },
      expected: { kind: "wait" },
    },
    {
      name: "a nod, final: the volume comes back at once",
      at: T0 + 900,
      speechUntil: T0 + 500,
      input: { text: "haan", final: true },
      expected: { kind: "restore", why: "backchannel" },
    },
    {
      name: "Hinglish 'theek hai', final: a nod",
      at: T0 + 900,
      speechUntil: T0 + 500,
      input: { text: "Theek hai.", final: true },
      expected: { kind: "restore", why: "backchannel" },
    },
    {
      name: "Hindi 'ठीक है', final: a nod",
      at: T0 + 900,
      speechUntil: T0 + 500,
      input: { text: "ठीक है", final: true },
      expected: { kind: "restore", why: "backchannel" },
    },
    {
      name: "a bare 'yes' with nothing asked is a nod",
      at: T0 + 900,
      speechUntil: T0 + 500,
      input: { text: "yes", final: true },
      expected: { kind: "restore", why: "backchannel" },
    },
    {
      name: "a bare 'yes' while an answer is awaited reaches the approval path at once",
      at: T0 + 150,
      speechUntil: T0 + 150,
      input: { text: "yes", waitingForAnswer: true },
      expected: { kind: "interrupt", why: "approval-answer" },
    },
    {
      name: "'haan' while an answer is awaited is the answer too",
      at: T0 + 150,
      speechUntil: T0 + 150,
      input: { text: "haan", waitingForAnswer: true },
      expected: { kind: "interrupt", why: "approval-answer" },
    },
    {
      name: "a real interruption: two real words after 400 ms of speech",
      at: T0 + 500,
      speechUntil: T0 + 500,
      input: { text: "open the report" },
      expected: { kind: "interrupt", why: "words" },
    },
    {
      name: "the same words before 400 ms of speech wait (a click that sounds like words is not enough)",
      at: T0 + 200,
      speechUntil: T0 + 200,
      input: { text: "open the report" },
      expected: { kind: "wait" },
    },
    {
      name: "one real word as a partial waits for more",
      at: T0 + 700,
      speechUntil: T0 + 700,
      input: { text: "report" },
      expected: { kind: "wait" },
    },
    {
      name: "one real word, final, is never dropped: it is a turn of its own, so she stops for it",
      at: T0 + 1500,
      speechUntil: T0 + 700,
      input: { text: "report", final: true },
      expected: { kind: "interrupt", why: "words" },
    },
    {
      name: "'wait' interrupts at once, before any duration",
      at: T0 + 50,
      speechUntil: T0 + 50,
      input: { text: "wait" },
      expected: { kind: "interrupt", why: "stop-word" },
    },
    {
      name: "'ruko' interrupts at once",
      at: T0 + 50,
      speechUntil: T0 + 50,
      input: { text: "ruko" },
      expected: { kind: "interrupt", why: "stop-word" },
    },
    {
      name: "'ek minute' interrupts at once",
      at: T0 + 50,
      speechUntil: T0 + 50,
      input: { text: "ek minute" },
      expected: { kind: "interrupt", why: "stop-word" },
    },
    {
      name: "'रुको' interrupts at once",
      at: T0 + 50,
      speechUntil: T0 + 50,
      input: { text: "रुको" },
      expected: { kind: "interrupt", why: "stop-word" },
    },
    {
      name: "'stop' interrupts at once",
      at: T0 + 50,
      speechUntil: T0 + 50,
      input: { text: "stop" },
      expected: { kind: "interrupt", why: "stop-word" },
    },
    {
      name: "her own voice coming back is never an interruption, however many words",
      at: T0 + 900,
      speechUntil: T0 + 900,
      input: { text: "the report is ready for you", selfEcho: true },
      expected: { kind: "wait" },
    },
    {
      name: "her own voice, final: the volume comes back",
      at: T0 + 1200,
      speechUntil: T0 + 900,
      input: { text: "the report is ready for you", selfEcho: true, final: true },
      expected: { kind: "restore", why: "echo" },
    },
    {
      name: "her own voice does not turn into a stop word or an approval answer",
      at: T0 + 100,
      speechUntil: T0 + 100,
      input: { text: "stop", selfEcho: true, waitingForAnswer: true },
      expected: { kind: "wait" },
    },
    {
      name: "a short noise burst (a cough) is judged false after the false-interruption timeout",
      at: T0 + 100 + DEFAULT_INTERRUPT_GATE.falseTimeoutMs,
      speechUntil: T0 + 100,
      expected: { kind: "restore", why: "noise" },
    },
    {
      name: "a short burst before the timeout still waits",
      at: T0 + 100 + DEFAULT_INTERRUPT_GATE.falseTimeoutMs - 1,
      speechUntil: T0 + 100,
      expected: { kind: "wait" },
    },
    {
      name: "real sound with no words yet waits for the final transcript past the false timeout",
      at: T0 + 600 + DEFAULT_INTERRUPT_GATE.falseTimeoutMs + 100,
      speechUntil: T0 + 600,
      expected: { kind: "wait" },
    },
    {
      name: "real sound and no transcript ever: after the final wait the volume comes back",
      at: T0 + 600 + DEFAULT_INTERRUPT_GATE.finalWaitMs,
      speechUntil: T0 + 600,
      expected: { kind: "restore", why: "silence" },
    },
    {
      name: "speech that goes on with no word from the recogniser at all is treated as real",
      at: T0 + DEFAULT_INTERRUPT_GATE.noWordsEscalateMs,
      speechUntil: T0 + DEFAULT_INTERRUPT_GATE.noWordsEscalateMs,
      expected: { kind: "interrupt", why: "long-speech" },
    },
    {
      name: "long speech that the recogniser says is her own echo is not treated as real",
      at: T0 + DEFAULT_INTERRUPT_GATE.noWordsEscalateMs + 500,
      speechUntil: T0 + DEFAULT_INTERRUPT_GATE.noWordsEscalateMs + 500,
      input: { text: "that is what I said", selfEcho: true },
      expected: { kind: "wait" },
    },
  ];

  for (const row of cases) {
    it(row.name, () => {
      expect(
        verdictAt(row.at, {
          ...(row.input ?? {}),
          ...(row.speechUntil ? { speechUntil: row.speechUntil } : {}),
        }),
      ).toEqual(row.expected);
    });
  }

  it("the thresholds are config: minWords 3 keeps two words waiting, minDuration 1000 delays the words", () => {
    const three = { ...DEFAULT_INTERRUPT_GATE, minWords: 3 };
    expect(verdictAt(T0 + 600, { speechUntil: T0 + 600, text: "open it" }, three)).toEqual({
      kind: "wait",
    });
    expect(verdictAt(T0 + 600, { speechUntil: T0 + 600, text: "open it now" }, three)).toEqual({
      kind: "interrupt",
      why: "words",
    });
    const slow = { ...DEFAULT_INTERRUPT_GATE, minDurationMs: 1000 };
    expect(verdictAt(T0 + 600, { speechUntil: T0 + 600, text: "open the report" }, slow)).toEqual({
      kind: "wait",
    });
    expect(verdictAt(T0 + 1000, { speechUntil: T0 + 1000, text: "open the report" }, slow)).toEqual(
      { kind: "interrupt", why: "words" },
    );
  });

  it("speech that resumes inside the timeout keeps the candidate alive; silence restarts the clock", () => {
    const gate = new InterruptGate(() => DEFAULT_INTERRUPT_GATE);
    gate.begin(T0);
    gate.evaluate({ t: T0 + 100, speechActive: true, text: null });
    // 1000 ms of silence is under the 1200 ms timeout.
    expect(gate.evaluate({ t: T0 + 1100, speechActive: false, text: null })).toEqual({
      kind: "wait",
    });
    // The voice comes back: the silence clock starts again from here.
    expect(gate.evaluate({ t: T0 + 1150, speechActive: true, text: null })).toEqual({
      kind: "wait",
    });
    expect(gate.evaluate({ t: T0 + 2300, speechActive: false, text: null })).toEqual({
      kind: "wait",
    });
  });

  it("an inactive gate waits and a second begin() does not restart the candidate", () => {
    const gate = new InterruptGate();
    expect(gate.evaluate({ t: 0, speechActive: true, text: "stop" })).toEqual({ kind: "wait" });
    gate.begin(T0);
    gate.evaluate({ t: T0 + 100, speechActive: true, text: null });
    gate.begin(T0 + 300);
    // Only time the voice was really heard counts: the second begin() neither restarts nor adds the silent gap.
    expect(gate.speechMs()).toBe(100);
    gate.evaluate({ t: T0 + 400, speechActive: true, text: null });
    expect(gate.speechMs()).toBe(200);
    gate.end();
    expect(gate.active).toBe(false);
  });

  it("the gate takes no speaker input: a voice match cannot approve, interrupt or release anything", () => {
    const gate = new InterruptGate(() => DEFAULT_INTERRUPT_GATE);
    gate.begin(T0);
    const input = {
      t: T0 + 500,
      speechActive: true,
      text: "open the report",
      speaker: "owner",
    } as GateInput;
    // Extra fields are ignored: the verdict is the same as without them.
    expect(gate.evaluate(input)).toEqual(
      gate.evaluate({ ...input, speaker: undefined } as GateInput),
    );
  });
});

describe("what counts as a nod and what always stops her", () => {
  it.each([
    "hmm",
    "mm",
    "mhm",
    "hmmmm",
    "haan",
    "haan ji",
    "ha",
    "ji",
    "okay",
    "ok",
    "ok ok",
    "theek hai",
    "thik hai ji",
    "accha",
    "right",
    "yes",
    "ho gaya",
    "ठीक है",
    "हाँ",
    "हम्म",
    "Hmm.",
  ])("%s is a backchannel", (word) => {
    expect(isBackchannel(word)).toBe(true);
  });

  it.each([
    "open the report",
    "haan but wait a second please",
    "nahi",
    "kya hua",
    "ok so what about the rest",
    "",
    "   ",
  ])("%j is not a backchannel", (word) => {
    expect(isBackchannel(word)).toBe(false);
  });

  it.each([
    "stop",
    "Stop it",
    "wait",
    "wait a second",
    "ruko",
    "ruk jao",
    "ek minute",
    "ek second ruko",
    "one second",
    "hold on",
    "hey friday stop",
    "रुको",
    "एक मिनट",
    "बस",
  ])("%s always interrupts", (words) => {
    expect(isImmediateStop(words)).toBe(true);
  });

  it.each(["haan", "okay", "open the report", "tell me about the weather", "yes"])(
    "%s is not a stop word",
    (words) => {
      expect(isImmediateStop(words)).toBe(false);
    },
  );
});

describe("the gate settings are safe whatever was stored", () => {
  it("defaults: on, 400 ms, 2 words, 1200 ms", () => {
    expect(DEFAULT_INTERRUPT_GATE).toEqual({
      enabled: true,
      minDurationMs: 400,
      minWords: 2,
      falseTimeoutMs: 1200,
      pauseAfterMs: 600,
      noWordsEscalateMs: 2500,
      finalWaitMs: 4000,
      duckLevel: 0.3,
    });
    expect(sanitizeInterruptGate(undefined)).toEqual(DEFAULT_INTERRUPT_GATE);
    expect(sanitizeInterruptGate(null)).toEqual(DEFAULT_INTERRUPT_GATE);
    expect(sanitizeInterruptGate("on")).toEqual(DEFAULT_INTERRUPT_GATE);
  });

  it("a stored shape with odd values is clamped, and off stays off", () => {
    expect(
      sanitizeInterruptGate({
        enabled: false,
        minDurationMs: -5,
        minWords: 99,
        falseTimeoutMs: "x",
      }),
    ).toEqual({
      ...DEFAULT_INTERRUPT_GATE,
      enabled: false,
      minDurationMs: 100,
      minWords: 6,
    });
    expect(sanitizeInterruptGate({ minDurationMs: 99999, falseTimeoutMs: 1 })).toMatchObject({
      enabled: true,
      minDurationMs: 3000,
      falseTimeoutMs: 400,
    });
    expect(sanitizeInterruptGate({ enabled: "yes" }).enabled).toBe(false);
    expect(sanitizeInterruptGate({ minWords: Number.NaN }).minWords).toBe(2);
  });
});

describe("review fixes: one-word interruptions, pause on voice, bounded settings", () => {
  const finalVerdict = (text: string): GateVerdict =>
    verdictAt(T0 + 1500, { speechUntil: T0 + 500, text, final: true });

  it.each([
    "no",
    "nope",
    "nahi",
    "nahin",
    "cancel",
    "galat",
    "नहीं",
    "No no",
    "nahi nahi",
    "cancel it",
  ])("%s is a stop word: she stops at once, even with nothing asked", (word) => {
    expect(isImmediateStop(word)).toBe(true);
    expect(verdictAt(T0 + 50, { speechUntil: T0 + 50, text: word })).toEqual({
      kind: "interrupt",
      why: "stop-word",
    });
  });

  it.each(["no problem at all", "nahi to kya hua", "cancel culture is odd"])(
    "%s is not the one-word refusal: a longer line keeps waiting for the rule on words",
    (line) => {
      expect(isImmediateStop(line)).toBe(false);
    },
  );

  it.each(["kya", "report", "wapas", "ruk", "kyun", "सुनो"])(
    "a final single word that is not a nod (%s) is a turn: never silently dropped",
    (word) => {
      expect(finalVerdict(word).kind).toBe("interrupt");
    },
  );

  it.each(["hmm", "haan", "ok", "theek hai", "yes", "हम्म"])(
    "a pure nod (%s) still only restores her volume",
    (word) => {
      expect(finalVerdict(word)).toEqual({ kind: "restore", why: "backchannel" });
    },
  );

  it("her own voice, final, is dropped and restores, however many words", () => {
    expect(
      verdictAt(T0 + 1500, { speechUntil: T0 + 500, text: "kya", final: true, selfEcho: true }),
    ).toEqual({ kind: "restore", why: "echo" });
  });

  it("voice that goes on for pauseAfterMs pauses her once; the decision is left to the words", () => {
    const gate = new InterruptGate(() => DEFAULT_INTERRUPT_GATE);
    gate.begin(T0);
    const seen: string[] = [];
    for (let t = T0; t <= T0 + 1500; t += 100) {
      const v = gate.evaluate({ t, speechActive: true, text: null });
      if (v.kind !== "wait") seen.push(`${t - T0}:${v.kind}`);
    }
    expect(seen).toEqual(["600:pause"]);
  });

  it("no pause for a nod, for her own echo, or for a voice that stopped before pauseAfterMs", () => {
    const run = (text: string | null, selfEcho: boolean, until: number) => {
      const gate = new InterruptGate(() => DEFAULT_INTERRUPT_GATE);
      gate.begin(T0);
      const kinds = new Set<string>();
      for (let t = T0; t <= T0 + 1500; t += 100) {
        kinds.add(gate.evaluate({ t, speechActive: t <= until, text, selfEcho }).kind);
      }
      return kinds.has("pause");
    };
    expect(run("haan", false, T0 + 1500)).toBe(false);
    expect(run("the report is ready", true, T0 + 1500)).toBe(false);
    expect(run(null, false, T0 + 400)).toBe(false);
    expect(run(null, false, T0 + 1500)).toBe(true);
  });

  it("pauseAfterMs 0 turns the pause off (the voice then only ducks until the words decide)", () => {
    const gate = new InterruptGate(() => ({ ...DEFAULT_INTERRUPT_GATE, pauseAfterMs: 0 }));
    gate.begin(T0);
    for (let t = T0; t <= T0 + 1500; t += 100) {
      expect(gate.evaluate({ t, speechActive: true, text: null }).kind).toBe("wait");
    }
  });

  it("the thresholds that were constants are settings with bounds", () => {
    const wild = sanitizeInterruptGate({
      pauseAfterMs: -1,
      noWordsEscalateMs: 1,
      finalWaitMs: 9e9,
      duckLevel: 5,
    });
    expect(wild).toMatchObject({
      pauseAfterMs: 0,
      noWordsEscalateMs: 1000,
      finalWaitMs: 15_000,
      duckLevel: 0.8,
    });
    expect(sanitizeInterruptGate({ duckLevel: 0 }).duckLevel).toBe(0.05);
    expect(sanitizeInterruptGate({ duckLevel: "loud" }).duckLevel).toBe(0.3);
    const slow = { ...DEFAULT_INTERRUPT_GATE, noWordsEscalateMs: 5000 };
    expect(verdictAt(T0 + 3000, { speechUntil: T0 + 3000 }, slow).kind).not.toBe("interrupt");
    expect(verdictAt(T0 + 5000, { speechUntil: T0 + 5000 }, slow)).toEqual({
      kind: "interrupt",
      why: "long-speech",
    });
  });

  it("the following-along check of voice-session is built on the same list", () => {
    for (const nod of [...BACKCHANNEL_WORDS, ...BACKCHANNEL_PHRASES]) {
      expect(isFollowingAlong(nod), nod).toBe(true);
    }
    for (const keep of ["go on", "carry on", "continue", "aage bolo", "jaari rakho"]) {
      expect(isFollowingAlong(keep), keep).toBe(true);
    }
    expect(isFollowingAlong("open the report")).toBe(false);
    expect(
      readFileSync(resolve(import.meta.dirname, "../../src/lib/friday/voice-session.ts"), "utf8"),
    ).not.toMatch(/const FOLLOWING_ALONG/);
  });

  it("one list of nods serves the gate and the following-along check", () => {
    for (const nod of BACKCHANNEL_WORDS) {
      expect(isBackchannel(nod), nod).toBe(true);
    }
    expect(BACKCHANNEL_WORDS).toEqual(expect.arrayContaining(["hmm", "haan", "ji", "ok", "accha"]));
  });
});
