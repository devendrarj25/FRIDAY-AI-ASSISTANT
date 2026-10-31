import { afterEach, describe, expect, it } from "vitest";
import { vectorIndex } from "../../src/lib/friday/brain/vector-index";
import { memory } from "../../src/lib/friday/self/memory-engine";

type Call = { method: string; params: Record<string, unknown> };

function useBridge(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  const target = vectorIndex as unknown as { bridge: unknown; pushed: Set<string> };
  target.bridge = {
    call: async (method: string, params: Record<string, unknown>) => {
      const call = { method, params };
      calls.push(call);
      return answer(call);
    },
  };
  return calls;
}

describe("vector index", () => {
  afterEach(() => {
    const target = vectorIndex as unknown as { bridge: unknown; pushed: Set<string> };
    target.bridge = null;
    target.pushed = new Set();
    memory.resetForTests();
  });

  it("returns nothing for an empty query and never calls the kernel", async () => {
    const calls = useBridge(() => ({ results: [] }));
    expect(await vectorIndex.queryHits("   ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("tries a rewritten query only when the first finds nothing", async () => {
    let n = 0;
    const calls = useBridge(() => {
      n += 1;
      return { results: n === 1 ? [] : [{ title: "Owner", snippet: "Dev owns it", score: 0.7 }] };
    });
    const hits = await vectorIndex.queryHits("who owns FRIDAY");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params["query"]).not.toBe(calls[1]?.params["query"]);
    expect(hits[0]?.title).toBe("Owner");

    n = 5;
    const again = useBridge(() => ({ results: [{ title: "x", snippet: "y", score: 0.5 }] }));
    await vectorIndex.queryHits("who owns FRIDAY");
    expect(again).toHaveLength(1);
  });

  it("answers with no hits when the kernel call fails, instead of throwing", async () => {
    const target = vectorIndex as unknown as { bridge: unknown };
    target.bridge = {
      call: async () => {
        throw new Error("socket closed");
      },
    };
    expect(await vectorIndex.queryHits("anything at all")).toEqual([]);
    expect(vectorIndex.getSnapshot().connected).toBe(false);
  });

  it("syncs a memory once and skips the working tier", async () => {
    const fact = memory.remember({
      tier: "semantic",
      title: "Fact one",
      text: "Fact one is stored for sync.",
    });
    const scratch = memory.remember({
      tier: "working",
      title: "Scratch",
      text: "Scratch note that stays local.",
    });
    const calls = useBridge(() => ({ ok: true }));
    expect(await vectorIndex.syncLocalMemory()).toBeGreaterThanOrEqual(1);
    const sent = calls
      .filter((call) => call.method === "memory.add")
      .map((call) => call.params["id"]);
    expect(sent).toContain(fact.id);
    expect(sent).not.toContain(scratch.id);
    expect(await vectorIndex.syncLocalMemory()).toBe(0);
  });

  it("stops syncing at the first refusal so nothing is marked as pushed by mistake", async () => {
    const fact = memory.remember({
      tier: "semantic",
      title: "Fact two",
      text: "Fact two waits for the kernel.",
    });
    useBridge(() => ({ ok: false }));
    expect(await vectorIndex.syncLocalMemory()).toBe(0);
    const calls = useBridge(() => ({ ok: true }));
    expect(await vectorIndex.syncLocalMemory()).toBeGreaterThanOrEqual(1);
    expect(calls.map((call) => call.params["id"])).toContain(fact.id);
  });
});
