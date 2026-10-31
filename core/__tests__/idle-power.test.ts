import { describe, expect, it } from "vitest";
import { idleWorkAllowed, LOW_BATTERY } from "../../src/lib/friday/self/autonomous-core";

describe("what idle work may run on this power", () => {
  it("runs everything on a desktop, a charger or a healthy battery that is allowed", () => {
    expect(idleWorkAllowed({ battery: null, pauseOnBattery: true })).toMatchObject({ heavy: true });
    expect(
      idleWorkAllowed({ battery: { level: 0.1, charging: true }, pauseOnBattery: true }).heavy,
    ).toBe(true);
    expect(
      idleWorkAllowed({ battery: { level: 0.6, charging: false }, pauseOnBattery: false }).heavy,
    ).toBe(true);
  });

  it("holds the heavy pass on a low battery or when the owner asked to pause", () => {
    expect(
      idleWorkAllowed({ battery: { level: LOW_BATTERY, charging: false }, pauseOnBattery: false }),
    ).toEqual({
      light: true,
      heavy: false,
      reason: "battery is low",
    });
    expect(
      idleWorkAllowed({ battery: { level: 0.8, charging: false }, pauseOnBattery: true }),
    ).toEqual({
      light: true,
      heavy: false,
      reason: "paused on battery",
    });
  });
});
