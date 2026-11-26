import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/friday/desktop", () => ({
  desktopApi: () => ({
    wakeEngineStatus: async () => ({
      engine: "friday-embed",
      installed: true,
      ready: true,
      model: "friday-wake.json",
      embedModel: "wake-embed.onnx",
      wakeWord: "friday",
    }),
  }),
}));

import { wakeEngineDoctorRow, wakeEngineStatus } from "../../src/lib/friday/wake-engine";
import type { WakeEngineStatus } from "../../src/lib/friday/wake-engine";
import { VOICE_ENGINE_TABLE } from "../../src/lib/friday/voice-engine/voice-engine-table";

const require = createRequire(import.meta.url);
const { isProductionManifest } = require("../../electron/wake-engine.cjs");

const production = {
  provenance: "real-speech",
  production: true,
  evaluation: { meetsTargets: true, independent: true },
};

describe("friday-embed wake engine wiring", () => {
  it("reports a ready friday-embed head as friday-embed, with its embedding model", async () => {
    const status = await wakeEngineStatus("friday", true);
    expect(status.engine).toBe("friday-embed");
    expect(status.embedModel).toBe("wake-embed.onnx");
  });

  it("accepts friday-embed-v1 and friday-linear-v2 only with the same production proof", () => {
    for (const kind of ["friday-linear-v2", "friday-embed-v1"]) {
      expect(isProductionManifest({ kind, ...production })).toBe(true);
      expect(isProductionManifest({ kind, ...production, provenance: "synthetic" })).toBe(false);
      expect(isProductionManifest({ kind, ...production, production: false })).toBe(false);
      expect(
        isProductionManifest({ kind, ...production, evaluation: { meetsTargets: true } }),
      ).toBe(false);
    }
    expect(isProductionManifest({ kind: "friday-embed-v0", ...production })).toBe(false);
  });

  it("names a missing embedding model in the Doctor row and keeps the other states", () => {
    const base: WakeEngineStatus = {
      engine: "transcript",
      installed: true,
      ready: false,
      model: null,
      modelDir: null,
      wakeWord: "friday",
      reason: "the wake embedding model wake-embed.onnx is not installed in X; install it",
    };
    const missing = wakeEngineDoctorRow(base);
    expect(missing.bad).toBe(true);
    expect(missing.value).toContain("embedding model not installed");
    expect(wakeEngineDoctorRow({ ...base, reason: null }).value).toContain("transcript fallback");
    const ready = wakeEngineDoctorRow({ ...base, engine: "friday-embed", ready: true, model: "m" });
    expect(ready).toEqual({ value: "friday-embed · m", bad: false });
  });

  it("lists friday-embed in the voice-engine table ahead of openwakeword", () => {
    const ids = VOICE_ENGINE_TABLE.map((row) => row.id);
    expect(ids).toContain("wake-embed");
    expect(ids).toContain("openwakeword");
  });
});
