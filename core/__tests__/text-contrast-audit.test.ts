/**
 * Text contrast audit: every colour a piece of small text can have, in all 8 mode and accent combinations, with and
 * without High contrast, against the two surfaces text sits on. The numbers are read from src/styles.css, and the
 * faded text utilities (text-primary/70) are found in the source, so a new faded class that is too faint fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_COMBOS, contrastRatio, contrastWithAlpha } from "../../src/lib/friday/appearance";
import { tokensFor } from "./helpers/css-tokens";

const MIN = 4.5;
const SURFACES = ["--card", "--background"] as const;
const cases = COLOR_COMBOS.flatMap((combo) => [false, true].map((hc) => ({ combo, hc })));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(name) ? [full] : [];
  });
const css = readFileSync("src/styles.css", "utf8");

describe("solid text colours", () => {
  it.each(cases)(
    "$combo.id (high contrast $hc): every text token reads at 4.5:1",
    ({ combo, hc }) => {
      const t = tokensFor(combo.mode, combo.accent, hc);
      const fails: string[] = [];
      for (const fg of [
        "--foreground",
        "--muted-foreground",
        "--primary",
        "--accent",
        "--destructive",
        "--warning",
        "--success",
        "--info",
        "--magenta",
      ]) {
        if (!t[fg]) continue;
        for (const bg of SURFACES) {
          const ratio = contrastRatio(t[fg] ?? "", t[bg] ?? "");
          if (ratio < MIN) fails.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(fails).toEqual([]);
    },
  );
});

describe("faded text", () => {
  /** Faded classes the stylesheet lifts to a floor. */
  const FLOORED: Record<string, [number, number]> = {
    primary: [50, 80],
    "muted-foreground": [60, 80],
  };
  /** Faded on purpose: a divider glyph, a disabled control. Named by file so a new one cannot hide here. */
  const EXEMPT = new Set([
    "src/components/friday/TitleStrip.tsx:text-primary/25",
    "src/components/friday/NotificationCenter.tsx:text-muted-foreground/50",
  ]);

  it.each(cases)(
    "$combo.id (high contrast $hc): the floors keep faded text at 4.5:1",
    ({ combo, hc }) => {
      const t = tokensFor(combo.mode, combo.accent, hc);
      const share = (name: string) => Number.parseFloat(t[name] ?? "0") / 100;
      const fails: string[] = [];
      for (const [fg, floor] of [
        ["--primary", share("--friday-dim-primary")],
        ["--muted-foreground", share("--friday-dim-muted")],
      ] as const) {
        expect(floor, fg).toBeGreaterThan(0);
        for (const bg of SURFACES) {
          const ratio = contrastWithAlpha(t[fg] ?? "", t[bg] ?? "", floor);
          if (ratio < MIN) fails.push(`${fg} at ${floor * 100}% on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(fails).toEqual([]);
    },
  );

  it("every faded text class in the source is lifted by a floor, exempt, or already strong enough", () => {
    const loose: string[] = [];
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /\btext-(primary|muted-foreground|accent|destructive|warning|success|info|magenta)\/(\d+)\b/g,
      )) {
        const token = match[1] ?? "";
        const alpha = Number(match[2]);
        if (alpha >= 90) continue;
        const range = FLOORED[token];
        const lifted =
          range !== undefined &&
          alpha >= range[0] &&
          alpha <= range[1] &&
          css.includes(`.text-${token}\\/${alpha}`);
        const key = `${file.replace(/\\/g, "/")}:${match[0]}`;
        if (!lifted && !EXEMPT.has(key)) loose.push(key);
      }
    }
    expect(loose).toEqual([]);
  });
});
