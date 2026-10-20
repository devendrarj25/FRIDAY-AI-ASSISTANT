import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const life = require_(path.join(root, "electron/app-lifecycle.cjs")) as {
  GRACE_MS: number;
  shutdownPlan: () => { order: string[]; graceMs: number; relaunch: boolean };
  restartPlan: () => { order: string[]; relaunch: string; graceMs: number };
  processesToStop: (list: Array<{ role: string; command?: string; pid?: number }>) => Array<{
    role: string;
  }>;
  isOwnerRuntime: (command: string) => boolean;
  alwaysAsk: (name: string) => boolean;
};

describe("FRIDAY shutdown and restart", () => {
  it("stops only processes FRIDAY owns, in order, inside the deadline", () => {
    const plan = life.shutdownPlan();
    expect(plan.graceMs).toBe(5000);
    expect(plan.graceMs).toBe(life.GRACE_MS);
    expect(plan.order[0]).toBe("microphone");
    expect(plan.order.indexOf("kernel")).toBeGreaterThan(plan.order.indexOf("downloads"));
    expect(plan.order.indexOf("tray")).toBeGreaterThan(plan.order.indexOf("kernel"));
    expect(plan.order[plan.order.length - 1]).toBe("exit");
    const restart = life.restartPlan();
    expect(restart.relaunch).toBe("after-owned-exit");
    expect(restart.order).not.toContain("exit");
    expect(restart.graceMs).toBe(5000);
    const stopped = life.processesToStop([
      { role: "kernel", command: "python kernel/main.py", pid: 11 },
      { role: "stt", command: "python kernel/stt.py", pid: 12 },
      { role: "wake", command: "python kernel/wake_word.py", pid: 13 },
      { role: "terminal", command: "ollama pull llama3.2", pid: 14 },
      {
        role: "kernel",
        command: "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
        pid: 15,
      },
      { role: "browser", command: "LM Studio.exe", pid: 16 },
      { role: "sandbox", command: "node scripts/job.js", pid: 17 },
      { role: "other", command: "notepad.exe", pid: 18 },
    ]);
    expect(stopped.map((row) => row.role)).toEqual(["kernel", "stt", "wake", "sandbox"]);
    expect(life.isOwnerRuntime("ollama serve")).toBe(true);
    expect(life.alwaysAsk("app_shutdown")).toBe(true);
    expect(life.alwaysAsk("app_restart")).toBe(true);
    expect(life.alwaysAsk("fs.read")).toBe(false);
  });

  it("uses one IPC path and always asks before the tool runs", () => {
    const main = read("electron/main.cjs");
    const preload = read("electron/preload.cjs");
    const brain = read("src/lib/friday/brain-engine.ts");
    const shell = read("src/components/friday/AppShell.tsx");
    expect(preload).toContain('ipcRenderer.invoke("app:shutdown"');
    expect(preload).toContain('ipcRenderer.invoke("app:lifecycle-preview")');
    expect(main).toContain('ipcMain.handle("app:shutdown"');
    expect(main).toContain('ipcMain.handle("app:lifecycle-preview"');
    expect(main).toContain("function shutdownFriday");
    expect(main).toContain("function quitFriday");
    expect(main).toContain("approved-tool");
    expect(main).toContain("appLifecycle.alwaysAsk");
    expect(main).toContain("life.requestShutdown");
    expect(main).toContain("life.requestRestart");
    expect(main).toContain("life.exitNow");
    const owner = read("electron/app-lifecycle.cjs");
    expect(owner).toContain("app.relaunch(");
    expect(owner).toContain("app.exit(code)");
    const shutdown = owner.slice(owner.indexOf("async function requestShutdown"));
    const afterCleanup = shutdown.slice(shutdown.indexOf("await runCleanup"));
    expect(afterCleanup).toContain("exitOnce(code)");
    expect(owner).not.toContain("app.quit(");
    expect(brain).toContain("appControlNeedsApproval");
    expect(brain).toContain("shutdownApp");
    expect(shell).toContain("Shutdown FRIDAY");
    expect(shell).toContain('aria-label="Shutdown FRIDAY"');
    expect(shell).toContain("border-destructive/40");
    expect(shell).toContain("!collapsed");
    expect(shell).toContain("Shut down");
    expect(shell).toContain("Cancel");
    expect(shell).toContain("disabled={lifeBusy}");
    expect(shell).toContain("Start at login stays as you set it");
    const tools = read("kernel/tools.py");
    expect(tools).toContain('"app_restart": "exec"');
    expect(tools).toContain('"app_shutdown": "exec"');
    const modelTools = tools.slice(
      tools.indexOf("MODEL_TOOL_PARAMS"),
      tools.indexOf("def wire_name"),
    );
    expect(modelTools).not.toContain("app_restart");
    expect(modelTools).not.toContain("app_shutdown");
    expect(read("config/kernel.yaml")).toMatch(/auto_approve_exec:\s*false/);
  });
});

