/**
 * FRIDAY · read-only Self Atlas observation
 *
 * "Where is your root, which EXE are you, what is running, what is wrong with this PC?" is answered
 * from the desktop's live probes, with the source and age of every fact. Nothing here probes by
 * itself, spawns anything or guesses: a fact that was not read is reported as not inspected.
 */

import {
  ATLAS_GROUP_ORDER,
  ATLAS_GROUP_TITLES,
  formatAtlas,
  formatReliability,
  refreshAtlas,
  refreshReliability,
} from "../self-atlas";

const ATLAS_LOOK =
  /\b(where (is|are) (your|friday'?s)\s+(root|folder|exe|app|install(ation)?|data|database|memory|logs?|backups?|config)|which (exe|version|build) (are you|is this)|are you (portable|installed)|portable or installed|installed or portable|what version are you|your (root|install(ation)?|exe|build|config|state|processes|ports?)\b|what(?:'s| is) running (in|inside|of) (you|friday)|what are you running|self[- ]?atlas|check yourself|inspect yourself|tumhara (root|folder|exe|version|state)|tum kahan (ho|rakhe)|apni (state|halat|location))\b/i;

const PC_HEALTH_LOOK =
  /\b(crash(es|ed)?|errors?|problems?|issues?|hangs?|faults?)\b.*\b(on )?(this|my) (pc|computer|laptop|machine|windows)\b|\b(pc|computer|windows|machine) (health|reliability|crashes|problems)\b|\b(restart|reboot) (is )?(pending|needed|required)\b|\bstartup (items|apps|programs|entries)\b|\bwhat (crashed|is wrong with (my|this) (pc|computer))\b|\bwindows error reporting\b|\breliability (history|monitor|report)\b/i;

export function atlasLookRequested(text: string): boolean {
  return ATLAS_LOOK.test(String(text || ""));
}

export function pcHealthLookRequested(text: string): boolean {
  return PC_HEALTH_LOOK.test(String(text || ""));
}

const TOPICS: [RegExp, string][] = [
  [/\b(root|folder|exe|app\b|install|portable|channel|where)\b/i, "location"],
  [/\b(version|build|epoch|electron|node)\b/i, "version"],
  [/\b(running|process|processes|port|ports|kernel|engine|engines)\b/i, "processes"],
  [/\b(config|setting|settings|yaml|auto[_ ]?approve)\b/i, "config"],
  [/\b(database|memory|data|sqlite)\b/i, "data"],
  [/\bbackups?\b/i, "backups"],
  [/\blogs?\b/i, "logs"],
  [/\b(tools?|models?|inventory|installed)\b/i, "inventory"],
];

/** Which parts of the atlas a question is about. A general question gets all of it. */
export function atlasTopics(text: string): string[] {
  const asked = String(text || "");
  const hit = TOPICS.filter(([pattern]) => pattern.test(asked)).map(([, group]) => group);
  const unique = ATLAS_GROUP_ORDER.filter((group) => hit.includes(group));
  return unique.length === ATLAS_GROUP_ORDER.length ? [] : unique;
}

const NEEDS_DESKTOP =
  "I can only inspect myself from the desktop app. The browser preview has no probes, so I have nothing to report and I will not guess.";

export async function describeSelfAtlas(text: string, now = Date.now()): Promise<string> {
  const snapshot = await refreshAtlas(now);
  if (!snapshot) return NEEDS_DESKTOP;
  return formatAtlas(snapshot, { groups: atlasTopics(text), now });
}

export async function describePcHealth(now = Date.now()): Promise<string> {
  const report = await refreshReliability(now);
  if (!report) return NEEDS_DESKTOP;
  return formatReliability(report, now);
}

export { ATLAS_GROUP_TITLES };
