import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const paths = require_("../../electron/friday-paths.cjs");
const { runReadiness } = require_("../../electron/readiness.cjs");

/** Minimal context: no window, no kernel — we only assert the BOOT contract. */
const ctx = {
  win: null,
  waitForKernel: async () => false,
  kernelUrl: "http://127.0.0.1:1",
  kernelRequest: async () => {
    throw new Error("kernel is not running");
  },
  getWorkspaceRoot: () => paths.root(),
};

const bootOf = async () => {
  const report = await runReadiness(ctx);
  return report.stages.find((s: { name: string }) => s.name === "BOOT");
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-readiness-"));
});

afterEach(() => {
  paths.setRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("readiness BOOT stage", () => {
  it("fails when no FRIDAY root is selected", async () => {
    paths.setRoot(null);
    const boot = await bootOf();
    expect(boot.ok).toBe(false);
  });

  it("fails when the canonical folders are missing", async () => {
    paths.setRoot(root);
    const boot = await bootOf();
    expect(boot.ok).toBe(false);
    expect(boot.detail).toBeTruthy();
  });

  it("never reports KERNEL ready without a usable root", async () => {
    paths.setRoot(null);
    const report = await runReadiness(ctx);
    const kernel = report.stages.find((s: { name: string }) => s.name === "KERNEL");
    expect(kernel.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("recreates the canonical structure inside the selected root only", () => {
    paths.setRoot(root);
    const created = paths.ensureStructure(root);
    expect(created.root).toBe(root);
    expect(paths.databaseFile().startsWith(root)).toBe(true);
    expect(paths.dir("memory").startsWith(root)).toBe(true);
  });
});
