import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("the title strip does not loop animations under its backdrop blur", () => {
  it("draws the small orb still", () => {
    expect(read("src/components/friday/TitleStrip.tsx")).toMatch(/<FridayOrb[^>]*\bstill\b/);
  });

  it("keeps every looping orb layer behind the still switch", () => {
    const orb = read("src/components/friday/FridayOrb.tsx");
    expect(orb).toContain("const moving = live && !still;");
    for (const layer of ["orb-halo", "orb-spin-slow", "orb-sweep", "orb-breathe"]) {
      const line = orb.split("\n").find((l) => l.includes(layer)) ?? "";
      expect(line, layer).toBeTruthy();
    }
    expect(orb).not.toMatch(
      /live \? "orb-|live && "orb-|\{live \? \(\s*<span\s+className="orb-sweep/,
    );
  });

  describe("expanding a section answers the click", () => {
    const css = read("src/styles.css");

    it("fades an opened details block in with opacity and transform only", () => {
      const frames = css.match(/@keyframes friday-reveal \{[^}]*\{[^}]*\}[^}]*\}/)?.[0] ?? "";
      expect(frames).toContain("opacity: 0");
      expect(frames).toContain("translateY");
      expect(frames).not.toMatch(/height|width|margin|padding/);
      expect(css).toMatch(/details\[open\] > :not\(summary\) \{\s*animation: friday-reveal/);
    });

    it("is switched off by reduced motion and by the Animations setting", () => {
      expect(css).toMatch(
        /prefers-reduced-motion: reduce\) \{\s*details\[open\] > :not\(summary\) \{\s*animation: none;/,
      );
      expect(css).toContain("html.no-motion details[open] > :not(summary)");
    });
  });

  describe("hover and focus ease instead of snapping", () => {
    const css = read("src/styles.css");

    it("gives every clickable element a base colour transition unless motion is reduced", () => {
      const base = css.slice(css.indexOf("@layer base {"), css.indexOf("@layer base {") + 3000);
      expect(base).toMatch(
        /prefers-reduced-motion: no-preference\) \{\s*a,\s*button,\s*select,\s*summary/,
      );
      expect(base).toContain(
        "transition-property: color, background-color, border-color, box-shadow, opacity;",
      );
      // Never transform or layout properties: those are what make a page feel heavy.
      expect(base).not.toMatch(
        /transition-property:[^;]*(width|height|margin|padding|transform|all)/,
      );
    });
  });

  describe("scrolling lists do not drag the page", () => {
    it("contains the scroll of menus, dialogs and capped lists", () => {
      const css = read("src/styles.css");
      expect(css).toMatch(/\[role="dialog"\][^{]*\{\s*overscroll-behavior: contain;/);
      expect(css).toContain('[class*="max-h-"]');
    });
  });
});
