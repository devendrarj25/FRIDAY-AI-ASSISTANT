/**
 * The colour tokens of src/styles.css for one mode, accent and High contrast setting, read from the file itself.
 * Shared by the contrast tests so they all look at the same numbers the app does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/** The `--name: value;` pairs of the first block with exactly this selector. */
export function tokenBlock(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) return {};
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
    out[m[1] ?? ""] = (m[2] ?? "").trim();
  return out;
}

export function tokensFor(mode: "dark" | "daylight", accent: string, highContrast: boolean) {
  const accentClass = accent === "cyan" ? "" : `.theme-${accent}`;
  return {
    ...tokenBlock(":root"),
    ...(accentClass ? tokenBlock(accentClass) : {}),
    ...(mode === "daylight" ? tokenBlock(".theme-daylight") : {}),
    ...(mode === "daylight" && accentClass ? tokenBlock(`.theme-daylight${accentClass}`) : {}),
    ...(highContrast && mode === "dark"
      ? tokenBlock("html.high-contrast:not(.theme-daylight)")
      : {}),
  } as Record<string, string>;
}
