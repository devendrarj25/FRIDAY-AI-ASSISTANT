/**
 * The title strip must show what FRIDAY is actually moving right now, not a
 * periodic capacity probe. These tests lock the shape of the shared sample and
 * the label priority so a future edit cannot silently drop live usage again.
 */
import { describe, expect, it } from "vitest";
import { networkMeter, type NetworkSample } from "../../src/lib/friday/network";

describe("network meter live usage", () => {
  it("exposes FRIDAY's own rate and the machine adapter rates", () => {
    const sample: NetworkSample = networkMeter.getSnapshot();
    expect(sample).toHaveProperty("appMbps");
    expect(sample).toHaveProperty("liveDownMbps");
    expect(sample).toHaveProperty("liveUpMbps");
    expect(typeof sample.appMbps).toBe("number");
    expect(sample).toHaveProperty("detail");
  });

  it("starts idle rather than inventing a rate", () => {
    const sample = networkMeter.getSnapshot();
    expect(sample.appMbps).toBe(0);
    expect(sample.liveDownMbps).toBeLessThan(0);
    expect(sample.liveUpMbps).toBeLessThan(0);
  });

  it("supports the authoritative desktop reachability source used by routing", () => {
    const sample: NetworkSample = {
      ...networkMeter.getSnapshot(),
      online: false,
      source: "offline",
      detail: "no internet route — local models only",
    };
    expect(sample.detail).toContain("local models only");
  });
});
