/**
 * FRIDAY · structured reasoning
 *
 * Private multi-step reasoning over evidence FRIDAY already has. Models still
 * generate language; this module owns claim kinds so a weak inference is never
 * presented as established fact. Raw chain-of-thought is never returned —
 * callers may only surface `publicNote`.
 *
 * Lives in this file (not `brain/reasoning/`) so the existing stage-name
 * export stays the one source of truth.
 */

import { compareBeliefs, retrievalTerms, termJaccard, type EvidenceRef } from "./retrieval";
import { planNodes } from "../self/task-graph";

export const REASONING_STAGES = [
  "understand",
  "decompose",
  "gather",
  "options",
  "evaluate",
  "decide",
  "execute",
  "verify",
  "reflect",
] as const;

export type ReasoningStage = (typeof REASONING_STAGES)[number];

/** Epistemic status — never collapse these into a single "the answer is". */
export type ClaimKind =
  "fact" | "inference" | "assumption" | "hypothesis" | "uncertainty" | "unknown";

export type ReasoningClaim = {
  id: string;
  kind: ClaimKind;
  text: string;
  support: string[];
  confidence: number;
  contradicted?: boolean;
};

export type ReasoningStageNote = { id: ReasoningStage; detail: string };

export type ReasoningTrace = {
  stages: ReasoningStageNote[];
  claims: ReasoningClaim[];
  alternatives: string[];
  contradictions: string[];
  assumptions: string[];
  conclusions: ReasoningClaim[];
  verified: boolean;
  /** Share of claims that are typed FACT — not a user-facing chain-of-thought. */
  groundedness: number;
  /** Least-to-most subproblems (Zhou et al. 2022). Private — not dumped. */
  subproblems: string[];
  /** Wang et al. 2022 analogue: did conclusion kinds agree. */
  consistency: "agreed" | "split" | "single";
  /** Tree-of-Thoughts-lite: evidence-supported alternative, if any. */
  preferredPath?: string;
  /** Safe to show. Never contains private chain-of-thought. */
  publicNote: string;
};

export type ReasonInput = {
  prompt: string;
  evidence?: string;
  worldSummary?: string;
  metaAction?: string;
  knowledgeHops?: string[];
  contradictions?: string[];
};

const CAUSAL = /\b(why|root cause|because|failed|failure|broke|caused)\b/i;
const WHAT_IF = /\b(what if|if i|counterfactual|instead of|suppose)\b/i;
const TRADE = /\b(vs\.?|versus|trade-?off|rather than|instead of)\b/i;
const CONSTRAINT = /\b(must|must not|never|only if|unless|required|forbidden)\b/i;
const DEPEND = /\b(depend(?:s|ent)?|blocked by|requires|after|before)\b/i;
const CERTAIN = /\b(definitely|certainly|guaranteed|confirmed fact|proved)\b/i;

let seq = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const cache = new Map<string, ReasoningTrace>();
const CACHE_CAP = 24;

function cacheKey(input: ReasonInput): string {
  return [
    input.prompt.trim().slice(0, 240),
    (input.evidence ?? "").slice(0, 160),
    input.worldSummary ?? "",
    input.metaAction ?? "",
    (input.knowledgeHops ?? []).join(">"),
    (input.contradictions ?? []).join("|"),
  ].join("\u0001");
}

export function clearReasoningCache(): void {
  cache.clear();
}

