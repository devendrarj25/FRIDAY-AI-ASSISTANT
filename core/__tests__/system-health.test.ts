import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);

type Snap = {
  level: string;
  lite: boolean;
  freeGb: number;
  appMemMb: number;
  appCpuPercent: number;
  onBattery: boolean;
  speedLimit: number;
};
type Plan = {
  backend: string;
  threads: number;
  maxRamGb: number;
  maxVramGb: number;
  adapted?: boolean;
};
const health = require_("../../electron/system-health.cjs") as {
  createGpuGuard: (o: Record<string, unknown>) => {
    softwareMode: () => boolean;
    recordChildGone: (d: unknown) => { action: string; count?: number };
  };
  createPressureMonitor: (o: Record<string, unknown>) => {
    sample: () => Snap;
    snapshot: () => Snap;
    onChange: (fn: (s: Snap) => void) => () => void;
    start: () => void;
    stop: () => void;
  };
  adaptPlan: (plan: Plan, snap: Partial<Snap>) => Plan;
  memoryLevel: (free: number, total: number) => string;
  rootHealth: (o: Record<string, unknown>) => {
    ok: boolean;
    writable: boolean;
    freeGb: number | null;
    problems: string[];
  };
};

const GB = 1024 ** 3;

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (f: string) => {
      const v = files.get(f);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (f: string, v: string) => void files.set(f, v),
    rmSync: (f: string) => void files.delete(f),
  };
}

describe("a graphics driver that keeps crashing gets software drawing", () => {
  const gpu = { type: "GPU", reason: "crashed", exitCode: 101 };

  it("leaves one crash alone and falls back on the second inside ten minutes", () => {
    const fs = memFs();
    let t = 1_000_000;
    const guard = health.createGpuGuard({ fs, file: "gpu.json", now: () => t });
    expect(guard.softwareMode()).toBe(false);
    expect(guard.recordChildGone(gpu).action).toBe("noted");
    t += 60_000;
    expect(guard.recordChildGone(gpu).action).toBe("fallback");
    expect(guard.softwareMode()).toBe(true);
  });

  it("does not count crashes that are far apart, other processes, or clean exits", () => {
    const fs = memFs();
    let t = 0;
    const guard = health.createGpuGuard({ fs, file: "gpu.json", now: () => t });
    expect(guard.recordChildGone(gpu).action).toBe("noted");
    t += 11 * 60_000;
    expect(guard.recordChildGone(gpu).action).toBe("noted");
    expect(guard.recordChildGone({ type: "Utility", reason: "crashed" }).action).toBe("ignore");
    expect(guard.recordChildGone({ type: "GPU", reason: "clean-exit" }).action).toBe("ignore");
    expect(guard.softwareMode()).toBe(false);
  });

  it("gives the GPU back after a week, or at once with FRIDAY_FORCE_GPU=1", () => {
    const fs = memFs();
    let t = 5_000_000;
    const make = (env: Record<string, string> = {}) =>
      health.createGpuGuard({ fs, file: "gpu.json", now: () => t, env });
    const guard = make();
    guard.recordChildGone(gpu);
    guard.recordChildGone(gpu);
    expect(make().softwareMode()).toBe(true);
    expect(make({ FRIDAY_FORCE_GPU: "1" }).softwareMode()).toBe(false);
    t += 8 * 24 * 60 * 60 * 1000;
    expect(make().softwareMode()).toBe(false);
    expect(fs.files.has("gpu.json")).toBe(false);
  });

  it("survives a marker it cannot read or write", () => {
    const broken = {
      readFileSync: () => "{not json",
      writeFileSync: () => {
        throw new Error("EACCES");
      },
      rmSync: () => undefined,
    };
    const guard = health.createGpuGuard({ fs: broken, file: "gpu.json" });
    expect(guard.softwareMode()).toBe(false);
    guard.recordChildGone({ type: "GPU", reason: "crashed" });
    expect(guard.recordChildGone({ type: "GPU", reason: "crashed" }).action).toBe("fallback");
  });
});

