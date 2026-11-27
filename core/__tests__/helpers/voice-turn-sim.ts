/**
 * A deterministic turn simulator. A scripted timeline (voice frames, the ear's turn events, brain events, voice
 * output events, controls) is played on a fake 80 ms frame clock into the real Auto mode controller, with the same
 * stubs the Auto flow test uses (the command goes to a recorder instead of the Brain, speech goes to a recorder, the
 * speaker library is a recorder). What the controller did is written to one trace that the pure scorers in
 * `turn-metrics.ts` read. No microphone, speaker, timer or network is touched.
 *
 * A test file that uses it must mock the speaker library once (vi.mock is hoisted and cannot live here):
 *
 *   vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
 *     (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()));
 *
 * Seams (the only places this reaches into the controller): `noteStreamTurn` (what the stream session's listener
 * calls), the partial handler the desktop bridge registers, the speech-start branch of the dictation callback
 * (mirrored in `speechStart`, pinned by a source test), the utterance arbiter's `local()` (the dictation `onFinal`
 * path), the `dispatch`, `speak` and `cancelSpeech` stubs, and the Brain's snapshot, stop and draft calls.
 */
import { vi } from "vitest";
import type {
  StreamTurn,
  TurnEventName,
  TurnEnv,
  TurnSpeaker,
} from "../../../src/lib/friday/voice-engine/stream-session";
import {
  FRAME_MS,
  VOICED_P,
  aggregateRun,
  createTurnMetricsRecorder,
  scoreTrace,
  type BrainEv,
  type ControlEv,
  type LaneName,
  type RunMetrics,
  type TraceEvent,
  type TraceScore,
  type TruthKind,
  type TurnMetricsSummary,
  type TtsEv,
} from "../../../src/lib/friday/voice-engine/turn-metrics";

/** Fake time zero: every trace time is milliseconds after this. */
export const SIM_BASE_MS = 1_700_000_000_000;

// ---------- the script ----------

export type ScriptEvent = { t: number } & (
  | { k: "vad"; p: number }
  | {
      k: "ear";
      event: TurnEventName;
      turnId: string;
      text?: string;
      speechMs?: number | null;
      env?: TurnEnv;
      speaker?: TurnSpeaker;
    }
  | {
      k: "final";
      text: string;
      turnId?: string;
      quality?: { avgLogprob: number; languageProbability: number; language: string };
    }
  | {
      k: "brain";
      ev: BrainEv;
      runId: string;
      turnId?: string;
      lane?: LaneName;
      reason?: string;
      /** The reply text so far (clause) or in full (done): what the streaming speaker is fed. */
      text?: string;
    }
  | { k: "tts"; ev: TtsEv; utteranceId: string; playedMs?: number; turnId?: string }
  | { k: "control"; ev: ControlEv; text?: string }
  | { k: "truth"; kind: TruthKind }
);

export type Scenario = {
  name: string;
  script: ScriptEvent[];
  /** Extra quiet time after the last event so timers and gates run out. Default 3000. */
  tailMs?: number;
  /** Runs once before the first frame: set preferences, open a question, fill the reply text she is "saying". */
  setup?: (h: SimHarness) => void;
};

/** Voice frames from `from` (inclusive) to `to` (exclusive) on the frame clock. */
export function vad(from: number, to: number, p = 0.9): ScriptEvent[] {
  const out: ScriptEvent[] = [];
  for (let t = from; t < to; t += FRAME_MS) out.push({ t, k: "vad", p });
  return out;
}

/** Quiet frames: same as `vad` with a low probability. */
export const quiet = (from: number, to: number, p = 0.05): ScriptEvent[] => vad(from, to, p);

export const ear = (
  t: number,
  event: TurnEventName,
  turnId: string,
  text = "",
  extra: { speechMs?: number | null; env?: TurnEnv; speaker?: TurnSpeaker } = {},
): ScriptEvent => ({ t, k: "ear", event, turnId, text, ...extra });

export const fin = (
  t: number,
  text: string,
  extra: Partial<Extract<ScriptEvent, { k: "final" }>> = {},
): ScriptEvent => ({ ...extra, t, k: "final", text });

export const brainEv = (
  t: number,
  ev: BrainEv,
  runId: string,
  extra: Partial<Extract<ScriptEvent, { k: "brain" }>> = {},
): ScriptEvent => ({ ...extra, t, k: "brain", ev, runId });

export const ttsEv = (
  t: number,
  ev: TtsEv,
  utteranceId: string,
  extra: Partial<Extract<ScriptEvent, { k: "tts" }>> = {},
): ScriptEvent => ({ ...extra, t, k: "tts", ev, utteranceId });

