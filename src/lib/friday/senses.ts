/**
 * FRIDAY · owner senses.
 *
 * Each sense is off until the owner turns it on. A folder event is kept only
 * when the path is on the approved list. The text is data. Nothing here
 * starts an action.
 */

import { redactRunText } from "./self/run-receipt";

export const SENSE_IDS = [
  "foreground",
  "folder",
  "idle",
  "lock",
  "power",
  "network",
  "calendar",
] as const;

export type SenseId = (typeof SENSE_IDS)[number];

export type SenseSwitches = Record<SenseId, boolean>;

export const SENSE_TOGGLE: Record<SenseId, string> = {
  foreground: "senseForeground",
  folder: "senseFolder",
  idle: "senseIdle",
  lock: "senseLock",
  power: "sensePower",
  network: "senseNetwork",
  calendar: "senseCalendar",
};

export const SENSES_OFF: SenseSwitches = {
  foreground: false,
  folder: false,
  idle: false,
  lock: false,
  power: false,
  network: false,
  calendar: false,
};

export type RawSense = {
  sense: SenseId;
  at: number;
  text?: string;
  path?: string;
  approvedFolders?: string[];
};

export type SenseEvent = {
  sense: SenseId;
  at: number;
  text: string;
  path: string;
  untrusted: true;
  instruction: false;
};

function folderKey(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function switchesFromToggles(toggles: Record<string, boolean> | undefined): SenseSwitches {
  const next = { ...SENSES_OFF };
  for (const id of SENSE_IDS) next[id] = toggles?.[SENSE_TOGGLE[id]] === true;
  return next;
}

/** Drops a sense that is off, and a folder that was not approved. */
export function admitSense(switches: SenseSwitches, raw: RawSense): SenseEvent | null {
  if (!switches[raw.sense]) return null;
  const path = folderKey(raw.path || "");
  if (raw.sense === "folder") {
    const allowed = (raw.approvedFolders || []).map(folderKey).filter(Boolean);
    const inside = allowed.some((root) => path === root || path.startsWith(`${root}/`));
    if (!inside) return null;
  }
  return {
    sense: raw.sense,
    at: raw.at,
    text: redactRunText(raw.text || ""),
    path: raw.sense === "folder" ? path : "",
    untrusted: true,
    instruction: false,
  };
}

export function approvedFolderList(field: string | undefined): string[] {
  return String(field || "")
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The visible line. Off means she is not watching. */
export function watchingLine(switches: SenseSwitches): string {
  const on = SENSE_IDS.filter((id) => switches[id]);
  if (!on.length) return "FRIDAY is not watching.";
  return `FRIDAY is watching: ${on.join(", ")}.`;
}