function claim(
  kind: ClaimKind,
  text: string,
  support: string[],
  confidence: number,
  contradicted = false,
): ReasoningClaim {
  const row: ReasoningClaim = {
    id: nextId("cl"),
    kind,
    text: text.slice(0, 280),
    support,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
  if (contradicted) row.contradicted = true;
  return row;
}

function evidenceSnippets(evidence: string): string[] {
  return String(evidence || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 8)
    .slice(0, 8);
}

function supportsSubproblem(text: string, part: string): boolean {
  const partTerms = retrievalTerms(part);
  if (!partTerms.length) return true;
  const hay = new Set(retrievalTerms(text));
  return partTerms.some((term) => hay.has(term));
}

/** Gather easier subproblems' snippets first (Zhou et al. 2022). */
function sortSnippetsLeastToMost(snippets: string[], ordered: string[]): string[] {
  if (ordered.length <= 1) return snippets;
  return [...snippets].sort((a, b) => {
    const indexOf = (line: string) => {
      const found = ordered.findIndex((part) => supportsSubproblem(line, part));
      return found < 0 ? 99 : found;
    };
    return indexOf(a) - indexOf(b);
  });
}

function coverSubproblems(
  ordered: string[],
  snippets: string[],
  claims: ReasoningClaim[],
): ReasoningClaim[] {
  if (ordered.length <= 1) return [];
  const extra: ReasoningClaim[] = [];
  for (const [index, part] of ordered.entries()) {
    const covered =
      snippets.some((line) => supportsSubproblem(line, part)) ||
      claims.some((row) => supportsSubproblem(row.text, part));
    if (!covered) {
      extra.push(
        claim(
          "unknown",
          `Subproblem ${index + 1} has no retrieved evidence yet.`,
          [`subproblem:${index}`],
          0.2,
        ),
      );
    }
  }
  return extra;
}

/** Attach fact claim ids onto inferences that share terms (private support graph). */
function linkSupports(claims: ReasoningClaim[]): void {
  const facts = claims.filter((row) => row.kind === "fact");
  for (const row of claims) {
    if (row.kind !== "inference" && row.kind !== "hypothesis") continue;
    const terms = new Set(retrievalTerms(row.text));
    if (!terms.size) continue;
    for (const fact of facts) {
      if (fact.id === row.id) continue;
      if (retrievalTerms(fact.text).some((term) => terms.has(term))) {
        if (!row.support.includes(fact.id)) row.support.push(fact.id);
      }
    }
  }
}

/** Graph-of-Thoughts-lite: agreeing facts share support (Besta et al. 2024 idea). */
function aggregateAgreeingFacts(claims: ReasoningClaim[]): void {
  const facts = claims.filter((row) => row.kind === "fact" && !row.contradicted);
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const left = facts[i]!;
      const right = facts[j]!;
      const overlap = termJaccard(retrievalTerms(left.text), retrievalTerms(right.text));
      const polarity =
        /\b(not|never|instead)\b/i.test(left.text) !== /\b(not|never|instead)\b/i.test(right.text);
      if (overlap < 0.45 || polarity) continue;
      const keep = left.confidence >= right.confidence ? left : right;
      const drop = keep === left ? right : left;
      for (const id of drop.support) {
        if (!keep.support.includes(id)) keep.support.push(id);
      }
    }
  }
}

/** Tree-of-Thoughts-lite: pick the alternative whose terms appear in evidence. */
function preferredThought(alts: string[], snippets: string[]): string | undefined {
  if (!alts.length) return undefined;
  const hay = new Set(snippets.flatMap((line) => retrievalTerms(line)));
  let best = alts[0];
  let bestScore = -1;
  for (const alt of alts) {
    const score = retrievalTerms(alt).filter((term) => hay.has(term)).length;
    if (score > bestScore) {
      bestScore = score;
      best = alt;
    }
  }
  return best;
}

function criteriaFromPrompt(prompt: string): ReasoningClaim[] {
  const must = String(prompt || "").match(/\bmust\s+(?:include|contain|have|not)\s+([^.,;]+)/i);
  if (!must?.[1]) return [];
  return [
    claim("assumption", `Success criterion: ${must[1].trim().slice(0, 160)}`, ["prompt"], 0.7),
  ];
}

function looksFactualLine(line: string): boolean {
  return (
    /\b(owned-by|is|prefers|requires|verified|source:)\b/i.test(line) ||
    /^from stored knowledge/i.test(line) ||
    /^\[[a-z]+]/i.test(line)
  );
}