export const ctl = (t: number, ev: ControlEv, text?: string): ScriptEvent => ({
  t,
  k: "control",
  ev,
  ...(text ? { text } : {}),
});

export const truth = (t: number, kind: TruthKind): ScriptEvent => ({ t, k: "truth", kind });

/** Flatten the parts and order them by time; events at the same time keep the order they were written in. */
export function script(...parts: (ScriptEvent | ScriptEvent[])[]): ScriptEvent[] {
  const flat = parts.flat();
  return flat
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
    .map(({ e }) => e);
}

// ---------- the speaker library recorder (shared with the hoisted vi.mock) ----------

type SimShared = {
  trace: TraceEvent[];
  runId: string;
  replyText: string;
  firstAudioAt: number | null;
  speaking: boolean;
  lastVoicedAt: number;
};

const SLOT = "__voiceTurnSim";
const slot = (): SimShared | null =>
  (globalThis as unknown as Record<string, SimShared | undefined>)[SLOT] ?? null;
const nowMs = (): number => Date.now() - SIM_BASE_MS;
const record = (e: TraceEvent): void => void slot()?.trace.push(e);

/** The speaker library with its audible parts replaced by recorders (mock factory body). */
export function simLibraryMock<T extends object>(real: T): T {
  return {
    ...real,
    duckSpeech: (on: boolean) => record({ t: nowMs(), k: "duck", on }),
    stopSpeaking: () => record({ t: nowMs(), k: "stop" }),
    playedReplyCut: () => {
      const s = slot();
      if (!s || s.firstAudioAt === null || !s.runId) return null;
      const playedMs = Math.max(0, nowMs() - s.firstAudioAt);
      return {
        runId: s.runId,
        text: s.replyText,
        words: s.replyText.split(/\s+/).filter(Boolean).length,
        wholeClips: 0,
        interrupted: true,
        playedMs,
        cutMs: playedMs,
      };
    },
    playbackEndsAt: () => null,
    playedReplySnapshot: () => ({
      runId: slot()?.runId ?? "",
      text: slot()?.replyText ?? "",
      words: 0,
      wholeClips: 0,
      interrupted: true,
    }),
  } as T;
}

// ---------- the harness ----------

type Driver = {
  state: {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    handsFree: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  emit: () => void;
  cancelSpeech: () => void;
  speakStreamed: (runId: string, text: string, final: boolean) => void;
  noteStreamTurn: (turn: StreamTurn) => void;
  gateEnabled: () => boolean;
  beginInterruptCandidate: () => void;
  holdForInterruption: () => void;
  discardEager: () => void;
  rememberLocalMeta: (text: string, meta: unknown) => void;
  sttArbiter: () => { local: (text: string) => unknown };
  setMuted: (muted: boolean) => void;
  setPaused: (paused: boolean) => void;
  openFollowUp: () => void;
  turnHints: () => TurnHintsView | undefined;
  speculativeKind: string;
  spokenText: string;
  followUpUntil: number;
  liveWakeAt: number;
  interruptHold: unknown;
  unfinished: string;
  lastTurn: () => {
    lang: string;
    mix: number;
    text: string;
    eager: boolean;
    interruptedPlayedMs: number | null;
  } | null;
};

type TurnHintsView = {
  lang: string;
  mix: number;
  confidence: number | null;
  eager: boolean;
  clipped: boolean;
};

type PartialHandler = (payload: { text?: string }) => void;

export type SimHarness = {
  /** The real Auto mode controller. */
  d: Driver;
  preferences: typeof import("../../../src/lib/friday/preferences").preferences;
  autonomy: typeof import("../../../src/lib/friday/self/autonomy").autonomy;
  /** What she said (speech asked of the voice), what was sent to the Brain, and calls the Brain received. */
  spoken: string[];
  sent: string[];
  /** The turn hints the controller held at the moment each command was handed over. */
  hints: Array<TurnHintsView | undefined>;
  cancelled: number;
  brainStops: unknown[];
  truncated: Array<[string, string, number | undefined]>;
  drafts: { started: string[]; discarded: string[]; adopted: string[] };
};

export type SimResult = {
  name: string;
  /** Copies taken when the script and its tail ended; later work of the controller is not in them. */
  spoken: string[];
  sent: string[];
  cancelled: number;
  trace: TraceEvent[];
  score: TraceScore;
  run: RunMetrics;
  /** The same trace fed through the live recorder: what the app's recorder would report for it, with the gates. */
  summary: TurnMetricsSummary;
  h: SimHarness;
};

function installGlobals(partials: PartialHandler[]): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g["window"] ??= globalThis;
  for (const name of ["addEventListener", "removeEventListener"]) g[name] ??= () => undefined;
  g["document"] ??= {
    hidden: false,
    documentElement: { classList: { toggle: () => undefined } },
    addEventListener: () => undefined,
    hasFocus: () => true,
    head: { appendChild: () => undefined },
    getElementsByTagName: () => [{ appendChild: () => undefined }],
    createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined }),
    createTextNode: () => ({}),
  };
  g["friday"] = {
    onVoicePartial: (cb: PartialHandler) => {
      partials.push(cb);
      return () => undefined;
    },
  };
}

