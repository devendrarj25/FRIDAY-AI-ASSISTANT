/**
 * FRIDAY · durable task graph
 *
 * A long request becomes a graph of ordered subtasks. Every subtask has a real
 * state, a bounded retry budget and a checkpoint written the moment it ends —
 * what was done, what is left, which files/models/tools were involved, the
 * result and the next action. The whole graph is persisted through the same
 * `persist` layer the task ledger and governance already use, so a restart
 * mid-task reloads the last safe checkpoint and continues instead of starting
 * over.
 *
 * Scheduling rules (deliberately small, no second scheduler):
 *  - One owner graph runs at a time; further owner requests QUEUE, they are
 *    never dropped, and never silently interrupt the running one.
 *  - Chat is untouched: this layer never blocks the brain-engine chat path.
 *  - Idle graphs (her own self-improvement backlog) only run when no owner
 *    work is queued or running, and pause — checkpointed — the instant the
 *    owner is active again.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { learning, recallProcedure, rememberProcedure } from "./learning-engine";
import { COGNITIVE_BASELINE } from "../brain/cognitive-baseline";

export type NodeState =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "paused"
  | "failed"
  | "retrying"
  | "completed"
  | "verified";

export type GraphState = "queued" | "running" | "paused" | "failed" | "completed" | "cancelled";

export type GraphPriority = "owner" | "idle";

/** Everything needed to resume this subtask after a restart. */
export type Checkpoint = {
  at: number;
  done: string;
  remaining: string;
  files: string[];
  models: string[];
  tools: string[];
  result: string;
  nextAction: string;
};

export type GraphNode = {
  id: string;
  title: string;
  instruction: string;
  /** Which runner executes it. */
  kind: string;
  /** Action vs the outcome that action is meant to achieve. */
  purpose?: "action" | "outcome";
  dependsOn: string[];
  state: NodeState;
  attempts: number;
  maxAttempts: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  checkpoint?: Checkpoint;
};

export type GraphLog = { at: number; level: "info" | "ok" | "warn" | "error"; line: string };

export type HorizonGoal = {
  goal: string;
  /** Desired end-state, when distinct from a single action. */
  outcome?: string;
  deadline?: string;
  blockers: string[];
};

export type TaskGraph = {
  id: string;
  request: string;
  priority: GraphPriority;
  state: GraphState;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  nodes: GraphNode[];
  logs: GraphLog[];
  error?: string;
  /** Set once the completion notification has been raised. */
  announced?: boolean;
  /** Multi-session owner goal — same persist layer, not a second store. */
  horizon?: HorizonGoal;
};

export type TaskGraphState = {
  graphs: TaskGraph[];
  runningId: string | null;
  /** Owner graphs waiting their turn, in line order. */
  queue: { id: string; request: string; position: number }[];
  idlePaused: boolean;
};

export type RunnerContext = {
  graph: TaskGraph;
  node: GraphNode;
  signal: AbortSignal;
  log: (line: string, level?: GraphLog["level"]) => void;
  /** Progress checkpoint written while the node is still running. */
  checkpoint: (patch: Partial<Checkpoint>) => void;
};

export type RunnerResult = Partial<Omit<Checkpoint, "at">> & {
  /** false marks the node failed without throwing. */
  ok?: boolean;
  /** Set when the node needs the owner before it can go on. */
  waiting?: boolean;
};

export type NodeRunner = (context: RunnerContext) => Promise<RunnerResult | void>;

const STORAGE_KEY = "friday.task-graph.v1";
const MAX_GRAPHS = 40;
const MAX_LOGS = 60;
/** How long after an owner message idle work stays parked. */
export const IDLE_GRACE_MS = 90_000;

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const DONE: NodeState[] = ["completed", "verified"];
const OPEN_GRAPH: GraphState[] = ["queued", "running", "paused"];

const emptyCheckpoint = (): Checkpoint => ({
  at: Date.now(),
  done: "",
  remaining: "",
  files: [],
  models: [],
  tools: [],
  result: "",
  nextAction: "",
});

/* ------------------------------------------------------------------ plan */

const STEP_SPLIT = /\n\s*(?:\d+[.)]|[-*•])\s+/g;

const OUTCOME_ASK = /\b(so that|such that|until|achieve|make sure|goal is|outcome is|done when)\b/i;

export function stepPurpose(instruction: string): "action" | "outcome" {
  return OUTCOME_ASK.test(instruction) ? "outcome" : "action";
}

const CREATIVE = /\b(haiku|poem|joke|hello|hi\b|thanks)\b/i;

