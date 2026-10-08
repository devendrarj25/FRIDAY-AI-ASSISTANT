/**
 * FRIDAY · failure recovery.
 *
 * Classifies a fault and says what the existing path should do. A spoken yes
 * still expires on its own clock. Offline work stays on chat, tasks, memory,
 * and a local model.
 */

import { revokeWatch, type WatchSession } from "./flow-graph";
import { SENSE_IDS, SENSE_TOGGLE, stopAllPatch } from "./senses";

export const STARTUP_BUDGET_MS = 8_000;
export const IDLE_CPU_PERCENT = 1;

export type FailureKind =
  | "kernel-crash"
  | "provider-outage"
  | "disk-full"
  | "permission-denied"
  | "clock-jump"
  | "corrupt-state"
  | "interrupted-write"
  | "other";

export type Recovery = {
  action: "resume" | "retry" | "fallback" | "stop" | "expire" | "restore";
  reason: string;
};

const PROVIDER = /\b429\b|rate limit|provider outage|provider unavailable/i;
const DISK = /enospc|disk full|no space left/i;
const DENIED = /eacces|eperm|permission denied|access is denied/i;
const CLOCK = /clock jump|time jump|clock skew/i;
const CORRUPT = /corrupt|malformed json|unexpected token/i;
const INTERRUPT = /interrupted write|partial write/i;
const CRASH = /kernel crash|kernel restart|process crash/i;

export function classifyFailure(message: string, code = ""): FailureKind {
  const text = `${code} ${message}`;
  if (PROVIDER.test(text)) return "provider-outage";
  if (DISK.test(text)) return "disk-full";
  if (DENIED.test(text)) return "permission-denied";
  if (CLOCK.test(text)) return "clock-jump";
  if (CORRUPT.test(text)) return "corrupt-state";
  if (INTERRUPT.test(text)) return "interrupted-write";
  if (CRASH.test(text)) return "kernel-crash";
  return "other";
}

/** What to do next. A provider fault retries once, then falls back. */
export function recoverFailure(kind: FailureKind, attempts = 0): Recovery {
  if (kind === "kernel-crash") {
    return { action: "resume", reason: "the checkpoint stays interrupted until the run continues" };
  }
  if (kind === "provider-outage") {
    if (attempts < 2)
      return { action: "retry", reason: "transient provider failure — one bounded retry" };
    return { action: "fallback", reason: "already retried — fall back instead of looping" };
  }
  if (kind === "disk-full" || kind === "permission-denied") {
    return { action: "stop", reason: "the write did not land and the previous file stays" };
  }
  if (kind === "clock-jump") {
    return { action: "expire", reason: "a jumped clock does not extend a spoken yes" };
  }
  if (kind === "corrupt-state" || kind === "interrupted-write") {
    return { action: "restore", reason: "the backup written before the change is copied back" };
  }
  return { action: "fallback", reason: "use the existing safer path" };
}

/** Elapsed time from an injected clock. A backward jump is not inside the budget. */
export function startupWithin(
  start: number,
  ready: number,
  budget = STARTUP_BUDGET_MS,
): { ok: boolean; elapsed: number } {
  const elapsed = ready - start;
  return { ok: elapsed >= 0 && elapsed <= budget, elapsed };
}

/** Peak of injected samples. The live process was not measured. */
export function idleWithin(
  samples: number[],
  budget = IDLE_CPU_PERCENT,
): { ok: boolean; peak: number } {
  const peak = samples.reduce((max, sample) => Math.max(max, sample), 0);
  return { ok: samples.length > 0 && samples.every((sample) => sample <= budget), peak };
}

/**
 * Chat, tasks, and memory stay available without a network.
 * A cloud call stays closed while offline. A local model is used only when one is present.
 */
export function offlineFlows(input: {
  online: boolean;
  hasLocalModel: boolean;
  localStt?: boolean;
  offlineTts?: boolean;
}): {
  chat: true;
  tasks: true;
  memory: true;
  localModel: boolean;
  localStt: boolean;
  offlineTts: boolean;
  cloud: boolean;
  status: string;
} {
  const localStt = input.localStt !== false;
  const offlineTts = input.offlineTts !== false;
  const status = input.online
    ? "online"
    : localStt && offlineTts
      ? "offline — local chat, memory, tasks, and on-device voice stay available"
      : "offline — a local speech piece is missing";
  return {
    chat: true,
    tasks: true,
    memory: true,
    localModel: input.hasLocalModel,
    localStt,
    offlineTts,
    cloud: input.online,
    status,
  };
}

