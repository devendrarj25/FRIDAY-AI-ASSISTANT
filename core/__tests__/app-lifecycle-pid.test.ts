import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");

type Identity = { pid?: number; image: string; startTime: string };
type Row = { role: string; pid: number; command: string; image?: string; startTime?: string };
type Registry = {
  track: (role: string, child: { pid?: number }, command: string) => boolean;
  settled: () => Promise<void>;
  list: () => Row[];
  stopAll: (kill?: (pid: number, options?: { command?: string }) => void) => void;
  stopRole: (role: string, kill?: (pid: number, options?: { command?: string }) => void) => void;
};
const owner = require_(path.join(root, "electron/app-lifecycle.cjs")) as {
  createPidRegistry: (options: {
    file?: string;
    inspectProcess?: (pid: number) => Identity | null | undefined;
    inspectProcessAsync?: (pid: number) => Promise<Identity | null | undefined>;
    inspectProcesses?: (pids: number[]) => Map<number, Identity | null | undefined> | undefined;
    fsImpl?: Record<string, unknown>;
  }) => Registry;
  inspectProcess: (pid: number, options?: Record<string, unknown>) => Identity | null | undefined;
  inspectProcessAsync: (
    pid: number,
    options?: Record<string, unknown>,
  ) => Promise<Identity | null | undefined>;
  inspectProcesses: (
    pids: number[],
    options?: Record<string, unknown>,
  ) => Map<number, Identity | null | undefined> | undefined;
};

// A pid that is alive on this machine, so a kill decision never rests on the real process table.
const LIVE_PID = process.pid;

function table(initial: Record<number, Identity | null | undefined>) {
  const rows = { ...initial };
  return {
    rows,
    inspect: (pid: number) => rows[pid],
  };
}

function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (file: string, data: string) => void files.set(file, data),
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    readFileSync: (file: string) => {
      const data = files.get(file);
      if (data === undefined) throw new Error("ENOENT");
      return data;
    },
  };
}

