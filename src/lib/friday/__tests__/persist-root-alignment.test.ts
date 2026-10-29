import { describe, expect, it, beforeEach, vi } from "vitest";

/** Minimal localStorage stand-in for the module-load alignment check. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
    // Object.keys(localStorage) is what persist.ts enumerates.
    ...Object.fromEntries(map),
  } as unknown as Storage & { keys: () => string[] };
}

function install(seed: Record<string, string>, identity: unknown) {
  const storage = fakeStorage(seed);
  vi.stubGlobal("window", { localStorage: storage, friday: { storageIdentity: identity } });
  return storage;
}

describe("browser cache follows the FRIDAY root", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("drops a cache stamped with a different root", async () => {
    const storage = install(
      {
        "friday.storage.identity": "old-root",
        "friday.brain.v1": '{"a":1}',
        "friday.memory.v1": '{"b":2}',
        "unrelated.app": "keep",
      },
      { id: "new-root", root: "C:/FRIDAY" },
    );
    await import("../persist");
    expect(storage.getItem("friday.brain.v1")).toBeNull();
    expect(storage.getItem("friday.memory.v1")).toBeNull();
    expect(storage.getItem("unrelated.app")).toBe("keep");
    expect(storage.getItem("friday.storage.identity")).toBe("new-root");
  });

  it("keeps the cache when the root is unchanged", async () => {
    const storage = install(
      { "friday.storage.identity": "same-root", "friday.brain.v1": '{"a":1}' },
      { id: "same-root", root: "C:/FRIDAY" },
    );
    await import("../persist");
    expect(storage.getItem("friday.brain.v1")).toBe('{"a":1}');
  });

  it("leaves the browser preview untouched (no desktop identity)", async () => {
    const storage = install({ "friday.brain.v1": '{"a":1}' }, null);
    await import("../persist");
    expect(storage.getItem("friday.brain.v1")).toBe('{"a":1}');
  });
});
