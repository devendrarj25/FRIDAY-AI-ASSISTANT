/**
 * Who may create a Brain turn when two recognisers hear the same utterance.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_CLOUD_PREFS,
  sanitizeCloudPrefs,
  toRouterSettings,
} from "../../src/lib/friday/voice-engine/voice-cloud-settings";
import {
  SttBillingReconciler,
  createUtteranceArbiter,
  type SttAuthority,
  type Utterance,
} from "../../src/lib/friday/voice-engine/stt-authority";
import { createRealtimeStt } from "../../src/lib/friday/voice-engine/sarvam-realtime-stt";
import type { VoiceTranscriptEvent } from "../../src/lib/friday/voice-engine/voice-contracts";

function rig(
  initial: {
    authority?: SttAuthority;
    healthy?: boolean;
    gate?: { ok: boolean; reason?: string };
  } = {},
) {
  const state = {
    authority: initial.authority ?? ("sarvam" as SttAuthority),
    healthy: initial.healthy ?? true,
    gate: initial.gate ?? { ok: true },
    clock: 1_000,
  };
  const submitted: Utterance[] = [];
  const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = [];
  const arbiter = createUtteranceArbiter({
    authority: () => state.authority,
    cloudHealthy: () => state.healthy,
    gate: () => state.gate,
    submit: (u) => submitted.push(u),
    now: () => state.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: state.clock + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    graceMs: 1500,
    pairWindowMs: 2500,
  });
  const advance = (ms: number) => {
    state.clock += ms;
    for (const t of timers) {
      if (t.cleared || t.at > state.clock) continue;
      t.cleared = true;
      t.fn();
    }
  };
  return { arbiter, state, submitted, advance };
}

describe("captions-only mode (the default)", () => {
  it("never lets Sarvam text start a turn, and lets the local final through at once", () => {
    const r = rig({ authority: "captions" });
    expect(r.arbiter.cloudFinal("hello there")).toMatchObject({
      action: "drop",
      reason: "captions-only",
    });
    expect(r.arbiter.local("hello there")).toEqual({ action: "submit", source: "local" });
    expect(r.submitted.map((u) => u.source)).toEqual(["local"]);
  });
});

describe("Sarvam as the authoritative input", () => {
  it("never submits a partial", () => {
    const r = rig();
    expect(r.arbiter.cloudPartial()).toMatchObject({ action: "drop", reason: "partial" });
    expect(r.submitted).toEqual([]);
  });

  it("uses the Sarvam final and drops the held local copy of the same utterance", () => {
    const r = rig();
    expect(r.arbiter.local("kal ka mausam")).toEqual({ action: "hold" });
    expect(r.submitted).toEqual([]); // nothing reaches the Brain while the cloud may still answer
    r.advance(400);
    expect(r.arbiter.cloudFinal("कल का मौसम", "hi-IN", "t3")).toEqual({
      action: "submit",
      source: "sarvam",
    });
    r.advance(5000); // the held timer was cancelled: no second turn
    expect(r.submitted).toEqual([
      { text: "कल का मौसम", source: "sarvam", language: "hi-IN", turnId: "t3" },
    ]);
    // A local final of the next utterance is a new turn, not the counterpart of the first.
    expect(r.arbiter.local("next one")).toEqual({ action: "hold" });
  });

  it("drops the local copy that arrives after the cloud final already created the turn", () => {
    const r = rig();
    expect(r.arbiter.cloudFinal("open the report")).toEqual({ action: "submit", source: "sarvam" });
    r.advance(800);
    expect(r.arbiter.local("open the report")).toMatchObject({
      action: "drop",
      reason: "counterpart-of-submitted",
    });
    expect(r.submitted).toHaveLength(1);
  });

  it("uses the local final when the cloud never answers, so no utterance is lost, and drops a late cloud copy", () => {
    const r = rig();
    r.arbiter.local("set a timer");
    r.advance(1499);
    expect(r.submitted).toEqual([]);
    r.advance(2);
    expect(r.submitted.map((u) => u.source)).toEqual(["local"]);
    r.advance(300);
    expect(r.arbiter.cloudFinal("set a timer")).toMatchObject({
      action: "drop",
      reason: "counterpart-of-submitted",
    });
    expect(r.submitted).toHaveLength(1);
  });

  it("rejects the same cloud final delivered twice", () => {
    const r = rig();
    r.arbiter.cloudFinal("what time is it");
    r.advance(100);
    expect(r.arbiter.cloudFinal("What time is it?")).toMatchObject({
      action: "drop",
      reason: "duplicate",
    });
    expect(r.submitted).toHaveLength(1);
  });

  it("treats a second final from the same engine as a new utterance, not as the other engine's copy", () => {
    const r = rig();
    r.arbiter.cloudFinal("first thing");
    r.advance(200);
    // The local recogniser missed the first one; its next final is for something new said right after.
    expect(r.arbiter.cloudFinal("second thing")).toEqual({ action: "submit", source: "sarvam" });
    expect(r.submitted.map((u) => u.text)).toEqual(["first thing", "second thing"]);
  });

  it("does not wait for the cloud when the stream is not open, and uses the local final at once", () => {
    const r = rig({ healthy: false });
    expect(r.arbiter.local("hello")).toEqual({ action: "submit", source: "local" });
  });

  it("releases a held local final when the stream is lost", () => {
    const r = rig();
    r.arbiter.local("hello");
    r.arbiter.cloudLost();
    expect(r.submitted.map((u) => u.source)).toEqual(["local"]);
    r.advance(5000);
    expect(r.submitted).toHaveLength(1); // not submitted a second time by the timer
  });

  it("an empty final is ignored by both engines", () => {
    const r = rig();
    expect(r.arbiter.local("   ")).toMatchObject({ action: "drop", reason: "empty" });
    expect(r.arbiter.cloudFinal("")).toMatchObject({ action: "drop", reason: "empty" });
  });
});

describe("the cloud gates stay mandatory", () => {
  it("drops a cloud final when a gate fails at the moment it arrives, and hands the utterance to the local text", () => {
    const r = rig();
    r.arbiter.local("send the file");
    r.state.gate = { ok: false, reason: "privacy mode is on" };
    expect(r.arbiter.cloudFinal("send the file")).toMatchObject({
      action: "drop",
      reason: "blocked",
      detail: "privacy mode is on",
    });
    expect(r.submitted.map((u) => u.source)).toEqual(["local"]); // released at once, not after the wait
  });

  it("does not hold a local final while a gate is closed", () => {
    const r = rig({ gate: { ok: false, reason: "no key" } });
    expect(r.arbiter.local("hello")).toEqual({ action: "submit", source: "local" });
  });

  it("falls back to local the moment the owner switches the authority off", () => {
    const r = rig();
    r.arbiter.local("hello");
    r.state.authority = "captions";
    expect(r.arbiter.cloudFinal("hello")).toMatchObject({
      action: "drop",
      reason: "captions-only",
    });
    r.advance(1600);
    expect(r.submitted.map((u) => u.source)).toEqual(["local"]);
  });
});

describe("a transcript event from the stream", () => {
  it("creates one turn for one final even when the stream repeats it", async () => {
    const r = rig();
    const finals: Array<Extract<VoiceTranscriptEvent, { type: "final" }>> = [];
    const emit: Array<(p: { id: string; event: { type: string; text?: string } }) => void> = [];
    const stt = createRealtimeStt({
      api: {
        voiceStreamOpen: async () => ({ ok: true }),
        voiceStreamSend: async () => ({ ok: true }),
        voiceStreamClose: async () => ({ ok: true }),
        onVoiceStreamOpened: () => () => undefined,
        onVoiceStreamEvent: (cb: never) => (emit.push(cb), () => undefined),
        onVoiceStreamClosed: () => () => undefined,
      } as never,
      sessionId: "auto",
      onTranscript: (event) => {
        if (event.type === "partial") r.arbiter.cloudPartial();
      },
      onFinalTurn: (final) => {
        finals.push(final);
        r.arbiter.cloudFinal(final.text, final.language, final.turnId);
      },
    });
    await stt.start({});
    const id = "stt-auto-1";
    const send = (event: { type: string; text?: string }) => emit.forEach((f) => f({ id, event }));
    send({ type: "partial", text: "open the" });
    send({ type: "partial", text: "open the report" });
    send({ type: "final", text: "open the report" });
    expect(finals).toHaveLength(1);
    expect(r.submitted.map((u) => u.text)).toEqual(["open the report"]);
  });
});

describe("billing is reconciled", () => {
  it("records the provider's figure once, in place of the estimate", () => {
    const b = new SttBillingReconciler();
    b.addSentSeconds(10);
    b.addSentSeconds(5.5);
    b.reportBilled(14);
    expect(b.take()).toEqual({ seconds: 14, source: "provider" });
    expect(b.take()).toEqual({ seconds: 0, source: "none" }); // never recorded twice
  });

  it("falls back to the estimate when the stream dropped before the provider reported", () => {
    const b = new SttBillingReconciler();
    b.addSentSeconds(8);
    expect(b.hasBilled).toBe(false);
    expect(b.take()).toEqual({ seconds: 8, source: "estimate" });
  });

  it("ignores nonsense and starts clean after each session", () => {
    const b = new SttBillingReconciler();
    b.addSentSeconds(Number.NaN);
    b.addSentSeconds(-3);
    b.reportBilled(Number.NaN);
    expect(b.take().source).toBe("none");
    b.reportBilled(0);
    expect(b.take()).toEqual({ seconds: 0, source: "provider" });
  });
});

describe("the option and its wiring", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");

  it("is off by default and kept only while the stream that supplies it is permitted", () => {
    expect(DEFAULT_VOICE_CLOUD_PREFS.sttAuthority).toBe("captions");
    expect(sanitizeCloudPrefs({}).sttAuthority).toBe("captions");
    const on = { cloudEnabled: true, streamCaptions: true, sttAuthority: "sarvam" as const };
    expect(sanitizeCloudPrefs(on).sttAuthority).toBe("sarvam");
    expect(sanitizeCloudPrefs({ ...on, cloudEnabled: false }).sttAuthority).toBe("captions");
    expect(sanitizeCloudPrefs({ ...on, streamCaptions: false }).sttAuthority).toBe("captions");
    expect(sanitizeCloudPrefs({ sttAuthority: "other" } as never).sttAuthority).toBe("captions");
    // The router's own settings never carry it.
    expect(toRouterSettings(sanitizeCloudPrefs(on), {})).not.toHaveProperty("sttAuthority");
  });

  it("sends every finished utterance of either engine through the one arbiter before the Brain", () => {
    expect(mode).toContain("this.sttArbiter().local(trimmed)");
    expect(mode).toContain("this.sttArbiter().cloudFinal(final.text");
    // The only call that turns heard text into a turn is the arbiter's submit.
    const accept = mode.slice(mode.indexOf("private acceptFinalUtterance"));
    expect(accept).toContain("this.handleHeard(text, meta?.wake ?? null)");
    const onFinal = mode.slice(mode.indexOf("onFinal: (text, meta) => {"));
    expect(onFinal.slice(0, 600)).not.toContain("handleHeard(");
    // A partial from the stream only draws the caption.
    const partial = mode.slice(mode.indexOf('if (event.type !== "partial") return;'));
    expect(partial.slice(0, 500)).toContain("this.state.interim = event.text");
  });

  it("asks the cloud gates again for every Sarvam final, including privacy mode", () => {
    const gate = mode.slice(
      mode.indexOf("private cloudSttGate"),
      mode.indexOf("private acceptFinalUtterance"),
    );
    expect(gate).toContain("privacyMode === true");
    expect(gate).toContain("cloudEnabled");
    expect(gate).toContain('allowedProviders.includes("sarvam")');
    expect(gate).toContain("canStreamSpeechToText");
  });

  it("records the audio seconds once when the stream closes, from the provider's figure when it came", () => {
    expect(mode).toContain(
      "onBilledSeconds: (seconds) => this.captionBilling.reportBilled(seconds)",
    );
    expect(mode).toContain("this.captionBilling.take()");
    expect(mode).not.toContain('ledger.record("sarvam", seconds / 60)');
  });
});
