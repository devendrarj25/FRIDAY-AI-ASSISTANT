/**
 * The spoken-reply cache (`<FRIDAY folder>/cache/tts`) is bounded: a total size and a file count, oldest FRIDAY-named
 * file first, never a link or a stranger's file, a folder that links out of the root is skipped. A temp folder stands
 * in for the PC; no microphone and no network.
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
  boundTtsCache: (options?: { maxBytes?: number; maxFiles?: number; keep?: string[] }) => {
    removed: number;
    freed: number;
    kept: number;
    keptBytes: number;
  };
  TTS_CACHE_MAX_BYTES: number;
  TTS_CACHE_MAX_FILES: number;
  useForTests: (deps: Record<string, unknown>) => void;
};

let tmp = "";
let root = "";
let ttsDir = "";
let previousFallback = "";
let previousEnv: string | undefined;
const clock = 1_700_000_000;

const hex40 = (n: number) => n.toString(16).padStart(40, "0");
/** One cache file whose age is its position: a lower `age` rank is older. */
const seed = (name: string, bytes: number, rank: number, dir = ttsDir) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  const when = clock + rank;
  fs.utimesSync(file, when, when);
  return file;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tts-bound-"));
  root = path.join(tmp, "friday");
  ttsDir = path.join(root, "cache", "tts");
  fs.mkdirSync(root, { recursive: true });
  previousFallback = paths.setFallbackRoot();
  paths.setFallbackRoot(path.join(tmp, "boot"));
  paths.setRoot(root);
  previousEnv = process.env["FRIDAY_ROOT"];
  process.env["FRIDAY_ROOT"] = root;
  privacy.useForTests({ tmpdir: () => path.join(tmp, "system-temp") });
});
afterEach(() => {
  privacy.useForTests({});
  paths.setRoot(null);
  paths.setFallbackRoot(previousFallback);
  if (previousEnv === undefined) delete process.env["FRIDAY_ROOT"];
  else process.env["FRIDAY_ROOT"] = previousEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the spoken-reply cache is bounded", () => {
  it("names the limits as constants: 200 MB and 2000 files", () => {
    expect(privacy.TTS_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(privacy.TTS_CACHE_MAX_FILES).toBe(2000);
  });

  it("removes the oldest files first until the size fits, and keeps the newest", () => {
    const files = [1, 2, 3, 4, 5].map((n) => seed(`${hex40(n)}.mp3`, 100, n));
    const out = privacy.boundTtsCache({ maxBytes: 250, maxFiles: 100 });
    expect(out).toMatchObject({ removed: 3, freed: 300, kept: 2, keptBytes: 200 });
    expect(files.map((f) => fs.existsSync(f))).toEqual([false, false, false, true, true]);
  });

  it("removes the oldest files first until the count fits", () => {
    const files = [1, 2, 3, 4].map((n) => seed(`${hex40(n)}.mp3`, 10, n));
    const out = privacy.boundTtsCache({ maxBytes: 1_000_000, maxFiles: 3 });
    expect(out).toMatchObject({ removed: 1, kept: 3 });
    expect(files.map((f) => fs.existsSync(f))).toEqual([false, true, true, true]);
  });

  it("removes nothing while the folder is inside both limits, and is safe to run twice", () => {
    for (const n of [1, 2, 3]) seed(`${hex40(n)}.mp3`, 10, n);
    expect(privacy.boundTtsCache({ maxBytes: 1000, maxFiles: 10 }).removed).toBe(0);
    seed(`${hex40(9)}.mp3`, 10, 9);
    expect(privacy.boundTtsCache({ maxBytes: 30, maxFiles: 10 }).removed).toBe(1);
    expect(privacy.boundTtsCache({ maxBytes: 30, maxFiles: 10 }).removed).toBe(0);
  });

  it("counts and removes only FRIDAY-named files: 16 hex and audio, or 40 hex and mp3 or wav", () => {
    const mine = [
      seed(`${hex40(1)}.mp3`, 10, 1),
      seed("0123456789abcdef.wav", 10, 2),
      seed("fedcba9876543210.ogg", 10, 3),
      seed(`${hex40(4)}.wav`, 10, 4),
    ];
    const strangers = [
      seed("notes.txt", 5000, 0),
      seed("aaaa.wav", 5000, 0),
      seed(`${hex40(5)}.txt`, 5000, 0),
      // Upper-case 16 hex is not a FRIDAY name; a different digit run so a case-insensitive disk cannot make it the same file as a real one.
      seed("0123456789ABCDEE.wav", 5000, 0),
    ];
    const out = privacy.boundTtsCache({ maxBytes: 20, maxFiles: 100 });
    expect(out).toMatchObject({ removed: 2, kept: 2, keptBytes: 20 });
    expect(mine.map((f) => fs.existsSync(f))).toEqual([false, false, true, true]);
    for (const file of strangers) expect(fs.existsSync(file)).toBe(true);
  });

  it("never follows or removes a link, even one named like a FRIDAY file", () => {
    const outside = seed("precious.mp3", 100, 0, path.join(tmp, "outside"));
    seed(`${hex40(1)}.mp3`, 10, 1);
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(ttsDir, `${hex40(2)}.mp3`));
    } catch {
      linked = false;
    }
    const out = privacy.boundTtsCache({ maxBytes: 0, maxFiles: 0 });
    expect(out.removed).toBe(1);
    expect(fs.existsSync(outside)).toBe(true);
    if (linked)
      expect(fs.lstatSync(path.join(ttsDir, `${hex40(2)}.mp3`)).isSymbolicLink()).toBe(true);
  });

  it("skips a cache folder that links out of the root", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    const victim = seed(`${hex40(1)}.mp3`, 10, 1, elsewhere);
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });
    try {
      fs.symlinkSync(elsewhere, ttsDir, "dir");
    } catch {
      return;
    }
    expect(privacy.boundTtsCache({ maxBytes: 0, maxFiles: 0 }).removed).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("keeps the file just written even when it alone is over the limit", () => {
    seed(`${hex40(1)}.mp3`, 100, 1);
    const fresh = seed(`${hex40(2)}.mp3`, 500, 2);
    const out = privacy.boundTtsCache({ maxBytes: 50, maxFiles: 5, keep: [fresh] });
    expect(out.removed).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("does nothing, and does not throw, when there is no cache folder", () => {
    expect(privacy.boundTtsCache({ maxBytes: 1, maxFiles: 1 })).toMatchObject({
      removed: 0,
      kept: 0,
    });
  });

  it("uses the default limits when none are given", () => {
    for (const n of [1, 2, 3]) seed(`${hex40(n)}.mp3`, 10, n);
    expect(privacy.boundTtsCache().removed).toBe(0);
  });
});

describe("the writers run the bound at the first use and after each write", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../electron/neural-voice.cjs"),
    "utf8",
  );
  it("neural-voice trims the cache before the first read and after a cloud or local write", () => {
    expect(source).toMatch(/boundTtsCache/);
    expect((source.match(/trimTtsCache\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
