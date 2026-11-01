/**
 * FRIDAY · what the owner does with her suggestions
 *
 * A suggestion FRIDAY makes on her own (a routine reminder, a lesson from what worked, a practice item) goes
 * through the approval gate. If he declines the same kind three times in a row, she stops offering that kind
 * for two weeks; one yes in between clears the count. Only a count per kind is kept, never what was suggested.
 * Anything he asked for himself is not a suggestion and never muted.
 */

import { readLocalState, writeState } from "../persist";

export type Family = "routine" | "dream" | "practice";

type Row = { dismissed: number; mutedUntil: number };

const KEY = "friday.suggestion-feedback.v1";
const DAY = 86_400_000;
export const MUTE_AFTER = 3;
export const MUTE_FOR_MS = 14 * DAY;

let table: Record<string, Row> | null = null;

function load(): Record<string, Row> {
  if (!table) {
    const stored = readLocalState<Record<string, Row>>(KEY);
    table = stored && typeof stored === "object" ? { ...stored } : {};
  }
  return table;
}

/** Which kind of suggestion a governance item is, from the id it was filed under. */
export function familyOf(id: string, title = ""): Family | null {
  if (id.startsWith("routine-")) return "routine";
  if (id.startsWith("dream-")) return "dream";
  if (/^Practise:/i.test(title)) return "practice";
  return null;
}

export function noteDecision(family: Family, allowed: boolean, now = Date.now()): void {
  const rows = load();
  const row = rows[family] ?? { dismissed: 0, mutedUntil: 0 };
  if (allowed) {
    row.dismissed = 0;
    row.mutedUntil = 0;
  } else {
    row.dismissed += 1;
    if (row.dismissed >= MUTE_AFTER) row.mutedUntil = now + MUTE_FOR_MS;
  }
  rows[family] = row;
  writeState(KEY, rows);
}

/** False while a kind is muted. A mute that has run out also clears the count so it starts fresh. */
export function mayOffer(family: Family, now = Date.now()): boolean {
  const rows = load();
  const row = rows[family];
  if (!row || !row.mutedUntil) return true;
  if (now < row.mutedUntil) return false;
  rows[family] = { dismissed: 0, mutedUntil: 0 };
  writeState(KEY, rows);
  return true;
}

export function resetSuggestionFeedbackForTests(): void {
  table = {};
  writeState(KEY, {});
}
