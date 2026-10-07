/**
 * Human-level voice policy that does not need a microphone, a network,
 * a GPU, or today's date. A missing model is not-ready. Hardware latency
 * that was not measured stays unmeasured.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import { downloadSources } from "../../src/lib/friday/model-sources";
import { modelById } from "../../src/lib/friday/model-catalog";
import {
  BARGE_IN_STOP_BUDGET_MS,
  applySttTier,
  endpointSilenceMs,
  shouldDuck,
  speakerDecision,
  audioHealth,
  backchannel,
  captureMayRetry,
  clarifyPrompt,
  cloudSpeechAllowed,
  falseWakeRate,
  foreignAssistant,
  holdInterrupted,
  isHoldSound,
  recoverVoiceFault,
  speakingProsody,
  spokenFailure,
  voiceEval,
  wantsContinue,
  wordErrorRate,
  type VoiceFault,
} from "../../src/lib/friday/voice-session";

const require_ = createRequire(import.meta.url);
const download = require_(resolve(process.cwd(), "electron/model-download.cjs")) as {
  assertDiskRoom: (dir: string, need: number) => { measured: boolean };
  assertSha256: (file: string, expected: string) => void;
  hashFile: (file: string) => string;
};
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const FAULTS: VoiceFault[] = [
  "tts-crash",
  "asr-timeout",
  "barge-in",
  "device-ended",
  "permission-denied",
  "engine-down",
  "approval-expired",
  "injection",
  "model-missing",
  "disk-full",
  "bluetooth-switch",
  "sleep-resume",
  "echo-loop",
];

describe("windows audio health", () => {
  it("names a dead or blocked microphone instead of calling it live", () => {
    expect(audioHealth({ state: "available", available: true })).toBe("live");
    expect(audioHealth({ state: "available", available: false })).toBe("unavailable");
    expect(audioHealth({ state: "permission-denied", available: false })).toBe("permission-denied");
    expect(audioHealth({ state: "no-microphone", available: false })).toBe("no-device");
    expect(audioHealth({ state: "device-offline", available: false })).toBe("busy");
    expect(audioHealth({ state: "available", available: false, suspended: true })).toBe("asleep");
    expect(audioHealth({ state: "device-offline", available: false, exclusive: true })).toBe(
      "exclusive",
    );
    expect(audioHealth({ state: "no-microphone", available: false, recovering: true })).toBe(
      "recovering",
    );
  });

  it("retries a lost device a bounded number of times on the one capture path", () => {
    expect(captureMayRetry(0)).toBe(true);
    expect(captureMayRetry(5)).toBe(true);
    expect(captureMayRetry(6)).toBe(false);
    const audio = source("src/lib/friday/voice-audio.ts");
    expect(audio).toContain("captureMayRetry");
    expect(audio).toContain("devicechange");
    expect(audio).toContain("echoCancellation: true");
    expect(audio).not.toContain("sounddevice");
  });
});

describe("listening and speaking policy", () => {
  it("keeps today's speech model unless auto tiering has a measured RAM figure", () => {
    expect(applySttTier({ auto: false, ramGb: 32, gpu: true, battery: false })).toBe("small");
    expect(applySttTier({ auto: true, ramGb: 0, gpu: true, battery: false })).toBe("small");
    expect(applySttTier({ auto: true, ramGb: 32, gpu: true, battery: false })).toBe("large-v3");
    expect(applySttTier({ auto: true, ramGb: 32, gpu: false, battery: false })).toBe("medium");
    expect(applySttTier({ auto: true, ramGb: 32, gpu: true, battery: true })).toBe("small");
    expect(applySttTier({ auto: true, ramGb: 6, gpu: false, battery: false })).toBe("base");
    expect(applySttTier({ auto: true, ramGb: 2, gpu: false, battery: false })).toBe("tiny");
  });

  it("lets a low turn score wait longer and never shortens a mid-thought pause", () => {
    expect(endpointSilenceMs(true, "open chrome.")).toBe(420);
    expect(endpointSilenceMs(true, "open chrome.", 0.9)).toBe(420);
    expect(endpointSilenceMs(true, "open chrome.", 0.2)).toBe(1200);
    expect(endpointSilenceMs(true, "open chrome and", 0.95)).toBe(1200);
  });

  it("ducks other audio only while speaking, and a voiceprint never approves", () => {
    expect(shouldDuck({ enabled: true, speaking: true, quiet: false })).toBe(true);
    expect(shouldDuck({ enabled: true, speaking: true, quiet: true })).toBe(false);
    expect(shouldDuck({ enabled: false, speaking: true, quiet: false })).toBe(false);
    expect(shouldDuck({ enabled: true, speaking: false, quiet: false })).toBe(false);
    expect(speakerDecision({ similarity: null, enrolled: false, sensitive: false })).toEqual({
      allow: true,
      execute: false,
      reason: "ordinary",
    });
    expect(speakerDecision({ similarity: null, enrolled: false, sensitive: true }).allow).toBe(
      true,
    );
    expect(speakerDecision({ similarity: 0.2, enrolled: true, sensitive: true })).toEqual({
      allow: false,
      execute: false,
      reason: "speaker-mismatch",
    });
    expect(speakerDecision({ similarity: 0.9, enrolled: true, sensitive: true }).execute).toBe(
      false,
    );
    const duck = source("electron/audio-duck.cjs");
    expect(duck).toContain('process.platform !== "win32"');
    expect(duck).toContain("unsupported");
  });

  it("sends cloud speech only when the owner opted in and the text is not sensitive", () => {
    expect(cloudSpeechAllowed({ optedIn: false, sensitive: false })).toBe(false);
    expect(cloudSpeechAllowed({ optedIn: true, sensitive: true })).toBe(false);
    expect(cloudSpeechAllowed({ optedIn: true, sensitive: false })).toBe(true);
    const neural = source("electron/neural-voice.cjs");
    expect(neural).toContain('classify(spoken).level === "sensitive"');
    expect(neural).toContain("Neural$");
    expect(neural).toContain("hi-IN-SwaraNeural");
    const library = source("src/lib/friday/voice-library.ts");
    expect(library).toContain('tuning.kind === "neural"');
  });

  it("changes tone without changing a permission, and keeps backchannels rare", () => {
    const quiet = speakingProsody({
      baseRate: 1,
      basePitch: 1,
      baseVolume: 1,
      affect: "urgent",
      quiet: true,
    });
    expect(quiet.volume).toBeLessThanOrEqual(0.45);
    expect(quiet.rate).toBeGreaterThan(1);
    expect(backchannel({ hold: true, usedThisTurn: false, mode: "auto" })).toBe("Mm-hmm.");
    expect(backchannel({ hold: true, usedThisTurn: true, mode: "auto" })).toBe("");
    expect(backchannel({ hold: true, usedThisTurn: false, mode: "manual" })).toBe("");
    expect(isHoldSound("hmm")).toBe(true);
    expect(isHoldSound("open chrome")).toBe(false);
  });

  it("ignores another assistant, asks instead of guessing, and can resume", () => {
    expect(foreignAssistant("hey google turn on the lights")).toBe(true);
    expect(foreignAssistant("friday what time is it")).toBe(false);
    expect(clarifyPrompt("do it")).toBe("Which one do you mean?");
    expect(clarifyPrompt("what is this")).toBe("");
    expect(clarifyPrompt("open chrome")).toBe("");
    expect(wantsContinue("continue")).toBe(true);
    expect(wantsContinue("continue the build")).toBe(true);
    expect(wantsContinue("open chrome")).toBe(false);
    expect(holdInterrupted(["The build finished.", "Restart when you want."])).toContain(
      "Restart when you want.",
    );
    expect(holdInterrupted(["", "  "])).toBe("");
  });
});

describe("failure injection", () => {
  it("never executes from a voice fault, including the hardware and model rows", () => {
    for (const fault of FAULTS) {
      expect(recoverVoiceFault(fault).execute, fault).toBe(false);
    }
    expect(recoverVoiceFault("model-missing").textFallback).toBe(true);
    expect(recoverVoiceFault("model-missing").clarify).toBe(true);
    expect(recoverVoiceFault("disk-full").speak).toBe(false);
    expect(recoverVoiceFault("bluetooth-switch").taskContinues).toBe(true);
    expect(recoverVoiceFault("sleep-resume").taskContinues).toBe(true);
    expect(recoverVoiceFault("echo-loop").dropPlayback).toBe(true);
    expect(recoverVoiceFault("injection").execute).toBe(false);
    expect(spokenFailure("permission-denied")).toMatch(/microphone/i);
    expect(spokenFailure("injection")).toMatch(/ignored/i);
    expect(spokenFailure("barge-in")).toBe("");
  });
});

describe("offline eval", () => {
  it("scores fixture text and leaves an unmeasured barge-in unmeasured", () => {
    expect(wordErrorRate("open chrome", "open chrome")).toBe(0);
    expect(wordErrorRate("open chrome", "open chroma")).toBe(0.5);
    const unmeasured = voiceEval();
    expect(unmeasured.find((stage) => stage.stage === "wer-clean")?.verdict).toBe("pass");
    expect(unmeasured.find((stage) => stage.stage === "endpoint-cap")?.verdict).toBe("pass");
    expect(unmeasured.find((stage) => stage.stage === "barge-in-stop")?.verdict).toBe("unmeasured");
    expect(unmeasured.find((stage) => stage.stage === "false-wake")?.verdict).toBe("unmeasured");
    const inside = voiceEval({ bargeInStopMs: BARGE_IN_STOP_BUDGET_MS });
    expect(inside.find((stage) => stage.stage === "barge-in-stop")?.verdict).toBe("pass");
    const over = voiceEval({ bargeInStopMs: BARGE_IN_STOP_BUDGET_MS + 1 });
    expect(over.find((stage) => stage.stage === "barge-in-stop")?.verdict).toBe("fail");
    expect(falseWakeRate(2, 0)).toBeNull();
    expect(falseWakeRate(1, 2)).toBe(0.5);
  });
});

describe("install and diagnostics", () => {
  it("downloads Silero by checksum and does not add a second speech package", () => {
    const model = modelById.get("silero-vad");
    expect(model?.license).toBe("MIT");
    const sources = downloadSources(model!);
    expect(sources[0]).toMatchObject({
      kind: "url",
      sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
      bytes: 2327524,
    });
    const caps = source("kernel/requirements-capabilities.txt");
    expect(caps).toContain("Voice-stack rule");
    expect(caps).not.toMatch(/^kokoro-onnx/m);
    expect(caps).not.toMatch(/^piper-tts/m);
    expect(caps).not.toMatch(/^sherpa-onnx/m);
    expect(source("package.json")).toContain("voice:check");
    expect(source("package.json")).toContain("voice:install");
    const local = modelById.get("supertonic-3");
    expect(local?.license).toContain("MIT");
    expect(downloadSources(local!)[0]).toMatchObject({
      kind: "hf-repo",
      repo: "Supertone/supertonic-3",
    });
    const turn = modelById.get("smart-turn");
    expect(downloadSources(turn!)[0]).toMatchObject({
      kind: "url",
      sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
      bytes: 8679182,
    });
    expect(source("kernel/requirements-capabilities.txt")).toContain("supertonic>=");
    expect(source("kernel/requirements-capabilities.txt")).toContain("moonshine-voice>=");
    expect(source("electron/neural-voice.cjs")).toContain("supertonic-3");
    expect(source("electron/voice-verify.cjs")).toContain("voice_runtime.py");
    const main = source("kernel/main.py");
    expect(main).not.toMatch(/^import voice_runtime/m);
    expect(main).not.toMatch(/^from voice_runtime/m);
  });

  it("refuses a checksum mismatch and a disk that cannot hold the file", () => {
    const os = require_("node:os") as typeof import("node:os");
    const fs = require_("node:fs") as typeof import("node:fs");
    const path = require_("node:path") as typeof import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-voice-"));
    const file = path.join(dir, "sample.bin");
    fs.writeFileSync(file, "friday");
    expect(download.hashFile(file)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => download.assertSha256(file, "0".repeat(64))).toThrow(/checksum mismatch/);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => download.assertDiskRoom(dir, Number.MAX_SAFE_INTEGER)).toThrow(/disk full/);
  });
});
