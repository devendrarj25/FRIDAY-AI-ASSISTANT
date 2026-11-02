import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as realFs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const safe = require_("../../electron/safe-write.cjs") as {
  writeFileSafe: (file: string, data: string, o?: Record<string, unknown>) => void;
  writeJsonSafe: (
    file: string,
    value: unknown,
    space?: number,
    o?: Record<string, unknown>,
  ) => void;
  readJsonSafe: (file: string, fallback?: unknown) => { value: unknown; source: string };
  renameWithRetry: (from: string, to: string, o?: Record<string, unknown>) => void;
  WAITS_MS: number[];
};

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-safe-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const locked = (code: string, times: number) => {
  let left = times;
  const calls = { rename: 0, copy: 0 };
  const fsApi = {
    ...realFs,
    renameSync: (from: string, to: string) => {
      calls.rename += 1;
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error("locked"), { code });
      }
      return realFs.renameSync(from, to);
    },
    copyFileSync: (from: string, to: string) => {
      calls.copy += 1;
      return realFs.copyFileSync(from, to);
    },
  };
  return { fsApi, calls };
};

describe("an important file is replaced whole or not at all", () => {
  it("writes the new body, keeps the previous good one as .bak and leaves no temp file", () => {
    const dir = tmp();
    const file = join(dir, "prefs.json");
    safe.writeJsonSafe(file, { a: 1 });
    safe.writeJsonSafe(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the folder when it is missing", () => {
    const file = join(tmp(), "deep", "er", "x.json");
    safe.writeJsonSafe(file, { ok: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true });
  });

  it("leaves the old file untouched when the new body cannot be written", () => {
    const dir = tmp();
    const file = join(dir, "prefs.json");
    safe.writeJsonSafe(file, { keep: "me" });
    const failing = {
      ...realFs,
      writeSync: () => {
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      },
    };
    expect(() => safe.writeFileSafe(file, "{}", { fsApi: failing })).toThrow(/full/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ keep: "me" });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("a Windows lock on the target is waited out, not fatal", () => {
  it("retries a transient rename failure with growing waits", () => {
    const dir = tmp();
    const file = join(dir, "state.json");
    const waits: number[] = [];
    const { fsApi, calls } = locked("EPERM", 3);
    safe.writeFileSafe(file, "one\n", { fsApi, wait: (ms: number) => waits.push(ms) });
    expect(readFileSync(file, "utf8")).toBe("one\n");
    expect(calls.rename).toBe(4);
    expect(waits).toEqual([15, 30, 60]);
  });

  it("copies the body over the target when the lock never lets go", () => {
    const dir = tmp();
    const file = join(dir, "state.json");
    writeFileSync(file, "old");
    const { fsApi, calls } = locked("EBUSY", 99);
    safe.writeFileSafe(file, "new", { fsApi, wait: () => undefined, keepBackup: false });
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(calls.rename).toBe(safe.WAITS_MS.length + 1);
    expect(calls.copy).toBe(1);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("does not retry an error that is not a lock", () => {
    const dir = tmp();
    const { fsApi, calls } = locked("ENOENT", 99);
    expect(() =>
      safe.writeFileSafe(join(dir, "x"), "x", { fsApi, wait: () => undefined }),
    ).toThrow();
    expect(calls.rename).toBe(1);
  });
});

describe("a damaged settings file falls back to the last good one", () => {
  it("reads the file, then its backup, then the fallback", () => {
    const dir = tmp();
    const file = join(dir, "prefs.json");
    expect(safe.readJsonSafe(file, { d: 1 })).toEqual({ value: { d: 1 }, source: "none" });
    safe.writeJsonSafe(file, { v: 1 });
    safe.writeJsonSafe(file, { v: 2 });
    expect(safe.readJsonSafe(file)).toEqual({ value: { v: 2 }, source: "file" });
    writeFileSync(file, '{"v": 3, "half'); // a write cut off in the middle
    expect(safe.readJsonSafe(file)).toEqual({ value: { v: 1 }, source: "backup" });
    writeFileSync(`${file}.bak`, "garbage");
    expect(safe.readJsonSafe(file, null)).toEqual({ value: null, source: "none" });
  });
});

describe("the files that reset the app if lost are written this way", () => {
  const read = (path: string) => realFs.readFileSync(path, "utf8");
  const main = read("electron/main.cjs");

  it("settings, the folder pointer and the workspace settings go through the safe writer, and read back from the backup", () => {
    expect(main).toContain("safeWrite.writeJsonSafe(preferencesFile(), value);");
    expect(main).toContain("safeWrite.readJsonSafe(preferencesFile(), null)");
    expect(main).toContain("safeWrite.writeJsonSafe(bootstrap,");
    expect(main).toContain("safeWrite.writeJsonSafe(file, next);");
    expect(main).toContain("`${file}.bak`");
  });

  it("the library index, the root record, durable state and the workspace record do not truncate in place", () => {
    expect(read("electron/library.cjs")).toContain("writeJsonSafe(indexPath()");
    expect(read("electron/root-registry.cjs")).toContain("writeJsonSafe(file, value)");
    expect(read("electron/state-store.cjs")).toContain("renameWithRetry(tmp, file)");
    expect(read("electron/workspace.cjs")).toContain("writeJsonSafe(file, next)");
  });

  it("shutdown and restart save the page's pending work right after the microphone stops, before any window is destroyed", () => {
    const lifecycle = require_("../../electron/app-lifecycle.cjs") as {
      shutdownPlan: () => { order: string[] };
      restartPlan: () => { order: string[] };
    };
    for (const plan of [lifecycle.shutdownPlan(), lifecycle.restartPlan()]) {
      expect(plan.order[0]).toBe("microphone");
      expect(plan.order[1]).toBe("flush");
      expect(plan.order.indexOf("flush")).toBeLessThan(plan.order.indexOf("windows"));
      expect(plan.order.indexOf("flush")).toBeLessThan(plan.order.indexOf("kernel"));
    }
    expect(main).toMatch(
      /lifeSteps\.flush = async \(\) => \{[\s\S]{0,400}system:suspend[\s\S]{0,200}setTimeout\(resolve, 400\)/,
    );
  });
});
