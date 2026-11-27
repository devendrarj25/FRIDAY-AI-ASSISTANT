/**
 * FRIDAY · task ledger
 *
 * Every FRIDAY action that leaves the UI thread runs through here so it gets a
 * unique id, a status, logs, a timeout, cancellation and a final result.
 * De-duplicated by key: the same key never runs twice at the same time.
 * Event-driven — no polling timers, no background loops.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { capabilityMatrix, DOMAINS, type CapabilityDomain } from "./capability-matrix";
import { domainsForTask } from "../brain/confidence";
import { similarity } from "../brain/reconciler";

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "done"
  | "failed"
  | "cancelled"
  | "timeout"
  | "interrupted";

export type TaskLog = { at: number; level: "info" | "ok" | "warn" | "error"; line: string };

export type TaskRecord = {
  id: string;
  key: string;
  kind: string;
  title: string;
  status: TaskStatus;
  progress: number;
  startedAt: number;
  endedAt?: number;
  logs: TaskLog[];
  result?: unknown;
  error?: string;
  /** Experience evidence: what actually did the work, and how it ended. */
  models?: string[];
  tools?: string[];
  success?: boolean;
  verified?: boolean;
  feedback?: string;
  /** Last safe point. A reload keeps this and marks the row interrupted. */
  checkpoint?: {
    at: number;
    done: string;
    nextAction: string;
    idempotencyKey?: string;
    checked?: boolean;
  };
  /**
   * Set only on a row mirrored from the voice task desk (additive: an old row without it loads as before). `state` is
   * the desk's own state, `spokenName` how it is said aloud, `ordinal` its number on the desk, `request` the owner's
   * request for a redo, `redo` what became of an interrupted row once she asked about it.
   */
  voice?: {
    state: string;
    spokenName?: string;
    ordinal?: number;
    request?: string;
    redo?: "asked" | "redone" | "dropped";
  };
};

/** The ledger status a voice desk state is written as. A live one reloads as interrupted (see `settleInterrupted`). */
export function voiceStatusOf(state: string): TaskStatus {
  switch (state) {
    case "CREATED":
    case "QUEUED":
      return "queued";
    case "WAITING_FOR_APPROVAL":
      return "awaiting-approval";
    case "COMPLETED":
      return "done";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "INTERRUPTED":
      return "interrupted";
    default:
      return "running";
  }
}

/** The stable ledger id of a desk task: the desk numbers restart with the app, the creation time does not. */
export const voiceLedgerId = (createdAt: number, deskId: string): string =>
  `voice-${Math.max(0, Math.round(createdAt)).toString(36)}-${deskId}`;

/** The voice rows that were live when the app closed and have not been asked about yet. */
export function restartVoiceRows(tasks: readonly TaskRecord[]): TaskRecord[] {
  return tasks.filter(
    (task) =>
      task.kind === "voice-task" &&
      task.status === "interrupted" &&
      Boolean(task.voice?.request) &&
      task.voice?.redo === undefined,
  );
}

/** A reload keeps the checkpoint and offers the run again. It does not cancel it. */
export function settleInterrupted(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.map((task) =>
    task.status === "running" || task.status === "queued" || task.status === "awaiting-approval"
      ? { ...task, status: "interrupted" }
      : task,
  );
}

export type TaskContext = {
  id: string;
  signal: AbortSignal;
  log: (line: string, level?: TaskLog["level"]) => void;
  progress: (percent: number) => void;
  /** Pauses the task until the user approves or rejects it. */
  approval: (question: string) => Promise<boolean>;
};

const STORAGE_KEY = "friday.tasks.v1";
const MAX_HISTORY = 120;
const MAX_LOGS = 200;

/**
 * Minimum verified successes of the same kind+model before routing preference
 * may shift. See `preferredModelFor`.
 */
export const STRATEGY_SAMPLE_MIN = 5;

