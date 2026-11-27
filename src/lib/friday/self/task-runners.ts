/**
 * FRIDAY · task graph runners + intake
 *
 * The graph engine only schedules; the real work stays where it already lives.
 *  - "goal" subtasks run through the kernel task planner (tools, approvals and
 *    permission gates included) exactly like any other FRIDAY action.
 *  - "self-improve" subtasks run one autonomous-core cycle, which is her
 *    existing self-diagnosis / dev-pipeline / skill-forge backlog.
 *
 * Intake decides — conservatively — when a chat message is really a long,
 * multi-step job that belongs in the background instead of the chat turn.
 */

import kernelApi from "../kernel-api";
import { autonomousCore } from "./autonomous-core";
import { autonomy } from "./autonomy";
import { parallelParts, taskGraph, withEarlier, type RunnerResult } from "./task-graph";
import { extractDeadline, looksLikeHorizonGoal, trackGoalDeadline } from "./horizon-goals";
import { desktopAsk, planDesktop, runComputerUse } from "./computer-use";
import { timelineFromEvidence } from "./run-receipt";
import { ledger } from "./task-ledger";
import {
  listVoiceTasks,
  startVoiceTask,
  subscribeVoiceTasks,
  voiceTaskActions,
} from "../voice-engine/voice-tasks";

let wired = false;

/** How long a background step waits for the owner's yes before it parks as "waiting" (the queue moves on). */
let approvalWaitMs = 5 * 60_000;

/** Test and settings seam: the wait for the owner's answer. */
export function configureTaskRunners(options: { approvalWaitMs?: number }): void {
  if (typeof options.approvalWaitMs === "number" && options.approvalWaitMs > 0) {
    approvalWaitMs = options.approvalWaitMs;
  }
}

export type OwnerAnswer = "yes" | "no" | "timeout" | "aborted";

/**
 * Ask the owner about one background step. The question goes to the Tasks approvals (the on-screen Approve and
 * Deny) and to the voice desk as a task waiting for approval (the spoken yes, with its own short, bound and
 * expiring rules). The first answer wins and closes the other prompt. No answer in time, or Stop everything,
 * is never a yes.
 */
