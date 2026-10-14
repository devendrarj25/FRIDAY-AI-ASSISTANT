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

const MAX_ROWS = 80;
let rows: HeardRow[] = [];

export function resetHeardLog(): void {
  rows = [];
}

export function noteHeard(row: HeardRow, keepMs: number, now: number): HeardRow[] {
  if (keepMs <= 0) {
    rows = [];
    return rows;
  }
  rows = rows
    .concat(row)
    .filter((item) => now - item.at <= keepMs)
    .slice(-MAX_ROWS);
  return rows;
}

export function heardRows(): readonly HeardRow[] {
  return rows;
}

export function clearHeard(): void {
  rows = [];
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
