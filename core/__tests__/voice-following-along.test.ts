/**
 * Talking over FRIDAY. ChatGPT's voice and Gemini Live keep going through a "mm-hmm"; a real interruption stops them.
 * FRIDAY used to cancel the whole answer on the first sound. Now playback pauses, and the words decide: a nod resumes,
 * a question or command stops for good, noise resumes after a short wait.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isFollowingAlong, judgeInterruption } from "../../src/lib/friday/voice-session";

describe("following along is not an interruption", () => {
  it("knows a nod in English, Hindi and Hinglish", () => {
    for (const nod of [
      "yeah",
      "Okay.",
      "ok ok",
      "mm-hmm",
      "uh huh",
      "right",
      "got it",
      "haan",
      "haan ji",
      "achha",
      "accha!",
      "theek hai",
      "samajh gaya",
      "bilkul",
      "go on",
      "aage bolo",
      "ji",
    ]) {
      expect(isFollowingAlong(nod), nod).toBe(true);
    }
  });

  it("does not treat content, questions or stops as a nod", () => {
    for (const real of [
      "wait what did you say about the invoice",
      "okay but can you do it tomorrow instead",
      "stop",
      "no no wait",
      "haan lekin pehle email bhejo",
      "what is the weather",
      "",
      "yeah right whatever you say",
    ]) {
      expect(isFollowingAlong(real), real).toBe(false);
    }
  });

  it("a yes is an answer, not a nod, while something waits for one", () => {
    expect(judgeInterruption("yes", { waitingForAnswer: true, selfEcho: false })).toBe("interrupt");
    expect(judgeInterruption("haan", { waitingForAnswer: true, selfEcho: false })).toBe(
      "interrupt",
    );
    expect(judgeInterruption("haan", { waitingForAnswer: false, selfEcho: false })).toBe("resume");
  });

  it("her own voice coming back is noise, a real sentence is an interruption", () => {
    expect(
      judgeInterruption("the invoice total is", { waitingForAnswer: false, selfEcho: true }),
    ).toBe("resume");
    expect(
      judgeInterruption("actually send it to Rahul", { waitingForAnswer: false, selfEcho: false }),
    ).toBe("interrupt");
  });
});

describe("the voice loop pauses first and decides on the words", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"),
    "utf8",
  );

  it("starting to talk pauses playback but does not stop the answer", () => {
    const start = source.slice(source.indexOf("onSpeechStart: () => {"));
    const block = start.slice(0, start.indexOf('this.to("vad-speech")'));
    expect(block).toContain("this.holdForInterruption()");
    expect(block).not.toContain("this.cancelSpeech()");
  });

  it("the transcript settles it before anything else, and only a real interruption stops the brain", () => {
    const heard = source.slice(source.indexOf("private handleHeard("));
    expect(heard.indexOf("this.settleInterruption(text)")).toBeGreaterThan(0);
    expect(heard.indexOf("this.settleInterruption(text)")).toBeLessThan(
      heard.indexOf("const sure ="),
    );
    const confirm = source.slice(source.indexOf("private confirmInterruption()"));
    expect(confirm.slice(0, confirm.indexOf("}\n\n")).includes("brain.stop()")).toBe(true);
    const resume = source.slice(source.indexOf("private resumeAfterInterruption()"));
    expect(resume.slice(0, resume.indexOf("\n  }\n")).includes("brain.stop()")).toBe(false);
  });

  it("an answer that keeps arriving while paused is kept and said on resume; silence resumes too", () => {
    expect(source).toContain("this.deferredStream = { runId, text, final };");
    expect(source).toContain("this.speakStreamed(later.runId, later.text, later.final)");
    expect(source).toContain("voiceGate.heardSpeechWithin(2000)");
    expect(source).toContain("nothing was said that needs an answer");
  });
});
