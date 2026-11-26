/**
 * Speech-to-text cloud wiring in main and preload: a missing `localOnly` reaches stt.cjs unchanged (so it fails closed),
 * and the cloud transcriber is opened only through the same cloud-voice gate as the other cloud speech
 * (consent, allowed provider, privacy mode, saved key). The gate knows sarvam and azure-speech only, so a connected
 * openai or groq key never opens an upload until the owner decides.
 */
import fs from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const voiceCloud = req("../../electron/voice-cloud.cjs");

const read = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CLOUD = { id: "openai", model: "gpt-4o-transcribe", base: "https://example.test", key: "k" };

function cloudOnlyPc() {
  const upload = vi.fn(async () => ({ ok: true, text: "uploaded", engine: "cloud:openai" }));
  stt.useForTests({
    python: async () => null,
    run: async () => ({ ok: false, stdout: "", stderr: "no python" }),
    cloudEngine: () => CLOUD,
    cloudTranscribe: upload,
  });
  return { upload };
}

/** The gate exactly as main wires it: the statement is cut out of main.cjs and run against a real voice-cloud gate. */
function mainGate(prefs: Record<string, unknown>, secrets: Record<string, string>) {
  const source = read("electron/main.cjs");
  const statement = source.match(/stt\.setCloudGate\([\s\S]*?\);\n/)?.[0];
  expect(statement, "main.cjs wires stt.setCloudGate").toBeTruthy();
  const voiceCloudApi = voiceCloud.createVoiceCloud({
    fetchImpl: vi.fn(),
    getSecret: (id: string) => secrets[id] || "",
    prefs: () => prefs,
  });
  let wired: ((provider: string) => unknown) | null = null;
  new Function("stt", "voiceCloudApi", statement as string)(
    { setCloudGate: (gate: (provider: string) => unknown) => (wired = gate) },
    voiceCloudApi,
  );
  expect(typeof wired).toBe("function");
  return wired as unknown as (provider: string) => { ok?: boolean };
}

const OPEN_PREFS = {
  cloudVoice: {
    cloudEnabled: true,
    allowedProviders: ["openai", "groq", "sarvam", "azure-speech"],
  },
};
const ALL_KEYS = { "voice-sarvam": "s", "voice-azure-speech": "a", "voice-openai": "o" };

beforeEach(() => stt.useForTests());
afterEach(() => {
  vi.restoreAllMocks();
  stt.setCloudGate(null);
  stt.useForTests();
});

describe("main passes localOnly through unchanged (V-S3)", () => {
  it("the status handler no longer turns a missing value into false", () => {
    const src = read("electron/main.cjs");
    const handler = src.match(/ipcMain\.handle\("voice:stt-status"[\s\S]*?\n\}\);/)?.[0] || "";
    expect(handler).toMatch(/localOnly: options\.localOnly,/);
    expect(handler).not.toMatch(/Boolean\(options\.localOnly\)/);
  });

  it("the preload sends a boolean as it is and a missing value as missing", () => {
    const src = read("electron/preload.cjs");
    expect(src).not.toMatch(/localOnly: Boolean\(localOnly\)/);
    const calls: unknown[][] = [];
    const exposed: Record<string, any> = {};
    const load = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld: (_n: string, api: object) => Object.assign(exposed, api),
          },
          ipcRenderer: {
            invoke: (...args: unknown[]) => calls.push(args),
            on: () => {},
            removeListener: () => {},
          },
          webUtils: {},
        };
      }
      return load.call(this, request, ...rest);
    };
    try {
      const file = req.resolve("../../electron/preload.cjs");
      delete req.cache[file];
      req(file);
    } finally {
      (Module as any)._load = load;
    }
    exposed["sttStatus"](true);
    exposed["sttStatus"](true, false, true);
    exposed["sttStatus"](false, true);
    const sent = calls.map((call) => (call[1] as { localOnly?: boolean }).localOnly);
    expect(sent).toEqual([undefined, false, true]);
  });
});

describe("the cloud transcriber opens only through the cloud-voice gate", () => {
  it("transcribe with no localOnly and only an openai key makes zero network calls", async () => {
    const { upload } = cloudOnlyPc();
    const net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    stt.setCloudGate(mainGate(OPEN_PREFS, ALL_KEYS));
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64) });
    expect(out).toMatchObject({ ok: false });
    expect(upload).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
  });

  it("status never reports a cloud engine ready while the gate refuses, even with consent and a key", async () => {
    cloudOnlyPc();
    stt.setCloudGate(mainGate(OPEN_PREFS, ALL_KEYS));
    const value = await stt.status(true, { localOnly: false });
    expect(String(value.engine)).not.toMatch(/^cloud:/);
    expect(value.ready).not.toBe(true);
  });

  it("an explicit cloud request is still refused for openai and groq by the real gate", async () => {
    const { upload } = cloudOnlyPc();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    stt.setCloudGate(mainGate(OPEN_PREFS, ALL_KEYS));
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64), localOnly: false });
    expect(out).toMatchObject({ ok: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it("the wired gate answers only ok:true or ok:false and never carries the key", () => {
    const gate = mainGate(OPEN_PREFS, ALL_KEYS);
    for (const provider of ["sarvam", "azure-speech"]) {
      const answer = gate(provider);
      expect(answer.ok).toBe(true);
      expect(JSON.stringify(answer)).not.toMatch(/"(key|cloud)"/);
    }
    for (const provider of ["openai", "groq", "", "nope"]) expect(gate(provider).ok).toBe(false);
  });

  it("privacy mode, a missing consent and a missing key close the gate for every provider", () => {
    for (const provider of ["sarvam", "azure-speech", "openai", "groq"]) {
      expect(mainGate({ ...OPEN_PREFS, privacyMode: true }, ALL_KEYS)(provider).ok).toBe(false);
      expect(mainGate({ cloudVoice: { cloudEnabled: false } }, ALL_KEYS)(provider).ok).toBe(false);
      expect(mainGate(OPEN_PREFS, {})(provider).ok).toBe(false);
    }
  });

  it("with a gate that says yes and localOnly:false, a cloud call is allowed", async () => {
    const { upload } = cloudOnlyPc();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    stt.setCloudGate(() => ({ ok: true }));
    const out = await stt.transcribe({ audioBytes: new Uint8Array(64), localOnly: false });
    expect(out).toMatchObject({ ok: true, text: "uploaded" });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
