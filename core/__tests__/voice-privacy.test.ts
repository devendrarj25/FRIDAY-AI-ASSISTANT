import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  preferences,
  sanitizeWavDays,
} from "../../src/lib/friday/preferences";
import {
  keepUtteranceWavs,
  setKeepUtteranceWavs,
  setUtteranceWavDays,
  utteranceWavDays,
} from "../../src/lib/friday/voice-hearing";
import { describeVoiceDelete } from "../../src/lib/friday/voice-profile";

/* eslint-disable @typescript-eslint/no-require-imports */
const paths = require("../../electron/friday-paths.cjs") as {
  setRoot: (dir: string | null) => string | null;
};
const privacy = require("../../electron/voice-privacy.cjs") as {
  hasConsent: () => boolean;
  grantConsent: () => { ok: boolean; reason?: string; consent?: { givenAt: number } };
  pruneWavs: (r?: { keep: boolean; days: number }) => { removed: number; count: number };
  setRetention: (r: { keep: boolean; days: number }) => { ok: boolean; removed: number };
  readRetention: () => { keep: boolean; days: number };
  status: () => {
    consent: { given: boolean; givenAt: number };
    enrolment: { samples: number; profile: boolean };
    wavs: { count: number };
    retention: { keep: boolean; days: number };
  };
  deleteAll: () => Promise<{
    ok: boolean;
    removed: { samples: number; profile: boolean; wavs: number; consent: boolean };
    left: string[];
  }>;
  wavsDir: () => string;
  useForTests: (deps: Record<string, unknown>) => void;
};
const enroll = require("../../electron/voice-enroll.cjs") as {
  saveSample: (input: Record<string, unknown>) => { ok: boolean; reason?: string };
  build: () => Promise<{ ok: boolean; reason?: string }>;
  status: () => { counts: { total: number } };
  samplesDir: () => string;
  useForTests: (deps: Record<string, unknown>) => void;
};

const DAY = 86_400_000;
const FIXED_NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function wav(ms = 1000, amp = 0.3, rate = 16000): Uint8Array {
  const count = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + count * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + count * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) {
    buf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * amp * 32767),
      44 + i * 2,
    );
  }
  return new Uint8Array(buf);
}

const calls: Record<string, unknown>[] = [];
const fakeWake = {
  async workerCall(payload: Record<string, unknown>) {
    calls.push(payload);
    if (payload["op"] === "enroll_build")
      return {
        result: { ok: true, profile: { t: [1] }, summary: { built: true }, skipped: [] },
        generation: 1,
      };
    return { result: { ok: true }, generation: 1 };
  },
};
const fakeSafe = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text: string) =>
    Buffer.from(`ENC:${Buffer.from(text).toString("base64")}`),
  decryptStringAsync: async (buf: Buffer) => ({
    result: Buffer.from(buf.toString().replace("ENC:", ""), "base64").toString(),
    shouldReEncrypt: false,
  }),
};

let root = "";
const sample = (id = "wake-1-1") => ({
  id,
  kind: "wake",
  promptId: "wake-1",
  text: "Friday",
  language: "en",
  wavBytes: wav(),
});

function keepClip(name: string, ageDays: number): string {
  const dir = privacy.wavsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from("RIFFxxxx"));
  const when = new Date(FIXED_NOW - ageDays * DAY);
  fs.utimesSync(file, when, when);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-privacy-"));
  paths.setRoot(root);
  calls.length = 0;
  enroll.useForTests({ wake: fakeWake, safeStorage: fakeSafe });
  privacy.useForTests({ now: () => FIXED_NOW, enroll });
});

afterEach(() => {
  paths.setRoot(null);
  enroll.useForTests({});
  privacy.useForTests({});
  fs.rmSync(root, { recursive: true, force: true });
});

