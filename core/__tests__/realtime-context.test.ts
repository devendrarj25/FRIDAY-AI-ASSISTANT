import { describe, expect, it } from "vitest";
import { readSystemContext, systemContextPrompt } from "../../src/lib/friday/system-context";
import { FONTS, THEMES, THEME_IDS } from "../../src/lib/friday/appearance";

describe("real-time system context", () => {
  it("reads the live OS clock, not a cached value", async () => {
    const first = readSystemContext();
    await new Promise((r) => setTimeout(r, 5));
    const second = readSystemContext();
    expect(new Date(second.iso).getTime()).toBeGreaterThanOrEqual(new Date(first.iso).getTime());
    expect(first.timeZone.length).toBeGreaterThan(0);
    expect(first.utcOffset).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });

  it("does not tell the model it has a browser search tool", () => {
    const prompt = systemContextPrompt({ ...readSystemContext(), online: true });
    expect(prompt).toContain("Live system context");
    expect(prompt.toLowerCase()).toContain("you do not have a web-search");
    expect(prompt.toLowerCase()).not.toContain("search the web with your browser tool");
  });

  it("says verification is impossible when offline", () => {
    const prompt = systemContextPrompt({ ...readSystemContext(), online: false });
    expect(prompt.toLowerCase()).toContain("offline");
  });
});

describe("appearance source of truth", () => {
  it("keeps the shipped dark theme as the default", () => {
    expect(THEMES[0]?.id).toBe("");
    expect(THEME_IDS).toContain("theme-green");
  });

  it("maps every offered font to a real stack", () => {
    for (const stack of Object.values(FONTS)) expect(stack).toMatch(/sans-serif|monospace/);
    expect(THEMES[0]?.id).toBe("");
    expect(THEME_IDS).toContain("theme-daylight");
  });
});
