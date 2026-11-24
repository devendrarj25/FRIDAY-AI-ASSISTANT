/**
 * The conductor's wiring of the push-to-talk state and the hands-free wake gates (the modules themselves are
 * tested in push-to-talk-hold and voice-wake-guard): Mute, pause, Stop everything and leaving Auto close the talk
 * key and put the wake gate to sleep, and unmute or resume release both; a wake word goes through the gate; a wake
 * with no command after it is reported false; her speech starts and ends the gate's speaking state. Fake devices
 * and the real modules; the microphone and speaker cannot run here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = globalThis as unknown as { window?: unknown; friday?: unknown };
win.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
(globalThis as unknown as { document?: unknown }).document ??= {
  hidden: false,
  documentElement: { classList: { toggle: () => undefined } },
  addEventListener: () => undefined,
  hasFocus: () => true,
  head: { appendChild: () => undefined },
  getElementsByTagName: () => [{ appendChild: () => undefined }],
  createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined }),
  createTextNode: () => ({}),
};
win.friday = { onVoicePartial: () => () => undefined };

const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
const { preferences, DEFAULT_PREFERENCES } = await import("../../src/lib/friday/preferences");
const { voiceGate } = await import("../../src/lib/friday/voice-audio");
const ptt = await import("../../src/lib/friday/push-to-talk");
assistantMode.subscribe(() => undefined);

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; muted: boolean };
  setMuted: (muted: boolean) => void;
  setPaused: (paused: boolean) => void;
  setHandsFree: (on: boolean, persist?: boolean) => void;
  leaveAuto: () => void;
  armPushToTalk: () => void;
  disarmPushToTalk: () => void;
  wakeGuardAllows: (text: string) => boolean;
  pauseForSpeech: () => void;
  bargeMicLevel: number;
  bargeMicAt: number;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
  pausedByStop: boolean;
};
const d = assistantMode as unknown as Driver;

const root = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");
const modeSource = read("src/lib/friday/assistant-mode.ts");

/** Speech frames that end now, so the gate has heard enough voice before a wake. */
function hearSpeech(ms = 360) {
  const end = performance.now();
  for (let t = end - ms; t <= end; t += 30) {
    voiceGate.wake.observe({ nowMs: t, level: 0.3, speech: true, speaking: false });
  }
}

beforeEach(() => {
  Object.assign(d.state, { mode: "auto", paused: false, muted: false, micReady: true });
  d.pausedByStop = false;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  preferences.setVoice({ listenStyle: "always" });
  ptt.resetPtt();
  voiceGate.wake.release(performance.now());
});

afterEach(() => {
  d.disarmPushToTalk();
  voiceGate.wake.release(performance.now());
});

