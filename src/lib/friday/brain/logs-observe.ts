/**
 * FRIDAY · read-only Logs observation
 *
 * Core Brain only reads the live Logs session the owner (or FRIDAY) already
 * produced. It never tails a second file. The store stays
 * `electron/telemetry.cjs`.
 */

import { formatLogsExtra, logsSnapshot, type LogsSession } from "../logs-awareness";

const LOOK =
  /\b(look at (the |my )?logs?|what(?:'s| is) (in|on) (the |my )?logs?|logs? (page|stream|buffer|output|file)|that log|explain (that|this|the) logs?|find (the )?(errors|warnings|failures) in (the )?logs?|why did (it|friday|the kernel) (fail|crash|exit)|show (me )?(the )?(errors|warnings) in (the )?logs?)\b/i;

export function logsLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

/** Chat / Auto Mode should attach the live log buffer for looks. */
export function shouldAttachLogsExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return logsLookRequested(text);
}

export type LogsObservation = {
  readOnly: true;
  spawned: false;
  file: string | null;
  summary: string;
  extra: string;
};

export function observationFromLogs(snap: LogsSession): LogsObservation {
  let summary: string;
  if (!snap.lines.length) {
    summary = "logs idle — no entries in the live ring yet";
  } else if (snap.lastErrors) {
    summary = `logs ${snap.lines.length} entries with warnings/errors in ${snap.file || "memory"}`;
  } else {
    summary = `logs ${snap.lines.length} entries from ${snap.file || "memory"}`;
  }
  return {
    readOnly: true,
    spawned: false,
    file: snap.file,
    summary,
    extra: formatLogsExtra(),
  };
}

export function observeLogsState(): LogsObservation {
  return observationFromLogs(logsSnapshot());
}
