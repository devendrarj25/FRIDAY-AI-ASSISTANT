import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  speechWorkerRows,
  voiceBudgetProfileLine,
} from "../../src/lib/friday/voice-diagnostics-rows";
import { formatVoiceProbeReport } from "../../src/lib/friday/voice-doctor";
import type { SttWorkerCache, VoiceBudget } from "../../src/lib/friday/desktop";

const require = createRequire(import.meta.url);
const root = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const stt = require("../../electron/stt.cjs") as {
  workerCacheOf: (ping: unknown) => SttWorkerCache | null;
};
const table = require("../../electron/ipc-budget-table.cjs") as {
  CHANNEL_CLASS: Record<string, string>;
};

const budget: VoiceBudget = {
  ok: true,
  profile: "balanced",
  sttSize: "small",
  sttDevice: "cpu",
  maxResidentModels: 2,
  speechBudgetGb: 3.4,
  idleUnloadMs: 600000,
  notes: [],
};

const cache: SttWorkerCache = {
  loadedModels: [{ name: "small", engine: "faster-whisper", loadMs: 1840 }],
  idleSec: 12.4,
  unloadCount: 2,
  memory: { level: "high", known: true, availableMb: 1500, totalMb: 16000 },
  fallbacks: { total: 3, byKind: { "low-memory-resident": 3 } },
};

describe("voice:budget and voice:restore wiring", () => {
  it("runs from the renderer API through the allowlist and the main handler to the voice modules", () => {
    expect(read("src/lib/friday/desktop.ts")).toMatch(
      /voiceBudget\?: \(\) => Promise<VoiceBudget>/,
    );
    expect(read("src/lib/friday/desktop.ts")).toMatch(/restoreVoiceModel\?: \(id: string\)/);
    const preload = read("electron/preload.cjs");
    expect(preload).toMatch(/voiceBudget: \(\) => ipcRenderer\.invoke\("voice:budget"\)/);
    expect(preload).toMatch(
      /restoreVoiceModel: \(id\) =>\s*ipcRenderer\.invoke\("voice:restore", String\(id \|\| ""\)\)/,
    );
    const main = read("electron/main.cjs");
    expect(main).toMatch(
      /ipcMain\.handle\("voice:budget"[\s\S]*app\.getGPUInfo\("basic"\)[\s\S]*weights\.budgetForProbe\(weights\.probeHardware\(\{ gpuInfo \}\)\)/,
    );
    expect(main).toMatch(
      /ipcMain\.handle\("voice:restore"[\s\S]*typeof id !== "string"[\s\S]*voiceVerify\.restoreVoiceModel\(id\)/,
    );
  });

  it("gives both channels the quick budget", () => {
    expect(table.CHANNEL_CLASS["voice:budget"]).toBe("quick");
    expect(table.CHANNEL_CLASS["voice:restore"]).toBe("quick");
  });

  it("refuses an id that is not a catalog id before it reaches the file system", () => {
    const main = read("electron/main.cjs");
    const guard = /voice:restore"[\s\S]*?test\(id\)/.exec(main)?.[0] ?? "";
    const pattern = /\/(\^\[a-z0-9\][^/]*\$)\//.exec(guard)?.[1];
    expect(pattern).toBeTruthy();
    const ok = new RegExp(pattern as string);
    expect(ok.test("hindi-ear")).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "A", "x".repeat(70), "a b"]) {
      expect(ok.test(bad)).toBe(false);
    }
  });
});

describe("speech worker cache from the worker status answer", () => {
  it("keeps plain values and bounds the lists", () => {
    const got = stt.workerCacheOf({
      loadedModels: [{ name: "small", engine: "faster-whisper", loadMs: 900, extra: "x" }],
      idleSec: 3,
      unloadCount: 1,
      memory: { level: "critical", known: true, availableMb: 100, totalMb: 8000, secret: "x" },
      fallbacks: { total: 2, byKind: { a: 2, b: "nope" } },
    });
    expect(got).toEqual({
      loadedModels: [{ name: "small", engine: "faster-whisper", loadMs: 900 }],
      idleSec: 3,
      unloadCount: 1,
      memory: { level: "critical", known: true, availableMb: 100, totalMb: 8000 },
      fallbacks: { total: 2, byKind: { a: 2 } },
    });
  });

  it("is null for an older worker that reports no cache, and an unknown memory level reads ok", () => {
    expect(stt.workerCacheOf({ ok: true })).toBeNull();
    expect(stt.workerCacheOf(null)).toBeNull();
    expect(stt.workerCacheOf({ loadedModels: [], memory: { level: "weird" } })?.memory.level).toBe(
      "ok",
    );
  });
});

