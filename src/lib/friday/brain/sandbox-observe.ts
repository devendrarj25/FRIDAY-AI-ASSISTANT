/**
 * FRIDAY · read-only sandbox-lab observation
 *
 * Core Brain only reads the live Sandbox session the owner (or FRIDAY) already
 * produced. It never spawns a second lab. Running a command stays on
 * `electron/sandbox-lab.cjs` behind the existing approval gate. Apply-to-source
 * stays owner-gated on the Sandbox page.
 */

import { extractSandboxRun } from "../sandbox-command";
import { formatSandboxExtra, sandboxSnapshot, type SandboxSession } from "../sandbox-awareness";

const LOOK =
  /\b(look at (the |my )?sandbox|what(?:'s| is) (in|on) (the |my )?sandbox|sandbox (output|log|error|buffer)|that sandbox (output|error)|why did (the )?sandbox (fail|exit)|explain (that|this|the) sandbox (error|output|exit)|find (the )?(errors|bugs|failures) in (the )?sandbox)\b/i;

export function sandboxLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

/** Chat / Auto Mode should attach the live sandbox buffer for looks and runs. */
export function shouldAttachSandboxExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (sandboxLookRequested(text)) return true;
  return Boolean(extractSandboxRun(text));
}

export type SandboxObservation = {
  readOnly: true;
  spawned: false;
  projectId: string | null;
  engine: string | null;
  running: boolean;
  lastCommand: string | null;
  summary: string;
  extra: string;
};

export function observationFromSandbox(snap: SandboxSession): SandboxObservation {
  let summary: string;
  if (!snap.projectId && !snap.output) {
    summary = "sandbox lab idle — no project buffer yet; apply to source stays owner-gated";
  } else if (snap.running) {
    summary = `sandbox running ${snap.lastCommand || "a command"} in ${snap.projectName || snap.projectId}`;
  } else {
    summary = `sandbox ${snap.projectName || snap.projectId || "idle"}; last ${snap.lastCommand || "none"}`;
  }
  return {
    readOnly: true,
    spawned: false,
    projectId: snap.projectId,
    engine: snap.engine,
    running: snap.running,
    lastCommand: snap.lastCommand,
    summary,
    extra: formatSandboxExtra(),
  };
}

export function observeSandboxState(): SandboxObservation {
  return observationFromSandbox(sandboxSnapshot());
}
