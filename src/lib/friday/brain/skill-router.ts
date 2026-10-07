/**
 * FRIDAY · skill router
 *
 * Installed skills are not decoration: when a turn matches one or more, FRIDAY
 * runs them for real and answers from their actual output. Matching is
 * deliberately conservative — a skill only fires when the prompt names it or
 * names enough of its own words that the intent is unambiguous — so ordinary
 * conversation never triggers a sandboxed run.
 *
 * A keyword index picks candidates first so a large catalog is not scored on
 * every turn. Several skills may run in sequence when the owner names more
 * than one, or when the prompt clearly chains them. Only `safe` + enabled
 * skills run automatically. Write/exec stays behind the owner's explicit
 * request in the Self Core panel.
 */

import { invokeSkill, listSkills, type SkillManifest } from "./skill-forge";
import { turnDone, turnMark } from "./turn-timing";

export type SkillRun = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  value: unknown;
};

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "to",
  "of",
  "in",
  "on",
  "my",
  "me",
  "you",
  "friday",
  "please",
  "skill",
  "run",
  "use",
  "get",
  "make",
  "do",
  "that",
  "this",
  "it",
  "is",
  "are",
]);

const SEQUENCE = /\b(then|after that|and then|also|plus|followed by|next)\b/i;
const MAX_SEQUENCE = 3;

/** Meaningful, lowercase words of a phrase. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

type SkillIndex = {
  signature: string;
  byToken: Map<string, number[]>;
  skills: SkillManifest[];
};

let cachedIndex: SkillIndex | null = null;
let lastScored = 0;

function signatureOf(skills: SkillManifest[]): string {
  return skills.map((skill) => `${skill.id}:${skill.enabled ? 1 : 0}:${skill.risk}`).join("|");
}

function buildIndex(skills: SkillManifest[]): SkillIndex {
  const byToken = new Map<string, number[]>();
  skills.forEach((skill, index) => {
    const tokens = words(`${skill.id} ${skill.name} ${skill.summary} ${skill.category}`);
    for (const token of tokens) {
      const list = byToken.get(token);
      if (list) {
        if (list[list.length - 1] !== index) list.push(index);
      } else {
        byToken.set(token, [index]);
      }
    }
  });
  return { signature: signatureOf(skills), byToken, skills };
}

export function resetSkillIndex(): void {
  cachedIndex = null;
  lastScored = 0;
}

export function lastScoredCount(): number {
  return lastScored;
}

export function skillIndex(skills: SkillManifest[]): SkillIndex {
  const signature = signatureOf(skills);
  if (cachedIndex && cachedIndex.signature === signature) return cachedIndex;
  cachedIndex = buildIndex(skills);
  return cachedIndex;
}

/**
 * Candidate set from the inverted index. Empty means nothing in the prompt
 * overlaps a skill token — do not fall back to scoring the whole catalog.
 */
export function candidateSkills(prompt: string, skills: SkillManifest[]): SkillManifest[] {
  const index = skillIndex(skills);
  const hits = new Set<number>();
  for (const token of words(prompt)) {
    const list = index.byToken.get(token);
    if (!list) continue;
    for (const i of list) hits.add(i);
  }
  return [...hits].map((i) => index.skills[i]!);
}

/**
 * Score one skill against the prompt. A direct name match wins outright;
 * otherwise the skill needs at least two of its distinctive words present.
 */
export function scoreSkill(prompt: string, skill: SkillManifest): number {
  const text = prompt.toLowerCase();
  const name = skill.name.toLowerCase().trim();
  if (name.length >= 4 && text.includes(name)) return 1;
  if (text.includes(skill.id.toLowerCase())) return 1;

  const hay = new Set(words(text));
  const needles = words(`${skill.name} ${skill.summary}`);
  if (!needles.length) return 0;
  const hits = needles.filter((word) => hay.has(word)).length;
  if (hits < 2) return 0;
  return Math.min(0.9, hits / needles.length + 0.2);
}

function scoredMatches(
  prompt: string,
  skills: SkillManifest[],
): { skill: SkillManifest; score: number }[] {
  const candidates = candidateSkills(prompt, skills);
  lastScored = candidates.length;
  const scored: { skill: SkillManifest; score: number }[] = [];
  for (const skill of candidates) {
    if (!skill.enabled || skill.risk !== "safe") continue;
    const score = scoreSkill(prompt, skill);
    if (score < 0.6) continue;
    scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Pick the single best automatic skill for a prompt, or nothing. */
export function chooseSkill(prompt: string, skills: SkillManifest[]): SkillManifest | null {
  return chooseSkills(prompt, skills, { limit: 1 })[0] ?? null;
}

/**
 * One or several matching skills, in score order. Named skills (score 1) all
 * run up to `limit`. A chained prompt ("then" / "also") runs complementary
 * matches. Ordinary chat still returns [].
 */
export function chooseSkills(
  prompt: string,
  skills: SkillManifest[],
  options: { limit?: number } = {},
): SkillManifest[] {
  const limit = Math.max(1, options.limit ?? MAX_SEQUENCE);
  const scored = scoredMatches(prompt, skills);
  if (!scored.length) return [];
  const named = scored.filter((item) => item.score === 1);
  if (named.length >= 2) return named.slice(0, limit).map((item) => item.skill);
  if (SEQUENCE.test(prompt)) {
    const picked: SkillManifest[] = [];
    const used = new Set<string>();
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (used.has(item.skill.id)) continue;
      picked.push(item.skill);
      used.add(item.skill.id);
    }
    return picked;
  }
  return [scored[0]!.skill];
}

/** Truncated, model-readable rendering of whatever the skill returned. */
export function describeSkillValue(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

async function invokeOne(
  skill: SkillManifest,
  prompt: string,
  previous: SkillRun[],
): Promise<SkillRun> {
  turnMark("skill", "invoke");
  try {
    const result = await invokeSkill(skill.id, {
      prompt,
      previous: previous.map((run) => ({ id: run.id, ok: run.ok, value: run.value })),
    });
    const ok = Boolean(result?.ok);
    turnDone("skill", "invoke", ok ? "ok" : "failed");
    return {
      id: skill.id,
      name: skill.name,
      ok,
      detail: ok ? `ran in ${result?.ms ?? 0}ms` : String(result?.error ?? "skill failed"),
      value: ok ? (result as { value?: unknown }).value : null,
    };
  } catch (error) {
    turnDone("skill", "invoke", "threw");
    return {
      id: skill.id,
      name: skill.name,
      ok: false,
      detail: String((error as Error)?.message ?? error),
      value: null,
    };
  }
}

/** Run every matching skill in sequence. Empty when nothing matched. */
export async function routeSkills(prompt: string): Promise<SkillRun[]> {
  turnMark("skill", "list");
  let skills: SkillManifest[];
  try {
    skills = await listSkills();
  } catch {
    turnDone("skill", "list", "failed");
    return [];
  }
  turnDone("skill", "list", `${skills.length} skill(s)`);
  const chosen = chooseSkills(prompt, skills, { limit: MAX_SEQUENCE });
  if (!chosen.length) return [];
  const runs: SkillRun[] = [];
  for (const skill of chosen) {
    runs.push(await invokeOne(skill, prompt, runs));
  }
  return runs;
}

/**
 * Run the matching skill, if any. Returns null when nothing matched so the
 * turn continues exactly as it did before skills existed.
 */
export async function routeSkill(prompt: string): Promise<SkillRun | null> {
  const runs = await routeSkills(prompt);
  return runs[0] ?? null;
}
