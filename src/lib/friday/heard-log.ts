/**
 * FRIDAY · local rolling transcript of what Auto mode heard.
 *
 * The rows stay on this PC. Cloud routes receive them only when the owner
 * turned that on and Privacy mode is off. Reports take counts, never the text.
 */

import type { AddressTag } from "./addressing";

export type HeardRow = {
  at: number;
  text: string;
  tag: AddressTag;
  language: string;
  confidence: number;
};

/** Hard cap. The owner can keep fewer rows. Zero turns the log off. */
export const HEARD_ROW_CAP = 80;
/** Short default. Ten minutes and this many rows, both on this PC. */
export const HEARD_ROW_DEFAULT = 40;
let rows: HeardRow[] = [];

export function resetHeardLog(): void {
  rows = [];
}

export function noteHeard(
  row: HeardRow,
  keepMs: number,
  now: number,
  keepRows: number = HEARD_ROW_DEFAULT,
): HeardRow[] {
  const cap = Number(keepRows);
  if (keepMs <= 0 || !Number.isFinite(cap) || cap <= 0) {
    rows = [];
    return rows;
  }
  rows = rows
    .concat(row)
    .filter((item) => now - item.at <= keepMs)
    .slice(-Math.min(HEARD_ROW_CAP, Math.floor(cap)));
  return rows;
}

export function heardRows(): readonly HeardRow[] {
  return rows;
}

export function clearHeard(): void {
  rows = [];
}

let droppedHeard = 0;

/** Drop the oldest half. The counter is what the voice log reports. */
export function dropHeardOverflow(): number {
  if (rows.length > 1) rows = rows.slice(Math.ceil(rows.length / 2));
  droppedHeard += 1;
  return droppedHeard;
}

export function heardDropCount(): number {
  return droppedHeard;
}

/**
 * Text that may be added to a cloud prompt. Empty unless the owner allowed
 * it and Privacy mode is off.
 */
export function ambientContextForRoute(input: {
  privacy: boolean;
  allowAmbientCloud: boolean;
  rows?: readonly HeardRow[];
}): string {
  if (input.privacy || !input.allowAmbientCloud) return "";
  const source = input.rows ?? rows;
  return source
    .filter((row) => row.tag !== "self")
    .map((row) => row.text)
    .join("\n")
    .slice(0, 2000);
}

export function heardSummary(source: readonly HeardRow[] = rows): {
  count: number;
  addressed: number;
  ambient: number;
  self: number;
} {
  return {
    count: source.length,
    addressed: source.filter((row) => row.tag === "addressed").length,
    ambient: source.filter((row) => row.tag === "ambient").length,
    self: source.filter((row) => row.tag === "self").length,
  };
}
