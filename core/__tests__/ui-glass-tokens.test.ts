/**
 * FRIDAY Glass tokens: contrast of text and icon tokens against the surface
 * tokens in all 8 mode + accent combinations and with High contrast, read
 * from src/styles.css itself. Pure math, no browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COLOR_COMBOS,
  contrastRatio,
  oklchToLinearRgb,
  parseOklch,
} from "../../src/lib/friday/appearance";

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

/* ------------------------------------------------------------------ */
/*  FRIDAY Glass, iOS recipe (task ui-glass-ios-look)                  */
/* ------------------------------------------------------------------ */

const GLASS = 'html[data-ui-style="glass"]';
const rem = (value: string | undefined) => Number.parseFloat(value ?? "NaN");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `--name: value;` pairs of every block with exactly this selector, merged. */
function tokenBlocks(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  let from = 0;
  for (;;) {
    const start = bare.indexOf(`\n${selector} {`, from);
    if (start < 0) return out;
    const end = bare.indexOf("\n}", start);
    for (const m of bare.slice(start, end).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
      out[m[1] ?? ""] = (m[2] ?? "").trim();
    from = end;
  }
}
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/** Every `selector { body }` rule of the style sheet (flat; at-rules unwrapped). */
function parseRules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of text.matchAll(/([^{}@;]+)\{([^{}]*)\}/g))
    out.push({ selector: (m[1] ?? "").trim().replace(/\s+/g, " "), body: m[2] ?? "" });
  return out;
}
const rules = () => parseRules(bare);
/** Every declaration block that has exactly this selector, joined (later ones win in CSS). */
const ruleFor = (selector: string) =>
  rules()
    .filter((r) => r.selector === selector)
    .map((r) => r.body)
    .join("\n");

describe("corner scale", () => {
  it("is rounder in glass and keeps Classic's 0.4rem", () => {
    expect(tokenBlock(":root")["--radius"]).toBe("0.4rem");
    const glass = tokenBlock(GLASS);
    expect(rem(glass["--radius"])).toBeGreaterThanOrEqual(1);
    expect(rem(glass["--radius-card"])).toBeGreaterThanOrEqual(1.25);
    expect(rem(glass["--radius-sheet"])).toBeGreaterThanOrEqual(1.5);
    expect(tokenBlocks(":root")["--radius-pill"]).toBe("999px");
  });

  it("offers Round, Medium and Sharp (Sharp is the Classic value)", () => {
    expect(tokenBlock(`${GLASS}[data-corner-style="Medium"]`)["--radius"]).toBe("0.65rem");
    expect(tokenBlock(`${GLASS}[data-corner-style="Sharp"]`)["--radius"]).toBe("0.4rem");
  });

  it("panels, tiles, menus and sheets read the scale", () => {
    expect(ruleFor(`${GLASS} .hud-panel`)).toContain("border-radius: var(--radius-card)");
    expect(ruleFor(`${GLASS} .hud-tile`)).toContain("border-radius: var(--radius)");
    expect(ruleFor(`${GLASS} .glass-dialog`)).toContain("var(--radius-sheet)");
    expect(ruleFor(`${GLASS} .glass-menu`)).toContain("var(--radius-xl)");
  });

  it("meets the numeric acceptance (px at the default Round corners)", () => {
    const root = 16;
    const glass = tokenBlock(GLASS);
    const card = rem(glass["--radius-card"]) * root;
    const field = rem(glass["--radius"]) * root + 4; // --radius-xl on .friday-field
    expect(card).toBeGreaterThanOrEqual(16);
    expect(field).toBeGreaterThanOrEqual(20);
    expect(ruleFor(`${GLASS} .friday-btn[data-variant="default"]`)).toContain("var(--radius-pill)");
    expect(ruleFor(`${GLASS} .friday-field`)).toContain("min-height: 2rem");
    expect(ruleFor(`${GLASS} .friday-field`)).toContain("border-radius: var(--radius-xl)");
    const bubble = ruleFor(`${GLASS} .bubble-user`) + ruleFor(`${GLASS} .bubble-friday`);
    expect(bubble).toContain("0.35rem");
    expect(ruleFor(`${GLASS} .bubble-user, ${GLASS} .bubble-friday`)).toContain("1.25rem");
    expect(ruleFor(`${GLASS} .friday-composer`)).toContain("border-radius: 1.5rem");
    expect(
      ruleFor(
        `${GLASS} .friday-btn[data-size="sm"], ${GLASS} .friday-btn[data-size="default"], ${GLASS} .friday-btn[data-size="lg"]`,
      ),
    ).toContain("min-height: 2rem");
  });
});

