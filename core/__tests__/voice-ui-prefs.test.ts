/**
 * Voice task preferences: shipped defaults, the sanitiser, old stored shapes, and the settings rows being wired
 * to the real stored keys. Nothing here needs a window, a microphone or the network.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_VOICE_TASK_PREFS,
  preferences,
  sanitizeVoiceTaskPrefs,
} from "../../src/lib/friday/preferences";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("voice task preferences", () => {
  it("ship the agreed defaults, and every new audible switch is off", () => {
    expect(DEFAULT_PREFERENCES.voice.tasks).toEqual({
      maxParallel: 1,
      narration: "normal",
      progressLinesPerMinute: 3,
      speakDone: true,
      resumeAfterRestart: "ask",
      sideQuestionLane: true,
    });
    expect(DEFAULT_VOICE_TASK_PREFS).toEqual(DEFAULT_PREFERENCES.voice.tasks);
    expect(DEFAULT_PREFERENCES.voice.instantAck).toBe(false);
    expect(DEFAULT_PREFERENCES.voice.eagerTurn).toBe(false);
    expect(DEFAULT_PREFERENCES.voice.echoReference).toBe(false);
  });

  it("sanitise: unknown words fall back, numbers clamp, junk becomes the default", () => {
    expect(sanitizeVoiceTaskPrefs(null)).toEqual(DEFAULT_VOICE_TASK_PREFS);
    expect(sanitizeVoiceTaskPrefs(undefined)).toEqual(DEFAULT_VOICE_TASK_PREFS);
    const odd = sanitizeVoiceTaskPrefs({
      maxParallel: 9,
      narration: "shouting" as never,
      progressLinesPerMinute: 99,
      speakDone: "no" as never,
      resumeAfterRestart: "always" as never,
      sideQuestionLane: 0 as never,
    });
    expect(odd).toEqual({
      maxParallel: 3,
      narration: "normal",
      progressLinesPerMinute: 6,
      speakDone: true,
      resumeAfterRestart: "ask",
      sideQuestionLane: true,
    });
    expect(sanitizeVoiceTaskPrefs({ maxParallel: -4, progressLinesPerMinute: -2.7 })).toMatchObject(
      { maxParallel: 1, progressLinesPerMinute: 0 },
    );
    expect(
      sanitizeVoiceTaskPrefs({ maxParallel: Number.NaN, progressLinesPerMinute: Number.NaN }),
    ).toMatchObject({ maxParallel: 1, progressLinesPerMinute: 3 });
    expect(sanitizeVoiceTaskPrefs({ maxParallel: 2.9 }).maxParallel).toBe(2);
  });

  it("sanitise keeps real choices and an explicit off", () => {
    expect(
      sanitizeVoiceTaskPrefs({
        narration: "chatty",
        progressLinesPerMinute: 0,
        speakDone: false,
        resumeAfterRestart: "auto",
        sideQuestionLane: false,
      }),
    ).toEqual({
      maxParallel: 1,
      narration: "chatty",
      progressLinesPerMinute: 0,
      speakDone: false,
      resumeAfterRestart: "auto",
      sideQuestionLane: false,
    });
  });

  it("an old stored voice shape without tasks reads the defaults; a partial one is completed", () => {
    const {
      tasks: _tasks,
      instantAck: _a,
      eagerTurn: _e,
      echoReference: _r,
      ...oldVoice
    } = DEFAULT_PREFERENCES.voice;
    preferences.importJson(JSON.stringify({ voice: { ...oldVoice, wakeWord: "jarvis" } }));
    let voice = preferences.getSnapshot().voice;
    expect(voice.wakeWord).toBe("jarvis");
    expect(voice.tasks).toEqual(DEFAULT_VOICE_TASK_PREFS);
    expect(voice.instantAck).toBe(false);
    expect(voice.eagerTurn).toBe(false);
    expect(voice.echoReference).toBe(false);

    preferences.importJson(
      JSON.stringify({
        voice: { tasks: { narration: "quiet", speakDone: false }, eagerTurn: "yes" },
      }),
    );
    voice = preferences.getSnapshot().voice;
    expect(voice.tasks).toEqual({
      ...DEFAULT_VOICE_TASK_PREFS,
      narration: "quiet",
      speakDone: false,
    });
    expect(voice.eagerTurn).toBe(false);

    preferences.setVoice({ instantAck: true, echoReference: true });
    expect(preferences.getSnapshot().voice.instantAck).toBe(true);
    expect(preferences.getSnapshot().voice.echoReference).toBe(true);
    // A single task switch never wipes the other task settings.
    preferences.setVoice({ tasks: { ...voice.tasks, progressLinesPerMinute: 5 } });
    expect(preferences.getSnapshot().voice.tasks.narration).toBe("quiet");
    expect(preferences.getSnapshot().voice.tasks.progressLinesPerMinute).toBe(5);
    preferences.importJson(JSON.stringify({ voice: { tasks: { progressLinesPerMinute: 40 } } }));
    expect(preferences.getSnapshot().voice.tasks.progressLinesPerMinute).toBe(6);
  });

  it("registers the new keys in the flow registry", () => {
    const registry = read("src/lib/friday/flow-registry.gen.ts");
    for (const key of [
      "voice.tasks",
      "voice.instantAck",
      "voice.eagerTurn",
      "voice.echoReference",
    ]) {
      expect(registry).toContain(`"${key}"`);
    }
  });
});

describe("voice settings rows are wired to the stored keys", () => {
  const source = read("src/components/friday/settings/VoiceSettings.tsx");

  it("has the three switches, off unless the stored value is true", () => {
    for (const [label, key] of [
      ["Say a short acknowledgement while I work", "instantAck"],
      ["Start thinking before I finish speaking (experimental)", "eagerTurn"],
      ["Cancel her own voice from the microphone (experimental)", "echoReference"],
    ] as const) {
      expect(source).toContain(label);
      expect(source).toContain(`on={prefs.voice.${key} === true}`);
      expect(source).toContain(`preferences.setVoice({ ${key}: prefs.voice.${key} !== true })`);
    }
    expect(source).toMatch(/unverified on your PC until you try it/i);
  });

  it("has one Tasks while talking card that reads and writes voice.tasks", () => {
    expect(source.match(/Tasks while talking/g)?.length).toBe(1);
    expect(source).toContain("sanitizeVoiceTaskPrefs(prefs.voice.tasks)");
    expect(source).toContain("preferences.setVoice({ tasks: sanitizeVoiceTaskPrefs(");
    for (const needle of [
      "tasks.narration",
      "tasks.progressLinesPerMinute",
      "tasks.speakDone",
      "tasks.resumeAfterRestart",
      "tasks.sideQuestionLane",
      "Full autonomy",
    ]) {
      expect(source).toContain(needle);
    }
    for (const value of ["quiet", "normal", "chatty", "ask", "auto"]) {
      expect(source).toContain(`value="${value}"`);
    }
  });
});
