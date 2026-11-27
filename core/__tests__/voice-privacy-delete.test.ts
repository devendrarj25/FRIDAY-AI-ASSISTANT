/**
 * "Delete voice data" (the voiceprint clear handler): the voiceprint and every audio cache FRIDAY keeps under the
 * FRIDAY folder, plus FRIDAY's own temp clips, go in one call that says how many files went. Only files FRIDAY
 * names that way (16 hex and an audio extension, or 40 hex and mp3 or wav in the reply cache) are removed; a stranger's file, a link and a
 * folder that links out of the root are left alone; a second call removes nothing. A temp folder stands in for the
 * PC; no microphone.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);
const paths = req("../../electron/friday-paths.cjs") as {
  setRoot: (dir: string | null) => string | null;
  setFallbackRoot: (dir?: string) => string;
};
const privacy = req("../../electron/voice-privacy.cjs") as {
  clearVoiceData: () => {
    ok: boolean;
    removed: number;
    bytes: number;
    failed: number;
    enrolled: boolean;
  };
  useForTests: (deps: Record<string, unknown>) => void;
};

let tmp = "";
let root = "";
let sys = "";
let previousFallback = "";
let previousEnv: string | undefined;

const seed = (dir: string, name: string, body = "RIFFxxxx") => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(body));
  return file;
};
const HEX16 = "0123456789abcdef";
const HEX40 = "ab".repeat(20);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-voice-delete-"));
  root = path.join(tmp, "friday");
  sys = path.join(tmp, "system-temp");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sys, { recursive: true });
  previousFallback = paths.setFallbackRoot();
  paths.setFallbackRoot(path.join(tmp, "boot"));
  paths.setRoot(root);
  previousEnv = process.env["FRIDAY_ROOT"];
  process.env["FRIDAY_ROOT"] = root;
  privacy.useForTests({ tmpdir: () => sys });
});
afterEach(() => {
  privacy.useForTests({});
  paths.setRoot(null);
  paths.setFallbackRoot(previousFallback);
  if (previousEnv === undefined) delete process.env["FRIDAY_ROOT"];
  else process.env["FRIDAY_ROOT"] = previousEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("delete voice data clears the voiceprint and the audio caches", () => {
  it("removes the voiceprint, replies, raw clips, wake clips and system-voice clips, and counts them", () => {
    const mine = [
      seed(root, "voiceprint.json", "{}"),
      seed(path.join(root, "cache", "tts"), `${HEX40}.mp3`, "mp3-bytes"),
      seed(path.join(root, "cache", "stt-in"), `${HEX16}.webm`),
      seed(path.join(root, "cache", "stt-in"), `fedcba9876543210.wav`),
      seed(path.join(root, "cache", "wake-in"), `00112233445566ff.ogg`),
      seed(path.join(sys, "wake-in"), `aabbccddeeff0011.wav`),
      seed(path.join(sys, "friday-sapi"), `1122334455667788.wav`),
    ];
    const out = privacy.clearVoiceData();
    expect(out).toMatchObject({ ok: true, removed: mine.length, failed: 0, enrolled: false });
    expect(out.bytes).toBeGreaterThan(0);
    for (const file of mine) expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a stranger's file, a model file and a wrongly named clip untouched", () => {
    const strangers = [
      seed(path.join(root, "cache", "tts"), "notes.txt"),
      seed(path.join(root, "cache", "tts"), "aaaa.wav"),
      seed(path.join(root, "cache", "stt-in"), "holiday-photo.wav"),
      seed(path.join(root, "cache", "models"), "keep.bin"),
      seed(path.join(root, "memory"), "facts.json", "{}"),
      seed(path.join(sys, "wake-in"), "short.wav"),
      seed(path.join(sys, "friday-sapi"), "someone-elses.wav"),
      seed(sys, `${HEX16}.wav`),
      seed(path.join(root, "cache", "tts"), `${"a".repeat(39)}.wav`),
      seed(path.join(root, "cache", "tts"), `${"a".repeat(41)}.wav`),
      seed(path.join(root, "cache", "tts"), `${"AB".repeat(20)}.wav`),
      seed(path.join(root, "cache", "stt-in"), `${HEX40}.wav`),
      seed(path.join(root, "cache", "tts", "sub"), `${HEX40}.wav`),
    ];
    seed(path.join(root, "cache", "tts"), `${HEX40}.mp3`);
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(1);
    for (const file of strangers) expect(fs.existsSync(file)).toBe(true);
  });

  it("removes a local reply clip (40 lowercase hex and wav) from the reply cache and counts it", () => {
    const clip = seed(path.join(root, "cache", "tts"), `${HEX40}.wav`, "RIFFlocal-reply");
    const out = privacy.clearVoiceData();
    expect(out).toMatchObject({ ok: true, removed: 1, failed: 0 });
    expect(out.bytes).toBe("RIFFlocal-reply".length);
    expect(fs.existsSync(clip)).toBe(false);
    expect(privacy.clearVoiceData().removed).toBe(0);
  });

  it("leaves the target of a link named like a local reply clip intact and the link in place", () => {
    const outside = seed(path.join(tmp, "outside"), "precious.wav");
    const link = path.join(root, "cache", "tts", `${HEX40}.wav`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("does not throw and removes nothing when the reply cache folder is missing", () => {
    expect(privacy.clearVoiceData()).toMatchObject({ ok: true, removed: 0, failed: 0 });
  });

  it("never follows or removes a link, even one named like a FRIDAY clip", () => {
    const outside = seed(path.join(tmp, "outside"), "precious.wav");
    const link = path.join(root, "cache", "stt-in", `${HEX16}.wav`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return; // links need a privilege on some PCs: nothing to prove there
    }
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("does not reach a cache folder that links out of the FRIDAY folder", () => {
    const outsideDir = path.join(tmp, "elsewhere");
    const victim = seed(outsideDir, `${HEX16}.wav`);
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });
    try {
      fs.symlinkSync(outsideDir, path.join(root, "cache", "stt-in"), "junction");
    } catch {
      return;
    }
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("is idempotent: a second call removes nothing and still says ok", () => {
    seed(root, "voiceprint.json", "{}");
    seed(path.join(root, "cache", "tts"), `${HEX40}.mp3`);
    expect(privacy.clearVoiceData().removed).toBe(2);
    const again = privacy.clearVoiceData();
    expect(again).toMatchObject({ ok: true, removed: 0, bytes: 0, failed: 0 });
  });

  it("with no FRIDAY folder chosen it still clears the bootstrap cache and temp clips", () => {
    paths.setRoot(null);
    delete process.env["FRIDAY_ROOT"];
    const boot = path.join(tmp, "boot");
    const mine = [
      seed(path.join(boot, "cache", "tts"), `${HEX40}.mp3`),
      seed(path.join(boot, "cache", "stt-in"), `${HEX16}.ogg`),
      seed(path.join(sys, "wake-in"), `${HEX16}.webm`),
    ];
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(3);
    for (const file of mine) expect(fs.existsSync(file)).toBe(false);
  });

  it("reports the voiceprint it removed and that nothing is enrolled afterwards", () => {
    const print = seed(root, "voiceprint.json", "{}");
    const out = privacy.clearVoiceData();
    expect(out.removed).toBe(1);
    expect(out.enrolled).toBe(false);
    expect(fs.existsSync(print)).toBe(false);
  });
});

describe("the IPC handler uses it", () => {
  it("answers voice:voiceprint-clear with the privacy module's clear, not a bare voiceprint delete", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
    expect(main).toMatch(
      /ipcMain\.handle\("voice:voiceprint-clear",\s*\(\)\s*=>\s*voicePrivacy\.clearVoiceData\(\)\)/,
    );
  });
});
