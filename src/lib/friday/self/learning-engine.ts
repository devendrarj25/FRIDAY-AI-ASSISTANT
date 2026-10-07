/**
 * FRIDAY · learning engine
 *
 * Runs after a task or a run finishes: evaluate the outcome, decide whether it
 * is worth keeping and write it into the right memory tier. Wrong output is
 * never promoted to knowledge — only verified successes and explicit user
 * corrections become semantic/permanent memory.
 */

import { memory } from "./memory-engine";
import { experiences, STRATEGY_SAMPLE_MIN, type ExperienceModel } from "./task-ledger";
import { ownerContextDigest } from "../brain/identity";
import { userProfileDigest } from "../brain/user-profile";
import { applyVerifiedCorrection } from "../brain/settings-intents";

export type Outcome = {
  taskId: string;
  kind: string;
  title: string;
  success: boolean;
  verified: boolean;
  ms: number;
  detail?: string;
  /** Set when the user corrected FRIDAY — corrections outrank successes. */
  correction?: string;
  /** Which models and tools actually did the work (experience evidence). */
  models?: (string | ExperienceModel)[];
  tools?: string[];
  strategy?: string;
  cause?: string;
  lesson?: string;
};

export type LearningResult = {
  learned: boolean;
  tier: "episodic" | "semantic" | "permanent" | null;
  note: string;
};

const patternKey = (o: Outcome) => `pattern:${o.kind}`;

