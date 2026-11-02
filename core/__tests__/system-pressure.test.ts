import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liteActive, type SystemPressure } from "../../src/lib/friday/system-pressure";

const read = (path: string) => readFileSync(path, "utf8");
const snap = (over: Partial<SystemPressure> = {}): SystemPressure => ({
  level: "ok",
  lite: false,
  freeGb: 8,
  freePercent: 50,
  appMemMb: 600,
  appCpuPercent: 2,
  onBattery: false,
  speedLimit: 100,
  at: 1,
  ...over,
});

describe("the interface lightens itself on battery or low memory", () => {
  it("is lite only when the main process says so and the setting allows it", () => {
    expect(liteActive(null, true)).toBe(false);
    expect(liteActive(snap(), true)).toBe(false);
    expect(liteActive(snap({ lite: true, onBattery: true }), true)).toBe(true);
    expect(liteActive(snap({ lite: true, level: "high" }), false)).toBe(false);
  });

  it("stops decoration but keeps the live-status dots", () => {
    const css = read("src/styles.css");
    const block = css.slice(css.indexOf("html.friday-lite .orb-breathe"));
    expect(block).toContain("animation-play-state: paused");
    expect(block).toMatch(/html\.friday-lite \.circuit-flow \{\s*display: none !important;/);
    expect(css).toMatch(
      /html\.friday-lite \.friday-titlestrip,[\s\S]{0,300}backdrop-filter: none;/,
    );
    expect(block.slice(0, 900)).not.toContain("pulse-dot");
  });

  it("has a setting, on by default, in Performance", () => {
    expect(read("src/lib/friday/preferences.ts")).toMatch(/autoLite: true,/);
    expect(read("src/components/friday/settings/SystemSettings.tsx")).toContain('flip("autoLite")');
  });

  it("is wired from the main process to the page and saves on sleep", () => {
    expect(read("electron/preload.cjs")).toContain('onSystemPressure: on("system:pressure")');
    expect(read("electron/preload.cjs")).toContain('onSystemSuspend: on("system:suspend")');
    expect(read("src/components/friday/AppShell.tsx")).toContain("startSystemPressure()");
    expect(read("src/lib/friday/system-pressure.ts")).toContain("flushPendingState()");
  });
});

describe("the main process uses what it reads", () => {
  const main = read("electron/main.cjs");

  it("draws in software after repeated graphics crashes, decided before the app is ready", () => {
    const guardAt = main.indexOf("gpuGuard.softwareMode()");
    expect(guardAt).toBeGreaterThan(0);
    expect(main.slice(guardAt, guardAt + 160)).toContain("app.disableHardwareAcceleration()");
    expect(main).toMatch(/app\.on\("child-process-gone"/);
    expect(main).toContain('life.requestRestart("gpu-fallback")');
  });

  it("starts the kernel with a plan that follows free memory", () => {
    expect(main).toContain("currentPlan().threads");
    expect(main).not.toContain("lastHardware.plan.threads");
  });

  it("ends the session cleanly on Windows, where powerMonitor has no shutdown event", () => {
    expect(main).toMatch(
      /win\.on\("session-end", \(\) => \{\s*void life\.onSessionEnd\("os-session-end"\);/,
    );
    expect(main).toMatch(/powerMonitor\.on\("suspend"/);
  });
});
