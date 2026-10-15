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
    expect(main).toContain("await releaseOwnedProcesses()");
    expect(main).toContain("app.relaunch()");
    const restart = main.slice(main.indexOf("async function restartFriday"));
    expect(restart.indexOf("await releaseOwnedProcesses()")).toBeLessThan(
      restart.indexOf("app.relaunch()"),
    );
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
