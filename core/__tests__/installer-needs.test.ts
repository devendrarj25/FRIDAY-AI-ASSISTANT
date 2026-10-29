/**
 * What a package needs is installed first. The desktop queue is serial, so the
 * missing runtime is queued ahead of the tool that runs on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../../src/lib/friday/catalog";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("catalog needs", () => {
  it("only names packages that exist in the catalog", () => {
    const names = new Set(catalog.map((e) => e.pkg));
    for (const e of catalog)
      for (const need of e.needs ?? []) expect(names.has(need), need).toBe(true);
  });

  it("states the runtime behind the common tools", () => {
    const needs = (pkg: string) => catalog.find((e) => e.pkg === pkg)?.needs;
    expect(needs("Maven")).toEqual(["OpenJDK (Temurin)"]);
    expect(needs("pnpm")).toEqual(["Node.js LTS"]);
    expect(needs("Docker Compose")).toEqual(["Docker Desktop"]);
  });
});

describe("desktop queue order", () => {
  it("queues a missing runtime before the tool that needs it", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      friday: { isDesktop: true, detectTools: async () => ({ tools: [] }) },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const { installer } = await import("../../src/lib/friday/installer-engine");
    installer.state.bridge = "desktop";
    installer.state.probed = ["Node.js LTS"];
    installer.state.installed["Node.js LTS"] = null;
    const job = installer.enqueue("pnpm", "install");
    const jobs = installer.getSnapshot().jobs;
    const order = jobs.map((j) => j.pkg);
    expect(job?.pkg).toBe("pnpm");
    expect(order.indexOf("Node.js LTS")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Node.js LTS")).toBeLessThan(order.indexOf("pnpm"));
  });
});

describe("a scan that fails", () => {
  it("is shown with its reason instead of silently keeping old data", async () => {
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      friday: {
        isDesktop: true,
        detectTools: async () => {
          throw new Error("the probe timed out");
        },
        latestToolVersions: async () => ({}),
        providerKeys: async () => ({}),
      },
    });
    const { installer } = await import("../../src/lib/friday/installer-engine");
    installer.state.bridge = "desktop";
    await installer.refreshFromSystem(true);
    expect(installer.getSnapshot().scanError).toBe("the probe timed out");
    expect(installer.getSnapshot().scanning).toBe(false);
  });

  it("flags that the newest versions could not be read", async () => {
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      friday: {
        isDesktop: true,
        detectTools: async () => ({ tools: [] }),
        latestToolVersions: async () => {
          throw new Error("offline");
        },
        providerKeys: async () => ({}),
        toolServices: async () => ({ services: [], idleMinutes: 20 }),
      },
    });
    const { installer } = await import("../../src/lib/friday/installer-engine");
    installer.state.bridge = "desktop";
    await installer.refreshFromSystem(true);
    expect(installer.getSnapshot().latestFailed).toBe(true);
    expect(installer.getSnapshot().scanError).toBeNull();
  });
});

describe("agent toolkit queue", () => {
  it("queues the manifest's missing tools in order, skips what is installed and gates CUDA on an NVIDIA driver", async () => {
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      friday: { isDesktop: true, detectTools: async () => ({ tools: [] }) },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    const { installer } = await import("../../src/lib/friday/installer-engine");
    const manifest = (await import("../../config/agent-toolkit.json")).default;
    installer.state.bridge = "desktop";
    installer.state.probed = ["Git"];
    installer.state.installed["Git"] = "2.50.0";
    const queued = installer.installToolkit();
    const order = installer.getSnapshot().jobs.map((j) => j.pkg);
    expect(queued).toBeGreaterThan(10);
    expect(order).toContain("Docker Desktop");
    expect(order).not.toContain("Git");
    expect(order).not.toContain("CUDA Toolkit");
    expect(order.indexOf("WSL 2")).toBeLessThan(order.indexOf("Docker Desktop"));
    for (const row of manifest.prefetch as { id: string; catalog?: string; requires?: string }[]) {
      if (row.requires === "nvidia-gpu") continue;
      if (row.id === "Git") continue;
      expect(order, row.id).toContain(row.catalog ?? row.id);
    }
  });
});
