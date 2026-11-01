import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { affect } from "../../src/lib/friday/brain/affect";
import {
  chatSignals,
  channelDirective,
  resetRateBaseline,
  voiceSignals,
} from "../../src/lib/friday/brain/channel-mood";
import { describeUserMood } from "../../src/lib/friday/brain/comfort";
import {
  assessTone,
  resetToneBaseline,
  TONE_WARMUP,
  type VoiceProsody,
} from "../../src/lib/friday/voice-tone";
import { prosodyAffect } from "../../src/lib/friday/voice-session";

const usual: VoiceProsody = {
  ok: true,
  pitchHz: 180,
  energyDbfs: -30,
  pitchSpreadSemitones: 3,
  voicedShare: 0.6,
};
const tenseVoice: VoiceProsody = {
  ok: true,
  pitchHz: 260,
  energyDbfs: -18,
  pitchSpreadSemitones: 7,
  voicedShare: 0.7,
};
const quietVoice: VoiceProsody = {
  ok: true,
  pitchHz: 140,
  energyDbfs: -42,
  pitchSpreadSemitones: 1,
  voicedShare: 0.5,
};

function learnVoice() {
  resetToneBaseline();
  for (let i = 0; i < TONE_WARMUP + 1; i += 1) assessTone(usual);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
  affect.forgetReadings();
  resetRateBaseline();
  resetToneBaseline();
});
afterEach(() => vi.useRealTimers());

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("typed messages: what chat shows", () => {
  it("reads emoji, trailing dots and stretched letters as what they usually mean", () => {
    expect(chatSignals("kaam nahi ho raha 😡").frustration).toBeGreaterThan(0.3);
    expect(chatSignals("sab theek hai 😭").low).toBeGreaterThan(0.3);
    expect(chatSignals("ok...").low).toBeGreaterThan(0);
    expect(chatSignals("pleaseeee jaldi").urgency).toBeGreaterThan(0);
    expect(chatSignals("report bhej do")).toEqual({});
  });

  it("three quick messages in a row read as someone waiting; a slow conversation does not", () => {
    affect.observePrompt("hello");
    later(2000);
    affect.observePrompt("are you there");
    later(2000);
    affect.observePrompt("hello??");
    later(2000);
    const waiting = affect.observePrompt("answer me");
    expect(waiting.user.urgency).toBeGreaterThan(0.2);
    affect.forgetReadings();
    for (const text of ["first thing", "second thing", "third thing", "fourth thing"]) {
      later(60_000);
      affect.observePrompt(text);
    }
    expect(affect.getSnapshot().burst).toBe(0);
  });

  it("the chat pipeline and the dispatcher looking at one turn count it once", () => {
    affect.observePrompt("mujhe tension hai");
    affect.observePrompt("mujhe tension hai");
    expect(affect.getSnapshot().recent.filter((row) => row.label === "anxiety").length).toBe(1);
  });

  it("typed turns are told to match his length, and know they were typed", () => {
    affect.observePrompt("thanks");
    expect(affect.getSnapshot().channel).toBe("chat");
    expect(affect.prompt()).toMatch(/TYPED/);
    expect(affect.prompt()).not.toMatch(/SPOKEN/);
  });
});

