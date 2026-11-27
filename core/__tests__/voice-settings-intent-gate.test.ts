/**
 * A change of settings that a reply staged ("hands-free off, say yes") is applied by a spoken yes only through the
 * same checks as a digest yes: a short bound yes, inside the approval window, not under a TV or another voice. A
 * change that opens the microphone without the wake word or spends money waits for a yes on the screen. The
 * direction of an on/off request comes from one English, Roman Hindi and Devanagari table; an unclear one is asked
 * about, and the staged change shows the real current value. Fake clock; no microphone, speech engine or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import {
  clearPendingChange,
  pendingChange,
  readSettingsIntent,
  setHandsFreeReader,
} from "../../src/lib/friday/brain/settings-intents";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; handsFree: boolean };
  arbiter: SpeechArbiter;
  awakeUntil: number;
  followUpUntil: number;
  addressFacts: unknown;
  pendingHeard: unknown;
  handleHeard: (text: string) => void;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const START = new Date("2026-03-02T10:00:00Z").getTime();
let spoken: string[] = [];
let sent: string[] = [];
let handsFreeNow = true;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", approvalTtlSec: 30 });
  autonomy.reset();
  clearPendingChange();
  handsFreeNow = true;
  setHandsFreeReader(() => handsFreeNow);
  Object.assign(d.state, { mode: "auto", paused: false, muted: false, pending: null });
  d.pendingHeard = null;
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.awakeUntil = START + 600_000;
  d.followUpUntil = START + 600_000;
  d.addressFacts = null;
  spoken = [];
  sent = [];
  d.speak = (text: string) => void spoken.push(text);
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  vi.spyOn(brain, "send").mockImplementation(((text: string) => {
    sent.push(text);
    return { accepted: true };
  }) as never);
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  clearPendingChange();
  setHandsFreeReader(null);
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("the direction of an on/off request", () => {
  it("'hands-free band karo' stages OFF and a yes turns it off", async () => {
    const setHandsFree = vi
      .spyOn(assistantMode, "setHandsFree")
      .mockImplementation(() => undefined);
    const out = readSettingsIntent("hands-free band karo");
    expect(out?.kind).toBe("staged");
    expect(pendingChange()?.to).toBe("off");
    expect(readSettingsIntent("haan")?.kind).toBe("applied");
    await vi.waitFor(() => expect(setHandsFree).toHaveBeenCalledWith(false));
  });

  it("reads the same table in Roman Hindi and Devanagari", () => {
    for (const line of [
      "hands free bandh karo",
      "hands-free hatao",
      "hands free mat rakho",
      "hands free nahi chahiye",
      "hands free बंद करो",
      "hands free हटाओ",
    ]) {
      clearPendingChange();
      readSettingsIntent(line);
      expect(pendingChange()?.to, line).toBe("off");
    }
  });

  it("a line that names no direction asks 'on or off?' and stages nothing", () => {
    handsFreeNow = false;
    const out = readSettingsIntent("hands-free karo");
    expect(out?.kind).toBe("ask");
    expect(out?.message).toMatch(/on or off/i);
    expect(pendingChange()).toBeNull();
  });

  it("a line that names both directions asks too", () => {
    expect(readSettingsIntent("hands-free on karo band nahi")?.kind).toBe("ask");
  });

  it("shows the real current value, and refuses a change that changes nothing", () => {
    handsFreeNow = true;
    const out = readSettingsIntent("turn hands-free off");
    expect(out?.kind).toBe("staged");
    expect(out?.message).toMatch(/Currently it is on/);
    clearPendingChange();
    handsFreeNow = false;
    const same = readSettingsIntent("turn hands-free off");
    expect(same?.kind).toBe("refused");
    expect(same?.message).toMatch(/already off/i);
  });

  it("policy, billing, hands-free and wake-word changes wait for their yes only 30 seconds", () => {
    readSettingsIntent("turn hands-free off");
    expect(pendingChange()?.ttlMs).toBe(30_000);
    clearPendingChange();
    readSettingsIntent("allow paid models");
    expect(pendingChange()?.ttlMs).toBe(30_000);
  });
});

describe("a spoken yes to a staged change", () => {
  it("a fresh, short yes goes on to the Brain, which applies it", () => {
    readSettingsIntent("turn hands-free off");
    d.handleHeard("yes");
    expect(sent).toEqual(["yes"]);
    expect(spoken).toEqual([]);
  });

  it("a long line that only contains a yes is not a yes", () => {
    readSettingsIntent("turn hands-free off");
    d.handleHeard("yes and also send the report to everyone in my contacts please");
    expect(pendingChange()).not.toBeNull();
    expect(sent.join(" ")).not.toMatch(/^yes\b/);
  });

  it("a yes after the approval window lapses is dropped and applies nothing", () => {
    preferences.setVoice({ approvalTtlSec: 10 });
    readSettingsIntent("turn hands-free off");
    vi.setSystemTime(Date.now() + 15_000);
    d.handleHeard("yes");
    expect(pendingChange()).toBeNull();
    expect(sent).toEqual([]);
    expect(spoken.length).toBe(1);
  });

  it("a yes heard under a TV is not taken and the change stays staged", () => {
    readSettingsIntent("turn hands-free off");
    d.addressFacts = { scene: { kind: "tv", score: 0.9 } };
    d.handleHeard("yes");
    expect(pendingChange()).not.toBeNull();
    expect(sent).toEqual([]);
    expect(spoken.length).toBe(1);
  });

  it("turning hands-free ON needs the screen, not a spoken yes", () => {
    handsFreeNow = false;
    readSettingsIntent("turn hands-free on");
    expect(pendingChange()?.to).toBe("on");
    d.handleHeard("yes");
    expect(pendingChange()).not.toBeNull();
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toMatch(/tap on screen/i);
  });

  it("a paid model policy needs the screen, a free-only one does not", () => {
    readSettingsIntent("allow paid models");
    d.handleHeard("yes");
    expect(sent).toEqual([]);
    expect(spoken.join(" ")).toMatch(/tap on screen/i);
    spoken = [];
    clearPendingChange();
    readSettingsIntent("free only please");
    d.handleHeard("yes");
    expect(sent).toEqual(["yes"]);
  });
});

describe("a staged change does not survive pause, mute or Stop everything", () => {
  it("the tray pause drops it, so a yes after resume binds to nothing", () => {
    d.stopRecognition = () => undefined;
    readSettingsIntent("turn hands-free off");
    assistantMode.setPaused(true);
    expect(pendingChange()).toBeNull();
    assistantMode.setPaused(false);
  });

  it("mute drops it", () => {
    readSettingsIntent("turn hands-free off");
    assistantMode.setMuted(true);
    expect(pendingChange()).toBeNull();
    assistantMode.setMuted(false);
  });

  it("Stop everything drops it", () => {
    readSettingsIntent("turn hands-free off");
    autonomy.stopEverything();
    expect(pendingChange()).toBeNull();
    autonomy.resume();
  });
});