export function askOwnerToApprove(
  question: string,
  signal: AbortSignal,
  waitMs = approvalWaitMs,
): Promise<OwnerAnswer> {
  if (signal.aborted || autonomy.getSnapshot().halted) return Promise.resolve("aborted");
  return new Promise<OwnerAnswer>((resolve) => {
    let settled = false;
    let ledgerId = "";
    let voiceId = "";
    let stopListening: () => void = () => undefined;
    const finish = (answer: OwnerAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stopListening();
      const yes = answer === "yes";
      if (ledgerId && ledger.getSnapshot().approvals.some((row) => row.taskId === ledgerId)) {
        ledger.answerApproval(ledgerId, yes);
      }
      const voice = voiceId ? listVoiceTasks().find((task) => task.id === voiceId) : undefined;
      if (voice?.state === "WAITING_FOR_APPROVAL") voiceTaskActions.approve(voiceId, yes);
      resolve(answer);
    };
    const onAbort = () => finish("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish("timeout"), waitMs);
    ledgerId = ledger.run(
      { kind: "approval", title: question, key: `approval:${question}:${Date.now()}` },
      async (context) => {
        const allowed = await context.approval(question);
        finish(allowed ? "yes" : "no");
        return allowed;
      },
    ).id;
    const voice = startVoiceTask(
      question,
      async () => {
        finish("yes");
        return "approved";
      },
      "needs-approval",
    );
    if (voice.ok) {
      voiceId = voice.task.id;
      stopListening = subscribeVoiceTasks(() => {
        const task = listVoiceTasks().find((item) => item.id === voiceId);
        if (task && (task.state === "CANCELLED" || task.state === "FAILED")) finish("no");
      });
    }
  });
}

/** What kernel task.run, task.approve and task.resume answer (kernel/main.py `_collect_task`). */
export type KernelTaskOutcome = {
  done?: boolean;
  state?: string;
  taskId?: string | null;
  results?: unknown[];
  error?: string;
  pendingApproval?: { stepId?: string; tool?: string; risk?: string } | null;
} | null;

/**
 * The subtask result from what the kernel task really ended as. Only a terminal `done` is ok and checked. A task
 * stopped at an approval gate waits (and keeps its task id and step, so the yes reaches the same task); failed,
 * cancelled and anything unknown are not ok.
 */
export function mapKernelOutcome(
  title: string,
  outcome: KernelTaskOutcome,
): RunnerResult & {
  kernelTaskId?: string;
} {
  const taskId = outcome?.taskId ? String(outcome.taskId) : "";
  const withId = taskId ? { kernelTaskId: taskId } : {};
  const state = String(outcome?.state ?? (outcome?.done ? "done" : ""));
  if (state === "done" && outcome?.done !== false) {
    const steps = Array.isArray(outcome?.results) ? outcome.results.length : 0;
    return {
      ok: true,
      result: `kernel completed: ${title}${steps ? ` (${steps} step(s))` : ""}`,
      tools: ["kernel.task.run"],
      checked: true,
      postcondition: "kernel reported the task done",
      pendingApproval: null,
      ...withId,
    };
  }
  if (state === "waiting-approval") {
    const pending = outcome?.pendingApproval ?? {};
    const tool = String(pending.tool ?? "a step");
    return {
      ok: false,
      waiting: true,
      result: `waiting on your approval for ${tool}`,
      tools: ["kernel.task.run"],
      checked: false,
      postcondition: "",
      pendingApproval: {
        stepId: String(pending.stepId ?? ""),
        tool,
        risk: String(pending.risk ?? "write"),
      },
      ...withId,
    };
  }
  const why = outcome ? `${state || "unknown"}${outcome.error ? `: ${outcome.error}` : ""}` : "";
  return {
    ok: false,
    result: outcome ? `kernel task ${why}` : "the kernel did not answer",
    tools: ["kernel.task.run"],
    checked: false,
    postcondition: "",
    pendingApproval: null,
    ...withId,
  };
}

/** Resolves when the signal aborts, so a stopped subtask does not wait for a kernel answer that may never come. */
function untilAborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

const HELD = "held: Stop everything is on";
const MAX_GATES = 8;

export function registerTaskRunners(): void {
  if (wired) return;
  wired = true;

  // A cancelled graph cancels the kernel task its waiting step belongs to.
  taskGraph.onCancel((graph) => {
    for (const node of graph.nodes) {
      const taskId = node.checkpoint?.kernelTaskId;
      if (taskId && node.checkpoint?.pendingApproval) {
        void kernelApi.tasks.cancel(taskId).catch(() => undefined);
      }
    }
  });

  taskGraph.registerRunner("goal", async ({ graph, node, signal, log, earlier }) => {
    if (autonomy.getSnapshot().halted) return { ok: false, waiting: true, result: HELD };
    const desktop = typeof window !== "undefined" ? window.friday : undefined;
    if (!desktop) {
      return { ok: false, result: "the kernel is only available in the desktop app" };
    }
    const paused = { ok: false, result: "paused before the result was recorded" };
    const prior = node.checkpoint;
    let outcome: KernelTaskOutcome;
    if (prior?.kernelTaskId && prior.pendingApproval?.stepId) {
      // The same kernel task is still waiting on the owner: never start a second one for this step.
      outcome = {
        done: false,
        state: "waiting-approval",
        taskId: prior.kernelTaskId,
        pendingApproval: prior.pendingApproval,
      };
    } else {
      log(`running "${node.title}" through the kernel task planner`);
      const running = kernelApi.tasks.run(withEarlier(node.instruction, earlier));
      // A run still going when the graph is cancelled is cancelled once its task id is known.
      void running
        .then((late) => {
          const id = (late as KernelTaskOutcome)?.taskId;
          const state = (late as KernelTaskOutcome)?.state;
          if (
            id &&
            state === "waiting-approval" &&
            taskGraph.get(graph.id)?.state === "cancelled"
          ) {
            void kernelApi.tasks.cancel(String(id)).catch(() => undefined);
          }
        })
        .catch(() => undefined);
      const first = await Promise.race([running, untilAborted(signal)]);
      if (first === "aborted" || signal.aborted) return paused;
      outcome = first as KernelTaskOutcome;
    }

    for (let gate = 0; gate < MAX_GATES; gate += 1) {
      const mapped = mapKernelOutcome(node.title, outcome);
      if (!mapped.waiting || !mapped.kernelTaskId || !mapped.pendingApproval) return mapped;
      const { stepId, tool, risk } = mapped.pendingApproval;
      log(`waiting on the owner: ${tool} (${risk})`, "warn");
      const answer = await askOwnerToApprove(
        `Allow ${tool} (${risk}) for "${node.title.slice(0, 80)}"?`,
        signal,
      );
      if (answer === "aborted" || signal.aborted) return { ...paused, ...pick(mapped) };
      if (answer === "timeout") return mapped;
      if (answer === "no") {
        await kernelApi.tasks.approve(mapped.kernelTaskId, stepId, false).catch(() => null);
        log(`the owner declined ${tool}`, "warn");
        taskGraph.cancel(graph.id);
        return {
          ok: false,
          result: `you declined ${tool}`,
          checked: false,
          pendingApproval: null,
          kernelTaskId: mapped.kernelTaskId,
        };
      }
      const next = await Promise.race([
        kernelApi.tasks.approve(mapped.kernelTaskId, stepId, true).catch(() => null),
        untilAborted(signal),
      ]);
      if (next === "aborted" || signal.aborted) return paused;
      outcome = next as KernelTaskOutcome;
    }
    return { ok: false, result: "too many approval gates in one subtask", pendingApproval: null };
  });

  taskGraph.registerRunner("desktop", async ({ node, signal, log, earlier }) => {
    const settings = autonomy.getSnapshot();
    log(`desktop step "${node.title}"`);
    const report = await runComputerUse({
      request: withEarlier(node.instruction, earlier),
      source: "task",
      level: settings.approvalLevel,
      halted: settings.halted || signal.aborted,
      isHalted: () => autonomy.getSnapshot().halted || signal.aborted,
      approve: async (question) => (await askOwnerToApprove(question, signal)) === "yes",
      signal,
      budget: { timeMs: 120_000, maxSteps: 4, spend: 0, tokens: 0 },
      codeMap: (path, budget) => kernelApi.tools.exec("code.map", { path, budget }),
    });
    const evidenceId = report.evidence[0]?.evidenceId;
    const timeline = timelineFromEvidence(report.evidence);
    return {
      ok: report.ok,
      waiting: report.needsOwner,
      result: report.summary,
      tools: ["desktop"],
      checked: report.ok,
      postcondition: report.evidence[0]?.postcondition ?? "",
      ...(evidenceId ? { evidenceId } : {}),
      ...(timeline.length ? { timeline } : {}),
    };
  });

  taskGraph.registerRunner("self-improve", async ({ signal, log }) => {
    if (autonomy.getSnapshot().halted) return { ok: false, waiting: true, result: HELD };
    const cycle = await autonomousCore.cycle();
    if (signal.aborted) return { ok: false, result: "paused for the owner" };
    const note = cycle ? cycle.note : "nothing to improve right now";
    log(note, "ok");
    return { ok: true, result: note };
  });
}

/* ------------------------------------------------------------- intake */

const ACTION =
  /\b(build|create|make|write|generate|fix|refactor|install|import|organise|organize|reconcile|prepare|process|audit|review|scan|update|migrate|clean|export|summarise|summarize|calculate|file|send|collect)\b/i;
const LONG_HINT =
  /\b(in the background|background|take your time|long task|when you can|step by step|one by one|all of|every)\b/i;
const QUESTION =
  /^(what|who|when|where|why|how|is|are|do|does|can|could|should|will|tell me|explain)\b/i;
/** Conversational / settings talk that must never become a background job. */
const CHAT_KEEP =
  /\b(make sure|make sense|update me|remind me|remember (that|this|it)|write that down|let me know|keep (it|that) in mind|hands[- ]?free|wake word|free only|prefer free|allow paid|spoken replies|voice replies|attention window)\b/i;

export type Intake = { id: string; message: string; position: number; queued: boolean } | null;

/**
 * Returns a reply when the message was taken as a background job. Chat is never
 * blocked: a normal question or small talk always returns null and flows on to
 * the usual brain-engine path.
 */
/**
 * A desktop sentence becomes a checkpointed graph on the same engine as any
 * other long task. Ordinary chat does not match `desktopAsk`.
 */
export function considerDesktopTask(text: string): Intake {
  const message = text.trim();
  if (!desktopAsk(message)) return null;
  const planned = planDesktop(message);
  if (!planned.actions.length) return null;
  registerTaskRunners();
  const { id, position, queued } = taskGraph.submit(message, {
    kind: "desktop",
    maxAttempts: 3,
    budget: { timeMs: 120_000, maxSteps: planned.actions.length, spend: 0, tokens: 0 },
    nodes: planned.actions.map((step) => ({
      title: `${step.kind} ${step.target}`,
      instruction: instructionFor(step),
      kind: "desktop",
    })),
  });
  const count = planned.actions.length;
  return {
    id,
    position,
    queued,
    message: queued
      ? `Queued on the desktop — ${count} step(s), number ${position} in line.`
      : `Started on the desktop — ${count} step(s), checkpointed after each one.`,
  };
}

/** Keeps the kernel task id and the waiting step on a paused subtask, so a resume asks again instead of re-running. */
function pick(mapped: {
  kernelTaskId?: string;
  pendingApproval?: RunnerResult["pendingApproval"];
}) {
  return {
    ...(mapped.kernelTaskId ? { kernelTaskId: mapped.kernelTaskId } : {}),
    ...(mapped.pendingApproval ? { pendingApproval: mapped.pendingApproval } : {}),
  };
}

function instructionFor(step: { kind: string; target: string; payload: string }): string {
  if (step.kind === "type") return `type ${step.payload} into ${step.target}`;
  if (step.kind === "drag") return `drag ${step.target} to ${step.payload}`;
  if (step.kind === "copy") return `copy ${step.payload}`;
  if (step.kind === "file-read") return `read file ${step.target}`;
  if (step.kind === "file-write") return `write file ${step.target} ${step.payload}`;
  if (step.kind === "hotkey") return `press ${step.target}`;
  if (step.kind === "clipboard-write") return `copy ${step.payload}`;
  if (step.kind === "clipboard-read") return "paste";
  return `${step.kind} ${step.target}`.trim();
}

export function considerLongTask(text: string): Intake {
  const message = text.trim();
  if (message.length < 24) return null;
  if (QUESTION.test(message)) return null;
  if (CHAT_KEEP.test(message)) return null;
  if (!ACTION.test(message)) return null;

  const steps = message.split(/\n\s*(?:\d+[.)]|[-*•])\s+/).length - 1;
  const busy = taskGraph.busy();
  const multiStep =
    steps >= 2 ||
    /\bthen\b/i.test(message) ||
    LONG_HINT.test(message) ||
    /\bmeanwhile\b/i.test(message) ||
    /\band (also|then)\b/i.test(message) ||
    parallelParts(message) !== null;
  // A running background job must not capture ordinary conversation. Only a
  // second real job (numbered / "then" / explicit background hint) or a long
  // action sentence queues while she is already busy.
  if (!multiStep && !(busy && message.length >= 40)) return null;

  const deadline = extractDeadline(message);
  // A goal with a deadline ("by friday") also becomes a to-do with that due time, so the heads-up and the
  // reminder fire for it like any other task. Once per goal.
  if (looksLikeHorizonGoal(message)) trackGoalDeadline(message);
  const { id, position, queued } = taskGraph.submit(
    message,
    looksLikeHorizonGoal(message)
      ? { horizon: { goal: message, ...(deadline ? { deadline } : {}) } }
      : {},
  );
  const graph = taskGraph.get(id);
  const count = graph?.nodes.length ?? 1;
  const running = taskGraph.running();

  const reply = queued
    ? [
        `Queued — that is ${count} subtask(s), number ${position} in line.`,
        running ? `I am still on: ${running.request.slice(0, 120)}` : "",
        "Nothing is dropped; I start it as soon as the current task is done. Say “interrupt” if you want me to switch now.",
      ]
    : [
        `Started in the background — ${count} subtask(s), checkpointed after each one.`,
        "It keeps running even if you close this view, and I will tell you when it is done. Ask me anything else meanwhile.",
      ];

  return { id, position, queued, message: reply.filter(Boolean).join("\n") };
}

