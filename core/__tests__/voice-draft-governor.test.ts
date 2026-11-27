import { describe, expect, it } from "vitest";
import {
  DRAFT_AUDIO_CAP_MS,
  DRAFT_PER_TURN_CAP,
  draftVerdict,
  governDraft,
  initialDraftGov,
  noteDraft,
  type DraftGovState,
  type DraftRequest,
} from "../../src/lib/friday/voice-engine/draft-governor";
import type { DraftVerdict } from "../../src/lib/friday/voice-engine/turn-engine";

const req = (over: Partial<DraftRequest> = {}): DraftRequest => ({
  turnId: "t1",
  text: "kya time hua",
  audioMs: 2000,
  lane: "quick",
  readOnly: true,
  ...over,
});

const st = (over: Partial<DraftGovState> = {}): DraftGovState => ({
  inFlight: false,
  thisTurn: 0,
  audioMsThisTurn: 0,
  ...over,
});

describe("governDraft", () => {
  it("allows a read-only quick draft on a fresh turn", () => {
    expect(governDraft(st(), req())).toEqual({ ok: true });
  });

  it("refuses while one is in flight", () => {
    expect(governDraft(st({ inFlight: true }), req())).toEqual({ ok: false, why: "in-flight" });
  });

  it("4th draft refused turn-cap", () => {
    expect(DRAFT_PER_TURN_CAP).toBe(3);
    expect(governDraft(st({ thisTurn: 2 }), req())).toEqual({ ok: true });
    expect(governDraft(st({ thisTurn: 3 }), req())).toEqual({ ok: false, why: "turn-cap" });
  });

  it("refuses past 10 s of audio, allows exactly 10 s", () => {
    expect(DRAFT_AUDIO_CAP_MS).toBe(10_000);
    expect(governDraft(st({ audioMsThisTurn: 8000 }), req({ audioMs: 2000 }))).toEqual({
      ok: true,
    });
    expect(governDraft(st({ audioMsThisTurn: 8000 }), req({ audioMs: 2001 }))).toEqual({
      ok: false,
      why: "audio-cap",
    });
    expect(governDraft(st(), req({ audioMs: 10_001 }))).toEqual({ ok: false, why: "audio-cap" });
  });

  it("refuses a draft that is not read-only", () => {
    expect(governDraft(st(), req({ readOnly: false }))).toEqual({
      ok: false,
      why: "not-read-only",
    });
  });

  it("refuses anything but the quick lane", () => {
    expect(governDraft(st(), req({ lane: "deep" }))).toEqual({ ok: false, why: "lane" });
  });

  it("reports the lane and read-only reasons before the caps", () => {
    const full = st({ inFlight: true, thisTurn: 3, audioMsThisTurn: 10_000 });
    expect(governDraft(full, req({ lane: "deep" }))).toEqual({ ok: false, why: "lane" });
    expect(governDraft(full, req({ readOnly: false }))).toEqual({
      ok: false,
      why: "not-read-only",
    });
    expect(governDraft(full, req())).toEqual({ ok: false, why: "in-flight" });
    expect(governDraft(st({ thisTurn: 3, audioMsThisTurn: 10_000 }), req())).toEqual({
      ok: false,
      why: "turn-cap",
    });
  });

  it("does not mutate its inputs", () => {
    const s = Object.freeze(st({ thisTurn: 1 }));
    const r = Object.freeze(req());
    expect(() => governDraft(s, r)).not.toThrow();
    expect(s).toEqual(st({ thisTurn: 1 }));
  });
});

describe("noteDraft", () => {
  it("start marks in flight and counts the draft with its audio", () => {
    expect(noteDraft(st(), "start", 2500)).toEqual({
      inFlight: true,
      thisTurn: 1,
      audioMsThisTurn: 2500,
    });
  });

  it("start without audio adds none", () => {
    expect(noteDraft(st({ audioMsThisTurn: 100 }), "start").audioMsThisTurn).toBe(100);
  });

  it("end clears in flight and keeps the counts", () => {
    expect(noteDraft(st({ inFlight: true, thisTurn: 2, audioMsThisTurn: 4000 }), "end")).toEqual({
      inFlight: false,
      thisTurn: 2,
      audioMsThisTurn: 4000,
    });
  });

  it("new-turn resets everything", () => {
    expect(
      noteDraft(st({ inFlight: true, thisTurn: 3, audioMsThisTurn: 9000 }), "new-turn"),
    ).toEqual(initialDraftGov());
    expect(initialDraftGov()).toEqual(st());
  });

  it("returns a new object and never mutates the old one", () => {
    const s = Object.freeze(st());
    const next = noteDraft(s, "start", 1000);
    expect(next).not.toBe(s);
    expect(s).toEqual(st());
    expect(Object.isFrozen(initialDraftGov())).toBe(false);
  });

  it("a full turn: three drafts run, the fourth is refused, a new turn allows again", () => {
    let s = initialDraftGov();
    for (let i = 0; i < 3; i += 1) {
      expect(governDraft(s, req({ audioMs: 1000 }))).toEqual({ ok: true });
      s = noteDraft(s, "start", 1000);
      expect(governDraft(s, req({ audioMs: 1000 }))).toEqual({ ok: false, why: "in-flight" });
      s = noteDraft(s, "end");
    }
    expect(governDraft(s, req({ audioMs: 1000 }))).toEqual({ ok: false, why: "turn-cap" });
    s = noteDraft(s, "new-turn");
    expect(governDraft(s, req({ audioMs: 1000 }))).toEqual({ ok: true });
  });
});

describe("draftVerdict", () => {
  it("maps a result onto the turn engine's DraftVerdict", () => {
    const yes: DraftVerdict = draftVerdict({ ok: true });
    const no: DraftVerdict = draftVerdict({ ok: false, why: "turn-cap" });
    expect(yes).toEqual({ allow: true });
    expect(no).toEqual({ allow: false });
  });
});
