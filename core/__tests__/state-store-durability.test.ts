/**
 * Durable state files (electron/state-store.cjs): every save is flushed to disk before it replaces the file, the
 * previous good body is kept as a rolling `.bak`, and a file that reads back empty or corrupt is set aside (never
 * deleted) and replaced from that `.bak` instead of silently becoming "no state".
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
type Result = { ok: boolean; reason: string | null; backup: string | null };
const store = require_("../../electron/state-store.cjs") as {
  commitState: (file: string, value: unknown, opts?: Record<string, unknown>) => Result;
  commitStateAsync: (
    file: string,
    value: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<Result>;
  readState: (file: string, opts?: Record<string, unknown>) => unknown;
  restoreState: (file: string) => { ok: boolean; body?: unknown; reason?: string };
};

const dirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-state-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
const names = (dir: string) => fs.readdirSync(dir).sort();
const corruptCopies = (dir: string) => names(dir).filter((name) => name.includes(".corrupt-"));

describe("a save is flushed before it replaces the file", () => {
  it("synchronous: fsync of the temporary file comes before the rename", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    const calls: string[] = [];
    const spy = {
      ...fs,
      fsyncSync: (fd: number) => {
        calls.push("fsync");
        return fs.fsyncSync(fd);
      },
      renameSync: (from: string, to: string) => {
        calls.push("rename");
        return fs.renameSync(from, to);
      },
    };
    const result = store.commitState(file, { items: [1] }, { fsApi: spy });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["fsync", "rename"]);
    expect(read(file)).toEqual({ items: [1] });
    expect(names(dir)).toEqual(["memory.json"]);
  });

  it("asynchronous: the handle is synced before the rename", async () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    const calls: string[] = [];
    const spy = {
      ...fs.promises,
      open: async (target: string, flags: string) => {
        const handle = await fs.promises.open(target, flags);
        return {
          writeFile: (data: string) => handle.writeFile(data),
          sync: async () => {
            calls.push("fsync");
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: async (from: string, to: string) => {
        calls.push("rename");
        return fs.promises.rename(from, to);
      },
    };
    const result = await store.commitStateAsync(file, { items: [1] }, { fsApi: spy });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["fsync", "rename"]);
    expect(read(file)).toEqual({ items: [1] });
    expect(names(dir)).toEqual(["memory.json"]);
  });
});

describe("the rolling .bak", () => {
  it("keeps the previous good body when the version did not change (sync and async)", async () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    store.commitState(file, { items: [1] });
    store.commitState(file, { items: [1, 2] });
    expect(read(`${file}.bak`)).toEqual({ items: [1] });
    await store.commitStateAsync(file, { items: [1, 2, 3] });
    expect(read(`${file}.bak`)).toEqual({ items: [1, 2] });
    expect(read(file)).toEqual({ items: [1, 2, 3] });
    expect(names(dir)).toEqual(["memory.json", "memory.json.bak"]);
  });

  it("a version change still keeps the older body, and readState gives it back when the file is lost", () => {
    const dir = scratch();
    const file = path.join(dir, "chat.json");
    store.commitState(file, { version: 1, note: "old" }, { now: 5 });
    const moved = store.commitState(file, { version: 2, note: "new" }, { now: 6 });
    expect(moved.backup).toBe(`${file}.bak`);
    expect((read(`${file}.bak`) as { body: unknown }).body).toEqual({ version: 1, note: "old" });
    fs.writeFileSync(file, "");
    expect(store.readState(file)).toEqual({ version: 1, note: "old" });
  });

  it("an empty or damaged file never replaces a good .bak on the next save", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    store.commitState(file, { items: [1] });
    store.commitState(file, { items: [1, 2] });
    fs.writeFileSync(file, "");
    store.commitState(file, { items: [9] });
    expect(read(`${file}.bak`)).toEqual({ items: [1] });
    expect(read(file)).toEqual({ items: [9] });
  });
});

describe("reading a file that is empty or corrupt", () => {
  it("sets the file aside and restores the last good body from the .bak", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    store.commitState(file, { items: [1] });
    store.commitState(file, { items: [1, 2] });
    fs.writeFileSync(file, "");
    expect(store.readState(file, { now: 1234 })).toEqual({ items: [1] });
    expect(read(file)).toEqual({ items: [1] });
    expect(corruptCopies(dir)).toEqual(["memory.json.corrupt-1234"]);
    expect(fs.readFileSync(path.join(dir, "memory.json.corrupt-1234"), "utf8")).toBe("");
  });

  it("keeps a half-written body for inspection and restores from the .bak", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    store.commitState(file, { items: [1] });
    store.commitState(file, { items: [1, 2] });
    fs.writeFileSync(file, '{"items":[1,2');
    expect(store.readState(file, { now: 7 })).toEqual({ items: [1] });
    expect(fs.readFileSync(path.join(dir, "memory.json.corrupt-7"), "utf8")).toBe('{"items":[1,2');
  });

  it("with no .bak the answer is null, the damaged file is still kept, and the next save works", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    fs.writeFileSync(file, "{ not json");
    expect(store.readState(file, { now: 3 })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(corruptCopies(dir)).toEqual(["memory.json.corrupt-3"]);
    store.commitState(file, { items: [1] });
    expect(read(file)).toEqual({ items: [1] });
  });

  it("a missing file is still just null, and a good file is returned as is without a copy", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    expect(store.readState(file)).toBeNull();
    store.commitState(file, { items: [4] });
    expect(store.readState(file)).toEqual({ items: [4] });
    expect(corruptCopies(dir)).toEqual([]);
  });

  it("keeps only the newest few damaged copies", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    for (let stamp = 1; stamp <= 6; stamp += 1) {
      fs.writeFileSync(file, `{ broken ${stamp}`);
      store.readState(file, { now: stamp });
    }
    expect(corruptCopies(dir).length).toBe(3);
    expect(corruptCopies(dir)).toEqual([
      "memory.json.corrupt-4",
      "memory.json.corrupt-5",
      "memory.json.corrupt-6",
    ]);
  });

  it("restoreState accepts both backup shapes and refuses a damaged one", () => {
    const dir = scratch();
    const file = path.join(dir, "memory.json");
    expect(store.restoreState(file)).toEqual({ ok: false, reason: "no-backup" });
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ at: 1, body: { a: 1 } }));
    expect(store.restoreState(file)).toEqual({ ok: true, body: { a: 1 } });
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 2 }));
    expect(store.restoreState(file)).toEqual({ ok: true, body: { a: 2 } });
    fs.writeFileSync(`${file}.bak`, "{ nope");
    expect(store.restoreState(file)).toEqual({ ok: false, reason: "corrupt-state" });
  });
});