describe("spoken messages: what a voice adds", () => {
  it("a voice alone says nothing until his own usual voice is learned", () => {
    resetToneBaseline();
    const early = assessTone(tenseVoice);
    const read = voiceSignals({ tone: early, text: "kya hua", words: "neutral" });
    expect(read.bumps.stress ?? 0).toBe(0);
  });

  it("once learned, a tense voice with angry words is stronger evidence than either alone", () => {
    learnVoice();
    const tone = assessTone(tenseVoice);
    const withWords = voiceSignals({ tone, text: "ye kaam nahi kar raha", words: "anger" });
    expect(tone?.label).toBe("tense");
    expect(withWords.bumps.frustration).toBeGreaterThan(0.2);
    expect(withWords.bumps.stress).toBeGreaterThan(0.1);
  });

  it("a quiet, low voice with sad words reads as low; the same voice with a plain request barely moves", () => {
    learnVoice();
    const tone = assessTone(quietVoice);
    const sad = voiceSignals({ tone, text: "mann nahi lag raha", words: "sadness" });
    learnVoice();
    const plain = voiceSignals({
      tone: assessTone(quietVoice),
      text: "kal ka mausam batao",
      words: "neutral",
    });
    expect(sad.bumps.low).toBeGreaterThan(plain.bumps.low ?? 0);
    expect(plain.bumps.low ?? 0).toBeLessThanOrEqual(0.1);
  });

  it("'I'm fine' said tensely is noticed as a mismatch, not argued with", () => {
    learnVoice();
    const tone = assessTone(tenseVoice);
    const read = voiceSignals({ tone, text: "nahi nahi sab theek hai", words: "neutral" });
    expect(read.mismatch).toBe(true);
    affect.noteVoice({ tone, speechMs: 2500 });
    affect.observePrompt("nahi nahi sab theek hai");
    const prompt = affect.prompt();
    expect(prompt).toMatch(/Do not contradict him or name it/);
    expect(prompt).toMatch(/never overrides what he said/);
  });

  it("speaking much faster than his usual speed raises urgency; hesitation raises confusion", () => {
    voiceSignals({
      tone: null,
      text: "ek do teen chaar paanch chhe saat",
      speechMs: 4000,
      words: "neutral",
    });
    voiceSignals({
      tone: null,
      text: "ek do teen chaar paanch chhe saat",
      speechMs: 4000,
      words: "neutral",
    });
    const fast = voiceSignals({
      tone: null,
      text: "ek do teen chaar paanch chhe saat aath",
      speechMs: 2000,
      words: "neutral",
    });
    expect(fast.rateRatio).toBeGreaterThan(1.35);
    expect(fast.bumps.urgency).toBeGreaterThan(0.2);
    const unsure = voiceSignals({
      tone: null,
      text: "umm matlab uh wo",
      speechMs: 3000,
      words: "neutral",
    });
    expect(unsure.hesitations).toBeGreaterThanOrEqual(2);
    expect(unsure.bumps.confusion).toBeGreaterThan(0.2);
  });

  it("a spoken turn is told to answer in two short sentences with nothing to read off a screen", () => {
    affect.noteVoice({ tone: null, speechMs: 2000 });
    affect.observePrompt("aaj ka din kaisa rahega");
    expect(affect.getSnapshot().channel).toBe("voice");
    const prompt = affect.prompt();
    expect(prompt).toMatch(/SPOKEN/);
    expect(prompt).toMatch(/no lists, no markdown/);
    expect(channelDirective("voice")).toMatch(/URL or a file path/);
  });

  it("speech marked a while ago is not applied to a later typed message", () => {
    affect.noteVoice({ tone: null, speechMs: 2000 });
    later(30_000);
    affect.observePrompt("typed this one");
    expect(affect.getSnapshot().channel).toBe("chat");
  });

  it("the mood answer says whether it is from words or from words and voice", () => {
    affect.observePrompt("so tired today");
    expect(describeUserMood("how do i sound")).not.toMatch(/voice/);
    later(10_000);
    learnVoice();
    affect.noteVoice({ tone: assessTone(quietVoice), speechMs: 3000 });
    affect.observePrompt("bahut thak gaya hu aaj");
    expect(describeUserMood("how do i sound")).toMatch(/words and voice|shabdon aur awaaz/);
  });

  it("a low, tired or overloaded owner is answered at a slower, calmer pace", () => {
    for (const label of [
      "sadness",
      "tiredness",
      "overwhelm",
      "disappointment",
      "anxiety",
      "distress",
    ]) {
      expect(prosodyAffect(label), label).toBe("calm");
    }
    expect(prosodyAffect("anger")).toBe("urgent");
    expect(prosodyAffect("relief")).toBe("neutral");
  });
});
