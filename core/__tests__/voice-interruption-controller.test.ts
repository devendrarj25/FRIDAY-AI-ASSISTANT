import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as controller from "../../src/lib/friday/voice-engine/interruption-controller";
import {
  BACKCHANNEL_RUN_MAX_MS,
  BACKCHANNEL_RUN_MAX_WORDS,
  INTERRUPT_STOP_PHRASES,
  MIN_INTERRUPT_VOICE_MS,
  NO_WORDS_TAKEOVER_MS,
  OWN_ECHO_GUARD_MS,
  TAKEOVER_VOICE_MS,
  TAKEOVER_WORDS,
  bargeFromController,
  classifyInterruption,
  type InterruptionInput,
} from "../../src/lib/friday/voice-engine/interruption-controller";
import { BACKCHANNEL_WORDS } from "../../src/lib/friday/voice-engine/hinglish-lexicon";
import {
  FRAME_MS,
  createTurnEngine,
  step,
  type TurnCommand,
  type TurnEngineState,
  type TurnInput,
} from "../../src/lib/friday/voice-engine/turn-engine";

const base: InterruptionInput = {
  words: [],
  voiceMs: 600,
  vadP: 0.9,
  ttsPlaying: true,
  playedMs: 1500,
  echoClean: true,
  scene: "quiet",
  speaker: "owner",
  sinceTtsStartMs: 1500,
};
const judge = (over: Partial<InterruptionInput>) => classifyInterruption({ ...base, ...over });
const decide = (over: Partial<InterruptionInput>) => judge(over).decision;
const say = (line: string, over: Partial<InterruptionInput> = {}) =>
  decide({ words: line.split(" "), voiceMs: 400, ...over });

describe("interruption classifier: named thresholds", () => {
  it("carries the planned numbers", () => {
    expect(MIN_INTERRUPT_VOICE_MS).toBe(500);
    expect(NO_WORDS_TAKEOVER_MS).toBe(2000);
    expect(TAKEOVER_WORDS).toBe(3);
    expect(TAKEOVER_VOICE_MS).toBe(1000);
    expect(BACKCHANNEL_RUN_MAX_WORDS).toBe(4);
    expect(BACKCHANNEL_RUN_MAX_MS).toBe(1500);
    expect(OWN_ECHO_GUARD_MS).toBe(300);
  });

  it("the stop list is closed and holds the Hinglish, English and Devanagari words", () => {
    expect([...INTERRUPT_STOP_PHRASES].sort()).toEqual(
      [
        "ruko",
        "rukiye",
        "stop",
        "nahi nahi",
        "wait",
        "ek minute",
        "ek second",
        "sunna",
        "suno",
        "bas",
        "chup",
        "hold on",
        "रुको",
        "बस",
        "चुप",
        "सुनो",
      ].sort(),
    );
    expect(Object.isFrozen(INTERRUPT_STOP_PHRASES)).toBe(true);
  });
});

describe("interruption classifier: voice without words", () => {
  it("a short sound with no words (< 500 ms) is ignored", () => {
    expect(judge({ voiceMs: 499 })).toMatchObject({ decision: "ignore", reason: "too-short" });
    expect(decide({ voiceMs: 0 })).toBe("ignore");
  });

  it("voice from 500 ms with no words yet keeps her talking, ducked, while the words are pending", () => {
    expect(judge({ voiceMs: 500 })).toMatchObject({ decision: "keep", reason: "words-pending" });
    expect(decide({ voiceMs: 1999 })).toBe("keep");
  });

  it("2 s of echo-clean voice without words takes over", () => {
    expect(judge({ voiceMs: 2000 })).toMatchObject({
      decision: "takeover",
      reason: "long-voice",
    });
  });

  it("2 s of voice that is not echo-clean never takes over", () => {
    expect(decide({ voiceMs: 2500, echoClean: false })).toBe("keep");
  });

  it("a weak voice probability is ignored", () => {
    expect(judge({ vadP: 0.3, voiceMs: 3000 })).toMatchObject({
      decision: "ignore",
      reason: "weak-voice",
    });
    expect(decide({ vadP: Number.NaN, voiceMs: 3000 })).toBe("ignore");
  });

  it("nothing playing means nothing to interrupt", () => {
    expect(judge({ ttsPlaying: false, words: ["ruko"] })).toMatchObject({
      decision: "ignore",
      reason: "not-speaking",
    });
  });
});

