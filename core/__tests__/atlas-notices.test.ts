import { describe, expect, it } from "vitest";
import { NOTICE_QUIET_MS, atlasNotices, newNoticeMemory } from "../../src/lib/friday/atlas-notices";
import type { ReliabilityReport } from "../../src/lib/friday/self-atlas";

const report = (state: "ok" | "warn" | "bad", supported = true): ReliabilityReport => ({
  detectedAt: 1,
  supported,
  items: [
    {
      id: "crashes",
      label: "App crashes",
      state,
      detail: "3 crashes this week",
      apps: [{ app: "chrome.exe", count: 3 }],
    },
  ],
});

describe("calm reliability notices", () => {
  it("raises a bad row once, with the app named, and stays quiet on the next poll", () => {
    const memory = newNoticeMemory();
    const first = atlasNotices(report("bad"), memory, 1000);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ level: "error", id: "reliability:crashes:bad" });
    expect(first[0]?.detail).toContain("chrome.exe");
    expect(atlasNotices(report("bad"), memory, 2000)).toEqual([]);
  });

  it("raises again when a row gets worse, but not when it improves", () => {
    const memory = newNoticeMemory();
    atlasNotices(report("warn"), memory, 0);
    expect(atlasNotices(report("bad"), memory, NOTICE_QUIET_MS + 1)).toHaveLength(1);
    expect(atlasNotices(report("warn"), memory, NOTICE_QUIET_MS * 3)).toEqual([]);
  });

  it("holds a worsening inside the quiet window", () => {
    const memory = newNoticeMemory();
    atlasNotices(report("warn"), memory, 0);
    expect(atlasNotices(report("bad"), memory, 1000)).toEqual([]);
  });

  it("forgets a row that recovered, so a relapse is told", () => {
    const memory = newNoticeMemory();
    atlasNotices(report("bad"), memory, 0);
    atlasNotices(report("ok"), memory, 10);
    expect(atlasNotices(report("bad"), memory, 20)).toHaveLength(1);
  });

  it("says nothing without a report or on a machine the probes do not read", () => {
    const memory = newNoticeMemory();
    expect(atlasNotices(null, memory, 0)).toEqual([]);
    expect(atlasNotices(report("bad", false), memory, 0)).toEqual([]);
  });
});
