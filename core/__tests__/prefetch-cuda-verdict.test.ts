import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const prefetch = require("../../scripts/prefetch-models.cjs");

type Run = (cmd: string, args: string[], opts: Record<string, unknown>) => unknown;

const gpuProbe = { gpu: { name: "card", vramGb: 16 } };
const noGpuProbe = { gpu: { name: "", vramGb: 0 } };
const withPython = { FRIDAY_PYTHON: process.execPath } as NodeJS.ProcessEnv;

const answer =
  (stdout: string, status = 0): Run =>
  () => ({ status, stdout });

describe("setup prefetch asks the speech kernel for the CUDA verdict", () => {
  it("is true only when the kernel answers cudaRuntimeReady true", () => {
    const yes = answer('{"ok":true,"cudaRuntimeReady":true}\n');
    const no = answer('{"ok":true,"cudaRuntimeReady":false}\n');
    expect(prefetch.setupCudaVerdict(withPython, gpuProbe, { spawnSync: yes })).toBe(true);
    expect(prefetch.setupCudaVerdict(withPython, gpuProbe, { spawnSync: no })).toBe(false);
  });

  it("never starts Python when no graphics card was seen or no Python exists", () => {
    let calls = 0;
    const spy: Run = () => {
      calls += 1;
      return { status: 0, stdout: '{"cudaRuntimeReady":true}' };
    };
    expect(prefetch.setupCudaVerdict(withPython, noGpuProbe, { spawnSync: spy })).toBe(false);
    expect(prefetch.setupCudaVerdict({} as NodeJS.ProcessEnv, gpuProbe, { spawnSync: spy })).toBe(
      false,
    );
    expect(prefetch.setupCudaVerdict(withPython, undefined, { spawnSync: spy })).toBe(false);
    expect(calls).toBe(0);
  });

  it("answers no for a failed, timed-out, garbage or truthy-but-not-true reply", () => {
    const cases: Run[] = [
      () => ({ error: new Error("ETIMEDOUT"), status: null, stdout: "" }),
      answer("", 1),
      answer("not json"),
      answer('{"cudaRuntimeReady":"yes"}'),
      answer('{"cudaRuntimeReady":1}'),
      () => {
        throw new Error("spawn failed");
      },
    ];
    for (const spawnSync of cases) {
      expect(prefetch.setupCudaVerdict(withPython, gpuProbe, { spawnSync })).toBe(false);
    }
  });

  it("reads the JSON line even after other output lines and passes the GPU flag to the kernel only", () => {
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    const spawnSync: Run = (_cmd, args, opts) => {
      seenArgs = args;
      seenEnv = opts["env"] as Record<string, string>;
      return { status: 0, stdout: 'warning line\n{"ok":true,"cudaRuntimeReady":true}\n' };
    };
    expect(prefetch.setupCudaVerdict(withPython, gpuProbe, { spawnSync })).toBe(true);
    expect(seenArgs[seenArgs.length - 1]).toBe("--probe");
    expect(seenArgs.some((a) => a.endsWith("stt.py"))).toBe(true);
    expect(seenEnv["FRIDAY_STT_CUDA"]).toBe("1");
  });
});
