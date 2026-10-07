/**
 * FRIDAY · kernel API (one typed surface for the Python bridge)
 *
 * The kernel exposes its whole capability set through a single WebSocket
 * dispatch (`kernel/main.py`). Before this module every caller had to know the
 * raw method string, so most of the kernel was reachable in theory and unused
 * in practice.
 *
 * Everything the kernel can do is declared here exactly once:
 *
 *   - `KERNEL_METHODS` is the canonical list, checked against the kernel's own
 *     dispatch by `core/__tests__/connectivity.test.ts`. Add a method in
 *     Python and the test tells you to surface it here, which is what keeps
 *     FRIDAY connected to her own backend as she grows.
 *   - `kernelApi` gives every section a typed call instead of a magic string.
 *
 * Off the desktop (browser preview) every call resolves `null`; callers keep
 * their local state rather than showing a stuck placeholder.
 */

import { kernelCall } from "./desktop";

/** Every method `dispatch()` in kernel/main.py understands. */
export const KERNEL_METHODS = [
  "kernel.status",
  "model.list",
  "model.add",
  "model.sync",
  "model.remove",
  "chat.stream",
  "chat.complete",
  "chat.sessions",
  "chat.history",
  "chat.replace",
  "session.active",
  "task.run",
  "task.approve",
  "task.resume",
  "task.cancel",
  "task.steps",
  "task.pending",
  "task.list",

  "billing.get",
  "billing.set",
  "tool.list",
  "tool.exec",
  "memory.search",
  "memory.index",
  "memory.add",
  "memory.reindex",
  "memory.status",
  "module.list",
  "module.toggle",
  "runtime.list",
  "runtime.install",
  "project.detect",
  "project.run",
  "code.run",
  "code.languages",
  "settings.get",
  "settings.set",
  "workspace.get",
  "workspace.set",
  "workspace.scan",
  "companion.status",
  "companion.pair",
  "companion.revoke",
] as const;

export type KernelMethod = (typeof KERNEL_METHODS)[number];

export type KernelStatusInfo = {
  connected: boolean;
  host: string;
  version: string;
  dataDir: string;
  gpu?: Record<string, unknown> | null;
};

export type KernelModel = Record<string, unknown> & { id: string };
export type KernelTask = Record<string, unknown> & { id?: string };
export type KernelTaskStep = {
  stepId: string;
  tool: string;
  args: Record<string, unknown>;
  modelId: string | null;
  ok: boolean;
  error: string | null;
  attempt: number;
  durationMs: number | null;
  result: Record<string, unknown>;
  createdAt: string;
};

export type KernelTool = Record<string, unknown> & { name: string };
export type KernelChatMessage = {
  role: string;
  content: string;
  model?: string | null;
  at?: number;
};

const call = <T>(method: KernelMethod, params?: Record<string, unknown>) =>
  kernelCall<T>(method, params);

/**
 * The whole kernel, grouped the way the UI is grouped. Every entry maps to
 * exactly one dispatch method — no duplicated request logic anywhere else.
 */
