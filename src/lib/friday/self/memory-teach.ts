/**
 * Memory console teach / search helpers.
 *
 * Teach on the Memory page writes the six-tier store (and the Brain session
 * overlay). Search uses the same ranker Core Brain retrieve uses — not a
 * second engine. Short queries that have no retrieval terms fall back to
 * substring so the listing does not dump the whole store.
 */

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
