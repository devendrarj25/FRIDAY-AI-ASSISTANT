/**
 * FRIDAY · packaged-app probe execution contract.
 *
 * The measurement code was already correct — what broke on a real packaged,
 * elevated Windows instance was the CONTEXT the probes ran in. These tests lock
 * the three properties that make a probe survivable outside a dev shell:
 *
 *  1. A failure returns a REAL reason string, never a silent `null`.
 *  2. Interpreters and vendor binaries are resolved by absolute path, not by
 *     whatever PATH the packaged process happened to inherit.
 *  3. Nothing swallows an error into a value that looks like a real reading.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require_ = createRequire(import.meta.url);
const probe = require_(path.join(process.cwd(), "electron/probe-exec.cjs"));

describe("probe execution context", () => {
  it("reports a real reason when the binary does not exist", async () => {
    const result = await probe.runProbe("friday-definitely-not-a-real-binary", ["--version"], 3000);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBeNull();
    expect(result.error).toMatch(/not found/i);
  });

  it("captures a non-zero exit as a reason instead of nothing", async () => {
    const result = await probe.runProbe(process.execPath, ["-e", "process.exit(3)"], 8000);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/exited with code 3|failed/i);
  });

  it("captures stderr text as the reason", async () => {
    const result = await probe.runProbe(
      process.execPath,
      ["-e", "console.error('running scripts is disabled on this system'); process.exit(1)"],
      8000,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/execution policy|running scripts is disabled/i);
  });

  it("reports a timeout honestly rather than returning empty output", async () => {
    const result = await probe.runProbe(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      600,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/timed out/i);
  });

  it("returns measured output on success", async () => {
    const result = await probe.runProbe(process.execPath, ["-e", "process.stdout.write('42')"]);
    expect(result).toMatchObject({ ok: true, stdout: "42", error: null });
  });

  it("runs probes from a directory that always exists", () => {
    const cwd = probe.probeCwd();
    expect(cwd).toBeTruthy();
    expect(fs.existsSync(String(cwd))).toBe(true);
  });

  it("does not guess a bare name for a vendor binary on Windows", () => {
    const resolved = probe.resolveBinary("friday-not-installed-tool", []);
    // On Windows an unresolvable tool must be reported as absent so the caller
    // can say "not found" instead of spawning a name that will ENOENT.
    if (process.platform === "win32") expect(resolved).toBeNull();
    else expect(resolved).toBe("friday-not-installed-tool");
  });
});

describe("packaged-app hardening of the real probes", () => {
  const monitor = fs.readFileSync(path.join(process.cwd(), "electron/system-monitor.cjs"), "utf8");
  const hardware = fs.readFileSync(path.join(process.cwd(), "electron/hardware.cjs"), "utf8");

  it("never spawns a bare powershell.exe or nvidia-smi from the packaged process", () => {
    for (const source of [monitor, hardware]) {
      expect(source).not.toContain('run("powershell.exe"');
      expect(source).not.toContain('run("nvidia-smi"');
      expect(source).not.toContain('run("nvcc"');
    }
  });

  it("resolves PowerShell under the system root and bypasses execution policy", () => {
    const runner = fs.readFileSync(path.join(process.cwd(), "electron/probe-exec.cjs"), "utf8");
    expect(runner).toContain("WindowsPowerShell");
    expect(runner).toContain("Sysnative");
    expect(runner).toContain("Bypass");
  });

  it("looks for nvidia-smi where drivers actually install it", () => {
    const runner = fs.readFileSync(path.join(process.cwd(), "electron/probe-exec.cjs"), "utf8");
    expect(runner).toContain("NVIDIA Corporation\\\\NVSMI");
    expect(runner).toContain("CUDA_PATH");
  });

  it("treats null adapter sums as a failed read, not as zero traffic", () => {
    expect(monitor).toContain("parsed.rx === null");
    expect(monitor).toContain("adapter statistics returned no byte counters");
  });

  it("gives the network probe enough time for the NetAdapter module to load", () => {
    expect(monitor).toContain("PS_TIMEOUT_MS");
    expect(monitor).toContain("Import-Module NetAdapter");
  });

  it("hands the real GPU failure reason to the UI", () => {
    expect(monitor).toContain("GPU query failed:");
    expect(monitor).toContain("gpuRead?.reason");
  });
});