/** HTN-style methods shipped in the cognitive baseline — not a second planner. */
export function baselineMethodSteps(
  request: string,
): { title: string; instruction: string; purpose: "action" | "outcome" }[] | null {
  const text = String(request || "").trim();
  if (!text || CREATIVE.test(text)) return null;
  // Already-decomposed leftover work (replan) is a task network, not a compound
  // task — do not replace it with a shipped method (Ghallab/Nau/Traverso).
  if (/^continue:/i.test(text) || /\bremaining after blocker\b/i.test(text)) return null;
  const lower = text.toLowerCase();
  for (const method of COGNITIVE_BASELINE.methods) {
    const keys = method.trigger
      .split("|")
      .map((key) => key.trim())
      .filter(Boolean);
    if (!keys.some((key) => lower.includes(key))) continue;
    if (method.steps.length < 2) continue;
    return method.steps.map((step) => ({
      title: step.title,
      instruction: step.instruction,
      purpose: stepPurpose(step.instruction),
    }));
  }
  return null;
}

/**
 * Breaks a request into ordered subtasks using what the owner actually wrote:
 * a numbered/bulleted list first, then "then/after that/next" clauses, then
 * sentences. Never invents work that was not asked for.
 */
export function planNodes(
  request: string,
): { title: string; instruction: string; purpose: "action" | "outcome" }[] {
  const text = request.trim();
  const listed = text
    .split(STEP_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);

  let parts: string[];
  if (listed.length > 1) {
    // A leading "do this: " header is context, not a subtask.
    parts = listed[0]?.endsWith(":") ? listed.slice(1) : listed;
  } else {
    parts = text
      .split(/\b(?:,?\s*(?:and\s+)?then\b|after that\b|next,?\s|;)/i)
      .map((part) => part.trim().replace(/^(?:and|also)\s+/i, ""))
      .filter((part) => part.length > 2);
  }
  if (parts.length < 2) {
    const method = baselineMethodSteps(text);
    if (method?.length) return method;
    parts = [text];
  }

  return parts.map((instruction) => ({
    title: instruction.length > 68 ? `${instruction.slice(0, 65)}…` : instruction,
    instruction,
    purpose: stepPurpose(instruction),
  }));
}

/** Verified / total nodes — outcome progress, not just "actions started". */
export function graphProgress(graph: TaskGraph): {
  done: number;
  total: number;
  ratio: number;
  remaining: string[];
} {
  const total = graph.nodes.length || 1;
  const done = graph.nodes.filter((node) => DONE.includes(node.state)).length;
  const remaining = graph.nodes
    .filter((node) => !DONE.includes(node.state))
    .map((node) => node.title);
  return { done, total, ratio: done / total, remaining };
}

/* --------------------------------------------------------------- engine */

export class TaskGraphEngine {
  private graphs: TaskGraph[] = [];
  private runners = new Map<string, NodeRunner>();
  private listeners = new Set<() => void>();
  private snapshot: TaskGraphState = { graphs: [], runningId: null, queue: [], idlePaused: false };
  private controller: AbortController | null = null;
  private activeGraphId: string | null = null;
  private pumping = false;
  private lastActivityAt = 0;

  constructor() {
    this.hydrate();
  }

  /* ------------------------------------------------------------- store */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Loads a stored set of graphs (what the last session left on disk) and
   * brings anything that was mid-flight back to its last checkpoint.
   */
  hydrateFrom(stored: TaskGraph[] | null): void {
    if (!stored?.length) return;
    this.graphs = stored.map((graph) => this.recover(graph));
    this.emit();
    void this.pump();
  }

  private hydrate(): void {
    this.hydrateFrom(readLocalState<TaskGraph[]>(STORAGE_KEY));
    restoreFromDisk<TaskGraph[]>(STORAGE_KEY, (disk) => this.hydrateFrom(disk));
  }

  /**
   * Restart recovery: a node that was mid-flight when the app died goes back to
   * `ready` with its checkpoint intact, so the graph continues from the last
   * safe point instead of re-running finished work.
   */
  private recover(graph: TaskGraph): TaskGraph {
    const nodes = graph.nodes.map((node) =>
      node.state === "running" || node.state === "retrying"
        ? { ...node, state: "ready" as NodeState }
        : node,
    );
    const resumed = nodes.some((node, i) => node.state !== graph.nodes[i]?.state);
    const next: TaskGraph = {
      ...graph,
      nodes,
      state: graph.state === "running" ? "queued" : graph.state,
    };
    if (resumed) {
      const from = nodes.find((node) => node.state === "ready");
      this.log(
        next,
        `resumed after restart from checkpoint: ${from?.checkpoint?.nextAction || from?.title || "start"}`,
        "warn",
      );
    }
    return next;
  }

