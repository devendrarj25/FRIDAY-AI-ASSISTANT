import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const stream = require_(path.resolve(import.meta.dirname, "../../electron/sarvam-stream.cjs"));
const {
  createSarvamStreams,
  buildSttUrl,
  buildTtsSession,
  parseSttEvent,
  parseTtsEvent,
  classifyClose,
  cleanKeyterms,
} = stream;

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  binaryType = "";
  constructor(
    public url: string,
    public options: { headers?: Record<string, string> },
  ) {
    FakeSocket.last = this;
  }
  addEventListener(name: string, fn: (e: unknown) => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code, reason: "" });
  }
  emit(name: string, event: unknown = {}) {
    for (const fn of this.listeners[name] ?? []) fn(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  receive(json: unknown) {
    this.emit("message", { data: JSON.stringify(json) });
  }
}

const allowed = { ok: true, key: "sk-secret-123", cloud: {} };
const rig = (gate: () => unknown = () => allowed) =>
  createSarvamStreams({
    WebSocketImpl: FakeSocket,
    gate,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
  });
const handlers = () => {
  const log: unknown[] = [];
  return {
    log,
    h: {
      onOpen: () => log.push("open"),
      onEvent: (e: unknown) => log.push(e),
      onClose: (e: unknown) => log.push({ close: e }),
    },
  };
};

describe("Sarvam realtime speech-to-text address", () => {
  it("builds the documented endpoint with the safe defaults", () => {
    const out = buildSttUrl({});
    expect(out.ok).toBe(true);
    const url = new URL(out.url);
    expect(url.origin + url.pathname).toBe("wss://api.sarvam.ai/speech-to-text-realtime/ws");
    expect(url.searchParams.get("language_code")).toBe("auto");
    expect(url.searchParams.get("model")).toBe("saaras:v4");
    expect(url.searchParams.get("stream_type")).toBe("fast");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("endpointing")).toBe("vad");
    expect(url.searchParams.get("mode")).toBe("codemix");
  });

  it("refuses a sample rate, model or language the provider does not offer", () => {
    expect(buildSttUrl({ sampleRate: 48000 }).ok).toBe(false);
    expect(buildSttUrl({ model: "saaras:v9" }).ok).toBe(false);
    expect(buildSttUrl({ language: "xx-YY" }).ok).toBe(false);
    expect(buildSttUrl({ streamType: "turbo" }).ok).toBe(false);
  });

  it("sends keyterms only to saaras:v4, at most 50, each within 64 characters", () => {
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
    const v4 = new URL(buildSttUrl({ keyterms: [...many, "x".repeat(65)] }).url);
    expect(JSON.parse(v4.searchParams.get("keyterms")!)).toHaveLength(50);
    const v3 = new URL(buildSttUrl({ model: "saaras:v3-realtime", keyterms: ["FRIDAY"] }).url);
    expect(v3.searchParams.has("keyterms")).toBe(false);
    expect(cleanKeyterms(["a", "a", " ", "b"])).toEqual(["a", "b"]);
  });

  it("only takes silence settings inside a sensible range", () => {
    expect(
      new URL(buildSttUrl({ silenceMs: 700 }).url).searchParams.get("silence_duration_ms"),
    ).toBe("700");
    expect(new URL(buildSttUrl({ silenceMs: 5 }).url).searchParams.has("silence_duration_ms")).toBe(
      false,
    );
  });
});

describe("Sarvam realtime speech-to-text events", () => {
  it("normalises partial and final transcripts with their language", () => {
    expect(
      parseSttEvent({ event: "transcript.partial", text: " नमस्ते ", language: "hi-IN" }),
    ).toEqual({
      type: "partial",
      text: "नमस्ते",
      language: "hi-IN",
    });
    expect(
      parseSttEvent({ event: "transcript.final", text: "open chrome", language_confidence: 0.9 }),
    ).toEqual({
      type: "final",
      text: "open chrome",
      languageConfidence: 0.9,
    });
  });

  it("reads voice activity, the billed seconds and errors, and ignores the rest", () => {
    expect(parseSttEvent({ event: "vad.speech_start" })).toEqual({ type: "speech-start" });
    expect(parseSttEvent({ event: "vad.speech_end" })).toEqual({ type: "speech-end" });
    expect(parseSttEvent({ event: "session.end", audio_duration_s: 12.5 })).toEqual({
      type: "end",
      audioSeconds: 12.5,
    });
    expect(
      parseSttEvent({ event: "error", code: 4000, is_fatal: true, message: "bad model" }),
    ).toEqual({
      type: "error",
      code: 4000,
      fatal: true,
      message: "bad model",
    });
    expect(parseSttEvent({ event: "something.new" })).toBeNull();
    expect(parseSttEvent(null)).toBeNull();
  });

  it("says which close codes are worth a retry", () => {
    expect(classifyClose(1003).retry).toBe(false);
    expect(classifyClose(4000).retry).toBe(false);
    expect(classifyClose(1008).retry).toBe(true);
    expect(classifyClose(1011).retry).toBe(true);
    expect(classifyClose(1000).retry).toBe(false);
  });
});