class LearningEngine {
  evaluate(outcome: Outcome): LearningResult {
    // 0. One durable experience record — the evidence base every other loop
    //    (capability matrix, skill learning, fine-tuning, routing metric)
    //    reads from. Written once, here, so there is no second logging system.
    experiences.record({
      taskId: outcome.taskId,
      kind: outcome.kind,
      title: outcome.title,
      success: outcome.success,
      verified: outcome.verified,
      ms: outcome.ms,
      ...(outcome.models ? { models: outcome.models } : {}),
      ...(outcome.tools ? { tools: outcome.tools } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.correction ? { feedback: outcome.correction } : {}),
    });

    // 1. Every finished task becomes an episode — that is history, not knowledge.

    memory.remember({
      tier: "episodic",
      title: `${outcome.kind}: ${outcome.title}`.slice(0, 100),
      text: [
        outcome.success ? "Completed" : "Failed",
        outcome.verified ? "and verified" : "without verification",
        `in ${(outcome.ms / 1000).toFixed(1)}s.`,
        outcome.detail ?? "",
        outcome.cause ? `Cause: ${outcome.cause}` : "",
        outcome.lesson ? `Lesson: ${outcome.lesson}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      tags: [outcome.kind, outcome.success ? "success" : "failure"],
      source: `task/${outcome.taskId}`,
      confidence: outcome.verified ? 0.9 : 0.5,
    });

    // 2. A user correction is the strongest signal there is.
    if (outcome.correction) {
      memory.remember({
        tier: "permanent",
        title: `Correction — ${outcome.title}`.slice(0, 100),
        text: outcome.correction,
        tags: ["correction", outcome.kind],
        source: "user",
        confidence: 1,
        pinned: true,
      });
      const promoted = applyVerifiedCorrection(outcome.correction);
      return {
        learned: true,
        tier: "permanent",
        note: promoted.applied
          ? `user correction stored and applied to ${promoted.key}`
          : "user correction stored as a standing rule",
      };
    }

    // 3. Only verified successes become reusable knowledge.
    if (!outcome.success || !outcome.verified) {
      if (!outcome.success) {
        memory.remember({
          tier: "temporary",
          title: `Failure signal — ${outcome.title}`.slice(0, 100),
          text: outcome.detail ?? "No detail captured.",
          tags: ["failure", outcome.kind],
          source: `task/${outcome.taskId}`,
          confidence: 0.4,
        });
        memory.remember({
          tier: "episodic",
          title: `Reflection — ${outcome.kind}`.slice(0, 100),
          text: [
            `Failed: ${outcome.title}.`,
            outcome.cause ? `Cause: ${outcome.cause}.` : "",
            outcome.lesson ? `Lesson: ${outcome.lesson}.` : (outcome.detail ?? ""),
            "Do not repeat the same failed action blindly; change method or stop if dangerous.",
          ]
            .filter(Boolean)
            .join(" "),
          tags: ["reflection", "failure", outcome.kind],
          source: `task/${outcome.taskId}`,
          confidence: 0.55,
          kind: "failure",
        });
      }
      return {
        learned: false,
        tier: null,
        note: outcome.success ? "unverified result — not learned" : "failure recorded, not learned",
      };
    }

    const key = patternKey(outcome);
    const prior = memory
      .search(key, { tiers: ["semantic"], k: 1 })
      .find((i) => i.tags.includes(key));
    const verifiedSame = experiences
      .successes(400)
      .filter((row) => row.kind === outcome.kind && row.verified).length;
    const repeats = Math.max(verifiedSame, (prior?.uses ?? 0) + 1);

    // One verified success is an episode. A reusable pattern needs a repeat
    // so a single noisy result cannot rewrite strategy.
    if (verifiedSame < 2) {
      return {
        learned: false,
        tier: "episodic",
        note: "verified once — waiting for a repeated outcome before promoting a pattern",
      };
    }

    memory.remember({
      tier: "semantic",
      title: `Working pattern — ${outcome.kind}`,
      text: `${outcome.title} succeeded and verified. Typical duration ${(outcome.ms / 1000).toFixed(1)}s. ${outcome.detail ?? ""}`.trim(),
      tags: [key, outcome.kind, "pattern"],
      source: `task/${outcome.taskId}`,
      confidence: Math.min(0.95, 0.6 + repeats * 0.05),
      kind: "procedural",
      verified: true,
    });

    if (outcome.strategy || outcome.lesson) {
      const verifiedSame = experiences
        .successes(400)
        .filter((row) => row.kind === outcome.kind).length;
      if (verifiedSame >= STRATEGY_SAMPLE_MIN) {
        memory.remember({
          tier: "semantic",
          title: `Strategy — ${outcome.kind}`,
          text: [outcome.strategy, outcome.lesson].filter(Boolean).join(" · "),
          tags: ["strategy", outcome.kind],
          source: `task/${outcome.taskId}`,
          confidence: 0.8,
          kind: "procedural",
          verified: true,
        });
      }
    }

    return { learned: true, tier: "semantic", note: `pattern reinforced (${repeats}×)` };
  }

  /**
   * Conservative conversational learning. One casual line is never enough
   * to rewrite durable memory. Corrections still use evaluate().
   */
  observeConversationalOutcome(input: {
    prompt: string;
    move?: string;
    styleCue?: string | null;
    accepted?: boolean;
  }): void {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) return;
    const standing = /\b(always|from now on|never|har baar|always use)\b/i.test(prompt);
    const languageStanding = /\b(default\s+)?hinglish mein baat\b/i.test(prompt);
    if (languageStanding) {
      this.preference("language Hinglish", prompt.slice(0, 240));
      return;
    }
    if (standing && (input.move === "correction" || input.styleCue)) {
      this.preference(
        input.styleCue ? `style ${input.styleCue}` : "standing request",
        prompt.slice(0, 240),
      );
    }
  }

  /** Kind-level specialist hint from verified strategy memory — not a second router. */
  specializationFor(kind: string): string | null {
    const needle = String(kind || "").trim();
    if (!needle) return null;
    const hit = memory
      .search(needle, { tiers: ["semantic"], k: 12 })
      .find((item) => item.tags.includes("strategy") && item.tags.includes(needle));
    return hit?.text ?? null;
  }

  /** Preference stated by the user, e.g. "always use the local model". */
  preference(title: string, text: string): void {
    memory.remember({
      tier: "permanent",
      title: `Preference — ${title}`.slice(0, 100),
      text,
      tags: ["preference"],
      source: "user",
      confidence: 1,
      pinned: true,
      kind: "preference",
      verified: true,
    });
  }

  /** Context block handed to the planner before it plans. */
  contextFor(prompt: string, k = 6): { text: string; used: string[] } {
    const hits = memory.retrieve(prompt, k);
    const reflections = memory
      .retrieve(prompt, Math.max(2, k))
      .filter((hit) => hit.item.tags.includes("reflection"));
    const merged = [...reflections, ...hits]
      .filter((hit, index, all) => all.findIndex((row) => row.item.id === hit.item.id) === index)
      .slice(0, k);
    return {
      text: merged.map((h) => `[${h.item.tier}] ${h.item.title}: ${h.item.text}`).join("\n"),
      used: merged.map((h) => h.item.id),
    };
  }

  /**
   * Personal context from identity + user profile + preference memory. Owner
   * instructions always outrank learned preferences. Same stores Settings uses.
   */
  personalContext(): {
    owner: string;
    instructions: string;
    style: string;
    preferences: string[];
    authority: string;
    userAddress: string;
    userName: string;
    occupation: string;
    location: string;
    languages: string;
    about: string;
    notes: string;
  } {
    const digest = ownerContextDigest();
    const user = userProfileDigest();
    const preferences = memory
      .search("preference", { tiers: ["permanent"], k: 8 })
      .filter((item) => item.kind === "preference" || item.tags.includes("preference"))
      .map((item) => item.text);
    return {
      owner: digest.owner,
      instructions: digest.instructions,
      style: digest.style,
      preferences,
      authority: "Owner instructions are the highest authority over any learned preference.",
      userAddress: user.honorific,
      userName: user.preferredName,
      occupation: user.occupation,
      location: user.location,
      languages: user.languages,
      about: user.about,
      notes: user.notes,
    };
  }

  /**
   * Store one Reflexion-style candidate after a material miss.
   * `applied` stays false. A second call for the same task does not write again.
   */
  fileAntiAnchor(input: {
    taskId: string;
    failedStrategy: string;
    alternative: string;
    whyDifferent: string;
    cause?: string;
  }): { stored: boolean; applied: false; id: string } {
    const taskId = String(input.taskId || "").trim() || "turn";
    const prior = antiAnchorLedger.get(taskId);
    if (prior) return { stored: false, applied: false, id: prior };
    const id = `anti-${taskId}`.slice(0, 96);
    antiAnchorLedger.set(taskId, id);
    try {
      memory.remember({
        tier: "episodic",
        title: `Anti-anchor — ${input.failedStrategy}`.slice(0, 100),
        text: [
          `Failed strategy: ${input.failedStrategy}.`,
          `Different candidate: ${input.alternative}.`,
          input.whyDifferent,
          input.cause ? `Cause: ${input.cause}` : "",
          "Not applied. Governance must accept a change before it becomes behavior.",
        ]
          .filter(Boolean)
          .join(" "),
        tags: ["anti-anchor", "candidate", "reflection", taskId],
        source: `task/${taskId}`,
        confidence: 0.45,
        kind: "failure",
      });
    } catch {
      /* the ledger still blocks a second write */
    }
    return { stored: true, applied: false, id };
  }
}

const antiAnchorLedger = new Map<string, string>();

export function resetAntiAnchorLedger(): void {
  antiAnchorLedger.clear();
}

export const learning = new LearningEngine();

/* ---------------------------------------------------- learned procedures */

const PROCEDURE_TAG = "procedure";
const PROCEDURE_MARK = "FRIDAY-PROCEDURE v1";

export type ProcedureStep = { title: string; instruction: string };

export type LearnedProcedure = {
  goal: string;
  steps: ProcedureStep[];
  source: string;
};

const significantTokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
};

export function encodeProcedure(goal: string, steps: ProcedureStep[]): string {
  const body = steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.title.replace(/\s+/g, " ").trim()} :: ${step.instruction.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
  return `${PROCEDURE_MARK}\nGOAL: ${goal.replace(/\s+/g, " ").trim()}\n${body}`;
}

export function parseProcedure(text: string): LearnedProcedure | null {
  if (!text.includes(PROCEDURE_MARK)) return null;
  const goal = text.match(/^GOAL:\s*(.+)$/m)?.[1]?.trim();
  const steps: ProcedureStep[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+\.\s+(.+?)\s+::\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    steps.push({ title: match[1].trim(), instruction: match[2].trim() });
  }
  if (!goal || steps.length < 2) return null;
  return { goal, steps, source: "memory" };
}

/** Store a verified multi-step workflow so the next similar goal can skip re-planning. */
export function rememberProcedure(goal: string, steps: ProcedureStep[], source: string): void {
  if (steps.length < 2) return;
  memory.remember({
    tier: "semantic",
    title: `Procedure — ${goal}`.slice(0, 100),
    text: encodeProcedure(goal, steps),
    tags: [PROCEDURE_TAG, "pattern", "workflow"],
    source,
    confidence: 0.85,
  });
}

/**
 * Retrieve a previously learned procedure when the new goal is actually the
 * same kind of work. Unrelated requests return null so we never invent steps.
 */
export function recallProcedure(goal: string): LearnedProcedure | null {
  const want = significantTokens(goal);
  if (want.size < 2) return null;
  const hits = memory.retrieve(goal, 8);
  let best: { score: number; procedure: LearnedProcedure } | null = null;
  for (const hit of hits) {
    if (!hit.item.tags.includes(PROCEDURE_TAG)) continue;
    const procedure = parseProcedure(hit.item.text);
    if (!procedure) continue;
    const score = jaccard(want, significantTokens(procedure.goal));
    if (score < 0.34) continue;
    if (!best || score > best.score)
      best = { score, procedure: { ...procedure, source: hit.item.id } };
  }
  return best?.procedure ?? null;
}
