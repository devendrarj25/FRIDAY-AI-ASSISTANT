/**
 * FRIDAY · knowledge ingestion
 *
 * SOURCE → INGEST → PARSE → EXTRACT → VERIFY → LINK ENTITIES → UPDATE
 * KNOWLEDGE → MARK FRESHNESS
 *
 * Consumes text already produced by conversation, docs.extract, or web.read.
 * Does not add a document parser or HTTP client. Sensitive text is refused
 * by the same `looksSensitive` check as memory — no learning bypass.
 */

import { brainKnowledge, type BrainEntry } from "./knowledge-base";
import { claimIngestFingerprint } from "./memory-fabric";
import { looksSensitive } from "./memory-policy";

export type IngestSourceKind = "conversation" | "document" | "web" | "file";

export type IngestStageId =
  "source" | "ingest" | "parse" | "extract" | "verify" | "link" | "update" | "freshness";

export type IngestResult = {
  stages: { id: IngestStageId; detail: string }[];
  entries: BrainEntry[];
  skipped: string | null;
};

const RELATION =
  /\b([A-Za-z][\w./:-]{1,48})\s+(depends on|depends-on|contains|owned by|owned-by|works on|works-on|changed by|changed-by|prefers|requires|never|is a|is-a|uses|caused|caused-by|located in|part of|has|enables|prevents|replaces)\s+([A-Za-z][\w./:-]{1,48})\b/gi;

const PREDICATE: Record<string, string> = {
  "depends on": "depends-on",
  "depends-on": "depends-on",
  contains: "contains",
  "owned by": "owned-by",
  "owned-by": "owned-by",
  "works on": "works-on",
  "works-on": "works-on",
  "changed by": "changed-by",
  "changed-by": "changed-by",
  prefers: "prefers",
  requires: "requires",
  never: "never",
  "is a": "is-a",
  "is-a": "is-a",
  uses: "uses",
  caused: "caused-by",
  "caused-by": "caused-by",
  "located in": "located-in",
  "part of": "part-of",
  has: "has",
  enables: "enables",
  prevents: "prevents",
  replaces: "replaces",
};

const STOP_ENTITY = new Set(["the", "this", "that", "these", "those", "a", "an", "it", "its"]);

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export type ExtractedClaim = {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: number;
  validUntil?: number;
};

function stamp(year: string, monthName?: string, end = false): number {
  const month = monthName ? (MONTH_INDEX[monthName.toLowerCase()] ?? 0) : end ? 11 : 0;
  const day = end ? 31 : 1;
  return Date.UTC(Number(year), month, day);
}

/** Temporal and preference sentences the relation regex does not cover. */
export function extractClaims(text: string): ExtractedClaim[] {
  const found: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const push = (claim: ExtractedClaim) => {
    const subject = normalizeEntity(claim.subject);
    const object = normalizeEntity(claim.object);
    if (!subject || !object || STOP_ENTITY.has(subject.toLowerCase())) return;
    const key = `${subject.toLowerCase()}|${claim.predicate}|${object.toLowerCase()}|${claim.validFrom ?? ""}|${claim.validUntil ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const row: ExtractedClaim = { subject, predicate: claim.predicate, object };
    if (claim.validFrom !== undefined) row.validFrom = claim.validFrom;
    if (claim.validUntil !== undefined) row.validUntil = claim.validUntil;
    found.push(row);
  };
  const since =
    /\b([A-Za-z][\w.-]{1,48})\s+has preferred\s+([A-Za-z][\w.-]{1,48})\s+since\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{4})\b/gi;
  const until =
    /\b([A-Za-z][\w.-]{1,48})\s+preferred\s+([A-Za-z][\w.-]{1,48})\s+until\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{4})\b/gi;
  const span =
    /\b([A-Za-z][\w.-]{1,48})\s+used\s+([A-Za-z][\w.-]{1,48})\s+from\s+(\d{4})\s+to\s+(\d{4})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = since.exec(text))) {
    push({
      subject: match[1] ?? "",
      predicate: "prefers",
      object: match[2] ?? "",
      validFrom: stamp(match[4] ?? "0", match[3]),
    });
  }
  while ((match = until.exec(text))) {
    push({
      subject: match[1] ?? "",
      predicate: "prefers",
      object: match[2] ?? "",
      validUntil: stamp(match[4] ?? "0", match[3], true),
    });
  }
  while ((match = span.exec(text))) {
    push({
      subject: match[1] ?? "",
      predicate: "uses",
      object: match[2] ?? "",
      validFrom: stamp(match[3] ?? "0"),
      validUntil: stamp(match[4] ?? "0", undefined, true),
    });
  }
  return found;
}

function hashUnit(text: string): string {
  let hash = 5381;
  const value = text.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

/** Sentence windows stored as notes on the same knowledge base. */
export function splitTextUnits(text: string): { hash: string; text: string }[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);
  const seen = new Set<string>();
  const units: { hash: string; text: string }[] = [];
  for (const part of parts) {
    const hash = hashUnit(part);
    if (seen.has(hash)) continue;
    seen.add(hash);
    units.push({ hash, text: part.slice(0, 500) });
  }
  return units.slice(0, 12);
}

function normalizeEntity(value: string): string {
  const trimmed = value.trim();
  if (/^friday$/i.test(trimmed)) return "FRIDAY";
  return trimmed;
}

function extractRelations(text: string): { subject: string; predicate: string; object: string }[] {
  const found: { subject: string; predicate: string; object: string }[] = [];
  const seen = new Set<string>();
  const push = (subject: string, predicate: string, object: string) => {
    const sub = normalizeEntity(subject);
    const obj = normalizeEntity(object);
    if (STOP_ENTITY.has(sub.toLowerCase()) || STOP_ENTITY.has(obj.toLowerCase())) return;
    if (!sub || !predicate || !obj) return;
    const key = `${sub.toLowerCase()}|${predicate}|${obj.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ subject: sub, predicate, object: obj });
  };
  RELATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATION.exec(text))) {
    const predicate = PREDICATE[String(match[2] || "").toLowerCase()];
    if (predicate) push(String(match[1] || ""), predicate, String(match[3] || ""));
  }
  const isPattern = /\b([A-Za-z][\w./-]{1,40})\s+is\s+(?:an?\s+)?([A-Za-z][\w./-]{1,40})\b/gi;
  while ((match = isPattern.exec(text))) {
    push(String(match[1] || ""), "is-a", String(match[2] || ""));
  }
  const becausePattern = /\b([A-Za-z][\w./-]{1,40})\s+failed because\s+([A-Za-z][\w./-]{1,40})\b/gi;
  while ((match = becausePattern.exec(text))) {
    push(String(match[1] || ""), "caused-by", String(match[2] || ""));
  }
  const belongsPattern = /\b([A-Za-z][\w./-]{1,40})\s+belongs to\s+([A-Za-z][\w./-]{1,40})\b/gi;
  while ((match = belongsPattern.exec(text))) {
    push(String(match[1] || ""), "part-of", String(match[2] || ""));
  }
  const enablesPattern = /\b([A-Za-z][\w./-]{1,40})\s+enables\s+([A-Za-z][\w./-]{1,40})\b/gi;
  while ((match = enablesPattern.exec(text))) {
    push(String(match[1] || ""), "enables", String(match[2] || ""));
  }
  return found;
}

