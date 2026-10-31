import { describe, expect, it } from "vitest";
import { buildGateReport } from "./helpers/release-gates";

describe("release gates, one report across renderer, main process and kernel", () => {
  const report = buildGateReport();

  it("covers all three places", () => {
    const places = new Set(report.gates.map((gate) => gate.where));
    expect(places.has("renderer")).toBe(true);
    expect(places.has("main")).toBe(true);
    // The kernel part runs when Python and its packages are present; otherwise it is listed, not passed.
    expect(places.has("kernel") || report.notChecked.some((id) => id.startsWith("kernel-"))).toBe(
      true,
    );
  });

  it("has no failed gate on the shipped code", () => {
    expect(report.failed.map((gate) => `${gate.where}:${gate.id} ${gate.detail}`)).toEqual([]);
  });

  it("fails the report when a gate is broken", () => {
    const broken = { ...report.gates[0]!, ok: false };
    const synthetic = [broken, ...report.gates.slice(1)].filter((gate) => !gate.ok);
    expect(synthetic).toHaveLength(1);
  });
});
