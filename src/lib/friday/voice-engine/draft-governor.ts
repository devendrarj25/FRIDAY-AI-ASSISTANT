/**
 * Speculative-draft limits, pure. While the owner is still finishing a sentence the turn
 * engine may start a draft answer early; this says when it may not. One draft in flight,
 * three per turn, ten seconds of audio per turn, and only read-only work in the quick lane,
 * so a draft can never act, and the cost of a wrong guess stays small.
 */
import type { DraftRequest as EngineDraftRequest, DraftVerdict } from "./turn-engine";

export const DRAFT_PER_TURN_CAP = 3;
export const DRAFT_AUDIO_CAP_MS = 10_000;

export type DraftLane = "quick" | "deep";

export type DraftGovState = {
  inFlight: boolean;
  /** Drafts started in the open turn. */
  thisTurn: number;
  /** Audio the open turn's drafts have covered. */
  audioMsThisTurn: number;
};

/** The engine's request (turn id and text), plus what the governor needs to judge it. */
export type DraftRequest = Pick<EngineDraftRequest, "turnId" | "text"> & {
  audioMs: number;
  lane: DraftLane;
  readOnly: boolean;
};

export type DraftRefusal = "in-flight" | "turn-cap" | "audio-cap" | "not-read-only" | "lane";
export type DraftGovResult = { ok: true } | { ok: false; why: DraftRefusal };

export function initialDraftGov(): DraftGovState {
  return { inFlight: false, thisTurn: 0, audioMsThisTurn: 0 };
}

/** Whether a draft may start now. Never mutates `s` or `req`. */
export function governDraft(s: DraftGovState, req: DraftRequest): DraftGovResult {
  if (req.lane !== "quick") return { ok: false, why: "lane" };
  if (!req.readOnly) return { ok: false, why: "not-read-only" };
  if (s.inFlight) return { ok: false, why: "in-flight" };
  if (s.thisTurn >= DRAFT_PER_TURN_CAP) return { ok: false, why: "turn-cap" };
  if (s.audioMsThisTurn + Math.max(0, req.audioMs) > DRAFT_AUDIO_CAP_MS) {
    return { ok: false, why: "audio-cap" };
  }
  return { ok: true };
}

/** The next state after a draft starts (with the audio it covers), ends, or a new turn opens. */
export function noteDraft(
  s: DraftGovState,
  ev: "start" | "end" | "new-turn",
  audioMs = 0,
): DraftGovState {
  if (ev === "new-turn") return initialDraftGov();
  if (ev === "end") return { ...s, inFlight: false };
  return {
    inFlight: true,
    thisTurn: s.thisTurn + 1,
    audioMsThisTurn: s.audioMsThisTurn + Math.max(0, audioMs),
  };
}

/** The turn engine's `draft` hook answers with this shape. */
export function draftVerdict(r: DraftGovResult): DraftVerdict {
  return { allow: r.ok };
}
