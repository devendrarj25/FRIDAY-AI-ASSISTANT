/**
 * FRIDAY · memory consolidation
 *
 * One pipeline on the existing memory engine — not a second store.
 *
 *   RAW EVENT → classify → dedupe → extract meaning → check source /
 *   confidence / conflicts → consolidate → promote → archive/decay
 *
 * "Is this worth remembering?" is `considerMemory` in memory-policy.ts.
 */

import { refuseInferredSensitive, resistPoison } from "../brain/memory-fabric";
import { considerMemory } from "../brain/memory-policy";
import { compareBeliefs } from "../brain/retrieval";
import { deriveKnowledgeFromMemory } from "../brain/knowledge-base";
import { notifications } from "../notifications";
import {
  classifyMemoryKind,
  defaultTierForKind,
  memory,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
} from "./memory-engine";

export type MemoryEvent = {
  text: string;
  title?: string;
  source: string;
  context?: string;
  kindHint?: MemoryKind;
  ok?: boolean;
  sourced?: boolean;
  confidence?: number;
  verified?: boolean;
  scope?: MemoryScope;
};

export type ConsolidateResult = {
  kept: boolean;
  item: MemoryItem | null;
  stage: "skip" | "conflict" | "consolidated";
  reason: string;
  kind: MemoryKind | null;
};

/**
 * Run one raw event through the consolidation pipeline.
 * Repeated paraphrases of the same preference converge on one record.
 */
export function consolidateEvent(event: MemoryEvent): ConsolidateResult {
  const text = String(event.text || "").trim();
  const title = (event.title || text).trim().slice(0, 120);
  const verdict = considerMemory({
    text,
    title,
    ...(event.ok !== undefined ? { ok: event.ok } : {}),
    ...(event.sourced !== undefined ? { sourced: event.sourced } : {}),
  });
  if (!verdict.keep) {
    return { kept: false, item: null, stage: "skip", reason: verdict.reason, kind: null };
  }
  if (refuseInferredSensitive(text, event.source) && event.verified !== true) {
    return {
      kept: false,
      item: null,
      stage: "skip",
      reason: "sensitive attributes are not inferred",
      kind: null,
    };
  }

  const kind = classifyMemoryKind(text, event.kindHint);
  const poison = resistPoison({ title, text, source: event.source }, memory.getSnapshot().items);
  if (poison.blocked) {
    return {
      kept: false,
      item: poison.item,
      stage: "conflict",
      reason: poison.reason,
      kind,
    };
  }
  const tier = kind === "preference" ? "permanent" : verdict.tier || defaultTierForKind(kind);

  const item = memory.remember({
    tier,
    title,
    text,
    source: event.source,
    confidence: event.confidence ?? verdict.confidence,
    kind,
    verified: event.verified ?? event.ok === true,
    scope: event.scope ?? "owner",
    tags: [kind],
    ...(event.context ? { context: event.context } : {}),
  });

  if (item.contradiction) {
    const rival = memory
      .getSnapshot()
      .items.find((row) => (item.relatedIds ?? []).includes(row.id));
    const judgment = rival
      ? compareBeliefs(evidenceOf(rival), evidenceOf(item))
      : {
          winner: "ambiguous" as const,
          sufficient: false,
          reason: "both sides stay with provenance; FRIDAY will not invent a resolution",
        };
    if (judgment.sufficient && judgment.winner === "incoming" && rival) {
      memory.supersede(rival.id, item.id);
      return {
        kept: true,
        item,
        stage: "consolidated",
        reason: `${judgment.reason} — older record superseded`,
        kind,
      };
    }
    if (judgment.sufficient && judgment.winner === "existing" && rival) {
      memory.supersede(item.id, rival.id);
      return {
        kept: true,
        item: rival,
        stage: "consolidated",
        reason: `${judgment.reason} — incoming record superseded`,
        kind,
      };
    }
    if (!judgment.sufficient) {
      try {
        notifications.push({
          id: `memory-conflict:${[rival?.id ?? "unknown", item.id].sort().join(":")}`,
          level: "action",
          title: "Conflicting memory — waiting for you",
          detail: rival
            ? `${rival.title}: stored “${rival.text.slice(0, 80)}” vs new “${text.slice(0, 80)}”. ${judgment.reason}`
            : judgment.reason,
          source: "Memory",
        });
      } catch {
        /* notification centre is optional in tests without a window */
      }
    }
    return {
      kept: true,
      item,
      stage: "conflict",
      reason: judgment.sufficient
        ? `${judgment.reason} — both records kept`
        : "disagreeing records kept with provenance; not overwritten",
      kind,
    };
  }

  memory.decayStale();
  if (item.kind === "preference" && item.uses >= 2) {
    try {
      deriveKnowledgeFromMemory(item);
    } catch {
      /* knowledge derivation must never break memory */
    }
  }
  return { kept: true, item, stage: "consolidated", reason: verdict.reason, kind };
}

function evidenceOf(item: MemoryItem) {
  return {
    source: item.source,
    confidence: item.confidence,
    updatedAt: item.updatedAt,
    ...(item.freshnessAt !== undefined ? { freshnessAt: item.freshnessAt } : {}),
    ...(item.verified !== undefined ? { verified: item.verified } : {}),
  };
}
