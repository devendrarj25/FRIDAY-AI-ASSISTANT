/**
 * Settings > Voice > Listening front end: the stored `voice.ears` shape (version 1), its defaults, the migration of
 * an older preferences file that has none, the clamps, the six Doctor rows and the wiring of the page. Nothing here
 * opens a microphone; every measurement is injected, and a missing one must read "absent", never a number.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_VOICE_EARS,
  sanitizeVoiceEars,
  type VoiceEarsPrefs,
} from "../../src/lib/friday/preferences";
import { earsRows, type EarsStats } from "../../src/lib/friday/voice-diagnostics-rows";
import { earsDoctorRows, voiceLayerChecks } from "../../src/lib/friday/voice-doctor";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.resetModules();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const IDS = ["ears-vad", "ears-turn", "ears-clip", "ears-agc", "ears-denoise", "ears-scene"];

describe("the stored shape and its defaults", () => {
  it("ships exactly the version 1 shape, with today's behaviour", () => {
    expect(DEFAULT_VOICE_EARS).toEqual({
      v: 1,
      hpf: true,
      agc: "browser",
      clipWarn: true,
      vad: "auto",
      vadStart: 0.5,
      vadEnd: 0.35,
      minSpeechMs: 120,
      preRollMs: 500,
      eagerness: "normal",
      eagerTurn: false,
      denoise: "off",
      scene: "score",
      otherVoice: "score",
      pcAudioRef: false,
    });
    expect(DEFAULT_PREFERENCES.voice.ears).toEqual(DEFAULT_VOICE_EARS);
    expect(DEFAULT_PREFERENCES.voice.ears).not.toBe(DEFAULT_VOICE_EARS);
    expect(DEFAULT_PREFERENCES.voice.noiseSuppression).toBe(true);
  });

  it("a missing, null or junk object reads the defaults", () => {
    for (const junk of [undefined, null, "x", 7, [], true]) {
      expect(sanitizeVoiceEars(junk)).toEqual(DEFAULT_VOICE_EARS);
    }
  });

  it("a partial object keeps what it set and fills the rest from the defaults", () => {
    const out = sanitizeVoiceEars({ agc: "own", vadStart: 0.6, eagerTurn: true });
    expect(out).toEqual({
      ...DEFAULT_VOICE_EARS,
      agc: "own",
      vadStart: 0.6,
      eagerTurn: true,
    });
  });

  it("unknown words and wrong types fall back key by key", () => {
    const out = sanitizeVoiceEars({
      agc: "loud",
      vad: 3,
      eagerness: "",
      denoise: "krisp",
      scene: null,
      otherVoice: "approve",
      hpf: "yes",
      minSpeechMs: "fast",
      v: 9,
    });
    expect(out).toEqual({ ...DEFAULT_VOICE_EARS, hpf: true });
  });
});

describe("the clamps", () => {
  it("vadStart stays 0.2 to 0.9", () => {
    expect(sanitizeVoiceEars({ vadStart: 0 }).vadStart).toBe(0.2);
    expect(sanitizeVoiceEars({ vadStart: 5 }).vadStart).toBe(0.9);
    expect(sanitizeVoiceEars({ vadStart: Number.NaN }).vadStart).toBe(0.5);
    expect(sanitizeVoiceEars({ vadStart: 0.65 }).vadStart).toBe(0.65);
  });

  it("vadEnd stays 0.05 up to vadStart minus 0.05", () => {
    expect(sanitizeVoiceEars({ vadStart: 0.5, vadEnd: 0.9 }).vadEnd).toBe(0.45);
    expect(sanitizeVoiceEars({ vadStart: 0.5, vadEnd: -1 }).vadEnd).toBe(0.05);
    expect(sanitizeVoiceEars({ vadStart: 0.2, vadEnd: 0.35 }).vadEnd).toBe(0.15);
    expect(sanitizeVoiceEars({ vadStart: 0.3 }).vadEnd).toBe(0.25);
    for (const start of [0.2, 0.3, 0.5, 0.9]) {
      const out = sanitizeVoiceEars({ vadStart: start, vadEnd: start });
      expect(out.vadEnd).toBeLessThanOrEqual(out.vadStart - 0.05 + 1e-9);
      expect(out.vadEnd).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("minSpeechMs is 60 to 400 and preRollMs is 200 to 1000, whole numbers", () => {
    expect(sanitizeVoiceEars({ minSpeechMs: 10 }).minSpeechMs).toBe(60);
    expect(sanitizeVoiceEars({ minSpeechMs: 9000 }).minSpeechMs).toBe(400);
    expect(sanitizeVoiceEars({ minSpeechMs: 150.7 }).minSpeechMs).toBe(150);
    expect(sanitizeVoiceEars({ preRollMs: 0 }).preRollMs).toBe(200);
    expect(sanitizeVoiceEars({ preRollMs: 99999 }).preRollMs).toBe(1000);
    expect(sanitizeVoiceEars({ preRollMs: Infinity }).preRollMs).toBe(500);
  });
});

describe("the store: migration of an older preferences file", () => {
  it("an old blob without `ears` hydrates to the defaults and keeps every other choice", async () => {
    store.set(
      "friday.preferences",
      JSON.stringify({
        theme: "dark",
        toggles: {},
        fields: {},
        voice: { wakeWord: "jarvis", noiseSuppression: false, streamEngine: "auto", itn: false },
      }),
    );
    const { preferences } = await import("../../src/lib/friday/preferences");
    const state = await preferences.hydrate();
    expect(state.voice.ears).toEqual(DEFAULT_VOICE_EARS);
    expect(state.voice.wakeWord).toBe("jarvis");
    expect(state.voice.noiseSuppression).toBe(false);
    expect(state.voice.streamEngine).toBe("auto");
    expect(state.voice.itn).toBe(false);
  });

  it("a stored partial and out-of-range `ears` is filled and clamped on load", async () => {
    store.set(
      "friday.preferences",
      JSON.stringify({
        voice: { ears: { denoise: "gtcrn", vadStart: 0.3, vadEnd: 0.8, preRollMs: 5 } },
      }),
    );
    const { preferences } = await import("../../src/lib/friday/preferences");
    const { ears } = (await preferences.hydrate()).voice;
    expect(ears.denoise).toBe("gtcrn");
    expect(ears.vadStart).toBe(0.3);
    expect(ears.vadEnd).toBe(0.25);
    expect(ears.preRollMs).toBe(200);
    expect(ears.minSpeechMs).toBe(120);
    expect(ears.v).toBe(1);
  });

  it("a stored `ears` that is not an object reads the defaults", async () => {
    store.set("friday.preferences", JSON.stringify({ voice: { ears: "broken" } }));
    const { preferences } = await import("../../src/lib/friday/preferences");
    expect((await preferences.hydrate()).voice.ears).toEqual(DEFAULT_VOICE_EARS);
  });

  it("a change is honoured, saved when the window closes, and a later vadStart re-clamps vadEnd", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    const { flushPendingState } = await import("../../src/lib/friday/persist");
    const now = preferences.getSnapshot().voice.ears;
    preferences.setVoice({ ears: { ...now, agc: "own", hpf: false, vadStart: 0.3 } });
    const ears = preferences.getSnapshot().voice.ears;
    expect(ears.agc).toBe("own");
    expect(ears.hpf).toBe(false);
    expect(ears.vadEnd).toBe(0.25);
    flushPendingState();
    await Promise.resolve();
    const saved = JSON.parse(store.get("friday.preferences") ?? "{}");
    expect(saved.voice.ears.agc).toBe("own");
    expect(saved.voice.ears.hpf).toBe(false);
    expect(saved.voice.noiseSuppression).toBe(true);
  });

  it("an import without `ears` and a reset both end on the defaults", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.setVoice({ ears: { ...DEFAULT_VOICE_EARS, denoise: "rnnoise" } });
    preferences.importJson(JSON.stringify({ voice: { wakeWord: "friday" } }));
    expect(preferences.getSnapshot().voice.ears).toEqual(DEFAULT_VOICE_EARS);
    preferences.setVoice({ ears: { ...DEFAULT_VOICE_EARS, denoise: "rnnoise" } });
    preferences.reset();
    expect(preferences.getSnapshot().voice.ears).toEqual(DEFAULT_VOICE_EARS);
    expect(preferences.getSnapshot().voice.ears).not.toBe(DEFAULT_VOICE_EARS);
  });
});

describe("the six Doctor rows", () => {
  const ears: VoiceEarsPrefs = { ...DEFAULT_VOICE_EARS, agc: "own", denoise: "gtcrn" };
  const measured: EarsStats = {
    vad: { engine: "silero", p: 0.83, speechMs: 640 },
    turn: { lastEndMs: 410, eager: 2, resumed: 1 },
    frontEnd: {
      clipRate: 0,
      peakDbfs: -6.2,
      rmsDbfs: -21.4,
      agcGainDb: 3.5,
      hpf: true,
      decimator: "fir",
    },
    denoise: { engine: "gtcrn", keepRatio: 0.9 },
    scene: { kind: "tv", score: 0.71 },
  };

  it("are the six ids in order, each with a label and a value", () => {
    const rows = earsRows(DEFAULT_VOICE_EARS, null);
    expect(rows.map((row) => row.id)).toEqual(IDS);
    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  it("say absent, with a reason and no number, when nothing was measured", () => {
    const rows = earsRows(ears, null);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    for (const id of [
      "ears-vad",
      "ears-turn",
      "ears-clip",
      "ears-agc",
      "ears-denoise",
      "ears-scene",
    ]) {
      expect(byId[id]?.state).toBe("absent");
      expect(byId[id]?.value).toMatch(/absent: /);
    }
    for (const row of rows) expect(row.value.split("absent: ")[1] ?? "").not.toMatch(/\d/);
    expect(rows.every((row) => row.bad === undefined)).toBe(true);
  });

  it("show the injected measurements when they exist", () => {
    const byId = Object.fromEntries(earsRows(ears, measured).map((row) => [row.id, row]));
    expect(byId["ears-vad"]?.value).toContain("running silero");
    expect(byId["ears-vad"]?.value).toContain("0.83");
    expect(byId["ears-turn"]?.value).toContain("410 ms");
    expect(byId["ears-agc"]?.value).toContain("gain 3.5 dB");
    expect(byId["ears-denoise"]?.value).toContain("running gtcrn");
    expect(byId["ears-denoise"]?.value).toContain("not measured");
    expect(byId["ears-scene"]?.value).toContain("sounds like tv");
    expect(byId["ears-scene"]?.value).toContain("never approves");
    expect(Object.values(byId).every((row) => row.state === "ok")).toBe(true);
  });

  it("flag clipping only when the warning is on and the rate is at or above the line", () => {
    const clipped: EarsStats = {
      frontEnd: { ...measured.frontEnd!, clipRate: 0.02, peakDbfs: -0.1 },
    };
    const on = earsRows(DEFAULT_VOICE_EARS, clipped).find((row) => row.id === "ears-clip");
    expect(on?.state).toBe("bad");
    expect(on?.bad).toBe(true);
    const off = earsRows({ ...DEFAULT_VOICE_EARS, clipWarn: false }, clipped).find(
      (row) => row.id === "ears-clip",
    );
    expect(off?.state).toBe("ok");
    expect(off?.bad).toBeUndefined();
  });

  it("a switched-off stage says off, and the browser leveller is not claimed as measured", () => {
    const rows = Object.fromEntries(
      earsRows({ ...DEFAULT_VOICE_EARS, scene: "off", denoise: "off", agc: "off" }, null).map(
        (row) => [row.id, row],
      ),
    );
    expect(rows["ears-scene"]?.state).toBe("off");
    expect(rows["ears-denoise"]?.state).toBe("off");
    expect(rows["ears-agc"]?.state).toBe("off");
    const browser = earsRows(DEFAULT_VOICE_EARS, measured).find((row) => row.id === "ears-agc");
    expect(browser?.value).toContain("not measured by FRIDAY");
  });

  it("reach the Doctor as voice:ears-* rows: Ready when fine, Warning when absent or bad", () => {
    const fine = earsDoctorRows(ears, measured);
    expect(fine.map((row) => row.id)).toEqual(IDS.map((id) => `voice:${id}`));
    expect(fine.every((row) => row.status === "Ready")).toBe(true);
    const none = earsDoctorRows(ears, null);
    expect(none.every((row) => row.status === "Warning")).toBe(true);
    expect(none.every((row) => row.fixable === false && row.group === "Voice")).toBe(true);
  });

  it("voiceLayerChecks adds them only when the caller injects them", () => {
    const base = voiceLayerChecks({ wake: "pass" });
    expect(base.some((row) => row.id.startsWith("voice:ears-"))).toBe(false);
    const withEars = voiceLayerChecks({ wake: "pass" }, { prefs: ears, stats: measured });
    expect(withEars.length).toBe(base.length + 6);
    expect(withEars.slice(0, base.length)).toEqual(base);
  });
});

describe("the page is wired", () => {
  const page = read("src/components/friday/settings/VoiceEarsSettings.tsx");

  it("is mounted in Settings > Voice", () => {
    const voice = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(voice).toContain("import { VoiceEarsSettings }");
    expect(voice).toContain("<VoiceEarsSettings />");
  });

  it("gives every stored key a control that writes it", () => {
    for (const key of Object.keys(DEFAULT_VOICE_EARS).filter((k) => k !== "v")) {
      expect(page, key).toMatch(
        new RegExp(`set\\(\\{ ${key}[ :}]|\\(${key}\\) => set\\(\\{ ${key} \\}\\)`),
      );
    }
    expect(page).toContain("DEFAULT_VOICE_EARS");
  });

  it("uses only shared components and tokens, and starts no timer", () => {
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(page).not.toMatch(/setInterval|setTimeout/);
    expect(page).toMatch(/ToggleRow/);
    expect(page).toMatch(/TuneRow/);
    expect(page).toMatch(/PickRow/);
    expect(page).not.toMatch(/grid-cols-\[/);
  });

  it("covers loading, offline, error with Retry and the empty (absent) reading", () => {
    expect(page).toContain('phase: "loading"');
    expect(page).toContain('phase: "offline"');
    expect(page).toContain('phase: "error"');
    expect(page).toContain('role="alert"');
    expect(page).toContain('role="status"');
    expect(page).toContain("onClick={reload}");
    expect(page).toContain("No measurement source is connected yet.");
    expect(page).toContain("Reset listening settings");
    expect(page).toContain("disabled={isDefault}");
    expect(page).toContain("earsRows(");
  });
});
