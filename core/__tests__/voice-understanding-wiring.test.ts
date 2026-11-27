/**
 * The understanding modules, wired into the real Auto mode controller behind `voice.understanding`: the turn record's
 * canonical line and language, the closed-vocabulary command lane, the addressedness gate and spoken self-repair.
 * Each wire is proven twice: a source pin that the product caller exists, and the behaviour through the conductor
 * with the Brain, the speaker and the microphone replaced by recorders. No microphone, speaker or network is touched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { preferences } from "../../src/lib/friday/preferences";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { voiceNotes } from "../../src/lib/friday/voice-notes";
import type { StreamTurn, TurnRecord } from "../../src/lib/friday/voice-engine/stream-session";

type Driver = {
  state: {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    handsFree: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  handleHeard: (text: string) => void;
  acceptFinalUtterance: (utterance: { text: string; source: string }) => void;
  lastTurn: () => TurnRecord | null;
  sideQuestionContext: () => string;
  speakPlan: (text: string) => { argTuning: { lang?: string } };
  streamPlan: () => { hotwords?: readonly string[] } | null;
  turnTracker: { ingest: (turn: StreamTurn, now: number) => unknown; reset: () => void };
  dispatch: (command: string) => void;
  cancelSpeech: () => void;
  setMuted: (muted: boolean) => void;
  speak: (text: string) => void;
  emit: () => void;
  trace: (kind: string, line: string) => void;
  translateTo: "en" | "hi" | null;
  lastHeardQuality: unknown;
  pendingHeard: { command: string; at: number; ttlMs?: number } | null;
  liveWakeAt: number;
  followUpUntil: number;
  awakeUntil: number;
  lastWakeAt: number;
  lastFinalText: string;
  lastFinalAt: number;
  approvalAsked: unknown;
};
const drive = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const root = resolve(__dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The text of one method of the conductor, from its signature to the next member at the same indent. */
function method(name: string): string {
  const start = modeSource.search(new RegExp(`\\n {2}(?:private |public |async )*${name}\\(`));
  expect(start, name).toBeGreaterThan(-1);
  const rest = modeSource.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(?:private |public |async |\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const SURE = { avgLogprob: -0.1, languageProbability: 0.99, language: "en" };
let spoken: string[] = [];
let sent: string[] = [];
let traced: string[] = [];
let mutedTo: boolean[] = [];

function setVoice(patch: Record<string, unknown>) {
  const voice = preferences.getSnapshot().voice;
  preferences.update({ voice: { ...voice, ...patch } as typeof voice });
}

function understanding(patch: Record<string, unknown>) {
  setVoice({
    understanding: { ...preferences.getSnapshot().voice.understanding, ...patch },
  });
}

/** Hands-free on, inside her attention window: a line needs no wake word unless a gate adds one. */
function handsFreeOn() {
  drive.state.handsFree = true;
  (drive as unknown as { wakeWordRequired: boolean }).wakeWordRequired = false;
  drive.awakeUntil = Date.now() + 30_000;
}

function earTurn(extra: Partial<StreamTurn>) {
  drive.turnTracker.ingest(
    { turnId: "wire-1", event: "end", text: "", vadP: 0.9, speechMs: 900, ...extra },
    Date.now(),
  );
}

beforeAll(async () => {
  await preferences.hydrate();
});

beforeEach(() => {
  spoken = [];
  sent = [];
  traced = [];
  mutedTo = [];
  voiceNotes.clear();
  drive.state.mode = "auto";
  drive.state.paused = false;
  drive.state.muted = false;
  drive.state.speaking = false;
  drive.state.handsFree = false;
  (drive as unknown as { wakeWordRequired: boolean }).wakeWordRequired = true;
  drive.state.pending = null;
  drive.translateTo = null;
  drive.lastHeardQuality = SURE;
  drive.pendingHeard = null;
  drive.approvalAsked = null;
  (drive as unknown as { lastReadBackAt: number }).lastReadBackAt = 0;
  (drive as unknown as { spokenText: string }).spokenText = "";
  (drive as unknown as { echoUntil: number }).echoUntil = 0;
  drive.liveWakeAt = 0;
  drive.lastWakeAt = 0;
  drive.followUpUntil = 0;
  drive.awakeUntil = 0;
  drive.lastFinalText = "";
  drive.lastFinalAt = 0;
  drive.turnTracker.reset();
  drive.dispatch = (command: string) => void sent.push(command);
  drive.cancelSpeech = () => undefined;
  drive.speak = (text: string) => void spoken.push(text);
  drive.emit = () => undefined;
  drive.trace = (_kind: string, line: string) => void traced.push(line);
  drive.setMuted = (muted: boolean) => void mutedTo.push(muted);
  setVoice({
    vocabulary: "Spotify, Delete Cleaner",
    speechLang: "en-US",
    streamEngine: "auto",
    understanding: { v: 1, selfRepair: true, commandLane: true, lexiconFix: "hints" },
  });
});

describe("1. the turn record v2 into the intake, and the turn's language into the reply and the voice", () => {
  it("is wired: the intake prefers the ear's lock and hands the canonical line on", () => {
    const accept = method("acceptFinalUtterance");
    expect(accept).toMatch(
      /preferStreamLang\(record\.lang, record\.streamLang, STREAM_LANG_MIN_CONF\)/,
    );
    expect(accept).toContain("this.handleHeard(this.turnRecord.canonical || text");
    expect(method("turnSpeaksHindi")).toContain('this.turnHints()?.lang === "hi"');
    expect(modeSource).toMatch(
      /usesHindiVoice\(voice\.speechLang \|\| voice\.recognitionLang\) \|\| hindiTurn/,
    );
    expect(modeSource).toMatch(/this\.turnSpeaksHindi\(\) \? "hi-IN"/);
  });

  it("a Hindi-locked turn gets the Hindi reply hint and the Hindi voice, even with English chosen", () => {
    earTurn({ lang: "hi", langConf: 0.9, langLocked: true });
    drive.acceptFinalUtterance({ text: "Friday what is the weather today", source: "local" });
    expect(drive.lastTurn()?.lang).toBe("hi");
    expect(drive.sideQuestionContext()).toContain("Reply language for this turn: Hindi");
    expect(drive.speakPlan("आज मौसम साफ़ है").argTuning.lang).toBe("hi-IN");
  });

  it("an unlocked or unsure ear leaves the script heuristic and the chosen voice alone", () => {
    earTurn({ lang: "hi", langConf: 0.4, langLocked: true });
    drive.acceptFinalUtterance({ text: "Friday what is the weather tomorrow", source: "local" });
    expect(drive.lastTurn()?.lang).toBe("en");
    expect(drive.sideQuestionContext()).not.toContain("Hindi");
    expect(drive.speakPlan("It will be sunny").argTuning.lang).toBe("en-IN");
  });

  it("the canonical line is what the turn acts on (Devanagari digits as digits)", () => {
    drive.acceptFinalUtterance({ text: "Friday set a reminder in ५ minutes", source: "local" });
    expect(sent).toEqual(["set a reminder in 5 minutes"]);
    expect(drive.lastTurn()?.textRaw).toBe("Friday set a reminder in ५ minutes");
  });
});

describe("2. the command lane before routeCommand", () => {
  it("is wired before routeCommand, and its names feed the ear's hotword list", () => {
    const heard = method("handleHeard");
    const lane = heard.indexOf("this.commandLaneTakes(command, true)");
    expect(lane).toBeGreaterThan(-1);
    expect(lane).toBeLessThan(heard.indexOf("this.routeCommand(command, route.kind"));
    expect(method("commandLaneTakes")).toContain("routeCommandLane({");
    expect(method("commandLaneTakes")).toContain("understanding.commandLane");
    expect(method("streamPlan")).toMatch(/apps: commandHints\(this\.commandRegistry\(\)/);
    expect(drive.streamPlan()?.hotwords).toContain("Spotify");
  });

  it("a lane verb answers without the Brain", () => {
    drive.handleHeard("Friday mute");
    expect(mutedTo).toEqual([true]);
    expect(sent).toEqual([]);
    expect(traced.some((line) => /^command lane — mute/.test(line))).toBe(true);
  });

  it("a near name snaps to the registry name and goes through the ordinary path", () => {
    drive.handleHeard("Friday open spotifi");
    expect(sent).toEqual(["open Spotify"]);
  });

  it("a snap to a consequential name is read back, waits for the approval window, and never opens directly", () => {
    drive.handleHeard("Friday open delet cleaner");
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toContain("Delete Cleaner");
    expect(drive.pendingHeard?.command).toBe("open Delete Cleaner");
    expect(drive.pendingHeard?.ttlMs).toBe(30_000);
    // A yes confirms what was heard; the order itself still has to be approved as an action.
    drive.handleHeard("haan");
    expect(sent).toEqual([]);
    expect(drive.state.pending?.command).toBe("open Delete Cleaner");
  });

  it("while she speaks, an unaddressed quietening verb is taken; any other verb needs her name", () => {
    drive.state.speaking = true;
    drive.handleHeard("mute");
    expect(mutedTo).toEqual([true]);
    drive.handleHeard("open spotify");
    expect(sent).toEqual([]);
  });

  it("an unaddressed verb heard over a TV scene is never taken, even while she speaks", () => {
    drive.state.speaking = true;
    earTurn({ env: { kind: "tv", score: 0.9 } });
    drive.acceptFinalUtterance({ text: "mute", source: "local" });
    expect(mutedTo).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("is off with voice.understanding.commandLane off: the line goes on as heard", () => {
    understanding({ commandLane: false });
    drive.handleHeard("Friday open spotifi");
    expect(sent).toEqual(["open spotifi"]);
    expect(drive.streamPlan()?.hotwords).toContain("Spotify"); // the dictionary still biases
  });
});

describe("3. the addressedness gate can only add a wake requirement", () => {
  it("is wired on each final with no wake word", () => {
    const heard = method("handleHeard");
    expect(heard).toMatch(
      /this\.heldForWake\(wake\.matched\) \|\|\s+this\.addressednessAddsWake\(/,
    );
    expect(method("addressednessAddsWake")).toContain("baseRequireWake: false");
  });

  it("hands-free with the TV on and no wake word executes nothing", () => {
    handsFreeOn();
    earTurn({ env: { kind: "tv", score: 0.9 } });
    drive.acceptFinalUtterance({ text: "turn off all the lights in the house", source: "local" });
    expect(sent).toEqual([]);
    expect(spoken).toEqual([]);
    expect(traced.some((line) => /addressedness .*scene:tv.*wake word required/.test(line))).toBe(
      true,
    );
  });

  it("the same line in a quiet room still goes on hands-free, and her name still wakes her over the TV", () => {
    handsFreeOn();
    drive.acceptFinalUtterance({ text: "switch off every light in the hall", source: "local" });
    expect(sent).toEqual(["switch off every light in the hall"]);
    sent = [];
    drive.lastFinalText = "";
    earTurn({ env: { kind: "tv", score: 0.9 } });
    drive.acceptFinalUtterance({ text: "Friday turn off the lights", source: "local" });
    expect(sent).toEqual(["turn off the lights"]);
  });
});

describe("4. spoken self-repair before the router", () => {
  it("is wired before routeUtterance, behind voice.understanding.selfRepair", () => {
    const heard = method("handleHeard");
    const repair = heard.indexOf("this.selfRepairOf(command, text)");
    expect(repair).toBeGreaterThan(-1);
    expect(repair).toBeLessThan(heard.indexOf("const route = this.routeHeard("));
    const body = method("selfRepairOf");
    expect(body).toContain("understanding.selfRepair");
    expect(body).toContain("repairAuditLine(repair)");
    expect(body).toContain('this.remember("self-repair", repair.raw, audit)');
  });

  it("a harmless repair acts on the repaired line, logs the repair and keeps the raw words shown", () => {
    drive.handleHeard("Friday play some jazz I mean rock");
    expect(sent).toEqual(["play some rock"]);
    expect(traced).toContain('repair "I mean": jazz -> rock');
    const captions = (assistantMode.getSnapshot() as { captions: { who: string; text: string }[] })
      .captions;
    expect(captions.filter((row) => row.who === "user").at(-1)?.text).toMatch(/jazz i mean rock/i);
  });

  it("a consequential repair is read back and waits; nothing runs", () => {
    drive.handleHeard("Friday call Rahul I mean Rohan");
    expect(sent).toEqual([]);
    expect(drive.pendingHeard?.command).toBe("call Rohan");
    expect(drive.pendingHeard?.ttlMs).toBe(30_000);
    expect(spoken.join(" ")).toContain("Rohan");
  });

  it("is off with voice.understanding.selfRepair off", () => {
    understanding({ selfRepair: false });
    drive.handleHeard("Friday play some jazz I mean rock");
    expect(sent).toEqual(["play some jazz i mean rock"]);
  });
});

describe("5. the turn's expectation, language and tail into the dictation, and the listening-paused line", () => {
  const d5 = drive as unknown as {
    turnExpect: () => string | undefined;
    turnEotLang: () => string | undefined;
    showListeningPaused: (pause: {
      lines: { en: string; hi: string; hinglish: string };
      retryAfterMs: number;
    }) => void;
    state: { status: string };
  };
  const PAUSE = {
    lines: {
      en: "Listening paused. Press Retry in a moment.",
      hi: "सुनना रुका हुआ है। थोड़ी देर में Retry दबाइए।",
      hinglish: "Sunna ruka hua hai. Thodi der mein Retry dabao.",
    },
    retryAfterMs: 29_500,
  };

  it("is wired into the one DesktopDictation the conductor makes", () => {
    const start = method("startDesktopDictation");
    expect(start).toContain("turnExpect: () => this.turnExpect(),");
    expect(start).toContain("turnLang: () => this.turnEotLang(),");
    expect(start).toContain("turnTail: () => this.state.interim,");
    expect(start).toContain("onListeningPaused: (pause) => this.showListeningPaused(pause),");
  });

  it("expects a yes while a read-back is open, dictation while a note is written, else nothing", () => {
    expect(d5.turnExpect()).toBeUndefined();
    drive.pendingHeard = { command: "open Delete Cleaner", at: Date.now() };
    expect(d5.turnExpect()).toBe("yesno");
    drive.pendingHeard = null;
    drive.handleHeard("Friday take a note");
    expect(d5.turnExpect()).toBe("dictation");
    voiceNotes.clear();
  });

  it("the wait follows a Hindi-locked turn, and the paused line is in that language with its retry time", () => {
    earTurn({ lang: "hi", langConf: 0.9, langLocked: true });
    drive.acceptFinalUtterance({ text: "Friday what time is it in London", source: "local" });
    expect(d5.turnEotLang()).toBe("hi");
    d5.showListeningPaused(PAUSE);
    expect(d5.state.status).toBe(`${PAUSE.lines.hi} (30 s)`);
    expect(traced.some((line) => /retry in 30 s/.test(line))).toBe(true);
  });
});
