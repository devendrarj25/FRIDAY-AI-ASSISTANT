/**
 * The boot screen shows real work: the stages the main process names (electron/boot-plan.cjs), a bar that follows what
 * is finished, and it leaves when FRIDAY reports ready, not after a fixed time. Pure functions, no window.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOT_BLOCKED_LINGER_MS,
  BOOT_GIVE_UP_MS,
  BOOT_MIN_SHOWN_MS,
  BOOT_STUCK_MS,
  bootGate,
  computeBootProgress,
  creepPercent,
  type BootPlan,
  type BootStepLike,
} from "../../src/lib/friday/boot-progress";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const plan = require_("../../electron/boot-plan.cjs") as {
  STAGES: Array<{ id: string; match: RegExp }>;
  stageFor: (label: string) => string | null;
  bootModeFor: (o: { argv?: string[]; firstRun?: boolean; loginArg?: string }) => string;
  planFor: (mode: string) => BootPlan;
};

let clock = 1000;
const step = (label: string, status: BootStepLike["status"] = "ok", detail = ""): BootStepLike => ({
  label,
  status,
  detail,
  at: (clock += 10),
  stage: plan.stageFor(label),
});

describe("boot plan", () => {
  it("names every piece of start-up work once and maps the reported labels to stages", () => {
    expect(plan.stageFor("Detecting installation")).toBe("install");
    expect(plan.stageFor("Starting services")).toBe("services");
    expect(plan.stageFor("Reading workspace.json")).toBe("workspace");
    expect(plan.stageFor("Detecting workspace")).toBe("workspace");
    expect(plan.stageFor("Scanning folders")).toBe("scan");
    expect(plan.stageFor("Loading workflows")).toBe("capabilities");
    expect(plan.stageFor("FRIDAY ready")).toBe("ready");
    // A detail line (one of five "Loading ..." lines) belongs to no stage of its own.
    expect(plan.stageFor("Loading agents")).toBeNull();
    expect(plan.stageFor("something else")).toBeNull();
    const ids = plan.planFor("start").stages.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe("ready");
  });

  it("says why this launch is a launch", () => {
    expect(plan.bootModeFor({ firstRun: true })).toBe("first-run");
    expect(plan.bootModeFor({ argv: ["x", "--friday-restart=1"] })).toBe("restart");
    expect(plan.bootModeFor({ argv: ["x", "--friday-login"] })).toBe("sign-in");
    expect(plan.bootModeFor({ argv: ["x"] })).toBe("start");
    // The first start wins over a restart flag.
    expect(plan.bootModeFor({ firstRun: true, argv: ["--friday-restart=1"] })).toBe("first-run");
    expect(plan.planFor("first-run").title).toMatch(/first time/i);
    expect(plan.planFor("nonsense").mode).toBe("start");
  });
});

describe("boot progress", () => {
  const thePlan = plan.planFor("start");

  it("follows what is really finished and never reaches 100 before FRIDAY is ready", () => {
    const none = computeBootProgress(thePlan, []);
    expect(none.percent).toBe(0);
    expect(none.currentLabel).toBe(thePlan.stages[0]!.label);
    const some = computeBootProgress(thePlan, [
      step("Detecting installation"),
      step("Starting services", "ok", "kernel on 127.0.0.1:8765"),
    ]);
    expect(some.percent).toBeGreaterThan(0);
    expect(some.percent).toBeLessThan(100);
    expect(some.stages.find((s) => s.id === "services")?.state).toBe("done");
    expect(some.stages.find((s) => s.id === "workspace")?.state).toBe("active");
    expect(some.currentDetail).toContain("127.0.0.1");
    const all = computeBootProgress(thePlan, [
      ...thePlan.stages.slice(0, -1).map((s) => step(s.label)),
    ]);
    expect(all.percent).toBeLessThanOrEqual(99);
    expect(all.ready).toBe(false);
  });

  it("is 100 and ready when 'FRIDAY ready' arrives, and does not wait for a stage that never reported", () => {
    const done = computeBootProgress(thePlan, [
      step("Detecting installation"),
      step("FRIDAY ready"),
    ]);
    expect(done.ready).toBe(true);
    expect(done.readyOk).toBe(true);
    expect(done.percent).toBe(100);
    expect(done.stages.find((s) => s.id === "providers")?.state).toBe("skipped");
  });

  it("skips the workspace stages when no FRIDAY folder is chosen, and reports a blocked start", () => {
    const noFolder = computeBootProgress(thePlan, [
      step("Detecting workspace", "missing", "Choose your FRIDAY folder to continue"),
    ]);
    expect(noFolder.stages.find((s) => s.id === "scan")?.state).toBe("skipped");
    expect(noFolder.stages.find((s) => s.id === "capabilities")?.state).toBe("skipped");
    const blocked = computeBootProgress(thePlan, [
      step("FRIDAY ready", "missing", "no /health response"),
    ]);
    expect(blocked.ready).toBe(true);
    expect(blocked.readyOk).toBe(false);
    expect(blocked.blockers).toBe("no /health response");
  });

  it("lets the bar creep inside the stage being worked on, never into the next one", () => {
    const p = computeBootProgress(thePlan, [step("Detecting installation")]);
    expect(creepPercent(p, 0)).toBe(p.percent);
    const later = creepPercent(p, 12_000);
    expect(later).toBeGreaterThan(p.percent);
    expect(later).toBeLessThan(p.percent + p.headroom);
    expect(creepPercent(computeBootProgress(thePlan, [step("FRIDAY ready")]), 0)).toBe(100);
  });
});

describe("when the boot screen leaves", () => {
  const thePlan = plan.planFor("start");
  const working = computeBootProgress(thePlan, [step("Detecting installation")]);
  const ready = computeBootProgress(thePlan, [step("FRIDAY ready")]);
  const blocked = computeBootProgress(thePlan, [step("FRIDAY ready", "missing", "kernel down")]);

  it("leaves on ready (after a moment so it never flashes), not on a timer", () => {
    expect(bootGate(working, 5_000, 0)).toBe("wait");
    expect(bootGate(ready, BOOT_MIN_SHOWN_MS - 1, 0)).toBe("wait");
    expect(bootGate(ready, BOOT_MIN_SHOWN_MS, 0)).toBe("leave");
  });

  it("shows a blocked start's reason for a few seconds, offers to continue when slow, and gives up in the end", () => {
    expect(bootGate(blocked, 10_000, 100)).toBe("wait");
    expect(bootGate(blocked, 10_000, BOOT_BLOCKED_LINGER_MS)).toBe("leave");
    expect(bootGate(working, BOOT_STUCK_MS, 0)).toBe("stuck");
    expect(bootGate(working, BOOT_GIVE_UP_MS, 0)).toBe("leave");
  });
});

describe("what is on screen before and during the boot", () => {
  it("has a static splash in index.html: centered, no script, handed over by BootScreen", () => {
    const html = read("src/renderer/index.html");
    expect(html).toContain('id="friday-splash"');
    expect(html).toContain("splash-logo.png");
    expect(html).toMatch(/place-items:\s*center/);
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
    expect(fs.statSync(path.join(root, "src/renderer/splash-logo.png")).size).toBeLessThan(150_000);
    expect(read("src/components/friday/BootScreen.tsx")).toContain("friday-splash");
    expect(read("src/renderer/main.tsx")).toContain("friday-splash");
  });

  it("is fed by the main process: a plan, stage ids on every step, no fixed 2.6 s timer when a plan exists", () => {
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("boot:plan"');
    expect(read("electron/main.cjs")).toContain("stage: bootPlan.stageFor(label)");
    expect(read("electron/preload.cjs")).toContain(
      'getBootPlan: () => ipcRenderer.invoke("boot:plan")',
    );
    const screen = read("src/components/friday/BootScreen.tsx");
    expect(screen).toContain('role="progressbar"');
    expect(screen).not.toContain("backdrop-blur");
  });
});
