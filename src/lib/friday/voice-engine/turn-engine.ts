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
  draftVerdict,
  governDraft,
  initialDraftGov,
  noteDraft,
  type DraftGovState,
} from "./draft-governor";
import {
  MAX_WAIT_FRAMES,
  MAX_MAX_WAIT_FRAMES,
  MIN_BASE_FRAMES,
  MIN_MAX_WAIT_FRAMES,
  eotEagerFrames,
  eotHoldFrames,
  maxWaitFramesFor,
  withLangOffset,
  type EotLang,
} from "./endpoint-calibration";
import {
  buildTurnRecord,
  languageMix,
  sameWords,
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
/** Most quiet frames a hold may take off the base wait (a bare yes or no closes fast). */
export const MAX_FASTER_FRAMES = 4;

export type TurnState = "idle" | "listen" | "think" | "speak" | "yield";
export type VoiceLane = "command" | "quick" | "full";
export type TurnExpect = "yesno" | "number" | "name" | "open" | "dictation";

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
  | { k: "commit"; record: TurnRecordV2 }
  | { k: "duck"; db: number }
  | { k: "stop-speech"; reason: string; resumable: boolean }
  | { k: "resume-speech" }
  | { k: "ack"; key: string }
  | { k: "require-wake"; why: string };

/** What the engine does when the owner's voice arrives while FRIDAY speaks. */
export type BargeVerdict = "keep" | "takeover" | "ignore";

/** The record the engine commits: today's turn record plus the wait it measured and the lane it chose, if any. */
export type TurnRecordV2 = TurnRecord & { v: 2; lane?: VoiceLane; eotWaitMs: number | null };

export type DraftRequest = { turnId: string; text: string; frame: number; started: number };
export type DraftVerdict = { allow: boolean };

export type TurnEngineConfig = {
  /** Hands-free on: no wake word is needed. Off: a wake word opens each stretch of listening. */
  handsFree: boolean;
  /** Quiet frames after the last voice before a turn ends (6 x 80 ms = 480 ms). */
  eotBaseFrames: number;
  /** A turn that has run this many frames is cut and handed on. */
  maxListenFrames: number;
  /**
   * The most quiet frames any hold may add: after this many the turn closes even when the words look unfinished.
   * Default 30 (2.4 s), clamped to 15..50; a dictation or an open answer gets up to 50 (4 s).
   */
  maxWaitFrames: number;
  /** The owner's language for the quiet wait: a language, or `auto` to read it off the words. Default: none. */
  lang?: EotLang | "auto";
  /** Echo-clean voice frames in a row, while FRIDAY speaks, before the owner takes the floor. Default 1. */
  onsetFrames: number;
  /** Extra quiet frames to wait for these words (a dangling "and", a digit run). Default `eotHoldFrames`. */
  holdFor?: (text: string, expect: TurnExpect | undefined, lang?: EotLang) => number;
  /** Whether a speculative draft may start now. Default: the draft governor (one in flight, three per turn). */
  draft?: (s: TurnEngineState, req: DraftRequest) => DraftVerdict;
  /** Whether these words are read-only work a draft may start on. Default: never, so drafts stay off. */
  isReadOnly?: (text: string) => boolean;
  /**
   * What to do with echo-clean voice while FRIDAY speaks: `keep` talks on, ducked; `takeover` gives the owner the
   * floor (duck and yield); `ignore` does nothing. Default `takeover` at p >= 0.5.
   */
  barge?: (p: number, playedMs: number) => BargeVerdict;
};

export type TurnDraft = { inFlight: boolean; turnId: string; text: string };
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
  /** The draft governor's counters for the open turn. */
  gov: DraftGovState;
  /** Speech is being kept at a lower volume while the owner makes a short sound. */
  ducked: boolean;
  /** Milliseconds of the current utterance FRIDAY has played, from the last speech event. */
  playedMs: number;
  /** Echo-clean voice frames in a row while FRIDAY speaks, and the frame of the last one. */
  onsetRun: number;
  onsetFrame: number;
  cfg: TurnEngineConfig;
  /** The wake word is needed before the next turn opens. */
  needWake: boolean;
  /** Muted or paused: shut until a `wake` control. */
  halted: boolean;
  listenStartFrame: number;
  facts: TurnFactsLite;
};

