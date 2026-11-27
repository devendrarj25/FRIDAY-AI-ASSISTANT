/**
 * The dual chat engine and the learning rails reach the owner: two IPC channels (read state, owner-started bench),
 * the stored settings of D9, the Brain settings controls and the "Learn from me" panel. Source-pinned where the
 * code is React; behaviour-tested where it is a pure module.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DEFAULT_PREFERENCES,
  ENGINE_PREFER_CHOICES,
  LEARN_DATA_CLASSES,
  acceptedLearnClasses,
  enginePreferOf,
} from "../../src/lib/friday/preferences";
import { benchMessage, engineLabel, adapterUndoTarget } from "../../src/lib/friday/llm-engine";

import { gateFromGovernor, rowsFromExperiences } from "../../src/lib/friday/learn-from-me";
import { selectTrainingRows } from "../../src/lib/friday/self/finetune";
import type { Experience } from "../../src/lib/friday/self/task-ledger";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("electron/main.cjs");
const preload = read("electron/preload.cjs");
const table = require_(path.join(root, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
};
const ipcModule = require_(path.join(root, "electron/llm-engine-ipc.cjs")) as {
  createLlmEngineIpc: (deps: Record<string, unknown>) => {
    state: (payload?: unknown) => Record<string, any>;
    bench: (payload?: unknown) => Promise<Record<string, any>>;
  };
};

describe("settings of D9", () => {
  it("defaults: engine auto, speculative auto, adapters off, glossary on, no data class accepted", () => {
    expect(DEFAULT_PREFERENCES.fields["brainEnginePrefer"]).toBe("auto");
    expect(DEFAULT_PREFERENCES.fields["brainSpeculative"]).toBe("auto");
    expect(DEFAULT_PREFERENCES.toggles["brainLearnAdapters"]).toBe(false);
    expect(DEFAULT_PREFERENCES.toggles["brainLearnGlossary"]).toBe(true);
    expect(DEFAULT_PREFERENCES.fields["brainLearnClasses"]).toBe("");
    expect(acceptedLearnClasses(DEFAULT_PREFERENCES.fields["brainLearnClasses"])).toEqual([]);
  });

  it("an unknown engine word reads auto; a known one is kept", () => {
    expect(ENGINE_PREFER_CHOICES).toEqual(["auto", "own", "official"]);
    expect(enginePreferOf("own")).toBe("own");
    expect(enginePreferOf("official")).toBe("official");
    expect(enginePreferOf("fastest")).toBe("auto");
    expect(enginePreferOf(undefined)).toBe("auto");
  });

  it("only listed data classes are accepted; the stored list is cleaned", () => {
    const first = LEARN_DATA_CLASSES[0]!.id;
    expect(acceptedLearnClasses(`${first}, nonsense ,${first}`)).toEqual([first]);
    expect(LEARN_DATA_CLASSES.every((c) => c.label.length > 0 && c.hint.length > 0)).toBe(true);
  });
});

describe("the two IPC channels", () => {
  it("are handled in main, exposed in preload and have a budget class", () => {
    expect(main).toContain('ipcMain.handle("llm-engine:state"');
    expect(main).toContain('ipcMain.handle("llm-engine:bench"');
    expect(preload).toContain(
      'llmEngineState: (payload) => ipcRenderer.invoke("llm-engine:state", payload)',
    );
    expect(preload).toContain(
      'llmEngineBench: (payload) => ipcRenderer.invoke("llm-engine:bench", payload)',
    );
    expect(table.CHANNEL_CLASS["llm-engine:state"]).toBe("quick");
    expect(table.CHANNEL_CLASS["llm-engine:bench"]).toBe("long-job");
  });

  it("main reads the stored engine choice and tells the bench a voice turn is busy", () => {
    expect(main).toContain('ownerPrefField("brainEnginePrefer"');
    expect(main).toContain("createLlmEngineIpc");
  });
});

function fakeRuntime(over: Record<string, unknown> = {}) {
  return {
    engineState: vi.fn((_root: string, deps: { prefer?: string }) => ({
      prefer: deps.prefer,
      active: "own",
      rows: { own: "own row", official: "official row", status: "status row", outdated: null },
      doctor: [{ id: "own", name: "own row", ok: true, detail: "ready" }],
    })),
    corePlan: vi.fn(() => ({ ok: true, variant: "v1" })),
    runBench: vi.fn(async () => ({ ok: true, ran: true, stored: true, winner: "own" })),
    ...over,
  };
}

const SHA = "a".repeat(64);
function make(over: Record<string, unknown> = {}) {
  const runtime = fakeRuntime();
  const finetune = {
    resolveActive: vi.fn((_sha: string | null): Record<string, unknown> => ({
      id: null,
      scale: 0,
    })),
  };
  const core = {
    planAssets: vi.fn(() => ({
      ok: true,
      assets: [{ kind: "model", present: true, sha256: SHA }],
    })),
  };
  const deps = {
    runtime,
    finetune,
    core,
    root: () => "/data/friday",
    readPrefer: () => "official",
    voiceBusy: () => false,
    ...over,
  };
  return { api: ipcModule.createLlmEngineIpc(deps), runtime, finetune, core };
}

describe("llm-engine-ipc state", () => {
  it("passes the stored prefer, lets a valid payload win, and ignores a bad one", () => {
    const { api, runtime } = make();
    expect(api.state()["prefer"]).toBe("official");
    expect(api.state({ prefer: "own" })["prefer"]).toBe("own");
    expect(api.state({ prefer: "rm -rf" })["prefer"]).toBe("official");
    expect(runtime.engineState).toHaveBeenCalledTimes(3);
  });

  it("adds the adapter retrain row when the base file changed", () => {
    const { api, finetune } = make();
    finetune.resolveActive.mockReturnValue({
      id: "ft-1",
      scale: 0,
      reason: "adapter retrain needed",
    });
    const out = api.state();
    expect(finetune.resolveActive).toHaveBeenCalledWith(SHA);
    expect(out["adapter"]).toEqual({ id: "ft-1", scale: 0, reason: "adapter retrain needed" });
    expect(out["doctor"].map((r: { name: string }) => r.name)).toContain("adapter retrain needed");
  });

  it("returns a plain error, never throws", () => {
    const { api } = make({
      runtime: fakeRuntime({
        engineState: () => {
          throw new Error("boom");
        },
      }),
    });
    expect(api.state()).toMatchObject({ ok: false, error: "boom" });
  });
});

describe("llm-engine-ipc bench", () => {
  it("is owner-started, hands over a stop signal and never runs twice at once", async () => {
    let release: (v: unknown) => void = () => {};
    const runBench = vi.fn(
      (_root: string, deps: { ownerStarted?: boolean; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          release = resolve;
          expect(deps.ownerStarted).toBe(true);
          deps.signal?.addEventListener("abort", () =>
            resolve({ ok: false, reason: "stopped", stopped: true }),
          );
        }),
    );
    const { api } = make({ runtime: fakeRuntime({ runBench }) });
    const first = api.bench({});
    const second = await api.bench({});
    expect(second).toMatchObject({ ok: false, ran: false, reason: "already-running" });
    expect(await api.bench({ stop: true })).toMatchObject({ ok: true, stopping: true });
    expect(await first).toMatchObject({ reason: "stopped" });
    release({});
    const again = api.bench({});
    expect(runBench).toHaveBeenCalledTimes(2);
    await api.bench({ stop: true });
    await again;
  });

  it("hands the governor and the Core stop and resume to the runtime", async () => {
    const governor = { acquire: vi.fn() };
    const coreLoaded = () => true;
    const stopCore = async () => undefined;
    const resumeCore = async () => undefined;
    const { api, runtime } = make({ governor, coreLoaded, stopCore, resumeCore });
    await api.bench({});
    expect(runtime.runBench).toHaveBeenCalledWith(
      "/data/friday",
      expect.objectContaining({ ownerStarted: true, governor, coreLoaded, stopCore, resumeCore }),
    );
  });

  it("main wires them and strips explicitPaid from page calls to the router", () => {
    for (const key of ["governor,", "coreLoaded:", "stopCore:", "resumeCore:"])
      expect(main).toContain(key);
    expect(main).toContain('if (name === "model.route_generation") delete payload.explicitPaid;');
  });

  it("main passes the stored engine choice to Core start and to the installer catalog row", () => {
    expect(main).toMatch(/prefer: \(\) => ownerPrefField\("brainEnginePrefer", "auto"\)/);
    expect(main).toMatch(/\.\.\.\(prefer \? \{ prefer: prefer\(\) \} : \{\}\)/);
    expect(main).toMatch(/enginePrefer: \(\) => ownerPrefField\("brainEnginePrefer", "auto"\)/);
  });

  it("refuses during a voice turn without starting anything", async () => {
    const { api, runtime } = make({ voiceBusy: () => true });
    expect(await api.bench({})).toMatchObject({ ok: false, ran: false, reason: "voice-turn" });
    expect(runtime.runBench).not.toHaveBeenCalled();
  });

  it("reports a thrown bench as an error result", async () => {
    const { api } = make({
      runtime: fakeRuntime({
        runBench: async () => {
          throw new Error("no engine");
        },
      }),
    });
    expect(await api.bench({})).toMatchObject({
      ok: false,
      ran: false,
      reason: "error",
      error: "no engine",
    });
  });
});

describe("renderer helpers", () => {
  it("names the engines with plain labels", () => {
    expect(engineLabel("auto")).toBe("Automatic");
    expect(engineLabel("own")).toBe("FRIDAY Runtime LLM (own)");
    expect(engineLabel("official")).toBe("llama.cpp (official)");
  });

  it("explains every bench outcome in plain words", () => {
    expect(
      benchMessage({ ok: true, ran: true, winner: "own", ownTps: 12, officialTps: 10 }),
    ).toMatch(/own.*faster|FRIDAY Runtime LLM/i);
    expect(benchMessage({ ok: false, ran: false, reason: "voice-turn" })).toMatch(/voice/i);
    expect(benchMessage({ ok: false, ran: false, reason: "needs-both-engines" })).toMatch(/both/i);
    expect(benchMessage({ ok: false, ran: false, reason: "own-outdated" })).toMatch(/outdated/i);
    expect(benchMessage({ ok: false, ran: false, reason: "stopped" })).toMatch(/stopped/i);
    expect(benchMessage({ ok: false, ran: false, reason: "error", error: "x" })).toContain("x");
  });

  it("undo goes to the previous adapter, else to the plain base model", () => {
    const list = [
      { id: "ft-3", finishedAt: 3 },
      { id: "ft-2", finishedAt: 2 },
    ];
    expect(adapterUndoTarget(list, "ft-3")).toEqual({ id: "ft-2" });
    expect(adapterUndoTarget(list, "ft-2")).toEqual({ id: null });
    expect(adapterUndoTarget(list, null)).toBeNull();
  });
});

describe("the screens", () => {
  const brain = read("src/components/friday/settings/BrainSettings.tsx");
  const learn = read("src/components/friday/settings/LearnSettings.tsx");
  const panel = read("src/components/friday/LlmEnginePanel.tsx");
  const tune = read("src/components/friday/FinetunePanel.tsx");
  const manager = read("src/routes/install-manager.tsx");

  it("Brain settings holds the engine panel and the Learn panel", () => {
    expect(brain).toContain("<LlmEnginePanel");
    expect(brain).toContain("<LearnSettings");
  });

  it("the engine panel has the selector, the bench with Stop and Retry, and the row texts", () => {
    expect(panel).toContain('setField("brainEnginePrefer"');
    expect(panel).toContain("Benchmark engines");
    expect(panel).toContain("Stop benchmark");
    expect(panel).toContain("Retry");
    expect(panel).toContain("state.rows");
    expect(panel).toContain("useLivePoll");
    expect(panel).not.toMatch(/setInterval/);
  });

  it("the Install Manager shows the same engine rows, read only", () => {
    expect(manager).toContain("<LlmEnginePanel");
  });

  it("Learn from me is opt-in with explicit classes, forget and undo", () => {
    expect(learn).toContain('"brainLearnAdapters"');
    expect(learn).toContain('"brainLearnGlossary"');
    expect(learn).toContain('"brainLearnClasses"');
    expect(learn).toMatch(/kernelApi\.glossary\s*\.list\(/);
    expect(learn).toMatch(/kernelApi\.glossary\s*\.forget\(/);
    expect(learn).toMatch(/kernelApi\.glossary\s*\.forgetAll\(/);
    expect(learn).toContain("What changed");
    expect(learn).toContain("Undo");
    expect(learn).toMatch(/SENSITIVE/);
    expect(learn).toMatch(/never used/i);
  });

  it("the fine-tune panel passes the required rails arguments", () => {
    expect(tune).toContain("adaptersEnabled");
    expect(tune).toContain("classesAccepted");
    expect(tune).toContain("kernelApi.privacy.classify");
    expect(tune).toContain("rows");
    expect(tune).toContain("gate");
  });
});

const experience = (over: Partial<Experience> = {}): Experience => ({
  id: "e1",
  taskId: "t1",
  at: 1,
  kind: "chat",
  title: "Open the notes",
  approach: "a",
  domains: [],
  models: [{ id: "m", kind: "local" }],
  tools: [],
  attempted: "Open the notes",
  success: true,
  verified: true,
  ms: 1,
  detail: "Opened.",
  ...over,
});

describe("rows for the rails", () => {
  it("ledger rows carry unknown provenance, so the rails drop all of them", async () => {
    const rows = rowsFromExperiences([experience(), experience({ tools: ["web.fetch"] })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.provenance.promptAuthor).toBe("unknown");
    expect(rows[1]!.provenance.contextKinds).toEqual(["tool"]);
    const out = await selectTrainingRows(rows, {
      classesAccepted: ["verified-runs"],
      classify: () => ({ level: "public" }),
    });
    expect(out.kept).toEqual([]);
  });

  it("an unchecked or failed run makes no row", () => {
    expect(
      rowsFromExperiences([experience({ verified: false }), experience({ success: false })]),
    ).toEqual([]);
  });

  it("the gate reads the governor and blocks on anything unstated", () => {
    expect(gateFromGovernor(null)).toEqual({});
    const calm = {
      ok: true,
      level: "ok",
      lag: { paused: false },
      holds: [],
      leases: [],
      power: { stress: "none" },
    } as never;
    expect(gateFromGovernor(calm)).toEqual({
      idle: true,
      onAc: true,
      inVoiceTurn: false,
      leaseGranted: true,
    });
    const busy = {
      ok: true,
      level: "ok",
      lag: { paused: false },
      holds: [],
      leases: [{ priority: "voice" }],
      power: { stress: "battery" },
    } as never;
    expect(gateFromGovernor(busy)).toMatchObject({ idle: false, onAc: false, inVoiceTurn: true });
  });
});
