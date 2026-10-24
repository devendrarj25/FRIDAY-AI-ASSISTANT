/**
 * A provider whose key is being checked says so ("Checking…") instead of
 * flashing Not connected and then Connected, and importing the same model file
 * twice keeps one row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const stubDesktop = (friday: Record<string, unknown>) =>
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    friday: { isDesktop: true, ...friday },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("provider connection check", () => {
  it("is marked as checking while the real probe runs, then settles", async () => {
    let finish: (v: unknown) => void = () => {};
    stubDesktop({
      setProviderKey: async () => ({ ok: true }),
      testModelProvider: () => new Promise((resolve) => (finish = resolve)),
    });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    const pending = models.connectProvider("groq", "gsk_test");
    await Promise.resolve();
    await Promise.resolve();
    expect(models.state.providerState["groq"]!.checking).toBe(true);
    expect(models.state.providerState["groq"]!.online).toBe(false);
    finish({ online: true, latencyMs: 80, models: 5, error: null });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(models.state.providerState["groq"]!.checking).toBe(false);
    expect(models.state.providerState["groq"]!.online).toBe(true);
  });

  it("clears the checking mark when the probe fails", async () => {
    stubDesktop({
      setProviderKey: async () => ({ ok: true }),
      testModelProvider: async () => {
        throw new Error("network down");
      },
    });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    const result = await models.connectProvider("groq", "gsk_test");
    expect(result.ok).toBe(false);
    expect(models.state.providerState["groq"]!.checking).toBe(false);
  });
});

describe("importing the same model twice", () => {
  it("keeps one row and does not start a second import while one runs", async () => {
    let finish: (v: unknown) => void = () => {};
    const importModel = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    stubDesktop({ importModel, onModelImportProgress: () => () => {} });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    models.state.imported = [];
    const first = models.importModel({ path: "C:\\Models\\auk-flash-f16.gguf" });
    const again = await models.importModel({ path: "C:\\Models\\auk-flash-f16.gguf" });
    expect(importModel).toHaveBeenCalledTimes(1);
    expect(again.state).toBe("importing");
    finish({ ok: true, state: "stored", note: "stored", format: "GGUF", bytes: 1 });
    await first;
    // A retry after it finished replaces the row.
    const retry = models.importModel({ path: "C:\\Models\\auk-flash-f16.gguf" });
    await Promise.resolve();
    expect(models.state.imported).toHaveLength(1);
    finish({ ok: true, state: "ready", format: "GGUF", bytes: 1 });
    await retry;
    expect(models.state.imported).toHaveLength(1);
  });
});
