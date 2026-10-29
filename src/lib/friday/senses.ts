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
  "clipboard",
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
  clipboard: "senseClipboard",
};

export const SENSE_LABEL: Record<SenseId, string> = {
  foreground: "Foreground window",
  folder: "Approved folders",
  idle: "Idle",
  lock: "Lock and unlock",
  power: "Power",
  network: "Network",
  calendar: "Calendar",
  clipboard: "Clipboard",
};

/** Minimum gap between two kept events of the same sense. Tests inject a shorter gap. */
export const SENSE_MIN_GAP_MS: Record<SenseId, number> = {
  foreground: 15_000,
  folder: 5_000,
  idle: 60_000,
  lock: 5_000,
  power: 5_000,
  network: 30_000,
  calendar: 15 * 60_000,
  clipboard: 60_000,
};

export const SENSES_OFF: SenseSwitches = {
  foreground: false,
  folder: false,
  idle: false,
  lock: false,
  power: false,
  network: false,
  calendar: false,
  clipboard: false,
};

const PASSWORD_SOURCE =
  /1password|bitwarden|keepass|lastpass|dashlane|keeper|nordpass|enpass|roboform|credential manager/i;

export type SenseMemory = {
  seen: string[];
  lastAt: Partial<Record<SenseId, number>>;
  held: Partial<Record<SenseId, RawSense>>;
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

export function isSenseId(value: string): value is SenseId {
  return (SENSE_IDS as readonly string[]).includes(value);
}

export function senseHint(id: SenseId): string {
  if (id === "folder") return "Only folders you list below";
  if (id === "clipboard") return "Redacted. A password manager is never read";
  if (id === "calendar") return "Titles already on this PC. No network fetch";
  return "Off until you turn it on";
}

/** Every sense switch off. Other settings are left untouched. */
export function stopAllPatch(): Record<string, boolean> {
  const patch: Record<string, boolean> = {};
  for (const id of SENSE_IDS) patch[SENSE_TOGGLE[id]] = false;
  return patch;
}

export function emptySenseMemory(): SenseMemory {
  return { seen: [], lastAt: {}, held: {} };
}

/** Title only. Newlines are spaces. Keys and pixels are not accepted. */
export function foregroundRaw(input: { title?: string; at: number }): RawSense | null {
  const text = String(input.title || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  if (!text) return null;
  return { sense: "foreground", at: input.at, text };
}

/** Null when the front window is a password manager, so the secret is not kept. */
export function clipboardRaw(input: {
  text?: string;
  sourceApp?: string;
  at: number;
}): RawSense | null {
  if (PASSWORD_SOURCE.test(input.sourceApp || "")) return null;
  const text = String(input.text || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
  if (!text) return null;
  return { sense: "clipboard", at: input.at, text };
}

/** Lines already on this PC. A URL is dropped. Nothing is fetched. */
export function titlesFromCalendarBody(body: string | undefined): string[] {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => Boolean(line) && !/^https?:\/\//i.test(line))
    .slice(0, 5);
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

function gapFor(id: SenseId, override?: Partial<Record<SenseId, number>>): number {
  const custom = override?.[id];
  return typeof custom === "number" ? custom : SENSE_MIN_GAP_MS[id];
}

function eventKey(event: SenseEvent): string {
  return `${event.sense}|${event.text.trim().toLowerCase().slice(0, 80)}|${event.path}`;
}

/**
 * Admit, then drop a burst and a repeat. The latest event of a sense is held
 * and released once the gap has passed. The text stays data.
 */
export function ingestSenses(input: {
  switches: SenseSwitches;
  raw: RawSense[];
  now: number;
  memory: SenseMemory;
  minGapMs?: Partial<Record<SenseId, number>>;
}): { events: SenseEvent[]; memory: SenseMemory } {
  const memory: SenseMemory = {
    seen: [...input.memory.seen],
    lastAt: { ...input.memory.lastAt },
    held: { ...input.memory.held },
  };
  const batch = new Set(input.raw.map((item) => item.sense));
  const queue: RawSense[] = [];
  for (const id of SENSE_IDS) {
    if (batch.has(id)) continue;
    const held = memory.held[id];
    if (!held) continue;
    const previous = memory.lastAt[id];
    if (previous != null && input.now - previous < gapFor(id, input.minGapMs)) continue;
    delete memory.held[id];
    queue.push(held);
  }
  queue.push(...input.raw);
  const events: SenseEvent[] = [];
  for (const raw of queue) {
    const event = admitSense(input.switches, raw);
    if (!event) {
      delete memory.held[raw.sense];
      continue;
    }
    const previous = memory.lastAt[event.sense];
    if (previous != null && input.now - previous < gapFor(event.sense, input.minGapMs)) {
      memory.held[event.sense] = raw;
      continue;
    }
    delete memory.held[event.sense];
    const key = eventKey(event);
    if (memory.seen.includes(key)) continue;
    memory.seen.push(key);
    memory.lastAt[event.sense] = input.now;
    events.push(event);
  }
  return { events, memory };
}

/** The visible line. Off means she is not watching. */
export function watchingLine(switches: SenseSwitches): string {
  const on = SENSE_IDS.filter((id) => switches[id]);
  if (!on.length) return "FRIDAY is not watching.";
  return `FRIDAY is watching: ${on.join(", ")}.`;
}
