/**
 * "Can FRIDAY Voice speak here" is one reading everywhere: the own engine reports ready, or the worker's flag says
 * available, or the Install Manager's package row says installed. The local failure reason travels with it, into the
 * failed-voice line and into the Doctor's layer rows. A reply pinned to Hindi is spoken through the Hindi path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { identity } from "../../src/lib/friday/brain/identity";
import { localVoiceReadiness } from "../../src/lib/friday/voice-library";
import { noVoiceFailure } from "../../src/lib/friday/tts-ladder";
import { noteVoiceCheck, voiceLayerChecks } from "../../src/lib/friday/voice-doctor";

type Driver = {
  state: Record<string, unknown> & { mode: string };
  offlineVoiceReady: boolean;
  offlineVoiceReason: string;
  offlineVoicePackage: boolean;
  offlineVoiceStatus: unknown;
  recomputeOfflineVoice: () => void;
  turnSpeaksHindi: () => boolean;
  turnRecord: { lang: string } | null;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const OWN_READY = { engine: "friday-voice", own: true, ready: true, reason: "" };
const OWN_BROKEN = {
  engine: "friday-voice",
  own: true,
  ready: false,
  reason: "model files missing",
};

describe("one reading of local voice readiness", () => {
  it("the own engine ready is enough, with no reason", () => {
    expect(localVoiceReadiness({ available: false, fridayVoice: OWN_READY }, false)).toEqual({
      ready: true,
      reason: "",
    });
  });

  it("the package row alone is enough, and the worker's failure reason still travels", () => {
    const out = localVoiceReadiness({ available: false, fridayVoice: OWN_BROKEN }, true);
    expect(out.ready).toBe(true);
    expect(out.reason).toBe("model files missing");
  });

  it("nothing ready carries the worker's reason", () => {
    expect(localVoiceReadiness({ available: false, reason: "not installed" }, false)).toEqual({
      ready: false,
      reason: "not installed",
    });
  });

  it("no status and no package is not ready, with no invented reason", () => {
    expect(localVoiceReadiness(null, false)).toEqual({ ready: false, reason: "" });
    expect(localVoiceReadiness(undefined, true).ready).toBe(true);
  });
});

describe("the conductor follows it", () => {
  beforeEach(async () => {
    await preferences.hydrate();
    autonomy.reset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("recompute joins the worker status and the package row", () => {
    d.offlineVoicePackage = false;
    d.offlineVoiceStatus = { available: false, fridayVoice: OWN_READY };
    d.recomputeOfflineVoice();
    expect(d.offlineVoiceReady).toBe(true);
    d.offlineVoiceStatus = { available: false, reason: "worker is down" };
    d.recomputeOfflineVoice();
    expect(d.offlineVoiceReady).toBe(false);
    expect(d.offlineVoiceReason).toBe("worker is down");
  });
});

describe("the failure reason is on the line", () => {
  it("the failed-voice line carries the local reason", () => {
    expect(noVoiceFailure("hello", "model files missing")).toMatch(/model files missing/);
    expect(noVoiceFailure("नमस्ते", "model files missing")).toMatch(/model files missing/);
    expect(noVoiceFailure("hello")).not.toMatch(/\(\s*\)/);
  });

  it("a failed Doctor layer row names why", () => {
    noteVoiceCheck([{ id: "tts-voice", ok: false, detail: "no voice file for hi-IN" }]);
    const row = voiceLayerChecks({ tts: "fail" }).find((r) => r.id === "voice:tts");
    expect(row?.detail).toMatch(/no voice file for hi-IN/);
  });
});

describe("a reply pinned to Hindi", () => {
  afterEach(() => identity.updateProfile({ replyLanguage: "follow-user" }));

  it("is spoken through the Hindi path whatever the heard turn was", () => {
    d.turnRecord = null;
    identity.updateProfile({ replyLanguage: "hindi" });
    expect(d.turnSpeaksHindi()).toBe(true);
  });

  it("another pin is not Hindi, and follow-user needs a Hindi turn", () => {
    d.turnRecord = null;
    identity.updateProfile({ replyLanguage: "english" });
    expect(d.turnSpeaksHindi()).toBe(false);
    identity.updateProfile({ replyLanguage: "hinglish" });
    expect(d.turnSpeaksHindi()).toBe(false);
    identity.updateProfile({ replyLanguage: "follow-user" });
    expect(d.turnSpeaksHindi()).toBe(false);
  });
});
