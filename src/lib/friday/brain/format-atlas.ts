/**
 * FRIDAY · what she can read and make, by kind of file
 *
 * The facts are rows in `config/format-atlas.json`, not code, so a new format is a new row. A row says
 * what is built (with the tool and a test), what needs an installed program, and what is honestly not
 * there. The answer to "can you read or make X" comes from the row plus the installed tools the Self
 * Atlas reports, never from what a model remembers about itself.
 */

import atlasData from "../../../../config/format-atlas.json";
import { latestAtlas } from "../self-atlas";
import { looksLikeFailure } from "./error-intelligence";

export type FormatStatus = "built" | "needs-tool" | "partial" | "not-built";

export type FormatAbility = { status: FormatStatus; tool: string; note: string };

export type FormatRow = {
  id: string;
  label: string;
  match: string[];
  words: string[];
  read: FormatAbility;
  make: FormatAbility;
  run?: FormatAbility;
};

export const FORMAT_ROWS: readonly FormatRow[] = atlasData.formats as FormatRow[];

const ASK =
  /\b(can|could|do|does|will|are)\s+(you|u|friday)\b|\bcan i\b|\bkya\b|\bsakti\b|\bsakte\b|\bable to\b/i;
const MAKE_VERB = /\b(make|create|generate|build|write|produce|export|banao|bana|banana|likho)\b/i;
const READ_VERB =
  /\b(read|open|understand|parse|analy[sz]e|summari[sz]e|extract|watch|listen|dekh|padh|padho|samajh)\b/i;

/** Rows a message is about: a ".docx"-style extension, an extension word, or a plain name like "excel". */
export function findFormats(text: string): FormatRow[] {
  const lower = String(text || "").toLowerCase();
  const tokens = new Set(lower.match(/[a-z0-9]+/g) ?? []);
  const dotted = new Set([...lower.matchAll(/\.([a-z0-9]{1,6})\b/g)].map((m) => m[1] ?? ""));
  const hits: FormatRow[] = [];
  for (const row of FORMAT_ROWS) {
    const byExtension = row.match.some((ext) => dotted.has(ext));
    // A bare word like "ts" or "c" is too common to count; plain names and long extensions do.
    const byName = row.words.some((word) =>
      word.includes(" ") ? lower.includes(word) : tokens.has(word),
    );
    const byLongExtension = row.match.some((ext) => ext.length >= 3 && tokens.has(ext));
    if (byExtension || byName || byLongExtension) hits.push(row);
  }
  return hits;
}

/** True when the owner asks whether she can do something with a kind of file, not when she is asked to do it. */
export function asksAboutFormats(text: string): { read: boolean; make: boolean } | null {
  const body = String(text || "");
  // A pasted error or a long document is data to look at, not a question about ability.
  if (body.length > 300 || body.split("\n").length > 3 || looksLikeFailure(body)) return null;
  if (!ASK.test(body) || findFormats(body).length === 0) return null;
  const make = MAKE_VERB.test(body);
  const read = READ_VERB.test(body);
  return { read: read || !make, make: make || !read };
}

const MARK: Record<FormatStatus, string> = {
  built: "yes",
  "needs-tool": "yes, with an installed program",
  partial: "partly",
  "not-built": "not yet",
};

const MARK_HI: Record<FormatStatus, string> = {
  built: "haan",
  "needs-tool": "haan, ek program install hone par",
  partial: "kuch hisse tak",
  "not-built": "abhi nahi",
};

function toolInstalled(name: string): boolean | null {
  const facts = latestAtlas()?.facts;
  if (!facts) return null;
  const hit = facts.find(
    (fact) =>
      fact.group === "inventory" && new RegExp(name, "i").test(`${fact.label} ${fact.value}`),
  );
  if (hit) return hit.status !== "bad";
  return null;
}

/** One line per kind, saying what she can do with it and what she cannot. */
export function describeFormats(
  rows: readonly FormatRow[],
  want: { read: boolean; make: boolean } = { read: true, make: true },
  hinglish = false,
): string {
  const marks = hinglish ? MARK_HI : MARK;
  const lines: string[] = [];
  for (const row of rows) {
    const parts: string[] = [];
    for (const [key, label, labelHi] of [
      ["read", "Read", "Padhna"],
      ["make", "Make", "Banana"],
    ] as const) {
      if (!want[key]) continue;
      const ability = row[key];
      let state = marks[ability.status];
      if (ability.status === "needs-tool") {
        const installed = toolInstalled("ffmpeg");
        if (installed === false)
          state = hinglish
            ? "abhi nahi, ffmpeg install nahi hai"
            : "not now: ffmpeg is not installed";
        else if (installed === true)
          state = hinglish ? "haan, ffmpeg hai" : "yes, ffmpeg is installed";
      }
      parts.push(
        `${hinglish ? labelHi : label}: ${state}${ability.tool ? ` (${ability.tool})` : ""}. ${ability.note}`,
      );
    }
    lines.push(`${row.label} — ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

/** The answer to "can you read or make X", from the registry; null when the message is not that question. */
export function answerFormatQuestion(text: string, hinglish = false): string | null {
  const want = asksAboutFormats(text);
  if (!want) return null;
  const rows = findFormats(text).slice(0, 4);
  return describeFormats(rows, want, hinglish);
}

/** Every kind she has any gap for, so the brain can say plainly what is missing. */
export function formatGaps(): { id: string; label: string; side: "read" | "make"; note: string }[] {
  const out: { id: string; label: string; side: "read" | "make"; note: string }[] = [];
  for (const row of FORMAT_ROWS) {
    for (const side of ["read", "make"] as const) {
      const ability = row[side];
      if (ability.status === "partial" || ability.status === "not-built") {
        out.push({ id: row.id, label: row.label, side, note: ability.note });
      }
    }
  }
  return out;
}
