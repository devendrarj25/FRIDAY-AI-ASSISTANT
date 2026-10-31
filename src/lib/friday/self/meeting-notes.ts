/**
 * FRIDAY · meeting and lecture notes from a transcript
 *
 * The transcript (from the speech model on this PC, or pasted) is turned into what a person wants afterwards:
 * the decisions, the action items with who and by when, and the questions nobody answered. It is rules, not a
 * model, so it works offline and never invents a name or a date: an owner or a deadline appears only when the
 * words say one. English and Hinglish are both read. The transcript is data: a line that reads as an order to an
 * AI is cut out by the quarantined reader before anything is kept, and nothing here runs or sends anything.
 */

import { quarantine } from "../brain/quarantined-reader";
import { deadlineToDueAt, extractDeadline } from "./horizon-goals";

export type ActionItem = { what: string; who?: string; due?: string; dueAt?: number };
export type MeetingNotes = {
  decisions: string[];
  actions: ActionItem[];
  questions: string[];
  speakers: string[];
  removed: number;
};

const DECISION =
  /\b(we (have )?decided|decided to|it'?s decided|agreed (to|that|on)|we agreed|final decision|approved|going with|let'?s go with|tay hua|tay kiya|decide hua|fix hua|final hua|finalise|finalize)\b/i;

const ACTION_EN =
  /\b(will|i'?ll|we'?ll|shall|needs? to|has to|have to|should|must|action item|to-?do|follow up|please (send|share|check|prepare|review|update|book|call)|can you|could you)\b/i;
const ACTION_HI =
  /\b(karna (hai|hoga|padega)|karega|karegi|karenge|kar (dena|do|lena|dunga|dungi|denge)|bhej (dena|do|dunga|dungi)|bhejna|dekhna (hai|hoga)|dekh lena|batana|bata dena|chahiye|zaroor|zaroori)\b/i;

const HI_DAYS: [RegExp, string][] = [
  [/\bsomvar\b|\bsomwar\b/i, "monday"],
  [/\bmangalvar\b|\bmangalwar\b/i, "tuesday"],
  [/\bbudhvar\b|\bbudhwar\b/i, "wednesday"],
  [/\bguruvar\b|\bguruwar\b|\bbrihaspativar\b/i, "thursday"],
  [/\bshukravar\b|\bshukrawar\b/i, "friday"],
  [/\bshanivar\b|\bshaniwar\b/i, "saturday"],
  [/\bravivar\b|\braviwar\b/i, "sunday"],
];

/** A deadline phrase in English or Hinglish as the English phrase the date reader understands. */
export function deadlinePhrase(text: string): string | undefined {
  const english = extractDeadline(text);
  if (english) return english;
  const low = text.toLowerCase();
  if (/\bkal tak\b|\bkal (se pehle|ya parso)\b|\bkal\b.*\b(tak|bhej|karna|karo|dena)\b/.test(low))
    return "by tomorrow";
  for (const [pattern, day] of HI_DAYS) if (pattern.test(low)) return `by ${day}`;
  if (/\baaj (shaam|raat)? ?tak\b|\bshaam tak\b|\baaj tak\b/.test(low)) return "by eod";
  return undefined;
}

const NAME = /^([A-Z][a-z]{1,15})\b/;

function sentences(text: string): { speaker?: string; line: string }[] {
  const out: { speaker?: string; line: string }[] = [];
  for (const raw of text.split(/\r?\n+/)) {
    const m = /^\s*(?:\[[^\]]*\]\s*)?([A-Z][\w .'-]{0,24}):\s+(.*)$/.exec(raw);
    const speaker = m?.[1]?.trim();
    const body = (m ? m[2] : raw) ?? "";
    for (const part of body.split(/(?<=[.!?।])\s+/)) {
      const line = part.trim();
      if (line.length >= 6) out.push({ ...(speaker ? { speaker } : {}), line });
    }
  }
  return out;
}

const clip = (text: string, n = 200) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function whoFor(line: string, speaker: string | undefined): string | undefined {
  if (/\b(i'?ll|i will|main (kar|bhej|dekh)\w*|mai (kar|bhej|dekh)\w*)\b/i.test(line))
    return speaker;
  const named =
    /\b([A-Z][a-z]{1,15})\s+(will|should|needs to|has to|karega|karegi|bhejega|bhejegi|dekhega|dekhegi)\b/.exec(
      line,
    );
  if (named) return named[1];
  const lead = NAME.exec(line);
  if (
    lead &&
    /\b(ko|please|can you|could you)\b/i.test(line) &&
    !/^(The|This|That|We|And|But|So|Please|Can|Could)$/.test(lead[1]!)
  ) {
    return lead[1];
  }
  return undefined;
}

export function makeNotes(transcript: string, now = Date.now()): MeetingNotes {
  const cleaned = quarantine(String(transcript || ""));
  // The reader works on a whole text; speaker lines survive because only order-like sentences are cut.
  const rows = sentences(String(transcript || "")).filter(
    (row) => quarantine(row.line).removed === 0,
  );
  const decisions: string[] = [];
  const actions: ActionItem[] = [];
  const questions: string[] = [];
  const speakers = new Set<string>();
  for (const { speaker, line } of rows) {
    if (speaker) speakers.add(speaker);
    if (DECISION.test(line)) {
      decisions.push(clip(line));
      continue;
    }
    if (ACTION_EN.test(line) || ACTION_HI.test(line)) {
      const phrase = deadlinePhrase(line);
      const due = phrase ? deadlineToDueAt(phrase, now) : null;
      const who = whoFor(line, speaker);
      actions.push({
        what: clip(line),
        ...(who ? { who } : {}),
        ...(phrase ? { due: phrase } : {}),
        ...(due ? { dueAt: due } : {}),
      });
      continue;
    }
    if (line.endsWith("?") && line.length > 12) questions.push(clip(line));
  }
  return {
    decisions: decisions.slice(0, 12),
    actions: actions.slice(0, 20),
    questions: questions.slice(0, 8),
    speakers: [...speakers].slice(0, 12),
    removed: cleaned.removed,
  };
}

export function notesToMarkdown(notes: MeetingNotes, title = "Meeting notes"): string {
  const out = [`# ${title}`];
  if (notes.speakers.length) out.push(`\nPeople: ${notes.speakers.join(", ")}`);
  const section = (head: string, lines: string[]) => {
    out.push(`\n## ${head}`);
    out.push(lines.length ? lines.join("\n") : "Nothing found.");
  };
  section(
    "Decisions",
    notes.decisions.map((line) => `- ${line}`),
  );
  section(
    "Action items",
    notes.actions.map(
      (item) =>
        `- ${item.what}${item.who ? ` (${item.who})` : ""}${item.due ? ` — ${item.due}` : ""}`,
    ),
  );
  section(
    "Open questions",
    notes.questions.map((line) => `- ${line}`),
  );
  if (notes.removed)
    out.push(`\n_${notes.removed} line(s) that read as orders to an AI were left out._`);
  return out.join("\n");
}
