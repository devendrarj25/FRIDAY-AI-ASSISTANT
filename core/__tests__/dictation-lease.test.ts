import { describe, expect, it } from "vitest";

import {
  claimDictation,
  DICTATION_LEASE_TTL_MS,
  heartbeatDictation,
  markDictationLive,
  releaseDictation,
  resetDictationLease,
  type DictationHolder,
} from "../../src/lib/friday/voice-stt";

function holder(active = false): DictationHolder & { stopped: boolean } {
  const row = {
    active,
    stopped: false,
    stop() {
      row.active = false;
      row.stopped = true;
    },
  };
  return row;
}

describe("dictation lease", () => {
  it("reclaims a stale holder and refuses a live second session", () => {
    resetDictationLease();
    const first = holder(false);
    const opened = claimDictation(first, 1_000);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    markDictationLive(opened.token, 1_000);
    first.active = true;
    expect(heartbeatDictation(opened.token, 5_000)).toBe(true);

    const second = holder(false);
    const busy = claimDictation(second, 6_000);
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.reason).toBe("in-app-session");
    expect(busy.detail).toMatch(/already active elsewhere/);

    const again = claimDictation(first, 7_000);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("own-second-capture");

    const stale = claimDictation(second, 5_000 + DICTATION_LEASE_TTL_MS);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.reclaimed).toBe(true);
    expect(first.stopped).toBe(true);
    expect(first.active).toBe(false);

    releaseDictation(stale.token);
    const third = holder(false);
    const fresh = claimDictation(third, 9_000);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.reclaimed).toBe(false);
    releaseDictation(fresh.token);
  });

  it("reclaims a live lease whose holder already stopped heartbeating", () => {
    resetDictationLease();
    const dead = holder(false);
    const opened = claimDictation(dead, 10_000);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    markDictationLive(opened.token, 10_000);
    dead.active = false;
    const next = holder(false);
    const taken = claimDictation(next, 10_500);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.reclaimed).toBe(true);
    expect(dead.stopped).toBe(true);
    releaseDictation(taken.token);
  });
});
