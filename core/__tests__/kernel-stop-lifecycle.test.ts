/**
 * Stopping and replacing the Python kernel. On Windows a virtual environment's python.exe is a launcher with the real
 * interpreter under it, and child.kill() ends only the launcher, so the interpreter kept the kernel port and the next
 * start could not bind it. And an exit event from an old kernel arriving after a new one started marked the new one as
 * down. Both are pinned against the main-process source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const main = readFileSync(path.resolve(__dirname, "../../electron/main.cjs"), "utf8");
const between = (from: string, to: string) => {
  const at = main.indexOf(from);
  expect(at, from).toBeGreaterThan(-1);
  return main.slice(at, main.indexOf(to, at));
};

describe("stopping the kernel", () => {
  it("ends the whole process tree on Windows, in a restart and at quit", () => {
    const stop = between("async function stopKernel(", "let kernelRestart");
    expect(stop).toContain('process.platform === "win32" && child.pid');
    expect(stop).toContain("appLifecycle.killProcessTree(child.pid)");
    expect(stop).toContain("else child.kill()");
    const quit = main.slice(
      main.indexOf("kernel.pid) appLifecycle.killProcessTree(kernel.pid)") - 120,
    );
    expect(quit).toContain('process.platform === "win32" && kernel.pid');
  });
});

describe("events from an older kernel", () => {
  it("only reset the live kernel when they come from it", () => {
    const block = between("const thisKernel = kernel;", "// The process now exists");
    expect(block).toContain("if (kernel === thisKernel)");
    expect(block.match(/if \(kernel === thisKernel\)/g)?.length).toBe(2);
    expect(block).toContain('thisKernel.on("exit"');
    expect(block).toContain("kernelAuto?.onProcessExit(code, { shutdownStarted })");
  });
});