describe("interruption classifier: stop words take over at once", () => {
  for (const line of [
    "ruko",
    "rukiye",
    "stop",
    "wait",
    "bas",
    "chup",
    "suno",
    "sunna",
    "nahi nahi",
    "ek minute",
    "ek second",
    "hold on",
  ]) {
    it(`"${line}" takes over even when short`, () => {
      expect(judge({ words: line.split(" "), voiceMs: 200 })).toMatchObject({
        decision: "takeover",
        reason: "stop-word",
      });
    });
  }

  it("Devanagari stop words take over", () => {
    for (const w of ["रुको", "बस", "चुप", "सुनो"]) expect(say(w)).toBe("takeover");
  });

  it("a stop word inside a line, in any case and with punctuation, takes over", () => {
    expect(say("Arre, RUKO!")).toBe("takeover");
    expect(say("haan wait")).toBe("takeover");
    expect(say("okay hold on.")).toBe("takeover");
  });

  it("a phrase only counts as its words together: 'ek' alone or 'hold' alone is not a stop", () => {
    expect(say("ek")).toBe("keep");
    expect(say("hold")).toBe("keep");
    expect(say("nahi")).toBe("keep");
  });

  it("a stop word wins on a TV scene and from another voice", () => {
    expect(say("ruko", { scene: "tv", speaker: "unknown" })).toBe("takeover");
    expect(say("stop", { speaker: "other" })).toBe("takeover");
  });
});

describe("interruption classifier: backchannels keep her talking", () => {
  it("'haan' keeps her talking, ducked, never stopped", () => {
    expect(judge({ words: ["haan"], voiceMs: 300 })).toMatchObject({
      decision: "keep",
      reason: "backchannel",
    });
  });

  it("every lexicon backchannel word alone is a keep", () => {
    for (const w of BACKCHANNEL_WORDS) expect(say(w)).toBe("keep");
  });

  it("'haan haan theek hai' (4 words, 1200 ms) stays a keep", () => {
    expect(judge({ words: ["haan", "haan", "theek", "hai"], voiceMs: 1200 })).toMatchObject({
      decision: "keep",
      reason: "backchannel",
    });
    expect(say("हाँ जी ठीक है", { voiceMs: 1400 })).toBe("keep");
    expect(say("hmmm ok", { voiceMs: 900 })).toBe("keep");
  });

  it("a backchannel run past 4 words or 1500 ms takes over", () => {
    expect(say("haan haan haan theek hai", { voiceMs: 1200 })).toBe("takeover");
    expect(say("haan theek hai", { voiceMs: 1500 })).toBe("takeover");
  });

  it("'hai' alone is not a nod", () => {
    expect(judge({ words: ["hai"], voiceMs: 300 })).toMatchObject({ reason: "few-words" });
  });
});

describe("interruption classifier: real speech", () => {
  it("3 or more words take over", () => {
    expect(judge({ words: ["open", "the", "sheet"], voiceMs: 600 })).toMatchObject({
      decision: "takeover",
      reason: "enough-words",
    });
  });

  it("1 s of voice with words takes over", () => {
    expect(judge({ words: ["actually"], voiceMs: 1000 })).toMatchObject({
      decision: "takeover",
      reason: "long-words",
    });
  });

  it("one or two plain words under 1 s keep her ducked until more come", () => {
    expect(judge({ words: ["actually"], voiceMs: 600 })).toMatchObject({
      decision: "keep",
      reason: "few-words",
    });
    expect(say("kal ka")).toBe("keep");
  });

  it("empty and blank words count as no words", () => {
    expect(decide({ words: ["", " ", "...", "!"], voiceMs: 300 })).toBe("ignore");
  });
});

