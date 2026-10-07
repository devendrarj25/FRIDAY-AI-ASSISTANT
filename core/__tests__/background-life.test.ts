import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { splitByLanguage, neuralVoiceFor } from "../../src/lib/friday/voice-library";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("tray + background life", () => {
  const main = read("electron/main.cjs");
  const tray = read("electron/tray.cjs");
  const preload = read("electron/preload.cjs");

  it("keeps the window alive when it is closed", () => {
    expect(main).toContain("function hideToTray");
    expect(main).toContain("if (!app.__fridayQuitting) {");
    expect(main).toContain("event.preventDefault();");
    expect(main).toContain('if (app.__fridayQuitting || process.platform === "darwin") return;');
  });

  it("offers the three tray actions and one real quit path", () => {
    for (const label of ["Open FRIDAY", "Pause listening", "Quit FRIDAY"]) {
      expect(tray).toContain(label);
    }
    expect(main).toContain("function quitFriday");
    expect(main).toContain('ipcMain.handle("app:quit"');
  });

  it("tells the user once that FRIDAY is still running", () => {
    expect(tray).toContain("noticeBackground");
    expect(tray).toContain("FRIDAY is still running");
    expect(main).toContain("tray.noticeBackground()");
  });

  it("exposes show/hide, quit and the honest mic state over the bridge", () => {
    for (const call of ["window:show", "app:quit", "voice:state", "voice:pause"]) {
      expect(preload).toContain(call);
    }
    expect(main).toContain('ipcMain.on("voice:state"');
  });
});

describe("wake word while hidden", () => {
  const mode = read("src/lib/friday/assistant-mode.ts");

  it("does not stop the microphone when the window is hidden", () => {
    expect(mode).not.toContain("if (document.hidden) this.stopRecognition();");
    expect(mode).toContain("!document.hidden && !this.dictation?.active");
  });

  it("shows the window when the wake word is heard while hidden", () => {
    expect(mode).toContain("desktop()?.showWindow?.()");
  });

  it("really stops the microphone when the tray pauses listening", () => {
    expect(mode).toContain("setPaused(paused: boolean)");
    expect(mode).toContain("this.stopRecognition();");
    expect(mode).toContain("reportVoiceState");
  });
});

describe("neural voice", () => {
  const neural = read("electron/neural-voice.cjs");

  it("uses free edge-tts Indian neural voices and the shared Python resolver", () => {
    expect(neural).toContain("hi-IN-SwaraNeural");
    expect(neural).toContain("en-IN-NeerjaNeural");
    expect(neural).toContain('require("./python.cjs")');
    expect(neural).toContain('paths.ensureDir("cache")');
  });

  it("routes each language of a Hinglish reply to its own voice", () => {
    const parts = splitByLanguage("नमस्ते सर. Your build finished successfully.");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.lang).toBe("hi-IN");
    expect(parts[1]?.lang).toBe("en-IN");
    expect(neuralVoiceFor(parts[0]!.lang)).toBe("hi-IN-SwaraNeural");
    expect(neuralVoiceFor(parts[1]!.lang)).toBe("en-IN-NeerjaNeural");
  });

  it("keeps a single-language line as one segment", () => {
    expect(splitByLanguage("Everything is ready")).toHaveLength(1);
  });
});
