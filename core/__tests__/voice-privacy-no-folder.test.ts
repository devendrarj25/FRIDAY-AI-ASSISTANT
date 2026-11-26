/**
 * "Delete my voice data" with no FRIDAY folder chosen (G2): the wake-word clips go to the temp `wake-in` folder, the
 * raw clips and the cloud-voice replies to the bootstrap cache, so they must still be cleared. Only files FRIDAY names
 * that way (hex name, audio extension) go, never a link and never another program's file. No microphone.
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
  deleteAll: () => Promise<{
    ok: boolean;
    reason?: string;
    left: string[];
    cleared?: Record<string, number>;
  }>;
  status: () => { caches: { count: number } };
  useForTests: (deps: Record<string, unknown>) => void;
};

let tmp = "";
let boot = "";
let previousFallback = "";

const seed = (dir: string, name: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from("RIFFxxxx"));
  return file;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-privacy-nf-"));
  boot = path.join(tmp, "boot");
  previousFallback = paths.setFallbackRoot();
  paths.setFallbackRoot(boot);
  paths.setRoot(null);
  privacy.useForTests({ tmpdir: () => tmp });
});
afterEach(() => {
  privacy.useForTests({});
  paths.setFallbackRoot(previousFallback);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("delete my voice data with no FRIDAY folder", () => {
  it("clears FRIDAY's own temp wake clips, raw clips and spoken replies, and says the folder is missing", async () => {
    const mine = [
      seed(path.join(tmp, "wake-in"), "0123456789abcdef.webm"),
      seed(path.join(tmp, "wake-in"), "fedcba9876543210.wav"),
      seed(path.join(boot, "cache", "stt-in"), "00112233445566ff.ogg"),
      seed(path.join(boot, "cache", "tts"), `${"ab".repeat(20)}.mp3`),
      seed(path.join(tmp, "friday-sapi"), "eeee.wav"),
    ];
    const other = [
      seed(path.join(tmp, "wake-in"), "notes.txt"),
      seed(path.join(tmp, "wake-in"), "short.wav"),
      seed(path.join(boot, "cache", "stt-in"), "holiday-photo.wav"),
      seed(tmp, "0123456789abcdef.wav"),
    ];
    expect(privacy.status().caches.count).toBe(mine.length);
    const out = await privacy.deleteAll();
    expect(out).toMatchObject({ ok: false, reason: "no-root", left: [] });
    expect(out.cleared).toMatchObject({ replies: 1, rawClips: 1, wakeClips: 2, systemClips: 1 });
    for (const file of mine) expect(fs.existsSync(file)).toBe(false);
    for (const file of other) expect(fs.existsSync(file)).toBe(true);
  });

  it("never follows or removes a link, even one named like a FRIDAY clip", async () => {
    const outside = seed(path.join(tmp, "outside"), "precious.wav");
    const link = path.join(tmp, "wake-in", "0123456789abcdef.wav");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return; // links need a privilege on some PCs: nothing to prove there
    }
    await privacy.deleteAll();
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
