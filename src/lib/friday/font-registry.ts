/**
 * FRIDAY · the fonts bundled with the app, as plain data. The CSS itself is imported in fonts.ts, which only the
 * app entry loads, so tests and the appearance code can read this list without touching a stylesheet.
 */

/** What is bundled, by the name Settings shows. `css` is the family name the bundled CSS declares. */
export const BUNDLED_FONTS = [
  { name: "Orbitron", css: "Orbitron Variable", pkg: "@fontsource-variable/orbitron" },
  { name: "Exo 2", css: "Exo 2 Variable", pkg: "@fontsource-variable/exo-2" },
  { name: "Inter Tight", css: "Inter Tight Variable", pkg: "@fontsource-variable/inter-tight" },
  { name: "Lexend", css: "Lexend Variable", pkg: "@fontsource-variable/lexend" },
  {
    name: "JetBrains Mono",
    css: "JetBrains Mono Variable",
    pkg: "@fontsource-variable/jetbrains-mono",
  },
  { name: "Rajdhani", css: "Rajdhani", pkg: "@fontsource/rajdhani" },
  {
    name: "Atkinson Hyperlegible",
    css: "Atkinson Hyperlegible",
    pkg: "@fontsource/atkinson-hyperlegible",
  },
] as const;

/** A CSS font-family list that tries the bundled face first, then the plain name an installed copy would have. */
export const stackFor = (name: string, fallback: string): string => {
  const face = BUNDLED_FONTS.find((font) => font.name === name);
  const names = face ? [face.css, face.name] : [name];
  return `${names.map((item) => `"${item}"`).join(", ")}, ${fallback}`;
};
