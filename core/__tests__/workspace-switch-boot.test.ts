/**
 * FRIDAY · boot steps on every path that sets the FRIDAY folder
 *
 * runDataBootSteps used to run only at first boot. Picking or switching the folder (workspace:set) left the new
 * root without the data migrations and the built-ins sync. The reset channel also stayed silent for other pages.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

/** The text of one ipcMain.handle(channel, ...) block, up to the next top-level statement. */
function handlerSource(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start, `${channel} is handled in main.cjs`).toBeGreaterThanOrEqual(0);
  const next = main.indexOf("\nipcMain.handle(", start + 1);
  return main.slice(start, next < 0 ? undefined : next);
}

describe("workspace:set runs the boot data steps for the new root", () => {
  const handler = handlerSource("workspace:set");

  it("runs them after the canonical config and before the kernel restarts", () => {
    const config = handler.indexOf("ensureCanonicalConfig(resolvedRoot);");
    const steps = handler.indexOf("runDataBootSteps(resolvedRoot);");
    const restart = handler.indexOf("restartKernel();");
    expect(config).toBeGreaterThanOrEqual(0);
    expect(steps).toBeGreaterThan(config);
    expect(restart).toBeGreaterThan(steps);
  });

  it("does that inside the guarded setup, so a failing step never blocks the switch", () => {
    const tryAt = handler.indexOf("try {");
    const catchAt = handler.indexOf("} catch (error) {");
    const steps = handler.indexOf("runDataBootSteps(resolvedRoot);");
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(steps).toBeGreaterThan(tryAt);
    expect(steps).toBeLessThan(catchAt);
  });

  it("forgets the old root's model check so the new root is checked on its own", () => {
    const steps = handler.indexOf("runDataBootSteps(resolvedRoot);");
    const reset = handler.indexOf("modelCheckState.settled = false");
    expect(reset).toBeGreaterThan(steps);
    expect(handler).toContain("modelCheckState.last = null");
  });
});

describe("the first-boot call stays the only boot-time call", () => {
  it("calls runDataBootSteps once with root at boot and once with resolvedRoot on a folder switch", () => {
    expect(main.match(/runDataBootSteps\(root\)/g)).toHaveLength(1);
    expect(main.match(/runDataBootSteps\(resolvedRoot\)/g)).toHaveLength(1);
  });
});

describe("capabilities:reset-builtin tells the other pages", () => {
  const handler = handlerSource("capabilities:reset-builtin");

  it("broadcasts capabilities:changed with the reset id, only when the reset worked", () => {
    expect(handler).toContain("resetBuiltin(");
    expect(handler).toMatch(
      /if \(result\.ok\) send\("capabilities:changed", \{ reset: result\.id \}\)/,
    );
  });

  it("returns the module's own result to the caller unchanged", () => {
    expect(handler).toMatch(/return result;/);
  });
});
