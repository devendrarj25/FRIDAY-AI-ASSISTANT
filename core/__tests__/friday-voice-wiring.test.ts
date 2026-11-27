/**
 * FRIDAY Voice wiring on the app side: the stored style list, the Electron style whitelist, the worker status the
 * Doctor reads, the Settings picker, the provider ranking and the warm-up. No model, network or clock is used; the
 * worker is a fake.
 */
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  LOCAL_VOICE_STYLES,
  preferences,
  sanitizeLocalVoiceStyle,
} from "../../src/lib/friday/preferences";
import {
  DEFAULT_LOCAL_STYLE,
  LOCAL_VOICE_CHOICES,
  SYNTHETIC_VOICE_NOTE,
  localVoicePickerState,
  ownerPresetStyle,
  pickerValueFor,
  profileFromPreferences,
  profileVoiceStyle,
  sanitizeFridayVoiceProfile,
} from "../../src/lib/friday/voice-engine/friday-voice-profile";
import {
  fridayVoiceRows,
  readFridayVoiceStatus,
} from "../../src/lib/friday/voice-diagnostics-rows";
import {
  fridayVoiceDoctorRows,
  noteFridayVoiceStatus,
  voiceLayerChecks,
} from "../../src/lib/friday/voice-doctor";
import { previewStyleToken } from "../../src/lib/friday/voice-library";
import { TTS_INFO, rankTtsProviders } from "../../src/lib/friday/voice-engine/tts-provider";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const neuralVoice = require_("../../electron/neural-voice.cjs");

const READY_OWN = {
  engine: "friday-voice",
  own: true,
  ready: true,
  voiceId: "friday",
  sampleRate: 44100,
  recipeVersion: 3,
  reason: "",
};

describe("the stored local voice style", () => {
  it("lists the FRIDAY voice, its two variants and the presets, and keeps every old value valid", () => {
    expect([...LOCAL_VOICE_STYLES]).toEqual([
      "",
      "friday",
      "friday-bright",
      "friday-calm",
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "M1",
      "M2",
    ]);
    for (const old of ["", "F1", "F2", "F3", "F4", "F5"])
      expect(sanitizeLocalVoiceStyle(old)).toBe(old);
  });

  it("reads anything else as the default and never lets a path through", () => {
    for (const bad of [
      "../x",
      "f2",
      "F6",
      "F2 ",
      "friday;rm",
      "C:\\voice",
      7,
      null,
      undefined,
      {},
    ]) {
      expect(sanitizeLocalVoiceStyle(bad)).toBe("");
    }
  });

  it("is made safe when it is saved: an odd stored value reads empty, the default stays empty", () => {
    preferences.setVoice({ localVoiceStyle: "../../evil" as never });
    expect(preferences.getSnapshot().voice.localVoiceStyle).toBe("");
    preferences.setVoice({ localVoiceStyle: "friday-calm" });
    expect(preferences.getSnapshot().voice.localVoiceStyle).toBe("friday-calm");
    preferences.setVoice({ localVoiceStyle: "F2" });
    expect(preferences.getSnapshot().voice.localVoiceStyle).toBe("F2");
    preferences.setVoice({ localVoiceStyle: "" });
    expect(preferences.getSnapshot().voice.localVoiceStyle).toBe("");
  });
});

describe("the profile keeps FRIDAY a female voice for Hindi and English", () => {
  it("accepts the FRIDAY voices and F1 to F5, drops a male preset from the profile itself", () => {
    for (const style of ["", "friday", "friday-bright", "friday-calm", "F4"]) {
      expect(profileVoiceStyle({ localVoiceStyle: style as never })).toBe(style);
    }
    expect(profileVoiceStyle({ localVoiceStyle: "M1" })).toBe("");
    const profile = profileFromPreferences({ localVoiceStyle: "friday-bright" });
    expect(profile.gender).toBe("female");
    expect(profile.languages.map((l) => l.code)).toEqual(["hi", "en"]);
    expect(sanitizeFridayVoiceProfile({ ...profile, gender: "male" }).gender).toBe("female");
  });

  it("passes a male preset on only as the owner's explicit choice", () => {
    expect(ownerPresetStyle({ localVoiceStyle: "M1" })).toBe("M1");
    expect(ownerPresetStyle({ localVoiceStyle: "M2" })).toBe("M2");
    for (const other of ["", "friday", "F2", "m1", "M3"]) {
      expect(ownerPresetStyle({ localVoiceStyle: other as never })).toBe("");
    }
  });

  it("the real speech path asks for FRIDAY's own voice when nothing else is chosen", () => {
    const library = read("src/lib/friday/voice-library.ts");
    expect(DEFAULT_LOCAL_STYLE).toBe("friday");
    expect(library).toContain("|| DEFAULT_LOCAL_STYLE");
    expect(library).toContain("ownerPresetStyle(voice)");
    expect(library).toContain('profileVoiceStyle(voice, "supertonic")');
  });
});

