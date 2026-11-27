import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  trainsOnDataNote,
  visibleLanes,
  type ProviderCaps,
} from "../../src/lib/friday/voice-engine/voice-provider-router";
const page = readFileSync("src/components/friday/settings/VoiceEngineSettings.tsx", "utf8");

describe("voice lane list in settings", () => {
  const off = visibleLanes(PROVIDERS, { paidAllowed: false });
  const on = visibleLanes(PROVIDERS, { paidAllowed: true });

  it("lists only cloud lanes, and with paid access off hides every lane with no cost proof", () => {
    expect(off.every((p) => p.kind === "cloud")).toBe(true);
    expect(off.some((p) => p.lane?.costProof === "none")).toBe(false);
  });

  it("shows the unproven lanes once paid access is on, and never fewer lanes", () => {
    const lane = (costProof: "official" | "none") =>
      ({ costProof, trainsOnData: "no", region: "us", codemixMode: "none" }) as const;
    const table = [
      { id: "free", kind: "cloud", lane: lane("official") },
      { id: "unproven", kind: "cloud", lane: lane("none") },
    ] as unknown as ProviderCaps[];
    expect(visibleLanes(table, { paidAllowed: false }).map((x) => x.id)).toEqual(["free"]);
    expect(visibleLanes(table, { paidAllowed: true }).map((x) => x.id)).toEqual([
      "free",
      "unproven",
    ]);
    expect(on.length).toBeGreaterThanOrEqual(off.length);
  });

  it("the page lists lanes through visibleLanes, not a raw filter", () => {
    expect(page).toContain("visibleLanes(PROVIDERS");
    expect(page).not.toContain('PROVIDERS.filter((p) => p.kind === "cloud")');
  });

  it("shows the training note only for a lane whose descriptor says yes", () => {
    const row = (trainsOnData: "yes" | "unknown" | "no") =>
      ({
        id: "x",
        label: "X",
        kind: "cloud",
        lane: { costProof: "official", trainsOnData, region: "us", codemixMode: "none" },
      }) as unknown as ProviderCaps;
    const table = [row("yes"), row("unknown"), row("no")];
    const shown = visibleLanes(table, { paidAllowed: false }).map(trainsOnDataNote);
    expect(shown[0]).toBe("Free-tier audio may be used to improve the provider's products.");
    expect(shown[1]).toBeNull();
    expect(shown[2]).toBeNull();
  });
});
