/**
 * FRIDAY · appearance application.
 *
 * The single place that turns saved preferences into what the window actually
 * looks like: color mode, accent, fonts, density and motion. Mounted once from
 * AppShell so the choice survives navigation and restarts instead of only
 * applying while the Settings page is open.
 *
 * Color mode (dark / daylight / match system) and accent (cyan / green /
 * orange / purple) are independent — picking an accent no longer overwrites
 * Daylight. Display font and body/chat font are also independent so headings
 * stay Orbitron while chat stays Rajdhani unless the owner changes them.
 *
 * Defaults are identical to the shipped design — nothing changes visually
 * until the owner picks something in Settings.
 */
import { useEffect } from "react";
import { preferences } from "./preferences";
import { usePreferences } from "./use-preferences";

export type ColorMode = "dark" | "daylight" | "system";
export type AccentId = "cyan" | "green" | "orange" | "purple";

export const COLOR_MODES = [
  { id: "dark", label: "Dark" },
  { id: "daylight", label: "Daylight" },
  { id: "system", label: "Match system" },
] as const;

export const ACCENTS = [
  { id: "cyan", label: "Cyan", className: "" },
  { id: "green", label: "Green", className: "theme-green" },
  { id: "orange", label: "Orange", className: "theme-orange" },
  { id: "purple", label: "Purple", className: "theme-purple" },
] as const;

export const COLOR_COMBOS = [
  { id: "midnight-cyan", label: "Midnight cyan", mode: "dark", accent: "cyan" },
  { id: "midnight-green", label: "Forest", mode: "dark", accent: "green" },
  { id: "midnight-orange", label: "Ember", mode: "dark", accent: "orange" },
  { id: "midnight-purple", label: "Violet", mode: "dark", accent: "purple" },
  { id: "daylight-cyan", label: "Daylight cyan", mode: "daylight", accent: "cyan" },
  { id: "daylight-green", label: "Daylight forest", mode: "daylight", accent: "green" },
  { id: "daylight-orange", label: "Daylight ember", mode: "daylight", accent: "orange" },
  { id: "daylight-purple", label: "Daylight violet", mode: "daylight", accent: "purple" },
] as const;

/** Headings / HUD labels. Shipped default is Orbitron. */
export const DISPLAY_FONTS: Record<string, string> = {
  Orbitron: '"Orbitron", "Rajdhani", ui-sans-serif, system-ui, sans-serif',
  Rajdhani: '"Rajdhani", "Inter Tight", ui-sans-serif, system-ui, sans-serif',
  "Inter Tight": '"Inter Tight", ui-sans-serif, system-ui, sans-serif',
  "Exo 2": '"Exo 2", "Orbitron", ui-sans-serif, system-ui, sans-serif',
  "System UI": "ui-sans-serif, system-ui, sans-serif",
};

/** Body / chat. Shipped default is Rajdhani. Atkinson / Lexend are loaded webfonts. */
export const BODY_FONTS: Record<string, string> = {
  Rajdhani: '"Rajdhani", "Inter Tight", ui-sans-serif, system-ui, sans-serif',
  "Inter Tight": '"Inter Tight", ui-sans-serif, system-ui, sans-serif',
  "Atkinson Hyperlegible": '"Atkinson Hyperlegible", ui-sans-serif, system-ui, sans-serif',
  Lexend: '"Lexend", ui-sans-serif, system-ui, sans-serif',
  "JetBrains Mono": '"JetBrains Mono", ui-monospace, monospace',
  "System UI": "ui-sans-serif, system-ui, sans-serif",
};

/** Union of every family Settings offers (tests + legacy single-font field). */
export const FONTS: Record<string, string> = { ...DISPLAY_FONTS, ...BODY_FONTS };

export const TEXT_SIZES = ["Small", "Normal", "Large", "Extra Large"] as const;
export const DENSITIES = ["Compact", "Normal", "Comfortable"] as const;

export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Exo+2:wght@500;600;700&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Lexend:wght@400;500;600&family=Orbitron:wght@500;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap";

/** Legacy theme buttons — Dark first so existing tests and old prefs still parse. */
export const THEMES = [
  { id: "", label: "Dark" },
  { id: "theme-green", label: "Green" },
  { id: "theme-orange", label: "Orange" },
  { id: "theme-purple", label: "Purple" },
  { id: "theme-daylight", label: "Daylight" },
] as const;

export const THEME_IDS = ["theme-daylight", "theme-green", "theme-orange", "theme-purple"] as const;

const ACCENT_IDS: readonly AccentId[] = ACCENTS.map((item) => item.id);
const COLOR_MODE_IDS: readonly ColorMode[] = COLOR_MODES.map((item) => item.id);

type AppearancePrefs = {
  theme: string;
  toggles: Record<string, boolean>;
  fields: Record<string, string>;
};

export function resolveColorMode(prefs: AppearancePrefs): ColorMode {
  const field = prefs.fields["colorMode"];
  if ((COLOR_MODE_IDS as readonly string[]).includes(field ?? "")) return field as ColorMode;
  if (prefs.toggles["followSystem"] === true) return "system";
  if (prefs.theme === "theme-daylight") return "daylight";
  return "dark";
}

