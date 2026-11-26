/**
 * The speech bridge in main trusts nothing the renderer sends: audio arrives as bytes only (a file path is refused,
 * never read), an audio clip has a size cap before anything is written to disk, and a missing `localOnly` means
 * "this PC only" (fail closed). A cloud transcriber must also pass the cloud-voice gate (consent, allowed provider,
 * privacy mode, billing) before one byte is uploaded, at the status check and again right before the upload.
 * No process, no model, no network, no microphone.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const read = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const MiB = 1024 * 1024;

const CLOUD = { id: "openai", model: "gpt-4o-transcribe", base: "https://example.test", key: "k" };

/** A PC with no local engine at all: only a connected cloud transcriber could answer. */
function cloudOnlyPc(overrides: Record<string, unknown> = {}) {
  const upload = vi.fn(async () => ({ ok: true, text: "uploaded", engine: "cloud:openai" }));
  stt.useForTests({
    python: async () => null,
    run: async () => ({ ok: false, stdout: "", stderr: "no python" }),
    cloudEngine: () => CLOUD,
    cloudTranscribe: upload,
    ...overrides,
  });
  return { upload };
}

beforeEach(() => stt.useForTests());
afterEach(() => {
  vi.restoreAllMocks();
  stt.useForTests();
});

describe("voice:transcribe takes bytes only (V-S2)", () => {
  it("answers a typed refusal for a path request and never reads the file", async () => {
    const file = join(tmpdir(), `friday-stt-guard-${process.pid}.wav`);
    fs.writeFileSync(file, Buffer.alloc(64));
    try {
      const reads = vi.spyOn(fs, "readFileSync");
      const out = await stt.transcribe({ path: file, localOnly: true });
      expect(out).toMatchObject({ ok: false, reason: "path-not-allowed" });
      expect(reads.mock.calls.some(([target]) => String(target) === file)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("refuses the path even when audio bytes ride along with it", async () => {
    const out = await stt.transcribe({
      path: "C:\\Users\\someone\\secret.wav",
      audioBytes: new Uint8Array(32),
      localOnly: true,
    });
    expect(out).toMatchObject({ ok: false, reason: "path-not-allowed" });
  });

  it("refuses a provisional path request too (the early read is not a way around it)", async () => {
    const out = await stt.transcribe({ path: "/etc/hosts", provisional: true, utteranceId: "p-1" });
    expect(out).toMatchObject({ ok: false, reason: "path-not-allowed" });
  });

  it("the source has no path branch left: a request path is never opened, read or typed as input", () => {
    const src = read("electron/stt.cjs");
    expect(src).not.toMatch(/(existsSync|readFileSync|statSync|createReadStream)\(\s*req\.path/);
    expect(src).not.toMatch(/path\?: string/);
    expect(src).toMatch(/reason: "path-not-allowed"/);
  });
});

describe("audio size caps (V-S7)", () => {
  it("a transcribe request over 12 MiB answers audio-too-large and writes nothing to disk", async () => {
    const writes = vi.spyOn(fs, "writeFileSync");
    const out = await stt.transcribe({ audioBytes: new Uint8Array(12 * MiB + 1), localOnly: true });
    expect(out).toMatchObject({ ok: false, reason: "audio-too-large" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("a base64 request over the cap is refused from its length, before it is decoded", async () => {
    const writes = vi.spyOn(fs, "writeFileSync");
    const fromBuffer = vi.spyOn(Buffer, "from");
    const audioBase64 = "A".repeat(Math.ceil(((12 * MiB + 4) * 4) / 3));
    const out = await stt.transcribe({ audioBase64, localOnly: true });
    expect(out).toMatchObject({ ok: false, reason: "audio-too-large" });
    expect(writes).not.toHaveBeenCalled();
    expect(fromBuffer.mock.calls.some(([value]) => value === audioBase64)).toBe(false);
  });

  it("a clip of exactly 12 MiB is inside the cap (the answer is not audio-too-large)", async () => {
    cloudOnlyPc({ cloudEngine: () => null });
    const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const out = await stt.transcribe({ audioBytes: new Uint8Array(12 * MiB), localOnly: true });
    expect(out.reason).not.toBe("audio-too-large");
    writes.mockRestore();
  });

  it("an end-of-turn score over 4 MiB is refused with audio-too-large and writes nothing", async () => {
    const writes = vi.spyOn(fs, "writeFileSync");
    const out = await stt.scoreTurn({ audioBytes: new Uint8Array(4 * MiB + 1) });
    expect(out).toEqual({ ok: true, ready: false, probability: null, reason: "audio-too-large" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("an empty score request still answers no-audio, as before", async () => {
    expect(await stt.scoreTurn({})).toEqual({
      ok: true,
      ready: false,
      probability: null,
      reason: "no-audio",
    });
  });

  it("the caps are named constants in one place", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/const MAX_TRANSCRIBE_BYTES = 12 \* 1024 \* 1024;/);
    expect(src).toMatch(/const MAX_SCORE_BYTES = 4 \* 1024 \* 1024;/);
  });
});

describe("local only is the default (V-S3)", () => {
  it("status without options never offers a cloud transcriber, even with a key and an open gate", async () => {
    cloudOnlyPc();
    stt.setCloudGate(() => ({ ok: true }));
    const value = await stt.status(true);
    expect(String(value.engine)).not.toMatch(/^cloud:/);
    expect(value.available).toBe(false);
  });

  it("an explicit localOnly:false with no gate wired is still closed", async () => {
    cloudOnlyPc();
    stt.setCloudGate(null);
    const value = await stt.status(true, { localOnly: false });
    expect(String(value.engine)).not.toMatch(/^cloud:/);
  });

  it("an explicit localOnly:false with the gate open offers the connected transcriber", async () => {
    cloudOnlyPc();
    const gate = vi.fn(() => ({ ok: true }));
    stt.setCloudGate(gate);
    const value = await stt.status(true, { localOnly: false });
    expect(value.engine).toBe("cloud:openai");
    expect(gate).toHaveBeenCalledWith("openai");
  });

  it("a gate that throws or answers anything but ok:true is closed", async () => {
    cloudOnlyPc();
    stt.setCloudGate(() => {
      throw new Error("prefs unreadable");
    });
    expect(String((await stt.status(true, { localOnly: false })).engine)).not.toMatch(/^cloud:/);
    stt.setCloudGate(() => ({ ok: "yes" }));
    expect(String((await stt.status(true, { localOnly: false })).engine)).not.toMatch(/^cloud:/);
    stt.setCloudGate(() => ({ ok: false, error: "privacy mode" }));
    expect(String((await stt.status(true, { localOnly: false })).engine)).not.toMatch(/^cloud:/);
  });

  it("transcribe with no localOnly never uploads on a cloud-only PC", async () => {
    const { upload } = cloudOnlyPc();
    stt.setCloudGate(() => ({ ok: true }));
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64) });
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("an explicit cloud request uploads once when the gate is open", async () => {
    const { upload } = cloudOnlyPc();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    stt.setCloudGate(() => ({ ok: true }));
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64), localOnly: false });
    expect(out).toMatchObject({ ok: true, text: "uploaded" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("the gate is asked again right before the upload: a consent revoked since the status check wins", async () => {
    const { upload } = cloudOnlyPc();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    let open = true;
    stt.setCloudGate(() => ({ ok: open }));
    expect((await stt.status(true, { localOnly: false })).engine).toBe("cloud:openai");
    open = false;
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64), localOnly: false });
    expect(out).toMatchObject({ ok: false, reason: "cloud-stt-not-allowed" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("the source defaults a missing localOnly to true on both paths", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/const localOnly = options\?\.localOnly !== false;/);
    expect(src).toMatch(/localOnly: req\.localOnly !== false/);
    expect(src).not.toMatch(/Boolean\(req\.localOnly\)/);
    expect(src).not.toMatch(/Boolean\(options\?\.localOnly\)/);
  });
});
