import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isHoldKey,
  normalizeListenStyle,
  PTT_GRACE_MS,
  PTT_TOGGLE_MAX_MS,
  pttActive,
  pttAdmits,
  pttPress,
  pttRelease,
  pttToggle,
  resetPtt,
} from "../../src/lib/friday/push-to-talk";

describe("push-to-talk gate", () => {
  beforeEach(() => resetPtt());

  it("keeps always-listening as the default and admits everything there", () => {
    expect(normalizeListenStyle(undefined)).toBe("always");
    expect(normalizeListenStyle("anything")).toBe("always");
    expect(normalizeListenStyle("push-to-talk")).toBe("push-to-talk");
    expect(pttAdmits("always", 1000)).toBe(true);
  });

  it("admits speech only while held, then for a short grace after release", () => {
    expect(pttAdmits("push-to-talk", 1000)).toBe(false);
    pttPress();
    expect(pttActive(1000)).toBe(true);
    expect(pttAdmits("push-to-talk", 1000)).toBe(true);
    pttRelease(5000);
    expect(pttAdmits("push-to-talk", 5000 + PTT_GRACE_MS)).toBe(true);
    expect(pttAdmits("push-to-talk", 5001 + PTT_GRACE_MS)).toBe(false);
  });

  it("toggles from the global shortcut and closes a forgotten toggle", () => {
    expect(pttToggle(0 + 10)).toBe(true);
    expect(pttAdmits("push-to-talk", 20)).toBe(true);
    expect(pttActive(10 + PTT_TOGGLE_MAX_MS)).toBe(false);
    resetPtt();
    pttToggle(100);
    expect(pttToggle(200)).toBe(false);
    expect(pttActive(300)).toBe(false);
  });

  it("uses Ctrl+Space so plain Space still types", () => {
    expect(isHoldKey({ code: "Space", ctrlKey: true })).toBe(true);
    expect(isHoldKey({ code: "Space", ctrlKey: false })).toBe(false);
    expect(isHoldKey({ key: "a", ctrlKey: true })).toBe(false);
  });
});

describe("push-to-talk wiring", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
  const stt = readFileSync("src/lib/friday/voice-stt.ts", "utf8");
  const main = readFileSync("electron/main.cjs", "utf8");

  it("refuses speech before a segment starts, so nothing is recorded or transcribed", () => {
    const gate = stt.indexOf("this.options.admit && !this.options.admit()");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(stt.indexOf("this.speaking = this.beginSegment()"));
    expect(mode).toContain("admit: () => pttAdmits(this.listenStyle())");
  });

  it("stays inside Auto mode: Manual never arms it and the key only works in Auto", () => {
    expect(mode).toMatch(/private enterAuto\(\) \{\s*this\.armPushToTalk\(\);/);
    expect(mode).toMatch(/private leaveAuto\(\) \{\s*this\.disarmPushToTalk\(\);/);
    expect(mode).toMatch(/holdToTalk\(down: boolean\) \{\s*if \(this\.state\.mode !== "auto"/);
  });

  it("treats a push-to-talk turn as addressed but still drops FRIDAY's own echo", () => {
    expect(mode).toContain('this.listenStyle() === "push-to-talk" && decision.tag !== "self"');
    expect(mode).toContain('decision.reason = "push-to-talk"');
  });

  it("registers the global toggle only on request and releases it on quit", () => {
    expect(main).toContain('ipcMain.handle("voice:ptt-shortcut"');
    expect(main).toContain('app.on("will-quit", () => setPttShortcut(false))');
    expect(main).not.toMatch(/globalShortcut\.register\([^)]*\)[^;]*;\s*\n\s*\/\/ always/);
    const prefs = readFileSync("src/lib/friday/preferences.ts", "utf8");
    expect(prefs).toContain('listenStyle: "always"');
  });
});
