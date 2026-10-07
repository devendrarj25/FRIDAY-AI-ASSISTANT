/**
 * The wiring guard.
 *
 * These tests are what keeps FRIDAY connected as she grows: add an IPC handler
 * without exposing it, a kernel method nobody calls, or a route nobody can
 * reach, and the suite fails here instead of shipping a dead button.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..", "..");
const connectivity = require_(path.join(ROOT, "electron", "connectivity.cjs"));

const graph = connectivity.buildGraph(ROOT);

describe("connectivity graph", () => {
  it("derives a graph from real project files", () => {
    expect(graph.summary.ipc).toBeGreaterThan(100);
    expect(graph.summary.pages).toBeGreaterThan(10);
    expect(graph.summary.kernelMethods).toBeGreaterThan(20);
    expect(graph.summary.capabilityTrees).toBeGreaterThan(5);
  });

  it("exposes every IPC handler through the preload bridge", () => {
    const missing = graph.issues.filter((i: { kind: string }) => i.kind === "ipc");
    expect(missing.map((i: { id: string }) => i.id)).toEqual([]);
  });

  it("has a caller for every kernel bridge method", () => {
    const orphans = graph.kernel.methods
      .filter((m: { callers: string[] }) => m.callers.length === 0)
      .map((m: { id: string }) => m.id);
    expect(orphans).toEqual([]);
  });

  it("keeps the typed kernel client in sync with the kernel dispatch", async () => {
    const { KERNEL_METHODS } = await import("../../src/lib/friday/kernel-api");
    const declared = new Set<string>(KERNEL_METHODS as readonly string[]);
    const missing = graph.kernel.methods
      .map((m: { id: string }) => m.id)
      .filter((id: string) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it("reports no broken links", () => {
    const errors = graph.issues.filter((i: { severity: string }) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("ConnectivityPanel refreshes the singleton store, not a second dynamic import", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/components/friday/ConnectivityPanel.tsx"),
      "utf8",
    );
    expect(src).toMatch(/connectivity\.refresh/);
    expect(src).not.toMatch(/await import\(/);
  });
});
