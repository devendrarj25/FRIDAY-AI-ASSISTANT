import { describe, expect, it } from "vitest";
import {
  applyServerEvent,
  clientEvents,
  newSession,
  pcm16Base64,
  realtimeGate,
  shouldBargeIn,
  type GateInput,
  type RealtimeServerEvent,
} from "../../src/lib/friday/realtime-protocol";

const play = (events: RealtimeServerEvent[]) => events.reduce(applyServerEvent, newSession());

describe("realtime session protocol", () => {
  it("walks a whole turn: listen, hear, think, speak, listen again", () => {
    const states: string[] = [];
    let session = newSession();
    for (const event of [
      { type: "session.created" },
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "kal ka mausam",
      },
      { type: "response.created" },
      { type: "response.output_item.added", item: { id: "item_1" } },
      { type: "response.audio.delta", delta: "AAA=" },
      { type: "response.audio_transcript.delta", delta: "Kal " },
      { type: "response.audio_transcript.delta", delta: "dhoop hai." },
      { type: "response.audio.delta", delta: "BBB=" },
      { type: "response.done" },
    ] as RealtimeServerEvent[]) {
      session = applyServerEvent(session, event);
      states.push(session.state);
    }
    expect(states).toEqual([
      "listening",
      "listening",
      "thinking",
      "thinking",
      "thinking",
      "thinking",
      "speaking",
      "speaking",
      "speaking",
      "speaking",
      "listening",
    ]);
    expect(session.heardText).toBe("kal ka mausam");
    expect(session.assistantText).toBe("Kal dhoop hai.");
    expect(session.audio).toEqual(["AAA=", "BBB="]);
    expect(session.itemId).toBe("item_1");
  });

  it("recognises speech over the answer as a barge-in and cuts the item where it was heard", () => {
    const speaking = play([
      { type: "session.created" },
      { type: "response.created" },
      { type: "response.output_item.added", item: { id: "item_9" } },
      { type: "response.audio.delta", delta: "AAA=" },
    ]);
    const over = { type: "input_audio_buffer.speech_started" };
    expect(shouldBargeIn(speaking, over)).toBe(true);
    expect(shouldBargeIn(newSession(), over)).toBe(false);
    const cuts = clientEvents.bargeIn({ ...speaking, playedMs: 812.4 });
    expect(cuts).toEqual([
      { type: "response.cancel" },
      {
        type: "conversation.item.truncate",
        item_id: "item_9",
        content_index: 0,
        audio_end_ms: 812,
      },
    ]);
    expect(clientEvents.bargeIn(newSession())).toEqual([{ type: "response.cancel" }]);
  });

  it("ignores events it does not know and stops on an error", () => {
    const base = play([{ type: "session.created" }]);
    expect(applyServerEvent(base, { type: "something.new" })).toBe(base);
    const failed = applyServerEvent(base, { type: "error", error: { message: "invalid key" } });
    expect(failed).toMatchObject({ state: "failed", error: "invalid key" });
    expect(applyServerEvent(failed, { type: "response.audio.delta", delta: "x" })).toBe(failed);
  });

  it("starts a session with FRIDAY's own endpointing unless the server's is asked for", () => {
    expect(clientEvents.start({ instructions: "Be brief." }).session.turn_detection).toBeNull();
    expect(
      clientEvents.start({ instructions: "x", serverVad: true }).session.turn_detection,
    ).toEqual({ type: "server_vad" });
    expect(
      clientEvents.start({ instructions: "x".repeat(9000) }).session.instructions,
    ).toHaveLength(4000);
  });

  it("turns float samples into little-endian PCM16 base64", () => {
    const base64 = pcm16Base64(new Float32Array([0, 1, -1, 2]));
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});

describe("realtime gate", () => {
  const cloud: GateInput = {
    engine: "cloud-realtime",
    url: "wss://api.example.com/v1/realtime",
    surface: "auto",
    paused: false,
    paidAccess: true,
    cloudKey: true,
    privacyMode: false,
    sessionConsent: true,
    halted: false,
  };
  const local: GateInput = {
    ...cloud,
    engine: "local-speech-to-speech",
    url: "ws://127.0.0.1:8123/v1/realtime",
  };

  it("lets a fully allowed cloud session and a loopback local one start", () => {
    expect(realtimeGate(cloud)).toEqual({ allowed: true, reasons: [] });
    expect(
      realtimeGate({
        ...local,
        paidAccess: false,
        cloudKey: false,
        privacyMode: true,
        sessionConsent: false,
      }).allowed,
    ).toBe(true);
  });

  it("refuses each missing condition for the cloud engine, with its reason", () => {
    const why = (patch: Partial<GateInput>) =>
      realtimeGate({ ...cloud, ...patch }).reasons.join(" | ");
    expect(why({ paidAccess: false })).toMatch(/paid access/);
    expect(why({ cloudKey: false })).toMatch(/no provider key/);
    expect(why({ privacyMode: true })).toMatch(/stays here/);
    expect(why({ sessionConsent: false })).toMatch(/have not said yes/);
    expect(why({ url: "ws://api.example.com/x" })).toMatch(/wss/);
    expect(why({ url: "wss://localhost/x" })).toMatch(/local engine/);
  });

  it("refuses everything outside Auto mode, while paused, or after Stop everything", () => {
    for (const patch of [{ surface: "manual" as const }, { paused: true }, { halted: true }]) {
      expect(realtimeGate({ ...cloud, ...patch }).allowed).toBe(false);
      expect(realtimeGate({ ...local, ...patch }).allowed).toBe(false);
    }
  });

  it("will not call a remote address a local engine", () => {
    const out = realtimeGate({ ...local, url: "ws://10.0.0.5:8123/v1/realtime" });
    expect(out.allowed).toBe(false);
    expect(out.reasons.join(" ")).toMatch(/on this PC/);
    expect(realtimeGate({ ...local, url: "ws://127.0.0.1.evil.com/x" }).allowed).toBe(false);
  });
});
