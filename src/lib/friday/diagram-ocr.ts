/**
 * FRIDAY · local diagram text.
 *
 * Tesseract's TSV is parsed here. The engine itself is installed by Install
 * Manager and run from the desktop process. This file does not spawn it.
 */

import type { OcrBox } from "./flow-diagram";

export type ShapeBounds = { x: number; y: number; width: number; height: number };

/** Word rows from `tesseract image stdout tsv`. Confidence is 0–1. */
export function boxesFromTesseractTsv(tsv: string): OcrBox[] {
  const rows = String(tsv || "").split(/\r?\n/);
  const boxes: OcrBox[] = [];
  for (const row of rows) {
    const cols = row.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const text = (cols[11] || "").trim();
    const confidence = Number(cols[10]);
    const x = Number(cols[6]);
    const y = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    if (![x, y, width, height].every((n) => Number.isFinite(n))) continue;
    boxes.push({
      text,
      x,
      y,
      width,
      height,
      confidence: confidence > 1 ? confidence / 100 : confidence,
    });
  }
  return boxes;
}

/** Words whose bounds sit inside a drawn box, in reading order. */
export function textInBox(words: OcrBox[], box: ShapeBounds): { text: string; confidence: number } {
  const inside = words
    .filter(
      (word) =>
        word.x + word.width >= box.x &&
        word.x <= box.x + box.width &&
        word.y + word.height >= box.y &&
        word.y <= box.y + box.height,
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!inside.length) return { text: "", confidence: 0.4 };
  const confidence = Math.min(...inside.map((word) => word.confidence));
  return { text: inside.map((word) => word.text).join(" "), confidence };
}