let seq = 0;
const newId = () => `task-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

export type PendingApproval = { taskId: string; question: string };

export type LedgerState = { tasks: TaskRecord[]; approvals: PendingApproval[] };

type Live = {
  controller: AbortController;
  resolveApproval?: ((ok: boolean) => void) | undefined;
};

class TaskLedger {
  private tasks: TaskRecord[] = [];
  private live = new Map<string, Live>();
  private byKey = new Map<string, Promise<unknown>>();
  private approvals: PendingApproval[] = [];
  private listeners = new Set<() => void>();
  private snapshot: LedgerState = {
    tasks: [],
    approvals: [],
  };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const settle = (parsed: TaskRecord[]): TaskRecord[] => settleInterrupted(parsed);
    const local = readLocalState<TaskRecord[]>(STORAGE_KEY);
    if (Array.isArray(local)) this.tasks = settle(local);
    restoreFromDisk<TaskRecord[]>(STORAGE_KEY, (disk) => {
      if (!Array.isArray(disk) || !disk.length) return;
      this.tasks = settle(disk);
      this.emit(false);
    });
    this.emit(false);
  }

  private emit(persist = true) {
    this.snapshot = { tasks: [...this.tasks], approvals: [...this.approvals] };
    this.listeners.forEach((l) => l());
    if (!persist || typeof window === "undefined") return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, this.tasks.slice(0, MAX_HISTORY));
    }, 600);
  }

  list(): TaskRecord[] {
    return this.getSnapshot().tasks;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  private patch(id: string, next: Partial<TaskRecord>) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tasks[i] = { ...this.tasks[i], ...next } as TaskRecord;
    this.emit();
  }

  /** Runs `fn` as a tracked task. Returns the task id and the settled promise. */
  run<T>(
    options: { kind: string; title: string; key?: string; timeoutMs?: number },
    fn: (ctx: TaskContext) => Promise<T>,
  ): { id: string; promise: Promise<T> } {
    this.load();
    const key = options.key ?? `${options.kind}:${options.title}`;
    const existing = this.byKey.get(key);
    if (existing) {
      const running = this.tasks.find((t) => t.key === key && t.status !== "done");
      return { id: running?.id ?? key, promise: existing as Promise<T> };
    }

    const id = newId();
    const controller = new AbortController();
    this.live.set(id, { controller });
    const record: TaskRecord = {
      id,
      key,
      kind: options.kind,
      title: options.title,
      status: "running",
      progress: 0,
      startedAt: Date.now(),
      logs: [{ at: Date.now(), level: "info", line: "task started" }],
    };
    this.tasks = [record, ...this.tasks].slice(0, MAX_HISTORY);
    this.emit();

    const log = (line: string, level: TaskLog["level"] = "info") => {
      const task = this.get(id);
      if (!task) return;
      this.patch(id, {
        logs: [...task.logs, { at: Date.now(), level, line }].slice(-MAX_LOGS),
      });
    };

    const ctx: TaskContext = {
      id,
      signal: controller.signal,
      log,
      progress: (percent) => this.patch(id, { progress: Math.max(0, Math.min(100, percent)) }),
      approval: (question) =>
        new Promise<boolean>((resolve) => {
          if (controller.signal.aborted) return resolve(false);
          this.approvals = [...this.approvals, { taskId: id, question }];
          const live = this.live.get(id);
          if (live) live.resolveApproval = resolve;
          this.patch(id, { status: "awaiting-approval" });
          log(`waiting for approval — ${question}`, "warn");
        }),
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const guard = options.timeoutMs
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort("timeout");
            reject(new Error("timed out"));
          }, options.timeoutMs);
        })
      : null;

    const promise = (async () => {
      try {
        const value = guard ? await Promise.race([fn(ctx), guard]) : await fn(ctx);
        this.patch(id, {
          status: "done",
          progress: 100,
          endedAt: Date.now(),
          result: value,
          logs: [...(this.get(id)?.logs ?? []), { at: Date.now(), level: "ok", line: "completed" }],
        });
        return value;
      } catch (error) {
        const aborted = controller.signal.aborted;
        const reason = String((error as Error)?.message ?? error);
        this.patch(id, {
          status: aborted ? (reason.includes("timed out") ? "timeout" : "cancelled") : "failed",
          endedAt: Date.now(),
          error: reason,
          logs: [
            ...(this.get(id)?.logs ?? []),
            { at: Date.now(), level: "error" as const, line: reason },
          ].slice(-MAX_LOGS),
        });
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        this.live.delete(id);
        this.byKey.delete(key);
        this.approvals = this.approvals.filter((a) => a.taskId !== id);
        this.emit();
      }
    })();

    this.byKey.set(
      key,
      promise.catch(() => undefined),
    );
    return { id, promise };
  }

  answerApproval(taskId: string, allow: boolean) {
    const live = this.live.get(taskId);
    this.approvals = this.approvals.filter((a) => a.taskId !== taskId);
    if (live?.resolveApproval) {
      live.resolveApproval(allow);
      live.resolveApproval = undefined;
      this.patch(taskId, { status: "running" });
      const task = this.get(taskId);
      if (task) {
        this.patch(taskId, {
          logs: [
            ...task.logs,
            {
              at: Date.now(),
              level: (allow ? "ok" : "warn") as TaskLog["level"],
              line: allow ? "approved" : "rejected",
            },
          ],
        });
      }
    }
    this.emit();
  }

  cancel(id: string, reason = "cancelled by user") {
    const live = this.live.get(id);
    if (!live) return;
    live.resolveApproval?.(false);
    live.controller.abort(reason);
  }

  cancelAll() {
    [...this.live.keys()].forEach((id) => this.cancel(id, "cancelled — all tasks"));
  }

  /**
   * Write-through of one voice desk task. The row is made or replaced, never duplicated; `redo` of an existing row is
   * kept. Nothing here starts, cancels or runs a task: the ledger only remembers it.
   */
  syncVoiceTask(row: {
    id: string;
    title: string;
    state: string;
    createdAt: number;
    updatedAt: number;
    percent?: number | undefined;
    error?: string | undefined;
    spokenName?: string | undefined;
    ordinal?: number | undefined;
    request?: string | undefined;
  }) {
    this.load();
    const status = voiceStatusOf(row.state);
    const done = status === "done" || status === "failed" || status === "cancelled";
    const prev = this.get(row.id);
    const record: TaskRecord = {
      id: row.id,
      key: row.id,
      kind: "voice-task",
      title: row.title.slice(0, 120),
      status,
      progress: status === "done" ? 100 : (row.percent ?? prev?.progress ?? 0),
      startedAt: row.createdAt,
      ...(done ? { endedAt: row.updatedAt } : {}),
      logs: prev?.logs ?? [],
      ...(row.error ? { error: row.error.slice(0, 200) } : {}),
      voice: {
        state: row.state,
        ...(row.spokenName ? { spokenName: row.spokenName } : {}),
        ...(row.ordinal !== undefined ? { ordinal: row.ordinal } : {}),
        ...((row.request ?? prev?.voice?.request)
          ? { request: (row.request ?? prev?.voice?.request ?? "").slice(0, 600) }
          : {}),
        ...(prev?.voice?.redo ? { redo: prev.voice.redo } : {}),
      },
    };
    this.tasks = prev
      ? this.tasks.map((t) => (t.id === row.id ? record : t))
      : [record, ...this.tasks].slice(0, MAX_HISTORY);
    this.emit();
  }

  /** The voice rows to ask about after a restart (see `restartVoiceRows`). */
  restartVoiceRows(): TaskRecord[] {
    this.load();
    return restartVoiceRows(this.tasks);
  }

  /** She asked about these rows (`asked`), or the owner answered: redone or dropped rows are closed for good. */
  markVoiceRows(ids: readonly string[], redo: "asked" | "redone" | "dropped") {
    this.load();
    let changed = false;
    this.tasks = this.tasks.map((task) => {
      if (!ids.includes(task.id) || task.kind !== "voice-task" || !task.voice) return task;
      changed = true;
      return {
        ...task,
        ...(redo === "asked" ? {} : { status: "cancelled" as const }),
        voice: { ...task.voice, redo },
      };
    });
    if (changed) this.emit();
  }

  clearHistory() {
    this.tasks = this.tasks.filter((t) => this.live.has(t.id));
    this.emit();
  }

  /** Attach experience evidence (models/tools used) to a live task record. */
  note(id: string, evidence: { models?: string[]; tools?: string[] }) {
    const task = this.get(id);
    if (!task) return;
    const merge = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]));
    this.patch(id, {
      models: merge(task.models, evidence.models),
      tools: merge(task.tools, evidence.tools),
    });
  }
}

export const ledger = new TaskLedger();

/* ------------------------------------------------------------ experience -- */

/**
 * FRIDAY · experience store (the evidence base)
 *
 * Every finished task lands here once: what was attempted, which tools and
 * models did it, whether verification passed, whether it succeeded and — when
 * the owner says something — his feedback. This is the ONE record the
 * capability matrix, the skill-learning loop, the routing metric and local
 * fine-tuning all read from; nothing here duplicates the task list, it
 * summarises it into durable, comparable outcomes.
 */
export type ExperienceModel = { id: string; kind: "local" | "cloud" | "unknown" };

/**
 * Who wrote the prompt of a task. "owner" only when the owner typed or spoke the text in this turn; every other
 * author, and every row stored before this was recorded, is not trainable (untrusted input is data).
 */
export const PROMPT_AUTHORS = ["owner", "tool", "web", "screen", "mcp", "file", "unknown"] as const;
export type PromptAuthor = (typeof PROMPT_AUTHORS)[number];

const asAuthor = (value: unknown): PromptAuthor =>
  PROMPT_AUTHORS.includes(value as PromptAuthor) ? (value as PromptAuthor) : "unknown";

/** Trimmed, lower-case, de-duplicated, sorted. Anything that is not a non-empty string is dropped. */
const cleanKinds = (value: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter((kind): kind is string => typeof kind === "string")
        .map((kind) => kind.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();

export type Experience = {
  id: string;
  taskId: string;
  at: number;
  kind: string;
  title: string;
  /** Stable signature of HOW it was done — repeated approaches become skills. */
  approach: string;
  domains: CapabilityDomain[];
  models: ExperienceModel[];
  tools: string[];
  attempted: string;
  success: boolean;
  verified: boolean;
  ms: number;
  detail?: string;
  feedback?: string;
  /** Who wrote the prompt. Missing (a row stored before this existed) means "unknown", never owner. */
  promptAuthor?: PromptAuthor;
  /** Untrusted-content kinds that were in the model context of this turn. Missing = unknown = not trainable. */
  contextKinds?: string[];
};

export type ExperienceInput = {
  taskId: string;
  kind: string;
  title: string;
  success: boolean;
  verified: boolean;
  ms?: number;
  attempted?: string;
  approach?: string;
  domains?: CapabilityDomain[];
  models?: (string | ExperienceModel)[];
  tools?: string[];
  detail?: string;
  feedback?: string;
  at?: number;
  /** "owner" only when the owner typed or spoke this turn's text. Missing = "unknown". */
  promptAuthor?: PromptAuthor;
  /** Untrusted-content kinds that sat in the context (web, screen, mcp, file, tool...). */
  contextKinds?: string[];
};

/** What was noted about a turn before its task finished (see `noteProvenance`). */
export type ProvenanceNote = { promptAuthor?: PromptAuthor; contextKind?: string };

export type ModelCall = {
  at: number;
  id: string;
  kind: "local" | "cloud" | "unknown";
  ok: boolean;
};

export type RoutingStats = {
  days: number;
  local: number;
  cloud: number;
  total: number;
  /** 0–1 share of calls answered on this PC. null when nothing ran yet. */
  localShare: number | null;
};

export type ExperienceState = {
  experiences: Experience[];
  calls: ModelCall[];
};

const EXPERIENCE_KEY = "friday.experiences.v1";
const MAX_EXPERIENCES = 400;
const MAX_CALLS = 600;
const MAX_PENDING = 200;
const DAY = 86_400_000;

const normaliseModel = (model: string | ExperienceModel): ExperienceModel =>
  typeof model === "string" ? { id: model, kind: "unknown" } : model;

/**
 * Bring a stored row forward: a row with no valid author becomes "unknown" (never "owner"), and a context list that
 * is not a list of strings is dropped. Idempotent, so it runs on every load.
 */
export function migrateExperience(raw: unknown): Experience {
  const { contextKinds, promptAuthor, ...rest } = raw as Omit<Experience, "contextKinds"> & {
    contextKinds?: unknown;
  };
  const kinds = Array.isArray(contextKinds) ? cleanKinds(contextKinds) : undefined;
  return {
    ...rest,
    promptAuthor: asAuthor(promptAuthor),
    ...(kinds ? { contextKinds: kinds } : {}),
  };
}

/** A comparable "how" signature: same kind, same tools, same model class. */
export function approachSignature(input: {
  kind: string;
  tools?: string[];
  models?: ExperienceModel[];
}): string {
  const tools = [...new Set(input.tools ?? [])].sort();
  const kinds = [...new Set((input.models ?? []).map((m) => m.kind))].sort();
  return [input.kind, tools.join("+") || "no-tool", kinds.join("+") || "no-model"].join("::");
}

class ExperienceStore {
  private experiences: Experience[] = [];
  private calls: ModelCall[] = [];
  private snapshot: ExperienceState = { experiences: [], calls: [] };
  private listeners = new Set<() => void>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  /** Provenance noted while a task runs, merged into its record and then forgotten. */
  private pending = new Map<string, { author: PromptAuthor; kinds: Set<string> }>();

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): ExperienceState => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<ExperienceState>(EXPERIENCE_KEY);
    if (local) this.adopt(local);
    restoreFromDisk<ExperienceState>(EXPERIENCE_KEY, (disk) => {
      if (!disk) return;
      this.adopt(disk);
      this.emit(false);
    });
    this.emit(false);
  }

  private adopt(state: ExperienceState) {
    if (Array.isArray(state.experiences))
      this.experiences = state.experiences.map(migrateExperience);
    if (Array.isArray(state.calls)) this.calls = state.calls;
  }

  private emit(persist = true) {
    this.snapshot = { experiences: [...this.experiences], calls: [...this.calls] };
    this.listeners.forEach((fn) => fn());
    if (!persist || typeof window === "undefined") return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(EXPERIENCE_KEY, {
        experiences: this.experiences.slice(0, MAX_EXPERIENCES),
        calls: this.calls.slice(0, MAX_CALLS),
      });
    }, 600);
  }

  /**
   * Note provenance while a turn runs: who wrote its prompt, and each kind of untrusted content that enters the
   * model context. `record` merges it into the row of that task. Kinds only accumulate, so content noted here can
   * never be erased by a later claim that the context was clean.
   */
  noteProvenance(taskId: string, note: ProvenanceNote): void {
    const entry = this.pending.get(taskId) ?? {
      author: "unknown" as PromptAuthor,
      kinds: new Set(),
    };
    if (note.promptAuthor) entry.author = asAuthor(note.promptAuthor);
    for (const kind of cleanKinds([note.contextKind])) entry.kinds.add(kind);
    this.pending.delete(taskId);
    this.pending.set(taskId, entry);
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  /**
   * Record ONE finished task. Also feeds the capability matrix — a verified
   * success nudges its domains up, a failure nudges them down, one small step
   * per real outcome (the matrix itself keeps the step conservative).
   */
  record(input: ExperienceInput): Experience {
    this.load();
    const models = (input.models ?? []).map(normaliseModel);
    const tools = input.tools ?? [];
    const domains = (input.domains ?? domainsForTask(`${input.title} ${input.kind}`)).filter((d) =>
      DOMAINS.includes(d),
    );
    const noted = this.pending.get(input.taskId);
    this.pending.delete(input.taskId);
    const promptAuthor = input.promptAuthor
      ? asAuthor(input.promptAuthor)
      : (noted?.author ?? "unknown");
    // The context is known when the caller said so, when a note was made, or when the owner wrote the turn
    // (then it holds exactly what the tools brought in). Otherwise it stays unknown.
    const known =
      input.contextKinds !== undefined || noted !== undefined || promptAuthor === "owner";
    const contextKinds = cleanKinds([
      ...(input.contextKinds ?? []),
      ...(noted?.kinds ?? []),
      ...(tools.length ? ["tool"] : []),
    ]);
    const experience: Experience = {
      id: `exp-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`,
      taskId: input.taskId,
      at: input.at ?? Date.now(),
      kind: input.kind,
      title: input.title,
      approach: input.approach ?? approachSignature({ kind: input.kind, tools, models }),
      domains: domains.length ? domains : (["conversation"] as CapabilityDomain[]),
      models,
      tools,
      attempted: input.attempted ?? input.title,
      success: Boolean(input.success),
      verified: Boolean(input.verified),
      ms: input.ms ?? 0,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.feedback ? { feedback: input.feedback } : {}),
      promptAuthor,
      ...(known || contextKinds.length ? { contextKinds } : {}),
    };
    this.experiences = [experience, ...this.experiences].slice(0, MAX_EXPERIENCES);
    // Only an outcome that was actually checked moves a capability score; an
    // unverified "it seemed fine" is history, not evidence.
    if (experience.verified || !experience.success) {
      for (const domain of experience.domains) {
        capabilityMatrix.record(domain, experience.success && experience.verified, experience.at);
      }
    }
    for (const model of models) {
      this.noteModelCall(model.id, model.kind, experience.success, experience.at);
    }
    this.emit();
    return experience;
  }

  /** Owner feedback arriving after the fact — corrections outrank successes. */
  feedback(taskId: string, text: string): void {
    this.load();
    const index = this.experiences.findIndex((e) => e.taskId === taskId);
    if (index < 0) return;
    const current = this.experiences[index] as Experience;
    const corrected = /\b(wrong|no,|not right|incorrect|bad|redo|fix)\b/i.test(text);
    this.experiences[index] = {
      ...current,
      feedback: text,
      ...(corrected ? { success: false } : {}),
    };
    if (corrected && current.success) {
      for (const domain of current.domains) capabilityMatrix.record(domain, false);
    }
    this.emit();
  }

  /**
   * One real model call. Called from the single place steps are recorded, so
   * the local-vs-cloud metric counts what actually ran — not an estimate.
   */
  noteModelCall(
    id: string,
    kind: "local" | "cloud" | "unknown",
    ok: boolean,
    at: number = Date.now(),
  ): void {
    this.load();
    this.calls = [{ at, id, kind, ok }, ...this.calls].slice(0, MAX_CALLS);
    this.emit();
  }

  list(limit = 50): Experience[] {
    return this.getSnapshot().experiences.slice(0, limit);
  }

  /** Verified successes only — the safe training/learning material. */
  successes(limit = 200): Experience[] {
    return this.getSnapshot()
      .experiences.filter((e) => e.success && e.verified)
      .slice(0, limit);
  }

  /**
   * Model id that has the most *verified* successes for this kind.
   * Unverified guesses never move this preference.
   *
   * Default sample size is `STRATEGY_SAMPLE_MIN` (5). One or two verified
   * runs can be luck (a single lucky network path). Five is the smallest
   * count where a later 2-failure dip still leaves a 3/5 majority, and where
   * five independent 50/50 coin-flips all landing the same way is ~3%. That
   * matches "repeated, verified evidence" rather than one noisy result.
   */
  preferredModelFor(kind: string, minVerified = STRATEGY_SAMPLE_MIN): string | null {
    const counts = new Map<string, number>();
    for (const experience of this.successes(400)) {
      if (experience.kind !== kind) continue;
      const id = experience.models[0]?.id;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let best: string | null = null;
    let n = 0;
    for (const [id, count] of counts) {
      if (count > n) {
        best = id;
        n = count;
      }
    }
    return n >= minVerified ? best : null;
  }

  /**
   * Approaches that keep working. Three or more verified successes of the same
   * kind, done the same way, is FRIDAY noticing a habit worth turning into a
   * skill.
   */
  repeatedApproaches(
    minCount = 3,
    windowDays = 30,
  ): { approach: string; kind: string; title: string; count: number; lastAt: number }[] {
    const since = Date.now() - windowDays * DAY;
    const groups = new Map<
      string,
      { kind: string; title: string; count: number; lastAt: number }
    >();
    for (const experience of this.getSnapshot().experiences) {
      if (!experience.success || !experience.verified || experience.at < since) continue;
      const current = groups.get(experience.approach);
      if (current) {
        current.count += 1;
        current.lastAt = Math.max(current.lastAt, experience.at);
      } else {
        groups.set(experience.approach, {
          kind: experience.kind,
          title: experience.title,
          count: 1,
          lastAt: experience.at,
        });
      }
    }
    return [...groups.entries()]
      .filter(([, value]) => value.count >= minCount)
      .map(([approach, value]) => ({ approach, ...value }))
      .sort((a, b) => b.count - a.count);
  }

  /** Local-vs-cloud routing metric for the doctor / system map surface. */
  routingStats(days = 7): RoutingStats {
    const since = Date.now() - days * DAY;
    const window = this.getSnapshot().calls.filter((c) => c.at >= since);
    const local = window.filter((c) => c.kind === "local").length;
    const cloud = window.filter((c) => c.kind === "cloud").length;
    const total = local + cloud;
    return { days, local, cloud, total, localShare: total ? local / total : null };
  }

  /**
   * Store one role-level answer so a later equivalent sub-task can reuse it.
   * Does not count as a model call and does not move the capability matrix —
   * those stay on `record()` / `noteModelCall()` for work that actually ran.
   */
  noteSubTaskResult(input: {
    taskId?: string;
    role: string;
    prompt: string;
    result: string;
    modelId: string;
    success?: boolean;
    at?: number;
  }): Experience {
    this.load();
    const prompt = (input.prompt ?? "").trim();
    const result = (input.result ?? "").trim();
    const models: ExperienceModel[] = [{ id: input.modelId, kind: "unknown" }];
    const kind = subTaskKind(input.role);
    const experience: Experience = {
      id: `exp-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`,
      taskId: input.taskId ?? `subtask-${Date.now().toString(36)}`,
      at: input.at ?? Date.now(),
      kind,
      title: prompt.slice(0, 280),
      approach: approachSignature({ kind, models }),
      domains: ["conversation"],
      models,
      tools: [],
      attempted: prompt.slice(0, 800),
      success: input.success !== false,
      verified: false,
      ms: 0,
      ...(result ? { detail: result.slice(0, 4000) } : {}),
    };
    this.experiences = [experience, ...this.experiences].slice(0, MAX_EXPERIENCES);
    this.emit();
    return experience;
  }

  clear(): void {
    this.load();
    this.experiences = [];
    this.calls = [];
    this.emit();
  }
}

export const experiences = new ExperienceStore();

/* -------------------------------------- duplicate-work reuse (existing stores) -- */

/** How far back a finished sub-task may still stand in for a new dispatch. */
export const SUBTASK_REUSE_WINDOW_MS = 90_000;
/** Same-turn equivalent work can be a looser match — it is the same request. */
export const SAME_TURN_SIMILARITY = 0.55;
/** A later turn must be a closer match before we skip a fresh model call. */
export const RECENT_TURN_SIMILARITY = 0.72;

export function subTaskKind(role: string): string {
  return `role:${role}`;
}

export function subTaskKey(role: string, prompt: string): string {
  const normalized = (prompt ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  return `${subTaskKind(role)}:${normalized}`;
}

export type RecentSubTask = {
  result: string;
  modelId: string;
  similarity: number;
  sameTurn: boolean;
  source: "experience" | "ledger";
};

function promptOverlap(a: string, b: string): number {
  const left = (a ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const right = (b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!left || !right) return 0;
  if (left === right) return 1;
  return similarity(a, b);
}

function resultFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const rec = value as { result?: unknown; text?: unknown };
    if (typeof rec.result === "string" && rec.result.trim()) return rec.result;
    if (typeof rec.text === "string" && rec.text.trim()) return rec.text;
  }
  return null;
}

/**
 * Look in the existing experience store and task ledger for an equivalent
 * sub-task that already has an answer. Uses the reconciler's Jaccard overlap
 * — not a second cache.
 */
export function findRecentSubTask(
  role: string,
  prompt: string,
  opts?: { taskId?: string; windowMs?: number },
): RecentSubTask | null {
  const needle = (prompt ?? "").trim();
  if (!needle) return null;
  const windowMs = opts?.windowMs ?? SUBTASK_REUSE_WINDOW_MS;
  const now = Date.now();
  const kind = subTaskKind(role);
  let best: RecentSubTask | null = null;

  const consider = (candidate: {
    at: number;
    taskId: string;
    attempted: string;
    result: string;
    modelId: string;
    success: boolean;
    source: "experience" | "ledger";
  }) => {
    if (!candidate.success || !candidate.result.trim()) return;
    if (now - candidate.at > windowMs) return;
    const sim = promptOverlap(needle, candidate.attempted);
    const sameTurn = Boolean(opts?.taskId) && candidate.taskId === opts!.taskId;
    const threshold = sameTurn ? SAME_TURN_SIMILARITY : RECENT_TURN_SIMILARITY;
    if (sim < threshold) return;
    if (!best || sim > best.similarity) {
      best = {
        result: candidate.result,
        modelId: candidate.modelId,
        similarity: sim,
        sameTurn,
        source: candidate.source,
      };
    }
  };

  for (const rec of experiences.getSnapshot().experiences) {
    if (rec.kind !== kind) continue;
    consider({
      at: rec.at,
      taskId: rec.taskId,
      attempted: rec.attempted || rec.title,
      result: rec.detail ?? "",
      modelId: rec.models[0]?.id ?? "reused",
      success: rec.success,
      source: "experience",
    });
  }

  for (const task of ledger.list()) {
    if (task.kind !== kind || task.status !== "done") continue;
    const result = resultFromUnknown(task.result);
    if (!result) continue;
    const fromResult =
      task.result && typeof task.result === "object" && "modelId" in (task.result as object)
        ? String((task.result as { modelId?: string }).modelId ?? "")
        : "";
    consider({
      at: task.endedAt ?? task.startedAt,
      taskId: task.id,
      attempted: task.title,
      result,
      modelId: task.models?.[0] || fromResult || "reused",
      success: task.success !== false,
      source: "ledger",
    });
  }

  return best;
}

export function rememberSubTask(input: {
  taskId?: string;
  role: string;
  prompt: string;
  result: string;
  modelId: string;
  success?: boolean;
}): void {
  experiences.noteSubTaskResult(input);
}
