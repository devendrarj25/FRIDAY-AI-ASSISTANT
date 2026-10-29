/**
 * FRIDAY · local mind
 *
 * The model is a teacher, not the memory. A verified stable answer is packed
 * into a small card on this PC. The next matching ask is answered from that
 * card, so the model stays idle and those characters are not sent again.
 *
 * Adapted from the public methods that fit this desk: keep durable knowledge
 * outside the context window (MemGPT / Letta), compact older talk instead of
 * resending it (Anthropic compaction), and retrieve only when the line earns
 * a place (Self-RAG). A card never changes permissions, never runs a tool,
 * and is not applied as policy. Live, private, creative, and machine-changing
 * asks always stay with the existing model path.
 */

import { readLocalState, writeState } from "../persist";

export type LocalCard = {
  id: string;
  key: string;
  question: string;
  answer: string;
  confidence: number;
  uses: number;
  learnedAt: number;
  teacher: "model";
  appliedToPolicy: false;
};

export type LocalMindDecision = {
  skipModel: boolean;
  reply: string | null;
  reason: string;
  confidence: number;
  cardId: string | null;
  appliedToPolicy: false;
  omittedChars: number;
};

export type LocalGrowth = {
  localAnswers: number;
  modelTurns: number;
  charsKeptOffModel: number;
  cards: number;
};

const STORAGE_KEY = "friday.local-mind.v1";
const MAX_CARDS = 64;
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "you",
  "your",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "about",
  "into",
  "onto",
  "than",
  "then",
  "them",
  "they",
  "its",
  "it's",
  "not",
  "but",
  "just",
  "only",
]);

let seq = 0;
let hydrated = false;
let cards: LocalCard[] = [];
let localAnswers = 0;
let modelTurns = 0;
let charsKeptOffModel = 0;

