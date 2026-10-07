/**
 * Renderer client for FRIDAY's real workspace terminal.
 *
 * In the desktop app every command is executed by a real child process in the
 * FRIDAY workspace root (electron/terminal.cjs). In the browser preview these
 * calls report that the terminal is desktop-only, and the ops engine falls
 * back to its documented preview shell.
 */

export type TerminalOutputEvent = {
  runId: string;
  phase: "start" | "output" | "done";
  kind?: "out" | "err";
  text?: string;
  command?: string;
  cwd?: string;
  shell?: string;
  ok?: boolean;
  code?: number | null;
  error?: string;
  ms?: number;
};

export type TerminalRunResult = {
  ok: boolean;
  code?: number | null;
  error?: string;
  output?: string;
  cwd?: string;
  runId?: string;
  ms?: number;
};

/** One shell profile FRIDAY can drive on this machine. */
export type TerminalShell = {
  id: string;
  label: string;
  bin: string;
  available: boolean;
  path?: string | null;
  default?: boolean;
  reason?: string;
};

export type TerminalRunInfo = {
  runId: string;
  command: string;
  cwd: string;
  shell: string;
  ms: number;
};

export type TerminalExecOptions = {
  command: string;
  cwd?: string;
  runId?: string;
  shell?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

type Bridge = {
  terminalExec?: (options: TerminalExecOptions) => Promise<TerminalRunResult>;
  terminalCancel?: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  terminalWrite?: (runId: string, data: string) => Promise<{ ok: boolean; error?: string }>;
  terminalRuns?: () => Promise<TerminalRunInfo[]>;
  terminalShells?: () => Promise<TerminalShell[]>;
  terminalCd?: (
    cwd: string,
    target: string,
  ) => Promise<{ ok: boolean; cwd: string; error?: string }>;
  terminalRoot?: () => Promise<{ root: string | null }>;
  onTerminalOutput?: (cb: (event: TerminalOutputEvent) => void) => () => void;
};

const api = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { friday?: Bridge }).friday;

const DESKTOP_ONLY = "The FRIDAY terminal runs in the desktop app.";

export const terminalAvailable = (): boolean => Boolean(api()?.terminalExec);

export const terminalRoot = async (): Promise<string | null> =>
  (await api()?.terminalRoot?.())?.root ?? null;

export const terminalCd = async (cwd: string, target: string) =>
  (await api()?.terminalCd?.(cwd, target)) ?? { ok: false, cwd, error: DESKTOP_ONLY };

export const terminalExec = async (options: TerminalExecOptions) =>
  (await api()?.terminalExec?.(options)) ?? { ok: false, error: DESKTOP_ONLY };

export const terminalCancel = async (runId: string) =>
  (await api()?.terminalCancel?.(runId)) ?? { ok: false, error: DESKTOP_ONLY };

export const terminalWrite = async (runId: string, data: string) =>
  (await api()?.terminalWrite?.(runId, data)) ?? { ok: false, error: DESKTOP_ONLY };

export const terminalRuns = async (): Promise<TerminalRunInfo[]> =>
  (await api()?.terminalRuns?.()) ?? [];

export const terminalShells = async (): Promise<TerminalShell[]> =>
  (await api()?.terminalShells?.()) ?? [];

export const onTerminalOutput = (cb: (event: TerminalOutputEvent) => void): (() => void) =>
  api()?.onTerminalOutput?.(cb) ?? (() => {});