  private persist(): void {
    writeState(STORAGE_KEY, this.graphs.slice(0, MAX_GRAPHS));
  }

  private emit(): void {
    const queued = this.graphs
      .filter((g) => g.priority === "owner" && g.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    const running = this.graphs.find((g) => g.state === "running") ?? null;
    this.snapshot = {
      graphs: this.graphs.map((graph) => ({ ...graph, nodes: [...graph.nodes] })),
      runningId: running?.id ?? null,
      queue: queued.map((graph, index) => ({
        id: graph.id,
        request: graph.request,
        position: index + (running && running.priority === "owner" ? 1 : 0) + 1,
      })),
      idlePaused: this.graphs.some((g) => g.priority === "idle" && g.state === "paused"),
    };
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private log(graph: TaskGraph, line: string, level: GraphLog["level"] = "info"): void {
    graph.logs = [...graph.logs, { at: Date.now(), level, line }].slice(-MAX_LOGS);
    graph.updatedAt = Date.now();
  }

  /* ----------------------------------------------------------- runners */

  registerRunner(kind: string, runner: NodeRunner): void {
    this.runners.set(kind, runner);
  }

  hasRunner(kind: string): boolean {
    return this.runners.has(kind);
  }

  /* ------------------------------------------------------------ submit */

  /** Queues a request. Returns its id and its place in line (1 = running next). */
  submit(
    request: string,
    options: {
      priority?: GraphPriority;
      kind?: string;
      nodes?: { title: string; instruction: string; kind?: string }[];
      maxAttempts?: number;
      horizon?: { goal: string; deadline?: string; outcome?: string };
    } = {},
  ): { id: string; position: number; queued: boolean } {
    const priority = options.priority ?? "owner";
    const kind = options.kind ?? "goal";
    const reused = !options.nodes && priority === "owner" ? recallProcedure(request)?.steps : null;
    const planned = options.nodes ?? reused ?? planNodes(request);
    const graphId = newId(priority === "idle" ? "idle" : "graph");

    const nodes: GraphNode[] = planned.map((step, index) => ({
      id: `${graphId}-n${index + 1}`,
      title: step.title,
      instruction: step.instruction,
      kind: (step as { kind?: string }).kind ?? kind,
      purpose:
        (step as { purpose?: "action" | "outcome" }).purpose ?? stepPurpose(step.instruction),
      dependsOn: index === 0 ? [] : [`${graphId}-n${index}`],
      state: index === 0 ? "ready" : "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 2,
    }));

    const graph: TaskGraph = {
      id: graphId,
      request,
      priority,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes,
      logs: [],
      ...(options.horizon
        ? {
            horizon: {
              goal: options.horizon.goal,
              blockers: [],
              ...(options.horizon.deadline ? { deadline: options.horizon.deadline } : {}),
              ...(options.horizon.outcome ? { outcome: options.horizon.outcome } : {}),
            },
          }
        : {}),
    };
    this.log(
      graph,
      reused
        ? `reusing learned procedure — ${nodes.length} subtask(s)`
        : `planned ${nodes.length} subtask(s)`,
    );
    this.graphs = [graph, ...this.graphs].slice(0, MAX_GRAPHS);
    this.emit();
    void this.pump();

    const position = this.snapshot.queue.find((entry) => entry.id === graphId)?.position ?? 1;
    return { id: graphId, position, queued: this.busy() && position > 1 };
  }

  get(id: string): TaskGraph | undefined {
    return this.graphs.find((graph) => graph.id === id);
  }

  list(): TaskGraph[] {
    return [...this.graphs];
  }

  /**
   * When a blocker appears, keep verified work and replan the unfinished
   * tail instead of leaving the graph silently stale.
   */
  replanBlocked(id: string, blocker: string): TaskGraph | null {
    const graph = this.get(id);
    if (!graph) return null;
    const reason = String(blocker || "").trim();
    if (!reason) return graph;
    const horizon: HorizonGoal = graph.horizon ?? { goal: graph.request, blockers: [] };
    horizon.blockers = [...horizon.blockers, reason].slice(-12);
    graph.horizon = horizon;
    const done = graph.nodes.filter((node) => DONE.includes(node.state));
    const leftover = graph.nodes
      .filter((node) => !DONE.includes(node.state))
      .map((node) => node.instruction || node.title);
    const rest = leftover.length ? leftover.join("\n") : horizon.goal;
    const planned = planNodes(
      `Continue: ${horizon.goal}. Remaining after blocker (${reason}):\n${rest}`,
    );
    const kind = graph.nodes[0]?.kind ?? "goal";
    const rebuilt: GraphNode[] = planned.map((step, index) => ({
      id: `${graph.id}-r${graph.nodes.length + index + 1}`,
      title: step.title,
      instruction: step.instruction,
      kind,
      purpose: step.purpose,
      dependsOn:
        index === 0
          ? done.length
            ? [done[done.length - 1]!.id]
            : []
          : [`${graph.id}-r${graph.nodes.length + index}`],
      state: index === 0 ? "ready" : "pending",
      attempts: 0,
      maxAttempts: 2,
    }));
    graph.nodes = [...done, ...rebuilt];
    if (graph.state === "failed" || graph.state === "paused") graph.state = "queued";
    graph.updatedAt = Date.now();
    this.log(graph, `replanned remaining work after blocker: ${reason}`, "warn");
    this.emit();
    void this.pump();
    return graph;
  }

  /** True while an owner graph is running or waiting in line. */
  busy(): boolean {
    return this.graphs.some((g) => g.priority === "owner" && OPEN_GRAPH.includes(g.state));
  }

  running(): TaskGraph | undefined {
    return this.graphs.find((graph) => graph.state === "running");
  }

  /* ---------------------------------------------------------- controls */

  /** Owner sent a message: idle self-work parks immediately, checkpointed. */
  noteOwnerActivity(): void {
    this.lastActivityAt = Date.now();
    const active = this.activeGraphId ? this.get(this.activeGraphId) : undefined;
    if (active?.priority === "idle" && active.state === "running") {
      this.log(
        active,
        "owner active — pausing idle self-improvement at the last checkpoint",
        "warn",
      );
      this.controller?.abort("owner-active");
    }
    for (const graph of this.graphs) {
      if (graph.priority === "idle" && graph.state === "queued") graph.state = "paused";
    }
    this.emit();
  }

  /** Explicit "stop what you're doing and take this instead". */
  interrupt(graphId: string): void {
    const graph = this.get(graphId);
    if (!graph || graph.state !== "running") return;
    this.log(graph, "interrupted by the owner — checkpointed and paused", "warn");
    graph.state = "paused";
    this.controller?.abort("interrupted");
    this.emit();
  }

  pause(graphId: string): void {
    const graph = this.get(graphId);
    if (!graph || !OPEN_GRAPH.includes(graph.state)) return;
    graph.state = "paused";
    if (this.activeGraphId === graphId) this.controller?.abort("paused");
    this.log(graph, "paused");
    this.emit();
  }

  resume(graphId: string): void {
    const graph = this.get(graphId);
    if (!graph || graph.state !== "paused") return;
    for (const node of graph.nodes) {
      if (node.state === "paused" || node.state === "waiting") {
        node.state = "ready";
        delete node.error;
      }
    }
    graph.state = "queued";
    this.log(graph, "resumed");
    this.emit();
    void this.pump();
  }

  cancel(graphId: string): void {
    const graph = this.get(graphId);
    if (!graph || !OPEN_GRAPH.includes(graph.state)) return;
    graph.state = "cancelled";
    graph.finishedAt = Date.now();
    if (this.activeGraphId === graphId) this.controller?.abort("cancelled");
    this.log(graph, "cancelled by the owner", "warn");
    this.emit();
    void this.pump();
  }

  /**
   * Owner-requested retry: keep verified nodes, put unfinished work back on
   * the queue, and continue from the last checkpoint. Does not invent steps.
   */
  retry(graphId: string): boolean {
    const graph = this.get(graphId);
    if (!graph) return false;
    if (graph.state === "running" || graph.state === "queued") return false;
    const unfinished = graph.nodes.filter((node) => !DONE.includes(node.state));
    if (!unfinished.length) return false;
    for (const node of unfinished) {
      if (node.state === "failed" || node.state === "paused" || node.state === "waiting") {
        if (node.attempts >= node.maxAttempts) node.maxAttempts = node.attempts + 1;
        node.state = "ready";
        delete node.error;
      }
    }
    graph.state = "queued";
    delete graph.error;
    delete graph.finishedAt;
    this.log(graph, "retry requested by the owner — continuing from last checkpoint", "warn");
    this.emit();
    void this.pump();
    return true;
  }

  /** Parks every running graph at its last checkpoint. */
  pauseAll(): number {
    const running = this.graphs.filter((graph) => graph.state === "running");
    for (const graph of running) this.pause(graph.id);
    return running.length;
  }

  /** Puts every paused graph back in line; the first eligible one starts. */
  resumeAllPaused(): number {
    const paused = this.graphs.filter((graph) => graph.state === "paused");
    for (const graph of paused) this.resume(graph.id);
    return paused.length;
  }

  /**
   * Swap a queued owner graph with its neighbour. `direction` -1 moves it
   * earlier in line, +1 later. Does not touch the running graph.
   */
  moveInQueue(graphId: string, direction: -1 | 1): boolean {
    const queued = this.graphs
      .filter((graph) => graph.priority === "owner" && graph.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    const index = queued.findIndex((graph) => graph.id === graphId);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= queued.length) return false;
    const a = queued[index]!;
    const b = queued[swap]!;
    const stamp = a.createdAt;
    a.createdAt = b.createdAt;
    b.createdAt = stamp;
    if (a.createdAt === b.createdAt) a.createdAt += direction;
    a.updatedAt = Date.now();
    b.updatedAt = Date.now();
    this.emit();
    return true;
  }

  /**
   * Queue the same request again as a new owner graph. Reuses a learned
   * procedure when one exists. Does not rewrite the finished graph.
   */
  requeue(graphId: string): { id: string; position: number; queued: boolean } | null {
    const graph = this.get(graphId);
    if (!graph) return null;
    return this.submit(graph.request, {
      priority: "owner",
      ...(graph.horizon
        ? {
            horizon: {
              goal: graph.horizon.goal,
              ...(graph.horizon.deadline ? { deadline: graph.horizon.deadline } : {}),
              ...(graph.horizon.outcome ? { outcome: graph.horizon.outcome } : {}),
            },
          }
        : {}),
    });
  }

  clearFinished(): void {
    this.graphs = this.graphs.filter((graph) => OPEN_GRAPH.includes(graph.state));
    this.emit();
  }

  /** Marks the completion notice delivered so it is raised exactly once. */
  markAnnounced(graphId: string): void {
    const graph = this.get(graphId);
    if (!graph || graph.announced) return;
    graph.announced = true;
    this.emit();
  }

  /* -------------------------------------------------------------- pump */

  /** Runs pending work. Safe to call from anywhere; single-flight. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const graph = this.pick();
        if (!graph) break;
        const advanced = await this.step(graph);
        if (!advanced) break;
      }
    } finally {
      this.pumping = false;
      this.activeGraphId = null;
      this.controller = null;
    }
  }

  private pick(): TaskGraph | undefined {
    const open = this.graphs.filter((graph) => OPEN_GRAPH.includes(graph.state));
    const owner = open
      .filter((graph) => graph.priority === "owner" && graph.state !== "paused")
      .sort((a, b) => a.createdAt - b.createdAt);
    if (owner.length) return owner[0];

    // Idle work only when nothing of the owner's is open and she has been quiet.
    const ownerOpen = open.some((graph) => graph.priority === "owner");
    if (ownerOpen) return undefined;
    if (Date.now() - this.lastActivityAt < IDLE_GRACE_MS) return undefined;
    return open
      .filter((graph) => graph.priority === "idle" && graph.state !== "paused")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  /** Executes exactly one node. Returns false when this graph cannot advance. */
  private async step(graph: TaskGraph): Promise<boolean> {
    const node = graph.nodes.find(
      (candidate) =>
        (candidate.state === "ready" || candidate.state === "retrying") &&
        candidate.dependsOn.every((dep) =>
          DONE.includes(graph.nodes.find((n) => n.id === dep)?.state ?? "pending"),
        ),
    );

    if (!node) {
      const unfinished = graph.nodes.filter((n) => !DONE.includes(n.state));
      if (!unfinished.length) return this.finish(graph, "completed");
      if (unfinished.every((n) => n.state === "waiting" || n.state === "paused")) {
        graph.state = "paused";
        this.emit();
        return false;
      }
      if (unfinished.some((n) => n.state === "failed")) return this.finish(graph, "failed");
      // Dependencies satisfied but nothing marked ready — promote the next one.
      const next = unfinished.find((n) =>
        n.dependsOn.every((dep) =>
          DONE.includes(graph.nodes.find((x) => x.id === dep)?.state ?? "pending"),
        ),
      );
      if (!next) return this.finish(graph, "failed");
      next.state = "ready";
      this.emit();
      return true;
    }

    const runner = this.runners.get(node.kind);
    if (!runner) {
      node.state = "failed";
      node.error = `no runner registered for "${node.kind}"`;
      this.log(graph, node.error, "error");
      return this.finish(graph, "failed");
    }

    graph.state = "running";
    node.state = "running";
    node.attempts += 1;
    node.startedAt = Date.now();
    this.activeGraphId = graph.id;
    this.controller = new AbortController();
    this.log(graph, `${node.title} — attempt ${node.attempts}`);
    this.emit();

    const checkpoint: Checkpoint = { ...(node.checkpoint ?? emptyCheckpoint()), at: Date.now() };
    const context: RunnerContext = {
      graph,
      node,
      signal: this.controller.signal,
      log: (line, level) => {
        this.log(graph, line, level);
        this.emit();
      },
      checkpoint: (patch) => {
        Object.assign(checkpoint, patch, { at: Date.now() });
        node.checkpoint = { ...checkpoint };
        this.emit();
      },
    };

    let result: RunnerResult | void = undefined;
    let failure: string | undefined;
    try {
      result = await runner(context);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    node.endedAt = Date.now();
    const aborted = this.controller.signal.aborted;
    Object.assign(checkpoint, result ?? {}, { at: Date.now() });
    const remainingTitles = graph.nodes
      .filter((n) => n !== node && !DONE.includes(n.state))
      .map((n) => n.title);
    checkpoint.done ||= node.title;
    checkpoint.remaining = remainingTitles.join(" · ");
    checkpoint.nextAction ||= remainingTitles[0] ?? "finish";
    node.checkpoint = { ...checkpoint };

    if (aborted) {
      // Paused, not lost: the checkpoint above is the resume point.
      node.state = "paused";
      if (graph.state === "running") graph.state = "paused";
      this.log(graph, `${node.title} paused — will resume from "${checkpoint.nextAction}"`, "warn");
      this.emit();
      return false;
    }

    if (result && result.waiting) {
      node.state = "waiting";
      this.log(graph, `${node.title} is waiting on the owner`, "warn");
      this.emit();
      return true;
    }

    if (failure || (result && result.ok === false)) {
      node.error = failure ?? checkpoint.result ?? "subtask failed";
      if (node.attempts < node.maxAttempts) {
        node.state = "retrying";
        this.log(graph, `${node.title} failed (${node.error}) — retrying`, "warn");
        this.emit();
        return true;
      }
      node.state = "failed";
      this.log(graph, `${node.title} failed: ${node.error}`, "error");
      this.emit();
      return this.finish(graph, "failed");
    }

    node.state = "completed";
    // Verification is part of the state machine, not an afterthought: a node
    // only counts as verified when it produced a real, recorded result.
    node.state = checkpoint.result ? "verified" : "completed";
    this.log(graph, `${node.title} — ${node.state}`, "ok");

    const next = graph.nodes.find((n) => n.state === "pending");
    if (next) next.state = "ready";
    this.emit();
    return true;
  }

  private finish(graph: TaskGraph, state: GraphState): boolean {
    graph.state = state;
    graph.finishedAt = Date.now();
    if (state === "failed") {
      graph.error = graph.nodes.find((node) => node.state === "failed")?.error ?? "task failed";
    }
    this.log(
      graph,
      state === "completed" ? "task complete" : `task ${state}`,
      state === "completed" ? "ok" : "error",
    );
    if (graph.priority === "owner") {
      const verified = graph.nodes.every((node) => node.state === "verified");
      const ms = Math.max(0, (graph.finishedAt ?? Date.now()) - graph.createdAt);
      learning.evaluate({
        taskId: graph.id,
        kind: "task-graph",
        title: graph.request.slice(0, 80),
        success: state === "completed",
        verified: state === "completed" && verified,
        ms,
        detail:
          state === "completed"
            ? graph.nodes.map((node) => node.title).join(" → ")
            : (graph.error ?? "task failed"),
        tools: [...new Set(graph.nodes.flatMap((node) => node.checkpoint?.tools ?? []))],
      });
      if (state === "completed" && verified && graph.nodes.length >= 2) {
        rememberProcedure(
          graph.request,
          graph.nodes.map((node) => ({ title: node.title, instruction: node.instruction })),
          `task-graph/${graph.id}`,
        );
      }
    }
    this.emit();
    return true;
  }
}

export const taskGraph = new TaskGraphEngine();
