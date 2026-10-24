/**
 * Native controls and corner popups follow the app theme: the open list of a
 * <select> is dark on a dark app (it was a white sheet), and toast text is
 * drawn in the app's colours (it was dark on dark).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const css = readFileSync(path.join(root, "src/styles.css"), "utf8");
const toaster = readFileSync(path.join(root, "src/components/ui/sonner.tsx"), "utf8");

describe("native theme", () => {
  it("tells the browser which colour scheme native controls use", () => {
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/);
    expect(css).toMatch(/\.theme-daylight \{\s*color-scheme: light;/);
    expect(css).toMatch(/select option,\s*select optgroup \{\s*background-color: var\(--popover\)/);
  });

  it("draws toast text in the app colours, outside any cascade layer", () => {
    const rule = css.indexOf("[data-sonner-toaster] [data-sonner-toast] {");
    expect(rule).toBeGreaterThan(0);
    // Everything after the last layer block closes is unlayered.
    const layered = css.lastIndexOf("@layer base {");
    const layerEnd = css.indexOf("\n}\n", layered);
    expect(rule).toBeGreaterThan(layerEnd);
    expect(toaster).toContain('"--normal-text": "var(--popover-foreground)"');
  });
});
