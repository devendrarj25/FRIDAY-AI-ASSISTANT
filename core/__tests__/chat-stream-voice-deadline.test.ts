/**
 * A spoken turn does not wait minutes for a slow first model. Each candidate gets a short first-words deadline
 * (longer when the model has to load first); on a miss that socket is closed and the next candidate answers. The
 * kernel's "ready" frame is proof of life, not words, so it neither moves nor ends the deadline. A stream of blank
 * lines is not an answer. Typed chat keeps its long limits. The real `streamOnceRaw` of electron/main.cjs runs here
 * against a fake kernel socket on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mainText, streamHarness } from "./helpers/main-stream";

const require_ = createRequire(import.meta.url);
type Stall = { kind: string; ms: number; message: string };
const watchdog = require_("../../electron/stream-watchdog.cjs") as {
  createStallWatchdog: (
    onStall: (stall: Stall) => void,
    options?: { firstByteMs?: number; idleMs?: number; firstDeltaMs?: number },
  ) => { beat: () => void; progress: () => void; stop: () => void };
  firstDeltaDeadlineMs: (input?: {
    surface?: string;
    model?: { type?: string };
    coldLoad?: boolean;
  }) => number;
  FIRST_DELTA_CLOUD_MS: number;
  FIRST_DELTA_WARM_MS: number;
  FIRST_DELTA_COLD_MS: number;
  FIRST_BYTE_MS: number;
  IDLE_MS: number;
};

const local = {
  id: "ollama:llama3.2",
  type: "local",
  label: "Llama",
  meta: { providerId: "ollama" },
};
const cloud = { id: "cloud:test", type: "cloud", label: "Test", meta: { providerId: "test" } };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const seconds = (n: number) => vi.advanceTimersByTimeAsync(n * 1000);

async function start(
  request: Record<string, unknown>,
  model: Record<string, unknown>,
  coldLoad = false,
) {
  const harness = streamHarness();
  const done = harness.run({ requestId: "r1", request, prompt: "hello", model, coldLoad });
  await vi.advanceTimersByTimeAsync(0);
  const socket = harness.socket();
  return { harness, socket, done };
}

describe("the deadline for the first words", () => {
  it("only a spoken turn has one, longer for a model that has to load, shorter for the cloud", () => {
    const { firstDeltaDeadlineMs: ms } = watchdog;
    expect(ms({ surface: "chat", model: local })).toBe(0);
    expect(ms({ model: local })).toBe(0);
    expect(ms({ surface: "voice", model: cloud })).toBe(watchdog.FIRST_DELTA_CLOUD_MS);
    expect(ms({ surface: "voice", model: local })).toBe(watchdog.FIRST_DELTA_WARM_MS);
    expect(ms({ surface: "voice", model: local, coldLoad: true })).toBe(
      watchdog.FIRST_DELTA_COLD_MS,
    );
    expect(watchdog.FIRST_DELTA_CLOUD_MS).toBeGreaterThanOrEqual(12_000);
    expect(watchdog.FIRST_DELTA_WARM_MS).toBeLessThanOrEqual(20_000);
    expect(watchdog.FIRST_DELTA_COLD_MS).toBeGreaterThan(watchdog.FIRST_DELTA_WARM_MS);
  });

  it("a bare frame does not count as progress; the first words hand over to the idle deadline", async () => {
    const stalls: Stall[] = [];
    const dog = watchdog.createStallWatchdog((stall) => stalls.push(stall), {
      firstDeltaMs: 1000,
      idleMs: 5000,
    });
    await seconds(0.6);
    dog.beat();
    await seconds(0.3);
    expect(stalls).toEqual([]);
    await seconds(0.2);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ kind: "first-delta", ms: 1000 });
    expect(stalls[0]?.message).toMatch(/^timeout: no first words within 1s/);

    const later: Stall[] = [];
    const quick = watchdog.createStallWatchdog((stall) => later.push(stall), {
      firstDeltaMs: 1000,
      idleMs: 5000,
    });
    await seconds(0.9);
    quick.progress();
    await seconds(4);
    expect(later).toEqual([]);
    await seconds(1.5);
    expect(later).toHaveLength(1);
    expect(later[0]?.kind).toBe("idle");
  });

  it("without a first-words deadline nothing changes: any frame hands over to the idle deadline", async () => {
    const stalls: Stall[] = [];
    const dog = watchdog.createStallWatchdog((stall) => stalls.push(stall), {
      firstByteMs: 1000,
      idleMs: 3000,
    });
    await seconds(0.5);
    dog.beat();
    await seconds(2);
    expect(stalls).toEqual([]);
    await seconds(1.5);
    expect(stalls[0]?.kind).toBe("idle");
  });
});

describe("one spoken turn, one candidate", () => {
  it("lets a silent loaded local model go after its deadline, closing its socket", async () => {
    const { socket, done } = await start({ routingSurface: "voice" }, local);
    expect(socket.closed).toBe(false);
    await seconds(19);
    expect(socket.closed).toBe(false);
    await seconds(1.1);
    const result = await done;
    expect(result).toMatchObject({
      ok: false,
      received: false,
      timedOut: true,
      firstDeltaMiss: true,
    });
    expect(result.error).toMatch(/^timeout: no first words within 20s/);
    expect(socket.closed).toBe(true);
  });

  it("the ready frame does not move the deadline", async () => {
    const { socket, done } = await start({ routingSurface: "voice" }, local);
    await seconds(15);
    socket.ready();
    await seconds(4.9);
    expect(socket.closed).toBe(false);
    await seconds(0.2);
    expect(await done).toMatchObject({ firstDeltaMiss: true });
    expect(socket.params).toHaveProperty("prompt", "hello");
  });

  it("waits longer for a model that is loading, and less for a cloud model", async () => {
    const cold = await start({ routingSurface: "voice" }, local, true);
    await seconds(30);
    expect(cold.socket.closed).toBe(false);
    await seconds(30.1);
    expect(await cold.done).toMatchObject({ firstDeltaMiss: true });
    expect((await cold.done).error).toMatch(/within 60s/);

    const cloudTurn = await start({ routingSurface: "voice" }, cloud);
    await seconds(15.1);
    expect(await cloudTurn.done).toMatchObject({ firstDeltaMiss: true });
  });

  it("blank lines are not words: they are passed on, but the deadline still runs and nothing counts as received", async () => {
    const { harness, socket, done } = await start({ routingSurface: "voice" }, local);
    socket.ready();
    await seconds(5);
    socket.delta("\n");
    socket.delta("  ");
    await seconds(15.1);
    const result = await done;
    expect(result).toMatchObject({ ok: false, received: false, firstDeltaMiss: true });
    expect(harness.sent.filter((row) => row.channel === "chat:delta")).toHaveLength(2);
  });

  it("the first words end the deadline; a later silence is the idle limit, not a missed start", async () => {
    const { socket, done } = await start({ routingSurface: "voice" }, local);
    socket.ready();
    await seconds(5);
    socket.delta("Hello");
    await seconds(60);
    expect(socket.closed).toBe(false);
    await seconds(100);
    const result = await done;
    expect(result).toMatchObject({ ok: false, received: true, timedOut: true });
    expect(result).not.toHaveProperty("firstDeltaMiss");
    expect(result.error).toMatch(/the reply stalled/);
  });

  it("a tool notice shows the model is working, so it ends the first-words wait too", async () => {
    const { socket, done } = await start({ routingSurface: "voice" }, local);
    socket.ready();
    await seconds(5);
    socket.tool("fs.read");
    await seconds(30);
    expect(socket.closed).toBe(false);
    socket.delta("Done");
    socket.result();
    expect(await done).toMatchObject({ ok: true, received: true });
  });

  it("typed chat has no first-words deadline: it keeps the long first-byte and idle limits", async () => {
    const { socket, done } = await start({ routingSurface: "chat" }, local);
    socket.ready();
    await seconds(60);
    expect(socket.closed).toBe(false);
    socket.delta("Hello");
    socket.result();
    expect(await done).toMatchObject({ ok: true, received: true });
    const plain = await start({}, local);
    await seconds(100);
    expect(plain.socket.closed).toBe(false);
    plain.socket.delta("x");
    plain.socket.result();
    await plain.done;
  });
});

describe("what counts as an answer", () => {
  it("only a delta with words sets received; a finished stream of blank lines is no content", async () => {
    const { socket, done } = await start({ routingSurface: "chat" }, local);
    socket.ready();
    socket.delta("\n");
    socket.delta(" \t ");
    socket.result();
    const result = await done;
    expect(result).toMatchObject({ ok: false, received: false });
    expect(result.error).toMatch(/accepted the request but streamed no content/);
  });

  it("blank lines before the words do not stop them from counting", async () => {
    const { harness, socket, done } = await start({ routingSurface: "chat" }, local);
    socket.ready();
    socket.delta("\n");
    socket.delta("Hello");
    socket.result();
    expect(await done).toMatchObject({ ok: true, received: true });
    expect(
      harness.sent.filter((row) => row.channel === "chat:delta").map((row) => row.payload["text"]),
    ).toEqual(["\n", "Hello"]);
  });
});

describe("the broker moves on", () => {
  it("a missed start goes to the next candidate, with no smaller-reply retry of the same model", () => {
    const main = mainText();
    expect(main).toContain('...(stall.kind === "first-delta" ? { firstDeltaMiss: true } : {})');
    expect(main).toContain("firstDeltaDeadlineMs({");
    expect(main).toContain("surface: request?.routingSurface,");
    expect(main).toMatch(/was too slow to start speaking, trying the next model/);
    expect(main).toContain("{ ...args, coldLoad: held.cold === true }");
    expect(main).toContain("cold: Boolean(taken.shrunk) || !tag");
  });
});
