import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { flushPendingState } from "../../src/lib/friday/persist";

const base = {
  tier: "semantic" as const,
  source: "t",
  tags: ["phone"],
  kind: "preference" as const,
};

describe("memory keeps what is true now", () => {
  beforeEach(() => memory.resetForTests());

  it("a newer, shorter statement of the same fact replaces the older one", () => {
    memory.remember({ ...base, title: "Phone", text: "Owner phone model is Pixel 6 Pro" });
    memory.remember({ ...base, title: "Phone", text: "Owner phone model is Pixel 9" });
    const hits = memory.search("owner phone model", { k: 10 }).filter((i) => i.title === "Phone");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("Owner phone model is Pixel 9");
  });

  it("an older statement that already says more is kept", () => {
    memory.remember({ ...base, title: "Editor", text: "Owner uses dark mode in the editor" });
    memory.remember({ ...base, title: "Editor", text: "owner uses dark mode" });
    const hit = memory.search("dark mode editor", { k: 5 }).find((i) => i.title === "Editor");
    expect(hit?.text).toBe("Owner uses dark mode in the editor");
  });

  it("ordinary search leaves out replaced records and ended ones; history asks for them", () => {
    const old = memory.remember({
      ...base,
      title: "City",
      text: "Owner lives in Jaipur",
      distinct: true,
    });
    const next = memory.remember({
      ...base,
      title: "City",
      text: "Owner lives in Udaipur",
      distinct: true,
    });
    expect(old.id).not.toBe(next.id);
    expect(memory.supersede(old.id, next.id, "moved")).toBe(true);
    const ended = memory.remember({
      ...base,
      title: "Trip",
      text: "Owner is travelling to Goa",
      validUntil: Date.now() - 1000,
    });
    const now = memory.search("owner lives travelling", { k: 10 }).map((i) => i.id);
    expect(now).toContain(next.id);
    expect(now).not.toContain(old.id);
    expect(now).not.toContain(ended.id);
    const history = memory
      .search("owner lives travelling", { k: 10, includeHistory: true })
      .map((i) => i.id);
    expect(history).toContain(old.id);
    expect(history).toContain(ended.id);
  });
});

describe("memory is written before the page goes away", () => {
  const store = new Map<string, string>();
  const sent: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    sent.length = 0;
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      addEventListener: () => undefined,
      friday: {
        getState: async () => null,
        setState: async (namespace: string) => void sent.push(namespace),
      },
    };
    memory.resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("flushing sends the newest record to disk without waiting for the timers", () => {
    memory.remember({ ...base, title: "Colour", text: "Owner likes the colour teal" });
    expect([...store.keys()].some((key) => /memory/i.test(key))).toBe(false);
    flushPendingState();
    expect([...store.keys()].some((key) => /memory/i.test(key))).toBe(true);
    expect(sent.some((key) => /memory/i.test(key))).toBe(true);
  });
});
