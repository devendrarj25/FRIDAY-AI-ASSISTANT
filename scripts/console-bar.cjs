/**
 * One look for every progress bar in setup, Doctor and the build.
 *
 * On a real console a bar is a solid coloured line: filled cells in the colour of the state (cyan while it moves,
 * green when done, red when it failed) and the rest of the line in dark grey, so the bar reads as one line and not
 * as `#####-----`. In a log file, CI or with NO_COLOR the same bar stays plain text (`[#####-----]`), so a saved log is
 * still readable. The block character is in every Windows console font (code page 437), so it never turns to boxes.
 *
 * This file draws and never decides: whether colour is wanted is the caller's question (scripts/live-console.cjs).
 */
"use strict";

const ESC = "\x1b[";
const paint = (code, text) => (text === "" ? text : `${ESC}${code}m${text}${ESC}0m`);

const BLOCK = "█";
const TONE = { running: "36", done: "32", failed: "31", warn: "33", waiting: "90" };

/** A solid bar of `total` cells, `filled` of them lit in the colour of `tone`. */
function solidBar(filled, total, tone = "running") {
  const cells = Math.max(1, Math.round(total));
  const lit = Math.max(0, Math.min(cells, Math.round(filled)));
  return `${paint(TONE[tone] || TONE.running, BLOCK.repeat(lit))}${paint(TONE.waiting, BLOCK.repeat(cells - lit))}`;
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

module.exports = { solidBar, solidBarOf, plainBarOf, recolorBars, paint, BLOCK };
