/**
 * FRIDAY · turn engine (pure).
 *
 * One small state machine for a spoken turn: idle, listen, think, speak, yield. It is a function of its input
 * list only: `step(state, input)` returns a new state and a list of commands and never changes what it was
 * given. Time arrives as `input.t` (milliseconds from any monotonic clock) and is cut into 80 ms frames; there
 * is no clock, timer or device in this file, so the same inputs always give byte-identical commands.
 *
 * The engine only asks. It never runs a task and never approves anything: a `commit` carries the heard turn to
 * the conductor, which owns runs and approvals. A stop-all, a mute or a pause ends everything from any state
 * and, when hands-free is off, asks for the wake word again. A mute or a pause also holds the engine shut until
 * an explicit `wake` control arrives.
 */

import {
  buildTurnRecord,
  type StreamTurn,
  type TurnEnv,
  type TurnRecord,
  type TurnSpeaker,
} from "./stream-session";

/** One engine frame, in milliseconds. */
export const FRAME_MS = 80;
/** A VAD probability at or above this is voice. */
export const VAD_VOICE_P = 0.5;
/** Loudness drop applied while the owner talks over FRIDAY. */
export const YIELD_DUCK_DB = -12;
/** Quiet frames in the yield state before FRIDAY carries on. */
export const YIELD_RESUME_FRAMES = 5;
/** Most drafts started for one turn by the default governor. */
export const MAX_DRAFTS_PER_TURN = 3;

export type TurnState = "idle" | "listen" | "think" | "speak" | "yield";
export type VoiceLane = "command" | "quick" | "full";
export type TurnExpect = "yesno" | "number" | "name" | "open";

export type TurnInput = { t: number } & (
  | { k: "tick" }
  | { k: "ear"; turn: StreamTurn }
  | { k: "vad"; p: number; echoClean: boolean }
  | {
      k: "brain";
      ev: "lane" | "first-token" | "clause" | "done" | "refused" | "approval";
      runId: string;
      lane?: VoiceLane;
      reason?: string;
    }
  | {
      k: "tts";
      ev: "first-audio" | "clause-end" | "drained" | "failed";
      utteranceId: string;
      playedMs: number;
    }
  | {
      k: "control";
      ev: "stop-all" | "mute" | "pause" | "wake" | "asked";
      expect?: TurnExpect;
    }
);

export type TurnCommand =
  | { k: "draft-start" | "draft-cancel" | "draft-adopt"; turnId: string; text: string }
  | { k: "commit"; record: TurnRecord }
  | { k: "duck"; db: number }
  | { k: "stop-speech"; reason: string; resumable: boolean }
  | { k: "resume-speech" }
  | { k: "ack"; key: string }
  | { k: "require-wake"; why: string };

export type DraftRequest = { turnId: string; text: string; frame: number; started: number };
export type DraftVerdict = { allow: boolean };

export type TurnEngineConfig = {
  /** Hands-free on: no wake word is needed. Off: a wake word opens each stretch of listening. */
  handsFree: boolean;
  /** Quiet frames after the last voice before a turn ends (6 x 80 ms = 480 ms). */
  eotBaseFrames: number;
  /** A turn that has run this many frames is cut and handed on. */
  maxListenFrames: number;
  /** Extra quiet frames to wait for these words (a dangling "and", a digit run). Default 0. */
  holdFor?: (text: string, expect: TurnExpect | undefined) => number;
  /** Whether a speculative draft may start now. Default: one in flight, at most three per turn. */
  draft?: (s: TurnEngineState, req: DraftRequest) => DraftVerdict;
};

export type TurnDraft = { inFlight: boolean; turnId: string; text: string; count: number };
type TurnFactsLite = { speaker: TurnSpeaker | null; env: TurnEnv | null; clipped: boolean };

export type TurnEngineState = {
  v: 1;
  state: TurnState;
  frame: number;
  turnId: string;
  text: string;
  lastVoiceFrame: number;
  /** The frame the open turn ends at when no more voice comes, or null. */
  eotAtFrame: number | null;
  runId: string;
  utteranceId: string;
  expect?: TurnExpect;
  draft: TurnDraft;
  cfg: TurnEngineConfig;
  /** The wake word is needed before the next turn opens. */
  needWake: boolean;
  /** Muted or paused: shut until a `wake` control. */
  halted: boolean;
  listenStartFrame: number;
  facts: TurnFactsLite;
};

export type TurnStep = { state: TurnEngineState; commands: TurnCommand[] };

const NO_DRAFT: TurnDraft = { inFlight: false, turnId: "", text: "", count: 0 };
const NO_FACTS: TurnFactsLite = { speaker: null, env: null, clipped: false };

function posInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function frameOf(t: number): number {
  return Number.isFinite(t) && t > 0 ? Math.floor(t / FRAME_MS) : 0;
}