describe("speech worker diagnostics rows", () => {
  it("show the loaded model, load time, idle time, unloads, memory, fallbacks and the profile line", () => {
    const rows = speechWorkerRows({ phase: "ready", cache, budget });
    const by = (label: string) => rows.find((row) => row.label.includes(label));
    expect(by("models loaded")?.value).toBe("small (faster-whisper)");
    expect(by("load time")?.value).toBe("small 1840 ms");
    expect(by("idle time")?.value).toBe("idle 12 s · 2 unload(s)");
    expect(by("memory pressure")).toMatchObject({
      value: "high · 1500 MB free of 16000 MB",
      bad: true,
    });
    expect(by("fallbacks")?.value).toBe("3 (low-memory-resident 3)");
    expect(by("budget")?.value).toBe(
      "balanced profile · speech small (cpu) · at most 2 resident · up to 3.4 GB for speech",
    );
    expect(voiceBudgetProfileLine(budget)).toContain("balanced profile");
  });

  it("say what is missing instead of showing zeros: loading, offline, error, no worker, no budget", () => {
    expect(speechWorkerRows({ phase: "loading" }).every((r) => /reading/.test(r.value))).toBe(true);
    expect(
      speechWorkerRows({ phase: "offline" }).every((r) => /installed FRIDAY/.test(r.value)),
    ).toBe(true);
    const failed = speechWorkerRows({ phase: "error", message: "timed out" });
    expect(failed.every((r) => r.bad === true && /timed out.*refresh/.test(r.value))).toBe(true);
    const idle = speechWorkerRows({ phase: "ready", cache: null, budget: null });
    expect(idle.slice(0, 5).every((r) => /no speech worker is running/.test(r.value))).toBe(true);
    expect(idle[5]).toMatchObject({ bad: true });
    const empty = speechWorkerRows({
      phase: "ready",
      cache: {
        ...cache,
        loadedModels: [],
        idleSec: null,
        memory: { ...cache.memory, level: "ok" },
      },
      budget,
    });
    expect(empty[0]?.value).toMatch(/none loaded/);
    expect(empty[2]?.value).toBe("nothing loaded · 2 unload(s)");
    expect(empty[3]?.bad).toBeUndefined();
  });
});

describe("Doctor restore button", () => {
  it("keeps rollbackId through the probe report, and only when set", () => {
    const report = formatVoiceProbeReport([
      { id: "rollback-hindi-ear", label: "x", ok: false, detail: "d", rollbackId: "hindi-ear" },
      { id: "other", label: "y", ok: true, detail: "d" },
    ]);
    expect(report.checks[0]?.rollbackId).toBe("hindi-ear");
    expect("rollbackId" in (report.checks[1] ?? {})).toBe(false);
  });

  it("asks for a confirm click, calls voice:restore through the desktop API and prints a result line", () => {
    const source = read("src/components/friday/VoiceDiagnostics.tsx");
    expect(source).toMatch(/check\.rollbackId \? \(/);
    expect(source).toMatch(/restoreAsk !== id[\s\S]*setRestoreAsk\(id\)[\s\S]*return;/);
    expect(source).toMatch(/desktopApi\(\)\?\.restoreVoiceModel/);
    expect(source).toMatch(/Confirm restore/);
    expect(source).toMatch(/restored revision/);
    expect(source).toMatch(/not restored:/);
    expect(source).toMatch(/speechWorkerRows\(worker\)/);
  });
});

describe("kernel idle unload", () => {
  it("goes through the Hindi ear's own unload", () => {
    const py = read("kernel/stt.py");
    expect(py).toMatch(/def unload_models[\s\S]*hindi_ear\.unload\(\)/);
    expect(py).not.toMatch(/hindi_ear\._model\s*=/);
    expect(read("kernel/hindi_ear.py")).toMatch(/def unload\(\) -> bool:/);
  });
});
