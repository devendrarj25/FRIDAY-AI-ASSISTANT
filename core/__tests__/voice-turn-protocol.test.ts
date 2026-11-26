/**
 * The turn protocol of the streaming ear and the barge-in ladder: pure rules with a fake bridge and explicit
 * timestamps (no timers, no microphone, no speaker). The conductor's live behaviour is pinned in
 * voice-barge-gate-live.test.ts; here the parts that carry no I/O.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTurnRecord,
  languageMix,
  parseStreamTurn,
  sameWords,
  subscribeStreamTurns,
  SttStreamSession,
  TurnTracker,
  TURN_FACTS_TTL_MS,
  type StreamBridge,
  type StreamTurn,
} from "../../src/lib/friday/voice-engine/stream-session";
import {
  BARGE_LADDER,
  BargeLadder,
  DEFAULT_INTERRUPT_GATE,
  dbToGain,
  inBackchannelWindow,
  interruptedPlayedMs,
  sanitizeInterruptGate,
  type LadderInput,
} from "../../src/lib/friday/voice-engine/interruption-controller";

const root = resolve(__dirname, "../..");

const turn = (event: StreamTurn["event"], text = "", turnId = "t1", extra = {}): StreamTurn => ({
  turnId,
  event,
  text,
  vadP: 0.9,
  speechMs: 400,
  ...extra,
});

describe("turn protocol: parsing", () => {
  it("reads the full shape and keeps env, speaker and clipped only when they are well formed", () => {
    const parsed = parseStreamTurn({
      turnId: "t1",
      event: "eager",
      text: "kal ka mausam",
      vadP: 0.82,
      speechMs: 1400,
      env: { kind: "tv", score: 0.7 },
      speaker: { tag: "other", score: 0.2 },
      clipped: true,
    });
    expect(parsed).toEqual({
      turnId: "t1",
      event: "eager",
      text: "kal ka mausam",
      vadP: 0.82,
      speechMs: 1400,
      env: { kind: "tv", score: 0.7 },
      speaker: { tag: "other", score: 0.2 },
      clipped: true,
    });
    const odd = parseStreamTurn({
      turnId: "t2",
      event: "partial",
      env: { kind: "radio", score: 1 },
      speaker: { tag: "owner" },
      clipped: "yes",
    });
    expect(odd).toEqual({ turnId: "t2", event: "partial", text: "", vadP: null, speechMs: null });
  });

  it.each([null, undefined, "start", 7, [], { event: "start" }, { turnId: "x", event: "begin" }])(
    "%j is no turn",
    (raw) => {
      expect(parseStreamTurn(raw)).toBeNull();
    },
  );
});

describe("turn protocol: the session hands the events on", () => {
  function bridgeWith(replies: Array<Record<string, unknown>>): StreamBridge {
    let n = 0;
    return {
      openSttStream: async () => ({ ok: true, streamId: "s1", engine: "stream-ear", chunkMs: 80 }),
      feedSttStream: async () => ({ ok: true, ...(replies[n++] ?? {}) }),
      closeSttStream: async () => ({ ok: true, text: "done" }),
    };
  }
  const second = new Float32Array(1280).fill(0.2);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("a native `turn` goes to onTurn and to every subscriber, and no turn is made up beside it", async () => {
    const seen: StreamTurn[] = [];
    const heard: StreamTurn[] = [];
    const off = subscribeStreamTurns((t) => heard.push(t));
    const session = new SttStreamSession({
      bridge: bridgeWith([
        {
          turn: { turnId: "n1", event: "eager", text: "open the report" },
          events: [{ type: "partial", text: "open the report" }],
        },
      ]),
      onTurn: (t) => seen.push(t),
    });
    await session.open({ streamEngine: "auto", locale: "en" });
    session.push(second);
    await flush();
    off();
    expect(seen.map((t) => [t.turnId, t.event])).toEqual([["n1", "eager"]]);
    expect(heard).toEqual(seen);
  });

  it("an ear without `turn` still gets start, partial, end and resumed from its own events", async () => {
    const seen: StreamTurn[] = [];
    const session = new SttStreamSession({
      bridge: bridgeWith([
        { events: [{ type: "partial", text: "kal subah" }] },
        { events: [{ type: "endpoint", event: "EndOfTurn", reason: "silence" }] },
        { events: [{ type: "endpoint", event: "TurnResumed" }] },
      ]),
      onTurn: (t) => seen.push(t),
    });
    await session.open({ streamEngine: "auto", locale: "hi-en" });
    for (let i = 0; i < 3; i += 1) {
      session.push(second);
      await flush();
    }
    expect(seen.map((t) => t.event)).toEqual(["start", "partial", "end", "resumed"]);
    expect(new Set(seen.map((t) => t.turnId)).size).toBe(1);
    expect(seen[2]?.text).toBe("kal subah");
    expect(session.endOfTurn).toBe(false);
  });

  it("once the ear sends a real `turn`, the endpoint events no longer make turns of their own", async () => {
    const seen: StreamTurn[] = [];
    const session = new SttStreamSession({
      bridge: bridgeWith([
        { turn: { turnId: "n1", event: "start" }, events: [] },
        { events: [{ type: "endpoint", event: "EndOfTurn" }] },
      ]),
      onTurn: (t) => seen.push(t),
    });
    await session.open({ streamEngine: "auto", locale: "en" });
    for (let i = 0; i < 2; i += 1) {
      session.push(second);
      await flush();
    }
    expect(seen.map((t) => t.event)).toEqual(["start"]);
    expect(session.endOfTurn).toBe(true);
  });

  it("a throwing listener never breaks the stream", async () => {
    const off = subscribeStreamTurns(() => {
      throw new Error("boom");
    });
    const session = new SttStreamSession({
      bridge: bridgeWith([{ turn: { turnId: "n1", event: "start" } }]),
      onTurn: () => {
        throw new Error("boom");
      },
    });
    await session.open({ streamEngine: "auto", locale: "en" });
    session.push(second);
    await flush();
    off();
    expect(session.state).toBe("open");
  });
});

describe("turn protocol: the dictation session passes onTurn through", () => {
  const stt = readFileSync(
    resolve(import.meta.dirname, "../../src/lib/friday/voice-stt.ts"),
    "utf8",
  );
  const open = stt.slice(stt.indexOf("private openStream()"));

  it("builds the stream session with an onTurn that is dropped once the session is replaced", () => {
    const build = open.slice(0, open.indexOf("onFallback"));
    expect(build).toMatch(
      /onTurn:\s*\(turn\)\s*=>\s*\{\s*if \(this\.streamSession === session\) this\.options\.onStreamTurn\?\.\(turn\)/,
    );
  });

  it("keeps the global subscription: the conductor still listens through subscribeStreamTurns", () => {
    const mode = readFileSync(
      resolve(import.meta.dirname, "../../src/lib/friday/assistant-mode.ts"),
      "utf8",
    );
    expect(mode).toContain("subscribeStreamTurns((turn) => this.noteStreamTurn(turn))");
  });

  it("onTurn and the global listeners both see the same turn", async () => {
    const seen: StreamTurn[] = [];
    const heard: StreamTurn[] = [];
    const off = subscribeStreamTurns((t) => heard.push(t));
    const session = new SttStreamSession({
      bridge: {
        openSttStream: async () => ({
          ok: true,
          streamId: "s9",
          engine: "stream-ear",
          chunkMs: 80,
        }),
        feedSttStream: async () => ({
          ok: true,
          turn: { turnId: "p1", event: "partial", text: "hi" },
        }),
        closeSttStream: async () => ({ ok: true, text: "" }),
      },
      onTurn: (t) => seen.push(t),
    });
    await session.open({ streamEngine: "auto", locale: "en" });
    session.push(new Float32Array(1280).fill(0.2));
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(seen.length).toBe(1);
    expect(heard).toEqual(seen);
  });
});

describe("turn protocol: the speculative draft", () => {
  it("is off unless the owner switched it on: an eager endpoint is counted and starts nothing", () => {
    const tracker = new TurnTracker();
    expect(tracker.ingest(turn("eager", "what time is it"), 1000)).toEqual([]);
    expect(tracker.eagers).toBe(1);
    expect(tracker.draftActive).toBe(false);
  });

  it("an eager endpoint starts one draft; a resume throws it away and counts the wrong guess", () => {
    const tracker = new TurnTracker(() => true);
    expect(tracker.ingest(turn("partial", "what is"), 100)).toEqual([]);
    expect(tracker.ingest(turn("eager", "what is the capital"), 400)).toEqual([
      { kind: "draft", turnId: "t1", text: "what is the capital" },
    ]);
    // A second eager in the same stretch never starts a second draft.
    expect(tracker.ingest(turn("eager", "what is the capital"), 450)).toEqual([]);
    expect(tracker.ingest(turn("resumed", "what is the capital of"), 700)).toEqual([
      { kind: "cancel-draft", turnId: "t1", why: "resumed" },
    ]);
    expect(tracker.draftActive).toBe(false);
    expect(tracker.resumes).toBe(1);
    expect(tracker.resumeRatio).toBe(0.5);
    // After the resume the next eager endpoint may draft again.
    expect(tracker.ingest(turn("eager", "what is the capital of France"), 1200)).toHaveLength(1);
  });

  it("a new turn id or a revised text that differs also cancels; an equal revision keeps the draft", () => {
    const tracker = new TurnTracker(() => true);
    tracker.ingest(turn("eager", "open the report"), 100);
    expect(tracker.ingest(turn("revised", "Open the report."), 200)).toEqual([]);
    expect(tracker.draftActive).toBe(true);
    expect(tracker.ingest(turn("revised", "open the other report"), 300)).toEqual([
      { kind: "cancel-draft", turnId: "t1", why: "revised" },
    ]);
    tracker.ingest(turn("eager", "stop the music"), 400);
    expect(tracker.ingest(turn("start", "", "t2"), 500)).toEqual([
      { kind: "cancel-draft", turnId: "t1", why: "new-turn" },
    ]);
  });

  it("the record marks the turn eager only when the final words equal the eager words", () => {
    const tracker = new TurnTracker(() => true);
    tracker.ingest(turn("eager", "what is the capital of France"), 100);
    const facts = tracker.take(200);
    expect(facts?.eagerText).toBe("what is the capital of France");
    expect(buildTurnRecord({ text: "What is the capital of France?", facts }).eager).toBe(true);
    expect(buildTurnRecord({ text: "what is the capital of Spain", facts }).eager).toBe(false);
    expect(sameWords("Haan, theek hai", "haan theek hai")).toBe(true);
    expect(sameWords("", "")).toBe(false);
  });

  it("turn facts are handed over once and never from a stale turn", () => {
    const tracker = new TurnTracker();
    tracker.ingest(turn("end", "ok", "t9", { speaker: { tag: "owner", score: 0.8 } }), 1000);
    expect(tracker.take(1000 + TURN_FACTS_TTL_MS + 1)).toBeNull();
    tracker.ingest(turn("end", "ok", "t10", { env: { kind: "music", score: 0.6 } }), 5000);
    expect(tracker.take(5100)?.env).toEqual({ kind: "music", score: 0.6 });
    expect(tracker.take(5200)).toBeNull();
  });
});

describe("turn protocol: the record that goes with a heard turn", () => {
  it("carries text, raw text, language mix, confidence, ids, tags, clipped and the played milliseconds", () => {
    const record = buildTurnRecord({
      text: "kal meeting hai at 5 pm",
      textRaw: " kal meeting hai at 5 pm ",
      declaredLanguage: "hi",
      confidence: 1.4,
      facts: {
        turnId: "t7",
        eagerText: "",
        speaker: { tag: "unknown", score: 0 },
        env: { kind: "speech", score: 0.9 },
        clipped: true,
      },
      interruptedPlayedMs: 1100.4,
    });
    expect(record).toEqual({
      text: "kal meeting hai at 5 pm",
      textRaw: " kal meeting hai at 5 pm ",
      lang: "hi",
      mix: 0,
      confidence: 1,
      turnId: "t7",
      eager: false,
      speaker: { tag: "unknown", score: 0 },
      env: { kind: "speech", score: 0.9 },
      clipped: true,
      interruptedPlayedMs: 1100,
    });
  });

  it("reads Hindi, English and mixed lines as spoken: the minority script's share is the mix", () => {
    expect(languageMix("कल मीटिंग है")).toEqual({ lang: "hi", mix: 0 });
    expect(languageMix("open the report")).toEqual({ lang: "en", mix: 0 });
    expect(languageMix("kal ki meeting", "hi").lang).toBe("hi");
    const mixed = languageMix("कल की meeting cancel करो");
    expect(mixed.lang).toBe("hi-en");
    expect(mixed.mix).toBeGreaterThan(0.3);
    expect(languageMix("12 34", "en")).toEqual({ lang: "en", mix: 0 });
  });

  it("no facts and no cut give empty tags, never invented ones", () => {
    const record = buildTurnRecord({ text: "haan", facts: null });
    expect(record).toMatchObject({
      turnId: "",
      eager: false,
      speaker: null,
      env: null,
      clipped: false,
      interruptedPlayedMs: null,
      confidence: null,
      textRaw: "haan",
    });
  });
});

describe("the speaker and the room never reach approval code", () => {
  const modeSource = readFileSync(
    resolve(root, "src/lib/friday/assistant-mode.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const TOKENS =
    /turnRecord|turnTracker|lastTurn\b|TurnRecord|TurnFacts|StreamTurn|TurnSpeaker|TurnEnv/;

  /** The text of one method of the conductor, from its signature to the next method at the same indent. */
  function method(name: string): string {
    const start = modeSource.search(new RegExp(`\\n {2}(?:private |public |async )*${name}\\(`));
    expect(start, name).toBeGreaterThan(-1);
    const rest = modeSource.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}(?:private |public |async |\/\*\*)/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }

  it.each([
    "needsConfirm",
    "askToConfirm",
    "waitingForOwner",
    "eagerAllowed",
    "eagerAdoptable",
    "speakerVerdict",
    "speakerRefusal",
    "routeCommand",
    "settleInterruption",
    "applyGateVerdict",
    "gateVerdictOf",
    "judgeCandidate",
  ])("%s does not read the turn record, the tracker or the ear's tags", (name) => {
    expect(method(name)).not.toMatch(TOKENS);
  });

  it("only the intake, the getter and the played-ms cut touch the record in the conductor", () => {
    const owners = new Set<string>();
    let current = "";
    for (const line of modeSource.split("\n")) {
      const head = /^ {2}(?:private |public |async |static )*([A-Za-z]\w*)\(/.exec(line);
      if (head) current = head[1] ?? current;
      if (/^ {2}(?:private )?\w+[:=]/.test(line) || /^\s*(?:\/\*\*|\*|\/\/)/.test(line)) continue;
      if (/\bturnRecord\b|\blastTurn\(|\blastInterruptedPlayedMs\b/.test(line)) owners.add(current);
    }
    expect([...owners].sort()).toEqual(
      ["acceptFinalUtterance", "lastTurn", "trimReplyToHeard", "turnHints"].sort(),
    );
  });

  it("hands the brain only the five language hints, never the speaker or the room", () => {
    const body = method("turnHints");
    expect(body).toMatch(/lang: t\.lang[\s\S]*mix: t\.mix[\s\S]*confidence: t\.confidence/);
    expect(body).toMatch(/eager: t\.eager[\s\S]*clipped: t\.clipped/);
    expect(body).not.toMatch(/speaker|\benv\b/);
    expect(modeSource).toContain(
      "brain.adoptDraft(this.draftId, this.speculative, this.turnHints())",
    );
    expect(modeSource).toContain("...this.turnHintsOption(),");
    expect(modeSource).toContain("viaTurn ? { onlyLocal: true } : {}");
  });

  it("a room tag only reaches the wake guard's observeScene, and a clarify is a question, not a failure", () => {
    const note = method("noteStreamTurn");
    expect(note).toContain("voiceGate.wake.observeScene(turn.env, performance.now())");
    expect(note).not.toMatch(/speaker|needsWake/);
    expect(modeSource.match(/observeScene\(/g)?.length).toBe(1);
    const clarify = modeSource.slice(modeSource.indexOf('result.reason === "clarify"'));
    expect(clarify.slice(0, 600)).toMatch(/this\.speak\(result\.message\)[\s\S]*return true/);
    expect(clarify.slice(0, 600)).not.toContain("reportFailure");
  });

  it("no approval, autonomy, confirmation or authority file imports the stream session", () => {
    const dirs = [
      "src/lib/friday",
      "src/lib/friday/self",
      "src/lib/friday/voice-engine",
      "electron",
    ];
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const file of readdirSync(resolve(root, dir))) {
        if (!/approv|autonomy|confirm|authority|permission|governance/i.test(file)) continue;
        if (!/\.(ts|tsx|cjs)$/.test(file)) continue;
        const source = readFileSync(resolve(root, dir, file), "utf8");
        if (/stream-session|TurnRecord|StreamTurn|TurnSpeaker/.test(source))
          hits.push(`${dir}/${file}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("barge-in ladder", () => {
  const input = (t: number, extra: Partial<LadderInput> = {}): LadderInput => ({
    t,
    echoCleanedSpeech: true,
    text: null,
    replyStartedAt: -10_000,
    replyEndsAt: null,
    ...extra,
  });
  const begun = () => {
    const ladder = new BargeLadder();
    ladder.begin(0);
    return ladder;
  };
  /** Echo-cleaned speech looked at every 50 ms until `untilMs`; the first non-wait verdict of each kind. */
  function climb(ladder: BargeLadder, untilMs: number, extra: Partial<LadderInput> = {}) {
    const seen: Array<[number, string]> = [];
    for (let t = 50; t <= untilMs; t += 50) {
      const verdict = ladder.evaluate(input(t, extra));
      if (verdict.kind !== "wait") seen.push([t, verdict.kind]);
    }
    return seen;
  }

  it("ducks at 150 ms of echo-cleaned speech by 12 dB, stops at 500 ms, and never ducks after the stop", () => {
    const seen = climb(begun(), 1500);
    expect(seen).toEqual([
      [150, "duck"],
      [500, "stop"],
    ]);
    const ladder = begun();
    const duck = Array.from({ length: 3 }, (_, i) => ladder.evaluate(input(50 * (i + 1)))).at(-1);
    expect(duck).toEqual({ kind: "duck", gain: dbToGain(-12) });
    expect(dbToGain(-12)).toBeCloseTo(0.251, 3);
  });

  it("the reference-gated level test alone never ducks or stops: only the cleaned signal counts", () => {
    const ladder = begun();
    const seen = climb(ladder, 1950, { echoCleanedSpeech: false });
    expect(seen).toEqual([]);
    expect(ladder.heardMs()).toBe(0);
    // With nothing heard on the cleaned signal and no words, she carries on at 2.0 s.
    expect(ladder.evaluate(input(2000, { echoCleanedSpeech: false }))).toEqual({
      kind: "resume",
      why: "no-words",
    });
  });

  it("one real word stops her at once, from a voice the cleaned signal heard", () => {
    const ladder = begun();
    ladder.evaluate(input(100));
    expect(ladder.evaluate(input(150, { text: "kya" }))).toEqual({ kind: "stop", why: "word" });
  });

  it("words with no cleaned speech behind them (her own voice picked up) are not a stop", () => {
    const ladder = begun();
    expect(
      ladder.evaluate(input(100, { echoCleanedSpeech: false, text: "open the report" })),
    ).toEqual({
      kind: "wait",
    });
  });

  it.each(["haan", "hmm", "ok", "acha", "theek hai"])(
    "a nod (%s) never stops her, however long the voice lasts",
    (nod) => {
      const ladder = begun();
      ladder.evaluate(input(100));
      const seen: string[] = [];
      for (let t = 150; t <= 1900; t += 50)
        seen.push(ladder.evaluate(input(t, { text: nod })).kind);
      expect(seen.every((k) => k === "wait")).toBe(true);
      expect(ladder.evaluate(input(2000, { text: nod, final: true }))).toEqual({
        kind: "resume",
        why: "backchannel",
      });
    },
  );

  it("a stop word and the answer to her question stop her at once, with or without speech", () => {
    expect(begun().evaluate(input(10, { echoCleanedSpeech: false, text: "ruko" }))).toEqual({
      kind: "stop",
      why: "stop-word",
    });
    expect(begun().evaluate(input(10, { text: "yes", waitingForAnswer: true }))).toEqual({
      kind: "stop",
      why: "approval-answer",
    });
  });

  it("inside the first second of her turn duration alone neither ducks nor stops; words still do", () => {
    const ladder = begun();
    const seen = climb(ladder, 900, { replyStartedAt: 0 });
    expect(seen).toEqual([]);
    expect(
      ladder.evaluate(input(950, { replyStartedAt: 0, text: "open the other report" })),
    ).toEqual({
      kind: "stop",
      why: "word",
    });
  });

  it("the windows are one second around her turn start and end", () => {
    const turn = { startedAt: 10_000, endsAt: 20_000 };
    expect(inBackchannelWindow(10_000, turn)).toBe(true);
    expect(inBackchannelWindow(10_999, turn)).toBe(true);
    expect(inBackchannelWindow(11_000, turn)).toBe(false);
    expect(inBackchannelWindow(19_001, turn)).toBe(true);
    expect(inBackchannelWindow(20_999, turn)).toBe(true);
    expect(inBackchannelWindow(21_000, turn)).toBe(false);
    expect(inBackchannelWindow(15_000, { startedAt: 10_000, endsAt: null })).toBe(false);
    expect(BARGE_LADDER.backchannelWindowMs).toBe(1000);
  });

  it("no words by 2.0 s resumes her once the voice is gone, and never while the voice goes on", () => {
    const ladder = begun();
    climb(ladder, 1000);
    expect(ladder.evaluate(input(2000)).kind).toBe("wait");
    expect(ladder.evaluate(input(2400, { echoCleanedSpeech: false }))).toEqual({
      kind: "resume",
      why: "no-words",
    });
  });

  it("her own voice coming back as text is never a stop, and its final resumes her", () => {
    const ladder = begun();
    ladder.evaluate(input(100));
    expect(ladder.evaluate(input(700, { text: "the report is ready", selfEcho: true })).kind).toBe(
      "wait",
    );
    expect(
      ladder.evaluate(input(900, { text: "the report is ready", selfEcho: true, final: true })),
    ).toEqual({ kind: "resume", why: "echo" });
  });

  it("a stalled page cannot fake a long voice: one look counts at most 250 ms", () => {
    const ladder = begun();
    expect(ladder.evaluate(input(5000)).kind).toBe("duck");
    expect(ladder.heardMs()).toBe(250);
  });

  it("reports the played milliseconds of the cut reply, rounded, or null when unknown", () => {
    expect(interruptedPlayedMs({ playedMs: 1100.6 })).toBe(1101);
    expect(interruptedPlayedMs({ playedMs: -1 })).toBeNull();
    expect(interruptedPlayedMs({})).toBeNull();
    expect(interruptedPlayedMs(null)).toBeNull();
  });

  it("is opt-in: the shipped gate has no ladder key, and only an explicit true keeps it", () => {
    expect("ladder" in DEFAULT_INTERRUPT_GATE).toBe(false);
    expect(sanitizeInterruptGate(undefined)).toEqual(DEFAULT_INTERRUPT_GATE);
    expect("ladder" in sanitizeInterruptGate({ ladder: "yes" })).toBe(false);
    expect(sanitizeInterruptGate({ ladder: true }).ladder).toBe(true);
  });
});