export function createTurnEngine(cfg: Partial<TurnEngineConfig> = {}): TurnEngineState {
  const handsFree = cfg.handsFree === true;
  const full: TurnEngineConfig = {
    handsFree,
    eotBaseFrames: posInt(cfg.eotBaseFrames, 6),
    maxListenFrames: posInt(cfg.maxListenFrames, 125),
    ...(cfg.holdFor ? { holdFor: cfg.holdFor } : {}),
    ...(cfg.draft ? { draft: cfg.draft } : {}),
  };
  return {
    v: 1,
    state: "idle",
    frame: 0,
    turnId: "",
    text: "",
    lastVoiceFrame: 0,
    eotAtFrame: null,
    runId: "",
    utteranceId: "",
    draft: NO_DRAFT,
    cfg: full,
    needWake: !handsFree,
    halted: false,
    listenStartFrame: 0,
    facts: NO_FACTS,
  };
}

function hold(n: TurnEngineState): number {
  const fn = n.cfg.holdFor;
  if (!fn) return 0;
  const extra = fn(n.text, n.expect);
  return typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0;
}

function cancelDraft(n: TurnEngineState, out: TurnCommand[]): void {
  if (n.draft.inFlight) {
    out.push({ k: "draft-cancel", turnId: n.draft.turnId, text: n.draft.text });
  }
  n.draft = { ...NO_DRAFT, count: n.draft.count };
}

/** A fresh stretch of listening: the old draft is dropped, the clock for the turn starts here. */
function openListen(n: TurnEngineState, turnId: string, out: TurnCommand[]): void {
  cancelDraft(n, out);
  n.state = "listen";
  n.turnId = turnId;
  n.text = "";
  n.draft = NO_DRAFT;
  n.facts = NO_FACTS;
  n.lastVoiceFrame = n.frame;
  n.listenStartFrame = n.frame;
  n.runId = "";
  n.utteranceId = "";
}

function goIdle(n: TurnEngineState): void {
  n.state = "idle";
  n.eotAtFrame = null;
  n.runId = "";
  n.utteranceId = "";
}

/** FRIDAY stopped talking: the answer to a question she asked opens the mic again, otherwise rest. */
function afterSpeech(n: TurnEngineState, out: TurnCommand[]): void {
  goIdle(n);
  if (n.expect && !n.needWake && !n.halted) openListen(n, "", out);
}

function applyEarListen(n: TurnEngineState, turn: StreamTurn, out: TurnCommand[]): void {
  if (turn.text.trim() !== "") n.text = turn.text;
  n.facts = {
    speaker: turn.speaker ?? n.facts.speaker,
    env: turn.env ?? n.facts.env,
    clipped: turn.clipped === true || n.facts.clipped,
  };
  if (turn.event === "start" || turn.event === "partial" || turn.event === "resumed") {
    n.lastVoiceFrame = n.frame;
  }
  if (turn.event === "resumed") cancelDraft(n, out);
  if (turn.event === "eager" && n.text.trim() !== "" && !n.draft.inFlight) {
    const req: DraftRequest = {
      turnId: n.turnId,
      text: n.text,
      frame: n.frame,
      started: n.draft.count,
    };
    const verdict = n.cfg.draft
      ? n.cfg.draft(n, req)
      : { allow: n.draft.count < MAX_DRAFTS_PER_TURN };
    if (verdict.allow) {
      n.draft = { inFlight: true, turnId: n.turnId, text: n.text, count: n.draft.count + 1 };
      out.push({ k: "draft-start", turnId: n.turnId, text: n.text });
    }
  }
}

function onEar(n: TurnEngineState, turn: StreamTurn, out: TurnCommand[]): void {
  if (n.halted) return;
  switch (n.state) {
    case "speak":
      return;
    case "think":
    case "yield": {
      if (turn.turnId === n.turnId) return;
      out.push({ k: "stop-speech", reason: "takeover", resumable: false });
      openListen(n, turn.turnId, out);
      break;
    }
    case "idle": {
      const blocked = n.needWake || (turn.needsWake === true && !n.cfg.handsFree);
      if (blocked) {
        if (turn.turnId !== n.turnId) {
          n.turnId = turn.turnId;
          out.push({ k: "require-wake", why: "wake-needed" });
        }
        return;
      }
      openListen(n, turn.turnId, out);
      break;
    }
    case "listen": {
      if (n.turnId === "") n.turnId = turn.turnId;
      else if (turn.turnId !== n.turnId) openListen(n, turn.turnId, out);
      break;
    }
  }
  applyEarListen(n, turn, out);
}

function onVad(n: TurnEngineState, p: number, echoClean: boolean, out: TurnCommand[]): void {
  if (n.halted || !(p >= VAD_VOICE_P)) return;
  switch (n.state) {
    case "idle":
      if (!n.needWake) openListen(n, "", out);
      return;
    case "listen":
      n.lastVoiceFrame = n.frame;
      return;
    case "speak":
      if (!echoClean) return;
      n.state = "yield";
      n.lastVoiceFrame = n.frame;
      out.push({ k: "duck", db: YIELD_DUCK_DB });
      return;
    case "yield":
      if (echoClean) n.lastVoiceFrame = n.frame;
      return;
    case "think":
      return;
  }
}