describe("Sarvam streaming text-to-speech", () => {
  it("builds the persistent socket and config, pinning the voice", () => {
    const out = buildTtsSession({ speaker: "aparna_hi_customer", language: "hi-IN" });
    expect(out.ok).toBe(true);
    expect(out.url).toBe(
      "wss://api.sarvam.ai/text-to-speech/ws?model=bulbul%3Av4-flash&send_completion_event=true",
    );
    expect(out.config).toEqual({
      type: "config",
      data: {
        model: "bulbul:v4-flash",
        language_code: "hi-IN",
        speaker: "aparna_hi_customer",
        speech_sample_rate: "24000",
        output_audio_codec: "mp3",
      },
    });
  });

  it("never leaves the voice to a provider default, and rejects bad options", () => {
    expect(buildTtsSession({ language: "hi-IN" }).ok).toBe(false);
    expect(buildTtsSession({ speaker: "Not Valid!", language: "hi-IN" }).ok).toBe(false);
    expect(buildTtsSession({ speaker: "anushka", language: "fr-FR" }).ok).toBe(false);
    expect(buildTtsSession({ speaker: "anushka", language: "hi-IN", sampleRate: 44100 }).ok).toBe(
      false,
    );
    expect(
      buildTtsSession({ speaker: "anushka", language: "hi-IN", pace: 9 }).config.data.pace,
    ).toBe(2);
  });

  it("normalises audio, completion and error frames", () => {
    expect(
      parseTtsEvent({
        type: "audio",
        data: { audio: "QUJD", content_type: "audio/mp3", request_id: "r1" },
      }),
    ).toEqual({
      type: "audio",
      audioBase64: "QUJD",
      mime: "audio/mp3",
      requestId: "r1",
    });
    expect(parseTtsEvent({ type: "event", data: { event_type: "final" } })).toEqual({
      type: "complete",
    });
    expect(parseTtsEvent({ type: "error", data: { message: "no", code: 429 } })).toEqual({
      type: "error",
      code: 429,
      message: "no",
    });
    expect(parseTtsEvent({ type: "audio", data: {} })).toBeNull();
  });
});

describe("Sarvam stream sessions", () => {
  it("opens the speech-to-text socket with the key in a header, never in the address", () => {
    const { h } = handlers();
    const streams = rig();
    expect(streams.open("s1", "stt", {}, h)).toEqual({ ok: true, id: "s1", kind: "stt" });
    expect(FakeSocket.last!.options.headers).toEqual({ "api-subscription-key": "sk-secret-123" });
    expect(FakeSocket.last!.url).not.toContain("sk-secret-123");
  });

  it("sends the text-to-speech config as soon as the socket opens", () => {
    const { h, log } = handlers();
    const streams = rig();
    streams.open("t1", "tts", { speaker: "aparna_hi_customer", language: "hi-IN" }, h);
    FakeSocket.last!.open();
    expect(log).toContain("open");
    expect(JSON.parse(FakeSocket.last!.sent[0]!).type).toBe("config");
  });

  it("maps renderer messages to the provider's wire frames and refuses the rest", () => {
    const { h } = handlers();
    const streams = rig();
    streams.open("s1", "stt", {}, h);
    FakeSocket.last!.open();
    expect(streams.send("s1", { type: "audio", audioBase64: "AAAA" }).ok).toBe(true);
    expect(streams.send("s1", { type: "end" }).ok).toBe(true);
    expect(streams.send("s1", { type: "text", text: "hi" }).ok).toBe(false);
    expect(streams.send("s1", { type: "audio", audioBase64: "" }).ok).toBe(false);
    expect(FakeSocket.last!.sent.map((s) => JSON.parse(s))).toEqual([
      { event: "audio_input", audio: "AAAA" },
      { event: "end" },
    ]);

    const tts = rig();
    tts.open("t1", "tts", { speaker: "anushka", language: "hi-IN" }, handlers().h);
    FakeSocket.last!.open();
    expect(tts.send("t1", { type: "text", text: "नमस्ते" }).ok).toBe(true);
    expect(tts.send("t1", { type: "flush" }).ok).toBe(true);
    expect(tts.send("t1", { type: "text", text: "x".repeat(2501) }).ok).toBe(false);
    expect(tts.send("t1", { type: "audio", audioBase64: "AA" }).ok).toBe(false);
    expect(FakeSocket.last!.sent.slice(1).map((s) => JSON.parse(s))).toEqual([
      { type: "text", data: { text: "नमस्ते" } },
      { type: "flush" },
    ]);
  });

  it("passes parsed events up and reports a close with its retry verdict, scrubbed of the key", () => {
    const { h, log } = handlers();
    const streams = rig();
    streams.open("s1", "stt", {}, h);
    FakeSocket.last!.open();
    FakeSocket.last!.receive({ event: "transcript.partial", text: "hello" });
    FakeSocket.last!.emit("close", { code: 1011, reason: "server said sk-secret-123 failed" });
    expect(log).toContainEqual({ type: "partial", text: "hello" });
    const closed = log.find((e) => typeof e === "object" && e && "close" in e) as {
      close: { retry: boolean; reason: string };
    };
    expect(closed.close.retry).toBe(true);
    expect(closed.close.reason).not.toContain("sk-secret-123");
    expect(streams.count()).toBe(0);
  });

  it("is refused when the cloud gate refuses, and caps the open streams", () => {
    const refused = rig(() => ({ ok: false, error: "Keep speech on this PC is on" }));
    expect(refused.open("s1", "stt", {}, handlers().h)).toEqual({
      ok: false,
      error: "Keep speech on this PC is on",
    });
    const streams = rig();
    for (let i = 0; i < 4; i += 1)
      expect(streams.open(`s${i}`, "stt", {}, handlers().h).ok).toBe(true);
    expect(streams.open("s9", "stt", {}, handlers().h).ok).toBe(false);
    expect(streams.open("s0", "stt", {}, handlers().h).ok).toBe(false); // already open
    expect(streams.open("bad id!", "stt", {}, handlers().h).ok).toBe(false);
    expect(streams.open("k", "video", {}, handlers().h).ok).toBe(false);
  });
});
