import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  failureCause,
  ownerVoiceLang,
  recoveryDelayMs,
  resumeAfterSpokenReply,
  shouldRetryNow,
  voiceFailureLine,
} from "../../src/lib/friday/voice-recovery";

const require_ = createRequire(import.meta.url);
const weights = require_("../../electron/voice-weights.cjs") as {
  sttPlan: (model: string, root: string) => { repo: string; dir: string; sha256: string | null };
  weightsReady: (dir: string, exists: (file: string) => boolean) => boolean;
  ensureSttWeights: (
    model: string,
    root: string,
    deps: {
      exists: (file: string) => boolean;
      downloadModel?: (job: { modelId: string }) => Promise<{ ok: boolean; cause?: string }>;
    },
  ) => Promise<{ ok: boolean; cause?: string; dir: string }>;
  otherVoiceJobs: () => Array<{ id: string; url: string | null }>;
  pinnedJobs: () => Array<{ id: string; sha256: string }>;
};

describe("voice failure lines use the cause", () => {
  it("says a different human line for each cause and language", () => {
    const causes = [
      "install",
      "permission",
      "busy",
      "exclusive",
      "device",
      "downloading",
      "model-failed",
    ];
    const lines = causes.map((cause) => voiceFailureLine(cause, 0, "en"));
    expect(new Set(lines).size).toBe(causes.length);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(8);
      expect(line).not.toMatch(/faster-whisper|python|onnx|pip\b|CTranslate/i);
    }
    expect(voiceFailureLine("permission", 0, "hi")).toMatch(/permission|Microphone/i);
    expect(voiceFailureLine("busy", 1, "hinglish")).toMatch(/busy|Mic/i);
    expect(voiceFailureLine("install", 0, "en")).not.toBe(voiceFailureLine("install", 1, "en"));
    expect(ownerVoiceLang("hi-IN")).toBe("hi");
    expect(ownerVoiceLang("en-IN")).toBe("hinglish");
    expect(failureCause("the speech model is still downloading")).toBe("downloading");
    expect(failureCause("model failed to load")).toBe("model-failed");
  });
});

describe("recovery triggers", () => {
  it("retries immediately for the live triggers and backs off only through one delay", () => {
    for (const trigger of [
      "install-finished",
      "model-ready",
      "settings",
      "device",
      "focus",
      "toggle",
      "fix-voice",
    ]) {
      expect(shouldRetryNow(trigger)).toBe(true);
    }
    expect(shouldRetryNow("timer")).toBe(false);
    expect(resumeAfterSpokenReply({ mode: "auto", paused: false, dictationActive: false })).toBe(
      true,
    );
    expect(resumeAfterSpokenReply({ mode: "manual", paused: false })).toBe(false);
    expect(resumeAfterSpokenReply({ mode: "auto", paused: true })).toBe(false);
    expect(recoveryDelayMs(0)).toBe(0);
    expect(recoveryDelayMs(1)).toBeGreaterThan(recoveryDelayMs(0));
    expect(recoveryDelayMs(3)).toBe(8000);
  });
});

describe("speech weights are local before the worker", () => {
  it("plans a Hugging Face snapshot and refuses a silent worker download", async () => {
    const plan = weights.sttPlan("base", "/friday");
    expect(plan.repo).toBe("Systran/faster-whisper-base");
    expect(plan.dir).toMatch(/cache[\\/]stt[\\/]base$/);
    expect(plan.sha256).toBeNull();
    expect(weights.weightsReady(plan.dir, () => false)).toBe(false);
    const missing = await weights.ensureSttWeights("base", "/friday", {
      exists: () => false,
    });
    expect(missing.ok).toBe(false);
    expect(missing.cause).toBe("downloading");
    let called = "";
    const ready = await weights.ensureSttWeights("small", "/friday", {
      exists: (file) => /model\.bin$|config\.json$/.test(file),
      downloadModel: async (job) => {
        called = job.modelId;
        return { ok: true };
      },
    });
    expect(ready.ok).toBe(true);
    expect(called).toBe("");
    const fetched = await weights.ensureSttWeights("tiny", "/friday", {
      exists: () => false,
      downloadModel: async (job) => {
        called = job.modelId;
        return { ok: false, cause: "disk" };
      },
    });
    expect(fetched.ok).toBe(false);
    expect(called).toBe("tiny");
    expect(weights.otherVoiceJobs().every((row) => row.url == null)).toBe(true);
    expect(
      weights
        .pinnedJobs()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["silero-vad", "smart-turn"]);
  });
});