export type TurnStep = { state: TurnEngineState; commands: TurnCommand[] };

const NO_DRAFT: TurnDraft = { inFlight: false, turnId: "", text: "" };
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
    maxWaitFrames: Math.min(
      MAX_MAX_WAIT_FRAMES,
      Math.max(MIN_MAX_WAIT_FRAMES, posInt(cfg.maxWaitFrames, MAX_WAIT_FRAMES)),
    ),
    ...(cfg.lang ? { lang: cfg.lang } : {}),
    onsetFrames: posInt(cfg.onsetFrames, 1),
    holdFor: cfg.holdFor ?? eotHoldFrames,
    ...(cfg.draft ? { draft: cfg.draft } : {}),
    isReadOnly: cfg.isReadOnly ?? (() => false),
    ...(cfg.barge ? { barge: cfg.barge } : {}),
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
    gov: initialDraftGov(),
    ducked: false,
    playedMs: 0,
    onsetRun: 0,
    onsetFrame: -1,
    cfg: full,
    needWake: !handsFree,
    halted: false,
    listenStartFrame: 0,
    facts: NO_FACTS,
  };
}

/** The language the quiet wait is for: the configured one, or what the words look like. */
function eotLang(n: TurnEngineState): EotLang | undefined {
  const lang = n.cfg.lang;
  if (lang !== "auto") return lang;
  const read = languageMix(n.text).lang;
  return read === "hi" ? "hi" : read === "hi-en" ? "hinglish" : "en";
}

function hold(n: TurnEngineState, lang: EotLang | undefined): number {
  const fn = n.cfg.holdFor;
  if (!fn) return 0;
  const extra = fn(n.text, n.expect, lang);
  if (typeof extra !== "number" || !Number.isFinite(extra)) return 0;
  return Math.max(-MAX_FASTER_FRAMES, Math.trunc(extra));
}

/**
 * Quiet frames after the last voice before the turn closes: the base (plus the language's offset and the
 * dictation allowance), plus the hold. A yes/no or number answer with no hold closes at the minimum base. A
 * hold can never push the wait past the longest wait, and the longest wait never cuts a base the owner set.
 */
function eotWaitFrames(n: TurnEngineState): number {
  const lang = eotLang(n);
  const extra = hold(n, lang);
  const raw = n.cfg.eotBaseFrames;
  if (extra === 0 && (n.expect === "yesno" || n.expect === "number")) {
    return Math.min(raw, MIN_BASE_FRAMES);
  }
  const base = withLangOffset(raw, lang) + eotEagerFrames(n.expect);
  const wait = base + extra;
  if (extra <= 0) return wait;
  return Math.min(wait, Math.max(maxWaitFramesFor(n.expect, n.cfg.maxWaitFrames), base));
}

function readOnly(n: TurnEngineState, text: string): boolean {
  try {
    return n.cfg.isReadOnly?.(text) === true;
  } catch {
    return false;
  }
}

function cancelDraft(n: TurnEngineState, out: TurnCommand[]): void {
  if (n.draft.inFlight) {
    out.push({ k: "draft-cancel", turnId: n.draft.turnId, text: n.draft.text });
  }
  n.draft = NO_DRAFT;
  n.gov = noteDraft(n.gov, "end");
}

