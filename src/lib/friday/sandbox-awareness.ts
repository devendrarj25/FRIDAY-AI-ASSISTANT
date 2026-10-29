/**
 * FRIDAY · live sandbox-lab session (renderer)
 *
 * One shared snapshot of the Sandbox page so Core Brain, Auto Mode, and Chat
 * see the same project / engine / buffer the owner is looking at. The real
 * child process still lives in `electron/sandbox-lab.cjs`; this module never
 * spawns a second sandbox.
 */

import {
  createProject,
  execCommand,
  loadSummary,
  planChecks,
  type SandboxRunResult,
} from "./sandbox-lab";
import type { SandboxRunPlan } from "./sandbox-command";
import { summarizeSandboxOutput } from "./sandbox-command";

export type SandboxSession = {
  projectId: string | null;
  projectName: string | null;
  engine: string | null;
  template: string | null;
  dir: string | null;
  running: boolean;
  lastCommand: string | null;
  lastExitOk: boolean | null;
  lastExitCode: number | null;
  output: string;
  lastErrors: string;
  desktop: boolean;
};

export type SandboxLabOptions = {
  projectId?: string;
  template?: string;
  name?: string;
  actor?: string;
};

const empty = (): SandboxSession => ({
  projectId: null,
  projectName: null,
  engine: null,
  template: null,
  dir: null,
  running: false,
  lastCommand: null,
  lastExitOk: null,
  lastExitCode: null,
  output: "",
  lastErrors: "",
  desktop: false,
});

let session: SandboxSession = empty();
let runner:
  | ((
      command: string,
      options: SandboxLabOptions,
    ) => Promise<SandboxRunResult & { skipped?: boolean }>)
  | null = null;
let asker: ((prompt: string) => void) | null = null;

export function sandboxSnapshot(): SandboxSession {
  return session;
}

export function publishSandboxSession(patch: Partial<SandboxSession>): SandboxSession {
  const output = patch.output !== undefined ? String(patch.output).slice(-120000) : session.output;
  session = {
    ...session,
    ...patch,
    output,
    lastErrors:
      patch.lastErrors !== undefined
        ? patch.lastErrors
        : patch.output !== undefined
          ? summarizeSandboxOutput(output)
          : session.lastErrors,
  };
  return session;
}

export function registerSandboxRunner(
  fn: (
    command: string,
    options: SandboxLabOptions,
  ) => Promise<SandboxRunResult & { skipped?: boolean }>,
): void {
  runner = fn;
}

export function registerSandboxAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestSandboxAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function isSandboxLabTool(tool: string): boolean {
  return tool === "sandbox.exec";
}

async function ensureProject(options: SandboxLabOptions = {}): Promise<{
  ok: boolean;
  id?: string;
  error?: string;
}> {
  if (options.projectId) return { ok: true, id: options.projectId };
  if (session.projectId) return { ok: true, id: session.projectId };
  const summary = await loadSummary();
  const existing = summary.projects.find((p) => p.name === "friday-scratch" && p.exists);
  if (existing) return { ok: true, id: existing.id };
  const created = await createProject("friday-scratch", options.template || "friday");
  if (created.ok && created.project) {
    publishSandboxSession({
      projectId: created.project.id,
      projectName: created.project.name,
      template: created.project.template,
      dir: created.project.dir,
      desktop: true,
    });
    return { ok: true, id: created.project.id };
  }
  return { ok: false, error: created.error ?? "Could not create the scratch project." };
}

/**
 * Run on the same sandbox project the Sandbox page uses. Returns
 * `{ skipped: true }` when the page has not registered (tests / kernel-only).
 */
export async function runSandboxLab(
  command: string,
  options: SandboxLabOptions = {},
): Promise<SandboxRunResult & { skipped?: boolean }> {
  const line = String(command || "").trim();
  if (!line) return { ok: false, error: "no command given" };
  if (runner) return runner(line, options);
  const project = await ensureProject(options);
  if (!project.ok || !project.id) {
    return { ok: false, error: project.error ?? "no sandbox project" };
  }
  return execCommand({ id: project.id, command: line });
}

export async function runSandboxPlan(
  plan: SandboxRunPlan,
  options: SandboxLabOptions = {},
): Promise<SandboxRunResult & { skipped?: boolean; detail?: string }> {
  if (plan.op === "apply") {
    return {
      ok: false,
      error:
        "I cannot apply sandbox changes to the FRIDAY source myself. Approve the files on the Sandbox page.",
    };
  }
  if (plan.op === "create") {
    const created = await createProject(plan.name || "friday-scratch", plan.template || "node");
    if (created.ok && created.project) {
      publishSandboxSession({
        projectId: created.project.id,
        projectName: created.project.name,
        template: created.project.template,
        dir: created.project.dir,
        desktop: true,
      });
    }
    return {
      ok: Boolean(created.ok),
      ...(created.error ? { error: created.error } : {}),
      output: created.ok
        ? `created ${created.project?.name ?? "project"}`
        : (created.error ?? "create failed"),
    };
  }
  if (plan.op === "checks") {
    const project = await ensureProject(options);
    if (!project.ok || !project.id) {
      return { ok: false, error: project.error ?? "no sandbox project" };
    }
    const planned = await planChecks(project.id);
    if (!planned.ok) return { ok: false, error: planned.error ?? "could not plan checks" };
    if (!planned.checks.length) {
      return { ok: true, output: "No check targets in this sandbox project yet." };
    }
    const lines: string[] = [];
    let ok = true;
    for (const check of planned.checks) {
      const result = await runSandboxLab(check.command, { ...options, projectId: project.id });
      const chunk = (result.output || result.error || "").slice(-800);
      lines.push(`${check.label}: ${result.ok ? "ok" : "failed"}\n${chunk}`.trim());
      if (!result.ok) ok = false;
    }
    return { ok, output: lines.join("\n\n") };
  }
  if (!plan.command) return { ok: false, error: "no command given" };
  return runSandboxLab(plan.command, options);
}

export function formatSandboxExtra(maxChars = 4000): string {
  const snap = session;
  const body = snap.output.slice(-maxChars);
  const errors = snap.lastErrors.slice(-1200);
  return [
    "SANDBOX SESSION (live FRIDAY sandbox lab — not invented)",
    `project: ${snap.projectName || snap.projectId || "(none)"}`,
    `dir: ${snap.dir || "(unset)"}`,
    `engine: ${snap.engine || "(auto)"}`,
    `template: ${snap.template || "(unset)"}`,
    `running: ${snap.running ? "yes" : "no"}`,
    snap.lastCommand ? `last command: ${snap.lastCommand}` : "last command: none this session",
    snap.lastExitOk === null
      ? "last exit: none"
      : `last exit: ${snap.lastExitOk ? "0" : String(snap.lastExitCode ?? "failed")}`,
    "recent buffer:",
    body || "(empty)",
    errors ? `error lines:\n${errors}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function resetSandboxSession(): void {
  session = empty();
}
