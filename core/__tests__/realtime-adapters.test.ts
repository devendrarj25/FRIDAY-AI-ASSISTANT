import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realtimeFormat } from "../../src/lib/friday/voice-engine/audio-format";
import {
  PROVIDERS,
  routeVoice,
  UsageLedger,
  DEFAULT_CLOUD_SETTINGS,
} from "../../src/lib/friday/voice-engine/voice-provider-router";
import { startFakeWs, type FakeWs } from "./helpers/ws-fake-server";

const require_ = createRequire(import.meta.url);
const { createGeminiAdapter, MAX_QUEUED_AUDIO } = require_(
  path.resolve(import.meta.dirname, "../../electron/realtime-adapters.cjs"),
);
const { createRealtimeSessions, CLOUD_REALTIME } = require_(
  path.resolve(import.meta.dirname, "../../electron/realtime-session.cjs"),
);

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("Gemini Live adapter", () => {
  const start = { type: "session.update", session: { instructions: "Be brief.", voice: "Puck" } };

  it("turns the session update into the setup message and sends it once", () => {
    const a = createGeminiAdapter({ model: "gemini-live-x" });
    const [setup] = a.encode(start);
    expect(setup).toEqual({
      setup: {
        model: "models/gemini-live-x",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "Be brief." }] },
      },
    });
    expect(a.encode(start)).toEqual([]);
    expect(
      createGeminiAdapter({ model: "m" }).encode({ type: "session.update", session: {} })[0].setup
        .generationConfig.speechConfig,
    ).toBeUndefined();
  });

  it("holds audio until the provider is ready, then releases it in order with the 16 kHz mime", () => {
    const a = createGeminiAdapter({ model: "m" });
    a.encode(start);
    expect(a.encode({ type: "input_audio_buffer.append", audio: "AAA" })).toEqual([]);
    expect(a.encode({ type: "input_audio_buffer.append", audio: "BBB" })).toEqual([]);
    const ready = a.decode({ setupComplete: {} });
    expect(ready.events).toEqual([{ type: "session.created" }]);
    expect(
      ready.replies.map(
        (r: { realtimeInput: { audio: { data: string } } }) => r.realtimeInput.audio.data,
      ),
    ).toEqual(["AAA", "BBB"]);
    expect(ready.replies[0].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(
      a.encode({ type: "input_audio_buffer.append", audio: "CCC" })[0].realtimeInput.audio.data,
    ).toBe("CCC");
    expect(a.decode({ setupComplete: {} }).events).toEqual([]);
  });

  it("bounds the audio held before ready", () => {
    const a = createGeminiAdapter({ model: "m" });
    for (let i = 0; i < MAX_QUEUED_AUDIO + 20; i += 1)
      a.encode({ type: "input_audio_buffer.append", audio: String(i) });
    expect(a.decode({ setupComplete: {} }).replies).toHaveLength(MAX_QUEUED_AUDIO);
  });

  it("sends nothing for commit, respond, cancel and truncate, which Gemini does by itself", () => {
    const a = createGeminiAdapter({ model: "m" });
    for (const type of [
      "input_audio_buffer.commit",
      "response.create",
      "response.cancel",
      "conversation.item.truncate",
      "unknown",
    ]) {
      expect(a.encode({ type })).toEqual([]);
    }
  });

  it("turns a model turn into created, audio, transcript and done events", () => {
    const a = createGeminiAdapter({ model: "m" });
    a.decode({ setupComplete: {} });
    const first = a.decode({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: "QQ==", mimeType: "audio/pcm;rate=24000" } },
            { text: "ignored" },
          ],
        },
        outputTranscription: { text: "Hello" },
      },
    });
    expect(first.events).toEqual([
      { type: "response.created" },
      { type: "response.audio.delta", delta: "QQ==" },
      { type: "response.audio_transcript.delta", delta: "Hello" },
    ]);
    const second = a.decode({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "Qg==" } }] } },
    });
    expect(second.events).toEqual([{ type: "response.audio.delta", delta: "Qg==" }]);
    expect(a.decode({ serverContent: { turnComplete: true } }).events).toEqual([
      { type: "response.done" },
    ]);
    expect(
      a.decode({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "Qw==" } }] } } })
        .events[0],
    ).toEqual({ type: "response.created" });
  });

  it("reports an interruption as speech over the answer and accumulates what was heard", () => {
    const a = createGeminiAdapter({ model: "m" });
    expect(a.decode({ serverContent: { interrupted: true } }).events).toEqual([
      { type: "input_audio_buffer.speech_started" },
    ]);
    a.decode({ serverContent: { inputTranscription: { text: "ruk " } } });
    const heard = a.decode({ serverContent: { inputTranscription: { text: "jao" } } });
    expect(heard.events).toEqual([
      { type: "conversation.item.input_audio_transcription.completed", transcript: "ruk jao" },
    ]);
    a.decode({ serverContent: { turnComplete: true } });
    expect(
      a.decode({ serverContent: { inputTranscription: { text: "naya" } } }).events[0],
    ).toMatchObject({ transcript: "naya" });
  });

  it("ignores junk and passes an error through", () => {
    const a = createGeminiAdapter({ model: "m" });
    expect(a.decode(null)).toEqual({ events: [], replies: [] });
    expect(a.decode({ usageMetadata: {} })).toEqual({ events: [], replies: [] });
    expect(a.decode({ error: { message: "quota" } }).events).toEqual([
      { type: "error", error: { message: "quota" } },
    ]);
  });
});

