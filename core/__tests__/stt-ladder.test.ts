/**
 * Live speech picks the first local engine the kernel says is actually ready.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  liveSttFromStatus,
  planLiveStt,
  rememberLiveStt,
  sttLadderDoctor,
  type LiveSttFacts,
} from "../../src/lib/friday/speech-stt";

const root = path.resolve(__dirname, "../..");

function choose(patch: LiveSttFacts, lang = "en-IN", privacy = false) {
  return liveSttFromStatus(
    {
      available: false,
      ready: false,
      engine: "faster-whisper",
      reason: null,
      moonshineReady: false,
      windowsSpeech: false,
      ...patch,
    },
    lang,
    privacy,
  );
}

describe("live speech ladder", () => {
  it("walks every local step and stays off the cloud in privacy mode", () => {
    expect(choose({ available: true, ready: true, engine: "faster-whisper" }).engine).toBe(
      "faster-whisper",
    );
    expect(choose({ reason: "downloading 40%", downloading: true }).status).toBe("downloading");
    expect(choose({ reason: "blocked: example.invalid" }).engine).toBe("faster-whisper");
    expect(choose({ reason: "blocked: example.invalid" }).status).toBe("blocked");
    const moonshine = choose({
      moonshineReady: true,
      reason: "faster-whisper is not installed yet.",
    });
    expect(moonshine).toMatchObject({
      engine: "moonshine",
      status: "ready",
      local: true,
    });
    expect(moonshine.reason).toContain("Moonshine");
    const windows = choose(
      { windowsSpeech: true, reason: "faster-whisper is not installed yet." },
      "hi-IN",
    );
    expect(windows.engine).toBe("windows-speech");
    expect(windows.reason).toContain("Windows speech");
    const none = choose({ reason: "faster-whisper is not installed yet." }, "hi-IN");
    expect(none.engine).toBe("none");
    expect(none.reason).toContain("Install a local speech model");
    const privateMoonshine = choose({ moonshineReady: true }, "en-US", true);
    expect(privateMoonshine.local).toBe(true);
    expect(privateMoonshine.engine).not.toBe("cloud");
    expect(
      planLiveStt({
        whisperReady: false,
        weightsReady: false,
        english: false,
        moonshineReady: true,
        windowsSpeech: false,
        privacy: true,
      }).engine,
    ).toBe("none");
    rememberLiveStt(moonshine);
    expect(sttLadderDoctor(moonshine)).toMatchObject({
      id: "stt:ladder",
      status: "Ready",
      detail: expect.stringContaining("moonshine:"),
    });
  });

  it("reads the kernel flags instead of hard-coding them off", () => {
    const source = fs.readFileSync(path.join(root, "src/lib/friday/assistant-mode.ts"), "utf8");
    expect(source).toContain("liveSttFromStatus(");
    expect(source).not.toContain("moonshineReady: false");
    expect(source).not.toContain("windowsSpeech: false");
    const kernel = fs.readFileSync(path.join(root, "kernel/stt.py"), "utf8");
    expect(kernel.indexOf("if args.probe:")).toBeLessThan(
      kernel.indexOf("if _import_whisper() is None:"),
    );
    expect(kernel).toContain('"moonshineReady": moonshine_model_dir() is not None');
    expect(kernel).toContain('"windowsSpeech": windows_speech_ready()');
  });
});