describe("pid registry identity (fake process table; nothing here ran on Windows)", () => {
  it("stores role, pid, image name and start time for a tracked child", async () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "2026-01-01T00:00:00Z" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    expect(registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py")).toBe(true);
    await registry.settled();
    expect(registry.list()).toEqual([
      {
        role: "kernel",
        command: "python kernel/main.py",
        pid: LIVE_PID,
        image: "python.exe",
        startTime: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("kills when the live process still has the recorded image and start time", async () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await registry.settled();
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([LIVE_PID]);
    expect(registry.list()).toEqual([]);
  });

  it("does not kill a stranger that reused the pid, and drops the stale entry", async () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await registry.settled();
    // The kernel died; Windows gave its pid to another program that started later.
    fake.rows[LIVE_PID] = { image: "chrome.exe", startTime: "T2" };
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("needs both to match: same image with a new start time, or same start time with a new image", async () => {
    for (const reused of [
      { image: "python.exe", startTime: "T2" },
      { image: "node.exe", startTime: "T1" },
    ]) {
      const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
      const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
      registry.track("tts", { pid: LIVE_PID }, "python tts.py");
      await registry.settled();
      fake.rows[LIVE_PID] = reused;
      const killed: number[] = [];
      registry.stopRole("tts", (pid) => void killed.push(pid));
      expect(killed).toEqual([]);
      expect(registry.list()).toEqual([]);
    }
  });

  it("compares the image name without case or a trailing .exe", async () => {
    const fake = table({ [LIVE_PID]: { image: "Python.EXE", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("stt", { pid: LIVE_PID }, "python stt.py");
    await registry.settled();
    fake.rows[LIVE_PID] = { image: "python", startTime: "T1" };
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([LIVE_PID]);
  });

  it("drops an entry whose process is gone without killing", async () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await registry.settled();
    fake.rows[LIVE_PID] = null;
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("never kills when the table cannot be read now but identity was recorded", async () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await registry.settled();
    fake.rows[LIVE_PID] = undefined;
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
  });

  it("never kills a row with no identity while the table cannot be read", async () => {
    const fake = table({ [LIVE_PID]: undefined });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await registry.settled();
    expect(registry.list()[0]).not.toHaveProperty("startTime");
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
  });

  it("checks identity for rows reloaded from a registry file left by an earlier run", async () => {
    const fsImpl = memoryFs();
    const first = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const writer = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcess: first.inspect,
    });
    writer.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    await writer.settled();
    // The app exited without cleanup; on the next run the pid belongs to something else.
    const second = table({ [LIVE_PID]: { image: "notepad.exe", startTime: "T9" } });
    const reader = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcess: second.inspect,
    });
    expect(reader.list()).toHaveLength(1);
    const killed: number[] = [];
    reader.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(reader.list()).toEqual([]);
    expect(JSON.parse(fsImpl.files.get("owned.json") ?? "{}")).toEqual({ pids: [] });
  });

  it("still never signals an owner runtime or a role it does not own", async () => {
    const fake = table({ [LIVE_PID]: { image: "ollama.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    expect(registry.track("kernel", { pid: LIVE_PID }, "C:\\Ollama\\ollama.exe")).toBe(false);
    expect(registry.track("random", { pid: LIVE_PID }, "x.exe")).toBe(true);
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
  });

  it("drops a legacy row (no identity) when the table is readable, instead of trusting the bare pid", async () => {
    const fsImpl = memoryFs();
    fsImpl.files.set(
      "owned.json",
      JSON.stringify({
        pids: [{ role: "kernel", command: "python kernel/main.py", pid: LIVE_PID }],
      }),
    );
    const fake = table({ [LIVE_PID]: { image: "chrome.exe", startTime: "T2" } });
    const registry = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcess: fake.inspect,
    });
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});

describe("track() never waits on the process table (slow fake; nothing here ran on Windows)", () => {
  function deferred() {
    let resolve: (value: Identity | null | undefined) => void = () => {};
    const promise = new Promise<Identity | null | undefined>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("returns at once, and fills the row and rewrites the file when the read comes back", async () => {
    const fsImpl = memoryFs();
    const slow = deferred();
    const registry = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcessAsync: () => slow.promise,
      inspectProcesses: () => new Map(),
    });
    expect(registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py")).toBe(true);
    expect(registry.list()).toEqual([
      { role: "kernel", command: "python kernel/main.py", pid: LIVE_PID },
    ]);
    expect(JSON.parse(fsImpl.files.get("owned.json") ?? "{}").pids[0]).not.toHaveProperty("image");
    slow.resolve({ image: "python.exe", startTime: "T1" });
    await registry.settled();
    expect(registry.list()[0]).toMatchObject({ image: "python.exe", startTime: "T1" });
    expect(JSON.parse(fsImpl.files.get("owned.json") ?? "{}").pids[0]).toMatchObject({
      image: "python.exe",
      startTime: "T1",
    });
  });

  it("does not bring back a row whose child exited before the read returned", async () => {
    const slow = deferred();
    const registry = owner.createPidRegistry({
      inspectProcessAsync: () => slow.promise,
      inspectProcesses: () => new Map(),
    });
    const exit: { fn: (() => void) | null } = { fn: null };
    registry.track(
      "sandbox",
      { pid: LIVE_PID, once: (_e: string, fn: () => void) => (exit.fn = fn) } as never,
      "node job.js",
    );
    exit.fn?.();
    slow.resolve({ image: "node.exe", startTime: "T1" });
    await registry.settled();
    expect(registry.list()).toEqual([]);
  });

  it("a read that never answers leaves a legacy row that only an image match can stop", async () => {
    for (const [live, expected] of [
      [{ image: "node.exe", startTime: "T9" }, [LIVE_PID]],
      [{ image: "chrome.exe", startTime: "T9" }, []],
    ] as const) {
      const registry = owner.createPidRegistry({
        inspectProcessAsync: () => new Promise(() => {}),
        inspectProcesses: () => new Map([[LIVE_PID, live]]),
      });
      registry.track("sandbox", { pid: LIVE_PID }, "node scripts/job.js");
      const killed: number[] = [];
      registry.stopAll((pid) => void killed.push(pid));
      expect(killed).toEqual(expected);
      expect(registry.list()).toEqual([]);
    }
  });

  it("reads every recorded pid in one table call at stop, and kills only the matches", async () => {
    const live: Record<number, Identity | null> = {
      101: { image: "python.exe", startTime: "A" },
      102: { image: "chrome.exe", startTime: "B" },
      103: null,
    };
    const calls: number[][] = [];
    const registry = owner.createPidRegistry({
      inspectProcessAsync: async (pid) => ({
        image: "python.exe",
        startTime: pid === 101 ? "A" : "Z",
      }),
      inspectProcesses: (pids) => {
        calls.push([...pids]);
        return new Map(pids.map((pid) => [pid, live[pid]]));
      },
    });
    for (const pid of [101, 102, 103]) registry.track("kernel", { pid }, "python kernel/main.py");
    await registry.settled();
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(calls).toEqual([[101, 102, 103]]);
    expect(killed).toEqual([101]);
    expect(registry.list()).toEqual([]);
  });
});

describe("a row with no identity (an older version's file, or a read that timed out)", () => {
  function legacy(command: string, live: Identity | null | undefined) {
    const fsImpl = memoryFs();
    fsImpl.files.set(
      "owned.json",
      JSON.stringify({ pids: [{ role: "kernel", command, pid: LIVE_PID }] }),
    );
    const registry = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcess: () => live,
    });
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    return { killed, registry };
  }

  it("is killed when the live image is the program named by the command", () => {
    expect(legacy("python kernel/main.py", { image: "python.exe", startTime: "T" }).killed).toEqual(
      [LIVE_PID],
    );
    expect(
      legacy('"C:\\Py 3\\Python.exe" -m x', { image: "python", startTime: "T" }).killed,
    ).toEqual([LIVE_PID]);
    expect(
      legacy("C:\\Program Files\\Friday\\kernel.exe --port 1", { image: "kernel", startTime: "T" })
        .killed,
    ).toEqual([LIVE_PID]);
  });

  it("is dropped without a kill when the pid was reused by another program", () => {
    const run = legacy("python kernel/main.py", { image: "chrome.exe", startTime: "T" });
    expect(run.killed).toEqual([]);
    expect(run.registry.list()).toEqual([]);
  });

  it("is dropped without a kill when the process is gone, or the command names no program", () => {
    expect(legacy("python kernel/main.py", null).killed).toEqual([]);
    expect(legacy("", { image: "python.exe", startTime: "T" }).killed).toEqual([]);
  });

  it("is never killed while the table cannot be read", () => {
    const run = legacy("python kernel/main.py", undefined);
    expect(run.killed).toEqual([]);
  });
});

describe("process table readers: one call per stop, asynchronous at track (canned output)", () => {
  it("inspectProcesses asks PowerShell once for all pids and parses one line per live pid", () => {
    const calls: string[][] = [];
    const out = owner.inspectProcesses([11, 12, 13], {
      platform: "win32",
      execFile: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return "11|python|639000000000000001\r\n13|my|app|639000000000000003\r\n";
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).toContain("Get-Process -Id 11,12,13");
    expect(out?.get(11)).toEqual({ image: "python", startTime: "639000000000000001" });
    expect(out?.get(12)).toBeNull();
    expect(out?.get(13)).toEqual({ image: "my|app", startTime: "639000000000000003" });
  });

  it("inspectProcesses marks a pid whose start time cannot be read as unreadable, and a failed call as unreadable", () => {
    const part = owner.inspectProcesses([21, 22], {
      platform: "win32",
      execFile: () => "21|system|\r\n22|python|5\r\n",
    });
    expect(part?.get(21)).toBeUndefined();
    expect(part?.has(21)).toBe(true);
    expect(part?.get(22)).toEqual({ image: "python", startTime: "5" });
    expect(
      owner.inspectProcesses([21], {
        platform: "win32",
        execFile: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeUndefined();
  });

  it("inspectProcessAsync never calls the synchronous runner and times out to unreadable", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const live = await owner.inspectProcessAsync(4242, {
      platform: "win32",
      execFile: () => {
        throw new Error("the synchronous runner must not be used");
      },
      execFileAsync: async (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
        seen.push(opts);
        return "python|639000000000000000\r\n";
      },
    });
    expect(live).toEqual({ image: "python", startTime: "639000000000000000" });
    expect(seen[0]?.["timeout"]).toBe(4000);
    expect(
      await owner.inspectProcessAsync(4242, {
        platform: "win32",
        execFileAsync: async () => {
          throw Object.assign(new Error("timed out"), { killed: true });
        },
      }),
    ).toBeUndefined();
    expect(
      await owner.inspectProcessAsync(4242, { platform: "win32", execFileAsync: async () => "" }),
    ).toBeNull();
  });
});

describe("inspectProcess readers (canned output, not a real machine)", () => {
  it("reads the Windows process name and creation ticks from the PowerShell answer", () => {
    const calls: string[][] = [];
    const live = owner.inspectProcess(4242, {
      platform: "win32",
      execFile: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return "python|639000000000000000\r\n";
      },
    });
    expect(live).toEqual({ image: "python", startTime: "639000000000000000" });
    expect(calls[0]?.[0]).toBe("powershell.exe");
    expect(calls[0]?.join(" ")).toContain("Get-Process -Id 4242");
    expect(owner.inspectProcess(4242, { platform: "win32", execFile: () => "" })).toBeNull();
    expect(
      owner.inspectProcess(4242, {
        platform: "win32",
        execFile: () => {
          throw new Error("powershell blocked");
        },
      }),
    ).toBeUndefined();
  });

  it("reads the Linux image and start tick from /proc/<pid>/stat, even with spaces and brackets in the name", () => {
    const stat =
      "77 (my (odd) app) S 1 77 77 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 0";
    expect(owner.inspectProcess(77, { platform: "linux", readFile: () => stat })).toEqual({
      image: "my (odd) app",
      startTime: "987654",
    });
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(
      owner.inspectProcess(77, {
        platform: "linux",
        readFile: () => {
          throw missing;
        },
      }),
    ).toBeNull();
    expect(owner.inspectProcess(0, { platform: "linux" })).toBeNull();
  });
});
