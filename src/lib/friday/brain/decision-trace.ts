/**
 * FRIDAY · decision trace, honest uncertainty and learning status
 *
 * Nothing here invents data. It surfaces, in plain language, what FRIDAY has
 * ALREADY recorded elsewhere:
 *
 *   - the routing decision for a turn  → runtime.prepareTurn (recorded here)
 *   - confidence for that turn         → brain/confidence.ts
 *   - domain ability                   → self/capability-matrix.ts
 *   - free-vs-paid policy              → brain/cost-policy.ts
 *   - what was attempted and verified  → self/task-ledger.ts (experience store)
 *
 * Three owner-facing answers are built from that one evidence base:
 *   1. "why did you use that model / how confident were you"
 *   2. "I genuinely don't know" — with the real next step, not a guess
 *   3. "what have you learned recently"
 */

import { capabilityMatrix, DOMAIN_LABEL, type CapabilityScore } from "../self/capability-matrix";
import { experiences } from "../self/task-ledger";
import { currentPolicy, describePolicy, isFree, type UsagePolicy } from "./cost-policy";
import { modelRegistry } from "./model-registry";
import { capabilityRegistry } from "./capability-registry";
import { brainKnowledge } from "./knowledge-base";
import { memory } from "../self/memory-engine";
import type { Confidence } from "./confidence";
import type { UnderstandingTrace } from "./intent-engine";

export type DecisionTrace = {
  at: number;
  mode: string;
  prompt: string;
  /** Models the router actually selected, strongest first. */
  modelIds: string[];
  /** The router's own note for this turn (pipeline roles + policy). */
  routing: string;
  policy: UsagePolicy;
  confidence: Confidence | null;
  /**
   * Set only when the turn really fanned out to several models at once, so
   * the owner can see the extra requests (and any extra cost) and why.
   */
  collaboration?: {
    initiator: "owner" | "friday";
    reason: string;
    models: { modelId: string; label: string; access: string; ok: boolean; ms: number }[];
    winner: string | null;
    agreement: number;
  };
  /** Normalized turn understanding — additional field on this trace, not a second system. */
  understanding?: UnderstandingTrace;
};

const MAX_TRACES = 40;
const traces: DecisionTrace[] = [];
let pendingUnderstanding: UnderstandingTrace | null = null;

/** Stash understanding until `recordDecision` (prepareTurn or an early ask). */
export function noteUnderstanding(understanding: UnderstandingTrace): void {
  // First writer wins so startRun's history-aware understanding is not
  // overwritten by cognize(), which often sees only the resolved prompt.
  if (pendingUnderstanding) return;
  pendingUnderstanding = understanding;
}

/** Called from the one routing path (runtime.prepareTurn) with real values. */
export function recordDecision(trace: DecisionTrace): DecisionTrace {
  const understanding = trace.understanding ?? pendingUnderstanding ?? null;
  pendingUnderstanding = null;
  const { understanding: _ignored, ...rest } = trace;
  const merged: DecisionTrace = understanding ? { ...rest, understanding } : { ...rest };
  traces.unshift(merged);
  if (traces.length > MAX_TRACES) traces.length = MAX_TRACES;
  return merged;
}

/** Newest recorded routing decision, or null before any turn has been routed. */
export function lastDecision(): DecisionTrace | null {
  return traces[0] ?? null;
}

/** Traces newest-first — used by the tests and the run detail panels. */
export function decisionTraces(limit = MAX_TRACES): DecisionTrace[] {
  return traces.slice(0, limit);
}

/** Test/reset hook. Never called from the UI. */
export function clearDecisionTraces(): void {
  traces.length = 0;
  pendingUnderstanding = null;
}

/**
 * Attach a real multi-model collaboration to the turn that was just routed.
 * Called once, after the concurrent calls have actually returned, so "why did
 * you use two models" is answered from what really happened.
 */
