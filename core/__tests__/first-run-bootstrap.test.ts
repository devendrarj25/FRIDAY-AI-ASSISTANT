/**
 * ISSUE 3 — first run set nothing up.
 *
 * `installer/first-run/index.ts` only ever flipped a flag. These tests drive
 * the real bootstrap module with the Install Manager and the model downloader
 * replaced by recording doubles, and prove it:
 *   • calls models.connectProvider() for a pasted key (never invents one),
 *   • calls models.install() for the offline chat model,
 *   • calls installer.enqueue() for the existing voice catalog rows,
 *   • marks first-run complete over the real IPC bridge, exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const installerCalls: Array<{ pkg: string; action: string }> = [];
const modelCalls: string[] = [];
const providerCalls: Array<{ id: string; key: string }> = [];

let installedPackages: Record<string, string | null> = {};
let installedModels: Record<string, string | null> = {};

vi.mock("../../src/lib/friday/installer-engine", () => ({
  isJobActive: (phase: string) => !["Done", "Failed", "Manual", "Cancelled"].includes(phase),
  installer: {
    getSnapshot: () => ({
      installed: installedPackages,
      jobs: installerCalls.map((c, i) => ({
        id: `job-${i}`,
        pkg: c.pkg,
        phase: "Done",
        detail: "installed",
      })),
    }),
    enqueue: (pkg: string, action: string) => {
      installerCalls.push({ pkg, action });
      return { id: `job-${installerCalls.length - 1}`, pkg, action, phase: "Queued", detail: "" };
    },
  },
}));

vi.mock("../../src/lib/friday/models-engine", () => ({
  models: {
    getSnapshot: () => ({
      installed: installedModels,
      jobs: modelCalls.map((id) => ({ modelId: id, phase: "Done", detail: "installed" })),
      providerState: { groq: { online: true, models: 12, error: null } },
    }),
    install: (id: string) => {
      modelCalls.push(id);
      installedModels[id] = "1.0";
    },
    connectProvider: (id: string, key: string) => providerCalls.push({ id, key }),
  },
}));

const completed: Array<{ steps: Array<{ id: string; state: string }> }> = [];
let record = {
  completed: false,
  completedAt: null as number | null,
  version: null as string | null,
};

beforeEach(() => {
  installerCalls.length = 0;
  modelCalls.length = 0;
  providerCalls.length = 0;
  completed.length = 0;
  installedPackages = {};
  installedModels = {};
  record = { completed: false, completedAt: null, version: null };
  (globalThis as unknown as { window: unknown }).window = {
    friday: {
      firstRunState: async () => record,
      completeFirstRun: async (payload: { steps: Array<{ id: string; state: string }> }) => {
        completed.push(payload);
        record = { completed: true, completedAt: Date.now(), version: "test" };
        return { ok: true };
      },
    },
  };
});

const load = () => import("../../src/lib/friday/first-run");

describe("first-run bootstrap performs real installs", () => {
  it("connects a pasted key, downloads the offline model and installs both voice engines", async () => {
    const mod = await load();
    const result = await mod.runFirstRunBootstrap({
      keys: [{ id: "groq" as never, apiKey: "gsk_real_key" }],
    });

    expect(providerCalls).toEqual([{ id: "groq", key: "gsk_real_key" }]);
    expect(modelCalls).toEqual([mod.BOOTSTRAP_MODEL_ID]);
    expect(installerCalls).toEqual(
      mod.BOOTSTRAP_VOICE_PACKAGES.map((pkg) => ({ pkg, action: "install" })),
    );
    expect(result.completed).toBe(true);
    // Every install step really succeeded. The runtime verification step is
    // separate on purpose: without the desktop bridge it CANNOT pass, and it
    // reports that instead of pretending the voice runtime works.
    expect(
      result.steps.filter((s) => s.id !== "voice:verify").every((s) => s.state === "done"),
    ).toBe(true);
    const verify = result.steps.find((s) => s.id === "voice:verify");
    expect(verify?.state).toBe("failed");
    expect(verify?.detail).toContain("desktop app required");
  });

  it("never invents a key: an empty box is simply not connected", async () => {
    const mod = await load();
    await mod.runFirstRunBootstrap({ keys: [{ id: "groq" as never, apiKey: "   " }] });
    expect(providerCalls).toEqual([]);
    // The offline fallback is still installed with zero cloud keys.
    expect(modelCalls).toEqual([mod.BOOTSTRAP_MODEL_ID]);
  });

  it("marks itself complete and never re-runs on the next launch", async () => {
    const mod = await load();
    expect((await mod.firstRunState()).completed).toBe(false);
    await mod.runFirstRunBootstrap({});
    expect(completed).toHaveLength(1);
    expect((await mod.firstRunState()).completed).toBe(true);
  });

  it("records an explicit skip so the screen never comes back", async () => {
    const mod = await load();
    await mod.skipFirstRun();
    expect(completed[0]?.steps[0]).toMatchObject({ id: "skipped", state: "skipped" });
    expect((await mod.firstRunState()).completed).toBe(true);
    // Skipping installs nothing at all.
    expect(installerCalls).toEqual([]);
    expect(modelCalls).toEqual([]);
  });

  it("skips work that is already installed instead of re-downloading", async () => {
    const mod = await load();
    installedPackages = { "faster-whisper": "1.0.3", "edge-tts": "6.1.12" };
    installedModels = { [mod.BOOTSTRAP_MODEL_ID]: "3.2" };
    await mod.runFirstRunBootstrap({});
    expect(installerCalls).toEqual([]);
    expect(modelCalls).toEqual([]);
  });

  it("uses catalog rows and a model id that really exist", async () => {
    const mod = await load();
    const { readFileSync } = await import("node:fs");
    const catalog = readFileSync("src/lib/friday/catalog.ts", "utf8");
    for (const pkg of mod.BOOTSTRAP_VOICE_PACKAGES) expect(catalog).toContain(`"${pkg}"`);
    const modelCatalog = readFileSync("src/lib/friday/model-catalog.ts", "utf8");
    expect(modelCatalog).toContain(`"${mod.BOOTSTRAP_MODEL_ID}"`);
  });
});
