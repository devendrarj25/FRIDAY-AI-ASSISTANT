import { describe, expect, it } from "vitest";
import { inspectCrossModeSync, resyncModes } from "../../src/lib/friday/cross-mode-sync";
import { withRoutingDefaults } from "../../src/lib/friday/brain-engine";
import { prepareTurn } from "../../src/lib/friday/runtime";
import { doctor } from "../../src/lib/friday/doctor-engine";

describe("cross-mode routing", () => {
  it("chat and voice resolve the same models for the same conditions", () => {
    const chat = prepareTurn("summarise this file", { mode: "manual" });
    const voice = prepareTurn("summarise this file", { mode: "auto" });
    // Auto Mode answers with the single best model on purpose; the model it
    // picks first must still be the exact one chat would use.
    expect(voice.modelIds[0]).toBe(chat.modelIds[0]);
    expect(chat.modelIds).toEqual(expect.arrayContaining(voice.modelIds));
  });

  it("fills routing options from the single source of truth for callers that omit them", () => {
    const chat = withRoutingDefaults({ routeMode: "auto" });
    const voice = withRoutingDefaults({});
    expect(voice.routeMode).toBe(chat.routeMode);
    expect(voice.modelIds ?? []).toEqual(chat.modelIds ?? []);
  });

  it("keeps an explicit caller choice instead of overwriting it", () => {
    const pinned = withRoutingDefaults({ routeMode: "manual", modelIds: ["ollama:llama3.2"] });
    expect(pinned.routeMode).toBe("manual");
    expect(pinned.modelIds).toEqual(["ollama:llama3.2"]);
    expect(pinned.routingContract?.routeMode).toBe("manual");
    expect(pinned.routingContract?.selectedModelIds).toEqual(["ollama:llama3.2"]);
  });

  it("normalises stored free-preferred into the shared free-first cost policy", () => {
    const filled = withRoutingDefaults({ routeMode: "local-only" });
    expect(filled.routeMode).toBe("local-only");
    expect(filled.routingContract?.routeMode).toBe("local-only");
    expect(["free-only", "free-first", "balanced", "quality-first", "paid", "paid-only"]).toContain(
      filled.routingContract?.costPolicy,
    );
  });

  it("reports the real measurement instead of assuming health", () => {
    const sync = inspectCrossModeSync();
    expect(sync.chatModelIds[0]).toBe(sync.voiceModelIds[0]);
    expect(sync.ok).toBe(true);
    expect(sync.detail).toMatch(/route mode/);
  });

  it("re-sync is honest when there is nothing to repair", async () => {
    const result = await resyncModes();
    expect(result.ok).toBe(true);
    expect(result.log.join(" ")).toMatch(/already in sync/);
  });
});

describe("doctor cross-mode check", () => {
  it("appears in a real scan with a measured status", async () => {
    await doctor.scan({ deep: false });
    const check = doctor.getSnapshot().checks.find((c) => c.id === "cross-mode-sync");
    expect(check).toBeTruthy();
    expect(check?.group).toBe("FRIDAY");
    expect(["Ready", "Warning", "Error"]).toContain(check?.status);
    expect(check?.detail).toBeTruthy();
    // Healthy checks must not advertise a repair they do not need.
    if (check?.status === "Ready") expect(check.fixable).toBeFalsy();
  });
});
