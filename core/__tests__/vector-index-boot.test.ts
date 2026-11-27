/**
 * The vector index syncs without any memory panel open: a turn that reaches the memory fabric starts it, and a
 * forgotten memory is removed from the kernel's copy at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetEverywhere, governRecall } from "../../src/lib/friday/brain/memory-fabric";
import { ensureVectorIndexStarted, vectorIndex } from "../../src/lib/friday/brain/vector-index";
import { memory } from "../../src/lib/friday/self/memory-engine";

type Call = { method: string; params: Record<string, unknown> };
type Target = {
  bridge: unknown;
  pushed: Set<string>;
  stamps: Map<string, number>;
  started: boolean;
};

function fakeKernel(): Call[] {
  const calls: Call[] = [];
  (vectorIndex as unknown as Target).bridge = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "memory.status") return { backend: "numpy", available: true, records: 1 };
      return { ok: true, removed: 1 };
    },
  };
  return calls;
}

describe("vector index boot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      friday: { isDesktop: true },
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    });
    memory.resetForTests();
  });
  afterEach(() => {
    vectorIndex.stop();
    const target = vectorIndex as unknown as Target;
    target.bridge = null;
    target.pushed = new Set();
    target.stamps = new Map();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does nothing outside the desktop app", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined } });
    ensureVectorIndexStarted();
    expect((vectorIndex as unknown as Target).started).toBe(false);
  });

  it("is idempotent: asking twice starts one loop", async () => {
    const calls = fakeKernel();
    ensureVectorIndexStarted();
    ensureVectorIndexStarted();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((call) => call.method === "memory.status")).toHaveLength(1);
  });

  it("a turn through the fabric starts the sync with no panel mounted, and a change reaches the kernel", async () => {
    const calls = fakeKernel();
    expect((vectorIndex as unknown as Target).started).toBe(false);
    governRecall({ prompt: "what tea does the owner drink", hits: [] });
    expect((vectorIndex as unknown as Target).started).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.some((call) => call.method === "memory.status")).toBe(true);
    const item = memory.remember({
      tier: "semantic",
      title: "Tea",
      text: "owner drinks masala tea every morning",
      source: "user",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const pushed = calls.find((call) => call.method === "memory.add");
    expect(pushed?.params["id"]).toBe(item.id);
  });

  it("forgetting a memory removes it from the kernel's vector copy now, not at the next sync", async () => {
    const calls = fakeKernel();
    const item = memory.remember({
      tier: "semantic",
      title: "Tea",
      text: "owner drinks masala tea every morning",
      source: "user",
    });
    const target = vectorIndex as unknown as Target;
    target.pushed.add(item.id);
    target.stamps.set(item.id, item.updatedAt);
    forgetEverywhere(item.id);
    await vi.advanceTimersByTimeAsync(10);
    const removal = calls.find((call) => call.method === "memory.remove");
    expect(removal?.params["ids"]).toEqual([item.id]);
    expect(target.pushed.has(item.id)).toBe(false);
    expect(target.stamps.has(item.id)).toBe(false);
  });

  it("keeps the stamp when the kernel cannot be reached, so the next sync retries the removal", async () => {
    const target = vectorIndex as unknown as Target;
    target.bridge = {
      call: async () => {
        throw new Error("socket closed");
      },
    };
    target.pushed.add("mem-x");
    target.stamps.set("mem-x", 1);
    await expect(vectorIndex.remove("mem-x")).resolves.toBe(false);
    expect(target.stamps.has("mem-x")).toBe(true);
  });
});
