import { afterEach, describe, expect, it } from "vitest";
import { preferences } from "../../src/lib/friday/preferences";
import {
  ACCENTS,
  COLOR_COMBOS,
  COLOR_MODES,
  DISPLAY_FONTS,
  BODY_FONTS,
  FONTS,
  GOOGLE_FONTS_HREF,
  THEMES,
  THEME_IDS,
  persistAccent,
  persistColorCombo,
  persistColorMode,
  resetAppearancePreferences,
  resolveAccent,
  resolveColorMode,
  accentClassFor,
  legacyThemeFor,
} from "../../src/lib/friday/appearance";

afterEach(() => {
  resetAppearancePreferences();
});

describe("appearance color mode vs accent", () => {
  it("keeps the shipped dark + cyan default", () => {
    expect(THEMES[0]?.id).toBe("");
    expect(COLOR_MODES[0]?.id).toBe("dark");
    expect(ACCENTS[0]?.id).toBe("cyan");
    expect(legacyThemeFor("dark", "cyan")).toBe("");
    expect(THEME_IDS).toContain("theme-green");
  });

  it("does not let an accent overwrite Daylight", () => {
    persistColorMode("daylight");
    persistAccent("green");
    const snap = preferences.getSnapshot();
    expect(resolveColorMode(snap)).toBe("daylight");
    expect(resolveAccent(snap)).toBe("green");
    expect(accentClassFor("green")).toBe("theme-green");
    expect(snap.toggles["followSystem"]).toBe(false);
  });

  it("applies a color combination as mode + accent together", () => {
    const forest = COLOR_COMBOS.find((combo) => combo.id === "midnight-green");
    expect(forest).toBeDefined();
    if (!forest) return;
    persistColorCombo(forest);
    const snap = preferences.getSnapshot();
    expect(resolveColorMode(snap)).toBe("dark");
    expect(resolveAccent(snap)).toBe("green");
  });

  it("maps Match system onto the existing followSystem toggle", () => {
    persistColorMode("system");
    persistAccent("purple");
    const snap = preferences.getSnapshot();
    expect(resolveColorMode(snap)).toBe("system");
    expect(resolveAccent(snap)).toBe("purple");
    expect(snap.toggles["followSystem"]).toBe(true);
  });

  it("reads legacy theme-daylight prefs as daylight + cyan", () => {
    preferences.setTheme("theme-daylight");
    preferences.setField("colorMode", "");
    preferences.setField("accent", "");
    preferences.setToggle("followSystem", false);
    const snap = preferences.getSnapshot();
    expect(resolveColorMode(snap)).toBe("daylight");
    expect(resolveAccent(snap)).toBe("cyan");
  });
});

describe("appearance fonts", () => {
  it("maps every offered family to a real stack", () => {
    for (const stack of Object.values(FONTS)) expect(stack).toMatch(/sans-serif|monospace/);
    expect(DISPLAY_FONTS["Orbitron"]).toContain("Orbitron");
    expect(BODY_FONTS["Rajdhani"]).toContain("Rajdhani");
    expect(BODY_FONTS["Atkinson Hyperlegible"]).toContain("Atkinson Hyperlegible");
  });

  it("loads Inter Tight, Exo 2, Atkinson, and Lexend from Google Fonts", () => {
    expect(GOOGLE_FONTS_HREF).toContain("Inter+Tight");
    expect(GOOGLE_FONTS_HREF).toContain("Exo+2");
    expect(GOOGLE_FONTS_HREF).toContain("Atkinson+Hyperlegible");
    expect(GOOGLE_FONTS_HREF).toContain("Lexend");
    expect(GOOGLE_FONTS_HREF).toContain("Orbitron");
    expect(GOOGLE_FONTS_HREF).toContain("Rajdhani");
  });
});
