/**
 * Auto mode is the only listen/speak surface. Chat does not open a microphone.
 * Hardware is not claimed here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptsVoiceTurn,
  busyReply,
  duplicateFinalUtterance,
  endpointSilenceMs,
  holdLines,
  createNarrator,
  microphoneAllowed,
  NARRATION_POOLS,
  nextSpokenCursor,
  replyForm,
  replyLanguage,
  spokenFailure,
  whileBusy,
  type NarrationKind,
  type ReplyForm,
  type VoiceFault,
  spokenReplyAllowed,
  spokenRouteError,
  clarifyPrompt,
  takeSpeakable,
} from "../../src/lib/friday/voice-session";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("microphone and speech stay in Auto mode", () => {
  it("opens the microphone only while Auto mode is listening", () => {
    expect(microphoneAllowed("auto", false)).toBe(true);
    expect(microphoneAllowed("auto", true)).toBe(false);
    expect(microphoneAllowed("manual", false)).toBe(false);
  });

  it("speaks only in Auto mode, and mute stops that", () => {
    expect(spokenReplyAllowed("auto", false)).toBe(true);
    expect(spokenReplyAllowed("auto", true)).toBe(false);
    expect(spokenReplyAllowed("manual", false)).toBe(false);
  });

  it("treats a sentence in Auto mode as a turn, and a saved wake-word choice as a gate", () => {
    const open = {
      mode: "auto" as const,
      paused: false,
      wakeMatched: false,
      awake: false,
      handsFree: true,
      wakeWordRequired: false,
      words: 4,
      stop: false,
    };
    expect(acceptsVoiceTurn(open)).toBe(true);
    expect(acceptsVoiceTurn({ ...open, mode: "manual" })).toBe(false);
    expect(acceptsVoiceTurn({ ...open, paused: true })).toBe(false);
    expect(
      acceptsVoiceTurn({
        ...open,
        handsFree: false,
        wakeWordRequired: true,
        words: 6,
      }),
    ).toBe(false);
    expect(acceptsVoiceTurn({ ...open, words: 1, wakeMatched: true })).toBe(true);
    expect(acceptsVoiceTurn({ ...open, words: 1, stop: true, handsFree: false })).toBe(true);
  });

  it("ends an open turn on a shorter pause than a wake-word wait", () => {
    expect(endpointSilenceMs(true)).toBeLessThan(endpointSilenceMs(false));
    expect(endpointSilenceMs(true)).toBeGreaterThanOrEqual(300);
    expect(endpointSilenceMs(false)).toBeLessThanOrEqual(1200);
  });

  it("speaks a finished sentence before the rest of the answer arrives", () => {
    expect(takeSpeakable("The build is fine. The tests are still", false)).toEqual({
      spoken: "The build is fine.",
      consumed: "The build is fine. ".length,
    });
    expect(takeSpeakable("version v1.2 is next", false).spoken).toBe("");
    expect(takeSpeakable("version v1.2 is next", true).spoken).toBe("version v1.2 is next");
  });

  it("asks which one is meant only when there is no conversation to resolve it", () => {
    expect(clarifyPrompt("open it")).toBe("Which one do you mean?");
    expect(clarifyPrompt("open it", true)).toBe("");
    expect(clarifyPrompt("what is that")).toBe(""); // a question is never held up
    expect(clarifyPrompt("open the invoice")).toBe("");
  });

  it("tells a rewritten answer from more text by what was already spoken", () => {
    expect(nextSpokenCursor(13, 40)).toEqual({ cursor: 13, rewritten: false });
    expect(nextSpokenCursor(13, 5)).toEqual({ cursor: 0, rewritten: true }); // shorter than the spoken part
    const spoken = { prefix: "First draft. ", text: "First draft. Second part grows" };
    expect(nextSpokenCursor(13, 30, spoken).rewritten).toBe(false);
    // same length or longer, but the spoken part is no longer its start
    expect(
      nextSpokenCursor(13, 28, { prefix: "First draft. ", text: "Completely new answer. Next" })
        .rewritten,
    ).toBe(true);
    // a change of spaces or markdown marks is not a rewrite
    expect(
      nextSpokenCursor(13, 40, { prefix: "First draft. ", text: "**First** draft.  Second part" })
        .rewritten,
    ).toBe(false);
  });

  it("never cuts a sentence after an abbreviation, an initial or a list number", () => {
    const wait = (text: string) => expect(takeSpeakable(text, false).spoken, text).toBe("");
    wait("Please ask Dr. Singh about it");
    wait("Call at 5 p.m. tomorrow, ok");
    wait("Use e.g. this one");
    wait("Meet Mr. Rao and Mrs. Iyer");
    wait("1. First item\n2. Second item\n3. Third");
    // the sentence that really ends is still spoken, abbreviations inside it kept whole
    expect(takeSpeakable("Please ask Dr. Singh about it. Then call me back", false).spoken).toBe(
      "Please ask Dr. Singh about it.",
    );
    expect(takeSpeakable("J. K. Rowling wrote it. Yes", false).spoken).toBe(
      "J. K. Rowling wrote it.",
    );
    expect(takeSpeakable("I am here. I said it", false).spoken).toBe("I am here.");
    // and the tail is always spoken when the answer is final
    expect(takeSpeakable("Please ask Dr. Singh about it", true).spoken).toBe(
      "Please ask Dr. Singh about it",
    );
    // a number split across two streamed pieces is not a sentence end
    expect(takeSpeakable("The total is 3.", false).spoken).toBe("");
  });

  it("speaks a route failure as one sentence and keeps the chat text intact", () => {
    const full = [
      "I can't answer that one on my own — it needs a connected AI model, and none is reachable right now.",
      "Want me to help you connect a model in Models, or start a local one with Ollama?",
    ].join("\n\n");
    expect(spokenRouteError(full)).toBe(
      "No model is reachable. Connect one in Models, or start a local engine.",
    );
    expect(spokenRouteError("Checked the key. Try again.")).toBe("Checked the key. Try again.");
    expect(spokenRouteError("Hello there.\n\n[This model id is gone.]")).toBe(
      "This model id is gone.",
    );
    expect(spokenRouteError("")).toBe("");
  });

  it("drops a repeated final and restarts speech when the answer is replaced", () => {
    expect(duplicateFinalUtterance("open chrome", "open chrome", 400)).toBe(true);
    expect(duplicateFinalUtterance("open chrome", "open chrome", 2500)).toBe(false);
    expect(duplicateFinalUtterance("open chrome", "close chrome", 10)).toBe(false);
    expect(duplicateFinalUtterance("", "open chrome", 10)).toBe(false);
    expect(nextSpokenCursor(40, 12)).toEqual({ cursor: 0, rewritten: true });
    expect(nextSpokenCursor(40, 80)).toEqual({ cursor: 40, rewritten: false });
  });
});

describe("the existing voice owners enforce that policy", () => {
  it("gates capture, speech, and late playback in the auto-mode store", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("microphoneAllowed");
    expect(assistant).toContain("spokenReplyAllowed");
    expect(assistant).toContain("acceptsVoiceTurn");
    expect(assistant).toContain("takeSpeakable");
    expect(assistant).toContain("endpointSilenceMs");
    expect(assistant).toContain("this.speechGen");
    expect(assistant).toContain("handsFree: false");
    expect(assistant).toContain("duplicateFinalUtterance");
    expect(assistant).toContain("captionUserTurn");
    expect(assistant).toContain("nextSpokenCursor");
    expect(assistant).toContain("spokenRouteError");
    expect(assistant).toContain("voicedFaultFor");
  });

  it("does not let chat open a microphone or a browser recogniser", () => {
    const dock = source("src/components/friday/ChatDock.tsx");
    expect(dock).toContain("Chat does not use the microphone. Auto mode listens.");
    expect(dock).not.toContain("DesktopDictation");
    expect(dock).not.toContain("webkitSpeechRecognition");
    expect(dock).not.toContain("sttStatus");
    expect(dock).not.toContain("getUserMedia");
    expect(dock).toContain("if (!sent.accepted)");
  });

  it("does not speak a chat reply from the brain store", () => {
    const engine = source("src/lib/friday/brain-engine.ts");
    expect(engine).toContain("private speakReply");
    expect(engine).not.toContain("speakText");
    expect(engine).toContain("Manual and chat stay silent");
  });

  it("keeps the settings microphone control on the real pause path", () => {
    const settings = source("src/components/friday/settings/VoiceSettings.tsx");
    expect(settings).toContain('label="Mute microphone"');
    expect(settings).toContain("assistantMode.setPaused(!voice.paused)");
    expect(settings).toContain("FRIDAY speaks only in Auto mode");
  });
});

describe("FRIDAY stays responsive while a turn is running", () => {
  const work = { task: "summarise the quarterly report", elapsedMs: 12_400 };

  it("answers a status question or a thank-you at once, in the language it was asked in", () => {
    const english = busyReply("are you still working?", work);
    expect(english).toContain("I'm on it");
    expect(english).toContain("summarise the quarterly report");
    expect(english).toContain("12 seconds");
    const hinglish = busyReply("kya kar rahi ho abhi", work);
    expect(hinglish).toMatch(/^Haan, main/);
    expect(hinglish).toContain("12 second");
    expect(busyReply("क्या कर रही हो ho gaya", work)).toMatch(/^Haan, main/);
    expect(busyReply("thanks", work)).toBe("Still on it.");
    expect(busyReply("theek hai", work)).toBe("Haan, kaam chal raha hai.");
  });

  it("leaves a real request to the normal path, so nothing is answered with a guess", () => {
    for (const text of [
      "open the downloads folder",
      "kal ki meeting ka summary banao",
      "write an email to the team",
      "",
    ]) {
      expect(busyReply(text, work)).toBe("");
    }
  });

  it("picks Hinglish for Hindi and Hinglish speech and English otherwise", () => {
    expect(replyLanguage("kya kar rahi ho")).toBe("hi");
    expect(replyLanguage("यह क्या है")).toBe("hi");
    expect(replyLanguage("what are you doing")).toBe("en");
    expect(holdLines("kya haal hai").first).toBe("Ek second, dekh rahi hu.");
    expect(holdLines("open the report").first).toBe("One moment, I'm on it.");
    expect(holdLines("open the report").later).not.toBe(holdLines("open the report").first);
  });

  it("is wired into Auto mode: an instant in-place reply, a hold line, and no stop for a remark", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("whileBusy(");
    expect(assistant).toContain('this.remember("busy-reply"');
    expect(assistant).toContain("this.armHoldLines(command)");
    expect(assistant).toContain("this.clearHoldLines()");
    // A real spoken request still interrupts, and a stop word still stops.
    expect(assistant).toContain("brain.stop()");
    const dispatch = assistant.slice(assistant.indexOf("private dispatch(command: string"));
    expect(dispatch.indexOf("whileBusy(")).toBeGreaterThan(-1);
    expect(dispatch.indexOf("whileBusy(")).toBeLessThan(dispatch.indexOf("this.dropPlayback()"));
    // The early draft is the Brain's own text-only run (startDraft), not a second dispatch: dispatch has no draft
    // branch. A real command interrupts only the foreground turn, never a background task's run.
    expect(dispatch.slice(0, dispatch.indexOf("\n  }\n"))).not.toContain("draft");
    expect(dispatch).toMatch(/const heard = this\.heardOfReply\(\);\s*this\.dropPlayback\(\)/);
    expect(dispatch).toMatch(
      /!result\.accepted && result\.reason === "busy"\) \{\s*brain\.stop\("foreground"\)/,
    );
  });
});

import { suggestLargerSpeech } from "../../src/lib/friday/voice-session";

describe("a larger speech size, suggested only on repeated doubt", () => {
  const doubtful = (model: string, lp = -1.1) => ({ model, avgLogprob: lp, text: "heard" });
  it("suggests the next size after three doubtful transcripts on one size", () => {
    const out = suggestLargerSpeech({
      recent: [doubtful("small"), doubtful("small"), doubtful("small")],
    });
    expect(out.suggest).toBe("medium");
    expect(out.reason).toMatch(/last 3 transcripts on small were doubtful/);
  });

  it("stays quiet for too few turns, a mixed run, a confident turn or an empty one", () => {
    expect(
      suggestLargerSpeech({ recent: [doubtful("small"), doubtful("small")] }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({ recent: [doubtful("small"), doubtful("base"), doubtful("small")] })
        .suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({
        recent: [doubtful("small"), doubtful("small", -0.2), doubtful("small")],
      }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({
        recent: [
          doubtful("small"),
          doubtful("small"),
          { model: "small", avgLogprob: -1, text: " " },
        ],
      }).suggest,
    ).toBeNull();
  });

  it("respects the PC's ceiling, the largest size and the battery", () => {
    const three = (m: string) => [doubtful(m), doubtful(m), doubtful(m)];
    expect(suggestLargerSpeech({ recent: three("medium") }).suggest).toBeNull();
    // the ladder now has the big turbo size between medium and large-v3: one step at a time
    expect(suggestLargerSpeech({ recent: three("medium"), maxSize: "large-v3" }).suggest).toBe(
      "large-v3-turbo",
    );
    expect(
      suggestLargerSpeech({ recent: three("medium"), maxSize: "large-v3-turbo" }).suggest,
    ).toBe("large-v3-turbo");
    expect(
      suggestLargerSpeech({ recent: three("large-v3-turbo"), maxSize: "large-v3" }).suggest,
    ).toBe("large-v3");
    expect(
      suggestLargerSpeech({ recent: three("large-v3-turbo"), maxSize: "large-v3-turbo" }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({ recent: three("medium"), battery: true, maxSize: "large-v3" }).suggest,
    ).toBeNull();
    expect(suggestLargerSpeech({ recent: three("large-v3"), maxSize: "large-v3" }).reason).toMatch(
      /largest/,
    );
    expect(suggestLargerSpeech({ recent: three("small"), battery: true }).suggest).toBeNull();
    expect(suggestLargerSpeech({ recent: three("tiny") }).suggest).toBe("base");
  });
});

describe("one language detector for her own fixed lines", () => {
  const DEVA = /\p{Script=Devanagari}/u;
  const FORMS: ReplyForm[] = ["en", "hi", "hinglish"];
  const work = { task: "report", elapsedMs: 12_400 };
  const said: Record<ReplyForm, string> = {
    en: "open the report please",
    hi: "यह रिपोर्ट खोलो",
    hinglish: "kya kar rahi ho abhi",
  };
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

  it("reads the form from the shared lexicon: Devanagari, Roman Hinglish, mixed script, English", () => {
    expect(replyForm("यह क्या है")).toBe("hi");
    expect(replyForm("kya kar rahi ho abhi")).toBe("hinglish");
    expect(replyForm("mujhe ek reminder set karo")).toBe("hinglish");
    expect(replyForm("क्या कर रही हो ho gaya")).toBe("hinglish");
    expect(replyForm("what are you doing")).toBe("en");
    expect(replyForm("")).toBe("en");
  });

  it("follows one sure Hindi word in a very short line, and leaves a short English line English", () => {
    expect(replyForm("theek hai")).toBe("hinglish");
    expect(replyForm("abhi")).toBe("hinglish");
    expect(replyForm("ok")).toBe("en");
    expect(replyForm("thanks")).toBe("en");
  });

  it("keeps a Hindi or Hinglish ear's declared language when the words alone cannot tell", () => {
    expect(replyForm("open the report", "hi")).toBe("hinglish");
    expect(replyForm("open the report", "hi-en")).toBe("hinglish");
    expect(replyForm("open the report", "en")).toBe("en");
    expect(replyLanguage("open the report", "hi")).toBe("hi");
  });

  it("an English line with a few Hindi names is not Hinglish, a romanised Hindi line is", () => {
    expect(replyForm("please send the quarterly report to Rahul before kal")).toBe("en");
    expect(replyForm("subah ki meeting cancel karo please")).toBe("hinglish");
  });

  it("replyLanguage is the two-way view of replyForm, and the old regex is gone", () => {
    for (const text of Object.values(said)) {
      expect(replyLanguage(text) === "hi").toBe(replyForm(text) !== "en");
    }
    const src = source("src/lib/friday/voice-session.ts");
    expect(src).not.toContain("HINGLISH_WORDS");
    expect(src).toContain("detectTurnLanguage(");
    expect(src).toContain('from "./voice-engine/hinglish-lexicon"');
  });

  it("every narration pool has English, Hindi (Devanagari) and Hinglish (Roman) lines", () => {
    const kinds: NarrationKind[] = ["first", "later", "tool"];
    for (const kind of kinds) {
      const en = NARRATION_POOLS.en[kind];
      const hi = NARRATION_POOLS.hi[kind];
      const hinglish = NARRATION_POOLS.hinglish[kind];
      expect(en.length).toBeGreaterThanOrEqual(4);
      expect(hi.length).toBe(en.length);
      expect(hinglish.length).toBe(en.length);
      for (const line of hi) expect(line).toMatch(DEVA);
      for (const line of [...en, ...hinglish]) expect(line).not.toMatch(DEVA);
      expect(new Set([...en, ...hi, ...hinglish]).size).toBe(en.length * 3);
    }
  });

  it("the narrator says each form in the language of the owner's last line", () => {
    const narrator = createNarrator(() => 0);
    expect(narrator.say("first", { text: said.hi, elapsedMs: 0 })).toMatch(DEVA);
    const roman = createNarrator(() => 0).say("first", { text: said.hinglish, elapsedMs: 0 });
    expect(roman).toBe(NARRATION_POOLS.hinglish.first[0]);
    const english = createNarrator(() => 0).say("first", { text: said.en, elapsedMs: 0 });
    expect(english).toBe(NARRATION_POOLS.en.first[0]);
  });

  it("a tool step names the real thing only in English, never as a guessed Hindi subject", () => {
    const hindi = createNarrator(() => 0).say("tool", {
      text: said.hi,
      detail: "opening Chrome",
      elapsedMs: 5000,
    });
    expect(hindi).toMatch(DEVA);
    expect(hindi).not.toContain("Chrome");
  });

  it("holdLines has all three forms", () => {
    const lines = FORMS.map((form) => holdLines(said[form]));
    expect(lines[0]?.first).toBe("One moment, I'm on it.");
    expect(lines[1]?.first).toMatch(DEVA);
    expect(lines[1]?.later).toMatch(DEVA);
    expect(lines[2]?.first).toBe("Ek second, dekh rahi hu.");
    expect(new Set(lines.flatMap((l) => [l.first, l.later])).size).toBe(6);
  });

  it("a status question or a thank-you is answered in all three forms", () => {
    const hindi = busyReply("क्या कर रही हो अभी तक", work);
    expect(hindi).toMatch(DEVA);
    expect(hindi).toContain("12");
    expect(busyReply("ठीक है", work)).toMatch(DEVA);
    expect(busyReply("ठीक है", work)).not.toBe(busyReply("theek hai", work));
    expect(busyReply("theek hai", work)).toBe("Haan, kaam chal raha hai.");
    expect(busyReply("thanks", work)).toBe("Still on it.");
  });

  it("queue, full-queue and social replies while busy come in three forms", () => {
    const late = { task: "report", elapsedMs: 9000 };
    const queued = FORMS.map((form) => {
      const request = {
        en: "write the email",
        hi: "ईमेल लिख दो",
        hinglish: "mujhe kal email bhejo",
      }[form];
      const d = whileBusy(request, late, { queued: 0 });
      expect(d.kind).toBe("queue");
      return d.kind === "queue" ? d.line : "";
    });
    expect(queued[1]).toMatch(DEVA);
    expect(queued[2]).not.toMatch(DEVA);
    expect(new Set(queued).size).toBe(3);
    const full = FORMS.map((form) => {
      const request = {
        en: "write the email",
        hi: "ईमेल लिख दो",
        hinglish: "mujhe kal email bhejo",
      }[form];
      const d = whileBusy(request, late, { queued: 3 });
      return d.kind === "reply" ? d.line : "";
    });
    expect(full[1]).toMatch(DEVA);
    expect(full[0]).toContain("lined up");
    expect(new Set(full).size).toBe(3);
    const social = whileBusy("धन्यवाद", late);
    expect(social.kind === "reply" && social.line).toMatch(DEVA);
  });

  it("a Devanagari stop word still interrupts the work", () => {
    expect(whileBusy("रुको", { task: "x", elapsedMs: 9000 }).kind).toBe("interrupt");
    expect(whileBusy("रुकिए", { task: "x", elapsedMs: 9000 }).kind).toBe("interrupt");
  });

  it("the clarifying question is asked in the language the owner used", () => {
    expect(clarifyPrompt("open it")).toBe("Which one do you mean?");
    const hindi = clarifyPrompt("वो खोलो");
    expect(hindi).toMatch(DEVA);
    const hinglish = clarifyPrompt("woh kholo");
    expect(hinglish).not.toMatch(DEVA);
    expect(hinglish).not.toBe("Which one do you mean?");
    expect(hinglish.length).toBeGreaterThan(5);
    expect(clarifyPrompt("वो खोलो", true)).toBe("");
    expect(clarifyPrompt("क्या है वो")).toBe("");
  });

  it("every spoken failure line has English, Hindi and Hinglish forms", () => {
    for (const fault of FAULTS) {
      const [en, hi, hinglish] = FORMS.map((form) => spokenFailure(fault, form)) as [
        string,
        string,
        string,
      ];
      if (fault === "barge-in" || fault === "echo-loop") {
        expect([en, hi, hinglish]).toEqual(["", "", ""]);
        continue;
      }
      expect(en.length).toBeGreaterThan(5);
      expect(hi).toMatch(DEVA);
      expect(hinglish).not.toMatch(DEVA);
      expect(hinglish.length).toBeGreaterThan(5);
      expect(new Set([en, hi, hinglish]).size).toBe(3);
      expect(spokenFailure(fault)).toBe(en);
    }
  });

  it("the failure lines never promise an action, and keep the safe facts in every form", () => {
    for (const form of FORMS) {
      expect(spokenFailure("injection", form)).not.toMatch(/\b(approved|executed|running now)\b/i);
    }
    expect(spokenFailure("approval-expired", "hi")).toMatch(DEVA);
  });
});