describe("memory pressure has a level with a margin", () => {
  it("maps free memory to ok, high and critical", () => {
    expect(health.memoryLevel(8 * GB, 16 * GB)).toBe("ok");
    expect(health.memoryLevel(1 * GB, 16 * GB)).toBe("high");
    expect(health.memoryLevel(0.4 * GB, 16 * GB)).toBe("critical");
    expect(health.memoryLevel(1.4 * GB, 64 * GB)).toBe("high");
    expect(health.memoryLevel(2.6 * GB, 64 * GB)).toBe("high");
    expect(health.memoryLevel(4 * GB, 64 * GB)).toBe("ok");
  });

  function monitor(state: { free: number; battery: boolean; limit: number }) {
    const events: Snap[] = [];
    const m = health.createPressureMonitor({
      os: { totalmem: () => 16 * GB, freemem: () => state.free },
      getMetrics: () => [
        { memory: { workingSetSize: 512 * 1024 }, cpu: { percentCPUUsage: 3.2 } },
        { memory: { workingSetSize: 256 * 1024 }, cpu: { percentCPUUsage: 1.1 } },
      ],
      isOnBattery: () => state.battery,
      speedLimit: () => state.limit,
      now: () => 42,
    });
    m.onChange((s) => events.push(s));
    return { m, events };
  }

  it("goes up at once and comes down only after two calm readings", () => {
    const state = { free: 8 * GB, battery: false, limit: 100 };
    const { m, events } = monitor(state);
    expect(m.sample().level).toBe("ok");
    state.free = 0.3 * GB;
    expect(m.sample().level).toBe("critical");
    state.free = 8 * GB;
    expect(m.sample().level).toBe("critical");
    expect(m.sample().level).toBe("ok");
    expect(events.map((e) => e.level)).toEqual(["critical", "ok"]);
  });

  it("reports FRIDAY's own memory and CPU, and turns lite on for battery or an OS speed limit", () => {
    const state = { free: 8 * GB, battery: false, limit: 100 };
    const { m } = monitor(state);
    const first = m.sample();
    expect(first.appMemMb).toBe(768);
    expect(first.appCpuPercent).toBe(4.3);
    expect(first.lite).toBe(false);
    state.battery = true;
    expect(m.sample().lite).toBe(true);
    state.battery = false;
    state.limit = 60;
    expect(m.sample().lite).toBe(true);
  });

  it("starts and stops one timer, and a failing listener does not stop the rest", () => {
    const state = { free: 8 * GB, battery: false, limit: 100 };
    const timers: unknown[] = [];
    const cleared: unknown[] = [];
    const m = health.createPressureMonitor({
      os: { totalmem: () => 16 * GB, freemem: () => state.free },
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t: unknown) => cleared.push(t),
    });
    const seen: string[] = [];
    m.onChange(() => {
      throw new Error("bad listener");
    });
    m.onChange((s) => seen.push(String(s.level)));
    m.start();
    m.start();
    expect(timers).toHaveLength(1);
    state.free = 0.2 * GB;
    (timers[0] as { fn: () => void }).fn();
    expect(seen).toEqual(["critical"]);
    m.stop();
    expect(cleared).toHaveLength(1);
  });
});

describe("the worker plan follows what is free now", () => {
  const plan = { backend: "gpu", threads: 6, maxRamGb: 11.2, maxVramGb: 4 };

  it("leaves a comfortable PC alone", () => {
    const out = health.adaptPlan(plan, {
      level: "ok",
      onBattery: false,
      speedLimit: 100,
      freeGb: 14,
    });
    expect(out.threads).toBe(6);
    expect(out.maxRamGb).toBe(8.4);
    expect(out.backend).toBe("gpu");
  });

  it("halves the threads and the memory budget under pressure, never below one", () => {
    const out = health.adaptPlan(plan, {
      level: "high",
      onBattery: false,
      speedLimit: 100,
      freeGb: 1.2,
    });
    expect(out.threads).toBe(3);
    expect(out.maxRamGb).toBe(1);
    expect(out.adapted).toBe(true);
    expect(
      health.adaptPlan(
        { ...plan, threads: 1 },
        { level: "critical", onBattery: true, speedLimit: 50, freeGb: 0.3 },
      ).threads,
    ).toBe(1);
  });
});

describe("the FRIDAY folder is checked when FRIDAY starts", () => {
  const okFs = (freeGb: number) => ({
    writeFileSync: () => undefined,
    rmSync: () => undefined,
    statfsSync: () => ({ bavail: freeGb * 1024, bsize: 1024 * 1024 }),
  });

  it("passes a writable folder with room, and reports the free space", () => {
    const out = health.rootHealth({ fs: okFs(40), root: "C:/FRIDAY" });
    expect(out).toMatchObject({ ok: true, writable: true, freeGb: 40, problems: [] });
  });

  it("says so when the folder cannot be written, with the reason code", () => {
    const fs = {
      ...okFs(40),
      writeFileSync: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };
    const out = health.rootHealth({ fs, root: "C:/FRIDAY" });
    expect(out.ok).toBe(false);
    expect(out.writable).toBe(false);
    expect(out.problems[0]).toContain("EPERM");
  });

  it("warns about a nearly full drive, and stays quiet when the drive cannot report", () => {
    expect(health.rootHealth({ fs: okFs(0.5), root: "C:/FRIDAY" }).problems[0]).toContain("0.5 GB");
    const quiet = {
      ...okFs(40),
      statfsSync: () => {
        throw new Error("no statfs");
      },
    };
    expect(health.rootHealth({ fs: quiet, root: "C:/FRIDAY" })).toMatchObject({
      ok: true,
      freeGb: null,
    });
    expect(health.rootHealth({ fs: okFs(1), root: null }).ok).toBe(true);
  });

  it("is shown in the boot list", () => {
    const main = require_("node:fs").readFileSync("electron/main.cjs", "utf8") as string;
    expect(main).toContain('"Checking folder"');
    expect(main).toContain("systemHealth.rootHealth({ fs, root })");
  });
});
