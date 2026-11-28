/**
 * hardwareFacts tells a part that shares system memory (an integrated part, the part beside a larger card, or a
 * carve-out of more than half the RAM) from a dedicated card, without reading any card name, and carries the
 * processor architecture. Fake probe rows only: no hardware, no network.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const hwMod = require_("../../electron/hardware.cjs") as {
  hardwareFacts: (hw: unknown, deps?: Record<string, unknown>) => any;
  parseVideoControllers: (text: string) => Array<Record<string, unknown>>;
};

const video = (rows: Array<[string, number]>) =>
  hwMod.parseVideoControllers(
    JSON.stringify(rows.map(([Name, mb]) => ({ Name, Qw: mb * 1024 ** 2, Driver: "31.0.1" }))),
  );
const facts = (rows: Array<[string, number]>, ramGb = 32, extra: Record<string, unknown> = {}) =>
  hwMod.hardwareFacts({
    gpus: video(rows),
    memory: { totalGb: ramGb, freeGb: ramGb / 2 },
    arch: "x64",
    ...extra,
  });
const flags = (f: any) => Object.fromEntries(f.gpus.map((g: any) => [g.name, g.unifiedMemory]));

describe("unifiedMemory on every graphics row", () => {
  it("a lone AMD or Intel card with its own memory is dedicated; a carve-out over half the RAM is not", () => {
    expect(facts([["AMD Alpha Card", 8192]], 32).gpus[0].unifiedMemory).toBe(false);
    expect(facts([["Intel Beta Card", 16384]], 64).gpus[0].unifiedMemory).toBe(false);
    expect(facts([["AMD Gamma Part", 12288]], 16).gpus[0].unifiedMemory).toBe(true);
  });

  it("a part of 1 GB or less shares memory (integrated)", () => {
    const g = facts([["Intel Delta Part", 512]]).gpus[0];
    expect(g.integrated).toBe(true);
    expect(g.unifiedMemory).toBe(true);
  });

  it("the AMD or Intel part beside a discrete NVIDIA card is the integrated one", () => {
    const f = hwMod.hardwareFacts({
      gpus: [
        ...video([["Intel(R) Beside Graphics", 8192]]),
        {
          vendor: "nvidia",
          name: "Discrete Card",
          vramTotalMb: 8192,
          vramKnown: true,
          vramUsedMb: 100,
          driver: "560.94",
        },
      ],
      memory: { totalGb: 32, freeGb: 20 },
    });
    expect(flags(f)).toEqual({ "Intel(R) Beside Graphics": true, "Discrete Card": false });
  });

  it("with two AMD or Intel parts only the larger can be the dedicated card", () => {
    const f = facts(
      [
        ["AMD Small Part", 4096],
        ["AMD Large Card", 16384],
      ],
      64,
    );
    expect(flags(f)).toEqual({ "AMD Small Part": true, "AMD Large Card": false });
  });

  it("an NVIDIA card never shares memory, and a part with no measured memory is unknown", () => {
    expect(
      hwMod.hardwareFacts({
        gpus: [{ vendor: "nvidia", name: "N", vramTotalMb: 8192, vramKnown: true, vramUsedMb: 1 }],
      }).gpus[0].unifiedMemory,
    ).toBe(false);
    const unknown = hwMod.hardwareFacts({
      gpus: [{ vendor: "amd", name: "No Figure", vramTotalMb: null, vramKnown: false }],
    }).gpus[0];
    expect(unknown.unifiedMemory).toBeNull();
    expect(hwMod.hardwareFacts({ gpus: [] }).gpus).toEqual([]);
  });
});

describe("the architecture is a top-level fact", () => {
  it("is carried from the machine, null when unknown", () => {
    expect(facts([["Card", 8192]], 32, { arch: "arm64" }).arch).toBe("arm64");
    expect(facts([["Card", 8192]]).arch).toBe("x64");
    expect(hwMod.hardwareFacts(null).arch).toBeNull();
  });
});
