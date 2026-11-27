/**
 * Auto starts with no wake model on disk for the configured word: that is the normal, documented state (the
 * transcript matcher answers). It is not a fault, so nothing is installed and no "needs you" line is shown; the
 * status says the wake word is heard by transcript. A model that IS on disk but broken still heals. The Install
 * Manager's wake install returns early, without pip, when no model for the word exists.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Probe = {
  engine: string;
  installed: boolean;
  ready: boolean;
  model: string | null;
  modelDir: string | null;
  wakeWord: string;
  reason: string | null;
};
let probe: Probe;
const installWakeEngine = vi.fn(async () => ({ ok: true }));

vi.mock("../../src/lib/friday/desktop", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/friday/desktop")>();
  return {
    ...original,
    desktopApi: () => ({
      wakeEngineStatus: async () => probe,
      installWakeEngine,
    }),
  };
});

import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    status: string;
    captions: Array<{ text: string }>;
    wakeEngine: { ready: boolean };
  };
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ wakeWord: "friday" });
  d.state.mode = "auto";
  d.state.captions = [];
  d.state.status = "";
  d.emit = () => undefined;
  installWakeEngine.mockClear();
  (globalThis as unknown as { friday?: unknown }).friday = { installWakeEngine };
});

afterEach(() => {
  delete (globalThis as unknown as { friday?: unknown }).friday;
  vi.restoreAllMocks();
});

describe("no wake model on disk", () => {
  beforeEach(() => {
    probe = {
      engine: "transcript",
      installed: false,
      ready: false,
      model: null,
      modelDir: "C:/friday/models/wake",
      wakeWord: "friday",
      reason: "No wake model for “friday”. Drop a trained friday.onnx into C:/friday/models/wake.",
    };
  });

  it("installs nothing and shows no needs-you line", async () => {
    await assistantMode.refreshWakeEngine(true);
    expect(installWakeEngine).not.toHaveBeenCalled();
    expect(d.state.captions.map((c) => c.text).join(" ")).not.toMatch(/needs you/i);
    expect(d.state.wakeEngine.ready).toBe(false);
  });

  it("says the wake word is heard by transcript", async () => {
    await assistantMode.refreshWakeEngine(true);
    expect(d.state.status).toBe("Wake word: listening by transcript");
  });
});

describe("a wake model that is there but broken", () => {
  it("still heals through the wake install", async () => {
    probe = {
      engine: "transcript",
      installed: true,
      ready: false,
      model: "friday-wake.json",
      modelDir: "C:/friday/models/wake",
      wakeWord: "friday",
      reason: "the wake model is not a production model",
    };
    await assistantMode.refreshWakeEngine(true);
    expect(installWakeEngine).toHaveBeenCalledTimes(1);
  });

  it("a ready model touches nothing", async () => {
    probe = {
      engine: "friday-linear",
      installed: true,
      ready: true,
      model: "friday-wake.json",
      modelDir: "C:/friday/models/wake",
      wakeWord: "friday",
      reason: null,
    };
    await assistantMode.refreshWakeEngine(true);
    expect(installWakeEngine).not.toHaveBeenCalled();
  });
});

describe("electron/wake-engine.cjs install()", () => {
  const require = createRequire(import.meta.url);
  const wake = require("../../electron/wake-engine.cjs") as {
    install: (
      wakeWord?: string,
      io?: Record<string, unknown>,
    ) => Promise<{ ok: boolean; ready?: boolean; skipped?: string; reason?: string | null }>;
  };

  const io = (model: string | null) => {
    const calls: string[] = [];
    return {
      calls,
      io: {
        python: async () => ["python", []],
        status: async () => ({
          installed: model !== null,
          ready: false,
          model,
          reason: model ? null : "No wake model for “friday”.",
        }),
        run: async () => {
          calls.push("run");
          return { stderr: "" };
        },
        commandFor: async () => {
          calls.push("commandFor");
          return ["python", ["-m", "pip", "install", "openwakeword"]];
        },
      },
    };
  };

  it("returns early, without pip, when no model for the word exists", async () => {
    const fake = io(null);
    const result = await wake.install("friday", fake.io);
    expect(result).toMatchObject({ ok: true, ready: false, skipped: "no-model" });
    expect(fake.calls).toEqual([]);
  });

  it("still installs when a model is there", async () => {
    const fake = io("friday.onnx");
    await wake.install("friday", fake.io);
    expect(fake.calls).toContain("run");
  });
});
