/**
 * Every way the streaming ear can fail ends the stream and answers null, so the dictation transcribes the same audio
 * the ordinary way. A fake bridge, no timers, no microphone.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STREAM_MAX_BACKLOG_MS,
  STREAM_RATE,
  SttStreamSession,
  streamEarlyRead,
  type StreamBridge,
} from "../../src/lib/friday/voice-engine/stream-session";

const sttSource = readFileSync(resolve(__dirname, "../../src/lib/friday/voice-stt.ts"), "utf8");
const ms = (n: number) => new Float32Array(Math.round((n / 1000) * STREAM_RATE)).fill(0.1);
const flush = () => new Promise((r) => setTimeout(r, 0));

function bridge(overrides: Partial<StreamBridge> = {}) {
  const calls = { open: 0, feed: 0, close: [] as { streamId: string; finalize?: boolean }[] };
  const b: StreamBridge = {
    openSttStream: async () => {
      calls.open += 1;
      return { ok: true, streamId: "s1", chunkMs: 160 };
    },
    feedSttStream: async () => {
      calls.feed += 1;
      return { ok: true, events: [] };
    },
    closeSttStream: async (payload) => {
      calls.close.push(payload);
      return { ok: true, text: "heard" };
    },
    ...overrides,
  };
  return { b, calls };
}

async function run(b: StreamBridge, reasons: string[]) {
  const session = new SttStreamSession({ bridge: b, onFallback: (r) => reasons.push(r) });
  await session.open({ streamEngine: "auto", locale: "hi" });
  session.push(ms(320));
  await flush();
  return { session, final: await session.close() };
}

describe("stream fallback: refusals and throws answer null", () => {
  it("off never touches the bridge", async () => {
    const { b, calls } = bridge();
    const reasons: string[] = [];
    const session = new SttStreamSession({ bridge: b, onFallback: (r) => reasons.push(r) });
    expect(await session.open({ streamEngine: "off", locale: "hi" })).toBe(false);
    expect(calls.open).toBe(0);
    expect(await session.close()).toBeNull();
    expect(reasons).toEqual(["off"]);
  });

  it("a missing bridge (browser, old preload) is a fallback", async () => {
    const reasons: string[] = [];
    for (const missing of [null, {}, { openSttStream: bridge().b.openSttStream }]) {
      const session = new SttStreamSession({
        bridge: missing as StreamBridge,
        onFallback: (r) => reasons.push(r),
      });
      expect(await session.open({ streamEngine: "auto", locale: "" })).toBe(false);
      expect(await session.close()).toBeNull();
    }
    expect(reasons).toEqual(["no-bridge", "no-bridge", "no-bridge"]);
  });

  it.each(["busy", "worker", "weights-missing", "locale-unsupported"])(
    "open refused %s",
    async (reason) => {
      const { b, calls } = bridge({
        openSttStream: async () => ({ ok: false, fallback: true, reason }),
      });
      const reasons: string[] = [];
      const { session, final } = await run(b, reasons);
      expect(final).toBeNull();
      expect(reasons).toEqual([reason]);
      expect(session.state).toBe("fallback");
      expect(calls.feed).toBe(0);
    },
  );

  it("open throws", async () => {
    const reasons: string[] = [];
    const { b } = bridge({
      openSttStream: async () => {
        throw new Error("ipc gone");
      },
    });
    expect((await run(b, reasons)).final).toBeNull();
    expect(reasons).toEqual(["threw"]);
  });

  it("feed refused (the main process already ended the stream)", async () => {
    const reasons: string[] = [];
    const { b, calls } = bridge({
      feedSttStream: async () => ({ ok: false, fallback: true, reason: "worker" }),
    });
    expect((await run(b, reasons)).final).toBeNull();
    expect(reasons).toEqual(["worker"]);
    expect(calls.close).toEqual([]);
  });

  it("feed throws", async () => {
    const reasons: string[] = [];
    const { b } = bridge({
      feedSttStream: async () => {
        throw new Error("boom");
      },
    });
    expect((await run(b, reasons)).final).toBeNull();
    expect(reasons).toEqual(["threw"]);
  });

  it("close refused, close throws, close empty", async () => {
    const reasons: string[] = [];
    expect(
      (
        await run(
          bridge({
            closeSttStream: async () => ({ ok: false, fallback: true, reason: "no-stream" }),
          }).b,
          reasons,
        )
      ).final,
    ).toBeNull();
    expect(
      (
        await run(
          bridge({
            closeSttStream: async () => {
              throw new Error("x");
            },
          }).b,
          reasons,
        )
      ).final,
    ).toBeNull();
    expect(
      (await run(bridge({ closeSttStream: async () => ({ ok: true, text: "   " }) }).b, reasons))
        .final,
    ).toBeNull();
    expect(reasons).toEqual(["no-stream", "threw"]);
  });

  it("a stalled ear (backlog past the cap) is dropped without a final", async () => {
    let hang: () => void = () => undefined;
    const { b, calls } = bridge({
      feedSttStream: () => new Promise((r) => (hang = () => r({ ok: true }))),
    });
    const session = new SttStreamSession({ bridge: b });
    await session.open({ streamEngine: "auto", locale: "en" });
    session.push(ms(160));
    session.push(ms(STREAM_MAX_BACKLOG_MS + 200));
    expect(session.state).toBe("fallback");
    expect(session.fallbackReason).toBe("stalled");
    expect(calls.close).toEqual([{ streamId: "s1", finalize: false }]);
    hang();
    expect(await session.close()).toBeNull();
  });

  it("aborted while opening: the late stream is closed without a final", async () => {
    let answer: (v: { ok: boolean; streamId: string }) => void = () => undefined;
    const { b, calls } = bridge({ openSttStream: () => new Promise((r) => (answer = r)) });
    const session = new SttStreamSession({ bridge: b });
    const opened = session.open({ streamEngine: "auto", locale: "hi" });
    session.abort("stopped");
    answer({ ok: true, streamId: "late" });
    expect(await opened).toBe(false);
    await flush();
    expect(calls.close).toEqual([{ streamId: "late", finalize: false }]);
    expect(await session.close()).toBeNull();
  });

  it("a null final makes the early read answer null, so the queue transcribes", async () => {
    expect(await streamEarlyRead(Promise.resolve(null)).take()).toBeNull();
    expect(await streamEarlyRead(Promise.reject(new Error("x"))).take()).toBeNull();
  });

  it("the dictation transcribes whenever the early read answers null", () => {
    expect(sttSource).toMatch(/const adopted = provisional \? await provisional\.take\(\) : null;/);
    expect(sttSource).toMatch(/const result = \(adopted \?\?\s*\(await api\.transcribe\(\{/);
  });
});
