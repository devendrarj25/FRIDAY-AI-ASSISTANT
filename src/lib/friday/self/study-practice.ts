/**
 * FRIDAY · idle study that actually practises
 *
 * Idle study used to file "Practise: <weakness>" and stop. Once the owner approves the item (or his dial lets
 * it run), this does the practice: the model is asked for one short program for the practice task, and the
 * answer is held to the same checks as any answer, including running the code in FRIDAY's scratch sandbox.
 * A pass counts toward the curriculum (the next practice is harder); a miss is reported as it is. It never
 * touches FRIDAY's own source and never runs without the item having passed governance.
 */

import { readLocalState, writeState } from "../persist";
import type { StudyTask } from "./skill-loop";
import type { VerifiedResult } from "../brain/verified-run";
import type { ToolPort } from "../brain/tool-checks";

export type PracticeDeps = {
  ask: (prompt: string, options: { tools?: ToolPort }) => Promise<VerifiedResult>;
  port: ToolPort | undefined;
};

const KEY = "friday.study-successes.v1";
let successes: Record<string, number> | null = null;

export function studySuccesses(): Record<string, number> {
  if (!successes) {
    const stored = readLocalState<Record<string, number>>(KEY);
    successes = stored && typeof stored === "object" ? { ...stored } : {};
  }
  return successes;
}

export function resetStudyForTests(): void {
  successes = {};
  writeState(KEY, {});
}

export function practicePrompt(task: Pick<StudyTask, "task" | "band">): string {
  return [
    `Practice (${task.band}): ${task.task}`,
    "Write a short python script for it in one code block. It must run on its own and print its result.",
  ].join("\n");
}

export async function practiceInSandbox(
  task: Pick<StudyTask, "id" | "title" | "task" | "band">,
  deps: PracticeDeps,
): Promise<{ ok: boolean; detail: string }> {
  if (!deps.port?.runCode) {
    return {
      ok: false,
      detail: "the sandbox is not available (it runs in the desktop app) so nothing was practised",
    };
  }
  let result: VerifiedResult;
  try {
    result = await deps.ask(practicePrompt(task), { tools: deps.port });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!result.answer) return { ok: false, detail: "no model answered" };
  const ran = result.checked.includes("runnable-code") && result.verified;
  if (ran) {
    const now = studySuccesses();
    now[task.id] = (now[task.id] ?? 0) + 1;
    writeState(KEY, now);
    return {
      ok: true,
      detail: `practised "${task.title}": the script ran (${now[task.id]} success(es))`,
    };
  }
  return { ok: false, detail: `practised "${task.title}": ${result.note}`.slice(0, 300) };
}
