/**
 * One look for every progress bar in setup, Doctor and the build.
 *
 * On a real console a bar is a thin coloured line: filled cells in the colour of the state (cyan while it moves,
 * green when done, red when it failed) and the rest of the line in dark grey, so the bar reads as one line and not
 * as `#####-----`. In a log file, CI or with NO_COLOR the same bar stays plain text (`[#####-----]`), so a saved log is
 * still readable.
 *
 * The line is a box-drawing character, not a full block: a full block fills the whole height of its row, so the bars of
 * two rows under each other (the model and pack boards) merged into one slab (seen on the owner's console). The heavy
 * line (U+2501) is in Cascadia, Consolas and every font Windows Terminal uses; an old console host with a raster or
 * Lucida font gets the light line (U+2500, in code page 437), so it never turns to boxes.
 *
 * This file draws and never decides: whether colour is wanted is the caller's question (scripts/live-console.cjs).
 */
"use strict";

const ESC = "\x1b[";
const paint = (code, text) => (text === "" ? text : `${ESC}${code}m${text}${ESC}0m`);

const HEAVY_LINE = "━";
const LIGHT_LINE = "─";

/** Windows Terminal and every modern console draw the heavy line; an old console host gets the light one. */
function lineGlyph(env = process.env) {
  if (process.platform !== "win32") return HEAVY_LINE;
  if (String(env.FRIDAY_ASCII ?? "") === "1") return LIGHT_LINE;
  return env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" ? HEAVY_LINE : LIGHT_LINE;
}
const TONE = { running: "36", done: "32", failed: "31", warn: "33", waiting: "90" };

/** A solid bar of `total` cells, `filled` of them lit in the colour of `tone`. */
function solidBar(filled, total, tone = "running") {
  const cells = Math.max(1, Math.round(total));
  const lit = Math.max(0, Math.min(cells, Math.round(filled)));
  const glyph = lineGlyph();
  return `${paint(TONE[tone] || TONE.running, glyph.repeat(lit))}${paint(TONE.waiting, glyph.repeat(cells - lit))}`;
}

/** The same bar from a fraction 0..1. */
function solidBarOf(fraction, total, tone) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return solidBar(f * total, total, tone);
}

/** The plain-text bar for a log: `#####-----`. */
function plainBarOf(fraction, total) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const lit = Math.round(f * total);
  return `${"#".repeat(lit)}${"-".repeat(total - lit)}`;
}

/**
 * A bar drawn by a tool in text (`[#####-----]`, `[=====>     ]`, `[!!!!!]`) becomes one solid coloured line. Only a bar
 * of ten cells or more is touched, so a word in brackets is never mistaken for one. The words around it stay as they are.
 */
function recolorBars(text) {
  return String(text).replace(/\[([#=!>]*)([ \-.]*)\]/g, (all, filled, rest) => {
    const total = filled.length + rest.length;
    if (total < 10) return all;
    const tone = filled.startsWith("!")
      ? "failed"
      : filled.length === 0
        ? "waiting"
        : rest.length === 0
          ? "done"
          : "running";
    return solidBar(filled.length, total, tone);
  });
}

module.exports = {
  solidBar,
  solidBarOf,
  plainBarOf,
  recolorBars,
  paint,
  lineGlyph,
  HEAVY_LINE,
  LIGHT_LINE,
};