function onBrain(
  n: TurnEngineState,
  i: Extract<TurnInput, { k: "brain" }>,
  out: TurnCommand[],
): void {
  if (n.halted || n.state !== "think") return;
  if (n.runId === "") n.runId = i.runId;
  else if (i.runId !== n.runId) return;
  if (i.ev === "refused") {
    out.push({ k: "ack", key: "refused" });
    delete n.expect;
    goIdle(n);
  }
}

function onTts(n: TurnEngineState, i: Extract<TurnInput, { k: "tts" }>, out: TurnCommand[]): void {
  if (n.halted) return;
  if (i.ev === "first-audio") {
    if (n.state === "think" && i.utteranceId !== "") {
      n.state = "speak";
      n.utteranceId = i.utteranceId;
    }
    return;
  }
  if ((n.state !== "speak" && n.state !== "yield") || i.utteranceId !== n.utteranceId) return;
  if (i.ev === "drained" || i.ev === "failed") afterSpeech(n, out);
}

function onControl(
  n: TurnEngineState,
  i: Extract<TurnInput, { k: "control" }>,
  out: TurnCommand[],
): void {
  if (i.ev === "stop-all" || i.ev === "mute" || i.ev === "pause") {
    out.push({ k: "draft-cancel", turnId: n.draft.turnId || n.turnId, text: n.draft.text });
    out.push({ k: "stop-speech", reason: i.ev, resumable: false });
    if (!n.cfg.handsFree) {
      n.needWake = true;
      out.push({ k: "require-wake", why: i.ev });
    }
    if (i.ev !== "stop-all") n.halted = true;
    n.draft = NO_DRAFT;
    n.text = "";
    delete n.expect;
    goIdle(n);
    return;
  }
  if (i.ev === "wake") {
    n.halted = false;
    n.needWake = false;
    if (n.state === "idle") openListen(n, "", out);
    return;
  }
  if (i.expect) n.expect = i.expect;
  if (n.state === "idle" && !n.needWake && !n.halted) openListen(n, "", out);
}

function toThink(n: TurnEngineState, out: TurnCommand[]): void {
  if (n.draft.inFlight) {
    out.push(
      n.draft.text === n.text
        ? { k: "draft-adopt", turnId: n.draft.turnId, text: n.draft.text }
        : { k: "draft-cancel", turnId: n.draft.turnId, text: n.draft.text },
    );
  }
  const eagerText = n.draft.text;
  out.push({
    k: "commit",
    record: buildTurnRecord({
      text: n.text,
      facts: {
        turnId: n.turnId,
        eagerText,
        speaker: n.facts.speaker,
        env: n.facts.env,
        clipped: n.facts.clipped,
      },
    }),
  });
  n.draft = { ...NO_DRAFT, count: n.draft.count };
  n.state = "think";
  n.eotAtFrame = null;
  n.runId = "";
  n.utteranceId = "";
  delete n.expect;
}

/** Everything that depends on frames passing, not on what just arrived. */
function runTimers(n: TurnEngineState, out: TurnCommand[]): void {
  if (n.state === "listen") {
    const hasText = n.text.trim() !== "";
    n.eotAtFrame = hasText ? n.lastVoiceFrame + n.cfg.eotBaseFrames + hold(n) : null;
    if (n.frame - n.listenStartFrame >= n.cfg.maxListenFrames) {
      if (hasText) toThink(n, out);
      else {
        cancelDraft(n, out);
        delete n.expect;
        goIdle(n);
      }
      return;
    }
    if (hasText && n.eotAtFrame !== null && n.frame >= n.eotAtFrame) toThink(n, out);
    return;
  }
  n.eotAtFrame = null;
  if (n.state === "yield" && n.frame - n.lastVoiceFrame >= YIELD_RESUME_FRAMES) {
    n.state = "speak";
    out.push({ k: "resume-speech" });
  }
}

/**
 * One input in, the next state and the commands out. The input state is never changed; the same state and the
 * same input always give the same result.
 */
export function step(s: TurnEngineState, i: TurnInput): TurnStep {
  const n: TurnEngineState = { ...s, frame: Math.max(s.frame, frameOf(i.t)) };
  const commands: TurnCommand[] = [];
  switch (i.k) {
    case "ear":
      onEar(n, i.turn, commands);
      break;
    case "vad":
      onVad(n, i.p, i.echoClean, commands);
      break;
    case "brain":
      onBrain(n, i, commands);
      break;
    case "tts":
      onTts(n, i, commands);
      break;
    case "control":
      onControl(n, i, commands);
      break;
    case "tick":
      break;
  }
  if (!n.halted) runTimers(n, commands);
  return { state: n, commands };
}
