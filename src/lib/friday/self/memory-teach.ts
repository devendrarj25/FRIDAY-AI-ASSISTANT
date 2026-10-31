/**
 * Memory console teach / search helpers.
 *
 * Teach on the Memory page writes the six-tier store (and the Brain session
 * overlay). Search uses the same ranker Core Brain retrieve uses — not a
 * second engine. Short queries that have no retrieval terms fall back to
 * substring so the listing does not dump the whole store.
 */

import { admitMemory } from "../brain/memory-fabric";
import type { MemoryLayer } from "../brain-catalog";
import { retrievalTerms } from "../brain/retrieval";
import { memory, type MemoryKind, type MemoryTier, type MemoryItem } from "./memory-engine";

export function layerToTier(layer: MemoryLayer): MemoryTier {
  if (layer === "long-term") return "permanent";
  if (layer === "project" || layer === "knowledge") return "semantic";
  return "working";
}

export function kindForLayer(layer: MemoryLayer): MemoryKind {
  if (layer === "long-term") return "preference";
  if (layer === "project") return "project";
  if (layer === "knowledge") return "semantic";
  return "working";
}

export function tierToLayer(tier: MemoryTier, kind?: MemoryKind): MemoryLayer {
  if (tier === "permanent") return "long-term";
  if (kind === "project") return "project";
  if (tier === "semantic") return "knowledge";
  return "conversation";
}

/** Durable six-tier write from the Memory page Teach form. */
export function teachDurable(layer: MemoryLayer, title: string, text: string): MemoryItem {
  // The owner wrote this himself, so it is verified; admission still refuses a replay, a poisoned or empty row
  // and names why, and a repeat of the same words returns the record already there.
  const out = admitMemory({
    title,
    text,
    source: "teach",
    tier: layerToTier(layer),
    kind: kindForLayer(layer),
    verified: true,
  });
  if (!out.item) {
    // The "is this worth keeping" heuristic is for things FRIDAY picked up herself. A short line the owner typed
    // into the Teach form is kept as he asked. Everything else admission refuses (credential-like text, a
    // poisoned row, paused memory) stays refused, with its reason.
    if (/working context only/i.test(out.reason)) {
      return memory.remember({
        tier: layerToTier(layer),
        title,
        text,
        source: "teach",
        pinned: layer === "long-term",
        kind: kindForLayer(layer),
        confidence: 0.9,
        verified: true,
      });
    }
    throw new Error(out.reason || "that was not kept");
  }
  if (layer === "long-term" && !out.item.pinned) memory.update(out.item.id, { pinned: true });
  return memory.getSnapshot().items.find((item) => item.id === out.item?.id) ?? out.item;
}

/** In-place edit of an existing six-tier row. */
export function reviseDurable(id: string, title: string, text: string): MemoryItem | null {
  const existing = memory.getSnapshot().items.find((item) => item.id === id);
  if (!existing) return null;
  memory.update(id, { title, text, verified: true });
  return memory.getSnapshot().items.find((item) => item.id === id) ?? null;
}

/** Ranked six-tier listing for the console. Empty query returns the live list. */
export function searchDurable(
  query: string,
  items: MemoryItem[],
  tier: MemoryTier | "all",
  k = 80,
): MemoryItem[] {
  const pool = tier === "all" ? items : items.filter((item) => item.tier === tier);
  const trimmed = query.trim();
  if (!trimmed) return pool;
  const needle = trimmed.toLowerCase();
  if (!retrievalTerms(trimmed).length) {
    return pool.filter((item) => `${item.title} ${item.text}`.toLowerCase().includes(needle));
  }
  const ranked = memory.search(trimmed, {
    k,
    ...(tier !== "all" ? { tiers: [tier] } : {}),
  });
  const terms = retrievalTerms(trimmed);
  const matched = ranked.filter((item) => {
    const hay = `${item.title} ${item.text}`.toLowerCase();
    if (hay.includes(needle)) return true;
    const hayTerms = retrievalTerms(`${item.title} ${item.text}`);
    return terms.some((term) => hay.includes(term) || hayTerms.includes(term));
  });
  if (matched.length) return matched;
  return pool.filter((item) => `${item.title} ${item.text}`.toLowerCase().includes(needle));
}