export const kernelApi = {
  status: () => call<KernelStatusInfo>("kernel.status"),

  models: {
    list: () => call<{ models: KernelModel[] }>("model.list"),
    add: (model: Record<string, unknown>) => call<{ model: KernelModel }>("model.add", model),
    sync: (models: Record<string, unknown>[]) =>
      call<{ synced?: number; models?: KernelModel[] }>("model.sync", { models }),
    remove: (id: string) => call<{ removed: boolean }>("model.remove", { id }),
  },

  chat: {
    /**
     * One-shot completion that does not append to the owner's chat session.
     * Used by skill forge and similar internal writers. Billing still passes
     * through the kernel router firewall.
     */
    complete: (
      messages: { role: string; content: string }[],
      modelIds?: string[],
      options?: { explicitPaid?: boolean },
    ) =>
      call<{ ok: boolean; text?: string; modelId?: string; error?: string }>("chat.complete", {
        messages,
        ...(modelIds?.length ? { modelIds } : {}),
        ...(options?.explicitPaid ? { explicitPaid: true } : {}),
      }),
    sessions: (limit = 40) =>
      call<{ sessions: { id: string; title?: string; at?: number }[] }>("chat.sessions", { limit }),
    history: (sessionId = "main", limit = 200) =>
      call<{ sessionId: string; messages: KernelChatMessage[] }>("chat.history", {
        sessionId,
        limit,
      }),
    /**
     * Replace the kernel transcript for one session (clear = empty list).
     * The phone companion replays this on reconnect and live phones get the
     * same history push, so desktop Clear / Load cannot leave a stale log.
     */
    replace: (
      sessionId: string,
      messages: { role: string; text: string; origin?: string; modelId?: string }[],
    ) =>
      call<{ ok: boolean; sessionId: string; count: number }>("chat.replace", {
        sessionId,
        messages,
      }),
    /** Tell the kernel which conversation is open (phone turns join it). */
    setActiveSession: (sessionId: string) =>
      call<{ sessionId: string }>("session.active", { sessionId }),
    activeSession: () => call<{ sessionId: string }>("session.active"),
  },

  tasks: {
    run: (goal: string, modelIds?: string[], options?: { priority?: number; agent?: string }) =>
      call<{ done: boolean }>("task.run", { goal, modelIds, ...(options ?? {}) }),
    approve: (taskId: string, stepId: string, allow = true) =>
      call<{ ok: boolean; resumed?: boolean }>("task.approve", { taskId, stepId, allow }),
    resume: (taskId: string) => call<{ done: boolean }>("task.resume", { taskId }),
    /** Ask a running or paused task to stop; honoured between steps. */
    cancel: (taskId: string) =>
      call<{ ok: boolean; taskId: string; state: string }>("task.cancel", { taskId }),
    /** Full executed-step trail for one task (tool, args, attempt, timing). */
    steps: (taskId: string) => call<{ steps: KernelTaskStep[] }>("task.steps", { taskId }),
    pending: () => call<{ tasks: KernelTask[] }>("task.pending"),
    list: (limit = 50) => call<{ tasks: KernelTask[] }>("task.list", { limit }),
  },

  billing: {
    get: () => call<Record<string, unknown>>("billing.get"),
    set: (billing: Record<string, unknown>, policy?: string) =>
      call<Record<string, unknown>>("billing.set", { billing, policy }),
  },

  tools: {
    list: () => call<{ tools: KernelTool[] }>("tool.list"),
    /**
     * Risky tools are gated by the desktop permission broker, which mints the
     * signed authorization; the renderer cannot approve a call for itself.
     */
    exec: (name: string, args: Record<string, unknown> = {}) =>
      call<Record<string, unknown>>("tool.exec", { name, args }),
  },

  memory: {
    search: (query: string, k = 8) =>
      call<{ results: Record<string, unknown>[] }>("memory.search", { query, k }),
    index: (path: string) => call<Record<string, unknown>>("memory.index", { path }),
    add: (text: string, kind = "note", title = "note") =>
      call<{ ok: boolean; backend: string }>("memory.add", { text, kind, title }),
    reindex: () => call<Record<string, unknown>>("memory.reindex"),
    status: () => call<{ backend: string; available: boolean }>("memory.status"),
  },

  modules: {
    list: () => call<{ modules: Record<string, unknown>[] }>("module.list"),
    toggle: (name: string, enabled: boolean) =>
      call<Record<string, unknown>>("module.toggle", { name, enabled }),
  },

  runtimes: {
    list: () => call<{ runtimes: Record<string, unknown>[] }>("runtime.list"),
    install: (name: string) => call<{ done: boolean }>("runtime.install", { name }),
  },

  projects: {
    detect: () => call<{ projects: Record<string, unknown>[] }>("project.detect"),
    run: (id: string, install = false, timeout = 300) =>
      call<Record<string, unknown>>("project.run", { id, install, timeout }),
  },

  code: {
    run: (language: string, code: string, timeout = 60) =>
      call<Record<string, unknown>>("code.run", { language, code, timeout }),
    languages: () => call<{ languages: string[] }>("code.languages"),
  },

  settings: {
    get: () => call<{ settings: Record<string, unknown> }>("settings.get"),
    set: (key: string, value: unknown) =>
      call<Record<string, unknown>>("settings.set", { key, value }),
  },

  workspace: {
    get: () => call<Record<string, unknown>>("workspace.get"),
    set: (root: string) => call<Record<string, unknown>>("workspace.set", { root }),
    scan: () => call<Record<string, unknown>>("workspace.scan"),
  },

  companion: {
    status: () =>
      call<{
        enabled: boolean;
        port: number;
        ip: string | null;
        url: string | null;
        phones: unknown[];
      }>("companion.status"),
    pair: () => call<Record<string, unknown>>("companion.pair"),
    revoke: (id: string) => call<{ removed: boolean }>("companion.revoke", { id }),
  },
} as const;

export default kernelApi;
