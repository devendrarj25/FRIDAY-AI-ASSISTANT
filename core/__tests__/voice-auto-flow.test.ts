/**
 * The real Auto mode controller, driven with heard lines. Nothing here opens a microphone or a speaker: the voice
 * output is replaced by a recorder and the Brain is not asked. It checks what the controller decides to do with a
 * line, which is where a wake word, a note, a translation or a stop word can be dropped or misread.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { voiceNotes } from "../../src/lib/friday/voice-notes";
import { listVoiceTasks } from "../../src/lib/friday/voice-engine/voice-tasks";

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
  dispatch: (command: string) => void;
  cancelSpeech: () => void;
  leaveAuto: () => void;
  holdForInterruption: () => void;
  lastHeardQuality: unknown;
  pendingHeard: unknown;
  speakStreamed: (runId: string, text: string, final: boolean) => void;
  voicedRunId: string;
  voicedChars: number;
  voicedPrefix: string;
  deferredStream: unknown;
  interruptHold: unknown;
  unfinished: string;
  speechQueue: string[];
  queuedCommands: string[];
  speak: (text: string) => void;
  emit: () => void;
  translateTo: "en" | "hi" | null;
  liveWakeAt: number;
  followUpUntil: number;
  awakeUntil: number;
};
const drive = assistantMode as unknown as Driver;
// The controller sets timers through `window`; here that is the test process itself.
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let spoken: string[] = [];
let sent: string[] = [];
let cancelled = 0;

beforeEach(() => {
  spoken = [];
  voiceNotes.clear();
  drive.state.mode = "auto";
  drive.state.paused = false;
  drive.state.muted = false;
  drive.state.speaking = false;
  drive.state.handsFree = false;
  drive.state.pending = null;
  drive.translateTo = null;
  drive.lastHeardQuality = null;
  drive.pendingHeard = null;
  drive.voicedRunId = "";
  drive.voicedChars = 0;
  drive.voicedPrefix = "";
  drive.deferredStream = null;
  drive.liveWakeAt = 0;
  (drive as unknown as { lastWakeAt: number }).lastWakeAt = 0;
  (drive as unknown as { spokenText: string }).spokenText = "";
  (drive as unknown as { echoUntil: number }).echoUntil = 0;
  drive.followUpUntil = 0;
  drive.awakeUntil = 0;
  sent = [];
  cancelled = 0;
  drive.dispatch = (command: string) => void sent.push(command);
  drive.cancelSpeech = () => void (cancelled += 1);
  drive.speak = (text: string) => void spoken.push(text);
  drive.emit = () => undefined;
});

describe("notes and meetings by voice", () => {
  it("starts on the wake word and writes the lines that follow", () => {
    drive.handleHeard("Friday start a note");
    expect(voiceNotes.active()?.kind).toBe("note");
    expect(spoken.join(" ")).toMatch(/Note shuru/);
    drive.handleHeard("buy milk and call the plumber");
    expect(voiceNotes.active()?.lines).toEqual(["buy milk and call the plumber"]);
  });

  it("keeps writing what people say in a meeting without anyone saying her name", () => {
    drive.handleHeard("Friday start the meeting");
    expect(voiceNotes.active()?.kind).toBe("meeting");
    drive.handleHeard("we agreed to ship the update next tuesday");
    drive.handleHeard("Rahul will review the invoice by thursday");
    expect(voiceNotes.active()?.lines).toEqual([
      "we agreed to ship the update next tuesday",
      "Rahul will review the invoice by thursday",
    ]);
  });

  it("ends a note by the stop phrase even without her name", () => {
    drive.handleHeard("Friday take a note");
    drive.handleHeard("first line");
    drive.handleHeard("stop note");
    expect(voiceNotes.active()).toBeNull();
    expect(voiceNotes.getSnapshot().notes[0]?.lines).toEqual(["first line"]);
    expect(spoken.join(" ")).toMatch(/Saved 1 line/);
  });

  it("does not write a spoken stop into the note, so it still stops her speech", () => {
    drive.handleHeard("Friday take a note");
    drive.handleHeard("Friday stop");
    expect(voiceNotes.active()?.lines).toEqual([]);
  });

  it("writes nothing when Auto mode is off", () => {
    drive.state.mode = "manual";
    drive.handleHeard("Friday start a note");
    expect(voiceNotes.active()).toBeNull();
  });
});

describe("being addressed", () => {
  it("answers a line that starts with her name, and only that line", () => {
    drive.handleHeard("Friday open the calculator");
    expect(sent).toEqual(["open the calculator"]);
    sent = [];
    drive.handleHeard("open the calculator");
    expect(sent).toEqual([]); // not addressed, no follow-up window
  });

  it("takes the next line after a wake word heard live, once", () => {
    drive.liveWakeAt = Date.now();
    drive.handleHeard("what is on my calendar today");
    expect(sent).toEqual(["what is on my calendar today"]);
    sent = [];
    drive.handleHeard("and what about tomorrow evening");
    expect(sent).toEqual([]); // the live wake covered one line
  });

  it("lets an old live wake expire", () => {
    drive.liveWakeAt = Date.now() - 60_000;
    drive.handleHeard("what is on my calendar today");
    expect(sent).toEqual([]);
  });

  it("is not woken by the day of the week", () => {
    for (const line of [
      "thank god it's friday",
      "see you on friday",
      "the report is due on friday",
      "friday evening we are going out",
    ]) {
      drive.handleHeard(line);
    }
    expect(sent).toEqual([]);
  });

  it("is woken by her name in Hindi and Hinglish too", () => {
    drive.handleHeard("फ्राइडे क्रोम खोलो");
    drive.handleHeard("hey friday weather kaisa hai aaj");
    drive.handleHeard("friday ji chrome kholo");
    expect(sent).toEqual(["क्रोम खोलो", "weather kaisa hai aaj", "ji chrome kholo"]);
  });

  it("ends her speech on a stop word and sends nothing to the Brain", () => {
    drive.handleHeard("Friday stop");
    expect(cancelled).toBe(1);
    expect(sent).toEqual([]);
  });

  it("does nothing when listening is paused or Auto mode is off", () => {
    drive.state.paused = true;
    drive.handleHeard("Friday open the calculator");
    drive.state.paused = false;
    drive.state.mode = "manual";
    drive.handleHeard("Friday open the calculator");
    expect(sent).toEqual([]);
  });
});

describe("translation by voice", () => {
  it("turns on, translates the lines that follow without her name, and turns off", () => {
    drive.handleHeard("Friday translate to English");
    expect(drive.translateTo).toBe("en");
    const before = listVoiceTasks().length;
    drive.handleHeard("kal subah das baje meeting hai");
    expect(listVoiceTasks().length).toBe(before + 1);
    expect(listVoiceTasks().at(-1)?.label).toBe("Translation");
    expect(sent).toEqual([]); // a translated line is not also sent as a request
    drive.handleHeard("stop translating");
    expect(drive.translateTo).toBeNull();
  });
});

describe("leaving Auto mode", () => {
  it("clears what must not survive into the next session", () => {
    drive.handleHeard("Friday start the meeting");
    drive.handleHeard("a line of the meeting");
    drive.translateTo = "hi";
    drive.queuedCommands = ["open mail"];
    drive.liveWakeAt = Date.now();
    drive.leaveAuto();
    expect(voiceNotes.active()).toBeNull();
    expect(voiceNotes.getSnapshot().notes[0]?.lines).toEqual(["a line of the meeting"]);
    expect(drive.translateTo).toBeNull();
    expect(drive.queuedCommands).toEqual([]);
    expect(drive.liveWakeAt).toBe(0);
  });
});

describe("a consequential command waits for a yes", () => {
  const ask = (command: string, ageMs = 0) => {
    drive.state.pending = { command, reason: "it deletes files", at: Date.now() - ageMs };
  };

  it("runs it on a clear yes, once, and not on anything else", () => {
    ask("delete the old reports");
    drive.handleHeard("what time is it"); // an unrelated line is ignored, the question stays open
    expect(sent).toEqual([]);
    expect(drive.state.pending).not.toBeNull();
    drive.handleHeard("yes");
    expect(sent).toEqual(["delete the old reports"]);
    expect(drive.state.pending).toBeNull();
    drive.handleHeard("yes");
    expect(sent).toEqual(["delete the old reports"]); // a second yes runs nothing
  });

  it("cancels on a no and runs nothing", () => {
    ask("delete the old reports");
    drive.handleHeard("no don't");
    expect(sent).toEqual([]);
    expect(drive.state.pending).toBeNull();
    expect(spoken.join(" ")).toMatch(/Nothing was executed/);
  });

  it("lets a yes expire, so a late yes approves nothing", () => {
    ask("delete the old reports", 10 * 60_000);
    drive.handleHeard("yes");
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toMatch(/expired/);
  });

  it("is not swallowed into a note while it waits", () => {
    drive.handleHeard("Friday start a note");
    ask("delete the old reports");
    drive.handleHeard("yes");
    expect(sent).toEqual(["delete the old reports"]);
    expect(voiceNotes.active()?.lines).toEqual([]);
  });
});

describe("what she does with a line once it is addressed", () => {
  it("asks for a yes before a consequential command, and does not run it yet", () => {
    drive.handleHeard("Friday delete all the old invoices");
    expect(sent).toEqual([]);
    expect(drive.state.pending?.command).toBe("delete all the old invoices");
    expect(spoken.join(" ")).toMatch(/Confirm: should I delete all the old invoices/);
  });

  it("answers just her name with a short prompt and runs nothing", () => {
    drive.handleHeard("Friday");
    expect(sent).toEqual([]);
    expect(spoken).toEqual(["Yes?"]);
  });

  it("does not repeat the prompt when the name is said twice in a row", () => {
    drive.handleHeard("Friday");
    drive.handleHeard("Friday");
    expect(spoken).toEqual(["Yes?"]);
  });

  it("does not take her own words coming back through the microphone as a request", () => {
    (drive as unknown as { spokenText: string }).spokenText =
      "the report is ready and I have saved it to your desktop";
    (drive as unknown as { echoUntil: number }).echoUntil = Date.now() + 5000;
    drive.state.speaking = true;
    drive.handleHeard("the report is ready and I have saved it to your desktop");
    expect(sent).toEqual([]);
  });

  it("takes the owner's short answer right after she asks, even when it repeats her words", () => {
    const raw = drive as unknown as { spokenText: string; echoUntil: number };
    raw.spokenText = "The report is ready. Do you want me to open it now?";
    raw.echoUntil = Date.now() + 1200; // she just finished: the short tail window
    drive.state.speaking = false;
    drive.followUpUntil = Date.now() + 8000;
    // a two-word line needs a heard speech signal, which a real microphone gives and this test has none of
    const heard = vi.spyOn(voiceGate, "heardSpeechWithin").mockReturnValue(true);
    drive.handleHeard("open it");
    heard.mockRestore();
    expect(sent).toEqual(["open it"]);
  });

  it("asks which one only when nothing was just said, never right after she asked", () => {
    drive.handleHeard("Friday open it");
    expect(sent).toEqual([]); // no conversation yet: it has no referent
    expect(spoken.join(" ")).toMatch(/Which one/);
    spoken = [];
    (drive as unknown as { spokenText: string }).spokenText =
      "I found the invoice. Should I print it?";
    drive.followUpUntil = Date.now() + 8000;
    drive.handleHeard("Friday print it");
    expect(sent).toEqual(["print it"]);
    expect(spoken.join(" ")).not.toMatch(/Which one/);
  });

  it("still drops the last words of her own sentence coming back after she finished", () => {
    const raw = drive as unknown as { spokenText: string; echoUntil: number };
    raw.spokenText = "The report is ready. Do you want me to open it now?";
    raw.echoUntil = Date.now() + 1200;
    drive.state.speaking = false;
    drive.followUpUntil = Date.now() + 8000;
    drive.handleHeard("open it now");
    expect(sent).toEqual([]);
  });

  it("keeps the conversation open for a follow-up that answers her, without her name", () => {
    (drive as unknown as { spokenText: string }).spokenText = "Do you want me to open the file?";
    drive.followUpUntil = Date.now() + 8000;
    drive.handleHeard("yes open it please");
    drive.handleHeard("haan kholo");
    expect(sent.length).toBe(2);
  });

  it("ignores talk in the follow-up window that is plainly for someone else", () => {
    (drive as unknown as { spokenText: string }).spokenText = "Done. The file is open.";
    drive.followUpUntil = Date.now() + 8000;
    drive.handleHeard(
      "I told him yesterday that we would go to the market after lunch and then see about dinner",
    );
    drive.handleHeard("ok bye mom talk to you later");
    expect(sent).toEqual([]);
  });

  it("in hands-free mode takes a request without her name while awake", () => {
    drive.state.handsFree = true;
    (drive as unknown as { wakeWordRequired: boolean }).wakeWordRequired = false;
    drive.awakeUntil = Date.now() + 8000;
    drive.handleHeard("open the downloads folder");
    expect(sent).toEqual(["open the downloads folder"]);
  });
});

describe("stopping her", () => {
  it("stops on the natural phrases in English, Hindi and Hinglish when she is called by name", () => {
    for (const line of [
      "Friday please stop",
      "Friday bas karo",
      "Friday chup ho jao",
      "Friday that's enough",
    ]) {
      cancelled = 0;
      drive.handleHeard(line);
      expect(cancelled, line).toBe(1);
    }
    expect(sent).toEqual([]);
  });

  it("stops while she is speaking even without her name", () => {
    drive.state.speaking = true;
    (drive as unknown as { spokenText: string }).spokenText =
      "I am reading the long summary to you now.";
    drive.handleHeard("bas karo");
    expect(cancelled).toBe(1);
  });

  it("does not let a sentence between other people cancel her work when she is quiet", () => {
    drive.handleHeard("ek minute");
    drive.handleHeard("bas karo");
    drive.handleHeard("please stop");
    expect(cancelled).toBe(0);
    expect(sent).toEqual([]);
  });

  it("still takes the short stop words from anyone, as before", () => {
    drive.handleHeard("stop");
    expect(cancelled).toBe(1);
  });

  it("writes a longer stop phrase into a running meeting, where it is only talk", () => {
    drive.handleHeard("Friday start the meeting");
    drive.handleHeard("ek minute let me check the number");
    drive.handleHeard("bas karo");
    expect(voiceNotes.active()?.lines).toEqual(["ek minute let me check the number", "bas karo"]);
  });
});

describe("talking over her", () => {
  const speakingNow = () => {
    const raw = drive as unknown as { spokenText: string };
    raw.spokenText = "First I will open the file. Then I will read the summary.";
    drive.speechQueue = ["After that I will send it."];
    drive.state.speaking = true;
    drive.followUpUntil = Date.now() + 8000;
  };

  it("pauses on the first sound and goes on from where she was when the owner only nods", () => {
    speakingNow();
    drive.holdForInterruption();
    expect(drive.interruptHold).not.toBeNull();
    drive.handleHeard("haan");
    expect(drive.interruptHold).toBeNull();
    expect(sent).toEqual([]); // a nod is not a request
    expect(spoken.join(" ")).toMatch(/summary|After that/); // she carries on with what was left
  });

  it("stops the answer for good when the owner really interrupts, and takes the new request", () => {
    speakingNow();
    drive.holdForInterruption();
    drive.handleHeard("wait, open the budget sheet instead");
    expect(drive.interruptHold).toBeNull();
    expect(sent).toEqual(["wait, open the budget sheet instead"]);
    expect(spoken.join(" ")).not.toMatch(/After that/);
  });

  it("does not take her own voice for an interruption", () => {
    speakingNow();
    (drive as unknown as { echoUntil: number }).echoUntil = Date.now() + 5000;
    drive.holdForInterruption();
    drive.handleHeard("Then I will read the summary.");
    expect(sent).toEqual([]);
  });

  it("waits for a yes while a confirmation is open instead of treating yes as a nod", () => {
    speakingNow();
    drive.state.pending = {
      command: "delete all the old invoices",
      reason: "it deletes files",
      at: Date.now(),
    };
    drive.holdForInterruption();
    drive.handleHeard("haan");
    expect(sent).toEqual(["delete all the old invoices"]);
  });
});

describe("speaking an answer while it is still being written", () => {
  const feed = (runId: string, texts: string[]) => {
    texts.forEach((text, i) => drive.speakStreamed(runId, text, i === texts.length - 1));
  };

  it("speaks each finished sentence once, in order, and the tail when the answer ends", () => {
    feed("r1", [
      "Hello th",
      "Hello there. How a",
      "Hello there. How are you? I am",
      "Hello there. How are you? I am fine, thanks",
    ]);
    expect(spoken).toEqual(["Hello there.", "How are you?", "I am fine, thanks"]);
  });

  it("does not cut inside a name or a number that arrives in pieces", () => {
    feed("r2", [
      "Please ask Dr.",
      "Please ask Dr. Singh about the total of 3.",
      "Please ask Dr. Singh about the total of 3.5 million. Then call me",
      "Please ask Dr. Singh about the total of 3.5 million. Then call me back",
    ]);
    expect(spoken).toEqual([
      "Please ask Dr. Singh about the total of 3.5 million.",
      "Then call me back",
    ]);
  });

  it("starts over cleanly when the answer is rewritten from the start", () => {
    feed(
      "r3",
      ["First draft. Second", "Completely new answer. Next"].concat([
        "Completely new answer. Next bit",
      ]),
    );
    expect(spoken[0]).toBe("First draft.");
    // the new answer is spoken from its own first word, never from the middle of a word
    expect(spoken[1]).toBe("Completely new answer.");
    expect(spoken.join(" ")).not.toMatch(/\bw answer/);
  });

  it("holds the newest text while she is paused for a possible interruption, and says it afterwards", () => {
    (drive as unknown as { spokenText: string }).spokenText = "Something she was saying.";
    drive.state.speaking = true;
    drive.holdForInterruption();
    drive.speakStreamed("r4", "A new sentence arrives. And a tail", true);
    expect(spoken).toEqual([]); // held
    drive.handleHeard("hmm");
    expect(spoken.join(" ")).toMatch(/A new sentence arrives\./);
  });
});

describe("when the speech model was unsure of the words", () => {
  const unsure = () => {
    drive.lastHeardQuality = { avgLogprob: -1.7, languageProbability: 0.35, language: "en" };
  };

  it("reads the words back and goes ahead only on a yes", () => {
    unsure();
    drive.handleHeard("Friday open the calculator");
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toMatch(/Did you say .open the calculator/);
    drive.lastHeardQuality = null;
    drive.handleHeard("yes");
    expect(sent).toEqual(["open the calculator"]);
  });

  it("drops the words on a no and asks again", () => {
    unsure();
    drive.handleHeard("Friday open the calculator");
    drive.lastHeardQuality = null;
    drive.handleHeard("no");
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toMatch(/say it again/i);
  });

  it("does not take a yes to the read-back as approval of a consequential command", () => {
    unsure();
    drive.handleHeard("Friday delete all the old invoices");
    drive.lastHeardQuality = null;
    drive.handleHeard("yes"); // yes, that is what I said
    expect(sent).toEqual([]); // not run yet
    expect(drive.state.pending?.command).toBe("delete all the old invoices");
    expect(spoken.join(" ")).toMatch(/Confirm: should I delete all the old invoices/);
    drive.handleHeard("yes"); // yes, do it
    expect(sent).toEqual(["delete all the old invoices"]);
  });

  it("never holds up a stop word", () => {
    unsure();
    drive.handleHeard("Friday stop");
    expect(cancelled).toBe(1);
  });
});
