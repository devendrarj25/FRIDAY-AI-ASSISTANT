import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Auto Mode local speech recognition contract", () => {
  it("never references Chromium's cloud SpeechRecognition API", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).not.toMatch(/webkitSpeechRecognition|\bSpeechRecognition\b|recognitionCtor/);
  });

  it("requires local STT from capture through the existing IPC handler", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    const dictation = source("src/lib/friday/voice-stt.ts");
    const preload = source("electron/preload.cjs");
    const main = source("electron/main.cjs");
    const stt = source("electron/stt.cjs");

    expect(assistant).toContain("localOnly: true");
    expect(dictation).toContain("localOnly: Boolean(this.options.localOnly)");
    expect(preload).toMatch(/voice:stt-status[\s\S]*localOnly/);
    expect(main).toMatch(/voice:stt-status[\s\S]*stt\.status[\s\S]*localOnly/);
    expect(main).toMatch(/voice:transcribe[\s\S]*stt\.transcribe/);
    expect(stt).toContain("status(false, { localOnly: Boolean(req.localOnly) })");
    expect(stt).toContain("Boolean(options?.warm)");
    expect(stt).toContain("ensureWorker");
    expect(stt).toContain("function shutdown");
    expect(stt).toContain('child.stderr?.on("data"');
    expect(source("electron/wake-engine.cjs")).toContain('child.stderr?.on("data"');
    expect(assistant).toContain("sttStatus(false, true, true)");
    expect(stt).toContain("if (!value.available && !localOnly)");
  });

  it("keeps VAD segmentation, barge-in, echo rejection, and the existing command sink", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    const dictation = source("src/lib/friday/voice-stt.ts");

    expect(dictation).toContain("voiceGate.subscribe");
    expect(dictation).toContain("onSpeechStart?.()");
    expect(assistant).toContain("barge-in — stopping playback");
    expect(assistant).toContain("this.cancelSpeech();");
    expect(assistant).toContain("if (this.recentlySpeaking() && this.isSelfEcho(text))");

    expect(assistant).toContain("this.handleHeard(text, meta?.wake ?? null)");
  });

  it("keeps retrying a dead STT session and speaks each cause once", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("recoveryDelayMs");
    expect(assistant).toContain("resumeAfterSpokenReply");
    expect(assistant).toContain("shouldRetryNow");
    expect(assistant).toContain('noteVoiceTrigger("install-finished")');
    expect(assistant).toContain('noteVoiceTrigger("model-ready")');
    expect(assistant).toContain('noteVoiceTrigger("settings")');
    expect(assistant).toContain('noteVoiceTrigger("device")');
    expect(assistant).toContain('noteVoiceTrigger("focus")');
    expect(assistant).toContain('noteVoiceTrigger("toggle")');
    expect(assistant).toContain('noteVoiceTrigger("fix-voice")');
    expect(assistant).toContain("scheduleSttRecovery");
    expect(source("src/lib/friday/voice-recovery.ts")).toContain("persistentRetryDelayMs");
    expect(assistant).toContain("mayAnnounce");
    expect(assistant).toContain("voiceOwnerGuidance");
    expect(assistant).toContain("formatGuidance");
    expect(assistant).toContain("resumeAfterSpeech");
    expect(assistant).not.toContain("Number.MAX_SAFE_INTEGER");
    expect(assistant).not.toContain("STT_RETRY_COOLDOWN_MS");
  });
});
