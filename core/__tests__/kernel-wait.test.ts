/**
 * A wait for the local AI service must survive the moment before the kernel process exists. Readiness used to ask
 * during that moment, get an instant "no", and report "kernel did not answer /health" on a restart that was fine.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wait = require("../../electron/kernel-wait.cjs") as {
  shouldStopWaiting: (s: Record<string, unknown>) => boolean;
  hasKnownFailure: (s: Record<string, unknown>) => boolean;
};
const base = {
  kernel: null,
  kernelReady: false,
  kernelStartPromise: null,
  kernelFailure: "",
  bootPending: false,
};

describe("kernel wait", () => {
  it("keeps waiting while a start is still on its way", () => {
    expect(wait.shouldStopWaiting({ ...base, bootPending: true })).toBe(false);
    expect(wait.shouldStopWaiting({ ...base, kernelStartPromise: Promise.resolve() })).toBe(false);
    expect(wait.shouldStopWaiting({ ...base, kernel: {} })).toBe(false);
    expect(wait.shouldStopWaiting({ ...base, kernelReady: true })).toBe(false);
  });

  it("stops only for a kernel that is gone and not coming back", () => {
    expect(wait.shouldStopWaiting(base)).toBe(true);
  });

  it("a known failure ends the wait at once, but not while a start is pending", () => {
    const failed = { ...base, kernelFailure: "Python was not found" };
    expect(wait.hasKnownFailure(failed)).toBe(true);
    expect(wait.hasKnownFailure({ ...failed, bootPending: true })).toBe(false);
    expect(wait.hasKnownFailure({ ...failed, kernel: {} })).toBe(false);
  });

  it("main.cjs uses it, marks every start and restart, and readiness names the kernel's own reason", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "../../electron/main.cjs"), "utf8");
    expect(main).toContain('require("./kernel-wait.cjs")');
    expect(main).toMatch(/kernelBootPending = true;\s+try \{\s+await startKernelNow\(root\)/);
    expect(main).toMatch(/kernelBootPending = true;\s+kernelRestart = kernelRestart/);
    const readiness = fs.readFileSync(
      path.resolve(__dirname, "../../electron/readiness.cjs"),
      "utf8",
    );
    expect(readiness).toContain("ctx.kernelFailure");
  });
});

describe("readiness hears the build's own speech weights", () => {
  it("finds staged weights by size and ignores a folder without a model", () => {
    const os = require("node:os") as typeof import("node:os");
    const verify = require("../../electron/voice-verify.cjs") as {
      stagedSttEnv: (o: { roots: string[] }) => Record<string, string> | undefined;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-staged-stt-"));
    try {
      expect(verify.stagedSttEnv({ roots: [dir] })).toBeUndefined();
      const base = path.join(dir, "cache", "stt", "base");
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, "config.json"), "{}");
      expect(verify.stagedSttEnv({ roots: [dir] })).toBeUndefined();
      fs.writeFileSync(path.join(base, "model.bin"), "x");
      expect(verify.stagedSttEnv({ roots: [dir] })).toEqual({
        FRIDAY_STT_MODEL: "base",
        FRIDAY_STT_MODEL_PATH: base,
      });
      const small = path.join(dir, "cache", "stt", "small");
      fs.mkdirSync(small, { recursive: true });
      fs.writeFileSync(path.join(small, "config.json"), "{}");
      fs.writeFileSync(path.join(small, "model.bin"), "x");
      expect(verify.stagedSttEnv({ roots: [dir] })?.FRIDAY_STT_MODEL).toBe("small");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
