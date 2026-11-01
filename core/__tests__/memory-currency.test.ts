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

  it("the replaced statement stays as history with its reason, and is not a current answer", () => {
    memory.remember({ ...base, title: "Phone", text: "Owner phone model is Pixel 6 Pro" });
    memory.remember({ ...base, title: "Phone", text: "Owner phone model is Pixel 9" });
    const all = memory.search("owner phone model", { k: 10, includeHistory: true });
    const history = all.find((i) => /Pixel 6 Pro/.test(i.text));
    expect(history?.supersededAt).toBeTruthy();
    expect(history?.invalidReason).toMatch(/replaced/);
    const now = memory.search("owner phone model", { k: 10 });
    expect(now.some((i) => /Pixel 6 Pro/.test(i.text))).toBe(false);
    expect(now.some((i) => /Pixel 9/.test(i.text))).toBe(true);
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

describe("one memory, two lists", () => {
  it("a turn recalls what the six-tier store knows, and forgetting is forgotten in both", async () => {
    const { brain } = await import("../../src/lib/friday/brain-engine");
    memory.resetForTests();
    const taught = memory.remember({
      tier: "permanent",
      title: "Tea",
      text: "Owner drinks masala chai without sugar",
      source: "user",
      tags: [],
      kind: "preference",
      verified: true,
    });
    const hits = brain.recall("how does the owner like his masala chai", 4);
    expect(hits.some((hit) => hit.id === taught.id && /without sugar/.test(hit.snippet))).toBe(
      true,
    );

    brain.remember("long-term", "Tea", "Owner drinks masala chai without sugar");
    const listed = brain.getSnapshot().memory.find((m) => m.title === "Tea");
    expect(listed).toBeTruthy();
    // The same line in both lists is shown once.
    const again = brain
      .recall("masala chai sugar", 6)
      .filter((hit) => /masala chai/.test(hit.snippet));
    expect(again).toHaveLength(1);

    brain.forget(listed!.id);
    expect(memory.search("masala chai", { k: 5 }).some((i) => i.id === taught.id)).toBe(false);
    expect(
      brain.recall("masala chai sugar", 6).some((hit) => /masala chai/.test(hit.snippet)),
    ).toBe(false);
  });

  it("forgetting a durable record also drops the same line from the quick list", async () => {
    const { brain } = await import("../../src/lib/friday/brain-engine");
    brain.remember("long-term", "Pet", "Owner has a cat named Momo");
    expect(brain.getSnapshot().memory.some((m) => m.title === "Pet")).toBe(true);
    brain.forgetMatching("Pet", "Owner has a cat named Momo");
    expect(brain.getSnapshot().memory.some((m) => m.title === "Pet")).toBe(false);
  });
});

describe("knowledge derived from memory follows it", () => {
  it("a replaced memory takes its derived knowledge entry with it", async () => {
    const { brainKnowledge } = await import("../../src/lib/friday/brain/knowledge-base");
    await import("../../src/lib/friday/brain/memory-fabric");
    memory.resetForTests();
    const older = memory.remember({
      tier: "semantic",
      title: "Laptop",
      text: "Owner laptop is a ThinkPad",
      source: "user",
      tags: [],
      kind: "semantic",
      verified: true,
      distinct: true,
    });
    const { deriveKnowledgeFromMemory } = await import("../../src/lib/friday/brain/knowledge-base");
    deriveKnowledgeFromMemory(older);
    const has = () =>
      brainKnowledge.getSnapshot().entries.some((entry) => entry.derivedFromMemoryId === older.id);
    expect(has()).toBe(true);
    const newer = memory.remember({
      tier: "semantic",
      title: "Laptop",
      text: "Owner laptop is a MacBook",
      source: "user",
      tags: [],
      kind: "semantic",
      verified: true,
      distinct: true,
    });
    memory.supersede(older.id, newer.id, "replaced");
    expect(has()).toBe(false);
  });
});
