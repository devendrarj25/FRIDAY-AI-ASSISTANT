// FRIDAY · skill: dev-color-contrast
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// WCAG 2.x contrast ratio of two colours, the AA and AAA verdicts, and conversions between hex, rgb and hsl.

const NAMED = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  navy: "#000080",
  teal: "#008080",
  silver: "#c0c0c0",
};

export function parseColor(text) {
  const t = String(text).trim().toLowerCase();
  if (NAMED[t]) return parseColor(NAMED[t]);
  let m = t.match(/^#?([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = t.match(/^#?([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = t.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (m) return [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)));
  m = t.match(/^hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function rgbToHsl([r, g, b]) {
  const [rn, gn, bn] = [r, g, b].map((v) => v / 255);
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h = Math.round(h * 60);
  return [(h + 360) % 360, Math.round(s * 100), Math.round(l * 100)];
}
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const describe = (rgb) => ({
  hex: hex(rgb),
  rgb: `rgb(${rgb.join(", ")})`,
  hsl: `hsl(${rgbToHsl(rgb)[0]}, ${rgbToHsl(rgb)[1]}%, ${rgbToHsl(rgb)[2]}%)`,
});

/** The nearest lightness of the foreground (same hue) that reaches the target ratio. */
function suggest(fg, bg, target) {
  const [h, s, l] = rgbToHsl(fg);
  for (let step = 1; step <= 100; step += 1) {
    for (const dir of [-1, 1]) {
      const nl = l + dir * step;
      if (nl < 0 || nl > 100) continue;
      const rgb = hslToRgb(h, s / 100, nl / 100);
      if (contrast(rgb, bg) >= target) return rgb;
    }
  }
  return null;
}

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "");
  const tokens =
    text.match(
      /#[0-9a-f]{3,6}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|green|blue|yellow|gray|grey|orange|purple|navy|teal|silver)\b/gi,
    ) ?? [];
  const fgRaw = input?.foreground ?? input?.fg ?? input?.color ?? tokens[0];
  const bgRaw = input?.background ?? input?.bg ?? tokens[1];
  const fg = fgRaw ? parseColor(fgRaw) : null;
  if (!fg)
    return {
      ok: false,
      error:
        "Give a colour such as #1a2b3c, rgb(26, 43, 60), hsl(210, 40%, 17%) or a name, and a second colour to get a contrast ratio.",
    };
  if (!bgRaw)
    return {
      ok: true,
      color: describe(fg),
      answer: `${hex(fg)} = rgb(${fg.join(", ")}) = hsl(${rgbToHsl(fg)[0]}, ${rgbToHsl(fg)[1]}%, ${rgbToHsl(fg)[2]}%).`,
    };
  const bg = parseColor(bgRaw);
  if (!bg) return { ok: false, error: `Could not read the second colour "${bgRaw}".` };
  const ratio = contrast(fg, bg);
  const rounded = Math.round(ratio * 100) / 100;
  const verdict = {
    normalTextAA: ratio >= 4.5,
    normalTextAAA: ratio >= 7,
    largeTextAA: ratio >= 3,
    largeTextAAA: ratio >= 4.5,
    uiComponentsAA: ratio >= 3,
  };
  const out = {
    ok: true,
    foreground: describe(fg),
    background: describe(bg),
    ratio: rounded,
    ...verdict,
  };
  out.answer = `Contrast ${rounded}:1 - normal text AA ${verdict.normalTextAA ? "pass" : "FAIL"} (needs 4.5), AAA ${verdict.normalTextAAA ? "pass" : "fail"} (7); large text AA ${verdict.largeTextAA ? "pass" : "FAIL"} (3).`;
  if (!verdict.normalTextAA) {
    const better = suggest(fg, bg, 4.5);
    if (better)
      out.suggestion = {
        foreground: hex(better),
        ratio: Math.round(contrast(better, bg) * 100) / 100,
        note: "Same hue and saturation, lightness moved the least that reaches 4.5:1.",
      };
  }
  out.note =
    "WCAG 2.x relative-luminance contrast. Transparency (alpha) is ignored: use the colour as it looks on its background.";
  return out;
}

export default run;
