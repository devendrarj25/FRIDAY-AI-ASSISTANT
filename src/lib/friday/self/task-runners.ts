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
import { taskGraph } from "./task-graph";
import { extractDeadline, looksLikeHorizonGoal } from "./horizon-goals";
import { desktopAsk, planDesktop, runComputerUse } from "./computer-use";
import { timelineFromEvidence } from "./run-receipt";

let wired = false;

export function registerTaskRunners(): void {
  if (wired) return;
  wired = true;

  taskGraph.registerRunner("goal", async ({ node, signal, log }) => {
    const desktop = typeof window !== "undefined" ? window.friday : undefined;
    if (!desktop) {
      return { ok: false, result: "the kernel is only available in the desktop app" };
    }
    log(`running "${node.title}" through the kernel task planner`);
    const outcome = await kernelApi.tasks.run(node.instruction);
    if (signal.aborted) return { ok: false, result: "paused before the result was recorded" };
    const done = Boolean((outcome as { done?: boolean } | null)?.done);
    return {
      ok: done,
      result: done ? `kernel completed: ${node.title}` : "kernel did not report completion",
      tools: ["kernel.task.run"],
    };
  });

  taskGraph.registerRunner("desktop", async ({ node, signal, log }) => {
    const settings = autonomy.getSnapshot();
    log(`desktop step "${node.title}"`);
    const report = await runComputerUse({
      request: node.instruction,
      source: "task",
      level: settings.approvalLevel,
      halted: settings.halted || signal.aborted,
      signal,
      budget: { timeMs: 120_000, maxSteps: 4, spend: 0, tokens: 0 },
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
    /\band (also|then)\b/i.test(message);
  // A running background job must not capture ordinary conversation. Only a
  // second real job (numbered / "then" / explicit background hint) or a long
  // action sentence queues while she is already busy.
  if (!multiStep && !(busy && message.length >= 40)) return null;

  const deadline = extractDeadline(message);
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
