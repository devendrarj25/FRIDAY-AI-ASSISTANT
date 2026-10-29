/**
 * Format kernel / telemetry log payloads for the Logs page.
 * Live lines come from the main-process ring (`electron/telemetry.cjs`).
 */

export type LogLevel = "info" | "debug" | "warn" | "error";

export type LogLine = {
  id: string;
  at: string;
  atMs?: number;
  level: LogLevel;
  source: string;
  message: string;
};

export type IpcLine = {
  id: string;
  at: string;
  atMs?: number;
  channel: string;
  ok: boolean;
  ms: number;
  error?: string;
};

const LEVELS = new Set<string>(["info", "debug", "warn", "error"]);

export const asLogLevel = (value: string): LogLevel =>
  (LEVELS.has(value) ? value : "info") as LogLevel;

const stamp = (at: number) => new Date(at).toISOString().slice(11, 23);

export function telemetryEntryToLine(
  entry: { id?: string; at: number; level: string; source: string; message: string },
  index = 0,
): LogLine {
  const atMs = Number(entry.at) || Date.now();
  return {
    id: entry.id || `${atMs}-${index}-${entry.source}`,
    at: stamp(atMs),
    atMs,
    level: asLogLevel(entry.level),
    source: entry.source,
    message: entry.message,
  };
}

export function ipcEntryToLine(
  entry: { id?: string; at: number; channel: string; ok: boolean; ms: number; error?: string },
  index = 0,
): IpcLine {
  const atMs = Number(entry.at) || Date.now();
  return {
    id: entry.id || `${atMs}-${index}-${entry.channel}`,
    at: stamp(atMs),
    atMs,
    channel: entry.channel,
    ok: Boolean(entry.ok),
    ms: Number(entry.ms) || 0,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export function kernelChunkToLines(level: string, text: string, at = Date.now()): LogLine[] {
  return String(text)
    .split(/\r?\n/)
    .map((message) => message.trimEnd())
    .filter((message) => message.trim().length > 0)
    .map((message, index) => ({
      id: `${at}-${index}-${message.slice(0, 24)}`,
      at: stamp(at),
      atMs: at,
      level: asLogLevel(level),
      source: "kernel",
      message,
    }));
}

export const LOG_STREAM_CAP = 300;
export const IPC_STREAM_CAP = 300;

function capById<T extends { id: string }>(existing: T[], incoming: T[], cap: number): T[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((row) => row.id));
  const extra = incoming.filter((row) => !seen.has(row.id));
  if (!extra.length) return existing;
  const next = existing.concat(extra);
  return next.length > cap ? next.slice(-cap) : next;
}

export function appendLogLines(existing: LogLine[], incoming: LogLine[]): LogLine[] {
  return capById(existing, incoming, LOG_STREAM_CAP);
}

export function appendIpcLines(existing: IpcLine[], incoming: IpcLine[]): IpcLine[] {
  return capById(existing, incoming, IPC_STREAM_CAP);
}

const ERROR_LINE =
  /\b(error|fail(ed|ure)?|traceback|exception|uncaught|fatal|npm err!|exit code [1-9])/i;

/** Pull the last failing lines from the live log buffer. Does not spawn. */
export function summarizeLogErrors(lines: LogLine[], maxLines = 12): string {
  const hits = lines.filter(
    (line) => line.level === "error" || line.level === "warn" || ERROR_LINE.test(line.message),
  );
  if (!hits.length) return "";
  return hits
    .slice(-maxLines)
    .map((line) => `${line.at} [${line.level}] ${line.source} ${line.message}`)
    .join("\n");
}

export function filterLogLines(
  lines: LogLine[],
  options: { level?: LogLevel | "all"; source?: string | "all"; query?: string },
): LogLine[] {
  const level = options.level && options.level !== "all" ? options.level : null;
  const source = options.source && options.source !== "all" ? options.source : null;
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return lines.filter((line) => {
    if (level && line.level !== level) return false;
    if (source && line.source !== source) return false;
    if (query && !`${line.source} ${line.message}`.toLowerCase().includes(query)) return false;
    return true;
  });
}
