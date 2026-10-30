/**
 * FRIDAY · does the loop beat the bare model?
 *
 * The same fixed asks go to the owner's own model twice: once as it is (the bare answer) and once through
 * the ask-check-fix-escalate loop (`runVerified`). Both answers are judged by the same counting and parsing
 * checks (`answer-checks.ts`), so the numbers compare like with like. This measures whether the answer
 * kept the rules of the ask, never whether it was true or wise: a model that follows every rule can still
 * be wrong. It needs a real model, so it runs only when the owner presses the button, and the tasks never
 * change between runs.
 */

import { checkAnswer } from "../brain/answer-checks";
import { runVerified, type Rung } from "../brain/verified-run";

export type InstructionTask = { id: string; prompt: string };

export const INSTRUCTION_TASKS: readonly InstructionTask[] = [
  { id: "words-8", prompt: "Explain what a firewall does in at most 8 words." },
  { id: "words-min", prompt: "Describe the benefits of walking daily in at least 40 words." },
  { id: "one-word", prompt: "What is the capital of France? Answer in one word." },
  { id: "bullets-3", prompt: "Give exactly 3 bullet points on why backups matter." },
  { id: "bullets-5", prompt: "List 5 bullet points about keeping a laptop battery healthy." },
  { id: "lines-4", prompt: "Explain what DNS is. Answer in at most 4 short lines." },
  { id: "sentences-2", prompt: "Explain recursion in 2 sentences." },
  { id: "lower", prompt: "Say hello and wish me a good day, all in lowercase." },
  { id: "upper", prompt: "Warn me that the disk is almost full, in all caps." },
  { id: "commas", prompt: "Describe a sunrise in one sentence without any commas." },
  { id: "include", prompt: 'Write two lines about saving money. Include the word "budget".' },
  { id: "exclude", prompt: 'Describe a good meeting. Do not use the word "very".' },
  { id: "end", prompt: 'Give me one tip for sleeping better. End your answer with "Sleep well."' },
  { id: "start", prompt: 'Tell me a fun fact about owls. Start your answer with "Fun fact:"' },
  { id: "json-keys", prompt: "Return details of a book as JSON with keys title, author and year." },
  { id: "json-list", prompt: "Return three fruit names as JSON." },
  { id: "hindi", prompt: "Explain what the internet is in Hindi in at most 30 words." },
  { id: "sum-1", prompt: "What is 487 * 36?" },
  { id: "sum-2", prompt: "Calculate (1250 + 340) / 5 - 12" },
  {
    id: "combo",
    prompt:
      'In exactly 3 bullet points, all lowercase, no commas, explain why we test code. Include the word "bugs".',
  },
];

export type InstructionEvalReport = {
  tasks: number;
  /** Tasks whose first, unaided answer kept every rule. */
  bare: number;
  /** Tasks whose final answer through the loop kept every rule. */
  brain: number;
  /** Tasks that needed a retry or a higher rung to get there. */
  repaired: number;
  /** Tasks where nothing passed, with the rule that stayed broken. */
  stuck: { id: string; why: string }[];
  /** Model calls used in total (bare plus the loop, the first answer being shared). */
  calls: number;
  /** Tasks that could not be answered at all (the model was unreachable). */
  unanswered: number;
  caveat: string;
};

export async function runInstructionEval(input: {
  ask: (prompt: string, rung: Rung) => Promise<string>;
  rungs: Rung[];
  tasks?: readonly InstructionTask[];
  onProgress?: (done: number, total: number) => void;
}): Promise<InstructionEvalReport> {
  const tasks = input.tasks ?? INSTRUCTION_TASKS;
  const first = input.rungs[0];
  let bare = 0;
  let brain = 0;
  let repaired = 0;
  let calls = 0;
  let unanswered = 0;
  const stuck: InstructionEvalReport["stuck"] = [];
  let done = 0;
  for (const task of tasks) {
    // The unaided answer is also the loop's first attempt, so the comparison costs no extra call.
    let firstAnswer: string | null = null;
    let used = false;
    try {
      if (first) {
        firstAnswer = await input.ask(task.prompt, first);
        calls += 1;
      }
    } catch {
      firstAnswer = null;
    }
    const bareOk = firstAnswer !== null && checkAnswer(task.prompt, firstAnswer).ok;
    if (bareOk) bare += 1;
    const out = await runVerified({
      prompt: task.prompt,
      rungs: input.rungs,
      ask: async (prompt, rung) => {
        if (!used && firstAnswer !== null && rung === first && prompt === task.prompt) {
          used = true;
          return firstAnswer;
        }
        calls += 1;
        return input.ask(prompt, rung);
      },
    });
    if (!out.answer) unanswered += 1;
    const finalOk = out.answer ? checkAnswer(task.prompt, out.answer).ok : false;
    if (finalOk) {
      brain += 1;
      if (!bareOk) repaired += 1;
    } else if (out.answer) {
      stuck.push({ id: task.id, why: out.note.replace(/^.*still failing:\s*/, "") });
    }
    done += 1;
    input.onProgress?.(done, tasks.length);
  }
  return {
    tasks: tasks.length,
    bare,
    brain,
    repaired,
    stuck,
    calls,
    unanswered,
    caveat:
      "These count whether the rules of the ask were kept (limits, bullets, JSON, language, a sum). They do not measure whether an answer is true, wise or well written.",
  };
}

export function describeInstructionEval(report: InstructionEvalReport): string {
  const pct = (n: number) => `${Math.round((n / Math.max(1, report.tasks)) * 100)}%`;
  return [
    `Rules kept, ${report.tasks} fixed asks on your model: as it is ${pct(report.bare)} (${report.bare}) · through FRIDAY's loop ${pct(report.brain)} (${report.brain}) · ${report.repaired} repaired · ${report.calls} model calls.`,
    report.unanswered
      ? `${report.unanswered} ask(s) got no answer: the model was unreachable.`
      : "",
    report.stuck.length
      ? `Still broken after the loop: ${report.stuck.map((row) => `${row.id} (${row.why.slice(0, 60)})`).join("; ")}`
      : "",
    report.caveat,
  ]
    .filter(Boolean)
    .join("\n");
}
