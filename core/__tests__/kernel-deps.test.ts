/**
 * An update that adds a Python package to kernel/requirements.txt gets it
 * installed once, in the background, into the managed environment — and a
 * failure never repeats on every start or blocks it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const deps = require_(path.resolve(import.meta.dirname, "../../electron/kernel-deps.cjs"));

let root = "";
let file = "";
const python = { exe: "py", prefix: ["-3"], executable: "C:/FRIDAY/py312/python.exe" };
const write = (text: string) => fs.writeFileSync(file, text);
const ok = (calls: string[][]) => async (_exe: string, args: string[]) => {
  calls.push(args);
  return { code: 0, out: "installed" };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-deps-"));
  file = path.join(root, "requirements.txt");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("requirements hash", () => {
  it("ignores comments, blank lines and line endings but not a new package", () => {
    write("fastapi>=1\n# note\n\npy7zr>=1 # inline\n");
    const first = deps.hashRequirements(file);
    write("fastapi>=1\r\npy7zr>=1\r\n");
    expect(deps.hashRequirements(file)).toBe(first);
    write("fastapi>=1\npy7zr>=1\nnewpkg>=2\n");
    expect(deps.hashRequirements(file)).not.toBe(first);
  });
});

describe("syncing after an update", () => {
  it("installs on the first run, records it, and then does nothing", async () => {
    write("fastapi>=1\n");
    const calls: string[][] = [];
    const first = await deps.syncKernelDeps({ root, file, python, run: ok(calls) });
    expect(first).toMatchObject({ ok: true, installed: true });
    expect(calls[0]).toEqual([
      "-3",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--prefer-binary",
      "-r",
      file,
    ]);
    const again = await deps.syncKernelDeps({ root, file, python, run: ok(calls) });
    expect(again).toMatchObject({ ok: true, skipped: true, current: true });
    expect(calls).toHaveLength(1);
  });

  it("installs again only when the requirements changed", async () => {
    write("fastapi>=1\n");
    const calls: string[][] = [];
    await deps.syncKernelDeps({ root, file, python, run: ok(calls) });
    write("fastapi>=1\nnewpkg>=2\n");
    expect(deps.status({ root, file })).toMatchObject({
      needed: true,
      reason: "requirements changed",
    });
    const out = await deps.syncKernelDeps({ root, file, python, run: ok(calls) });
    expect(out.installed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("remembers a failure for a day, then tries again, and keeps the old record", async () => {
    write("fastapi>=1\n");
    const calls: string[][] = [];
    await deps.syncKernelDeps({ root, file, python, run: ok(calls) });
    write("fastapi>=1\nbroken>=9\n");
    const now = 1_000_000;
    const fail = async () => ({ code: 1, out: "ERROR: no matching distribution for broken" });
    const out = await deps.syncKernelDeps({ root, file, python, run: fail, now });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no matching distribution");
    expect(deps.status({ root, file, now: now + 3_600_000 })).toMatchObject({
      needed: false,
      reason: "failed recently",
    });
    expect(deps.status({ root, file, now: now + 25 * 3_600_000 }).needed).toBe(true);
    // The earlier success is still on record.
    const stamp = JSON.parse(fs.readFileSync(path.join(root, deps.STAMP), "utf8"));
    expect(stamp.hash).toBeTruthy();
    expect(stamp.failed.error).toContain("broken");
  });

  it("does nothing, and says why, without a managed Python or a requirements file", async () => {
    write("fastapi>=1\n");
    const calls: string[][] = [];
    expect(await deps.syncKernelDeps({ root, file, python: null, run: ok(calls) })).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(
      await deps.syncKernelDeps({
        root,
        file: path.join(root, "none.txt"),
        python,
        run: ok(calls),
      }),
    ).toMatchObject({ ok: true, skipped: true });
    expect(calls).toHaveLength(0);
  });
});

describe("running pip", () => {
  it("reports the exit code and output of a real process, and never throws", async () => {
    const done = await deps.runPip(process.execPath, ["-e", "console.log('hello')"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("hello");
    const missing = await deps.runPip(path.join(root, "no-such-python"), []);
    expect(missing.code).toBeLessThan(0);
  });

  it("stops a run that hangs", async () => {
    const out = await deps.runPip(process.execPath, ["-e", "setTimeout(()=>{},20000)"], {
      timeoutMs: 300,
    });
    expect(out.code).toBe(-2);
    expect(out.out).toContain("timed out");
  }, 10_000);
});

describe("wired into the installed app only", () => {
  const main = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../electron/main.cjs"),
    "utf8",
  );
  it("runs a minute after start and asks for a restart when packages were installed", () => {
    expect(main).toContain('id: "kernel-deps"');
    expect(main).toContain(
      "if (app.isPackaged) setTimeout(() => void syncKernelDepsNow(), 60_000)",
    );
    expect(main).toContain("New Python packages were installed for this version");
  });
});
