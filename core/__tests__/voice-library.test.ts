import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { preferences, DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import {
  addSystemVoice,
  activeVoiceSettings,
  selectVoiceModel,
  spokenSummary,
  updateVoiceModel,
  removeVoiceModel,
} from "../../src/lib/friday/voice-library";

const root = resolve(import.meta.dirname, "../..");

describe("voice library", () => {
  beforeEach(() => {
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, models: [], activeId: "" } });
  });

  it("registers an installed voice and makes it selectable", () => {
    const model = addSystemVoice("Microsoft Swara Online (Natural) - Hindi (India)", "hi-IN");
    expect(preferences.getSnapshot().voice.models).toHaveLength(1);
    selectVoiceModel(model.id);
    expect(activeVoiceSettings().voiceName).toContain("Swara");
    expect(activeVoiceSettings().lang).toBe("hi-IN");
  });

  it("never duplicates the same system voice", () => {
    addSystemVoice("Microsoft Heera - English (India)", "en-IN");
    addSystemVoice("Microsoft Heera - English (India)", "en-IN");
    expect(preferences.getSnapshot().voice.models).toHaveLength(1);
  });

  it("keeps per-voice tuning and applies it when active", () => {
    const model = addSystemVoice("Microsoft Neerja - English (India)", "en-IN");
    updateVoiceModel(model.id, { rate: 1.4, pitch: 0.8, volume: 0.5 });
    selectVoiceModel(model.id);
    const tuning = activeVoiceSettings();
    expect(tuning.rate).toBeCloseTo(1.4);
    expect(tuning.pitch).toBeCloseTo(0.8);
    expect(tuning.volume).toBeCloseTo(0.5);
  });

  it("removing the active voice clears the selection without losing defaults", async () => {
    const model = addSystemVoice("Microsoft Swara", "hi-IN");
    selectVoiceModel(model.id);
    await removeVoiceModel(model.id);
    expect(preferences.getSnapshot().voice.models).toHaveLength(0);
    expect(preferences.getSnapshot().voice.activeId).toBe("");
    // the last selected voice stays as the plain fallback voice name
    expect(activeVoiceSettings().voiceName).toBe("Microsoft Swara");
  });

  it("exposes the voice-file channels on both sides of the desktop bridge", () => {
    const preload = readFileSync(resolve(root, "electron/preload.cjs"), "utf8");
    const main = readFileSync(resolve(root, "electron/main.cjs"), "utf8");
    for (const channel of ["voice:import", "voice:remove", "voice:list"]) {
      expect(preload).toContain(channel);
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
  });

  it("writes imported voice files only inside the canonical FRIDAY voices folder", () => {
    const main = readFileSync(resolve(root, "electron/main.cjs"), "utf8");
    expect(main).toContain('paths.ensureDir("voices")');
    expect(main).toContain("insideVoicesDir");
  });

  it("does not speak markdown, code fences, or citation leftovers", () => {
    const heard = spokenSummary(
      "## Login bug\n\n```ts\nconst x = 1;\n```\nThe timeout is on line 40 [1]. Sources: example.com",
    );
    expect(heard).not.toMatch(/```|const x|# /);
    expect(heard).toMatch(/timeout/i);
    expect(heard).not.toMatch(/Sources:/);
  });
});