describe("consent before a voice sample is stored", () => {
  it("refuses to save a sample or build a voiceprint until the owner agrees", async () => {
    expect(privacy.hasConsent()).toBe(false);
    expect(enroll.saveSample(sample())).toMatchObject({ ok: false, reason: "consent-required" });
    expect(fs.existsSync(enroll.samplesDir())).toBe(false);
    expect(await enroll.build()).toMatchObject({ ok: false, reason: "consent-required" });
    expect(calls.find((c) => c["op"] === "enroll_build")).toBeUndefined();
  });

  it("stores a timestamp and a notice number and nothing else once the owner agrees", () => {
    const given = privacy.grantConsent();
    expect(given.ok).toBe(true);
    const file = path.join(root, "preferences", "voice-privacy", "consent.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["givenAt", "notice", "v"]);
    expect(record["givenAt"]).toBe(FIXED_NOW);
    expect(enroll.saveSample(sample()).ok).toBe(true);
    // agreeing again keeps the first time
    privacy.useForTests({ now: () => FIXED_NOW + DAY, enroll });
    expect(privacy.grantConsent().consent?.givenAt).toBe(FIXED_NOW);
  });

  it("does not count a damaged or older-notice record as agreement", () => {
    const file = path.join(root, "preferences", "voice-privacy", "consent.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(privacy.hasConsent()).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ v: 1, notice: 0, givenAt: FIXED_NOW }));
    expect(privacy.hasConsent()).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ v: 1, notice: 1, givenAt: "yesterday" }));
    expect(privacy.hasConsent()).toBe(false);
  });

  it("builds with the consent flag so the kernel agrees too", async () => {
    privacy.grantConsent();
    for (let i = 1; i <= 2; i += 1) enroll.saveSample(sample(`wake-${i}-1`));
    expect((await enroll.build()).ok).toBe(true);
    expect(calls.find((c) => c["op"] === "enroll_build")?.["consent"]).toBe(true);
  });

  it("agrees to nothing without a FRIDAY folder", () => {
    paths.setRoot(null);
    expect(privacy.grantConsent()).toMatchObject({ ok: false, reason: "no-root" });
    expect(privacy.hasConsent()).toBe(false);
  });
});

describe("kept utterance clips", () => {
  it("are off by default, in the stored settings and in what the speech worker is told", () => {
    expect(DEFAULT_PREFERENCES.voice.keepUtteranceWavs).toBe(false);
    expect(DEFAULT_PREFERENCES.voice.utteranceWavDays).toBe(7);
    expect(privacy.readRetention()).toEqual({ keep: false, days: 7 });
    setKeepUtteranceWavs(false);
    expect(keepUtteranceWavs()).toBe(false);
  });

  it("honour the stored setting, and an old stored shape reads off", () => {
    const { keepUtteranceWavs: _k, utteranceWavDays: _d, ...old } = DEFAULT_PREFERENCES.voice;
    preferences.importJson(JSON.stringify({ voice: old }));
    expect(keepUtteranceWavs()).toBe(false);
    setKeepUtteranceWavs(true);
    setUtteranceWavDays(30);
    expect(keepUtteranceWavs()).toBe(true);
    expect(utteranceWavDays()).toBe(30);
    preferences.importJson(JSON.stringify({ voice: { keepUtteranceWavs: "yes" } }));
    expect(keepUtteranceWavs()).toBe(false);
    setKeepUtteranceWavs(false);
  });

  it("clamp the days to 1 to 90", () => {
    expect([0, -4, 400, Number.NaN, "x", 2.6].map(sanitizeWavDays)).toEqual([1, 1, 90, 7, 7, 3]);
  });

  it("are removed after the retention days and kept before it", () => {
    const fresh = keepClip("00001-raw.wav", 2);
    const edge = keepClip("00002-raw.wav", 6.9);
    const stale = keepClip("00003-raw.wav", 8);
    const notWav = path.join(privacy.wavsDir(), "notes.txt");
    fs.writeFileSync(notWav, "x");
    const out = privacy.setRetention({ keep: true, days: 7 });
    expect(out.removed).toBe(1);
    expect(fs.existsSync(fresh) && fs.existsSync(edge)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(notWav)).toBe(true);
    expect(privacy.readRetention()).toEqual({ keep: true, days: 7 });
  });

  it("are all removed when retention is off, and at every start", () => {
    const a = keepClip("00001-raw.wav", 0);
    const b = keepClip("00002-raw.wav", 1);
    expect(privacy.pruneWavs().removed).toBe(2); // nothing stored yet reads off
    expect(fs.existsSync(a) || fs.existsSync(b)).toBe(false);
    keepClip("00003-raw.wav", 0);
    privacy.setRetention({ keep: true, days: 7 });
    expect(privacy.pruneWavs().removed).toBe(0);
    privacy.setRetention({ keep: false, days: 7 });
    expect(privacy.status().wavs.count).toBe(0);
  });
});