/** A fresh stretch of listening: the old draft is dropped, the clock for the turn starts here. */
function openListen(n: TurnEngineState, turnId: string, out: TurnCommand[]): void {
  cancelDraft(n, out);
  n.state = "listen";
  n.turnId = turnId;
  n.text = "";
  n.draft = NO_DRAFT;
  n.gov = noteDraft(n.gov, "new-turn");
  n.ducked = false;
  n.facts = NO_FACTS;
  n.lastVoiceFrame = n.frame;
  n.listenStartFrame = n.frame;
  n.runId = "";
  n.utteranceId = "";
}

function goIdle(n: TurnEngineState): void {
  n.state = "idle";
  n.ducked = false;
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
    const audioMs = Math.max(0, n.frame - n.listenStartFrame) * FRAME_MS;
    const req: DraftRequest = {
      turnId: n.turnId,
      text: n.text,
      frame: n.frame,
      started: n.gov.thisTurn,
    };
    const verdict = n.cfg.draft
      ? n.cfg.draft(n, req)
      : draftVerdict(
          governDraft(n.gov, {
            turnId: n.turnId,
            text: n.text,
            audioMs,
            lane: "quick",
            readOnly: readOnly(n, n.text),
          }),
        );
    if (verdict.allow) {
      n.draft = { inFlight: true, turnId: n.turnId, text: n.text };
      n.gov = noteDraft(n.gov, "start", audioMs);
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

function bargeVerdict(n: TurnEngineState, p: number): BargeVerdict {
  if (!n.cfg.barge) return "takeover";
  try {
    const v = n.cfg.barge(p, n.playedMs);
    return v === "keep" || v === "ignore" ? v : "takeover";
  } catch {
    return "takeover";
  }
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
    case "speak": {
      if (!echoClean) {
        n.onsetRun = 0;
        return;
      }
      if (n.onsetFrame !== n.frame) n.onsetRun = n.onsetFrame === n.frame - 1 ? n.onsetRun + 1 : 1;
      n.onsetFrame = n.frame;
      if (n.onsetRun < n.cfg.onsetFrames) return;
      const verdict = bargeVerdict(n, p);
      if (verdict === "ignore") return;
      n.lastVoiceFrame = n.frame;
      if (verdict === "keep") {
        if (!n.ducked) {
          n.ducked = true;
          out.push({ k: "duck", db: YIELD_DUCK_DB });
        }
        return;
      }
      n.state = "yield";
      n.ducked = false;
      out.push({ k: "duck", db: YIELD_DUCK_DB });
      return;
    }
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
      n.playedMs = 0;
    }
    return;
  }
  if ((n.state !== "speak" && n.state !== "yield") || i.utteranceId !== n.utteranceId) return;
  if (Number.isFinite(i.playedMs) && i.playedMs >= 0) n.playedMs = i.playedMs;
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
    n.gov = noteDraft(n.gov, "new-turn");
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
  const adopted = n.draft.inFlight && sameWords(n.text, n.draft.text);
  if (n.draft.inFlight) {
    out.push({
      k: adopted ? "draft-adopt" : "draft-cancel",
      turnId: n.draft.turnId,
      text: n.draft.text,
    });
  }
  const eagerText = n.draft.text;
  out.push({
    k: "commit",
    record: {
      ...buildTurnRecord({
        text: n.text,
        facts: {
          turnId: n.turnId,
          eagerText,
          speaker: n.facts.speaker,
          env: n.facts.env,
          clipped: n.facts.clipped,
        },
      }),
      v: 2,
      eotWaitMs: Math.max(0, n.frame - n.lastVoiceFrame) * FRAME_MS,
      ...(adopted ? { lane: "quick" as const } : {}),
    },
  });
  n.draft = NO_DRAFT;
  n.gov = noteDraft(n.gov, "end");
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
    n.eotAtFrame = hasText ? n.lastVoiceFrame + eotWaitFrames(n) : null;
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
  if (n.state === "speak" && n.ducked && n.frame - n.lastVoiceFrame >= YIELD_RESUME_FRAMES) {
    n.ducked = false;
    out.push({ k: "resume-speech" });
    return;
  }
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