/** Keeps one idle self-improvement graph available for quiet moments. */
export function ensureIdleWork(): string {
  registerTaskRunners();
  const open = taskGraph
    .list()
    .find(
      (graph) => graph.priority === "idle" && ["queued", "running", "paused"].includes(graph.state),
    );
  if (open) {
    if (open.state === "paused" && !taskGraph.busy()) taskGraph.resume(open.id);
    return open.id;
  }
  const { id } = taskGraph.submit("Self-improvement pass", {
    priority: "idle",
    kind: "self-improve",
    nodes: [
      { title: "Review my own backlog", instruction: "self-diagnosis and dev-pipeline pass" },
    ],
  });
  return id;
}

/* --------------------------------------------------------- queue commands */

const DONE_NODE = new Set(["completed", "verified"]);

/** Real progress from checkpoints — never invented percentages. */
function describeGraph(graph: ReturnType<typeof taskGraph.list>[number]): string {
  const total = graph.nodes.length;
  const done = graph.nodes.filter((node) => DONE_NODE.has(node.state)).length;
  const failed = graph.nodes.filter((node) => node.state === "failed");
  const current = graph.nodes.find((node) => node.state === "running" || node.state === "retrying");
  const checkpoint =
    current?.checkpoint ?? [...graph.nodes].reverse().find((node) => node.checkpoint)?.checkpoint;
  const label = graph.state.charAt(0).toUpperCase() + graph.state.slice(1);
  const lines = [
    `${label}: ${graph.request.slice(0, 140)}`,
    total
      ? `${done} of ${total} subtask(s) finished${current ? ` — now: ${current.title}` : ""}.`
      : "No subtasks recorded.",
  ];
  if (checkpoint?.done) lines.push(`Done: ${checkpoint.done}`);
  if (checkpoint?.remaining) lines.push(`Remaining: ${checkpoint.remaining}`);
  if (checkpoint?.nextAction) lines.push(`Next: ${checkpoint.nextAction}`);
  if (failed.length) {
    lines.push(
      `Failed: ${failed
        .map((node) => `${node.title}${node.error ? ` (${node.error})` : ""}`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The owner's direct control over the queue, answered by FRIDAY herself from
 * the live graph — "how much is complete?", "what failed?", "continue that
 * task", plus the original "task status" / "interrupt" / "resume task".
 * Returns null for anything else so ordinary chat is not stolen.
 */
export function handleQueueCommand(text: string): string | null {
  const message = text.trim().toLowerCase();
  const snapshot = taskGraph.getSnapshot();
  const running = taskGraph.running();
  const graphs = taskGraph.list();

  const statusAsk =
    /^(task|queue)\s*(status|list)\b/.test(message) ||
    /\bhow much (is |has )?(been )?(complete|done|finished)\b/.test(message) ||
    /\b(what(?:'s| is) the progress|progress on (the )?task|how(?:'s| is) the (current )?task)\b/.test(
      message,
    ) ||
    /^(what(?:'s| is) running|status of (the )?(task|queue))\b/.test(message);

  if (statusAsk) {
    if (!running && !snapshot.queue.length) {
      const recent = graphs.find(
        (graph) =>
          graph.state === "paused" || graph.state === "interrupted" || graph.state === "failed",
      );
      if (recent) return describeGraph(recent);
      return "No background task is running, and nothing is queued.";
    }
    const lines = [
      running ? describeGraph(running) : "Nothing running.",
      ...snapshot.queue.map((entry) => `${entry.position}. ${entry.request.slice(0, 120)}`),
    ];
    return lines.join("\n");
  }

  const failAsk =
    /\bwhat failed\b/.test(message) ||
    /\bwhich (sub)?task failed\b/.test(message) ||
    (/\bfailed\b/.test(message) && /\b(task|queue|background|subtask)\b/.test(message));
  if (failAsk) {
    const broken = graphs.filter(
      (graph) => graph.state === "failed" || graph.nodes.some((node) => node.state === "failed"),
    );
    if (!broken.length) {
      if (/\b(task|queue|background|subtask)\b/.test(message))
        return "No background task has a recorded failure.";
      return null;
    }
    return broken.map(describeGraph).join("\n\n");
  }

  if (/^(interrupt|stop the current task|switch now)\b/.test(message)) {
    if (!running) return "There is nothing running to interrupt.";
    taskGraph.interrupt(running.id);
    return `Interrupted and checkpointed: ${running.request.slice(0, 140)}\nThe next queued task starts now; say “resume task” to put it back.`;
  }

  if (/^(pause all( the)?( tasks?)?|pause every task)\b/.test(message)) {
    const n = taskGraph.pauseAll();
    return n ? `Paused ${n} running graph(s).` : "There is nothing running to pause.";
  }

  if (/^(pause (the )?(current )?task|pause (the )?queue)\b/.test(message)) {
    if (!running) return "There is nothing running to pause.";
    taskGraph.pause(running.id);
    return `Paused and checkpointed: ${running.request.slice(0, 140)}`;
  }

  if (/^(cancel (the )?(current )?task|drop (the )?(current )?task)\b/.test(message)) {
    if (running) {
      taskGraph.cancel(running.id);
      return `Cancelled: ${running.request.slice(0, 140)}`;
    }
    const next = snapshot.queue[0];
    if (!next) return "There is nothing to cancel.";
    taskGraph.cancel(next.id);
    return `Cancelled: ${next.request.slice(0, 140)}`;
  }

  if (/^(retry (the )?task|try (the )?task again)\b/.test(message)) {
    const failed = graphs.find((graph) => graph.state === "failed" || graph.state === "cancelled");
    if (!failed) return "Nothing failed to retry.";
    taskGraph.retry(failed.id);
    return `Retrying from the last checkpoint: ${failed.request.slice(0, 140)}`;
  }

  if (/^(run (the )?task again|run it again)\b/.test(message)) {
    const done = graphs.find(
      (graph) =>
        graph.state === "completed" || graph.state === "failed" || graph.state === "cancelled",
    );
    if (!done) return "Nothing finished to run again.";
    taskGraph.requeue(done.id);
    return `Queued again: ${done.request.slice(0, 140)}`;
  }

  if (/^(resume all( the)?( tasks?)?|resume every task)\b/.test(message)) {
    const n = taskGraph.resumeAllPaused();
    return n ? `Resumed ${n} held graph(s).` : "Nothing is waiting to resume.";
  }

  if (
    /^resume (the )?task\b/.test(message) ||
    /\bcontinue (that|the|this) task\b/.test(message) ||
    /^keep going\b/.test(message)
  ) {
    const held = graphs.find((graph) => graph.state === "paused" || graph.state === "interrupted");
    if (!held) return "Nothing is waiting to resume.";
    taskGraph.resume(held.id);
    const next = held.nodes.find((node) => !DONE_NODE.has(node.state));
    const from = next?.checkpoint?.nextAction || next?.title || "the last checkpoint";
    return `Resuming from ${from}: ${held.request.slice(0, 140)}`;
  }

  return null;
}