describe("Delete my voice data", () => {
  it("removes the enrolment files, the kept clips and the consent record from a throwaway folder", async () => {
    privacy.grantConsent();
    for (let i = 1; i <= 3; i += 1) enroll.saveSample(sample(`wake-${i}-1`));
    await enroll.build();
    const clip = keepClip("00001-raw.wav", 1);
    keepClip("00001-denoised.wav", 1);
    const enrolment = path.join(root, "preferences", "voice-enrollment");
    const consent = path.join(root, "preferences", "voice-privacy", "consent.json");
    expect(fs.existsSync(path.join(enrolment, "profile.enc"))).toBe(true);
    expect(fs.existsSync(path.join(enrolment, "samples", "wake-1-1.wav"))).toBe(true);
    expect(fs.existsSync(consent)).toBe(true);

    const out = await privacy.deleteAll();
    expect(out.ok).toBe(true);
    expect(out.left).toEqual([]);
    expect(out.removed).toEqual({ samples: 3, profile: true, wavs: 2, consent: true });
    expect(fs.existsSync(enrolment)).toBe(false);
    expect(fs.existsSync(clip)).toBe(false);
    expect(fs.existsSync(privacy.wavsDir())).toBe(false);
    expect(fs.existsSync(consent)).toBe(false);
    expect(privacy.hasConsent()).toBe(false);
    expect(calls.some((c) => c["op"] === "enroll_clear")).toBe(true);
    // agreement is needed again before anything is stored
    expect(enroll.saveSample(sample())).toMatchObject({ ok: false, reason: "consent-required" });
  });

  it("is safe to run when nothing is stored, and with no folder it says so", async () => {
    const empty = await privacy.deleteAll();
    expect(empty).toMatchObject({ ok: true, left: [] });
    expect(empty.removed).toEqual({ samples: 0, profile: false, wavs: 0, consent: false });
    paths.setRoot(null);
    expect(await privacy.deleteAll()).toMatchObject({ ok: false, reason: "no-root" });
  });

  it("leaves other debug reports alone", async () => {
    const report = path.join(root, "debug", "reports", "voice-hearing.jsonl");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, "{}\n");
    keepClip("00001-raw.wav", 0);
    await privacy.deleteAll();
    expect(fs.existsSync(report)).toBe(true);
  });

  it("is named by a plain result line, with anything left", () => {
    expect(
      describeVoiceDelete({
        ok: true,
        removed: { samples: 3, profile: true, wavs: 1, consent: true },
        left: [],
      }),
    ).toBe("Deleted 3 recordings, the voiceprint, 1 kept clip, the consent record.");
    expect(
      describeVoiceDelete({
        ok: false,
        removed: { samples: 0, profile: false, wavs: 2, consent: false },
        left: ["kept utterance clips"],
      }),
    ).toContain("Still there: kept utterance clips.");
    expect(describeVoiceDelete(null)).toContain("could not be deleted");
  });
});

describe("the wiring", () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
  const channels = [
    ["voice-privacy:status", "voicePrivacyStatus"],
    ["voice-privacy:consent", "voicePrivacyConsent"],
    ["voice-privacy:set-retention", "voicePrivacySetRetention"],
    ["voice-privacy:delete-all", "voicePrivacyDeleteAll"],
  ] as const;

  it("reaches the window through main, the preload allowlist and the budget table", () => {
    const main = read("electron/main.cjs");
    const preload = read("electron/preload.cjs");
    const table = read("electron/ipc-budget-table.cjs");
    const types = read("src/lib/friday/desktop.ts");
    for (const [channel, method] of channels) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
      expect(preload).toContain(`${method}:`);
      expect(preload).toContain(`"${channel}"`);
      expect(table).toContain(`"${channel}": "quick"`);
      expect(types).toContain(`${method}?:`);
    }
    expect(main).toContain('id: "voice-privacy-prune"');
  });

  it("is shown in Settings with the three controls", () => {
    const ui = read("src/components/friday/settings/VoicePrivacy.tsx");
    const host = read("src/components/friday/settings/VoiceEnrollment.tsx");
    expect(host).toContain("<VoicePrivacy");
    expect(host).toContain("!consented");
    expect(ui).toContain("I agree: allow FRIDAY to store my voice samples");
    expect(ui).toContain("Keep my spoken clips for diagnostics");
    expect(ui).toContain("Delete my voice data");
    expect(ui).toContain("Click again to delete");
  });
});