describe("the Electron style whitelist", () => {
  it("canonicalises only the listed ids, in any case", () => {
    expect(neuralVoice.normaliseLocalStyle("friday")).toBe("friday");
    expect(neuralVoice.normaliseLocalStyle(" FRIDAY-BRIGHT ")).toBe("friday-bright");
    expect(neuralVoice.normaliseLocalStyle("Friday-Calm")).toBe("friday-calm");
    expect(neuralVoice.normaliseLocalStyle("f3")).toBe("F3");
    expect(neuralVoice.normaliseLocalStyle("m2")).toBe("M2");
    expect(neuralVoice.LOCAL_STYLES).toHaveLength(10);
  });

  it("drops injection-like, path-like and oversized input to the default", () => {
    const hostile = [
      "../evil",
      "..\\..\\windows\\system32",
      "F2; rm -rf /",
      "F2\nM1",
      "F2\u0000",
      'friday" --out x',
      "$(whoami)",
      "M3",
      "F0",
      "F10",
      "friday-bright-extra",
      "x".repeat(5000),
      "__proto__",
      "constructor",
      "toString",
      "",
      "  ",
      null,
      undefined,
      7,
      {},
      ["F2"],
    ];
    for (const style of hostile) expect(neuralVoice.normaliseLocalStyle(style)).toBe("");
  });

  it("sends only a listed id to the worker, whatever the renderer sent", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const pcm = Buffer.from([1, 0, 2, 0]).toString("base64");
    const deps = {
      resolvePy: async () => ["python", []],
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        sent.push(payload);
        return { ok: true, pcm16: pcm, sampleRate: 44100, engine: "friday-voice", own: true };
      },
    };
    const calls = ["friday-calm", "F1", "../up", "friday; --x", "M2", ""];
    for (const style of calls) await neuralVoice.speakPcm({ text: "hi", style }, deps);
    expect(sent.map((p) => p["style"])).toEqual(["friday-calm", "F1", "", "", "M2", ""]);
    const own = await neuralVoice.speakPcm({ text: "hi", style: "friday-bright" }, deps);
    expect(own).toMatchObject({
      ok: true,
      engine: "friday-voice",
      own: true,
      voice: "friday-bright",
    });
    const none = await neuralVoice.speakPcm({ text: "hi" }, deps);
    expect(none.voice).toBe("friday");
  });

  it("does not call a package answer the own engine, and never trusts the worker's own flag alone", async () => {
    const pcm = Buffer.from([1, 0, 2, 0]).toString("base64");
    const ask = (answer: Record<string, unknown>) =>
      neuralVoice.speakPcm(
        { text: "hi" },
        {
          resolvePy: async () => ["python", []],
          request: async () => ({ ok: true, pcm16: pcm, ...answer }),
        },
      );
    expect((await ask({ engine: "supertonic-3", own: true })).own).toBe(false);
    expect((await ask({ engine: "friday-voice" })).own).toBe(false);
    expect((await ask({ engine: "friday-voice", own: "yes" })).own).toBe(false);
  });
});

