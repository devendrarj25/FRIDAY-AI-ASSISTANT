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
  appearanceState,
  AMBIENT_LIGHTS,
  AMBIENT_MOTIONS,
  BUTTON_LABEL_MODES,
  CORNER_STYLES,
  GLASS_DEPTHS,
  UI_STYLES,
  resolveAmbientLight,
  resolveAmbientMotion,
  resolveButtonLabels,
  resolveCornerStyle,
  resolveGlassDepth,
  resolveUiStyle,
} from "../../src/lib/friday/appearance";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("appearance state (what the document gets)", () => {
  const snap = () => preferences.getSnapshot();

  it("applies the Blur effect toggle as html.no-blur, which styles.css reads", () => {
    expect(appearanceState(snap()).classes["no-blur"]).toBe(false);
    preferences.setToggle("blur", false);
    expect(appearanceState(snap()).classes["no-blur"]).toBe(true);
    const source = readFileSync(resolve(process.cwd(), "src/lib/friday/appearance.ts"), "utf8");
    expect(source).toContain('root.classList.toggle("no-blur", state.classes["no-blur"]);');
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain(
      'html.no-blur [class*="backdrop-blur"] { backdrop-filter: none !important; }',
    );
  });

  it("applies every stored appearance toggle to a class", () => {
    const pairs: Array<[string, string, boolean]> = [
      ["animations", "no-motion", false],
      ["reduceMotion", "no-motion", true],
      ["glow", "no-glow", false],
      ["scanlines", "no-scanlines", false],
      ["highContrast", "high-contrast", false],
      ["circuit", "no-circuit", false],
      ["gpuRender", "no-gpu", false],
      ["blur", "no-blur", false],
    ];
    for (const [toggle, cls, value] of pairs) {
      resetAppearancePreferences();
      const before =
        appearanceState(snap()).classes[cls as keyof ReturnType<typeof appearanceState>["classes"]];
      preferences.setToggle(toggle, value);
      const after =
        appearanceState(snap()).classes[cls as keyof ReturnType<typeof appearanceState>["classes"]];
      expect(after, toggle).not.toBe(before);
    }
  });

  it("applies density, text size, opacity, intensity and both fonts", () => {
    preferences.setField("density", "Compact");
    preferences.setField("textSize", "Large");
    preferences.setField("panelOpacity", "70");
    preferences.setField("graphicIntensity", "40");
    preferences.setField("font", "Exo 2");
    preferences.setField("bodyFont", "Lexend");
    const state = appearanceState(snap());
    expect(state.dataset.density).toBe("Compact");
    expect(state.dataset.textSize).toBe("Large");
    expect(state.vars["--friday-panel-opacity"]).toBe("0.7");
    expect(state.vars["--friday-graphic-intensity"]).toBe("0.4");
    expect(state.vars["--font-display"]).toContain("Exo 2");
    expect(state.vars["--font-sans"]).toContain("Lexend");
  });

  it("resolves system mode from the OS preference", () => {
    persistColorMode("system");
    expect(appearanceState(snap(), true).themeClasses).toContain("theme-daylight");
    expect(appearanceState(snap(), false).themeClasses).not.toContain("theme-daylight");
  });

  it("ships Futuristic Glass, Balanced depth and hover labels, all in Reset", () => {
    expect(UI_STYLES.map((s) => s.id)).toEqual(["glass", "classic"]);
    expect(GLASS_DEPTHS).toEqual(["Subtle", "Balanced", "Rich"]);
    expect(BUTTON_LABEL_MODES.map((m) => m.id)).toEqual(["hover", "always", "icons"]);
    const fresh = appearanceState(snap());
    expect(fresh.dataset.uiStyle).toBe("glass");
    expect(fresh.dataset.glassDepth).toBe("Balanced");
    expect(fresh.dataset.buttonLabels).toBe("hover");
    preferences.setField("uiStyle", "classic");
    preferences.setField("glassDepth", "Rich");
    preferences.setField("buttonLabels", "icons");
    preferences.setToggle("blur", false);
    expect(appearanceState(snap()).dataset).toMatchObject({
      uiStyle: "classic",
      glassDepth: "Rich",
      buttonLabels: "icons",
    });
    resetAppearancePreferences();
    expect(appearanceState(snap()).dataset).toMatchObject({
      uiStyle: "glass",
      glassDepth: "Balanced",
      buttonLabels: "hover",
    });
    expect(appearanceState(snap()).classes["no-blur"]).toBe(false);
  });

  it("falls back safely on unknown stored values", () => {
    const prefs = {
      theme: "",
      toggles: {},
      fields: { uiStyle: "x", glassDepth: "deep", buttonLabels: "?" },
    };
    expect(resolveUiStyle(prefs)).toBe("glass");
    expect(resolveGlassDepth(prefs)).toBe("Balanced");
    expect(resolveButtonLabels(prefs)).toBe("hover");
  });

  it("styles.css reads every new attribute", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain('html[data-ui-style="glass"] .hud-panel');
    expect(css).toContain('html[data-glass-depth="Subtle"]');
    expect(css).toContain('html[data-glass-depth="Rich"]');
    expect(css).toContain('html[data-button-labels="always"]');
    expect(css).toContain('html[data-button-labels="icons"]');
    // Classic adds no override of its own.
    expect(css).not.toContain('[data-ui-style="classic"]');
  });

  it("ships Round corners, Vivid ambient light and no ambient motion, all in Reset", () => {
    expect(CORNER_STYLES).toEqual(["Round", "Medium", "Sharp"]);
    expect(AMBIENT_LIGHTS).toEqual(["Off", "Soft", "Vivid"]);
    expect(AMBIENT_MOTIONS).toEqual(["Off", "On"]);
    expect(appearanceState(snap()).dataset).toMatchObject({
      cornerStyle: "Round",
      ambientLight: "Vivid",
      ambientMotion: "Off",
    });
    preferences.setField("cornerStyle", "Sharp");
    preferences.setField("ambientLight", "Soft");
    preferences.setField("ambientMotion", "On");
    expect(appearanceState(snap()).dataset).toMatchObject({
      cornerStyle: "Sharp",
      ambientLight: "Soft",
      ambientMotion: "On",
    });
    resetAppearancePreferences();
    expect(appearanceState(snap()).dataset).toMatchObject({
      cornerStyle: "Round",
      ambientLight: "Vivid",
      ambientMotion: "Off",
    });
  });

  it("falls back safely on unknown corner, ambient light and motion values", () => {
    const prefs = {
      theme: "",
      toggles: {},
      fields: { cornerStyle: "pointy", ambientLight: "blazing", ambientMotion: "yes" },
    };
    expect(resolveCornerStyle(prefs)).toBe("Round");
    expect(resolveAmbientLight(prefs)).toBe("Vivid");
    expect(resolveAmbientMotion(prefs)).toBe("Off");
  });

  it("styles.css reads the corner, ambient and motion attributes", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain('[data-corner-style="Medium"]');
    expect(css).toContain('[data-corner-style="Sharp"]');
    expect(css).toContain('html[data-ambient-light="Off"]');
    expect(css).toContain('html[data-ambient-light="Soft"]');
    expect(css).toContain('[data-ambient-motion="On"]');
  });
});