describe("interruption classifier: TV, music and other voices", () => {
  it("a TV or music scene with an unknown or other voice is ignored, however long", () => {
    for (const scene of ["tv", "music"] as const) {
      for (const speaker of ["other", "unknown", "none"] as const) {
        expect(
          judge({ scene, speaker, words: ["the", "news", "tonight", "is"], voiceMs: 3000 }),
        ).toMatchObject({ decision: "ignore", reason: "background-media" });
        expect(decide({ scene, speaker, voiceMs: 4000 })).toBe("ignore");
      }
    }
  });

  it("the owner talking over a TV still takes over", () => {
    expect(say("open the sheet", { scene: "tv", speaker: "owner" })).toBe("takeover");
  });

  it("another voice alone never takes over without a stop word", () => {
    for (const scene of ["quiet", "noise", "speech"] as const) {
      expect(
        judge({ scene, speaker: "other", words: ["open", "the", "sheet"], voiceMs: 3000 }),
      ).toMatchObject({ decision: "keep", reason: "other-voice" });
      expect(decide({ scene, speaker: "other", voiceMs: 3000 })).not.toBe("takeover");
    }
  });

  it("a speaker verdict only blocks: 'owner' grants nothing 'unknown' does not", () => {
    const grid: Partial<InterruptionInput>[] = [
      { words: [], voiceMs: 2500 },
      { words: ["haan"], voiceMs: 300 },
      { words: ["open", "the", "sheet"], voiceMs: 800 },
      { words: ["actually"], voiceMs: 600 },
    ];
    for (const g of grid)
      expect(decide({ ...g, speaker: "owner" })).toBe(decide({ ...g, speaker: "unknown" }));
  });
});

describe("interruption classifier: own echo", () => {
  it("in the first 300 ms of her reply, a voice that is not echo-clean is her own echo", () => {
    expect(
      judge({ playedMs: 200, sinceTtsStartMs: 200, echoClean: false, words: ["stop"] }),
    ).toMatchObject({ decision: "ignore", reason: "own-echo" });
  });

  it("an echo-clean voice early in the reply is judged as usual", () => {
    expect(say("ruko", { playedMs: 100, sinceTtsStartMs: 100 })).toBe("takeover");
  });

  it("after 300 ms the echo guard is off", () => {
    expect(say("ruko", { playedMs: 300, sinceTtsStartMs: 300, echoClean: false })).toBe("takeover");
  });
});

describe("interruption classifier: shape, safety and purity", () => {
  it("returns only decision, reason and confidence, with confidence in 0..1", () => {
    const r = judge({ words: ["ruko"] });
    expect(Object.keys(r).sort()).toEqual(["confidence", "decision", "reason"]);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("has no path that approves anything", () => {
    const speakers = ["owner", "other", "unknown", "none"] as const;
    const scenes = ["quiet", "tv", "music", "noise", "speech"] as const;
    const lines = [[], ["haan"], ["yes"], ["haan", "ji", "kar", "do"], ["ruko"], ["approve", "it"]];
    for (const speaker of speakers)
      for (const scene of scenes)
        for (const words of lines)
          for (const voiceMs of [0, 700, 1200, 2500]) {
            const r = judge({ speaker, scene, words, voiceMs });
            expect(["keep", "takeover", "ignore"]).toContain(r.decision);
            expect(JSON.stringify(r)).not.toMatch(/approv|allow|grant|confirm/i);
          }
  });

  it("the module exports nothing that speaks or makes a backchannel", () => {
    for (const name of Object.keys(controller)) {
      expect(name).not.toMatch(
        /^(speak|say|utter|play|generate|emit)|backchannel(guard|gen|speak|say)/i,
      );
    }
  });

  it("is deterministic and leaves its input untouched", () => {
    const input = Object.freeze({
      ...base,
      words: Object.freeze(["haan", "theek", "hai"]) as unknown as string[],
    });
    const a = classifyInterruption(input);
    const b = classifyInterruption(input);
    expect(a).toEqual(b);
    expect(input.words).toEqual(["haan", "theek", "hai"]);
  });

  it("odd input is read safely", () => {
    const odd = {
      ...base,
      words: [7, null, "ruko"] as unknown as string[],
      voiceMs: Number.NaN,
      scene: "stadium" as unknown as InterruptionInput["scene"],
      speaker: "robot" as unknown as InterruptionInput["speaker"],
    };
    expect(classifyInterruption(odd).decision).toBe("takeover");
    expect(
      classifyInterruption({ ...base, words: "ruko" as unknown as string[], voiceMs: 100 })
        .decision,
    ).toBe("ignore");
  });

  it("the new rules hold no timer and no DOM", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/lib/friday/voice-engine/interruption-controller.ts"),
      "utf8",
    );
    const section = src.slice(src.indexOf("export const INTERRUPT_STOP_PHRASES"));
    expect(section).not.toMatch(/setTimeout|setInterval|Date\.now|window\.|document\./);
  });
});

