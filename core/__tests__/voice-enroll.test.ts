import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-require-imports */
const paths = require("../../electron/friday-paths.cjs") as {
  setRoot: (dir: string | null) => string | null;
};
const enroll = require("../../electron/voice-enroll.cjs") as {
  inspectWav: (bytes: Uint8Array) => { ok: boolean; reason?: string; durationMs?: number };
  saveSample: (input: Record<string, unknown>) => {
    ok: boolean;
    reason?: string;
    counts?: { total: number };
  };
  deleteSample: (id: string) => { ok: boolean };
  readSample: (id: string) => { ok: boolean };
  status: () => {
    counts: { total: number; wakeTakes: number; speechClips: number };
    profile: { built: boolean; stale: boolean };
    samples: { id: string }[];
  };
  build: () => Promise<{ ok: boolean; reason?: string; summary?: unknown }>;
  score: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  forget: () => Promise<{ ok: boolean; profile: { built: boolean } }>;
  clearRecordings: () => { ok: boolean };
  samplesDir: () => string;
  useForTests: (deps: Record<string, unknown>) => void;
};

/** A 16 kHz mono PCM16 WAV of a sine at `amp` (0..1) lasting `ms`. */
function wav(ms: number, amp: number, rate = 16000): Uint8Array {
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

let root = "";
const calls: Record<string, unknown>[] = [];
let generation = 1;
let held: unknown = null;

const fakeWake = {
  async workerCall(payload: Record<string, unknown>) {
    calls.push(payload);
    const op = payload["op"];
    if (op === "enroll_summary")
      return { result: { ok: true, summary: { built: held !== null } }, generation };
    if (op === "enroll_load") {
      held = payload["profile"];
      return { result: { ok: true }, generation };
    }
    if (op === "enroll_clear") {
      held = null;
      return { result: { ok: true }, generation };
    }
    if (op === "enroll_build") {
      held = { secretTemplate: [1, 2, 3] };
      return {
        result: {
          ok: true,
          profile: held,
          summary: { built: true, speaker: { ready: true } },
          skipped: [],
        },
        generation,
      };
    }
    if (op === "enroll_score") {
      return {
        result: {
          ok: true,
          engine: "dsp-mfcc-v1",
          evidence: "test",
          speaker: {
            enrolled: held !== null,
            similarity: 0.9,
            match: true,
            reason: "speaker-match",
          },
          wake: { ready: true, matched: false, reason: "personal-wake-no-match" },
        },
        generation,
      };
    }
    return { result: { ok: false }, generation };
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-enroll-"));
  paths.setRoot(root);
  calls.length = 0;
  generation = 1;
  held = null;
  enroll.useForTests({ wake: fakeWake, safeStorage: fakeSafe });
});

afterEach(() => {
  paths.setRoot(null);
  enroll.useForTests({});
  fs.rmSync(root, { recursive: true, force: true });
});

const good = (ms = 2000) => wav(ms, 0.3);

describe("what a sample must be", () => {
  it("accepts a clear 16 kHz mono recording and says why it refuses the rest", () => {
    expect(enroll.inspectWav(good()).ok).toBe(true);
    expect(enroll.inspectWav(good(200)).reason).toBe("too-short");
    expect(enroll.inspectWav(good(16000)).reason).toBe("too-long");
    expect(enroll.inspectWav(wav(2000, 0.001)).reason).toBe("too-quiet");
    expect(enroll.inspectWav(wav(2000, 1.0)).reason).toBe("clipped");
    expect(enroll.inspectWav(wav(2000, 0.3, 44100)).reason).toBe("wrong-format");
    expect(enroll.inspectWav(new Uint8Array([1, 2, 3])).reason).toBe("not-a-wav");
  });
});

describe("recordings on disk", () => {
  it("keeps a WAV and its text, counts them, plays them back and deletes them", () => {
    const saved = enroll.saveSample({
      id: "wake-1-1",
      kind: "wake",
      promptId: "wake-1",
      text: "Friday",
      language: "en",
      wavBytes: good(1000),
    });
    expect(saved.ok).toBe(true);
    enroll.saveSample({
      id: "en-1-1",
      kind: "speech",
      promptId: "en-1",
      text: "Hello there",
      language: "en",
      wavBytes: good(3000),
    });
    const dir = enroll.samplesDir();
    expect(fs.existsSync(path.join(dir, "wake-1-1.wav"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "en-1-1.txt"), "utf8").trim()).toBe("Hello there");
    expect(enroll.status().counts).toMatchObject({ total: 2, wakeTakes: 1, speechClips: 1 });
    expect(enroll.readSample("wake-1-1").ok).toBe(true);
    // the same prompt recorded again replaces it, it does not add a second one
    enroll.saveSample({
      id: "wake-1-1",
      kind: "wake",
      promptId: "wake-1",
      text: "Friday",
      language: "en",
      wavBytes: good(1200),
    });
    expect(enroll.status().counts.total).toBe(2);
    expect(enroll.deleteSample("wake-1-1").ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "wake-1-1.wav"))).toBe(false);
    expect(enroll.status().counts.total).toBe(1);
  });

  it("refuses a bad id, a bad kind and a path trick", () => {
    expect(enroll.saveSample({ id: "../evil", kind: "wake", wavBytes: good() }).reason).toBe(
      "bad-id",
    );
    expect(enroll.saveSample({ id: "ok-id-1", kind: "other", wavBytes: good() }).reason).toBe(
      "bad-kind",
    );
    expect(enroll.readSample("../../etc/passwd").ok).toBe(false);
    expect(enroll.deleteSample("..\\x").ok).toBe(false);
  });

  it("refuses to save without a FRIDAY folder", () => {
    paths.setRoot(null);
    expect(enroll.saveSample({ id: "wake-1-1", kind: "wake", wavBytes: good() }).reason).toBe(
      "no-root",
    );
  });
});