describe("lifecycle owner", () => {
  const owner = require_(path.join(root, "electron/app-lifecycle.cjs")) as {
    createLifecycle: (options: Record<string, unknown>) => {
      requestShutdown: (reason: string, opts?: { delayMs?: number }) => Promise<boolean>;
      requestRestart: (reason: string) => Promise<boolean>;
      exitNow: (code: number, reason?: string) => boolean;
      hideToBackground: () => boolean;
      reloadRenderer: () => { ok: boolean; action: string; killsProcesses: boolean };
      getState: () => string;
      onSessionEnd: (reason: string) => Promise<boolean>;
    };
    killProcessTree: (pid: number, options?: Record<string, unknown>) => boolean;
    createPidRegistry: (options: { file?: string }) => {
      track: (
        role: string,
        child: { pid?: number; once?: (event: string, fn: () => void) => void },
        command: string,
      ) => boolean;
      list: () => Array<{ role: string; pid: number; command: string }>;
      stopAll: (kill?: (pid: number, options?: { command?: string }) => void) => void;
      stopRole: (
        role: string,
        kill?: (pid: number, options?: { command?: string }) => void,
      ) => void;
    };
    waitForPreviousInstance: (options: Record<string, unknown>) => {
      waited: boolean;
      released: boolean;
    };
  };

  function fakeApp() {
    const calls: string[] = [];
    return {
      calls,
      __fridayQuitting: false,
      quit() {
        calls.push("quit");
      },
      exit(code: number) {
        calls.push(`exit:${code}`);
      },
      relaunch(opts?: { args?: string[] }) {
        calls.push(`relaunch:${(opts && opts.args ? opts.args : []).join(" ")}`);
      },
      releaseSingleInstanceLock() {
        calls.push("unlock");
      },
    };
  }

  it("awaits cleanup and exits once, and a second request is ignored", async () => {
    // Electron app.exit does not emit before-quit or will-quit
    // (https://www.electronjs.org/docs/latest/api/app#appexitexitcode). Calling
    // quit and then exit in the same turn leaves that cleanup unfinished.
    const seen: string[] = [];
    const premature = {
      quit() {
        seen.push("quit");
        setTimeout(() => seen.push("before-quit"), 15);
      },
      exit() {
        seen.push("exit");
      },
    };
    premature.quit();
    premature.exit();
    expect(seen).toEqual(["quit", "exit"]);

    const app = fakeApp();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const life = owner.createLifecycle({
      app,
      setTimer: () => 1,
      clearTimer: () => {},
      steps: {
        microphone: async () => {
          app.calls.push("microphone");
          await gate;
        },
        kernel: async () => {
          app.calls.push("kernel");
        },
      },
    });
    const first = life.requestShutdown("owner");
    expect(app.calls).toEqual(["microphone"]);
    expect(await life.requestShutdown("again")).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(app.calls).toEqual(["microphone", "kernel", "unlock", "exit:0"]);
    expect(app.calls).not.toContain("quit");
    expect(life.getState()).toBe("EXITED");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(seen).toEqual(["quit", "exit", "before-quit"]);
  });

  it("relaunches once after cleanup and forces exit if cleanup hangs", async () => {
    const app = fakeApp();
    const deadline: { fire: (() => void) | null } = { fire: null };
    const hanging = owner.createLifecycle({
      app,
      graceMs: 5000,
      setTimer: (fn: () => void) => {
        deadline.fire = fn;
        return 1;
      },
      clearTimer: () => {
        deadline.fire = null;
      },
      relaunchArgs: () => ["--friday-restart=1"],
      steps: {
        microphone: () => new Promise(() => {}),
      },
    });
    const pending = hanging.requestRestart("hang");
    expect(typeof deadline.fire).toBe("function");
    deadline.fire?.();
    expect(app.calls).toEqual(["relaunch:--friday-restart=1", "unlock", "exit:0"]);
    void pending;

    const app2 = fakeApp();
    let cleared = false;
    const done = owner.createLifecycle({
      app: app2,
      setTimer: () => 1,
      clearTimer: () => {
        cleared = true;
      },
      relaunchArgs: () => ["--workspace", "--friday-restart=1"],
      steps: {
        microphone: async () => {
          app2.calls.push("microphone");
        },
      },
    });
    expect(await done.requestRestart("ok")).toBe(true);
    expect(cleared).toBe(true);
    expect(app2.calls.filter((call) => call.startsWith("exit:")).length).toBe(1);
    expect(app2.calls.filter((call) => call.startsWith("relaunch:")).length).toBe(1);
    expect(app2.calls.indexOf("microphone")).toBeLessThan(
      app2.calls.findIndex((call) => call.startsWith("relaunch:")),
    );
  });

  it("does not kill an owner runtime and drops a pid when its process exits", () => {
    const killed: number[] = [];
    expect(
      owner.killProcessTree(15, {
        command: "ollama serve",
        platform: "win32",
        spawn: () => {
          throw new Error("owner runtime must stay up");
        },
      }),
    ).toBe(false);
    expect(
      owner.killProcessTree(21, {
        platform: "linux",
        kill: (pid: number) => {
          killed.push(pid);
        },
      }),
    ).toBe(true);
    expect(killed).toEqual([21]);
    const registry = owner.createPidRegistry({});
    const exitSlot: { fn: (() => void) | null } = { fn: null };
    expect(
      registry.track(
        "kernel",
        {
          pid: 44,
          once: (_event: string, fn: () => void) => {
            exitSlot.fn = fn;
          },
        },
        "python kernel/main.py",
      ),
    ).toBe(true);
    expect(registry.list().map((row) => row.pid)).toEqual([44]);
    exitSlot.fn?.();
    expect(registry.list()).toEqual([]);
    registry.track("kernel", { pid: 45 }, "C:\\Ollama\\ollama.exe");
    registry.track("sandbox", { pid: process.pid }, "node scripts/job.js");
    const stopped: Array<{ pid: number; command?: string }> = [];
    const note = (pid: number, options?: { command?: string }) => {
      const row: { pid: number; command?: string } = { pid };
      if (options?.command) row.command = options.command;
      stopped.push(row);
    };
    registry.stopRole("sandbox", note);
    expect(stopped).toEqual([{ pid: process.pid, command: "node scripts/job.js" }]);
    stopped.length = 0;
    registry.stopAll(note);
    expect(stopped).toEqual([]);
  });

  it("waits for a live previous pid and does not wait when the record is gone", () => {
    let clock = 0;
    const waiting = owner.waitForPreviousInstance({
      file: "lifecycle.json",
      budgetMs: 500,
      stepMs: 200,
      now: () => clock,
      alive: () => true,
      sleep: (ms: number) => {
        clock += ms;
      },
      read: () => JSON.stringify({ pid: 9 }),
    });
    expect(waiting).toEqual({ waited: true, released: false });
    const gone = owner.waitForPreviousInstance({
      file: "lifecycle.json",
      budgetMs: 500,
      now: () => 0,
      alive: () => false,
      sleep: () => {},
      read: () => JSON.stringify({ pid: 9 }),
    });
    expect(gone).toEqual({ waited: false, released: true });
    const missing = owner.waitForPreviousInstance({
      file: "missing",
      budgetMs: 500,
      now: () => 0,
      sleep: () => {},
      read: () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.released).toBe(true);
  });

  it("reloads the renderer through the lifecycle owner and does not kill a process", () => {
    let reloaded = 0;
    const life = owner.createLifecycle({
      app: { exit() {}, relaunch() {} },
      steps: {
        reload() {
          reloaded += 1;
        },
      },
      log() {},
    });
    expect(life.reloadRenderer()).toEqual({
      ok: true,
      action: "reload-renderer",
      killsProcesses: false,
    });
    expect(reloaded).toBe(1);
    const source = read("electron/app-lifecycle.cjs");
    const body = source.slice(
      source.indexOf("function reloadRenderer"),
      source.indexOf("return {", source.indexOf("function reloadRenderer")),
    );
    expect(body).not.toContain("killProcessTree");
    expect(read("electron/main.cjs")).toContain("win.webContents.reload()");
    expect(read("electron/main.cjs")).not.toContain("forcefullyCrashRenderer");
  });
});
