/**
 * Every registered IPC channel has an explicit wait class.
 * Long chat and a speech install are not cut at 30s. A quiet stream is.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { classifyVoiceFault, healFault } from "../../src/lib/friday/voice-heal";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const ipc = require_(path.join(root, "electron/ipc-timeout.cjs")) as {
  QUICK_MS: number;
  STREAM_IDLE_MS: number;
  timeoutMs: (channel: string, method?: string) => number;
  budgetFor: (channel: string, args?: unknown[]) => { class: string; method: string };
  runWithBudget: (
    channel: string,
    args: unknown[],
    work: Promise<unknown> | (() => Promise<unknown>),
  ) => { promise: Promise<unknown>; beat: () => void };
  longWorkActive: () => boolean;
};
const table = require_(path.join(root, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
  KERNEL_CLASS: Record<string, string>;
};
const methods = require_(path.join(root, "electron/kernel-methods.cjs")) as {
  KERNEL_METHODS: string[];
};
const router = require_(path.join(root, "electron/model-router.cjs")) as {
  classifyError: (input: { message?: string; code?: string }) => {
    category: string;
    retryable: boolean;
    cooldownMs: number;
  };
  fallbackAdvances: (category: string) => boolean;
  midStreamFallback: (category: string) => { resume: boolean };
};

const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const handles = [...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)]
  .map((match) => match[1])
  .filter((name): name is string => typeof name === "string");

describe("ipc budget table", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names a class for every registered channel and every kernel method", () => {
    expect(new Set(handles).size).toBe(handles.length);
    expect(Object.keys(table.CHANNEL_CLASS).sort()).toEqual([...new Set(handles)].sort());
    expect(Object.keys(table.KERNEL_CLASS).sort()).toEqual([...methods.KERNEL_METHODS].sort());
    for (const name of handles) {
      expect(["quick", "long-job", "stream", "method"]).toContain(table.CHANNEL_CLASS[name]);
    }
    for (const name of methods.KERNEL_METHODS) {
      expect(["quick", "long-job", "stream"]).toContain(table.KERNEL_CLASS[name]);
    }
    expect(ipc.budgetFor("not-a-channel").class).toBe("quick");
    expect(table.CHANNEL_CLASS["voice:stt-install"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["voice:transcribe"]).toBe("stream");
    expect(table.CHANNEL_CLASS["chat:parallel"]).toBe("stream");
    expect(table.CHANNEL_CLASS["agents:run"]).toBe("stream");
    expect(table.CHANNEL_CLASS["doctor:run"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["models:pull"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["models:download"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["models:test-provider"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["sandbox-lab:exec"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["sandbox-lab:install-runtime"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["github:pull"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["github:download-installer"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["toolpacks:invoke"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["updates:apply"]).toBe("long-job");
    expect(table.KERNEL_CLASS["chat.complete"]).toBe("stream");
    expect(table.KERNEL_CLASS["chat.stream"]).toBe("stream");
    expect(table.KERNEL_CLASS["task.run"]).toBe("stream");
    expect(table.KERNEL_CLASS["kernel.status"]).toBe("quick");
    expect(ipc.timeoutMs("doctor:run")).toBe(0);
    expect(ipc.timeoutMs("window:state")).toBe(ipc.QUICK_MS);
    expect(ipc.timeoutMs("kernel:rpc", "chat.complete")).toBe(ipc.STREAM_IDLE_MS);
  });

  it("does not cut a long chat.complete at 30s and names a quiet stream", async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const handle = ipc.runWithBudget("kernel:rpc", ["chat.complete"], work);
    await vi.advanceTimersByTimeAsync(30_000);
    let settled = false;
    handle.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(ipc.longWorkActive()).toBe(true);
    handle.beat();
    await vi.advanceTimersByTimeAsync(ipc.STREAM_IDLE_MS - 1000);
    expect(settled).toBe(false);
    finish("answer");
    await expect(handle.promise).resolves.toBe("answer");
    expect(ipc.longWorkActive()).toBe(false);
  });

  it("leaves a speech install running with no total limit", async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const handle = ipc.runWithBudget("voice:stt-install", [], work);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    let settled = false;
    handle.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(ipc.longWorkActive()).toBe(true);
    finish("installed");
    await expect(handle.promise).resolves.toBe("installed");
  });

  it("expires a quiet stream and lets the work finish", async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => {};
    let finished = false;
    const work = new Promise<string>((resolve) => {
      finish = (value) => {
        finished = true;
        resolve(value);
      };
    });
    const handle = ipc.runWithBudget("voice:transcribe", [], work);
    handle.beat();
    await vi.advanceTimersByTimeAsync(ipc.STREAM_IDLE_MS - 1);
    let settled = false;
    handle.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(handle.promise).rejects.toMatchObject({
      code: "IPC_BUDGET",
      budgetClass: "stream",
      message: expect.stringMatching(/ipc budget expired: stream inactivity \(voice:transcribe\)/),
    });
    expect(finished).toBe(false);
    finish("still-going");
    expect(finished).toBe(true);
    await work;
  });

  it("does not treat a budget expiry as a model fallback or a voice retry", () => {
    const row = router.classifyError({
      message: "ipc budget expired: stream inactivity (kernel:rpc chat.complete)",
      code: "IPC_BUDGET",
    });
    expect(row.category).toBe("ipc_budget");
    expect(row.retryable).toBe(false);
    expect(row.cooldownMs).toBe(0);
    expect(router.fallbackAdvances("ipc_budget")).toBe(false);
    expect(router.midStreamFallback("ipc_budget").resume).toBe(false);
    expect(classifyVoiceFault("ipc budget expired: quick (voice:transcribe)")).toBe("none");
    expect(healFault("ipc budget expired: stream inactivity (voice:transcribe)")).toBe("none");
    expect(classifyVoiceFault("worker timeout")).toBe("stt-engine-crash");
  });
});