describe("the profile", () => {
  const record = () => {
    for (let i = 1; i <= 6; i += 1) {
      enroll.saveSample({
        id: `wake-${i}-1`,
        kind: "wake",
        promptId: `wake-${i}`,
        text: "Friday",
        language: "en",
        wavBytes: good(900),
      });
    }
  };

  it("is built by the worker and stored encrypted: no template is readable on disk", async () => {
    record();
    const built = await enroll.build();
    expect(built.ok).toBe(true);
    const file = path.join(root, "preferences", "voice-enrollment", "profile.enc");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("secretTemplate");
    expect(JSON.parse(raw).enc).toBeTruthy();
    expect(enroll.status().profile).toMatchObject({ built: true, stale: false });
    expect(calls.find((c) => c["op"] === "enroll_build")?.["samples"]).toHaveLength(6);
  });

  it("is marked stale when a recording changes afterwards", async () => {
    record();
    await enroll.build();
    await new Promise((r) => setTimeout(r, 15));
    enroll.deleteSample("wake-1-1");
    expect(enroll.status().profile.stale).toBe(true);
  });

  it("refuses to build without the Windows safe store or without samples", async () => {
    expect((await enroll.build()).reason).toBe("no-samples");
    record();
    enroll.useForTests({
      wake: fakeWake,
      safeStorage: { isAsyncEncryptionAvailable: async () => false },
    });
    expect((await enroll.build()).reason).toBe("no-safe-store");
  });

  it("scores nothing and starts no worker while no voice is saved", async () => {
    const answer = await enroll.score({ audioBytes: good(), mime: "audio/wav" });
    expect(answer).toMatchObject({ ok: true, enrolled: false });
    expect(calls).toEqual([]);
  });

  it("loads the profile into a restarted worker before it scores", async () => {
    record();
    await enroll.build();
    calls.length = 0;
    generation = 2; // the worker was restarted: its memory is empty
    held = null;
    const answer = await enroll.score({ audioBytes: good(), mime: "audio/wav" });
    expect(answer).toMatchObject({ ok: true, enrolled: true });
    expect(calls.map((c) => c["op"])).toEqual(["enroll_summary", "enroll_load", "enroll_score"]);
    // the same worker keeps it: no second load
    calls.length = 0;
    await enroll.score({ audioBytes: good(), mime: "audio/wav" });
    expect(calls.map((c) => c["op"])).toEqual(["enroll_summary", "enroll_score"]);
  });

  it("deletes the recordings but keeps the profile, and forgets everything on request", async () => {
    record();
    await enroll.build();
    enroll.clearRecordings();
    expect(enroll.status().counts.total).toBe(0);
    expect(enroll.status().profile.built).toBe(true);
    const gone = await enroll.forget();
    expect(gone.profile.built).toBe(false);
    expect(fs.existsSync(path.join(root, "preferences", "voice-enrollment"))).toBe(false);
    expect(calls.some((c) => c["op"] === "enroll_clear")).toBe(true);
  });
});