/**
 * Split the ask into ordered parts using the existing planner — not a second
 * decomposer. Extra question marks become extra parts only when the planner
 * returned a single blob.
 */
export function decomposePrompt(prompt: string): string[] {
  const planned = planNodes(prompt);
  if (planned.length > 1) return planned.map((step) => step.instruction);
  const text = String(prompt || "").trim();
  if (!text) return [];
  const questions = text
    .split(/\?\s+/)
    .map((part) => part.trim().replace(/\?+$/, ""))
    .filter((part) => part.length > 8);
  if (questions.length > 1) return questions;
  return [text];
}

/**
 * Least-to-most ordering (Zhou et al. 2022): easier identity/status parts
 * before why/how. Does not rewrite the owner's listed steps — only orders
 * already-split parts for gathering evidence.
 */
export function leastToMostOrder(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  const hardness = (part: string): number => {
    let score = Math.min(120, part.length);
    if (/\b(why|root cause|how)\b/i.test(part)) score += 80;
    if (/\b(what if|versus|trade-?off)\b/i.test(part)) score += 40;
    if (/\b(who|what is|where)\b/i.test(part)) score -= 25;
    return score;
  };
  return [...parts].sort((a, b) => hardness(a) - hardness(b));
}

export function publicReasoningNote(
  trace: Pick<ReasoningTrace, "claims" | "verified" | "groundedness">,
): string {
  const counts: Record<ClaimKind, number> = {
    fact: 0,
    inference: 0,
    assumption: 0,
    hypothesis: 0,
    uncertainty: 0,
    unknown: 0,
  };
  for (const row of trace.claims) counts[row.kind] += 1;
  const bits = (Object.keys(counts) as ClaimKind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${kind}${counts[kind] === 1 ? "" : "s"}`);
  const stance = trace.verified
    ? "conclusions checked against evidence"
    : "weak inference kept distinct from fact";
  const ground = (trace.groundedness ?? 0) >= 0.5 ? "grounded" : "weakly grounded";
  return `reasoning: ${bits.join(", ") || "no claims"} — ${stance} (${ground})`;
}

function gatherClaims(input: ReasonInput, snippets: string[]): ReasoningClaim[] {
  const claims: ReasoningClaim[] = [];
  for (const [index, line] of snippets.entries()) {
    const kind: ClaimKind = looksFactualLine(line) ? "fact" : "inference";
    claims.push(
      claim(kind, line.slice(0, 220), [`evidence:${index}`], kind === "fact" ? 0.82 : 0.55),
    );
  }
  for (const hop of input.knowledgeHops ?? []) {
    claims.push(claim("fact", `graph: ${hop}`, ["knowledge-graph"], 0.8));
  }
  if (input.worldSummary) {
    const unknown = /\bunknown\b/i.test(input.worldSummary);
    claims.push(
      claim(
        unknown ? "uncertainty" : "fact",
        `world: ${input.worldSummary.slice(0, 180)}`,
        ["world-model"],
        unknown ? 0.4 : 0.75,
      ),
    );
  }
  return claims;
}

function evidenceGroundedness(claims: ReasoningClaim[], snippets: string[]): number {
  const factRatio = claims.length
    ? claims.filter((row) => row.kind === "fact").length / claims.length
    : 0;
  const ev = new Set(snippets.flatMap((line) => retrievalTerms(line)));
  const supported = claims.filter(
    (row) => row.kind === "fact" || row.kind === "inference" || row.kind === "hypothesis",
  );
  if (!ev.size || !supported.length) return factRatio;
  let hit = 0;
  for (const row of supported) {
    if (retrievalTerms(row.text).some((term) => ev.has(term))) hit += 1;
  }
  return Math.max(factRatio, hit / supported.length);
}

function hypothesisFromPrompt(prompt: string): ReasoningClaim[] {
  const claims: ReasoningClaim[] = [];
  if (CAUSAL.test(prompt)) {
    claims.push(
      claim(
        "hypothesis",
        "A cause is not established until evidence supports it — treating the why-ask as a hypothesis, not a fact.",
        ["prompt"],
        0.35,
      ),
    );
  }
  if (WHAT_IF.test(prompt)) {
    claims.push(
      claim(
        "hypothesis",
        "Counterfactual / what-if branch — outcome is conditional, not observed.",
        ["prompt"],
        0.3,
      ),
    );
  }
  return claims;
}

function assumptionFromMeta(metaAction?: string): ReasoningClaim[] {
  if (!metaAction) return [];
  if (metaAction === "proceed" || metaAction === "execute") return [];
  return [
    claim(
      "assumption",
      `meta-reasoner would ${metaAction} before treating the answer as settled`,
      ["meta-reasoner"],
      0.5,
    ),
  ];
}

function alternativesFor(prompt: string, parts: string[]): string[] {
  const alts: string[] = [];
  if (TRADE.test(prompt)) {
    alts.push("Compare both sides with evidence; do not pick a side without support.");
  }
  if (parts.length > 1) {
    alts.push("Solve parts independently, then combine — a blocked part does not fail the rest.");
  }
  if (CAUSAL.test(prompt)) {
    alts.push("List competing causes; keep unsupported ones as hypotheses.");
  }
  if (!alts.length && parts.length === 1) {
    alts.push("Answer from retrieved evidence; if evidence is thin, say what is unknown.");
  }
  return alts.slice(0, 4);
}

function detectContradictions(
  input: ReasonInput,
  claims: ReasoningClaim[],
): { lines: string[]; flagged: ReasoningClaim[] } {
  const lines = [...(input.contradictions ?? [])];
  const flagged: ReasoningClaim[] = [];
  const facts = claims.filter((row) => row.kind === "fact" || row.kind === "inference");
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const left = facts[i]!;
      const right = facts[j]!;
      const leftTerms = new Set(retrievalTerms(left.text));
      const rightTerms = retrievalTerms(right.text);
      const overlap = rightTerms.filter((word) => leftTerms.has(word)).length;
      const polarity =
        /\b(not|never|instead)\b/i.test(left.text) !== /\b(not|never|instead)\b/i.test(right.text);
      if (overlap >= 2 && polarity) {
        left.contradicted = true;
        right.contradicted = true;
        flagged.push(left, right);
        lines.push(`claims disagree: “${left.text.slice(0, 80)}” vs “${right.text.slice(0, 80)}”`);
      }
    }
  }
  return { lines: [...new Set(lines)].slice(0, 6), flagged };
}

function compareEvidencePair(snippets: string[]): string | null {
  if (snippets.length < 2) return null;
  const toRef = (line: string, source: string): EvidenceRef => ({
    source,
    confidence: looksFactualLine(line) ? 0.8 : 0.45,
    updatedAt: Date.now(),
    verified: /verified|identity|owner|user/i.test(line),
  });
  const judgment = compareBeliefs(toRef(snippets[0]!, "stored"), toRef(snippets[1]!, "incoming"));
  if (judgment.sufficient) return `evidence comparison: ${judgment.reason}`;
  return `evidence comparison: ${judgment.reason}`;
}

function decideConclusions(claims: ReasoningClaim[], contradictions: string[]): ReasoningClaim[] {
  const usable = claims.filter((row) => !row.contradicted && row.kind !== "unknown");
  const facts = usable.filter((row) => row.kind === "fact" && row.confidence >= 0.7);
  const conclusions: ReasoningClaim[] = [];
  if (contradictions.length) {
    conclusions.push(
      claim(
        "uncertainty",
        "Conflicting evidence is preserved; no side is declared the fact.",
        usable.map((row) => row.id),
        0.4,
      ),
    );
    return conclusions;
  }
  if (facts.length) {
    conclusions.push(
      claim(
        "fact",
        facts.length === 1
          ? facts[0]!.text
          : `${facts.length} supported facts; inferences stay separate.`,
        facts.map((row) => row.id),
        Math.min(0.9, facts.reduce((sum, row) => sum + row.confidence, 0) / facts.length),
      ),
    );
  }
  const open = usable.filter(
    (row) => row.kind === "hypothesis" || row.kind === "uncertainty" || row.kind === "assumption",
  );
  const missing = claims.filter(
    (row) => row.kind === "unknown" && /subproblem \d+ has no retrieved evidence/i.test(row.text),
  );
  if (missing.length && facts.length) {
    conclusions.push(
      claim(
        "inference",
        "Some subproblems still lack retrieved evidence.",
        missing.map((row) => row.id),
        0.35,
      ),
    );
  }
  if (open.length) {
    conclusions.push(
      claim(
        "inference",
        "Remaining hypotheses and assumptions are not facts.",
        open.map((row) => row.id),
        0.4,
      ),
    );
  }
  if (!conclusions.length) {
    conclusions.push(claim("unknown", "Not enough supported evidence to conclude.", [], 0.2));
  }
  return conclusions;
}

function consistencyOf(conclusions: ReasoningClaim[]): "agreed" | "split" | "single" {
  const kinds = [...new Set(conclusions.map((row) => row.kind))];
  if (kinds.length <= 1) return conclusions.length <= 1 ? "single" : "agreed";
  return "split";
}

function verifyConclusions(conclusions: ReasoningClaim[], claims: ReasoningClaim[]): boolean {
  const overclaim = conclusions.some(
    (row) => row.kind === "fact" && (row.confidence < 0.7 || CERTAIN.test(row.text)),
  );
  const factWithoutSupport = conclusions.some(
    (row) => row.kind === "fact" && row.support.length === 0,
  );
  const hypothesisAsFact = claims.some(
    (row) =>
      row.kind === "hypothesis" &&
      conclusions.some((c) => c.kind === "fact" && c.text === row.text),
  );
  return !overclaim && !factWithoutSupport && !hypothesisAsFact;
}

/**
 * Run the private reasoning stages. Cached for identical inputs in-session
 * (Task 14 reuse) — never persisted, never dumped as CoT.
 */
export function reasonAbout(input: ReasonInput): ReasoningTrace {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit) return hit;

  const prompt = String(input.prompt || "").trim();
  const stages: ReasoningStageNote[] = [];
  const parts = decomposePrompt(prompt);
  const ordered = leastToMostOrder(parts);
  const snippets = sortSnippetsLeastToMost(evidenceSnippets(input.evidence ?? ""), ordered);

  stages.push({
    id: "understand",
    detail: prompt ? `ask: ${prompt.slice(0, 120)}` : "empty prompt",
  });

  stages.push({
    id: "decompose",
    detail:
      parts.length > 1 ? `${parts.length} parts, least-to-most then gather` : "single question",
  });

  const gathered = gatherClaims(input, snippets);
  const coverage = coverSubproblems(ordered, snippets, gathered);
  stages.push({
    id: "gather",
    detail: `${gathered.length} evidence-backed claim(s), ${snippets.length} snippet(s), ${ordered.length} subproblem(s), ${coverage.length} uncovered`,
  });

  const alts = alternativesFor(prompt, parts);
  stages.push({ id: "options", detail: `${alts.length} alternative path(s)` });

  const extra: ReasoningClaim[] = [
    ...hypothesisFromPrompt(prompt),
    ...assumptionFromMeta(input.metaAction),
  ];
  if (CONSTRAINT.test(prompt)) {
    extra.push(
      claim(
        "assumption",
        "Constraint language in the ask — treat limits as binding assumptions.",
        ["prompt"],
        0.6,
      ),
    );
  }
  if (DEPEND.test(prompt)) {
    extra.push(
      claim(
        "inference",
        "Dependency language present — order of work may be constrained.",
        ["prompt"],
        0.5,
      ),
    );
  }
  if (TRADE.test(prompt)) {
    extra.push(
      claim(
        "hypothesis",
        "Trade-off: both options stay open until evidence ranks them.",
        ["prompt"],
        0.4,
      ),
    );
  }
  if (!prompt) {
    extra.push(claim("unknown", "No ask to reason about.", [], 0.1));
  } else if (!gathered.length && !snippets.length) {
    extra.push(claim("unknown", "No retrieved evidence for this ask.", ["retrieval"], 0.2));
  }

  const claims = [...gathered, ...extra, ...coverage, ...criteriaFromPrompt(prompt)];
  linkSupports(claims);
  aggregateAgreeingFacts(claims);
  const found = detectContradictions(input, claims);
  const compared = compareEvidencePair(snippets);
  stages.push({
    id: "evaluate",
    detail: [
      found.lines.length ? `${found.lines.length} contradiction(s)` : "no claim clash",
      compared ?? "single evidence line",
    ].join("; "),
  });

  const conclusions = decideConclusions(claims, found.lines);
  const consistency = consistencyOf(conclusions);
  const preferredPath = preferredThought(alts, snippets);
  stages.push({
    id: "decide",
    detail: `conclusions: ${conclusions.map((row) => row.kind).join(", ")} (${consistency})`,
  });

  stages.push({
    id: "execute",
    detail: "reasoning does not execute actions — planning and governance stay in their modules",
  });

  const verified = verifyConclusions(conclusions, claims);
  const groundedness = evidenceGroundedness(claims, snippets);
  stages.push({
    id: "verify",
    detail: verified
      ? `no fact overclaim (groundedness ${(groundedness * 100).toFixed(0)}%)`
      : "blocked presenting weak inference as fact",
  });

  const assumptions = claims.filter((row) => row.kind === "assumption").map((row) => row.text);
  stages.push({
    id: "reflect",
    detail: `${assumptions.length} assumption(s) kept explicit`,
  });

  const trace: ReasoningTrace = {
    stages,
    claims,
    alternatives: alts,
    contradictions: found.lines,
    assumptions,
    conclusions,
    verified,
    groundedness,
    subproblems: ordered,
    consistency,
    publicNote: "",
  };
  if (preferredPath) trace.preferredPath = preferredPath;
  if (found.lines.length && preferredPath) {
    trace.alternatives = [
      `backtrack: ${preferredPath}`,
      ...alts.filter((row) => row !== preferredPath),
    ].slice(0, 4);
  }
  trace.publicNote = publicReasoningNote(trace);

  cache.set(key, trace);
  if (cache.size > CACHE_CAP) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return trace;
}

/** Internal strategies. One interface. No second agent and no private chain dump. */
export const REASONING_MODES = [
  "direct",
  "retrieval",
  "decomposition",
  "analogy",
  "causal",
  "constraint",
  "hypothesis",
  "plan-search",
  "simulation",
  "tool-assisted",
  "debate",
  "verification-first",
  "recovery",
] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

const NEXT_MODE: Record<ReasoningMode, ReasoningMode> = {
  direct: "retrieval",
  retrieval: "decomposition",
  decomposition: "hypothesis",
  analogy: "causal",
  causal: "hypothesis",
  constraint: "plan-search",
  hypothesis: "verification-first",
  "plan-search": "simulation",
  simulation: "constraint",
  "tool-assisted": "verification-first",
  debate: "retrieval",
  "verification-first": "recovery",
  recovery: "decomposition",
};

const ANALOGY = /\b(like|similar to|analogy|reminds me)\b/i;
const PLAN = /\b(steps|plan|break down|decompose)\b/i;
const GUESS = /\b(hypothesis|maybe|might|could it be)\b/i;

export function selectReasoningMode(input: {
  prompt: string;
  liveFact?: boolean;
  consequential?: boolean;
  contradicted?: boolean;
  failed?: boolean;
  ambiguous?: boolean;
  complex?: boolean;
}): ReasoningMode {
  const prompt = String(input.prompt || "");
  if (input.failed) return "recovery";
  if (input.contradicted || input.consequential) return "verification-first";
  if (WHAT_IF.test(prompt)) return "simulation";
  if (CAUSAL.test(prompt)) return "causal";
  if (CONSTRAINT.test(prompt)) return "constraint";
  if (TRADE.test(prompt)) return "debate";
  if (DEPEND.test(prompt)) return "plan-search";
  if (ANALOGY.test(prompt)) return "analogy";
  if (PLAN.test(prompt)) return "decomposition";
  if (GUESS.test(prompt)) return "hypothesis";
  if (input.liveFact) return "tool-assisted";
  if (input.ambiguous || input.complex) return "retrieval";
  return "direct";
}

export function alternateReasoningMode(mode: ReasoningMode): ReasoningMode {
  return NEXT_MODE[mode];
}

export type AntiAnchorProposal = {
  failedStrategy: ReasoningMode;
  alternative: ReasoningMode;
  whyDifferent: string;
  applied: false;
};

/** A different strategy after a material miss. Never applied from here. */
export function describeAntiAnchor(input: {
  failed: ReasoningMode;
  cause: string;
}): AntiAnchorProposal {
  const alternative = alternateReasoningMode(input.failed);
  const cause = String(input.cause || "the last strategy missed").slice(0, 180);
  return {
    failedStrategy: input.failed,
    alternative,
    whyDifferent: `Do not repeat ${input.failed}. A different candidate is ${alternative}. Cause: ${cause}. This candidate is not applied.`,
    applied: false,
  };
}

export type ThoughtCandidate = {
  id: string;
  mode: ReasoningMode;
  score: number;
  note: string;
  kept: boolean;
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scoreMode(
  mode: ReasoningMode,
  primary: ReasoningMode,
  input: {
    contradicted?: boolean;
    consequential?: boolean;
    hasEvidence?: boolean;
    liveFact?: boolean;
    failed?: boolean;
  },
): number {
  let score = mode === primary ? 0.62 : 0.4;
  if (!input.hasEvidence && mode === "direct") score -= 0.28;
  if (input.consequential && mode === "direct") score -= 0.35;
  if (input.contradicted && (mode === "verification-first" || mode === "debate")) score += 0.22;
  if (input.liveFact && (mode === "tool-assisted" || mode === "retrieval")) score += 0.18;
  if (input.failed && mode === "recovery") score += 0.24;
  if (input.hasEvidence && mode === "retrieval") score += 0.08;
  return clampScore(score);
}

/**
 * Tree-of-Thoughts bounded to three modes. Fast depth keeps a single path.
 * Exactly one candidate is marked kept.
 */
export function deliberateModes(input: {
  primary: ReasoningMode;
  depth: "fast" | "deliberative" | "metacognitive";
  contradicted?: boolean;
  consequential?: boolean;
  hasEvidence?: boolean;
  liveFact?: boolean;
  failed?: boolean;
}): ThoughtCandidate[] {
  const pool: ReasoningMode[] = [input.primary];
  if (input.depth !== "fast") {
    pool.push(alternateReasoningMode(input.primary));
    if (input.depth === "metacognitive") {
      pool.push(input.contradicted || input.consequential ? "debate" : "verification-first");
    }
  }
  const unique: ReasoningMode[] = [];
  for (const mode of pool) {
    if (!unique.includes(mode)) unique.push(mode);
  }
  const scored = unique.slice(0, 3).map((mode, index) => ({
    mode,
    index,
    score: scoreMode(mode, input.primary, input),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0]?.mode;
  return scored.map((row) => ({
    id: nextId("th"),
    mode: row.mode,
    score: row.score,
    kept: row.mode === best,
    note:
      row.mode === best
        ? row.score < 0.35
          ? "kept as the least weak path — do not invent certainty"
          : "kept"
        : "explored and not kept",
  }));
}