describe("ambient light", () => {
  // The first rule is the layer itself; later ones are the reduced-motion override.
  const base = rules().find((r) => r.selector === `${GLASS} body::before`)?.body ?? "";

  it("is one fixed, click-through layer with three lights, glass only", () => {
    expect(base).toContain("position: fixed");
    expect(base).toContain("pointer-events: none");
    expect(base).toContain("z-index: -1");
    expect(base.match(/radial-gradient\(/g)?.length).toBe(3);
    for (const token of ["--color-primary", "--color-magenta", "--color-warning"])
      expect(base).toContain(token);
    expect(base).toContain("--friday-ambient");
    expect(base).toContain("--friday-graphic-intensity");
    expect(css).not.toMatch(/\n(?:html )?body::before/);
  });

  it("is static; it drifts only with Ambient motion On and no no-motion or no-gpu", () => {
    expect(base).not.toContain("animation");
    const drift = rules().filter(
      (r) => r.body.includes("friday-ambient-drift") && r.body.includes("animation:"),
    );
    expect(drift.map((r) => r.selector)).toEqual([
      `${GLASS}[data-ambient-motion="On"]:not(.no-motion):not(.no-gpu) body::before`,
    ]);
    expect(css).toContain(
      "html.no-motion body::before,\nhtml.no-gpu body::before {\n  animation: none;",
    );
    expect(css).toContain("html.friday-hidden body::before");
    const keyframes = css.slice(css.indexOf("@keyframes friday-ambient-drift"));
    const frames = keyframes.slice(0, keyframes.indexOf("\n}\nhtml"));
    expect(frames).toContain("transform");
    expect(frames).not.toMatch(/\b(top|left|width|height|margin)\b/);
  });

  it("has Off, Soft and Vivid strengths and works in Daylight too", () => {
    expect(tokenBlock('html[data-ambient-light="Off"]')["--friday-ambient"]).toBe("0");
    expect(
      Number(tokenBlock('html[data-ambient-light="Soft"]')["--friday-ambient"]),
    ).toBeGreaterThan(0);
    expect(Number(tokenBlocks(":root")["--friday-ambient"])).toBe(1);
    const day = tokenBlock(`${GLASS}.theme-daylight`);
    expect(Number(day["--friday-ambient-scale"])).toBeGreaterThan(0.4);
  });
});

describe("glass fills", () => {
  it("are translucent in dark and light in Daylight", () => {
    const dark = tokenBlock(GLASS);
    expect(Number.parseFloat(dark["--friday-fill-top"] ?? "100")).toBeLessThanOrEqual(35);
    expect(Number.parseFloat(dark["--friday-fill-top"] ?? "0")).toBeGreaterThanOrEqual(6);
    expect(dark["--friday-glass-top"]).toContain("--friday-panel-opacity");
    const day = tokenBlock(`${GLASS}.theme-daylight`);
    const top = Number.parseFloat(day["--friday-fill-top"] ?? "0");
    expect(top).toBeGreaterThanOrEqual(55);
    expect(top).toBeLessThanOrEqual(70);
  });

  it("depth changes blur 10 / 18 / 26 px and the fill", () => {
    expect(tokenBlock(GLASS)["--friday-glass-blur"]).toBe("18px");
    expect(tokenBlock(`${GLASS}[data-glass-depth="Subtle"]`)["--friday-glass-blur"]).toBe("10px");
    expect(tokenBlock(`${GLASS}[data-glass-depth="Rich"]`)["--friday-glass-blur"]).toBe("26px");
    expect(
      Number(tokenBlock(`${GLASS}[data-glass-depth="Subtle"]`)["--friday-fill-k"]),
    ).toBeLessThan(1);
    expect(
      Number(tokenBlock(`${GLASS}[data-glass-depth="Rich"]`)["--friday-fill-k"]),
    ).toBeGreaterThan(1);
  });

  it("uses the spring easing and 120 / 200 / 320 ms", () => {
    const glass = tokenBlock(GLASS);
    expect(glass["--friday-ease"]).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    expect([
      glass["--friday-motion-fast"],
      glass["--friday-motion-mid"],
      glass["--friday-motion-slow"],
    ]).toEqual(["120ms", "200ms", "320ms"]);
  });
});

describe("blur policy", () => {
  const blurRules = rules().filter((r) => /backdrop-filter:\s*blur/.test(r.body));

  it("only the Blur setting switches blur off; Neon glow never does", () => {
    const glowRules = rules().filter((r) => r.selector.includes("no-glow"));
    expect(glowRules.length).toBeGreaterThan(0);
    for (const r of glowRules) expect(r.body).not.toContain("backdrop-filter");
    const off = rules().find(
      (r) =>
        r.selector.includes("html.no-blur .friday-sidebar") &&
        r.body.includes("backdrop-filter: none"),
    );
    expect(off?.selector).toContain("html.no-blur .friday-titlestrip");
    expect(off?.selector).toContain("html.no-blur .friday-chat-full");
    expect(off?.selector).toContain("html.no-blur .voice-glass");
    expect(css).toContain(
      'html.no-blur [class*="backdrop-blur"] { backdrop-filter: none !important; }',
    );
  });

  it("GPU render off removes every blur and uses solid fills", () => {
    expect(css).toMatch(/html\.no-gpu \* \{[^}]*backdrop-filter: none !important/);
    expect(css).toContain('html.no-gpu[data-ui-style="glass"] :is(.hud-panel');
  });

  it("stays inside the blur budget and never blurs a card, tile or bubble", () => {
    for (const r of blurRules)
      expect(r.selector).not.toMatch(/hud-panel|hud-tile|bubble|nav-link|neural-circuit/);
    // Page level: sidebar, title strip, Full chat (+ its composer), voice.
    const pageLevel = blurRules.filter((r) =>
      /friday-sidebar|friday-titlestrip|friday-chat-full|voice-glass|friday-composer/.test(
        r.selector,
      ),
    );
    expect(pageLevel.length).toBeLessThanOrEqual(8);
    expect(blurRules.length).toBeLessThanOrEqual(14);
  });
});

describe("contrast over the ambient lights", () => {
  /** Alpha blend of `top` at `alpha` over `bottom`, composited in sRGB like the browser. */
  const enc = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  const dec = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const mix = (
    top: [number, number, number],
    bottom: [number, number, number],
    alpha: number,
  ): [number, number, number] => [
    dec(enc(top[0]) * alpha + enc(bottom[0]) * (1 - alpha)),
    dec(enc(top[1]) * alpha + enc(bottom[1]) * (1 - alpha)),
    dec(enc(top[2]) * alpha + enc(bottom[2]) * (1 - alpha)),
  ];
  const rgb = (value: string | undefined) => {
    const lch = parseOklch(value ?? "");
    if (!lch) throw new Error(`not oklch: ${value}`);
    return oklchToLinearRgb(...lch);
  };
  const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  it.each(COLOR_COMBOS)(
    "$id keeps 4.5:1 text at each light's peak with Vivid lights and Rich glass",
    ({ mode, accent }) => {
      const t = tokensFor(mode, accent, true);
      const scale = mode === "daylight" ? 0.62 : 1;
      // Worst case: Graphic intensity 100% hits each light's cap (the min() in
      // the layer), and the text sits on the brightest point of that light.
      const caps = [
        ...ruleFor(`${GLASS} body::before`).matchAll(/min\(.*?\/ 0\.7,\s*([\d.]+)%\)/gs),
      ].map((m) => Number(m[1]) / 100);
      expect(caps).toHaveLength(3);
      const lights = ["--primary", "--magenta", "--warning"] as const;
      const ground = lights.map((light, i) =>
        mix(rgb(t[light]), rgb(t["--background"]), (caps[i] ?? 1) * scale),
      );
      // Rich glass fill on top (tint is the foreground in dark, white in Daylight).
      const tint: [number, number, number] =
        mode === "daylight" ? [1, 1, 1] : rgb(t["--foreground"]);
      const fill = mode === "daylight" ? Math.min(0.7 * 1.3, 0.95) : 0.09 * 1.3;
      const fails: string[] = [];
      for (const point of ground) {
        const panel = mix(tint, point, fill);
        for (const [fg, bg, name] of [
          [rgb(t["--foreground"]), panel, "foreground on panel"],
          [rgb(t["--muted-foreground"]), panel, "muted on panel"],
          [rgb(t["--foreground"]), point, "foreground on lights"],
        ] as const) {
          const r = ratio(fg, bg);
          if (r < 4.5) fails.push(`${name}: ${r.toFixed(2)}`);
        }
      }
      expect(fails).toEqual([]);
    },
  );
});

describe("Classic keeps the earlier look", () => {
  it("only glass selectors carry the new recipe", () => {
    const start = css.indexOf("\n:root {\n  --radius-pill");
    const end = css.indexOf("/* Conversation bubbles (chat and voice)");
    const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
    const bareRules = parseRules(block)
      .map((r) => r.selector)
      .filter((sel) => !sel.includes('[data-ui-style="glass"]') && !/^html[.:[]/.test(sel))
      .filter(
        (sel) => !/^(:root|\.friday-seg-thumb|\.typing-dot|from|to|\d+%(, \d+%)*)$/.test(sel),
      );
    expect(JSON.stringify(bareRules)).toBe("[]");
    // Classic values are the earlier ones.
    expect(tokenBlock(":root")["--radius"]).toBe("0.4rem");
    expect(tokenBlocks(":root")["--friday-glass-blur"]).toBe("14px");
    expect(css).toContain("--friday-ease: cubic-bezier(0.22, 1, 0.36, 1);");
    expect(css).toContain(
      'html:not([data-ui-style="glass"]) .glass-backdrop-blur {\n  backdrop-filter: none;',
    );
    expect(css).not.toContain('[data-ui-style="classic"]');
  });
});

describe("bubbles", () => {
  it("every chat level and the voice captions use the bubble classes", () => {
    const messages = read("src/components/friday/ChatMessages.tsx");
    const dock = read("src/components/friday/ChatDock.tsx");
    const voice = read("src/components/friday/VoiceTranscript.tsx");
    expect(messages).toContain("bubble-friday bubble-enter");
    expect(dock).toContain('"bubble-user px-3.5 py-2.5 text-sm"');
    expect(dock).toContain('"bubble-user px-2.5 py-1.5 text-xs"');
    expect(voice).toContain('user ? "bubble-user" : "bubble-friday"');
    // One row component serves Compact, Expanded and Full chat.
    expect(dock).toContain("ChatTranscript");
    expect(dock).not.toMatch(/level === 3[^\n]*bubble-/);
    const glass = css.slice(css.lastIndexOf("Conversation bubbles in glass"));
    expect(glass).toContain("border-bottom-right-radius: 0.35rem");
    expect(glass).toContain("border-bottom-left-radius: 0.35rem");
    expect(glass).toContain("max-width: 78%");
    expect(glass).toContain("translateY(6px)");
  });

  it("the typing dots follow the real busy state", () => {
    const messages = read("src/components/friday/ChatMessages.tsx");
    expect(messages).toContain('busy && (!newest || newest.role === "user" || !newest.text)');
    expect(css).toContain("html.friday-hidden .typing-dot");
  });
});
