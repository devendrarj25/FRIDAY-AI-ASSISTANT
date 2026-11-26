import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");

type Identity = { pid?: number; image: string; startTime: string };
type Row = { role: string; pid: number; command: string; image?: string; startTime?: string };
type Registry = {
  track: (role: string, child: { pid?: number }, command: string) => boolean;
  list: () => Row[];
  stopAll: (kill?: (pid: number, options?: { command?: string }) => void) => void;
  stopRole: (role: string, kill?: (pid: number, options?: { command?: string }) => void) => void;
};
const owner = require_(path.join(root, "electron/app-lifecycle.cjs")) as {
  createPidRegistry: (options: {
    file?: string;
    inspectProcess?: (pid: number) => Identity | null | undefined;
    fsImpl?: Record<string, unknown>;
  }) => Registry;
  inspectProcess: (pid: number, options?: Record<string, unknown>) => Identity | null | undefined;
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
  it("stores role, pid, image name and start time for a tracked child", () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "2026-01-01T00:00:00Z" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    expect(registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py")).toBe(true);
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

  it("kills when the live process still has the recorded image and start time", () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([LIVE_PID]);
    expect(registry.list()).toEqual([]);
  });

  it("does not kill a stranger that reused the pid, and drops the stale entry", () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    // The kernel died; Windows gave its pid to another program that started later.
    fake.rows[LIVE_PID] = { image: "chrome.exe", startTime: "T2" };
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("needs both to match: same image with a new start time, or same start time with a new image", () => {
    for (const reused of [
      { image: "python.exe", startTime: "T2" },
      { image: "node.exe", startTime: "T1" },
    ]) {
      const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
      const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
      registry.track("tts", { pid: LIVE_PID }, "python tts.py");
      fake.rows[LIVE_PID] = reused;
      const killed: number[] = [];
      registry.stopRole("tts", (pid) => void killed.push(pid));
      expect(killed).toEqual([]);
      expect(registry.list()).toEqual([]);
    }
  });

  it("compares the image name without case or a trailing .exe", () => {
    const fake = table({ [LIVE_PID]: { image: "Python.EXE", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("stt", { pid: LIVE_PID }, "python stt.py");
    fake.rows[LIVE_PID] = { image: "python", startTime: "T1" };
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([LIVE_PID]);
  });

  it("drops an entry whose process is gone without killing", () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    fake.rows[LIVE_PID] = null;
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("never kills when the table cannot be read now but identity was recorded", () => {
    const fake = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    fake.rows[LIVE_PID] = undefined;
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
  });

  it("keeps the old pid-alive behaviour only when identity was never readable", () => {
    const fake = table({ [LIVE_PID]: undefined });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    registry.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
    expect(registry.list()[0]).not.toHaveProperty("startTime");
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([LIVE_PID]);
  });

  it("checks identity for rows reloaded from a registry file left by an earlier run", () => {
    const fsImpl = memoryFs();
    const first = table({ [LIVE_PID]: { image: "python.exe", startTime: "T1" } });
    const writer = owner.createPidRegistry({
      file: "owned.json",
      fsImpl,
      inspectProcess: first.inspect,
    });
    writer.track("kernel", { pid: LIVE_PID }, "python kernel/main.py");
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

  it("still never signals an owner runtime or a role it does not own", () => {
    const fake = table({ [LIVE_PID]: { image: "ollama.exe", startTime: "T1" } });
    const registry = owner.createPidRegistry({ inspectProcess: fake.inspect });
    expect(registry.track("kernel", { pid: LIVE_PID }, "C:\\Ollama\\ollama.exe")).toBe(false);
    expect(registry.track("random", { pid: LIVE_PID }, "x.exe")).toBe(true);
    const killed: number[] = [];
    registry.stopAll((pid) => void killed.push(pid));
    expect(killed).toEqual([]);
  });

  it("drops a legacy row (no identity) when the table is readable, instead of trusting the bare pid", () => {
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
