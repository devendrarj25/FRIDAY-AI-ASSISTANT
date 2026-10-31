import { beforeEach, describe, expect, it, vi } from "vitest";

// Node has no browser storage, so local state is stood in for by a map that outlives a module reload.
const disk = new Map<string, unknown>();
vi.mock("../../src/lib/friday/persist", () => ({
  readLocalState: (key: string) => disk.get(key) ?? null,
  writeState: (key: string, value: unknown) => void disk.set(key, structuredClone(value)),
  restoreFromDisk: () => undefined,
}));

const KEY = "friday.asr-corrections.v1";
const fresh = async () => {
  vi.resetModules();
  return import("../../src/lib/friday/asr-bias");
};

describe("corrections survive a restart", () => {
  beforeEach(() => disk.clear());

  it("a fix taught before a restart still applies after it", async () => {
    const first = await fresh();
    first.learnCorrection("khol chrome", "kholo Chrome");
    const second = await fresh();
    expect(second.applyCorrections("khol chrome please")).toBe("kholo Chrome please");
  });

  it("the same mishearing taught again replaces the old fix", async () => {
    const bias = await fresh();
    bias.learnCorrection("pandoc", "Pandoc");
    bias.learnCorrection("pandoc", "pandoc tool");
    expect(bias.applyCorrections("open pandoc")).toBe("open pandoc tool");
    expect(disk.get(KEY)).toHaveLength(1);
  });

  it("never keeps a secret", async () => {
    const bias = await fresh();
    expect(bias.learnCorrection("my password is abc", "my password is abd")).toBeNull();
    expect(disk.get(KEY) ?? []).toEqual([]);
  });

  it("keeps the newest forty and drops the oldest", async () => {
    const bias = await fresh();
    for (let i = 0; i < 45; i += 1) bias.learnCorrection(`word${i}`, `fixed ${i}`);
    const saved = disk.get(KEY) as { from: string }[];
    expect(saved).toHaveLength(40);
    expect(saved[0]?.from).toBe("word5");
  });

  it("reset clears the saved list too", async () => {
    const bias = await fresh();
    bias.learnCorrection("a word", "A word");
    bias.resetCorrections();
    expect(disk.get(KEY)).toEqual([]);
    expect((await fresh()).applyCorrections("a word")).toBe("a word");
  });
});
