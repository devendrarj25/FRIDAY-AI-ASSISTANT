/**
 * FRIDAY · live monitoring + restart classification contract.
 *
 * Two rules are enforced here:
 *  1. The monitor reports measured values or an honest `null` with a reason —
 *     never a decorative number.
 *  2. Only files that are genuinely read once at process start may ask the user
 *     to restart. FRIDAY's own runtime writes must not.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require_ = createRequire(import.meta.url);
const monitor = require_(path.join(process.cwd(), "electron/system-monitor.cjs"));
const watcher = require_(path.join(process.cwd(), "electron/watcher.cjs"));

describe("system monitor", () => {
  it("measures RAM and reports an absent GPU honestly", async () => {
    const sample = await monitor.sample();
    expect(sample.ram.totalGb).toBeGreaterThan(0);
    expect(sample.ram.percent).toBeGreaterThanOrEqual(0);
    expect(typeof sample.uptime).toBe("string");
    if (!sample.gpu.available) {
      expect(sample.gpu.percent).toBeNull();
      expect(sample.gpu.reason).toBeTruthy();
    }
  });

  it("never invents a CPU load before it has two tick samples", async () => {
    const sample = await monitor.sample();
    expect(sample.cpu.percent === null || sample.cpu.percent >= 0).toBe(true);
    expect(sample.cpu.cores).toBeGreaterThan(0);
  });
});

describe("hardware truthfulness", () => {
  it("separates CUDA toolkit detection from NVIDIA driver acceleration", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "electron/hardware.cjs"), "utf8");
    expect(source).toContain("toolkitAvailable: cudaToolkit");
    expect(source).toContain("driverAvailable: nvidiaDriver");
    expect(source).not.toContain("Boolean(cudaVersion) || nvidia.length > 0");
  });
});

describe("restart classification", () => {
  it("asks for a restart only for start-time configuration", () => {
    expect(watcher.needsRestart(path.join("config", "kernel.yaml"))).toBe(true);
    expect(watcher.needsRestart(path.join("config", "system", "paths.json"))).toBe(true);
  });

  it("never asks for a restart because FRIDAY wrote its own runtime state", () => {
    for (const file of [
      path.join("config", "models.json"),
      path.join("config", "providers.json"),
      path.join("config", "services.json"),
      path.join("config", "preferences.json"),
      path.join("skills", "code-review", "skill.json"),
    ]) {
      expect(watcher.needsRestart(file)).toBe(false);
    }
  });

  it("ignores editor noise and database side files", () => {
    expect(watcher.isIgnored(path.join("config", "friday.json.tmp"))).toBe(true);
    expect(watcher.isIgnored(path.join("database", "friday.sqlite3-wal"))).toBe(true);
    expect(watcher.isIgnored(path.join("config", "friday.json"))).toBe(false);
  });
});
