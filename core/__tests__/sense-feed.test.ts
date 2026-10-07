import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const feedApi = require("../../electron/sense-feed.cjs") as {
  createSenseFeed: (deps: Record<string, unknown>) => {
    apply: (toggles: Record<string, boolean>, fields?: Record<string, string>) => void;
    stop: () => void;
  };
  FOREGROUND_TITLE_SCRIPT: string;
  readForegroundTitle: () => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const clips = require("../../electron/clipboard-history.cjs") as {
  peek: (input: { text?: string; sourceApp?: string }) => { text: string } | null;
  note: (root: string, text: string, at: number) => { ok: boolean; stored?: boolean };
  load: (root: string) => { text: string }[];
};

type Power = {
  on: (event: string, fn: () => void) => void;
  removeListener: (event: string, fn: () => void) => void;
  emit: (event: string) => void;
  count: (event: string) => number;
};

function fakePower(): Power {
  const map = new Map<string, Array<() => void>>();
  return {
    on(event, fn) {
      const list = map.get(event) ?? [];
      list.push(fn);
      map.set(event, list);
    },
    removeListener(event, fn) {
      map.set(
        event,
        (map.get(event) ?? []).filter((item) => item !== fn),
      );
    },
    emit(event) {
      for (const fn of map.get(event) ?? []) fn();
    },
    count(event) {
      return (map.get(event) ?? []).length;
    },
  };
}

let root: string | null = null;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("sense feed", () => {
  it("stays quiet until a switch is on, and the title command reads no keys or pixels", () => {
    const power = fakePower();
    const folders: string[][] = [];
    let polls = 0;
    const feed = feedApi.createSenseFeed({
      powerMonitor: power,
      watchFolders: (list: string[]) => folders.push(list),
      schedule: () => {
        polls += 1;
      },
    });
    feed.apply({}, {});
    expect(power.count("lock-screen")).toBe(0);
    expect(power.count("suspend")).toBe(0);
    expect(polls).toBe(0);
    expect(folders.at(-1)).toEqual([]);
    expect(feedApi.FOREGROUND_TITLE_SCRIPT).toMatch(/GetWindowText/);
    expect(feedApi.FOREGROUND_TITLE_SCRIPT).not.toMatch(
      /SendKeys|keybd_event|screenshot|BitBlt|PrintWindow|GetDC/i,
    );
    expect(feedApi.readForegroundTitle()).toBe("");
  });

  it("listens for lock only while that switch is on", () => {
    const power = fakePower();
    const events: { sense: string; text: string }[] = [];
    const feed = feedApi.createSenseFeed({
      powerMonitor: power,
      now: () => 50,
      watchFolders: () => undefined,
      emit: (raw: { sense: string; text: string }) => events.push(raw),
    });
    feed.apply({ senseLock: true }, {});
    expect(power.count("lock-screen")).toBe(1);
    expect(power.count("unlock-screen")).toBe(1);
    power.emit("lock-screen");
    expect(events).toEqual([{ sense: "lock", text: "locked", at: 50 }]);
    expect(Object.keys(events[0] ?? {})).toEqual(["sense", "at", "text"]);
    feed.stop();
    expect(power.count("lock-screen")).toBe(0);
    power.emit("lock-screen");
    expect(events).toHaveLength(1);
  });

  it("does not read the clipboard while a password manager is in front", () => {
    const ticks: Array<() => void> = [];
    let reads = 0;
    const events: { text: string }[] = [];
    const notes: string[] = [];
    const feed = feedApi.createSenseFeed({
      now: () => 80,
      foregroundTitle: () => "1Password",
      readClipboard: () => {
        reads += 1;
        return "hunter2";
      },
      noteClip: (text: string) => notes.push(text),
      watchFolders: () => undefined,
      schedule: (_ms: number, fn: () => void) => ticks.push(fn),
      emit: (raw: { text: string }) => events.push(raw),
    });
    feed.apply({ senseClipboard: true }, {});
    expect(ticks).toHaveLength(1);
    ticks[0]?.();
    expect(reads).toBe(0);
    expect(events).toEqual([]);
    expect(notes).toEqual([]);
    expect(clips.peek({ text: "hunter2", sourceApp: "Bitwarden" })).toBeNull();
  });

  it("emits a redacted clipboard line and a title with no screen contents", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sense-"));
    const ticks: Array<() => void> = [];
    const events: { sense: string; text: string }[] = [];
    const folders: string[][] = [];
    const feed = feedApi.createSenseFeed({
      now: () => 90,
      foregroundTitle: () => "Notes\nbody",
      readClipboard: () => "password=hunter2 lunch",
      noteClip: (text: string, at: number) => clips.note(root!, text, at),
      watchFolders: (list: string[]) => folders.push(list),
      schedule: (_ms: number, fn: () => void) => ticks.push(fn),
      emit: (raw: { sense: string; text: string }) => events.push(raw),
    });
    feed.apply(
      { senseClipboard: true, senseForeground: true, senseFolder: true },
      {
        senseFolders: "notes, Desk",
      },
    );
    for (const tick of ticks) tick();
    const clip = events.find((event) => event.sense === "clipboard");
    const title = events.find((event) => event.sense === "foreground");
    expect(clip?.text).toBe("[redacted] lunch");
    expect(clip?.text).not.toContain("hunter2");
    expect(folders.at(-1)).toEqual(["notes", "Desk"]);
    expect(title?.text).toBe("Notes body");
    expect(JSON.stringify(title)).not.toMatch(/screenshot|keystroke/i);
    const stored = clips.load(root);
    expect(stored[0]?.text).toBe("[redacted] lunch");
    expect(stored[0]?.text).not.toContain("hunter2");
  });
});
