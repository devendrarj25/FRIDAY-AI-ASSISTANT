import { describe, expect, it } from "vitest";
import {
  capabilityRegistry,
  capabilityRunnable,
} from "../../src/lib/friday/brain/capability-registry";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

describe("FRIDAY capability registry", () => {
  it("builds one snapshot of everything FRIDAY can do", () => {
    const snapshot = capabilityRegistry.refresh();
    expect(snapshot.resources.length).toBeGreaterThan(0);
    expect(snapshot.refreshedAt).toBeGreaterThan(0);
    expect(snapshot.availableCount).toBeLessThanOrEqual(snapshot.resources.length);
  });

  it("never registers the same resource twice", () => {
    capabilityRegistry.refresh();
    const snapshot = capabilityRegistry.refresh();
    const ids = snapshot.resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("always knows her own browser and search path", () => {
    const snapshot = capabilityRegistry.refresh();
    const search = snapshot.resources.find((r) => r.ref === "web-search");
    expect(search).toBeDefined();
    expect(search?.capabilities).toContain("search");
    expect(search?.available).toBe(true);
  });

  it("marks the resources that need the owner's consent", () => {
    const snapshot = capabilityRegistry.refresh();
    const shell = snapshot.resources.find((r) => r.ref === "shell");
    expect(shell?.permission).toBe("owner-only");
    const memoryTool = snapshot.resources.find((r) => r.ref === "memory");
    expect(memoryTool?.permission).toBe("open");
  });

  it("ranks resources best-first for a need", () => {
    capabilityRegistry.refresh();
    const best = capabilityRegistry.best("search", { limit: 3 });
    expect(best.length).toBeGreaterThan(0);
    expect(best.every((r) => r.available)).toBe(true);
  });

  it("exposes a digest the brain can put in a prompt", () => {
    capabilityRegistry.refresh();
    const digest = capabilityRegistry.digest(5);
    expect(digest).toMatch(/Available capabilities/);
  });

  it("is reachable from the Core Brain", () => {
    const snapshot = coreBrain.capabilities(true);
    expect(snapshot.resources.length).toBeGreaterThan(0);
  });

  it("lists the live Logs stream as a built-in inspect-only capability", () => {
    const snapshot = capabilityRegistry.refresh();
    const logs = snapshot.resources.find((resource) => resource.ref === "logs");
    expect(logs).toBeDefined();
    expect(logs?.type).toBe("system");
    expect(logs?.runnable).toBe(false);
    expect(logs?.capabilities).toContain("diagnose");
  });

  it("lists the live Task graph as a built-in inspect-only capability", () => {
    const snapshot = capabilityRegistry.refresh();
    const tasks = snapshot.resources.find((resource) => resource.ref === "task-graph");
    expect(tasks).toBeDefined();
    expect(tasks?.type).toBe("system");
    expect(tasks?.runnable).toBe(false);
    expect(tasks?.capabilities).toContain("queue");
  });

  it("lists Setup & Doctor as a built-in inspect-only capability", () => {
    const snapshot = capabilityRegistry.refresh();
    const doctorCap = snapshot.resources.find((resource) => resource.ref === "doctor");
    expect(doctorCap).toBeDefined();
    expect(doctorCap?.type).toBe("system");
    expect(doctorCap?.runnable).toBe(false);
    expect(doctorCap?.capabilities).toContain("diagnose");
    expect(doctorCap?.capabilities).toContain("repair");
  });

  it("lists Install Manager as a built-in inspect-only capability", () => {
    const snapshot = capabilityRegistry.refresh();
    const installCap = snapshot.resources.find((resource) => resource.ref === "install-manager");
    expect(installCap).toBeDefined();
    expect(installCap?.type).toBe("system");
    expect(installCap?.runnable).toBe(false);
    expect(installCap?.capabilities).toContain("install");
    expect(installCap?.capabilities).toContain("toolchain");
  });

  it("lists source health as a built-in capability, not a hardcoded side list", () => {
    const snapshot = capabilityRegistry.refresh();
    const source = snapshot.resources.find((resource) => resource.ref === "source-health");
    expect(source).toBeDefined();
    expect(source?.type).toBe("system");
    expect(source?.capabilities).toContain("diagnose");
    expect(source?.detail).toMatch(/approval-gated/i);
  });

  it("lists system wiring as a built-in inspect-only capability", () => {
    const snapshot = capabilityRegistry.refresh();
    const wiring = snapshot.resources.find((resource) => resource.ref === "system-wiring");
    expect(wiring).toBeDefined();
    expect(wiring?.type).toBe("system");
    expect(wiring?.runnable).toBe(false);
  });

  it("registers page interact, skill-forge drafts and real-data charts in the one registry", () => {
    const snapshot = capabilityRegistry.refresh();
    expect(snapshot.resources.find((resource) => resource.ref === "web-interact")).toBeDefined();
    expect(snapshot.resources.find((resource) => resource.ref === "skill-forge")?.permission).toBe(
      "ask",
    );
    expect(snapshot.resources.find((resource) => resource.ref === "module-forge")?.permission).toBe(
      "ask",
    );
    expect(snapshot.resources.find((resource) => resource.ref === "plugin-forge")?.permission).toBe(
      "ask",
    );
    expect(
      snapshot.resources.find((resource) => resource.ref === "workflow-forge")?.permission,
    ).toBe("ask");
    expect(snapshot.resources.find((resource) => resource.ref === "workflow-catalog")?.type).toBe(
      "workflow",
    );
    expect(snapshot.resources.find((resource) => resource.ref === "tool-catalog")?.type).toBe(
      "tool",
    );
    expect(snapshot.resources.find((resource) => resource.ref === "module-catalog")?.type).toBe(
      "module",
    );
    expect(snapshot.resources.find((resource) => resource.ref === "stage-chart")).toBeDefined();
  });

  it("treats every non-model type as planner-runnable so the phone cannot keep a second allowlist", () => {
    expect(capabilityRunnable("model")).toBe(false);
    expect(capabilityRunnable("tool")).toBe(true);
    expect(capabilityRunnable("browser")).toBe(true);
    expect(capabilityRunnable("system")).toBe(true);
    expect(capabilityRunnable("skill")).toBe(true);
    expect(capabilityRunnable("module")).toBe(true);
    expect(capabilityRunnable("plugin")).toBe(true);
  });
});