/** Run one scenario on a fresh controller and return its trace, scores and what it did. */
export async function runScenario(scenario: Scenario): Promise<SimResult> {
  const shared: SimShared = {
    trace: [],
    runId: "",
    replyText: "",
    firstAudioAt: null,
    speaking: false,
    lastVoicedAt: Number.NEGATIVE_INFINITY,
  };
  (globalThis as unknown as Record<string, unknown>)[SLOT] = shared;
  const partials: PartialHandler[] = [];
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  vi.setSystemTime(SIM_BASE_MS);
  installGlobals(partials);
  try {
    const { assistantMode } = await import("../../../src/lib/friday/assistant-mode");
    const { brain } = await import("../../../src/lib/friday/brain-engine");
    const { preferences } = await import("../../../src/lib/friday/preferences");
    const { voiceGate } = await import("../../../src/lib/friday/voice-audio");
    const { autonomy } = await import("../../../src/lib/friday/self/autonomy");
    assistantMode.subscribe(() => undefined);
    const d = assistantMode as unknown as Driver;
    const h: SimHarness = {
      d,
      preferences,
      autonomy,
      spoken: [],
      sent: [],
      hints: [],
      cancelled: 0,
      brainStops: [],
      truncated: [],
      drafts: { started: [], discarded: [], adopted: [] },
    };
    let turnId = "";
    let activeRunId = "";
    let voicedNow = false;

    const turnOf = (explicit?: string): string => explicit ?? turnId;
    d.emit = () => undefined;
    d.dispatch = (command: string) => {
      h.sent.push(command);
      h.hints.push(d.turnHints());
      d.openFollowUp();
      record({ t: nowMs(), k: "dispatch", text: command, turnId: turnId });
    };
    d.speak = (text: string) => {
      h.spoken.push(text);
      d.spokenText = text;
      d.openFollowUp();
      record({ t: nowMs(), k: "say", text, turnId: turnId });
    };
    const realCancel = d.cancelSpeech.bind(d);
    d.cancelSpeech = () => {
      h.cancelled += 1;
      record({ t: nowMs(), k: "cancel" });
      realCancel();
    };
    vi.spyOn(voiceGate, "heardSpeechWithin").mockImplementation(
      (ms: number) => voicedNow || nowMs() - shared.lastVoicedAt <= ms,
    );
    const snapshot = brain.getSnapshot.bind(brain);
    vi.spyOn(brain, "getSnapshot").mockImplementation((() => ({
      ...snapshot(),
      activeRunId,
      approval: null,
    })) as never);
    vi.spyOn(brain, "stop").mockImplementation(((scope?: unknown) => {
      h.brainStops.push(scope ?? "all");
    }) as never);
    vi.spyOn(brain, "truncateAssistantReply").mockImplementation(((
      runId: string,
      text: string,
      playedMs?: number,
    ) => {
      h.truncated.push([runId, text, playedMs]);
      return true;
    }) as never);
    vi.spyOn(brain, "startDraft").mockImplementation(((command: string) => {
      h.drafts.started.push(command);
      return { started: true, draft: { draftId: `draft-${h.drafts.started.length}` } };
    }) as never);
    vi.spyOn(brain, "adoptDraft").mockImplementation(((id: string, text: string) => {
      const at = h.drafts.started.indexOf(text);
      const ok = at >= 0 && id === `draft-${at + 1}`;
      if (ok) {
        h.drafts.adopted.push(id);
        h.hints.push(d.turnHints());
        record({ t: nowMs(), k: "dispatch", text, turnId });
      }
      return ok;
    }) as never);
    vi.spyOn(brain, "discardDraft").mockImplementation(((id: string) => {
      h.drafts.discarded.push(id);
      return true;
    }) as never);

    // Start-up lines (the ready announcement) belong to no turn: let them pass, then start the clock at zero.
    vi.advanceTimersByTime(1000);
    shared.trace.length = 0;
    h.spoken.length = 0;
    d.spokenText = "";
    vi.setSystemTime(SIM_BASE_MS);

    scenario.setup?.(h);

    /** The speech-start branch of the dictation callback (assistant-mode.ts `onSpeechStart`), unchanged. */
    const speechStart = () => {
      if (d.speculativeKind === "brain") d.discardEager();
      if (d.state.speaking) {
        if (d.gateEnabled()) d.beginInterruptCandidate();
        else d.holdForInterruption();
      }
    };

    const apply = (e: ScriptEvent) => {
      const t = nowMs();
      switch (e.k) {
        case "vad": {
          record({ t, k: "vad", p: e.p });
          const on = e.p >= VOICED_P;
          if (on) shared.lastVoicedAt = t;
          if (on && !voicedNow) speechStart();
          voicedNow = on;
          break;
        }
        case "ear": {
          if (e.event === "start") turnId = e.turnId;
          record({ t, k: "ear", event: e.event, turnId: e.turnId, text: e.text ?? "" });
          const turn: StreamTurn = {
            turnId: e.turnId,
            event: e.event,
            text: e.text ?? "",
            vadP: voicedNow ? 0.9 : 0.05,
            speechMs: e.speechMs ?? null,
            ...(e.env ? { env: e.env } : {}),
            ...(e.speaker ? { speaker: e.speaker } : {}),
          };
          d.noteStreamTurn(turn);
          if (e.event === "partial" && e.text) partials[partials.length - 1]?.({ text: e.text });
          break;
        }
        case "final": {
          record({ t, k: "final", text: e.text, turnId: turnOf(e.turnId) });
          if (e.quality) d.rememberLocalMeta(e.text.trim(), { quality: e.quality });
          d.sttArbiter().local(e.text.trim());
          break;
        }
        case "brain": {
          record({
            t,
            k: "brain",
            ev: e.ev,
            runId: e.runId,
            turnId: turnOf(e.turnId),
            ...(e.lane ? { lane: e.lane } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
          });
          if (e.ev === "first-token") {
            activeRunId = e.runId;
            shared.runId = e.runId;
          }
          if (e.text !== undefined) shared.replyText = e.text;
          if (e.ev === "clause" && e.text !== undefined) d.speakStreamed(e.runId, e.text, false);
          if (e.ev === "done") {
            if (e.text !== undefined) d.speakStreamed(e.runId, e.text, true);
            activeRunId = "";
          }
          if (e.ev === "refused") activeRunId = "";
          break;
        }
        case "tts": {
          record({
            t,
            k: "tts",
            ev: e.ev,
            utteranceId: e.utteranceId,
            playedMs: e.playedMs ?? 0,
            turnId: turnOf(e.turnId),
          });
          if (e.ev === "first-audio") {
            d.state.speaking = true;
            shared.speaking = true;
            shared.firstAudioAt = t;
          } else if (e.ev === "drained") {
            d.state.speaking = false;
            shared.speaking = false;
          }
          break;
        }
        case "control": {
          record({ t, k: "control", ev: e.ev });
          if (e.ev === "stop-all") h.autonomy.stopEverything();
          else if (e.ev === "mute") d.setMuted(true);
          else if (e.ev === "pause") d.setPaused(true);
          else if (e.ev === "wake") d.liveWakeAt = Date.now();
          else if (e.ev === "asked") {
            if (e.text) d.spokenText = e.text;
            d.followUpUntil = Date.now() + 8000;
          }
          break;
        }
        case "truth":
          record({ t, k: "truth", kind: e.kind });
          break;
      }
    };

    let clock = 0;
    const advanceTo = (target: number) => {
      while (clock < target) {
        vi.advanceTimersByTime(FRAME_MS);
        clock += FRAME_MS;
      }
    };
    for (const e of scenario.script) {
      if (e.t % FRAME_MS !== 0)
        throw new Error(`event at ${e.t} ms is off the ${FRAME_MS} ms frame clock`);
      advanceTo(e.t);
      apply(e);
    }
    const lastAt = scenario.script.at(-1)?.t ?? 0;
    advanceTo(Math.ceil((lastAt + (scenario.tailMs ?? 3000)) / FRAME_MS) * FRAME_MS);

    // Her own reply the simulator did not script a stop for is still "speaking" at the end; nothing else is read.
    const trace = shared.trace.slice().sort((a, b) => a.t - b.t);
    const score = scoreTrace(trace);
    const recorder = createTurnMetricsRecorder({ maxEvents: trace.length });
    for (const e of trace) recorder.record(e);
    return {
      name: scenario.name,
      spoken: h.spoken.slice(),
      sent: h.sent.slice(),
      cancelled: h.cancelled,
      trace,
      score,
      run: aggregateRun([score]),
      summary: recorder.summary(),
      h,
    };
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as unknown as Record<string, unknown>)[SLOT];
  }
}
