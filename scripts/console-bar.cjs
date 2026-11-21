/**
 * One look for every progress bar in setup, Doctor and the build.
 *
 * On a real console a bar is a row of small rectangles (U+25AC): the finished part in green (red when it failed), the rest
 * in dark grey, so the bar reads as a bar and not as `#####-----`. In a log file, CI or with NO_COLOR the same bar stays
 * plain text (`[#####-----]`), so a saved log is still readable.
 *
 * The rectangle is a middle size on purpose. A full block fills the whole height of its row, so the bars of two rows under
 * each other (the model and pack boards) merged into one slab on the owner's console; a box-drawing line was too thin to
 * see and its cyan too faint. U+25AC is in code page 437, so it is in every console font and never turns to a box.
 *
 * This file draws and never decides: whether colour is wanted is the caller's question (scripts/live-console.cjs).
 */
"use strict";

const ESC = "\x1b[";
const paint = (code, text) => (text === "" ? text : `${ESC}${code}m${text}${ESC}0m`);

// A small rectangle (U+25AC, in code page 437 and every console font): thicker than a line so the bar is easy to see, far
// thinner than a full block so the bars of two rows under each other never merge.
const BAR_GLYPH = "▬";

/** The bar's character. */
function lineGlyph() {
  return BAR_GLYPH;
}

// Green for the part that is done (cyan was hard to see on the owner's console), dark grey for the rest.
const TONE = { running: "32", done: "32", failed: "31", warn: "33", waiting: "90" };

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

const MAX_CELLS = 40;
const STANDARD_CELLS = 24;

/**
 * A bar drawn by a tool in text (`[#####-----]`, `[=====>     ]`, `[!!!!!]`) becomes one solid coloured line. Only a bar
 * of ten cells or more is touched, so a word in brackets is never mistaken for one. The words around it stay as they are.
 */
function recolorBars(text) {
  return String(text).replace(/\[([#=!>]*)([ \-.]*)\]/g, (all, filled, rest) => {
    const total = filled.length + rest.length;
    if (total < 10) return all;
    // A tool that sizes its bar to the window (electron-builder's download bar is 80 to 90 cells) gets the same width as
    // every other bar, so the line neither wraps nor looks different.
    if (total > MAX_CELLS) {
      const tone = filled.startsWith("!")
        ? "failed"
        : filled.length === 0
          ? "waiting"
          : rest.length === 0
            ? "done"
            : "running";
      return solidBar((filled.length / total) * STANDARD_CELLS, STANDARD_CELLS, tone);
    }
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
  BAR_GLYPH,
};
