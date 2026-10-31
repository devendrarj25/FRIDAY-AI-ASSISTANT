import { describe, expect, it } from "vitest";
import { startRealtime } from "../../src/lib/friday/realtime-client";
import type { GateInput } from "../../src/lib/friday/realtime-protocol";

const local: GateInput = {
  engine: "local-speech-to-speech",
  url: "ws://127.0.0.1:8123/v1/realtime",
  surface: "auto",
  paused: false,
  paidAccess: false,
  cloudKey: false,
  privacyMode: true,
  sessionConsent: false,
  halted: false,
};

function fakeBridge() {
  const sent: { type: string; [k: string]: unknown }[] = [];
  let push: (payload: { id: string; event: { type: string } }) => void = () => undefined;
  let close: (payload: { id: string; reason: string }) => void = () => undefined;
  let closedId = "";
  return {
    sent,
    emit: (event: { type: string; [k: string]: unknown }) => push({ id: "t1", event }),
    drop: (reason: string) => close({ id: "t1", reason }),
    closedId: () => closedId,
    bridge: {
      realtimeOpen: async () => ({ ok: true }),
      realtimeSend: async (_id: string, event: unknown) => {
        sent.push(event as { type: string });
        return { ok: true };
      },
      realtimeClose: async (id: string) => {
        closedId = id;
        return { ok: true };
      },
      onRealtimeEvent: (cb: typeof push) => {
        push = cb;
        return () => undefined;
      },
      onRealtimeClosed: (cb: typeof close) => {
        close = cb;
        return () => undefined;
      },
    },
  };
}

describe("realtime client", () => {
  it("opens nothing when the gate says no, and gives the reasons", async () => {
    const fake = fakeBridge();
    const out = await startRealtime({
      gate: { ...local, surface: "manual" },
      settings: { instructions: "x" },
      bridge: fake.bridge,
      id: "t1",
    });
    expect(out).toMatchObject({ ok: false, reasons: [expect.stringMatching(/Auto mode/)] });
    expect(fake.sent).toEqual([]);
  });

  it("does not open a cloud connection, even when every condition holds", async () => {
    const fake = fakeBridge();
    const out = await startRealtime({
      gate: {
        ...local,
        engine: "cloud-realtime",
        url: "wss://api.example.com/v1/realtime",
        paidAccess: true,
        cloudKey: true,
        privacyMode: false,
        sessionConsent: true,
      },
      settings: { instructions: "x" },
      bridge: fake.bridge,
      id: "t1",
    });
    expect(out).toMatchObject({
      ok: false,
      reasons: [expect.stringMatching(/not available in this version/)],
    });
  });

  it("runs a turn: settings first, audio out to the caller, then a barge-in cuts the item where it was heard", async () => {
    const fake = fakeBridge();
    const played: string[] = [];
    const out = await startRealtime({
      gate: local,
      settings: { instructions: "Be brief." },
      onAudio: (c) => played.push(c),
      bridge: fake.bridge,
      id: "t1",
    });
    if (!out.ok) throw new Error("should have opened");
    expect(fake.sent[0]?.type).toBe("session.update");
    fake.emit({ type: "session.created" });
    fake.emit({ type: "response.created" });
    fake.emit({ type: "response.output_item.added", item: { id: "item_7" } });
    fake.emit({ type: "response.audio.delta", delta: "AAA=" });
    fake.emit({ type: "response.audio.delta", delta: "BBB=" });
    expect(played).toEqual(["AAA=", "BBB="]);
    await out.handle.sendAudio("CCC=");
    expect(fake.sent.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: "CCC=" });
    await out.handle.bargeIn(430);
    expect(fake.sent.slice(-2)).toEqual([
      { type: "response.cancel" },
      {
        type: "conversation.item.truncate",
        item_id: "item_7",
        content_index: 0,
        audio_end_ms: 430,
      },
    ]);
  });

  it("stops and tells the caller when the engine fails or the pipe drops", async () => {
    const fake = fakeBridge();
    const reasons: string[] = [];
    const out = await startRealtime({
      gate: local,
      settings: { instructions: "x" },
      onStop: (r) => reasons.push(r),
      bridge: fake.bridge,
      id: "t1",
    });
    if (!out.ok) throw new Error("should have opened");
    fake.emit({ type: "error", error: { message: "model not loaded" } } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(reasons[0]).toBe("model not loaded");
    expect(fake.closedId()).toBe("t1");
    await out.handle.sendAudio("DDD=");
    expect(fake.sent.some((e) => e["audio"] === "DDD=")).toBe(false);
  });

  it("says the desktop app is needed when there is no bridge", async () => {
    const out = await startRealtime({ gate: local, settings: { instructions: "x" }, bridge: {} });
    expect(out).toMatchObject({ ok: false, reasons: [expect.stringMatching(/desktop app/)] });
  });
});
