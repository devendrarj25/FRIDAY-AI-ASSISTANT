/**
 * The vector recall asks the kernel with a timeout, so a hung kernel cannot hold a spoken turn: on timeout the
 * query returns no hits and the lexical hits stand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { vectorIndex } from "../../src/lib/friday/brain/vector-index";

type Target = { bridge: unknown };

afterEach(() => {
  (vectorIndex as unknown as Target).bridge = null;
});

describe("vector index query timeout", () => {
  it("passes a timeout to the bridge for memory.search", async () => {
    const call = vi.fn(async () => ({ results: [] }));
    (vectorIndex as unknown as Target).bridge = { call };
    await vectorIndex.queryHits("coffee order", 4, "none");
    const search = call.mock.calls.find((c) => (c as unknown[])[0] === "memory.search") as
      unknown[] | undefined;
    expect(search).toBeTruthy();
    const options = search?.[2] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBeGreaterThan(0);
  });

  it("returns no hits when the bridge call rejects with a timeout", async () => {
    const call = vi.fn(async () => {
      throw new Error("bridge call timed out");
    });
    (vectorIndex as unknown as Target).bridge = { call };
    await expect(vectorIndex.queryHits("coffee order", 4, "none")).resolves.toEqual([]);
  });
});
