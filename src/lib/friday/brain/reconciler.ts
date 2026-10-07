/**
 * FRIDAY · multi-model reconciliation
 *
 * When more than one engine answers the same turn, something has to decide
 * which answer FRIDAY actually gives — and make sure the answer sounds like
 * FRIDAY rather than like whichever model produced it.
 *
 * Pure functions only. No model calls, no state, no side effects, so this is
 * safe to use from the brain, from tests and from the sandbox.
 */

/** The identity contract every engine runs under. Shared with the Core Brain. */
export const IDENTITY_DIRECTIVE =
  "You are FRIDAY. The model answering is one of your engines, not your identity. Never introduce yourself as the model, never mention which model or provider you are, and never claim an action you did not perform. Ask the owner before anything that changes files, apps or system state.";

export type ModelAnswer = {
  modelId: string;
  text: string;
  ok: boolean;
  ms?: number;
  error?: string;
};

export type Reconciliation = {
  /** The answer FRIDAY gives, already scrubbed of foreign identity. */
  answer: string;
  /** Model that produced the winning answer, or null when none succeeded. */
  winner: string | null;
  /** Models that produced a usable answer but were not chosen. */
  runnersUp: string[];
  /** Human-readable disagreements found between engines. */
  conflicts: string[];
  /** 0..1 agreement between the usable answers. */
  agreement: number;
  detail: string;
};

/** Phrases where an engine speaks as itself instead of as FRIDAY. */
const FOREIGN_IDENTITY =
  /\b(i am|i'?m|this is)\s+(chatgpt|gpt[- ]?\d[\w.-]*|openai|claude|anthropic|gemini|bard|google (?:ai|deepmind)|llama\d?|meta ai|mistral|qwen|deepseek|copilot|an ai (?:language )?model|a large language model)\b[^.!?\n]*[.!?]?/gi;
const MODEL_DISCLAIMER =
  /\b(as an ai (?:language )?model|as a large language model)\b[^.!?\n]*[.!?]?/gi;
const TRAINED_BY =
  /\b(trained|developed|created|made|built)\s+by\s+(openai|anthropic|google|meta|mistral ai|alibaba|deepseek)\b[^.!?\n]*[.!?]?/gi;

/**
 * Removes an engine's own identity from an answer so FRIDAY's persona stays
 * the only voice. The content of the answer is left untouched.
 */
export function enforceIdentity(text: string): string {
  return (text ?? "")
    .replace(FOREIGN_IDENTITY, "")
    .replace(MODEL_DISCLAIMER, "")
    .replace(TRAINED_BY, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+/gm, (match) => match)
    .trim();
}

/** True when the answer still claims to be some other assistant. */
export function leaksForeignIdentity(text: string): boolean {
  FOREIGN_IDENTITY.lastIndex = 0;
  MODEL_DISCLAIMER.lastIndex = 0;
  return FOREIGN_IDENTITY.test(text ?? "") || MODEL_DISCLAIMER.test(text ?? "");
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "that",
  "this",
  "it",
  "as",
  "at",
  "by",
  "be",
  "you",
  "your",
  "i",
]);

function terms(text: string): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s.-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

/** Jaccard overlap between two answers, 0..1. */
export function similarity(a: string, b: string): number {
  const left = terms(a);
  const right = terms(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Numbers and yes/no verdicts are where engines disagree in ways that matter. */
function factsOf(text: string): string[] {
  const numbers = (text.match(/\b\d+(?:[.,]\d+)*\s?(?:%|kb|mb|gb|tb|ms|s|x)?\b/gi) ?? []).map((n) =>
    n.trim().toLowerCase(),
  );
  return [...new Set(numbers)].slice(0, 12);
}

/**
 * Picks FRIDAY's answer from every engine that replied.
 *
 * Ranking is deliberately simple and honest: a failed run never wins, longer
 * substantive answers beat stubs, an answer that agrees with the other engines
 * beats an outlier, and a `score` supplied by the caller (the Core Brain's own
 * verification) outranks all of it.
 */
export function reconcile(
  answers: ModelAnswer[],
  options: { scores?: Record<string, number>; requireSources?: boolean } = {},
): Reconciliation {
  const usable = answers.filter((a) => a.ok && (a.text ?? "").trim().length > 2);
  if (!usable.length) {
    const failure = answers.find((a) => a.error)?.error;
    return {
      answer: "",
      winner: null,
      runnersUp: [],
      conflicts: [],
      agreement: 0,
      detail: failure ? `no engine produced an answer: ${failure}` : "no engine produced an answer",
    };
  }

  const scores = options.scores ?? {};
  const rank = (answer: ModelAnswer) => {
    const text = answer.text.trim();
    let value = scores[answer.modelId] ?? 0;
    value += Math.min(text.length, 1600) / 4000; // substance, capped
    if (options.requireSources && /https?:\/\//i.test(text)) value += 0.25;
    if (leaksForeignIdentity(text)) value -= 0.3;
    // Agreement with the other engines — an outlier is likelier to be wrong.
    const others = usable.filter((other) => other.modelId !== answer.modelId);
    if (others.length) {
      const mean =
        others.reduce((sum, other) => sum + similarity(text, other.text), 0) / others.length;
      value += mean * 0.4;
    }
    return value;
  };

  const ordered = [...usable].sort((a, b) => rank(b) - rank(a));
  const winner = ordered[0]!;
  const runnersUp = ordered.slice(1).map((a) => a.modelId);

  // Agreement across every pair, and the concrete disagreements worth showing.
  const conflicts: string[] = [];
  let pairs = 0;
  let total = 0;
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const left = usable[i]!;
      const right = usable[j]!;
      total += similarity(left.text, right.text);
      pairs += 1;
      const leftFacts = factsOf(left.text);
      const rightFacts = factsOf(right.text);
      const diverged = leftFacts.filter((fact) => rightFacts.length && !rightFacts.includes(fact));
      if (diverged.length && rightFacts.length) {
        conflicts.push(
          `${left.modelId} and ${right.modelId} disagree on ${diverged.slice(0, 3).join(", ")}`,
        );
      }
    }
  }
  const agreement = pairs ? total / pairs : 1;
  if (pairs && agreement < 0.2) {
    conflicts.push(
      `engines gave substantially different answers (${Math.round(agreement * 100)}% overlap)`,
    );
  }

  const answer = enforceIdentity(winner.text);
  const detail = [
    `${usable.length} engine(s) answered`,
    `chose ${winner.modelId}`,
    pairs ? `${Math.round(agreement * 100)}% agreement` : "single answer",
    conflicts.length ? `${conflicts.length} conflict(s) noted` : "no conflicts",
  ].join(" · ");

  return { answer, winner: winner.modelId, runnersUp, conflicts, agreement, detail };
}
