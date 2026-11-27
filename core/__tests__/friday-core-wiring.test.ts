/**
 * FRIDAY Core wiring in the main process: the kernel call is bound once, the Core row is pushed after every kernel
 * ready (a restart too), Core starts only while the owner's setting is on, and an old stored shape reads off.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

type Wiring = { onKernelReady(): void; apply(enabled: unknown): Promise<unknown> | undefined };

function loadFactory(): (o: Record<string, unknown>) => Wiring {
  const start = main.indexOf("function createCoreWiring(");
  const end = main.indexOf("\nconst coreWiring = ", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(`${main.slice(start, end)}\nreturn createCoreWiring;`)();
}

function setup(enabled: boolean) {
  const state = { enabled };
  const api = {
    bindCoreKernel: vi.fn(),
    pushCoreToKernel: vi.fn(async () => true),
    startCore: vi.fn(async () => ({ ok: true })),
    stopCore: vi.fn(async () => true),
  };
  const request = vi.fn();
  const wiring = loadFactory()({ api, request, isEnabled: () => state.enabled });
  return { api, request, wiring, state };
}

describe("FRIDAY Core wiring", () => {
  it("binds the kernel call once and pushes after every kernel ready", () => {
    const { api, request, wiring } = setup(false);
    wiring.onKernelReady();
    wiring.onKernelReady();
    expect(api.bindCoreKernel).toHaveBeenCalledTimes(1);
    expect(api.bindCoreKernel).toHaveBeenCalledWith(request);
    expect(api.pushCoreToKernel).toHaveBeenCalledTimes(2);
    expect(api.startCore).not.toHaveBeenCalled();
  });

  it("starts Core only when the setting is on, and stops it when it turns off", async () => {
    const { api, wiring, state } = setup(false);
    await wiring.apply(false);
    expect(api.startCore).not.toHaveBeenCalled();
    state.enabled = true;
    await wiring.apply(true);
    expect(api.startCore).toHaveBeenCalledTimes(1);
    await wiring.apply(true);
    expect(api.startCore).toHaveBeenCalledTimes(1);
    state.enabled = false;
    await wiring.apply(false);
    expect(api.stopCore).toHaveBeenCalledTimes(1);
  });

  it("starts Core at kernel ready when the stored choice is on", () => {
    const { api, wiring } = setup(true);
    wiring.onKernelReady();
    expect(api.startCore).toHaveBeenCalledTimes(1);
  });

  it("survives a missing or failing api", async () => {
    const make = loadFactory();
    const bare = make({ api: {}, request: vi.fn(), isEnabled: () => true });
    expect(() => bare.onKernelReady()).not.toThrow();
    const failing = make({
      api: { startCore: async () => Promise.reject(new Error("x")) },
      request: vi.fn(),
      isEnabled: () => true,
    });
    await expect(failing.apply(true)).resolves.toBeUndefined();
  });

  it("is wired into the kernel-ready step and the preference effects", () => {
    expect(main).toMatch(/connectSessionStream\(\);\s*coreWiring\.onKernelReady\(\);/);
    expect(main).toContain("coreWiring.apply(toggles.brainCoreEnabled)");
    expect(main).toContain('ownerPrefToggle("brainCoreEnabled", false)');
  });

  it("reads off for an old stored shape and honours an explicit choice", () => {
    expect(DEFAULT_PREFERENCES.toggles["brainCoreEnabled"]).toBe(false);
    const preferencesSource = fs.readFileSync(
      path.join(root, "src/lib/friday/preferences.ts"),
      "utf8",
    );
    expect(preferencesSource).toContain("toggles: { ...base.toggles, ...(patch.toggles ?? {}) }");
  });
});
