/**
 * FRIDAY · live Logs session (renderer)
 *
 * One shared snapshot of the Logs page so Core Brain, Auto Mode, and Chat see
 * the same ring the owner is looking at. The real store is
 * `electron/telemetry.cjs`; this module never opens a second file tail.
 */

import { summarizeLogErrors, type IpcLine, type LogLine } from "./log-stream";

export type LogsSession = {
  desktop: boolean;
  file: string | null;
  follow: boolean;
  lines: LogLine[];
  ipc: IpcLine[];
  lastErrors: string;
};

const empty = (): LogsSession => ({
  desktop: false,
  file: null,
  follow: true,
  lines: [],
  ipc: [],
  lastErrors: "",
});

let session: LogsSession = empty();
let asker: ((prompt: string) => void) | null = null;

export function logsSnapshot(): LogsSession {
  return session;
}

export function publishLogsSession(patch: Partial<LogsSession>): LogsSession {
  const lines = patch.lines ? patch.lines.slice(-300) : session.lines;
  session = {
    ...session,
    ...patch,
    lines,
    ipc: patch.ipc ? patch.ipc.slice(-300) : session.ipc,
    lastErrors:
      patch.lastErrors !== undefined
        ? patch.lastErrors
        : patch.lines
          ? summarizeLogErrors(lines)
          : session.lastErrors,
  };
  return session;
}

export function registerLogsAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestLogsAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function formatLogsExtra(maxChars = 4000): string {
  const snap = session;
  const body = snap.lines
    .slice(-60)
    .map((line) => `${line.at} [${line.level}] ${line.source} ${line.message}`)
    .join("\n")
    .slice(-maxChars);
  const errors = snap.lastErrors.slice(-1200);
  return [
    "LOGS SESSION (live FRIDAY telemetry ring + logs/main.log — not invented)",
    snap.file ? `file: ${snap.file}` : "file: (no FRIDAY folder yet)",
    `entries: ${snap.lines.length}`,
    `follow: ${snap.follow ? "yes" : "paused scroll"}`,
    errors ? `recent errors:\n${errors}` : "recent errors: none in this buffer",
    "recent buffer:",
    body || "(empty)",
  ].join("\n");
}

export function resetLogsSession(): void {
  session = empty();
}
