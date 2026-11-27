/**
 * Windows' own microphone privacy answer, read in the main process: renderer micAccessStatus -> preload ->
 * voice:mic-access -> electron/voice-ipc.cjs. The renderer turns it into a fault with mic-faults.ts accessFault.
 * openMicPrivacySettings opens the one Settings page and nothing else. askForMediaAccess is macOS only and never called.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { MIC_PRIVACY_LINK, accessFault } from "../../src/lib/friday/mic-faults";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const budget = require_("../../electron/ipc-budget-table.cjs");
const voiceIpc = require_("../../electron/voice-ipc.cjs");

describe("mic access wiring", () => {
  it("has one handler, one preload entry and one quick budget row per channel", () => {
    const main = read("electron/main.cjs");
    const preload = read("electron/preload.cjs");
    for (const channel of ["voice:mic-access", "voice:open-mic-privacy"]) {
      expect(main.match(new RegExp(`ipcMain\\.handle\\("${channel}"`, "g"))).toHaveLength(1);
      expect(preload.match(new RegExp(channel, "g"))).toHaveLength(1);
      expect(budget.CHANNEL_CLASS[channel]).toBe("quick");
    }
    expect(preload).toMatch(/micAccessStatus: \(\) => ipcRenderer\.invoke\("voice:mic-access"\)/);
    expect(preload).toMatch(
      /openMicPrivacySettings: \(\) => ipcRenderer\.invoke\("voice:open-mic-privacy"\)/,
    );
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toMatch(/\bmicAccessStatus\?: \(\) => Promise</);
    expect(desktop).toMatch(/\bopenMicPrivacySettings\?: \(\) => Promise</);
  });

  it("never calls askForMediaAccess (macOS only)", () => {
    expect(read("electron/voice-ipc.cjs")).not.toMatch(/askForMediaAccess\s*\(/);
    expect(read("electron/main.cjs")).not.toMatch(/askForMediaAccess\s*\(/);
  });

  it("the exact link is the one the renderer shows", () => {
    expect(voiceIpc.MIC_PRIVACY_LINK).toBe(MIC_PRIVACY_LINK);
    expect(MIC_PRIVACY_LINK).toBe("ms-settings:privacy-microphone");
  });
});

describe("micAccessStatus", () => {
  const prefs = (status: unknown) => ({
    getMediaAccessStatus: (kind: string) => {
      if (kind !== "microphone") throw new Error("wrong kind");
      if (status instanceof Error) throw status;
      return status;
    },
  });

  it("maps the five answers and nothing else", () => {
    for (const s of ["granted", "denied", "restricted", "not-determined", "unknown"]) {
      expect(voiceIpc.micAccessStatus({ systemPreferences: prefs(s) })).toEqual({
        ok: true,
        status: s,
      });
    }
    for (const bad of ["yes", "", 1, null, undefined, {}]) {
      expect(voiceIpc.micAccessStatus({ systemPreferences: prefs(bad) })).toEqual({
        ok: true,
        status: "unknown",
      });
    }
  });

  it("answers unknown when the platform has no answer or the call throws", () => {
    expect(voiceIpc.micAccessStatus({ systemPreferences: {} })).toEqual({
      ok: true,
      status: "unknown",
    });
    expect(voiceIpc.micAccessStatus({ systemPreferences: null })).toEqual({
      ok: true,
      status: "unknown",
    });
    expect(voiceIpc.micAccessStatus({ systemPreferences: prefs(new Error("x")) })).toEqual({
      ok: true,
      status: "unknown",
    });
  });

  it("feeds accessFault: denied shows the settings link, granted shows none", () => {
    const denied = voiceIpc.micAccessStatus({ systemPreferences: prefs("denied") });
    expect(accessFault(denied.status)?.settingsLink).toBe(MIC_PRIVACY_LINK);
    const granted = voiceIpc.micAccessStatus({ systemPreferences: prefs("granted") });
    expect(accessFault(granted.status)).toBeNull();
  });
});

describe("openMicPrivacySettings", () => {
  const shellWith = () => {
    const opened: string[] = [];
    return { opened, shell: { openExternal: async (url: string) => void opened.push(url) } };
  };

  it("opens the exact Settings page when asked with nothing or with the exact string", async () => {
    const a = shellWith();
    expect(await voiceIpc.openMicPrivacySettings({ shell: a.shell })).toEqual({ ok: true });
    expect(await voiceIpc.openMicPrivacySettings({ shell: a.shell }, MIC_PRIVACY_LINK)).toEqual({
      ok: true,
    });
    expect(a.opened).toEqual([MIC_PRIVACY_LINK, MIC_PRIVACY_LINK]);
  });

  it("refuses every other value, look-alikes included, and opens nothing", async () => {
    const a = shellWith();
    const bad: unknown[] = [
      "ms-settings:privacy-camera",
      "ms-settings:privacy-microphone ",
      " ms-settings:privacy-microphone",
      "MS-SETTINGS:privacy-microphone",
      "ms-settings:privacy-microphone?x=1",
      "ms-settings:privacy-microphone#a",
      "ms-settings:privacy-microphone\n",
      "ms-settings:privacy-microphone\0",
      "ms-settings:privacy-microphones",
      "ms-settings://privacy-microphone",
      "ms-settings:privacy-micr0phone",
      "https://example.com",
      "file:///C:/Windows/System32/calc.exe",
      "calc.exe",
      "",
      0,
      false,
      null,
      {},
      ["ms-settings:privacy-microphone"],
      { toString: () => MIC_PRIVACY_LINK },
    ];
    for (const value of bad) {
      expect(await voiceIpc.openMicPrivacySettings({ shell: a.shell }, value)).toEqual({
        ok: false,
        error: "refused",
      });
    }
    expect(a.opened).toEqual([]);
  });

  it("answers a short code when the shell fails or is missing, and never throws", async () => {
    const failing = {
      openExternal: async () => {
        throw new Error("C:\\Users\\someone\\x failed");
      },
    };
    expect(await voiceIpc.openMicPrivacySettings({ shell: failing })).toEqual({
      ok: false,
      error: "open-failed",
    });
    expect(await voiceIpc.openMicPrivacySettings({ shell: null })).toEqual({
      ok: false,
      error: "open-failed",
    });
  });
});
