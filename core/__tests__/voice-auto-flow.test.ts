/**
 * The real Auto mode controller, driven with heard lines. Nothing here opens a microphone or a speaker: the voice
 * output is replaced by a recorder and the Brain is not asked. It checks what the controller decides to do with a
 * line, which is where a wake word, a note, a translation or a stop word can be dropped or misread.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
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
  drive.liveWakeAt = 0;
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
