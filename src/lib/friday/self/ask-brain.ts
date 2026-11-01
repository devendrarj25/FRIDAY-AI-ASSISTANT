/**
 * FRIDAY · ask the whole Brain and wait for the finished turn
 *
 * `askFriday` goes straight to a model. A real turn goes through the Core Brain first: intent, memory, routing,
 * the checks and the one repair. To measure the Brain and not just a model, a request has to take the real
 * turn. This sends it the way typed chat does (`brain.send`) and waits until the run is finished, then returns
 * the answer. It waits for a busy Brain to be idle first, and gives up after the time it was given.
 */

import type { Run } from "../brain-engine";

export type BrainLike = {
  send: (prompt: string) => { accepted: boolean; reason?: string; message?: string | null };
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { activeRunId: string | null; runs: Run[] };
};

export type BrainAnswer = { answer: string; verified: boolean };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function askBrain(
  prompt: string,
  options: { brain: BrainLike; timeoutMs?: number; idleWaitMs?: number },
): Promise<BrainAnswer> {
  const { brain } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const idleUntil = Date.now() + (options.idleWaitMs ?? 30_000);
  while (brain.getSnapshot().activeRunId && Date.now() < idleUntil) await wait(100);
  const before = new Set(brain.getSnapshot().runs.map((run) => run.id));
  const sent = brain.send(prompt);
  if (!sent.accepted)
    throw new Error(
      sent.message || `the Brain did not take the request (${sent.reason ?? "busy"})`,
    );
  return new Promise<BrainAnswer>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      fn();
    };
    const look = () => {
      const snapshot = brain.getSnapshot();
      const run = snapshot.runs.find(
        (row) => !before.has(row.id) && row.prompt.trim() === prompt.trim(),
      );
      if (
        !run ||
        snapshot.activeRunId === run.id ||
        run.state === "running" ||
        run.state === "awaiting-approval"
      )
        return;
      finish(() =>
        run.state === "failed" && !run.answer.trim()
          ? reject(new Error("the turn failed without an answer"))
          : resolve({ answer: run.answer, verified: run.state === "done" }),
      );
    };
    const off = brain.subscribe(look);
    const timer = setTimeout(
      () => finish(() => reject(new Error("the Brain did not finish in time"))),
      timeoutMs,
    );
    look();
  });
}