describe("the worker status the renderer gets", () => {
  it("is read from the tts section, with a known engine, numbers and a short reason", () => {
    const status = neuralVoice.normaliseFridayVoiceStatus({
      tts: { ...READY_OWN, voiceId: "friday-calm" },
    });
    expect(status).toEqual({ ...READY_OWN, voiceId: "friday-calm" });
  });

  it("reads the old runtime shape as the package engine and an unknown engine as none", () => {
    const old = neuralVoice.normaliseFridayVoiceStatus({
      tts: { ready: true, engine: "supertonic-3", voice: "F2" },
    });
    expect(old).toMatchObject({ engine: "supertonic-3", own: false, ready: true, voiceId: "F2" });
    for (const raw of [null, undefined, 5, "x", [], { tts: { engine: "evil" } }]) {
      expect(neuralVoice.normaliseFridayVoiceStatus(raw)).toMatchObject({
        engine: "none",
        own: false,
        ready: false,
      });
    }
  });

  it("clamps the numbers, strips control characters and caps the reason", () => {
    const status = neuralVoice.normaliseFridayVoiceStatus({
      tts: {
        engine: "none",
        sampleRate: -1,
        recipeVersion: "abc",
        voiceId: "../x",
        reason: `no model\u0000\n${"y".repeat(500)}`,
      },
    });
    expect(status.sampleRate).toBe(0);
    expect(status.recipeVersion).toBe(0);
    expect(status.voiceId).toBe("");
    expect(status.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(status.reason.length).toBeLessThanOrEqual(200);
  });

  it("is attached to the status the app already asks for", () => {
    const source = read("electron/neural-voice.cjs");
    expect(source.match(/fridayVoice,/g)?.length).toBeGreaterThanOrEqual(3);
    expect(read("electron/main.cjs")).toContain(
      '"voice:neural-status", () => neuralVoice.status(true)',
    );
  });
});

describe("the Doctor rows for FRIDAY Voice", () => {
  it("own runner ready is Ready and names the voice, the sample rate and the recipe", () => {
    const rows = fridayVoiceDoctorRows(readFridayVoiceStatus(READY_OWN));
    expect(rows.map((r) => r.id)).toEqual([
      "voice:friday-voice-engine",
      "voice:friday-voice-active",
    ]);
    expect(rows.map((r) => r.status)).toEqual(["Ready", "Ready"]);
    expect(rows[0]?.label).toBe("FRIDAY Voice engine");
    expect(rows[0]?.detail).toMatch(/own runner ready/);
    expect(rows[1]?.detail).toBe("friday · 44.1 kHz · recipe v3");
  });

  it("the package fallback is a Warning that says so, with the reason", () => {
    const rows = fridayVoiceDoctorRows(
      readFridayVoiceStatus({
        ...READY_OWN,
        engine: "supertonic-3",
        own: false,
        reason: "runner missing",
      }),
    );
    expect(rows[0]?.status).toBe("Warning");
    expect(rows[0]?.detail).toMatch(/package fallback.*runner missing/);
    expect(rows[0]?.steps?.length).toBeGreaterThan(0);
  });

  it("not installed is a Warning with the reason, and the active row invents nothing", () => {
    const rows = fridayVoiceDoctorRows(
      readFridayVoiceStatus({ engine: "none", reason: "model folder absent" }),
    );
    expect(rows[0]?.status).toBe("Warning");
    expect(rows[0]?.detail).toMatch(/not installed.*model folder absent/);
    expect(rows[1]?.detail).toMatch(/no local voice is installed/);
    expect(rows[1]?.detail).not.toMatch(/kHz/);
  });

  it("no status yet is a Warning on both rows, never a pass", () => {
    const rows = fridayVoiceRows(null);
    expect(rows.map((r) => r.state)).toEqual(["absent", "absent"]);
    expect(noteFridayVoiceStatus(undefined)).toBeNull();
    expect(fridayVoiceDoctorRows().every((r) => r.status === "Warning")).toBe(true);
  });

  it("joins both Doctor row lists once, and reads odd shapes safely", () => {
    noteFridayVoiceStatus(READY_OWN);
    expect(fridayVoiceDoctorRows().map((r) => r.id)).toEqual([
      "voice:friday-voice-engine",
      "voice:friday-voice-active",
    ]);
    // The layer rows stay as they were: the FRIDAY Voice rows are their own, added next to them.
    expect(voiceLayerChecks({}).some((r) => r.id.startsWith("voice:friday-voice"))).toBe(false);
    const engine = read("src/lib/friday/doctor-engine.ts");
    expect(engine.match(/\.\.\.fridayVoiceDoctorRows\(\)/g)).toHaveLength(2);
    expect(engine).toContain("checks.push(...fridayVoiceDoctorRows());");
    expect(readFridayVoiceStatus("nope")).toBeNull();
    expect(readFridayVoiceStatus({ engine: "evil", own: true, sampleRate: "x" })).toMatchObject({
      engine: "none",
      own: false,
      sampleRate: 0,
    });
    noteFridayVoiceStatus(undefined);
  });

  it("the Doctor scan asks the worker for the status before it builds the rows", () => {
    const engine = read("src/lib/friday/doctor-engine.ts");
    expect(engine).toContain("noteFridayVoiceStatus(");
    expect(engine.indexOf("noteFridayVoiceStatus(")).toBeLessThan(
      engine.indexOf("...voiceLayerChecks(voiceDoctorMarks(), earsDoctorInput()),"),
    );
  });
});

describe("the Settings voice picker", () => {
  it("offers FRIDAY first, then bright and calm, then the presets", () => {
    expect(LOCAL_VOICE_CHOICES.map((c) => c.id)).toEqual([
      "",
      "friday-bright",
      "friday-calm",
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "M1",
      "M2",
    ]);
    expect(LOCAL_VOICE_CHOICES[0]?.label).toBe("FRIDAY (default, sweet and warm)");
    expect(LOCAL_VOICE_CHOICES[1]?.label).toBe("FRIDAY bright");
    expect(LOCAL_VOICE_CHOICES[2]?.label).toBe("FRIDAY calm");
    for (const choice of LOCAL_VOICE_CHOICES) expect(LOCAL_VOICE_STYLES).toContain(choice.id);
  });

  it("shows the default for an empty, a friday or an unknown stored value", () => {
    for (const stored of ["", "friday", "nope", undefined, 3])
      expect(pickerValueFor(stored)).toBe("");
    expect(pickerValueFor("F3")).toBe("F3");
    expect(pickerValueFor("friday-calm")).toBe("friday-calm");
  });

  it("covers loading, offline, error, empty and ready, and says which engine speaks", () => {
    const base = { loading: false, desktop: true, status: null };
    expect(localVoicePickerState({ ...base, desktop: false }).kind).toBe("offline");
    expect(localVoicePickerState({ ...base, loading: true }).kind).toBe("loading");
    expect(localVoicePickerState({ ...base, error: "worker did not answer" })).toMatchObject({
      kind: "error",
      note: "worker did not answer",
    });
    expect(localVoicePickerState(base).kind).toBe("empty");
    expect(
      localVoicePickerState({
        ...base,
        status: readFridayVoiceStatus({ engine: "none", reason: "absent" }),
      }),
    ).toMatchObject({ kind: "empty", note: expect.stringContaining("absent") });
    expect(
      localVoicePickerState({ ...base, status: readFridayVoiceStatus(READY_OWN) }),
    ).toMatchObject({
      kind: "ready",
      own: true,
    });
    const fallback = localVoicePickerState({
      ...base,
      status: readFridayVoiceStatus({ ...READY_OWN, engine: "supertonic-3", own: false }),
    });
    expect(fallback).toMatchObject({ kind: "ready", own: false });
  });

  it("is mounted in Settings, uses shared parts, previews through the sample path and has Retry", () => {
    const page = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(page).toContain("<LocalVoicePicker />");
    expect(page).toContain("previewStyle: style");
    expect(page).toContain("speakSample(");
    expect(page).toContain("onRetry={retry}");
    expect(page).toContain("SYNTHETIC_VOICE_NOTE");
    expect(page).not.toContain('<option value="F1">F1</option>');
    expect(SYNTHETIC_VOICE_NOTE).toMatch(/synthetic/);
    expect(SYNTHETIC_VOICE_NOTE).toMatch(/assistant, not a person/);
  });

  it("a preview asks for one listed style and nothing else", () => {
    expect(previewStyleToken("")).toBe("friday");
    expect(previewStyleToken("friday-calm")).toBe("friday-calm");
    expect(previewStyleToken("M1")).toBe("M1");
    for (const bad of ["../x", "f2", "F9", undefined, null, 4])
      expect(previewStyleToken(bad)).toBe("");
  });
});

describe("the provider ranking", () => {
  it("names the own engine and ranks it as the local default, before the system voice", () => {
    expect(TTS_INFO.supertonic.own).toBe(true);
    expect(TTS_INFO.supertonic.label).toBe("FRIDAY's own voice");
    const infos = [TTS_INFO.sapi, TTS_INFO.formant, TTS_INFO.supertonic];
    const ranking = rankTtsProviders(infos, { text: "hello", lang: "en-IN" }, {
      online: false,
      allowCloud: false,
      privacyMode: false,
      sensitive: false,
    } as never);
    const ids = ranking.order.map((info) => info.id);
    expect(ids[0]).toBe("supertonic");
    expect(ids.indexOf("supertonic")).toBeLessThan(ids.indexOf("sapi"));
    expect(ranking.order.find((info) => info.id === "supertonic")?.languages).toEqual(["hi", "en"]);
  });
});

describe("the warm-up", () => {
  it("warms the voice FRIDAY speaks with, which is her own unless another was chosen", () => {
    const source = read("src/lib/friday/voice-prewarm.ts");
    expect(source).toContain("style: activeLocalStyle()");
    expect(source).not.toContain("localVoiceStyle");
  });

  it("trusts the own engine being ready even when the online voice package is missing", async () => {
    vi.resetModules();
    const speakNeuralPcm = vi.fn(async () => ({
      ok: true,
      sampleRate: 44100,
      pcm: new Uint8Array([1, 0, 2, 0]),
    }));
    const api = {
      neuralVoiceStatus: async () => ({
        available: false,
        reason: "edge-tts missing",
        fridayVoice: READY_OWN,
      }),
      speakNeuralPcm,
    };
    vi.stubGlobal("window", { friday: api });
    const prewarm = await import("../../src/lib/friday/voice-prewarm");
    const io = prewarm.createPrewarmIO();
    const done = await io.warmSpeech("Ready.");
    expect(done).toMatchObject({ ok: true });
    expect(speakNeuralPcm).toHaveBeenCalledWith(expect.objectContaining({ style: "friday" }));
    vi.unstubAllGlobals();
  });
});