export function ingestKnowledge(input: {
  text: string;
  source: string;
  kind: IngestSourceKind;
}): IngestResult {
  const stages: IngestResult["stages"] = [];
  const text = String(input.text || "").trim();
  stages.push({ id: "source", detail: `${input.kind} via ${input.source}` });
  stages.push({ id: "ingest", detail: `${text.length} character(s)` });

  if (!text) {
    stages.push({ id: "parse", detail: "empty" });
    return { stages, entries: [], skipped: "empty text" };
  }
  if (looksSensitive(text)) {
    stages.push({ id: "parse", detail: "refused" });
    return { stages, entries: [], skipped: "sensitive text is never ingested for learning" };
  }
  if (!claimIngestFingerprint(input.source, text)) {
    stages.push({ id: "parse", detail: "replay of an identical source" });
    return { stages, entries: [], skipped: "duplicate source replay" };
  }

  stages.push({ id: "parse", detail: "plain text split into sentence units" });
  const relations = extractRelations(text);
  const claims = extractClaims(text);
  const units = splitTextUnits(text);
  stages.push({
    id: "extract",
    detail: `${relations.length} relation(s), ${claims.length} claim(s), ${units.length} unit(s)`,
  });

  if (!relations.length && !claims.length) {
    stages.push({ id: "verify", detail: "nothing structured to verify" });
    return { stages, entries: [], skipped: "no entity/relation sentences found" };
  }

  const verified = relations.filter((rel) => rel.subject.length > 1 && rel.object.length > 1);
  const keptClaims = claims.filter((claim) => claim.subject.length > 1 && claim.object.length > 1);
  stages.push({
    id: "verify",
    detail: `${verified.length}/${relations.length} relations and ${keptClaims.length} claim(s) kept`,
  });
  stages.push({
    id: "link",
    detail: `linking ${verified.length} SPO triple(s) and ${units.length} text unit(s) on the Brain store`,
  });

  const entries: BrainEntry[] = [];
  const provenance = "observed" as const;
  const confidence = input.kind === "web" ? 0.55 : 0.7;
  for (const rel of verified) {
    const entry = brainKnowledge.assertBelief({
      subject: rel.subject,
      predicate: rel.predicate,
      object: rel.object,
      source: input.source,
      provenance,
      confidence,
      shape: "relation",
    });
    entries.push(entry);
  }
  for (const claim of keptClaims) {
    const entry = brainKnowledge.assertBelief({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      source: input.source,
      provenance,
      confidence,
      shape: "fact",
      ...(claim.validFrom !== undefined ? { validFrom: claim.validFrom } : {}),
      ...(claim.validUntil !== undefined ? { validUntil: claim.validUntil } : {}),
    });
    entries.push(entry);
  }
  for (const unit of units) {
    const hay = unit.text.toLowerCase();
    const matched = keptClaims.filter(
      (claim) =>
        hay.includes(claim.object.toLowerCase()) || hay.includes(claim.subject.toLowerCase()),
    );
    const validFrom = matched.find((claim) => claim.validFrom !== undefined)?.validFrom;
    const validUntil = matched
      .map((claim) => claim.validUntil)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b)[0];
    const entry = brainKnowledge.remember({
      kind: "knowledge",
      title: `unit ${unit.hash}`.slice(0, 120),
      body: unit.text,
      tags: ["text-unit", unit.hash],
      source: input.source,
      provenance,
      confidence: Math.min(confidence, 0.6),
      shape: "note",
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validUntil !== undefined ? { validUntil } : {}),
    });
    entries.push(entry);
  }
  stages.push({ id: "update", detail: `${entries.length} belief(s) written` });
  stages.push({
    id: "freshness",
    detail: entries[0]?.freshnessAt
      ? `freshnessAt ${entries[0].freshnessAt}`
      : "freshness stamped by assertBelief",
  });
  return { stages, entries, skipped: null };
}