export function recordCollaboration(
  collaboration: NonNullable<DecisionTrace["collaboration"]>,
): DecisionTrace | null {
  const trace = traces[0];
  if (!trace) return null;
  trace.collaboration = collaboration;
  trace.modelIds = collaboration.models.filter((m) => m.ok).map((m) => m.modelId);
  return trace;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function modelNote(id: string): string {
  try {
    const record = modelRegistry.get(id);
    if (!record) return id;
    const free = isFree(record) ? "free" : "paid";
    const reliability =
      record.reliability === null
        ? "no measured history yet"
        : `${pct(record.reliability)} success`;
    return `${record.name} (${record.kind}, ${free}, ${reliability})`;
  } catch {
    return id;
  }
}

/**
 * "Why did you use that model / how confident were you / why didn't you know
 * that" — answered from the recorded trace of that turn, never generically.
 */
export function explainDecision(question = ""): string {
  const trace = lastDecision();
  if (!trace) {
    return "I haven't routed a model turn yet in this session, so there's no decision of mine to explain. Ask me something that needs a model and then ask why — I'll show the real reasoning.";
  }

  const lines: string[] = [];
  lines.push(`For "${trace.prompt.slice(0, 80)}"${trace.mode ? ` (${trace.mode} mode)` : ""}:`);

  if (trace.modelIds.length) {
    lines.push(`I used ${trace.modelIds.map(modelNote).join(", then ")}.`);
  } else {
    lines.push("I used no model at all — nothing allowed by your policy was reachable.");
  }

  const confidence = trace.confidence;
  if (confidence) {
    const domains = confidence.domains
      .map((domain) => `${DOMAIN_LABEL[domain]} ${capabilityMatrix.score(domain).score}/100`)
      .join(", ");
    lines.push(
      `My own confidence was ${pct(confidence.score)} — that comes from my capability scores for ${domains}, so I ${
        confidence.local ? "kept it local" : "preferred a stronger model"
      }.`,
    );
  }

  if (trace.collaboration) {
    const c = trace.collaboration;
    const used = c.models
      .map((m) => `${m.label} (${m.access}${m.ok ? `, ${m.ms}ms` : ", no answer"})`)
      .join(" and ");
    lines.push(
      `I ran ${c.models.length} models at once on that turn — ${used} — because ${c.reason}.`,
      `That was ${c.models.length} separate requests, not one${c.models.some((m) => m.access === "paid") ? " (and a paid model was among them)" : ""}.`,
      c.winner
        ? `I built the final answer from them, leading with ${c.winner}; they agreed ${pct(c.agreement)}.`
        : "None of them produced a usable answer, so I told you that instead of guessing.",
    );
  }
  if (trace.understanding) {
    const u = trace.understanding;
    lines.push(
      `I understood that as "${u.resolvedGoal.slice(0, 80)}" (${pct(u.understandingConfidence)} understanding)${
        u.ambiguous ? " and needed a clearer target before acting" : ""
      }.`,
    );
  }
  lines.push(`Cost rule in force: ${describePolicy(trace.policy)}.`);

  if (/why (didn'?t|did not) you know|why don'?t you know/i.test(question)) {
    const weakest = confidence?.domains
      .map((domain) => capabilityMatrix.score(domain))
      .sort((a, b) => a.score - b.score)[0];
    if (weakest) {
      lines.push(
        `The gap was ${weakest.label}: I'm at ${weakest.score}/100 there${
          weakest.provisional
            ? " and that's still my declared baseline, not measured"
            : ` over ${weakest.runs} real runs`
        }. That domain is what I need more verified runs — or a stronger model — for.`,
      );
    }
  }
  lines.push(`Router note for that turn: ${trace.routing}.`);
  return lines.join(" ");
}

/* ------------------------------------------------------------ uncertainty */

export type UncertaintyCheck = {
  /** True when FRIDAY genuinely has nothing to answer from. */
  unknown: boolean;
  /** The ladder she actually walked, in order, with what each step found. */
  steps: string[];
  /** The plain-language answer to speak/write when `unknown` is true. */
  message: string;
};

/**
 * The honest escalation ladder: memory → stored knowledge → tools → skills →
 * a local model. Every step reads an existing store; none of them guesses.
 */
export function checkUncertainty(
  prompt: string,
  options: { reachableModels?: () => { name: string; kind: string }[] } = {},
): UncertaintyCheck {
  const steps: string[] = [];
  let found = false;

  let memoryHits: number;
  try {
    memoryHits = memory.retrieve(prompt, 3).length;
  } catch {
    memoryHits = 0;
  }
  steps.push(memoryHits ? `memory: ${memoryHits} relevant record(s)` : "memory: nothing stored");
  found ||= memoryHits > 0;

  let knowledgeHits: number;
  try {
    knowledgeHits = brainKnowledge.recall(prompt, { k: 3 }).length;
  } catch {
    knowledgeHits = 0;
  }
  steps.push(
    knowledgeHits ? `my knowledge base: ${knowledgeHits} entry(s)` : "my knowledge base: nothing",
  );
  found ||= knowledgeHits > 0;

  const tools = safeBest(prompt, "tool");
  steps.push(tools.length ? `tools: ${tools[0]?.name} could help` : "tools: none that fit");
  found ||= tools.length > 0;

  const skills = safeBest(prompt, "skill");
  steps.push(skills.length ? `skills: ${skills[0]?.name} could help` : "skills: none that fit");
  found ||= skills.length > 0;

  let reachable: { name: string; kind: string }[];
  try {
    reachable = options.reachableModels
      ? options.reachableModels()
      : modelRegistry.available().map((r) => ({ name: r.name, kind: r.kind }));
  } catch {
    reachable = [];
  }
  const localModel = reachable.find((r) => r.kind === "local");
  steps.push(
    reachable.length
      ? `model: ${(localModel ?? reachable[0])?.name} is reachable`
      : "model: none reachable",
  );
  // A reachable model means this is a handoff, not genuine ignorance.
  found ||= reachable.length > 0;

  if (found) return { unknown: false, steps, message: "" };

  const policy = currentPolicy();
  const next = [
    "I can research it for you if you want me to go and look it up,",
    policy === "free-only"
      ? "or you can start a local model in Models — your policy is free-only, so I won't reach for a paid one."
      : "or I can ask a stronger cloud model — but that's paid, so I need you to approve it first.",
  ].join(" ");

  return {
    unknown: true,
    steps,
    message: [
      "I don't know this one, and I'm not going to guess.",
      `I checked: ${steps.join("; ")}.`,
      next,
      "If it's about something on this PC or in your work, tell me the missing detail and I'll take it from there.",
    ].join(" "),
  };
}

function safeBest(prompt: string, type: "tool" | "skill") {
  try {
    return capabilityRegistry.best(prompt, { type, limit: 1 });
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- learning */

/**
 * "What have you learned recently / how are you improving" — read straight out
 * of the capability matrix and the experience store.
 */
export function learningSummary(days = 7): string {
  const since = Date.now() - days * 86_400_000;
  const moved = capabilityMatrix
    .scores()
    .filter((score) => score.runs > 0 && (score.lastRunAt ?? 0) >= since)
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));

  const recent = experiences.list(200).filter((experience) => experience.at >= since);
  const verified = recent.filter((e) => e.success && e.verified).length;
  const failed = recent.filter((e) => !e.success).length;
  const habits = experiences.repeatedApproaches(3, days);
  const routing = experiences.routingStats(days);

  if (!recent.length && !moved.length) {
    return `Nothing measurable in the last ${days} days — no verified task outcomes were recorded, so none of my capability scores moved. They're still my declared baselines: ${capabilityMatrix.digest()}.`;
  }

  const lines: string[] = [];
  lines.push(
    `In the last ${days} days I recorded ${recent.length} real outcome(s): ${verified} verified good, ${failed} failed.`,
  );
  if (moved.length) {
    lines.push(
      `Scores that actually moved: ${moved
        .map((score) => `${score.label} ${score.score}/100 over ${score.runs} run(s)`)
        .join(", ")}.`,
    );
  }
  if (habits.length) {
    lines.push(
      `I've repeated ${habits.length} approach(es) enough times to be worth turning into a skill — top one: "${habits[0]?.title}" (${habits[0]?.count} verified runs).`,
    );
  }
  if (routing.total) {
    lines.push(
      `${Math.round((routing.localShare ?? 0) * 100)}% of my model calls ran on this PC (${routing.local} local, ${routing.cloud} cloud).`,
    );
  }
  const weakest = capabilityMatrix
    .scores()
    .slice()
    .sort((a, b) => a.score - b.score)[0] as CapabilityScore | undefined;
  if (weakest) {
    lines.push(
      `Weakest area right now is ${weakest.label} at ${weakest.score}/100 — that's where I need more verified runs.`,
    );
  }
  return lines.join(" ");
}

/* ---------------------------------------------------------------- matching */

export const DECISION_ASK =
  /\b(why (did|do) you (use|choose|pick|select|route)|which model did you use|why that model|how confident (were|are) you|what was your confidence|why (didn'?t|did not) you know)\b/i;

export const LEARNING_ASK =
  /\b(what have you learn(ed|t)|what did you learn|how are you improving|are you improving|your (learning|progress)|self[- ]improvement|getting better)\b/i;

/** Questions where guessing would be worse than admitting ignorance. */
export const FACT_ASK =
  /^(do you know|what do you know about)\b|\b(who|what|when|where) (is|was|are|were)\b/i;
