/**
 * FRIDAY Glass tokens: contrast of text and icon tokens against the surface
 * tokens in all 8 mode + accent combinations and with High contrast, read
 * from src/styles.css itself. Pure math, no browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COLOR_COMBOS, contrastRatio, parseOklch } from "../../src/lib/friday/appearance";

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

const BODY: Array<[string, string]> = [
  ["--foreground", "--background"],
  ["--foreground", "--card"],
  ["--card-foreground", "--card"],
  ["--muted-foreground", "--card"],
  ["--muted-foreground", "--background"],
  ["--popover-foreground", "--popover"],
  ["--primary-foreground", "--primary"],
  ["--sidebar-foreground", "--sidebar"],
];
const LARGE: Array<[string, string]> = [
  ["--primary", "--card"],
  ["--primary", "--background"],
  ["--accent", "--card"],
  ["--destructive", "--card"],
  ["--warning", "--card"],
  ["--success", "--card"],
];

describe("FRIDAY Glass contrast", () => {
  const cases = COLOR_COMBOS.flatMap((combo) => [false, true].map((hc) => ({ combo, hc })));

  it.each(cases)(
    "$combo.id (high contrast $hc) meets 4.5:1 body and 3:1 large",
    ({ combo, hc }) => {
      const t = tokensFor(combo.mode, combo.accent, hc);
      const fails: string[] = [];
      for (const [fg, bg] of BODY) {
        const ratio = contrastRatio(t[fg] ?? "", t[bg] ?? "");
        if (ratio < 4.5) fails.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
      for (const [fg, bg] of LARGE) {
        const ratio = contrastRatio(t[fg] ?? "", t[bg] ?? "");
        if (ratio < 3) fails.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
      expect(fails).toEqual([]);
    },
  );

  it("computes known contrast values", () => {
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 0);
    expect(contrastRatio("oklch(0.5 0 0)", "oklch(0.5 0 0)")).toBeCloseTo(1, 5);
    expect(parseOklch("oklch(0.79 0.15 213)")).toEqual([0.79, 0.15, 213]);
    expect(parseOklch("#fff")).toBeNull();
  });
});
