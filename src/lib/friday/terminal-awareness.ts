/**
 * FRIDAY · live workspace-terminal session (renderer)
 *
 * One shared snapshot of the Terminal console so Core Brain, Auto Mode, and
 * Chat can see the same cwd / shell / buffer the owner is looking at. The
 * real child process still lives in `electron/terminal.cjs`; this module
 * never spawns a second shell.
 */

import type { TerminalRunResult, TerminalShell } from "./terminal";

export type TerminalLineKind = "cmd" | "out" | "warn" | "err" | "ok";

export type TerminalSessionLine = {
  kind: TerminalLineKind;
  text: string;
};

export type TerminalSession = {
  cwd: string;
  shell: string;
  running: boolean;
  lastCommand: string | null;
  lastExitOk: boolean | null;
  lastExitCode: number | null;
  lines: TerminalSessionLine[];
  shells: Array<Pick<TerminalShell, "id" | "label" | "available"> & { reason?: string }>;
  history: string[];
  desktop: boolean;
};

export type WorkspaceShellOptions = {
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  actor?: string;
};

const empty = (): TerminalSession => ({
  cwd: "",
  shell: "cmd",
  running: false,
  lastCommand: null,
  lastExitOk: null,
  lastExitCode: null,
  lines: [],
  shells: [],
  history: [],
  desktop: false,
});

let session: TerminalSession = empty();
let runner:
  | ((
      command: string,
      options: WorkspaceShellOptions,
    ) => Promise<TerminalRunResult & { skipped?: boolean }>)
  | null = null;
let asker: ((prompt: string) => void) | null = null;

export function terminalSnapshot(): TerminalSession {
  return session;
}

export function publishTerminalSession(patch: Partial<TerminalSession>): TerminalSession {
  session = {
    ...session,
    ...patch,
    lines: patch.lines ? patch.lines.slice(-80) : session.lines,
    history: patch.history ? patch.history.slice(0, 50) : session.history,
    shells: patch.shells ?? session.shells,
  };
  return session;
}

export function registerTerminalRunner(
  fn: (
    command: string,
    options: WorkspaceShellOptions,
  ) => Promise<TerminalRunResult & { skipped?: boolean }>,
): void {
  runner = fn;
}

export function registerTerminalAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestTerminalAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function isWorkspaceShellTool(tool: string): boolean {
  return tool === "shell.cmd" || tool === "shell.powershell";
}

/**
 * Run on the same console the Terminal page uses. Returns `{ skipped: true }`
 * when the ops engine has not registered (tests / kernel-only) so the caller
 * can fall back to `tool.exec`.
 */
export async function runWorkspaceShell(
  command: string,
  options: WorkspaceShellOptions = {},
): Promise<TerminalRunResult & { skipped?: boolean }> {
  const line = String(command || "").trim();
  if (!line) return { ok: false, error: "no command given" };
  if (!runner)
    return { ok: false, skipped: true, error: "workspace terminal runner not registered" };
  return runner(line, options);
}

export function formatTerminalExtra(maxChars = 4000): string {
  const snap = session;
  const body = snap.lines
    .slice(-60)
    .map((line) => line.text)
    .join("\n")
    .slice(-maxChars);
  const shells = snap.shells.map((s) => `${s.id}${s.available ? "" : " (missing)"}`).join(", ");
  return [
    "TERMINAL SESSION (live FRIDAY workspace console — not invented)",
    `cwd: ${snap.cwd || "(unset)"}`,
    `shell: ${snap.shell}`,
    `running: ${snap.running ? "yes" : "no"}`,
    snap.lastCommand ? `last command: ${snap.lastCommand}` : "last command: none this session",
    snap.lastExitOk === null
      ? "last exit: none"
      : `last exit: ${snap.lastExitOk ? "0" : String(snap.lastExitCode ?? "failed")}`,
    shells ? `profiles: ${shells}` : "",
    "recent buffer:",
    body || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

export function resetTerminalSession(): void {
  session = empty();
}
