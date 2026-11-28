/**
 * The busy status line names an approval wait, the failed-voice reason is quoted only for a local-engine route,
 * and the local voice reason is read again after an install, a model, a settings change or Fix voice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; muted: boolean };
  offlineVoiceReason: string;
  busyStatusLine: (kind: "reply" | "queue", awaitingApproval: boolean) => string;
  localVoiceFailureReason: (route: { engine: string; cloud: boolean }) => string;
  refreshOfflineVoice: () => Promise<void>;
  resetVoiceRecovery: () => void;
  startRecognition: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

describe("busy status line", () => {
  it("says it is waiting for approval when the run waits at one", () => {
    expect(d.busyStatusLine("reply", true)).toBe("Waiting for your approval");
    expect(d.busyStatusLine("queue", true)).toBe("Waiting for your approval");
  });
  it("keeps the working lines otherwise", () => {
    expect(d.busyStatusLine("reply", false)).toBe("Working — still on it");
    expect(d.busyStatusLine("queue", false)).toBe("Working — next request queued");
  });
});

describe("failed-voice reason", () => {
  afterEach(() => {
    d.offlineVoiceReason = "";
  });
  it("is quoted for the local engines and for a route that never started", () => {
    d.offlineVoiceReason = "model files missing";
    expect(d.localVoiceFailureReason({ engine: "", cloud: false })).toBe("model files missing");
    expect(d.localVoiceFailureReason({ engine: "supertonic", cloud: false })).toBe(
      "model files missing",
    );
    expect(d.localVoiceFailureReason({ engine: "sapi", cloud: false })).toBe("model files missing");
  });
  it("is not blamed on a cloud or other engine", () => {
    d.offlineVoiceReason = "model files missing";
    expect(d.localVoiceFailureReason({ engine: "edge-neural", cloud: true })).toBe("");
    expect(d.localVoiceFailureReason({ engine: "speechSynthesis", cloud: false })).toBe("");
  });
});

describe("the local voice reason is refreshed on retry", () => {
  afterEach(() => vi.restoreAllMocks());
  const arm = () => {
    d.state.mode = "auto";
    d.state.paused = false;
    d.state.muted = false;
    const refresh = vi.spyOn(d, "refreshOfflineVoice").mockResolvedValue();
    vi.spyOn(d, "resetVoiceRecovery").mockImplementation(() => undefined);
    vi.spyOn(d, "startRecognition").mockImplementation(() => undefined);
    return refresh;
  };
  it.each(["install-finished", "model-ready", "settings"])("after %s", (trigger) => {
    const refresh = arm();
    assistantMode.noteVoiceTrigger(trigger);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(["focus", "device"])("not on every %s", (trigger) => {
    const refresh = arm();
    assistantMode.noteVoiceTrigger(trigger);
    expect(refresh).not.toHaveBeenCalled();
  });
});