// ── The adapter plugged into the turn engine ────────────────────────────────────────────────────────────────

const at = (frame: number) => frame * FRAME_MS;
const ear = (
  frame: number,
  event: "start" | "partial",
  text: string,
  turnId = "t1",
): TurnInput => ({
  t: at(frame),
  k: "ear",
  turn: { turnId, event, text, vadP: null, speechMs: null },
});
const tick = (frame: number): TurnInput => ({ t: at(frame), k: "tick" });
const vad = (frame: number, p = 0.9): TurnInput => ({ t: at(frame), k: "vad", p, echoClean: true });
const firstAudio = (frame: number): TurnInput => ({
  t: at(frame),
  k: "tts",
  ev: "first-audio",
  utteranceId: "u1",
  playedMs: 0,
});

function run(start: TurnEngineState, inputs: TurnInput[]) {
  let s = start;
  const commands: { frame: number; c: TurnCommand }[] = [];
  for (const input of inputs) {
    const out = step(s, input);
    s = out.state;
    for (const c of out.commands) commands.push({ frame: Math.floor(input.t / FRAME_MS), c });
  }
  return { s, commands };
}

function speakingWith(ctx: { words: string[]; voiceMs: number }) {
  const engine = createTurnEngine({ handsFree: true, barge: bargeFromController(() => ctx) });
  return run(engine, [
    ear(0, "start", "hello"),
    ear(10, "partial", "hello there"),
    tick(16),
    firstAudio(17),
  ]);
}

describe("bargeFromController in the turn engine", () => {
  it("a stop word yields at its frame and the new turn stops speech for good", () => {
    const sp = speakingWith({ words: ["ruko"], voiceMs: 300 });
    expect(sp.s.state).toBe("speak");
    const out = run(sp.s, [vad(20), ear(21, "start", "ruko", "t2")]);
    expect(out.commands).toEqual([
      { frame: 20, c: { k: "duck", db: -12 } },
      { frame: 21, c: { k: "stop-speech", reason: "takeover", resumable: false } },
    ]);
    expect(out.s.state).toBe("listen");
  });

  it("a backchannel ducks her once and never stops her", () => {
    const sp = speakingWith({ words: ["haan"], voiceMs: 300 });
    const out = run(sp.s, [vad(20), vad(21), ear(21, "start", "haan", "t2"), tick(30)]);
    expect(out.s.state).toBe("speak");
    // Ducked while she hears the nod, full volume again after the quiet frames; never a stop.
    expect(out.commands.map((x) => x.c.k)).toEqual(["duck", "resume-speech"]);
    expect(out.commands.some((x) => x.c.k === "stop-speech")).toBe(false);
  });

  it("a short click with no words does nothing at all", () => {
    const sp = speakingWith({ words: [], voiceMs: 100 });
    const out = run(sp.s, [vad(20)]);
    expect(out.s.state).toBe("speak");
    expect(out.commands).toEqual([]);
  });

  it("the engine's own probability and played ms win over the context", () => {
    const barge = bargeFromController(() => ({
      words: ["ruko"],
      vadP: 1,
      playedMs: 99_999,
      echoClean: false,
    }));
    expect(barge(0.2, 500)).toBe("ignore"); // weak voice, whatever the context says
    expect(barge(0.9, 50)).toBe("ignore"); // own echo: the engine's 50 ms played is used
    expect(barge(0.9, 500)).toBe("takeover");
  });

  it("defaults to a playing, echo-clean, quiet scene with an unknown speaker", () => {
    const barge = bargeFromController(() => ({}));
    expect(barge(0.9, 1000)).toBe("ignore");
    expect(bargeFromController(() => ({ voiceMs: 2000 }))(0.9, 1000)).toBe("takeover");
    expect(bargeFromController(() => ({ scene: "tv", voiceMs: 3000 }))(0.9, 1000)).toBe("ignore");
  });
});
