/**
 * FRIDAY · the renderer-callable kernel surface (authoritative allowlist).
 *
 * `kernel:rpc` used to forward ANY method string the renderer supplied to the
 * Python kernel. That made the whole privileged dispatch — including future
 * methods nobody audited — reachable from renderer code, from an injected
 * script, or from a compromised page inside the FRIDAY Browser.
 *
 * This file is the single source of truth for what the renderer may call. It
 * mirrors `KERNEL_METHODS` in `src/lib/friday/kernel-api.ts` (the typed client)
 * and the dispatch table in `kernel/main.py`; a test keeps the three in sync so
 * the list cannot drift silently. Anything not listed here is refused in the
 * main process and never reaches the kernel.
 */
const KERNEL_METHODS = [
  "kernel.status",
  "model.list",
  "model.add",
  "model.sync",
  "model.remove",
  "chat.stream",
  "chat.complete",
  "task.run",
  "task.approve",
  "task.resume",
  "task.cancel",
  "task.steps",
  "task.pending",
  "task.list",
  "billing.set",
  "billing.get",
  "tool.list",
  "tool.exec",
  "session.active",
  "chat.sessions",
  "chat.history",
  "chat.replace",
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
];

const ALLOWED = new Set(KERNEL_METHODS);

/** True only for a method the renderer is allowed to reach. */
const isAllowedKernelMethod = (method) => ALLOWED.has(String(method || ""));

/**
 * Fields a caller must never be able to set: they are the authorization the
 * main process alone mints. Stripped from EVERY method, not just `tool.exec`,
 * so no future kernel method can be self-approved by its caller.
 */
const CALLER_FORBIDDEN_FIELDS = ["approved", "authorization", "privacyConfirmed"];

module.exports = { KERNEL_METHODS, isAllowedKernelMethod, CALLER_FORBIDDEN_FIELDS };
