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
 * FRIDAY Glass: Interface style (Futuristic Glass by default, or Classic, the
 * earlier look), Glass depth, Corner style, Ambient light, Ambient motion and
 * Button labels are applied here too, as data
 * attributes on <html> that src/styles.css reads. Classic adds no override,
 * so it is exactly the earlier look on the same tokens.
 *
 * `appearanceState()` is the pure description of what the document gets;
 * `applyAppearance()` only writes it, so tests can check every setting
 * without a browser.
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

/** Interface style. Classic is the earlier look, kept as a safe fallback. */
export const UI_STYLES = [
  { id: "glass", label: "Futuristic Glass" },
  { id: "classic", label: "Classic" },
] as const;
export type UiStyle = (typeof UI_STYLES)[number]["id"];

/** How much glass: translucency, highlight and blur strength. */
export const GLASS_DEPTHS = ["Subtle", "Balanced", "Rich"] as const;
export type GlassDepth = (typeof GLASS_DEPTHS)[number];

/** Corner style (glass only): how round panels, controls and bubbles are. */
export const CORNER_STYLES = ["Round", "Medium", "Sharp"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

/** Ambient light (glass only): the soft colored lights behind every page. */
export const AMBIENT_LIGHTS = ["Off", "Soft", "Vivid"] as const;
export type AmbientLight = (typeof AMBIENT_LIGHTS)[number];

/** Ambient motion (glass only): a slow drift of those lights. Off by default. */
export const AMBIENT_MOTIONS = ["Off", "On"] as const;
export type AmbientMotion = (typeof AMBIENT_MOTIONS)[number];

/** Compact icon controls: label on hover, always shown, or icons only. */
export const BUTTON_LABEL_MODES = [
  { id: "hover", label: "On hover" },
  { id: "always", label: "Always" },
  { id: "icons", label: "Icons only" },
] as const;
export type ButtonLabelMode = (typeof BUTTON_LABEL_MODES)[number]["id"];

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

export function resolveUiStyle(prefs: AppearancePrefs): UiStyle {
  return prefs.fields["uiStyle"] === "classic" ? "classic" : "glass";
}

export function resolveGlassDepth(prefs: AppearancePrefs): GlassDepth {
  const value = prefs.fields["glassDepth"];
  return (GLASS_DEPTHS as readonly string[]).includes(value ?? "")
    ? (value as GlassDepth)
    : "Balanced";
}

export function resolveCornerStyle(prefs: AppearancePrefs): CornerStyle {
  const value = prefs.fields["cornerStyle"];
  return (CORNER_STYLES as readonly string[]).includes(value ?? "")
    ? (value as CornerStyle)
    : "Round";
}

export function resolveAmbientLight(prefs: AppearancePrefs): AmbientLight {
  const value = prefs.fields["ambientLight"];
  return (AMBIENT_LIGHTS as readonly string[]).includes(value ?? "")
    ? (value as AmbientLight)
    : "Vivid";
}

export function resolveAmbientMotion(prefs: AppearancePrefs): AmbientMotion {
  return prefs.fields["ambientMotion"] === "On" ? "On" : "Off";
}

export function resolveButtonLabels(prefs: AppearancePrefs): ButtonLabelMode {
  const value = prefs.fields["buttonLabels"];
  return value === "always" || value === "icons" ? value : "hover";
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
  preferences.setField("uiStyle", "glass");
  preferences.setField("glassDepth", "Balanced");
  preferences.setField("cornerStyle", "Round");
  preferences.setField("ambientLight", "Vivid");
  preferences.setField("ambientMotion", "Off");
  preferences.setField("buttonLabels", "hover");
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

/** Everything the document gets for these preferences. Pure; no DOM. */
export function appearanceState(prefs: AppearancePrefs, systemLight = false) {
  const mode = resolveColorMode(prefs);
  const accent = resolveAccent(prefs);
  const daylight = mode === "daylight" || (mode === "system" && systemLight);
  const accentClass = accentClassFor(accent);
  const displayName = prefs.fields["font"] || "Orbitron";
  const bodyName = prefs.fields["bodyFont"] || "Rajdhani";
  const graphicIntensity = Number(prefs.fields["graphicIntensity"] ?? "70");
  return {
    themeClasses: [daylight ? "theme-daylight" : "", accentClass].filter(Boolean),
    classes: {
      "no-motion": prefs.toggles["animations"] === false || prefs.toggles["reduceMotion"] === true,
      "no-glow": prefs.toggles["glow"] === false,
      "no-scanlines": prefs.toggles["scanlines"] === false,
      "high-contrast": prefs.toggles["highContrast"] !== false,
      "no-circuit": prefs.toggles["circuit"] === false,
      "no-gpu": prefs.toggles["gpuRender"] === false,
      // Stored as toggles.blur; styles.css switches off every backdrop-blur.
      "no-blur": prefs.toggles["blur"] === false,
    },
    dataset: {
      colorMode: mode,
      accent,
      density: prefs.fields["density"] ?? "Normal",
      textSize: prefs.fields["textSize"] ?? "Normal",
      uiStyle: resolveUiStyle(prefs),
      glassDepth: resolveGlassDepth(prefs),
      cornerStyle: resolveCornerStyle(prefs),
      ambientLight: resolveAmbientLight(prefs),
      ambientMotion: resolveAmbientMotion(prefs),
      buttonLabels: resolveButtonLabels(prefs),
    },
    vars: {
      "--font-display": DISPLAY_FONTS[displayName] ?? FONTS[displayName] ?? null,
      "--font-sans": BODY_FONTS[bodyName] ?? FONTS[bodyName] ?? null,
      "--friday-panel-opacity": String(panelOpacityPercent(prefs.fields["panelOpacity"]) / 100),
      "--friday-graphic-intensity": String(
        Math.min(100, Math.max(0, Number.isFinite(graphicIntensity) ? graphicIntensity : 70)) / 100,
      ),
    } as Record<string, string | null>,
  };
}

export function applyAppearance(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const systemLight =
    resolveColorMode(prefs) === "system" &&
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const state = appearanceState(prefs, systemLight);

  THEME_IDS.forEach((id) => root.classList.remove(id));
  state.themeClasses.forEach((id) => root.classList.add(id));
  for (const [key, value] of Object.entries(state.dataset)) root.dataset[key] = value;
  for (const [name, value] of Object.entries(state.vars)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.classList.toggle("no-motion", state.classes["no-motion"]);
  root.classList.toggle("no-glow", state.classes["no-glow"]);
  root.classList.toggle("no-scanlines", state.classes["no-scanlines"]);
  root.classList.toggle("high-contrast", state.classes["high-contrast"]);
  root.classList.toggle("no-circuit", state.classes["no-circuit"]);
  root.classList.toggle("no-gpu", state.classes["no-gpu"]);
  root.classList.toggle("no-blur", state.classes["no-blur"]);
}

/* ------------------------------------------------------------- contrast */

/** oklch(L C H) → linear sRGB through the published OKLab matrices. */
export function oklchToLinearRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

/** Parse "oklch(0.79 0.15 213)" (alpha ignored). Null when it is not oklch. */
export function parseOklch(value: string): [number, number, number] | null {
  const m = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (!m) return null;
  const raw = m[1] ?? "0";
  const l = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return [l, Number(m[2]), Number(m[3])];
}

function luminance(color: [number, number, number]): number {
  const [r, g, b] = oklchToLinearRgb(...color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two oklch colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseOklch(a);
  const cb = parseOklch(b);
  if (!ca || !cb) return 0;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
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