describe("provider table", () => {
  it("lists openai, xai and gemini with their fixed hosts", () => {
    expect(Object.keys(CLOUD_REALTIME).sort()).toEqual(["gemini", "openai", "xai"]);
    expect(CLOUD_REALTIME.xai.url("grok-x")).toBe("wss://api.x.ai/v1/realtime?model=grok-x");
    expect(CLOUD_REALTIME.xai.headers("K")).toEqual({ Authorization: "Bearer K" });
    const url = CLOUD_REALTIME.gemini.url("m", "a b&c");
    expect(url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=a%20b%26c",
    );
    expect(CLOUD_REALTIME.gemini.headers("K")).toEqual({});
  });

  it("uses 16 kHz in and 24 kHz out for Gemini and 24 kHz both ways elsewhere", () => {
    expect(realtimeFormat("gemini")).toEqual({ inputRate: 16000, outputRate: 24000 });
    expect(realtimeFormat("openai")).toEqual({ inputRate: 24000, outputRate: 24000 });
    expect(realtimeFormat("unknown")).toEqual({ inputRate: 24000, outputRate: 24000 });
  });

  it("treats xAI realtime as paid like OpenAI and Gemini as not paid by default", () => {
    expect(PROVIDERS.find((p) => p.id === "xai")?.needs).toContain("realtime-audio");
    const settings = {
      ...DEFAULT_CLOUD_SETTINGS,
      cloudEnabled: true,
      allowedProviders: ["xai", "gemini"],
      keyPresent: { xai: true, gemini: true },
      dailyRequests: 5,
      monthlyRequests: 5,
      monthlyAudioMinutes: 5,
    };
    const request = {
      need: "realtime-audio" as const,
      sensitive: false,
      privacyMode: false,
      billingAllowsPaid: false,
      online: true,
    };
    expect(routeVoice(request, settings, new UsageLedger()).provider?.id).toBe("gemini");
    const onlyXai = routeVoice(
      request,
      { ...settings, allowedProviders: ["xai"] },
      new UsageLedger(),
    );
    expect(onlyXai.active).toBe("none");
    expect(onlyXai.refused.find((r) => r.id === "xai")?.why).toMatch(/paid/);
  });
});

describe("through the real pipe", () => {
  let server: FakeWs | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("opens Gemini with the key in the address, translates in both directions, and never leaks the key", async () => {
    server = await startFakeWs();
    const requested: string[] = [];
    class Redirect extends WebSocket {
      constructor(url: string, options?: unknown) {
        requested.push(url);
        super(server!.url, options as never);
      }
    }
    const sessions = createRealtimeSessions({ WebSocketImpl: Redirect });
    const events: { type: string; delta?: string }[] = [];
    const out = sessions.startCloud("g", "gemini", "gemini-live-x", "KEY123", {
      onEvent: (e: { type: string }) => events.push(e),
    });
    expect(out).toMatchObject({
      ok: true,
      provider: "gemini",
      host: "generativelanguage.googleapis.com",
    });
    expect(requested[0]).toContain("?key=KEY123");
    await until(
      () => sessions.send("g", { type: "session.update", session: { instructions: "hi" } }).ok,
    );
    await until(() => server!.received.length >= 1);
    expect(JSON.parse(server!.received[0]!).setup.model).toBe("models/gemini-live-x");
    sessions.send("g", { type: "input_audio_buffer.append", audio: "AAAA" });
    server.send(JSON.stringify({ setupComplete: {} }));
    await until(() => server!.received.length >= 2);
    expect(JSON.parse(server!.received[1]!).realtimeInput.audio.mimeType).toBe(
      "audio/pcm;rate=16000",
    );
    server.send(
      JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: "QQ==" } }] } },
      }),
    );
    await until(() => events.some((e) => e.type === "response.audio.delta"));
    expect(events.map((e) => e.type)).toEqual([
      "session.created",
      "response.created",
      "response.audio.delta",
    ]);
    sessions.close("g");
  });

  it("reads JSON delivered in a binary frame, in order", async () => {
    class FakeSocket extends EventTarget {
      readyState = 1;
      sent: string[] = [];
      send(text: string) {
        this.sent.push(text);
      }
      close() {}
    }
    const made: FakeSocket[] = [];
    const sessions = createRealtimeSessions({
      WebSocketImpl: class extends FakeSocket {
        constructor() {
          super();
          made.push(this as FakeSocket);
        }
      },
    });
    const events: { type: string }[] = [];
    sessions.startCloud("g", "gemini", "m", "K", {
      onEvent: (e: { type: string }) => events.push(e),
    });
    const frame = (value: unknown) =>
      Object.assign(new Event("message"), { data: new Blob([JSON.stringify(value)]) });
    const socket = made[0]!;
    socket.dispatchEvent(frame({ setupComplete: {} }));
    socket.dispatchEvent(frame({ serverContent: { turnComplete: true } }));
    socket.dispatchEvent(Object.assign(new Event("message"), { data: new Blob(["not json"]) }));
    await until(() => events.length >= 2);
    expect(events.map((e) => e.type)).toEqual(["session.created", "response.done"]);
  });
});
