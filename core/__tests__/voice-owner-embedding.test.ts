/**
 * The owner's speaker-model centroid reaches the streaming ear only through the main process: main reads the stored
 * voiceprint itself and adds it to the worker's stream-open request. It never rides the renderer payload and never
 * comes back in a renderer-bound reply. A missing or wrong-size voiceprint adds nothing (the speaker stays
 * "unknown"), and no approval code reads the speaker tag. Fake worker, fake store, no model, no microphone.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");

const vec = (n: number, base = 0.25) => Array.from({ length: n }, (_v, i) => base + i / 1000);

type Ears = { ownerEmbedding?: number[]; vad?: string };
type Payload = { op?: string; ears?: Ears; [key: string]: unknown };

function rig(owner: () => Promise<unknown> | unknown) {
  const calls: Payload[] = [];
  const session = { alive: true, loaded: true, pending: new Map() };
  const ear = stt.createStreamEar({
    gate: stt.createTurnGate(),
    getWorker: () => session,
    request: vi.fn(async (_s: unknown, payload: Payload) => {
      calls.push(payload);
      return { ok: true, op: payload.op, engine: "fake" };
    }),
    ownerEmbedding: async () => owner(),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  return { ear, calls };
}

const opened = (calls: Payload[]) => calls.find((c) => c.op === "stream-open") as Payload;

describe("owner embedding on stream-open", () => {
  it("adds the stored centroid to the worker request and never to the reply", async () => {
    const stored = vec(256);
    const { ear, calls } = rig(() => stored);
    const reply = await ear.open({ streamEngine: "nemotron", streamId: "a" });
    expect(reply.ok).toBe(true);
    expect(opened(calls).ears?.ownerEmbedding).toEqual(stored);
    expect(JSON.stringify(reply)).not.toContain("ownerEmbedding");
    expect(JSON.stringify(reply)).not.toContain(String(stored[10]));
  });

  it("ignores a vector the renderer sends and uses only the stored one", async () => {
    const { ear, calls } = rig(() => null);
    await ear.open({
      streamEngine: "nemotron",
      ears: { ownerEmbedding: vec(128, 9), vad: "energy" },
    });
    const ears = opened(calls).ears ?? {};
    expect(ears.ownerEmbedding).toBeUndefined();
    expect(ears.vad).toBe("energy");
    const second = rig(() => vec(128, 1));
    await second.ear.open({ streamEngine: "nemotron", ears: { ownerEmbedding: vec(128, 9) } });
    expect(opened(second.calls).ears?.ownerEmbedding?.[0]).toBe(1);
  });

  it("adds nothing when no voiceprint is stored, the size is wrong, or the store fails", async () => {
    for (const owner of [
      () => null,
      () => vec(63),
      () => vec(1025),
      () => "x",
      () => {
        throw new Error("safe store");
      },
    ]) {
      const { ear, calls } = rig(owner);
      const reply = await ear.open({ streamEngine: "nemotron" });
      expect(reply.ok).toBe(true);
      expect(opened(calls).ears).toBeUndefined();
    }
  });
});

describe("voiceprint.loadOwnerEmbedding", () => {
  it("returns a stored 64..1024 vector and drops any other size or shape", async () => {
    const secretBox = req("../../electron/secret-box.cjs");
    const voiceprint = req("../../electron/voiceprint.cjs");
    let text = JSON.stringify(vec(256));
    const spies = [
      vi.spyOn(secretBox, "available").mockResolvedValue(true),
      vi.spyOn(secretBox, "readRaw").mockReturnValue({ enc: "x" }),
      vi.spyOn(secretBox, "decryptText").mockImplementation(async () => ({ ok: true, text })),
    ];
    process.env["FRIDAY_ROOT"] = "/tmp/friday-owner-embedding-test";
    try {
      expect(await voiceprint.loadOwnerEmbedding()).toHaveLength(256);
      text = JSON.stringify(vec(16));
      expect(await voiceprint.loadOwnerEmbedding()).toBeNull();
      text = JSON.stringify([...vec(64), "1"]);
      expect(await voiceprint.loadOwnerEmbedding()).toBeNull();
      text = "not json";
      expect(await voiceprint.loadOwnerEmbedding()).toBeNull();
    } finally {
      delete process.env["FRIDAY_ROOT"];
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("the voiceprint stays private and never approves", () => {
  it("is read only inside main (stt.cjs, voice-enroll.cjs), never by the renderer, preload or approval code", () => {
    expect(read("electron/stt.cjs")).toMatch(/loadOwnerEmbedding\(\)/);
    for (const file of ["electron/preload.cjs", "src/lib/friday/desktop.ts"]) {
      expect(read(file)).not.toMatch(/ownerEmbedding|loadOwnerEmbedding/);
    }
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
      });
    const renderer = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".gen.ts"));
    for (const file of renderer) expect(read(file), file).not.toMatch(/ownerEmbedding/);
  });

  it("no approval, confirmation or safety code reads the speaker tag or the embedding", () => {
    const approval = [
      "electron/approvals.cjs",
      "electron/confirm.cjs",
      "src/lib/friday/self/governance.ts",
      "kernel/risk.py",
    ];
    for (const file of approval) {
      let text: string;
      try {
        text = read(file);
      } catch {
        continue;
      }
      expect(text, file).not.toMatch(/ownerEmbedding|speaker_tag|speakerTag|loadOwnerEmbedding/);
    }
    expect(read("electron/voiceprint.cjs")).toMatch(/never approves an action/);
  });

  it("the enrolment keeps the centroid in the safe store and out of the reply", () => {
    const text = read("electron/voice-enroll.cjs");
    expect(text).toMatch(/voiceprint\.save\(result\.ownerEmbedding\)/);
    expect(text).not.toMatch(/return \{[^}]*ownerEmbedding/);
  });
});