export function voiceBudgets(input: {
  listenMs: number;
  audioMs: number;
  idleCpu: number[];
  memoryMb: number[];
}): { id: string; ok: boolean }[] {
  const newest = input.memoryMb[input.memoryMb.length - 1];
  const oldest = input.memoryMb[0];
  const growth =
    input.memoryMb.length > 1 && newest !== undefined && oldest !== undefined ? newest - oldest : 0;
  const idle = input.idleCpu.length ? Math.max(...input.idleCpu) : 0;
  return [
    { id: "first-listen", ok: input.listenMs <= 45000 },
    { id: "first-audio", ok: input.audioMs <= 1500 },
    { id: "idle-cpu", ok: idle <= 2 },
    { id: "memory", ok: growth <= 64 },
  ];
}

export type WaveCheck = {
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Missing" | "Warning";
  detail: string;
  fix: string;
  fixable: boolean;
};

export type WaveSnapshot = {
  toggles?: Record<string, boolean | undefined>;
  consent?: boolean;
  playbookEnabled?: boolean;
  speakerPresent?: boolean;
};

function senseIsOn(toggles: Record<string, boolean | undefined> | undefined): boolean {
  const flags = toggles ?? {};
  return SENSE_IDS.some((id) => flags[SENSE_TOGGLE[id]] === true);
}

/** Rows for senses, watching, the page agent, playbooks, and the speaker file. */
export function waveCapabilityChecks(input: WaveSnapshot = {}): WaveCheck[] {
  const sensesOn = senseIsOn(input.toggles);
  const consent = input.consent === true;
  const playbookOn = input.playbookEnabled === true;
  const speaker = input.speakerPresent === true;
  return [
    {
      id: "sense:watching",
      label: "Owner senses",
      group: "Desktop",
      status: sensesOn ? "Warning" : "Ready",
      detail: sensesOn
        ? "One or more senses are on. Repair turns them all off. The live Windows hook was not read here."
        : "Every sense is off. The live Windows hook was not read here.",
      fix: "Turn every sense off.",
      fixable: sensesOn,
    },
    {
      id: "watch:learn",
      label: "Learn by watching",
      group: "Desktop",
      status: consent ? "Warning" : "Ready",
      detail: consent
        ? "A recording is open. Repair clears consent and drops the steps."
        : "No recording is open in this check. A password step is omitted.",
      fix: "Clear the recording consent.",
      fixable: consent,
    },
    {
      id: "browser:page",
      label: "Browser page agent",
      group: "Desktop",
      status: "Warning",
      detail:
        "A live page was not driven. A host off the allow list, a login, a payment, and a captcha stay a handoff. Repair does not edit the allow list.",
      fix: "Keep the allow list as you set it.",
      fixable: false,
    },
    {
      id: "playbook:daily",
      label: "Daily desk playbooks",
      group: "Desktop",
      status: playbookOn ? "Warning" : "Ready",
      detail: playbookOn
        ? "The daily pack is enabled. Repair keeps it disabled. A send still waits, and nothing deletes."
        : "The daily pack stays disabled. A send still waits, and nothing deletes.",
      fix: "Leave the daily pack disabled.",
      fixable: playbookOn,
    },
    {
      id: "speaker:ecapa",
      label: "Speaker match file",
      group: "Voice",
      status: speaker ? "Ready" : "Missing",
      detail: speaker
        ? "A speaker file is present. A match still does not execute. This check did not score a voice."
        : "WeSpeaker ECAPA is CC-BY-4.0, not bundled, and was not downloaded here. A missing file is not a match.",
      fix: "Place the file on this PC when you choose to. FRIDAY does not fetch it.",
      fixable: false,
    },
  ];
}

export type WaveRepair = {
  ok: boolean;
  kind: "auto-fixed" | "needs-owner";
  reason: string;
  patch: Record<string, boolean>;
  session: WatchSession | null;
  playbookEnabled: boolean | null;
};

/** Repair that stays on this PC. A speaker file and a page allow list stay with the owner. */
export function repairWaveCapability(id: string, session?: WatchSession): WaveRepair {
  if (id === "sense:watching") {
    return {
      ok: true,
      kind: "auto-fixed",
      reason: "every sense is off",
      patch: stopAllPatch(),
      session: null,
      playbookEnabled: null,
    };
  }
  if (id === "watch:learn") {
    const cleared = revokeWatch(session ?? { consent: true, steps: [] });
    return {
      ok: true,
      kind: "auto-fixed",
      reason: "consent cleared",
      patch: {},
      session: cleared,
      playbookEnabled: null,
    };
  }
  if (id === "playbook:daily") {
    return {
      ok: true,
      kind: "auto-fixed",
      reason: "the pack stays disabled",
      patch: {},
      session: null,
      playbookEnabled: false,
    };
  }
  return {
    ok: false,
    kind: "needs-owner",
    reason: "this check needs the owner",
    patch: {},
    session: null,
    playbookEnabled: null,
  };
}
