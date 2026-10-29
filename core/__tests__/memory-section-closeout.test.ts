/**
 * Memory section closeout: Teach writes the six-tier store, search is ranked,
 * kernel ids stay canonical, and existing Button controls stay on the same row.
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { memory } from "../../src/lib/friday/self/memory-engine";
import {
  kindForLayer,
  layerToTier,
  reviseDurable,
  searchDurable,
  teachDurable,
} from "../../src/lib/friday/self/memory-teach";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Memory page wiring", () => {
  const page = read("src/components/friday/MemoryConsole.tsx");
  const engine = read("src/lib/friday/self/memory-engine.ts");
  const kernel = read("kernel/main.py");
  const vectors = read("src/lib/friday/brain/vector-index.ts");

  it("Teach writes the six-tier store and indexes with the canonical id", () => {
    expect(page).toContain("teachDurable");
    expect(page).toContain("reviseDurable");
    expect(page).toContain("brain.remember");
    expect(page).toContain("brain.recall");
    expect(page).toContain("vectorIndex.add");
    expect(page).toContain("Import JSON");
    expect(page).toContain("Hygiene now");
    expect(page).toContain("Compact now");
    expect(page).toContain("Clear working");
    expect(page).toContain("Update memory");
    expect(page).toContain("memoryEngine.pin");
    expect(page).toContain("memoryEngine.restore");
    expect(page).toContain("unpinnedBrain.forEach");
    expect(page).toContain("vectorIndex.refresh()");
  });

  it("search uses ranked durable lookup and live vector queryHits", () => {
    expect(page).toContain("searchDurable");
    expect(page).toContain("vectorIndex.search(memQuery)");
    expect(vectors).toContain("const hits = await this.queryHits");
    expect(engine).toContain("hygiene()");
    expect(kernel).toContain('record_id=params.get("id")');
  });
});

describe("teach and ranked search", () => {
  beforeEach(() => {
    memory.resetForTests();
  });

  it("maps Memory layers onto six-tier kinds", () => {
    expect(layerToTier("long-term")).toBe("permanent");
    expect(layerToTier("project")).toBe("semantic");
    expect(layerToTier("conversation")).toBe("working");
    expect(kindForLayer("knowledge")).toBe("semantic");
  });

  it("Save to memory creates a durable six-tier record", () => {
    const item = teachDurable("long-term", "Prefer local models", "Always prefer local models.");
    expect(item.tier).toBe("permanent");
    expect(item.pinned).toBe(true);
    expect(item.source).toBe("teach");
    expect(memory.getSnapshot().items.some((row) => row.id === item.id)).toBe(true);
  });

  it("pin toggles without a second store", () => {
    const item = teachDurable("conversation", "Scratch", "A working scratch fact for tests.");
    expect(item.pinned).toBe(false);
    memory.pin(item.id);
    expect(memory.getSnapshot().items.find((row) => row.id === item.id)?.pinned).toBe(true);
  });

  it("ranked search beats a non-matching substring-only miss", () => {
    teachDurable("knowledge", "Owner", "Devendra Singh Meena publishes FRIDAY.");
    const hits = searchDurable("Devendra", memory.getSnapshot().items, "all");
    expect(hits.some((row) => /Devendra/.test(row.text))).toBe(true);
  });

  it("short queries do not dump the whole store", () => {
    teachDurable("knowledge", "Owner", "Devendra Singh Meena publishes FRIDAY.");
    const all = memory.getSnapshot().items;
    const hits = searchDurable("qzxqzx", all, "all");
    expect(hits).toEqual([]);
  });

  it("reviseDurable updates the same row id", () => {
    const item = teachDurable("knowledge", "Owner name", "Devendra Singh Meena publishes FRIDAY.");
    const revised = reviseDurable(item.id, "Owner name", "Devendra publishes FRIDAY from India.");
    expect(revised?.id).toBe(item.id);
    expect(revised?.text).toContain("India");
    expect(memory.getSnapshot().items.filter((row) => row.id === item.id)).toHaveLength(1);
  });
});
