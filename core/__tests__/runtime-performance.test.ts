/**
 * Keeping the window smooth, the fast graphics card in use and the network honest. Measured on the running app first
 * (every route, long tasks and frame times): the steady costs were the page writing its whole state to storage on every
 * change, the companion snapshot rebuilt for every notification, forced layouts in the sliding highlights, an audio
 * device opened for every alert beep, and (on a laptop) the weak graphics chip drawing the window.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const gpu = require_("../../electron/gpu-preference.cjs") as {
  KEY: string;
  HIGH_PERFORMANCE: string;
  wanted: (o?: Record<string, unknown>) => boolean;
  ensureHighPerformance: (
    o: Record<string, unknown>,
  ) => Promise<{ changed: boolean; reason: string }>;
};
const netStatus = require_("../../electron/net-status.cjs") as {
  HTTPS_PROBES: string[];
  probeHttps: (
    url: string,
    timeoutMs?: number,
    doFetch?: (url: string, init: Record<string, unknown>) => Promise<{ status: number }>,
  ) => Promise<boolean>;
};

describe("the fast graphics card", () => {
  const exe = "C:\\Users\\a\\FRIDAY\\App\\FRIDAY.exe";
  const fakeReg = (existing: boolean, addCode = 0) => {
    const calls: string[][] = [];
    const execFile = (
      _cmd: string,
      args: string[],
      _opts: unknown,
      done: (error: (Error & { code?: number }) | null, stdout: string) => void,
    ) => {
      calls.push(args);
      if (args[0] === "query") {
        if (existing) done(null, `    ${exe}    REG_SZ    GpuPreference=1;\r\n`);
        else done(Object.assign(new Error("not found"), { code: 1 }), "");
      } else {
        done(addCode ? Object.assign(new Error("denied"), { code: addCode }) : null, "");
      }
    };
    return { calls, execFile };
  };

  it("is wanted only on an installed Windows FRIDAY that was not told otherwise", () => {
    expect(gpu.wanted({ platform: "win32", env: {} })).toBe(true);
    expect(gpu.wanted({ platform: "linux", env: {} })).toBe(false);
    expect(gpu.wanted({ platform: "win32", env: {}, portable: true })).toBe(false);
    expect(gpu.wanted({ platform: "win32", env: { FRIDAY_GPU_PREFERENCE: "default" } })).toBe(
      false,
    );
    expect(gpu.wanted({ platform: "win32", env: { FRIDAY_READINESS: "1" } })).toBe(false);
    expect(gpu.wanted({ platform: "win32", env: { FRIDAY_BOOT_SELFTEST: "1" } })).toBe(false);
  });

  it("writes High performance for the program when Windows has no choice for it", async () => {
    const reg = fakeReg(false);
    const out = await gpu.ensureHighPerformance({
      exe,
      execFile: reg.execFile,
      platform: "win32",
      env: {},
    });
    expect(out.changed).toBe(true);
    expect(reg.calls[0]).toEqual(["query", gpu.KEY, "/v", exe]);
    expect(reg.calls[1]).toEqual([
      "add",
      gpu.KEY,
      "/v",
      exe,
      "/t",
      "REG_SZ",
      "/d",
      "GpuPreference=2;",
      "/f",
    ]);
    expect(gpu.HIGH_PERFORMANCE).toBe("GpuPreference=2;");
  });

  it("never changes a choice the owner already made, and a refused write is not a failure", async () => {
    const owned = fakeReg(true);
    expect(
      (
        await gpu.ensureHighPerformance({
          exe,
          execFile: owned.execFile,
          platform: "win32",
          env: {},
        })
      ).changed,
    ).toBe(false);
    expect(owned.calls.every((c) => c[0] === "query")).toBe(true);
    const denied = fakeReg(false, 5);
    const out = await gpu.ensureHighPerformance({
      exe,
      execFile: denied.execFile,
      platform: "win32",
      env: {},
    });
    expect(out.changed).toBe(false);
    const none = fakeReg(false);
    await gpu.ensureHighPerformance({
      exe,
      execFile: none.execFile,
      platform: "win32",
      env: {},
      portable: true,
    });
    expect(none.calls).toHaveLength(0);
  });

  it("is registered at start, removed by the uninstaller, and the renderer is not slowed behind the tray", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain('id: "gpu-preference"');
    expect(main).toContain("ensureHighPerformance({");
    for (const sw of [
      "disable-renderer-backgrounding",
      "disable-background-timer-throttling",
      "disable-backgrounding-occluded-windows",
    ]) {
      expect(main).toContain(`appendSwitch("${sw}")`);
    }
    expect(read("installer/build/installer.nsh")).toContain(
      'DeleteRegValue HKCU "Software\\Microsoft\\DirectX\\UserGpuPreferences" "$INSTDIR\\FRIDAY.exe"',
    );
  });
});

describe("the network check on a PC behind a proxy", () => {
  it("counts any HTTP answer below 500 through the app's own network stack as online", async () => {
    expect(netStatus.HTTPS_PROBES.length).toBeGreaterThanOrEqual(2);
    expect(netStatus.HTTPS_PROBES.every((u) => u.startsWith("https://"))).toBe(true);
    expect(await netStatus.probeHttps("https://x.test/", 500, async () => ({ status: 204 }))).toBe(
      true,
    );
    expect(await netStatus.probeHttps("https://x.test/", 500, async () => ({ status: 302 }))).toBe(
      true,
    );
    expect(await netStatus.probeHttps("https://x.test/", 500, async () => ({ status: 503 }))).toBe(
      false,
    );
    expect(
      await netStatus.probeHttps("https://x.test/", 500, async () => {
        throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
      }),
    ).toBe(false);
  });

  it("gives up on a request that never answers", async () => {
    const never = (_url: string, init: Record<string, unknown>) =>
      new Promise<{ status: number }>((_resolve, reject) => {
        (init["signal"] as AbortSignal).addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    expect(await netStatus.probeHttps("https://x.test/", 30, never)).toBe(false);
  });

  it("the check tries HTTPS only after every TCP probe failed", () => {
    const text = read("electron/net-status.cjs");
    expect(text.indexOf("results.some(Boolean)")).toBeLessThan(text.indexOf("HTTPS_PROBES.map"));
    expect(text).toContain("internet reachable through the system proxy");
  });
});

describe("saving state without a cost on every change", () => {
  const store = new Map<string, string>();
  let sets = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    store.clear();
    sets = 0;
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          sets += 1;
          store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
      },
      addEventListener: () => undefined,
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("gathers a burst of writes into one storage write, readable in between, written on flush", async () => {
    const persist = await import("../../src/lib/friday/persist");
    for (let i = 0; i < 50; i += 1) persist.writeState("friday.test", { token: i });
    expect(sets).toBe(0);
    expect(persist.readLocalState<{ token: number }>("friday.test")).toEqual({ token: 49 });
    vi.advanceTimersByTime(200);
    expect(sets).toBe(1);
    expect(JSON.parse(store.get("friday.test")!)).toEqual({ token: 49 });
    persist.writeState("friday.test", { token: 50 });
    persist.flushPendingState();
    expect(JSON.parse(store.get("friday.test")!)).toEqual({ token: 50 });
  });
});

describe("the knowledge search", () => {
  it("answers the same phrase the same way every time, from a cache a caller cannot spoil", async () => {
    const { searchExpertise, diagnoseError } = await import("../../src/lib/friday/brain/expertise");
    const first = searchExpertise("npm install failed with eacces permission denied", 2);
    const second = searchExpertise("npm install failed with eacces permission denied", 2);
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    second.length = 0;
    expect(searchExpertise("npm install failed with eacces permission denied", 2)).toHaveLength(
      first.length,
    );
    expect(searchExpertise("   ")).toEqual([]);
    expect(Array.isArray(diagnoseError("ModuleNotFoundError: No module named 'fastapi'"))).toBe(
      true,
    );
  });
});

describe("the page does less work for the same result", () => {
  it("builds the companion snapshot once for a burst of notifications", () => {
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).toContain("const schedulePublish = () =>");
    for (const store of [
      "capabilityRegistry",
      "doctor",
      "assistantMode",
      "usageRegistry",
      "brain",
    ]) {
      expect(shell).toContain(`${store}.subscribe(schedulePublish)`);
    }
    expect(shell).toContain("if (publishTimer) clearTimeout(publishTimer);");
  });

  it("reads every size before writing any, so the browser lays the page out once", () => {
    for (const file of ["src/components/friday/ui.tsx", "src/components/friday/nav-thumb.ts"]) {
      expect(read(file)).toContain("const { offsetWidth, offsetHeight, offsetLeft, offsetTop }");
    }
  });

  it("opens one audio device for every alert beep, not one per beep", () => {
    const text = read("src/lib/friday/settings-runtime.ts");
    expect(text).toContain("let alertContext: AudioContext | null = null;");
    expect(text).not.toContain("void ctx.close()");
  });
});
