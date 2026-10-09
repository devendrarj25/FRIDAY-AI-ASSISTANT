import { describe, expect, it } from "vitest";
import { readCarouselEnds } from "../../src/components/ui/carousel";
import { LIVE_GUEST_WEBPREFERENCES } from "../../src/routes/browser";
import { activityUpdatedAt } from "../../src/routes/projects";
import { deferEffect, skeletonWidth } from "../../src/lib/friday/defer-effect";

describe("deferred effect work", () => {
  it("waits for a microtask and skips work that was cancelled", async () => {
    const calls: string[] = [];
    const stop = deferEffect(() => calls.push("cancelled"));
    stop();
    deferEffect(() => calls.push("ran"));
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual(["ran"]);
  });
});

describe("carousel ends", () => {
  it("reads both ends from the carousel api and treats a missing api as stuck", () => {
    expect(
      readCarouselEnds({
        canScrollPrev: () => true,
        canScrollNext: () => false,
      }),
    ).toEqual({ prev: true, next: false });
    expect(readCarouselEnds(undefined)).toEqual({ prev: false, next: false });
  });
});

describe("live guest webview", () => {
  it("keeps the guest isolated and sandboxed", () => {
    expect(LIVE_GUEST_WEBPREFERENCES).toContain("contextIsolation=yes");
    expect(LIVE_GUEST_WEBPREFERENCES).toContain("sandbox=yes");
    expect(LIVE_GUEST_WEBPREFERENCES).not.toContain("nodeIntegration=yes");
  });
});

describe("project activity stamp", () => {
  it("uses the injected clock", () => {
    expect(activityUpdatedAt(() => 1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe("skeleton width", () => {
  it("stays in the skeleton band and does not change for the same seed", () => {
    const first = skeletonWidth("menu-a");
    const second = skeletonWidth("menu-a");
    expect(first).toBe(second);
    const percent = Number(first.replace("%", ""));
    expect(percent).toBeGreaterThanOrEqual(50);
    expect(percent).toBeLessThanOrEqual(90);
  });
});
