/**
 * Manual chat levels: Compact (1), Expanded (2), Full chat (3). Pure rules
 * plus the shared store with an injected reader/writer — no window, no date.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_LEVEL_KEY,
  COMPACT_MESSAGE_COUNT,
  DEFAULT_CHAT_LEVEL,
  circuitDesignSize,
  circuitFitScale,
  clampChatLevel,
  createChatLevelStore,
  followsLatest,
  levelForKey,
  nextChatLevel,
  previousChatLevel,
  secondaryFit,
  toolbarFit,
  visibleMessages,
  type ChatLevel,
} from "../../src/lib/friday/chat-level";

const key = (over: Partial<Parameters<typeof levelForKey>[0]>) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: "1",
  ...over,
});

describe("chat level rules", () => {
  it("defaults to Compact under its own versioned key", () => {
    expect(DEFAULT_CHAT_LEVEL).toBe(1);
    expect(CHAT_LEVEL_KEY).toBe("friday.chat.level.v1");
  });

  it("clamps every stored value to 1, 2 or 3", () => {
    expect(clampChatLevel(1)).toBe(1);
    expect(clampChatLevel(2)).toBe(2);
    expect(clampChatLevel(3)).toBe(3);
    expect(clampChatLevel("2")).toBe(2);
    for (const bad of [
      0,
      4,
      -1,
      2.5,
      NaN,
      Infinity,
      "",
      "x",
      "3x",
      null,
      undefined,
      {},
      [2],
      true,
    ]) {
      expect(clampChatLevel(bad)).toBe(1);
    }
  });

  it("steps next and previous without wrapping", () => {
    expect(nextChatLevel(1)).toBe(2);
    expect(nextChatLevel(2)).toBe(3);
    expect(nextChatLevel(3)).toBe(3);
    expect(previousChatLevel(3)).toBe(2);
    expect(previousChatLevel(2)).toBe(1);
    expect(previousChatLevel(1)).toBe(1);
    expect(nextChatLevel(9 as ChatLevel)).toBe(2);
  });

  it("shows the last four at Compact, everything at Expanded, Full chat and in a search", () => {
    const list = Array.from({ length: 500 }, (_, i) => i);
    expect(visibleMessages(list, 1, false)).toEqual([496, 497, 498, 499]);
    expect(visibleMessages(list, 1, false)).toHaveLength(COMPACT_MESSAGE_COUNT);
    expect(visibleMessages(list, 2, false)).toHaveLength(500);
    expect(visibleMessages(list, 3, false)).toHaveLength(500);
    expect(visibleMessages(list, 1, true)).toHaveLength(500);
    expect(visibleMessages([], 1, false)).toEqual([]);
  });

  it("maps only Alt+1/2/3 to a level, never Ctrl or Shift combinations", () => {
    expect(levelForKey(key({ key: "1" }))).toBe(1);
    expect(levelForKey(key({ key: "2" }))).toBe(2);
    expect(levelForKey(key({ key: "¡", code: "Digit3" }))).toBe(3);
    expect(levelForKey(key({ key: "4" }))).toBeNull();
    expect(levelForKey(key({ altKey: false }))).toBeNull();
    expect(levelForKey(key({ ctrlKey: true }))).toBeNull();
    expect(levelForKey(key({ shiftKey: true }))).toBeNull();
    expect(levelForKey(key({ metaKey: true }))).toBeNull();
    expect(levelForKey(key({ key: " ", code: "Space" }))).toBeNull();
  });
});

describe("chat level store", () => {
  const io = (initial: unknown) => {
    const writes: ChatLevel[] = [];
    let stored = initial;
    return {
      writes,
      io: {
        read: () => stored,
        write: (level: ChatLevel) => {
          stored = level;
          writes.push(level);
        },
      },
    };
  };

  it("loads the remembered level, so it survives a restart", () => {
    const disk = io(3);
    expect(createChatLevelStore(disk.io).getSnapshot()).toBe(3);
    const first = io(1);
    const store = createChatLevelStore(first.io);
    store.set(2);
    // A new store on the same storage is the next app start.
    expect(createChatLevelStore(first.io).getSnapshot()).toBe(2);
  });

  it("falls back to Compact on a corrupt value or a reader that throws", () => {
    expect(createChatLevelStore(io("{broken").io).getSnapshot()).toBe(1);
    expect(createChatLevelStore(io({ level: 3 }).io).getSnapshot()).toBe(1);
    const throwing = createChatLevelStore({
      read: () => {
        throw new Error("corrupt");
      },
      write: () => undefined,
    });
    expect(throwing.getSnapshot()).toBe(1);
  });

  it("notifies subscribers once per real change and writes only real changes", () => {
    const disk = io(null);
    const store = createChatLevelStore(disk.io);
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.set(1);
    expect(calls).toBe(0);
    store.next();
    store.next();
    store.next();
    expect(store.getSnapshot()).toBe(3);
    store.previous();
    store.set("bogus");
    expect(store.getSnapshot()).toBe(1);
    expect(disk.writes).toEqual([2, 3, 2, 1]);
    expect(calls).toBe(4);
    off();
    store.set(3);
    expect(calls).toBe(4);
    expect(store.getServerSnapshot()).toBe(1);
  });
});

describe("transcript follows the newest message only when it should", () => {
  it("keeps following at the bottom, stops when the owner scrolls up", () => {
    const prev = { first: "a", last: "b", lastRole: "friday" };
    expect(followsLatest(true, prev, { ...prev, last: "c" })).toBe(true);
    expect(followsLatest(false, prev, { ...prev, last: "c", lastRole: "friday" })).toBe(false);
    expect(followsLatest(false, prev, prev)).toBe(false);
  });

  it("jumps for a sent message or a different conversation", () => {
    const prev = { first: "a", last: "b", lastRole: "friday" };
    expect(followsLatest(false, prev, { first: "a", last: "u1", lastRole: "user" })).toBe(true);
    expect(followsLatest(false, prev, { first: "z", last: "y", lastRole: "friday" })).toBe(true);
  });
});

describe("toolbar overflow decision", () => {
  it("keeps everything when it fits and reserves room for More otherwise", () => {
    expect(toolbarFit([50, 50, 50], 150, 30)).toBe(3);
    expect(toolbarFit([50, 50, 50], 149, 30)).toBe(2);
    expect(toolbarFit([50, 50, 50], 79, 30)).toBe(0);
    expect(toolbarFit([], 0, 30)).toBe(0);
  });

  it("shows every secondary button on a wide chat and moves the last ones first", () => {
    expect(secondaryFit(0)).toBe(4);
    expect(secondaryFit(1000)).toBe(4);
    // With labels on, everything fits, so labels never push a button into More.
    expect(secondaryFit(752)).toBe(4);
    const narrow = secondaryFit(360);
    expect(narrow).toBeLessThan(4);
    expect(narrow).toBeGreaterThanOrEqual(0);
    // Within one label mode, a wider toolbar never shows fewer buttons.
    for (const [from, to] of [
      [200, 751],
      [752, 1400],
    ] as const) {
      let last = secondaryFit(from);
      for (let w = from; w <= to; w += 7) {
        expect(secondaryFit(w)).toBeGreaterThanOrEqual(last);
        last = secondaryFit(w);
      }
    }
  });
});

describe("Expanded graphic scale", () => {
  it("never enlarges and is 1 when the stage is big enough", () => {
    expect(circuitFitScale(0, 0, 680)).toBe(1);
    expect(circuitFitScale(2000, 2000, 680)).toBe(1);
    const need = circuitDesignSize(680);
    expect(circuitFitScale(need.width, need.height, 680)).toBe(1);
  });

  it("scales down with the shorter side and keeps the scaled graphic inside the stage", () => {
    for (const [w, h, vh] of [
      [900, 220, 680],
      [1000, 180, 680],
      [600, 400, 1080],
      [1200, 260, 1440],
    ] as const) {
      const scale = circuitFitScale(w, h, vh);
      const need = circuitDesignSize(vh);
      expect(scale).toBeLessThan(1);
      expect(need.height * scale).toBeLessThanOrEqual(h + 0.5);
      expect(need.width * scale).toBeLessThanOrEqual(w + 0.5);
    }
  });

  it("needs room for seven box rows and the vh-capped mark", () => {
    const small = circuitDesignSize(680);
    // 7 boxes per side at a 13% pitch, each ~38px tall.
    expect(small.height * 0.13).toBeGreaterThanOrEqual(38);
    const tall = circuitDesignSize(1600);
    expect(tall.height).toBeGreaterThanOrEqual(420 + 16);
  });
});
