/**
 * FRIDAY · read-only workspace-terminal observation
 *
 * Core Brain only reads the live Terminal session the owner (or FRIDAY) already
 * produced. It never spawns a second shell. Running a command stays on
 * `electron/terminal.cjs` behind the existing approval gate.
 */

import { extractTerminalRun } from "../terminal-command";
import { formatTerminalExtra, terminalSnapshot, type TerminalSession } from "../terminal-awareness";

const LOOK =
  /\b(look at (the |my )?terminal|what(?:'s| is) (in|on) (the |my )?terminal|last command|that (output|error)|the (output|error) (above|in the terminal)|what did (that|the command) (print|return|say)|workspace shell buffer|why did (it|that|this) fail|explain (that|this|the) (error|output|exit))\b/i;

export function terminalLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

/** Chat / Auto Mode should attach the live buffer for looks and for run-in-terminal. */
export function shouldAttachTerminalExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (terminalLookRequested(text)) return true;
  return Boolean(extractTerminalRun(text));
}

export type TerminalObservation = {
  readOnly: true;
  spawned: false;
  cwd: string;
  shell: string;
  running: boolean;
  lastCommand: string | null;
  summary: string;
  extra: string;
};

export function observationFromTerminal(snap: TerminalSession): TerminalObservation {
  let summary: string;
  if (!snap.cwd && !snap.lines.length) {
    summary =
      "workspace terminal idle — no buffer yet; commands stay confined to the FRIDAY root after approval";
  } else if (snap.running) {
    summary = `workspace terminal running in ${snap.cwd || "FRIDAY root"} via ${snap.shell}`;
  } else {
    summary = `workspace terminal ${snap.shell} at ${snap.cwd || "FRIDAY root"}; last ${
      snap.lastCommand || "none"
    }`;
  }
  return {
    readOnly: true,
    spawned: false,
    cwd: snap.cwd,
    shell: snap.shell,
    running: snap.running,
    lastCommand: snap.lastCommand,
    summary,
    extra: formatTerminalExtra(),
  };
}

export function observeTerminalState(): TerminalObservation {
  return observationFromTerminal(terminalSnapshot());
}