describe("Mute, pause and leaving Auto close the talk key and put the wake gate to sleep", () => {
  it("mute: a press opens nothing and the gate is locked; unmute lets both work again", () => {
    d.setMuted(true);
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(false);
    expect(voiceGate.wake.snapshot().locked).toBe("muted");
    expect(voiceGate.wake.snapshot().counters.forcedAsleep).toBeGreaterThan(0);
    d.setMuted(false);
    expect(voiceGate.wake.snapshot().locked).toBe("");
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(true);
  });

  it("mute ends a held key and an open toggle at once", () => {
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(true);
    d.setMuted(true);
    expect(ptt.pttActive()).toBe(false);
    expect(ptt.pttPhase()).toBe("idle");
    d.setMuted(false);
  });

  it("the tray pause locks the gate as 'paused' and a resume releases it", () => {
    d.setPaused(true);
    expect(voiceGate.wake.snapshot().locked).toBe("paused");
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(false);
    d.setPaused(false);
    expect(voiceGate.wake.snapshot().locked).toBe("");
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(true);
  });

  it("unmuting while the pause is on does not release the gate", () => {
    d.setMuted(true);
    d.setPaused(true);
    d.setMuted(false);
    expect(voiceGate.wake.snapshot().locked).not.toBe("");
    ptt.pttPress();
    expect(ptt.pttActive()).toBe(false);
    d.setPaused(false);
  });

  it("a pause that Stop everything made is locked as 'stopped'", () => {
    d.pausedByStop = true;
    d.setPaused(true);
    expect(voiceGate.wake.snapshot().locked).toBe("stopped");
    d.pausedByStop = false;
    d.setPaused(false);
  });

  it("leaving Auto closes the key and locks the gate", () => {
    ptt.pttPress();
    d.leaveAuto();
    expect(ptt.pttActive()).toBe(false);
    expect(voiceGate.wake.snapshot().locked).toBe("stopped");
    Object.assign(d.state, { mode: "auto" });
  });

  it("the source calls the same pair at every stop point and releases it at every resume", () => {
    expect(modeSource).toMatch(
      /private gateSleep\([^)]*\) \{\s*pttSetAllowed\(false\);\s*pttCloseNow\(\);/,
    );
    expect(modeSource).toMatch(/voiceGate\.wake\.forceAsleep\(reason, performance\.now\(\)\)/);
    expect(modeSource).toMatch(
      /pttSetAllowed\(allowed\);\s*if \(allowed\) voiceGate\.wake\.release\(performance\.now\(\)\)/,
    );
    for (const where of [
      /if \(muted\) this\.gateSleep\("muted"\)/,
      /this\.gateSleep\(this\.pausedByStop \|\| this\.stopped\(\) \? "stopped" : "paused"\)/,
      /brain\.stop\(\);\s*this\.gateSleep\("stopped"\)/,
      /this\.disarmPushToTalk\(\);\s*this\.gateSleep\("stopped"\)/,
    ]) {
      expect(modeSource).toMatch(where);
    }
    expect(modeSource.match(/this\.gateRelease\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("push-to-talk in the window", () => {
  it("losing focus ends the hold like a release (pttFocusLost), and the status shows Listening then Finishing", () => {
    expect(modeSource).toMatch(/const blur = \(\) => \{\s*pttFocusLost\(\);/);
    preferences.setVoice({ listenStyle: "push-to-talk" });
    d.armPushToTalk();
    const now = Date.now();
    ptt.pttPress(now - 500);
    expect(d.state["status"]).toBe("Listening");
    ptt.pttFocusLost(now);
    expect(ptt.pttPhase(now)).toBe("finishing");
    expect(d.state["status"]).toBe("Finishing");
  });

  it("a session that ended with the key down does not hide the first press of the next one", () => {
    d.armPushToTalk();
    ptt.pttPress();
    expect(d.state["status"]).toBe("Listening");
    d.disarmPushToTalk();
    d.state["status"] = "Ready";
    d.armPushToTalk();
    ptt.pttPress();
    expect(d.state["status"]).toBe("Listening");
  });

  it("the stored release tail is read when push-to-talk is armed, and it is clamped", () => {
    expect(DEFAULT_PREFERENCES.voice.pttTailMs).toBe(ptt.PTT_TAIL_DEFAULT_MS);
    preferences.setVoice({ pttTailMs: 600 });
    d.armPushToTalk();
    expect(ptt.pttTailMs("en")).toBe(600);
    preferences.setVoice({ pttTailMs: 5 });
    expect(preferences.getSnapshot().voice.pttTailMs).toBe(ptt.PTT_TAIL_MIN_MS);
    preferences.setVoice({ pttTailMs: 99_999 });
    expect(preferences.getSnapshot().voice.pttTailMs).toBe(ptt.PTT_TAIL_MAX_MS);
    preferences.setVoice({ pttTailMs: "slow" as never });
    expect(preferences.getSnapshot().voice.pttTailMs).toBe(ptt.PTT_TAIL_DEFAULT_MS);
    preferences.setVoice({ pttTailMs: ptt.PTT_TAIL_DEFAULT_MS });
  });
});

describe("a wake word that was heard goes through the gate", () => {
  it("accepted with enough speech heard before it, refused without", () => {
    expect(d.wakeGuardAllows("friday open the report")).toBe(false);
    expect(voiceGate.wake.snapshot().counters.blocked["no-speech"]).toBeGreaterThan(0);
    hearSpeech();
    expect(d.wakeGuardAllows("friday open the report")).toBe(true);
  });

  it("refused while the gate is locked (muted), but a stop word is never held up", () => {
    hearSpeech();
    d.setMuted(true);
    d.state["micReady"] = true; // a transcript that was already on its way when the mic closed
    expect(d.wakeGuardAllows("friday open the report")).toBe(false);
    expect(d.wakeGuardAllows("friday stop")).toBe(true);
    d.setMuted(false);
  });

  it("with no open microphone the gate has nothing to judge by, so the transcript decides", () => {
    d.state["micReady"] = false;
    expect(d.wakeGuardAllows("friday open the report")).toBe(true);
    expect(modeSource).toMatch(/if \(!this\.state\.micReady\) return true;/);
  });

  it("a push-to-talk turn is addressed by the key and never needs the gate", () => {
    preferences.setVoice({ listenStyle: "push-to-talk" });
    expect(d.wakeGuardAllows("open the report")).toBe(true);
  });

  it("her own voice cannot wake her, and that is counted as a false wake", () => {
    hearSpeech();
    voiceGate.wake.speakStart(performance.now());
    const before = voiceGate.wake.snapshot().counters.falseWakes;
    expect(d.wakeGuardAllows("friday open the report")).toBe(false);
    expect(voiceGate.wake.snapshot().counters.falseWakes).toBe(before + 1);
    voiceGate.wake.release(performance.now());
  });

  it("the wake path is wired: guard, false wake, accepted turn, follow-up, speaking and hands-free", () => {
    expect(modeSource).toMatch(
      /const guardAllows = heardWake \? this\.wakeGuardAllows\(text\) : true;/,
    );
    expect(modeSource).toMatch(/if \(wake\.matched\) this\.reportFalseWake\(\);/);
    expect(modeSource).toMatch(
      /this\.expectCommandAfterWake\(\);\s*const ready = this\.variedLine\("wake", text\)/,
    );
    expect(modeSource).toMatch(/voiceGate\.wake\.followUpSpeech\(turnAt\)/);
    expect(modeSource).toMatch(/voiceGate\.wake\.turnAccepted\(turnAt\)/);
    expect(modeSource).toMatch(/voiceGate\.wake\.speakStart\(performance\.now\(\)\)/);
    expect(modeSource.match(/voiceGate\.wake\.speakEnd\(performance\.now\(\)\)/g)?.length).toBe(5);
    expect(modeSource).toMatch(/voiceGate\.wake\.setHandsFree\(on\)/);
  });

  it("the hands-free choice is passed on, and its shipped default is untouched (off until the owner turns it on)", () => {
    d.setHandsFree(true, false);
    expect(voiceGate.wake.handsFree).toBe(true);
    d.setHandsFree(false, false);
    expect(voiceGate.wake.handsFree).toBe(false);
    expect(modeSource).toMatch(/\n {4}handsFree: false,/);
  });

  it("the diagnostics panel shows the wake gate rows", () => {
    const panel = read("src/components/friday/VoiceDiagnostics.tsx");
    expect(panel).toContain("...wakeGuardRows(voiceGate.wake.snapshot())");
  });
});

describe("the wake settings", () => {
  it("the wake settings are stored bounded and reach the gate when push-to-talk is armed", () => {
    expect(DEFAULT_PREFERENCES.voice.wake.cooldownMs).toBe(5000);
    preferences.setVoice({ wake: { ...DEFAULT_PREFERENCES.voice.wake, cooldownMs: 1 } });
    expect(preferences.getSnapshot().voice.wake.cooldownMs).toBe(500);
    d.armPushToTalk();
    voiceGate.wake.reportFalseWake(performance.now());
    expect(voiceGate.wake.snapshot().cooldownLeftMs).toBeLessThanOrEqual(501);
    preferences.setVoice({ wake: { ...DEFAULT_PREFERENCES.voice.wake } });
    d.armPushToTalk();
  });
});

describe("live words on the conductor (timed passes, caption only)", () => {
  const start = modeSource.indexOf("private startLiveWords()");
  const stop = modeSource.indexOf("private stopLiveWords(");
  const body = modeSource.slice(start, stop);

  it("uses the timed follower over the provisional live-pass bridge, reading the owner's language and size fresh", () => {
    expect(start).toBeGreaterThan(0);
    expect(modeSource).toMatch(
      /import \{ LiveWords, livePassDeps \} from "\.\/voice-engine\/live-words"/,
    );
    expect(body).toMatch(/new LiveWords\(\{\s*timed: true,\s*audioSince:/);
    expect(body).toMatch(
      /\.\.\.livePassDeps\(api, \(\) => \{\s*const v = preferences\.getSnapshot\(\)\.voice;/,
    );
    expect(body).toContain("language: whisperLanguageArg(v.recognitionLang)");
    expect(body).toContain("speechPref: v.recognitionLang");
    expect(body).toContain("sttSize: v.sttSize");
    // The plain transcribe dependency is gone: nothing here calls the bridge outside the live-pass wrapper.
    expect(body).not.toMatch(/api\.transcribe/);
  });

  it("partials only set the caption: never executed, never counted as heard, never sent to the Brain", () => {
    const update = body.slice(body.indexOf("onUpdate:"));
    expect(update).toMatch(/this\.state\.interim = update\.shown;/);
    expect(body).not.toMatch(
      /brain\.|dispatch\(|routeCommand\(|handleHeard\(|remember\(|pendingUserEcho|caption\(/,
    );
    expect(body).toContain("speaking: () => voiceGate.heardSpeechWithin(1200)");
  });

  it("stays off by default and only runs in Auto when the owner turned it on", () => {
    expect(DEFAULT_PREFERENCES.voice.liveWords).toBe(false);
    expect(modeSource).toMatch(
      /preferences\.getSnapshot\(\)\.voice\.liveWords === true &&\s*this\.state\.mode === "auto" &&\s*!this\.state\.paused &&\s*!this\.state\.speaking/,
    );
  });
});

describe("review fixes: a reply that never reported its end cannot lock the owner out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("speech starts, no end is ever reported: 30 s later a wake utterance still passes", () => {
    const base = performance.now();
    let now = base;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    d.pauseForSpeech();
    now = base + 30_000;
    // A stale loud reading from her own speech must not stand in for the owner's energy.
    d.bargeMicLevel = 0.01;
    d.bargeMicAt = base;
    hearSpeech();
    expect(d.wakeGuardAllows("friday open the report")).toBe(true);
    expect(voiceGate.wake.snapshot().counters.falseWakes).toBe(
      voiceGate.wake.snapshot().counters.falseWakes,
    );
  });

  it("a mic level older than a second is not passed as the owner's energy; a fresh one is", () => {
    const consider = vi.spyOn(voiceGate.wake, "consider");
    hearSpeech();
    d.bargeMicLevel = 0.6;
    d.bargeMicAt = performance.now() - 5000;
    d.wakeGuardAllows("friday open the report");
    expect(consider.mock.calls[0]?.[0]).not.toHaveProperty("ownerEnergy");
    d.bargeMicAt = performance.now();
    d.wakeGuardAllows("friday open the report");
    expect(consider.mock.calls[1]?.[0]).toMatchObject({ ownerEnergy: 0.6 });
  });

  it("both failed-voice paths and the skipped resume report the end of her reply to the wake gate", () => {
    const fail = modeSource.match(
      /this\.to\("tts-failed"\);\s*this\.state\.speaking = false;\s*voiceGate\.setSpeakingGuard\(false\);\s*voiceGate\.wake\.speakEnd\(performance\.now\(\)\);/g,
    );
    expect(fail).toHaveLength(2);
    expect(modeSource).toMatch(
      /this\.resumeAfterSpeech\(\);\s*\} else \{[^}]*voiceGate\.wake\.speakEnd\(performance\.now\(\)\);\s*\}/,
    );
  });

  it("a refused wake in hands-free still names her, so the 'Friday,' prefix is stripped from the command", () => {
    expect(modeSource).toMatch(
      /const guardAllows = heardWake \? this\.wakeGuardAllows\(text\) : true;[\s\S]{0,160}const matched = heardWake && \(guardAllows \|\| this\.state\.handsFree\);/,
    );
  });
});