const nextId = () => `local-${(seq += 1).toString(36)}`;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clip(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

function keyOf(text: string): string {
  return terms(text).join(" ");
}

function overlap(
  left: string[],
  right: string[],
): { coverage: number; jaccard: number; shared: number } {
  if (!left.length || !right.length) return { coverage: 0, jaccard: 0, shared: 0 };
  const rightSet = new Set(right);
  const sharedList = left.filter((word) => rightSet.has(word));
  const union = new Set([...left, ...right]).size;
  return {
    coverage: sharedList.length / left.length,
    jaccard: union ? sharedList.length / union : 0,
    shared: sharedList.length,
  };
}

type Snapshot = {
  cards: LocalCard[];
  localAnswers: number;
  modelTurns: number;
  charsKeptOffModel: number;
};

function persist(): void {
  const snapshot: Snapshot = { cards, localAnswers, modelTurns, charsKeptOffModel };
  try {
    writeState(STORAGE_KEY, snapshot);
  } catch {
    /* desktop persistence is best-effort; the in-memory cards still stand */
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const saved = readLocalState<Snapshot>(STORAGE_KEY);
  if (!saved || !Array.isArray(saved.cards)) return;
  cards = saved.cards.slice(0, MAX_CARDS);
  localAnswers = saved.localAnswers || 0;
  modelTurns = saved.modelTurns || 0;
  charsKeptOffModel = saved.charsKeptOffModel || 0;
}

export function resetLocalMind(): void {
  hydrated = true;
  seq = 0;
  cards = [];
  localAnswers = 0;
  modelTurns = 0;
  charsKeptOffModel = 0;
}

export function localMindGrowth(): LocalGrowth {
  hydrate();
  return {
    localAnswers,
    modelTurns,
    charsKeptOffModel,
    cards: cards.length,
  };
}

/**
 * Older turns stay on this PC. The returned packet is the only history a
 * model should see: a short earlier line plus the last four turns.
 */
export function packHistory(
  turns: { role: string; text: string }[],
  budget = 900,
): { packet: string; omittedChars: number } {
  const older = turns.slice(0, Math.max(0, turns.length - 4));
  const recent = turns.slice(-4);
  const omittedChars = older.reduce((sum, turn) => sum + turn.text.length, 0);
  const summary = older
    .slice(-6)
    .map((turn) => `${turn.role}: ${clip(turn.text, 80)}`)
    .join(" | ");
  const lines = [
    summary ? `Earlier, still stored on this PC: ${summary}` : "",
    ...recent.map((turn) => `${turn.role}: ${clip(turn.text, 220)}`),
  ].filter(Boolean);
  let packet = lines.join("\n");
  if (packet.length > budget) packet = packet.slice(packet.length - budget);
  return { packet, omittedChars };
}

/** Keep the first lines that fit. Later lines stay in memory and are not sent. */
export function boundLines(
  lines: string[],
  budgetChars: number,
): { lines: string[]; omittedChars: number } {
  const kept: string[] = [];
  let used = 0;
  let omittedChars = 0;
  for (const line of lines) {
    const next = line.length + 1;
    if (kept.length && used + next > budgetChars) {
      omittedChars += line.length;
      continue;
    }
    kept.push(line);
    used += next;
  }
  return { lines: kept, omittedChars };
}

export function distillLocalAnswer(input: {
  prompt: string;
  answer: string;
  blocked?: boolean;
  sensitive?: boolean;
  now?: number;
}): { stored: boolean; reinforced: boolean; card: LocalCard | null; reason: string } {
  hydrate();
  const question = clip(input.prompt, 180);
  const answer = clip(input.answer, 700);
  if (input.sensitive) {
    return { stored: false, reinforced: false, card: null, reason: "sensitive text is not stored" };
  }
  if (input.blocked) {
    return {
      stored: false,
      reinforced: false,
      card: null,
      reason: "live, creative, or machine-changing answers are not reused",
    };
  }
  if (question.length < 12 || answer.length < 40) {
    return { stored: false, reinforced: false, card: null, reason: "too small to reuse" };
  }
  if (/\b(could not|cannot|don't know|do not know|unverified)\b/i.test(answer)) {
    return {
      stored: false,
      reinforced: false,
      card: null,
      reason: "an uncertain answer is not stored",
    };
  }
  const key = keyOf(question);
  if (!key) {
    return { stored: false, reinforced: false, card: null, reason: "no stable terms" };
  }
  const existing = cards.find((card) => card.key === key);
  if (existing) {
    existing.answer = answer;
    existing.confidence = clamp(existing.confidence + 0.04);
    existing.learnedAt = input.now ?? existing.learnedAt;
    persist();
    return {
      stored: false,
      reinforced: true,
      card: existing,
      reason: "the same lesson was reinforced",
    };
  }
  const card: LocalCard = {
    id: nextId(),
    key,
    question,
    answer,
    confidence: 0.72,
    uses: 0,
    learnedAt: input.now ?? 0,
    teacher: "model",
    appliedToPolicy: false,
  };
  cards.push(card);
  while (cards.length > MAX_CARDS) {
    cards.sort((a, b) => a.uses - b.uses || a.learnedAt - b.learnedAt);
    cards.shift();
  }
  persist();
  return { stored: true, reinforced: false, card, reason: "learned from the model for next time" };
}

export function consultLocalMind(input: {
  prompt: string;
  blocked?: boolean;
  sensitive?: boolean;
  history?: { role: string; text: string }[];
}): LocalMindDecision {
  hydrate();
  const history = packHistory(input.history ?? []);
  const empty: LocalMindDecision = {
    skipModel: false,
    reply: null,
    reason: "no saved answer yet",
    confidence: 0,
    cardId: null,
    appliedToPolicy: false,
    omittedChars: history.omittedChars,
  };
  if (input.sensitive) return { ...empty, reason: "sensitive text is not reused" };
  if (input.blocked) return { ...empty, reason: "this turn stays with the model" };
  const asked = terms(input.prompt);
  let best: { card: LocalCard; coverage: number; jaccard: number; shared: number } | null = null;
  for (const card of cards) {
    const score = overlap(asked, terms(card.question));
    if (!best || score.jaccard > best.jaccard) best = { card, ...score };
  }
  if (
    !best ||
    best.coverage < 0.8 ||
    best.jaccard < 0.55 ||
    best.shared < 2 ||
    best.card.confidence < 0.62
  ) {
    return best ? { ...empty, reason: "saved answers do not cover this ask" } : empty;
  }
  return {
    skipModel: true,
    reply: best.card.answer,
    reason: "saved answer covers this ask",
    confidence: best.card.confidence,
    cardId: best.card.id,
    appliedToPolicy: false,
    omittedChars: history.omittedChars,
  };
}

/** Count one local answer after the desk actually uses it. */
export function commitLocalAnswer(cardId: string, chars: number): void {
  hydrate();
  const card = cards.find((row) => row.id === cardId);
  if (card) {
    card.uses += 1;
    card.confidence = clamp(card.confidence + 0.02);
  }
  localAnswers += 1;
  charsKeptOffModel += Math.max(0, Math.floor(chars));
  persist();
}

export function noteModelTurn(): void {
  hydrate();
  modelTurns += 1;
  persist();
}