export function resolveAccent(prefs: AppearancePrefs): AccentId {
  const field = prefs.fields["accent"];
  if ((ACCENT_IDS as readonly string[]).includes(field ?? "")) return field as AccentId;
  if (prefs.theme === "theme-green") return "green";
  if (prefs.theme === "theme-orange") return "orange";
  if (prefs.theme === "theme-purple") return "purple";
  return "cyan";
}

export function accentClassFor(accent: AccentId): string {
  return ACCENTS.find((item) => item.id === accent)?.className ?? "";
}

export function legacyThemeFor(mode: ColorMode, accent: AccentId): string {
  const accentClass = accentClassFor(accent);
  if (accentClass) return accentClass;
  return mode === "daylight" ? "theme-daylight" : "";
}

export function activeComboId(prefs: AppearancePrefs): string | null {
  const mode = resolveColorMode(prefs);
  const accent = resolveAccent(prefs);
  if (mode === "system") return null;
  return COLOR_COMBOS.find((combo) => combo.mode === mode && combo.accent === accent)?.id ?? null;
}

function panelOpacityPercent(raw: string | undefined): number {
  if (!raw || raw === "92") return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(100, Math.max(55, parsed));
}

export function persistColorMode(mode: ColorMode): void {
  preferences.setField("colorMode", mode);
  preferences.setToggle("followSystem", mode === "system");
  const accent = resolveAccent(preferences.getSnapshot());
  preferences.setTheme(legacyThemeFor(mode, accent));
}

export function persistAccent(accent: AccentId): void {
  preferences.setField("accent", accent);
  const mode = resolveColorMode(preferences.getSnapshot());
  preferences.setTheme(legacyThemeFor(mode, accent));
}

export function persistColorCombo(combo: (typeof COLOR_COMBOS)[number]): void {
  preferences.setField("colorMode", combo.mode);
  preferences.setField("accent", combo.accent);
  preferences.setToggle("followSystem", false);
  preferences.setTheme(legacyThemeFor(combo.mode, combo.accent));
}

export function resetAppearancePreferences(): void {
  preferences.setTheme("");
  preferences.setField("colorMode", "dark");
  preferences.setField("accent", "cyan");
  preferences.setField("font", "Orbitron");
  preferences.setField("bodyFont", "Rajdhani");
  preferences.setField("density", "Normal");
  preferences.setField("textSize", "Normal");
  preferences.setField("bubbleStyle", "Compact");
  preferences.setField("graphicIntensity", "70");
  preferences.setField("panelOpacity", "100");
  preferences.setToggle("circuit", true);
  preferences.setToggle("glow", true);
  preferences.setToggle("scanlines", true);
  preferences.setToggle("animations", true);
  preferences.setToggle("blur", true);
  preferences.setToggle("gpuRender", true);
  preferences.setToggle("reduceMotion", false);
  preferences.setToggle("highContrast", true);
  preferences.setToggle("followSystem", false);
  preferences.setToggle("chatTimestamps", false);
}

export function applyAppearance(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  THEME_IDS.forEach((id) => root.classList.remove(id));
  const mode = resolveColorMode(prefs);
  const accent = resolveAccent(prefs);
  let daylight = mode === "daylight";
  if (mode === "system" && typeof window !== "undefined") {
    daylight = window.matchMedia("(prefers-color-scheme: light)").matches;
  }
  if (daylight) root.classList.add("theme-daylight");
  const accentClass = accentClassFor(accent);
  if (accentClass) root.classList.add(accentClass);
  root.dataset["colorMode"] = mode;
  root.dataset["accent"] = accent;

  const displayName = prefs.fields["font"] || "Orbitron";
  const bodyName = prefs.fields["bodyFont"] || "Rajdhani";
  const display = DISPLAY_FONTS[displayName] ?? FONTS[displayName];
  const body = BODY_FONTS[bodyName] ?? FONTS[bodyName];
  if (display) root.style.setProperty("--font-display", display);
  else root.style.removeProperty("--font-display");
  if (body) root.style.setProperty("--font-sans", body);
  else root.style.removeProperty("--font-sans");

  root.dataset["density"] = prefs.fields["density"] ?? "Normal";
  root.dataset["textSize"] = prefs.fields["textSize"] ?? "Normal";
  root.style.setProperty(
    "--friday-panel-opacity",
    String(panelOpacityPercent(prefs.fields["panelOpacity"]) / 100),
  );
  const graphicIntensity = Number(prefs.fields["graphicIntensity"] ?? "70");
  root.style.setProperty(
    "--friday-graphic-intensity",
    String(Math.min(100, Math.max(0, graphicIntensity)) / 100),
  );
  root.classList.toggle(
    "no-motion",
    prefs.toggles["animations"] === false || prefs.toggles["reduceMotion"] === true,
  );
  root.classList.toggle("no-glow", prefs.toggles["glow"] === false);
  root.classList.toggle("no-scanlines", prefs.toggles["scanlines"] === false);
  root.classList.toggle("high-contrast", prefs.toggles["highContrast"] !== false);
  root.classList.toggle("no-circuit", prefs.toggles["circuit"] === false);
  root.classList.toggle("no-gpu", prefs.toggles["gpuRender"] === false);
}

/** Keeps the live document in sync with saved appearance preferences. */
export function useAppearance(): void {
  const prefs = usePreferences();
  useEffect(() => {
    applyAppearance(prefs);
    if (resolveColorMode(prefs) !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyAppearance(prefs);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [prefs]);
}
