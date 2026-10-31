/**
 * FRIDAY · ask, check, fix, escalate
 *
 * The loop that lets the answer be better than one model's first try. It asks the cheapest rung, holds the
 * answer to every requirement in the ask that can be checked without a model (answer-checks.ts), and when
 * one fails it asks the SAME model again with exactly what failed (cheap), then moves to the next rung
 * (a stronger or different model). It stops at the first answer that passes. If none does, it returns
 * the closest one and says plainly that it did not pass.
 *
 * Nothing is verified that the ask did not require, and a model's own confidence is never used. When the
 * ask has nothing checkable the model is asked once, as before. The models themselves are called through
 * the injected `ask`, so the privacy and billing gates stay where they already are.
 */

import { checkAnswer, checksFor, feedbackFor, type CheckFailure } from "./answer-checks";
import { checkWithTools, toolChecksFor, type ToolPort } from "./tool-checks";

export type Rung = { id: string; label: string; modelIds: string[] };

export type Attempt = {
  rung: string;
  attempt: number;
  failures: string[];
  error?: string;
};

export type VerifiedResult = {
  answer: string;
  /** The rung that produced `answer`, or null when no model answered. */
  rung: string | null;
  /** True only when every check that applied passed. False with `checked` empty means nothing was checkable. */
  verified: boolean;
  checked: string[];
  attempts: Attempt[];
  escalated: boolean;
  note: string;
};

const clip = (text: string, size = 1500) => (text.length > size ? `${text.slice(0, size)}…` : text);

export function retryPrompt(prompt: string, previous: string, failures: CheckFailure[]): string {
  return [
    prompt,
    "",
    "Your previous answer did not meet these requirements:",
    feedbackFor(failures),
    "",
    "Previous answer:",
    clip(previous),
    "",
    "Answer again so that every requirement is met. Give only the corrected answer.",
  ].join("\n");
}

export async function runVerified(input: {
  prompt: string;
  rungs: Rung[];
  ask: (prompt: string, rung: Rung) => Promise<string>;
  /** Extra tries on the same rung before moving up. Default 1. */
  retriesPerRung?: number;
  /** Tools for the checks that need doing something (run the code, find the file). Absent: those are skipped. */
  tools?: ToolPort;
}): Promise<VerifiedResult> {
  const rungs = input.rungs.length
    ? input.rungs
    : [{ id: "default", label: "default", modelIds: [] }];
  const plan = [...checksFor(input.prompt), ...(input.tools ? toolChecksFor(input.prompt) : [])];
  const retries = Math.max(0, Math.min(3, input.retriesPerRung ?? 1));
  const attempts: Attempt[] = [];
  let best: { answer: string; rung: string; failures: CheckFailure[] } | null = null;

  // Nothing checkable in the ask: one answer from the first rung that answers, as before.
  const rungsToTry = plan.length ? rungs : rungs.slice(0, 1);

  for (const rung of rungsToTry) {
    let prompt = input.prompt;
    for (let attempt = 1; attempt <= 1 + (plan.length ? retries : 0); attempt += 1) {
      let answer: string;
      try {
        answer = await input.ask(prompt, rung);
      } catch (error) {
        attempts.push({
          rung: rung.id,
          attempt,
          failures: [],
          error: error instanceof Error ? error.message : String(error),
        });
        break; // a rung that errors is not asked again; the next one is
      }
      if (!plan.length) {
        attempts.push({ rung: rung.id, attempt, failures: [] });
        return {
          answer,
          rung: rung.id,
          verified: false,
          checked: [],
          attempts,
          escalated: false,
          note: "nothing in the ask could be checked without a model; answered once",
        };
      }
      const base = checkAnswer(input.prompt, answer);
      const toolRun = await checkWithTools(input.prompt, answer, input.tools);
      const result = {
        checked: [...base.checked, ...toolRun.checked],
        failures: [...base.failures, ...toolRun.failures],
        ok: base.ok && toolRun.failures.length === 0,
      };
      attempts.push({ rung: rung.id, attempt, failures: result.failures.map((f) => f.message) });
      if (!best || result.failures.length < best.failures.length) {
        best = { answer, rung: rung.id, failures: result.failures };
      }
      if (result.ok) {
        return {
          answer,
          rung: rung.id,
          verified: true,
          checked: result.checked,
          attempts,
          escalated: rung !== rungs[0],
          note: `passed ${result.checked.length} check(s)${attempts.length > 1 ? ` after ${attempts.length} tries` : ""}`,
        };
      }
      prompt = retryPrompt(input.prompt, answer, result.failures);
    }
  }

  if (!best) {
    return {
      answer: "",
      rung: null,
      verified: false,
      checked: plan,
      attempts,
      escalated: rungsToTry.length > 1,
      note: "no model answered",
    };
  }
  return {
    answer: best.answer,
    rung: best.rung,
    verified: false,
    checked: plan,
    attempts,
    escalated: rungsToTry.length > 1,
    note: `closest answer after ${attempts.length} tries; still failing: ${best.failures.map((f) => f.message).join(" ")}`,
  };
}
