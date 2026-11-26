/**
 * The first kernel start already sees the Program Files tools (Tesseract, FFmpeg, Git): the managed folders are applied
 * to this process before the kernel is spawned, the way the Install Manager does after an install.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("electron/main.cjs", "utf8");

describe("kernel spawn PATH", () => {
  it("applies the managed PATH before the kernel process is spawned, and a failure never stops the boot", () => {
    const spawnAt = main.indexOf("kernel = spawn(python, [...pythonPrefix, entry]");
    expect(spawnAt).toBeGreaterThan(0);
    const before = main.slice(
      main.lastIndexOf("kernelInstanceId = crypto.randomUUID();", spawnAt),
      spawnAt,
    );
    expect(before).toContain("toolchain.applyManagedPath(root)");
    const call = before.indexOf("toolchain.applyManagedPath(root)");
    expect(before.slice(Math.max(0, call - 20), call)).toMatch(/try \{\s*$/);
    expect(before.slice(call)).toMatch(/\}\s*catch/);
    // The spawn env copies process.env after that call, so the kernel inherits the new PATH.
    expect(main.slice(spawnAt, spawnAt + 120)).toContain("env: {");
    expect(main.slice(spawnAt, spawnAt + 200)).toContain("...process.env");
  });
});
