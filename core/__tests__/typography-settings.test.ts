import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  appearanceState,
  resetAppearancePreferences,
  resolveTextScale,
} from "../../src/lib/friday/appearance";
import { preferences } from "../../src/lib/friday/preferences";

const css = readFileSync("src/styles.css", "utf8");
const state = () => appearanceState(preferences.getSnapshot());

afterEach(() => resetAppearancePreferences());

describe("text settings reach the document", () => {
  it("leave the look alone at their defaults", () => {
    resetAppearancePreferences();
    const { vars, dataset } = state();
    for (const name of [
      "--friday-text-scale",
      "--friday-line-height",
      "--friday-letter-spacing",
      "--friday-body-weight",
      "--friday-chat-scale",
    ]) {
      expect(vars[name], name).toBeNull();
    }
    expect(dataset.textCustom).toBe("off");
    expect(dataset.smallText).toBe("Standard");
    expect(vars["--font-mono"]).toContain("JetBrains Mono");
  });

  it("apply a fine size, spacing, weight, chat size, small text and code font", () => {
    preferences.setField("textScale", "135");
    preferences.setField("lineSpacing", "Relaxed");
    preferences.setField("letterSpacing", "Wide");
    preferences.setField("textWeight", "Medium");
    preferences.setField("chatTextSize", "Large");
    preferences.setField("smallText", "Larger");
    preferences.setField("codeFont", "System mono");
    const { vars, dataset } = state();
    expect(vars["--friday-text-scale"]).toBe("1.35");
    expect(dataset.textCustom).toBe("on");
    expect(vars["--friday-line-height"]).toBe("1.65");
    expect(vars["--friday-letter-spacing"]).toBe("0.02em");
    expect(vars["--friday-body-weight"]).toBe("500");
    expect(vars["--friday-chat-scale"]).toBe("1.15");
    expect(dataset.smallText).toBe("Larger");
    expect(vars["--font-mono"]).toContain("Consolas");
  });

  it("keeps a custom size inside its range and falls back to the named size on nonsense", () => {
    expect(resolveTextScale({ textScale: "20" }).percent).toBe(TEXT_SCALE_MIN);
    expect(resolveTextScale({ textScale: "900" }).percent).toBe(TEXT_SCALE_MAX);
    expect(resolveTextScale({ textScale: "abc", textSize: "Large" })).toEqual({
      percent: 112.5,
      custom: false,
    });
    expect(resolveTextScale({ textSize: "Extra Large" }).percent).toBe(125);
    expect(resolveTextScale({}).percent).toBe(100);
  });

  it("ignores a value that is not one of the choices instead of writing it into CSS", () => {
    preferences.setField("lineSpacing", "9; background: red");
    preferences.setField("codeFont", "x; color: red");
    const { vars, dataset } = state();
    expect(dataset.lineSpacing).toBe("Normal");
    expect(vars["--friday-line-height"]).toBeNull();
    expect(vars["--font-mono"]).toContain("JetBrains Mono");
  });

  it("the font utilities read the variables Settings sets, not a name baked in by the theme", () => {
    // Checked in a real browser too: with the heading, body and code font changed, .font-display, .font-sans and
    // .font-mono took the new family. Without these rules the theme's inline names won and the choice did nothing.
    for (const name of ["display", "sans", "mono"]) {
      expect(css).toMatch(
        new RegExp(`\\.font-${name} \\{\\s*font-family: var\\(--font-${name}\\);`),
      );
    }
  });

  it("has a CSS rule that reads each of them", () => {
    expect(css).toContain('html[data-text-custom="on"]');
    expect(css).toContain("var(--friday-text-scale");
    expect(css).toContain("var(--friday-line-height)");
    expect(css).toContain("var(--friday-letter-spacing)");
    expect(css).toContain("var(--friday-body-weight)");
    expect(css).toContain("var(--friday-chat-scale");
    expect(css).toContain('html[data-small-text="Larger"]');
  });
});

describe("no text size ignores the owner's text size", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });

  it("uses rem, not px, for every font size in the components and routes", () => {
    const fixed: string[] = [];
    for (const file of walk("src")) {
      if (/__tests__|\.gen\.ts$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/text-\[\d+(?:\.\d+)?px\]/g))
        fixed.push(`${file}: ${match[0]}`);
    }
    expect(fixed).toEqual([]);
  });

  it("uses rem for font sizes in the stylesheet, except the root size itself", () => {
    const fixed = [...css.matchAll(/^\s*font-size:\s*(\d+(?:\.\d+)?)px\s*;/gm)].map((m) =>
      m[0].trim(),
    );
    // The four named sizes set the root size in px on purpose: everything else follows it.
    expect(fixed.filter((rule) => !/^font-size:\s*(14|16|18|20)px;$/.test(rule))).toEqual([]);
  });
});

describe("small text stays readable", () => {
  const walkTsx = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walkTsx(full) : /\.tsx$/.test(name) ? [full] : [];
    });

  it("no component sets a font size under 11px (0.6875rem) at the normal text size", () => {
    const tiny: string[] = [];
    for (const file of walkTsx("src")) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/text-\[(\d*\.?\d+)rem\]/g)) {
        if (Number(match[1]) < 0.6875) tiny.push(`${file}: ${match[0]}`);
      }
    }
    expect(tiny).toEqual([]);
  });

  it("the small text utilities are at least 11px in the default glass style", () => {
    for (const name of [
      "text-meta",
      "text-meta-sm",
      "text-note",
      "text-note-sm",
      "text-data",
      "text-data-sm",
    ]) {
      const rule = css.match(
        new RegExp(`html\\[data-ui-style="glass"\\] \\.${name} \\{[^}]*font-size:\\s*([\\d.]+)rem`),
      );
      expect(rule, name).not.toBeNull();
      expect(Number(rule?.[1]), name).toBeGreaterThanOrEqual(0.6875);
    }
  });

  it("the small text utilities are at least 11px in the Classic style too", () => {
    for (const name of [
      "label-xs",
      "text-meta",
      "text-meta-sm",
      "text-note",
      "text-note-sm",
      "text-data",
      "text-data-sm",
    ]) {
      const rule = css.match(new RegExp(`@utility ${name} \\{[^}]*?font-size:\\s*([\\d.]+)rem`));
      expect(rule, name).not.toBeNull();
      expect(Number(rule?.[1]), name).toBeGreaterThanOrEqual(0.6875);
    }
  });

  it("the title strip hides its chips by its own width in rem, so a larger text size drops them in time", () => {
    const source = readFileSync("src/components/friday/TitleStrip.tsx", "utf8");
    expect(source).toContain("@container");
    expect(source).not.toMatch(/\b(sm|md|lg|xl|2xl):(inline|flex|block)\b/);
    expect(source).toMatch(/@min-\[\d+rem\]:/);
  });
});
