/**
 * Settings and durable state are saved without stopping the thread that owns the window. A synchronous write (flush,
 * backup, rename with retries) on a busy disk is long enough for Windows to mark the window "Not Responding" while the
 * owner moves a settings slider. Same guarantees as before: atomic, a backup, retry on a locked file, newest body wins.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Job = {
  write: (v: unknown, c: { shouldCommit: () => boolean }) => Promise<unknown>;
  writeSync?: (v: unknown) => unknown;
  onError?: (e: unknown) => void;
};
const { createWriteQueue } = require_("../../electron/write-queue.cjs") as {
  createWriteQueue: () => {
    submit: (key: string, value: unknown, job: Job) => Promise<unknown>;
    idle: (key: string) => Promise<void>;
    drain: () => Promise<void>;
    flushSync: () => void;
  };
};
const safe = require_("../../electron/safe-write.cjs") as {
  writeFileSafeAsync: (
    file: string,
    data: string,
    opts?: Record<string, unknown>,
  ) => Promise<boolean>;
  writeJsonSafeAsync: (
    file: string,
    value: unknown,
    space?: number,
    opts?: Record<string, unknown>,
  ) => Promise<boolean>;
  renameWithRetryAsync: (from: string, to: string, opts?: Record<string, unknown>) => Promise<void>;
};
const store = require_("../../electron/state-store.cjs") as {
  commitStateAsync: (
    file: string,
    value: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; reason: string | null; backup: string | null }>;
};

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-async-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe("the write queue", () => {
  it("writes only the newest body when changes arrive faster than the disk, and answers every caller", async () => {
    const queue = createWriteQueue();
    const written: unknown[] = [];
    const hold = gate();
    const job: Job = {
      write: async (value) => {
        if (written.length === 0) await hold.promise;
        written.push(value);
        return true;
      },
    };
    const first = queue.submit("prefs", 1, job);
    const rest = [2, 3, 4, 5].map((v) => queue.submit("prefs", v, job));
    hold.open();
    expect(await Promise.all([first, ...rest])).toEqual([true, true, true, true, true]);
    // The first write was already running; the four after it collapsed into one.
    expect(written).toEqual([1, 5]);
  });

  it("keeps different files apart, and idle() waits for a file's own writes", async () => {
    const queue = createWriteQueue();
    const log: string[] = [];
    const hold = gate();
    const slow: Job = {
      write: async () => {
        await hold.promise;
        log.push("a");
        return true;
      },
    };
    const fast: Job = {
      write: async () => {
        log.push("b");
        return true;
      },
    };
    const a = queue.submit("a", 1, slow);
    await queue.submit("b", 1, fast);
    expect(log).toEqual(["b"]);
    let idle = false;
    const waiting = queue.idle("a").then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    hold.open();
    await a;
    await waiting;
    expect(idle).toBe(true);
    expect(log).toEqual(["b", "a"]);
  });

  it("on close writes what is waiting with the synchronous writer and stops an older write from landing over it", async () => {
    const queue = createWriteQueue();
    const hold = gate();
    const events: string[] = [];
    let commitAllowed: (() => boolean) | null = null;
    const job = (name: string): Job => ({
      write: async (value, { shouldCommit }) => {
        commitAllowed = shouldCommit;
        await hold.promise;
        events.push(`async ${name} ${String(value)} commit=${shouldCommit()}`);
        return shouldCommit();
      },
      writeSync: (value) => {
        events.push(`sync ${name} ${String(value)}`);
        return true;
      },
    });
    const running = queue.submit("k", "old", job("k"));
    const waiting = queue.submit("k", "new", job("k"));
    queue.flushSync();
    expect(events).toEqual(["sync k new"]);
    expect(await waiting).toBe(true);
    hold.open();
    // The write that was already running must not publish the older body.
    expect(await running).toBe(false);
    expect(commitAllowed).not.toBeNull();
    expect(events.at(-1)).toBe("async k old commit=false");
  });

  it("a failing write is reported and does not stop the next one", async () => {
    const queue = createWriteQueue();
    const errors: unknown[] = [];
    const bad = await queue.submit("k", 1, {
      write: async () => {
        throw new Error("disk full");
      },
      onError: (e) => errors.push(e),
    });
    expect(bad).toBe(false);
    expect(errors).toHaveLength(1);
    expect(await queue.submit("k", 2, { write: async () => true })).toBe(true);
  });
});

describe("the asynchronous safe write", () => {
  it("writes the body, keeps the previous good one as .bak and leaves no temporary file", async () => {
    const dir = tmp();
    const file = path.join(dir, "preferences.json");
    await safe.writeJsonSafeAsync(file, { a: 1 });
    await safe.writeJsonSafeAsync(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ a: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual(["preferences.json", "preferences.json.bak"]);
  });

  it("retries a rename that an antivirus scanner holds for a moment, with a timer and not a blocking wait", async () => {
    const dir = tmp();
    const from = path.join(dir, "a.tmp");
    const to = path.join(dir, "a.json");
    fs.writeFileSync(from, "x");
    let calls = 0;
    const waits: number[] = [];
    const fsApi = {
      rename: async (a: string, b: string) => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        return fs.promises.rename(a, b);
      },
    };
    await safe.renameWithRetryAsync(from, to, {
      fsApi,
      wait: async (ms: number) => void waits.push(ms),
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([15, 30]);
    expect(fs.readFileSync(to, "utf8")).toBe("x");
  });

  it("does not publish when a newer save took over (shouldCommit is false) and removes its temporary file", async () => {
    const dir = tmp();
    const file = path.join(dir, "s.json");
    fs.writeFileSync(file, '{"v":"new"}');
    const published = await safe.writeFileSafeAsync(file, '{"v":"old"}', {
      shouldCommit: () => false,
    });
    expect(published).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('{"v":"new"}');
    expect(fs.readdirSync(dir)).toEqual(["s.json"]);
  });
});

describe("the asynchronous durable state commit", () => {
  it("publishes a body, and a version change keeps the previous body beside it", async () => {
    const dir = tmp();
    const file = path.join(dir, "chat.json");
    await store.commitStateAsync(file, { version: 1, items: [1] }, { now: 5 });
    const result = await store.commitStateAsync(file, { version: 2, items: [1, 2] }, { now: 6 });
    expect(result.ok).toBe(true);
    expect(result.backup).toBe(`${file}.bak`);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).body).toEqual({
      version: 1,
      items: [1],
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(2);
  });

  it("does not read or parse the old file for a body without a version, and does not publish a superseded one", async () => {
    const dir = tmp();
    const file = path.join(dir, "memory.json");
    // An old file that is not JSON: a body without a version never needs it, so it is replaced without a parse.
    fs.writeFileSync(file, "{ not json");
    const ok = await store.commitStateAsync(file, { items: [1] });
    expect(ok.ok).toBe(true);
    const superseded = await store.commitStateAsync(
      file,
      { items: [2] },
      { shouldCommit: () => false },
    );
    expect(superseded).toMatchObject({ ok: false, reason: "superseded" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ items: [1] });
    expect(fs.readdirSync(dir)).toEqual(["memory.json"]);
  });
});

describe("where it is used", () => {
  const main = read("electron/main.cjs");

  it("settings and state are saved through the queue, off the thread that owns the window", () => {
    const prefs = main.slice(main.indexOf('ipcMain.handle("prefs:set"'));
    expect(prefs.slice(0, 900)).toContain("persistQueue.submit(");
    expect(prefs.slice(0, 900)).toContain("writeJsonSafeAsync");
    expect(prefs.slice(0, 900)).not.toMatch(/safeWrite\.writeJsonSafe\(file, value\)/);
    const state = main.slice(main.indexOf('ipcMain.handle("state:set"'));
    expect(state.slice(0, 700)).toContain("commitStateAsync");
    // A read waits for a save of the same file that is still on its way.
    expect(main).toContain("await persistQueue.idle(file)");
  });

  it("the sign-in entry is written only when the choice changed, not on every settings save", () => {
    expect(main).toContain("toggles.startup !== appliedStartupChoice");
  });

  it("a toggle check right after a change reads the newest settings, and the shutdown flush writes what is waiting", () => {
    expect(main).toContain("latestPreferences || JSON.parse(");
    const flush = main.slice(main.indexOf("lifeSteps.flush = async"));
    expect(flush.slice(0, 1400)).toContain("persistQueue.flushSync()");
    expect(flush.slice(0, 1400)).toContain("persistQueue.drain()");
  });
});
