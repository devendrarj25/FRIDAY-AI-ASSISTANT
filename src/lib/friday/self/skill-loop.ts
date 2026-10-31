/**
 * FRIDAY · learned skills: read -> act -> reflect -> write
 *
 * A learned skill is a procedure in the one memory store (see `learning-engine.ts`). This module adds
 * what that store did not have for them:
 *
 *   - a write gate: only a verified run or an owner correction can teach a skill. Text from a web
 *     page, a file, a tool, a transcript or a model is data, never a lesson, and a step that tries
 *     to give orders, run a download, touch a secret or switch a safety control off is refused;
 *   - credit: a skill that works gains utility, a skill that fails loses it, and one that keeps
 *     failing is quarantined and no longer retrieved;
 *   - versions: a revision is a new record that stays a candidate until it passes held-out cases,
 *     the older version is kept, and the owner (or a failing revision) can roll back to it;
 *   - tidying: near-duplicates are merged by superseding (nothing is deleted), and a skill that is
 *     old, unused and weak is archived, where it can be restored.
 *
 * Nothing here changes behaviour on its own. A skill only suggests steps for a goal; every step still
 * runs through the same approval and kill switch as any other work.
 */

import { memory, type MemoryItem } from "./memory-engine";
import { PROTECTED_POLICY_FILES } from "./governance";
import {
  encodeProcedure,
  parseProcedure,
  nextCurriculumTask,
  type ProcedureStep,
} from "./learning-engine";

export type SkillStatus = "active" | "candidate" | "quarantined" | "retired";

/** Where the lesson came from. Only the first two may teach. */
export type SkillOrigin =
  | "verified-run"
  | "owner-correction"
  | "web"
  | "file"
  | "tool-output"
  | "transcript"
  | "model-text";

const TEACHING_ORIGINS: ReadonlySet<SkillOrigin> = new Set(["verified-run", "owner-correction"]);

export type SkillMeta = {
  version: number;
  wins: number;
  losses: number;
  /** The memory id of the version this one revises, or "" for a first version. */
  parent: string;
  status: SkillStatus;
  origin: SkillOrigin;
  /** A candidate that is not validated by then is retired. 0 when not a candidate. */
  candidateUntil: number;
};

export type Skill = {
  id: string;
  goal: string;
  steps: ProcedureStep[];
  meta: SkillMeta;
  /** 0..1: confidence the skill works, moved by real outcomes. */
  utility: number;
  uses: number;
  lastUsedAt: number;
};

export const SKILL_TAG = "skill";
const PROCEDURE_TAG = "procedure";
const DAY = 86_400_000;
export const CANDIDATE_DAYS = 30;
export const STALE_DAYS = 90;
export const QUARANTINE_BELOW = 0.35;
export const QUARANTINE_AFTER_LOSSES = 3;
export const MIN_HELD_OUT = 2;
const WIN_CREDIT = 0.05;
const LOSS_PENALTY = 0.1;

/* ----------------------------------------------------------------- the gate */

const ORDERS = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|messages)/i,
  /disregard\s+.{0,30}(?:instructions|rules|policy)/i,
  /\b(?:system|developer)\s+prompt\b/i,
  /you\s+(?:must|should|will)\s+now\b/i,
  /reveal\s+.{0,30}(?:key|token|password|secret|credential)/i,
  /\b(?:send|post|upload|e-?mail|share|paste|type)\b.{0,40}\b(?:api[_ -]?keys?|passwords?|tokens?|credentials?|secrets?)\b/i,
  /curl[^|\n]{0,200}\|\s*(?:sh|bash|pwsh|powershell)\b/i,
  /Invoke-Expression\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)/i,
  /(?:download|fetch)\b.{0,40}\b(?:and|then)\s+(?:run|execute|launch)\b/i,
];

const SAFETY_OFF =
  /(?:disable|turn\s+off|bypass|remove|delete|skip|ignore)\b.{0,30}(?:kill\s*switch|audit\s*log|undo\s*journal|approval|approve|privacy\s*firewall|billing\s*firewall|stop\s+everything)/i;

const SECRET_WORD = /\b(?:api[_-]?key|password|passwd|secret|token)\b\s*[:=]\s*\S+/i;

const PROTECTED_NAMES = [
  ...PROTECTED_POLICY_FILES,
  "AGENTS.md",
  "friday-version.json",
  "scripts/identity.cjs",
  "auto_approve_exec",
];

export type Screen = { ok: true } | { ok: false; reason: string };

/** Whether this text may become a skill. A refusal names the reason. */
export function screenSkill(input: {
  goal: string;
  steps: ProcedureStep[];
  origin: SkillOrigin;
}): Screen {
  if (!TEACHING_ORIGINS.has(input.origin)) {
    return {
      ok: false,
      reason: `text from ${input.origin.replace("-", " ")} is data, not a lesson: only a verified run or the owner's correction can teach a skill`,
    };
  }
  const goal = input.goal.replace(/\s+/g, " ").trim();
  if (goal.length < 3 || goal.length > 200)
    return { ok: false, reason: "the goal must be 3 to 200 characters" };
  if (input.steps.length < 2 || input.steps.length > 12) {
    return { ok: false, reason: "a skill needs 2 to 12 steps" };
  }
  const text = [goal, ...input.steps.flatMap((step) => [step.title, step.instruction])].join("\n");
  if (input.steps.some((step) => step.instruction.length > 400 || step.title.length > 120)) {
    return { ok: false, reason: "a step is too long to be a step" };
  }
  if (ORDERS.some((pattern) => pattern.test(text))) {
    return {
      ok: false,
      reason: "a step reads as an order to the assistant or runs a download, which is not a skill",
    };
  }
  if (SAFETY_OFF.test(text))
    return { ok: false, reason: "a skill cannot switch a safety control off" };
  if (SECRET_WORD.test(text)) return { ok: false, reason: "a skill must not hold a secret" };
  const lower = text.toLowerCase();
  const touched = PROTECTED_NAMES.find((name) => lower.includes(name.toLowerCase()));
  if (touched)
    return { ok: false, reason: `a skill cannot touch the protected file or setting ${touched}` };
  return { ok: true };
}

/* ------------------------------------------------------------------ records */

const META_LINE = /^META:\s*(.+)$/m;

function encodeMeta(meta: SkillMeta): string {
  return `META: v=${meta.version}; wins=${meta.wins}; losses=${meta.losses}; parent=${meta.parent}; status=${meta.status}; origin=${meta.origin}; until=${meta.candidateUntil}`;
}

function parseMeta(text: string): SkillMeta | null {
  const line = META_LINE.exec(text)?.[1];
  if (!line) return null;
  const pairs = new Map(
    line.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key ?? "", rest.join("=")] as const;
    }),
  );
  const status = pairs.get("status") as SkillStatus | undefined;
  const origin = pairs.get("origin") as SkillOrigin | undefined;
  if (!status || !["active", "candidate", "quarantined", "retired"].includes(status)) return null;
  if (!origin) return null;
  return {
    version: Number(pairs.get("v")) || 1,
    wins: Number(pairs.get("wins")) || 0,
    losses: Number(pairs.get("losses")) || 0,
    parent: pairs.get("parent") ?? "",
    status,
    origin,
    candidateUntil: Number(pairs.get("until")) || 0,
  };
}

function encodeSkill(goal: string, steps: ProcedureStep[], meta: SkillMeta): string {
  const body = encodeProcedure(goal, steps);
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.startsWith("GOAL:"));
  lines.splice(at + 1, 0, encodeMeta(meta));
  return lines.join("\n");
}

function toSkill(item: MemoryItem): Skill | null {
  if (!item.tags.includes(SKILL_TAG)) return null;
  const procedure = parseProcedure(item.text);
  const meta = parseMeta(item.text);
  if (!procedure || !meta) return null;
  return {
    id: item.id,
    goal: procedure.goal,
    steps: procedure.steps,
    meta,
    utility: item.confidence,
    uses: item.uses,
    lastUsedAt: item.lastUsedAt,
  };
}

function allItems(): MemoryItem[] {
  return memory.getSnapshot().items;
}

/** Every learned skill, whatever its status, newest version first within a goal. */
export function allSkills(): Skill[] {
  return allItems()
    .map(toSkill)
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => b.meta.version - a.meta.version);
}

export function getSkill(id: string): Skill | null {
  const item = allItems().find((row) => row.id === id);
  return item ? toSkill(item) : null;
}

/** Skills that may be retrieved for work: active, not superseded, not archived. */
export function activeSkills(): Skill[] {
  const live = new Map(
    allItems()
      .filter((row) => !row.supersededAt && row.tier !== "archived")
      .map((row) => [row.id, row]),
  );
  return allSkills().filter((skill) => skill.meta.status === "active" && live.has(skill.id));
}

const words = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
};

function patch(
  id: string,
  update: {
    text?: string;
    tags?: string[];
    confidence?: number;
    tier?: MemoryItem["tier"];
    /** `undefined` clears it: the record is current again. */
    supersededAt?: number | undefined;
  },
): void {
  memory.update(id, update as Parameters<typeof memory.update>[1]);
}

function setMeta(skill: Skill, change: Partial<SkillMeta>, utility?: number): void {
  const meta = { ...skill.meta, ...change };
  const tags = [PROCEDURE_TAG, SKILL_TAG, `status:${meta.status}`];
  patch(skill.id, {
    text: encodeSkill(skill.goal, skill.steps, meta),
    tags,
    ...(utility === undefined ? {} : { confidence: Math.max(0.02, Math.min(0.98, utility)) }),
  });
}

/* --------------------------------------------------------------------- write */

export type WriteResult = {
  written: boolean;
  id: string | null;
  status: SkillStatus | null;
  reason: string;
};

/**
 * Teach a skill. A first version from a verified run is active; a revision of an existing skill is a
 * candidate until it passes held-out cases. A skill from an owner correction is active at once.
 */
export function writeSkill(
  input: {
    goal: string;
    steps: ProcedureStep[];
    origin: SkillOrigin;
    /** The run behind it passed a checked postcondition. Required for a verified run. */
    verified: boolean;
    /** The skill this revises. */
    parentId?: string;
    source?: string;
    /** Wait for held-out cases even though the owner supplied it (a file from outside). */
    asCandidate?: boolean;
  },
  now = Date.now(),
): WriteResult {
  const screen = screenSkill(input);
  if (!screen.ok) return { written: false, id: null, status: null, reason: screen.reason };
  if (input.origin === "verified-run" && !input.verified) {
    return { written: false, id: null, status: null, reason: "an unverified run is not learned" };
  }
  const goal = input.goal.replace(/\s+/g, " ").trim();
  const parent = input.parentId ? getSkill(input.parentId) : null;
  if (input.parentId && !parent) {
    return { written: false, id: null, status: null, reason: "the skill to revise was not found" };
  }
  const revision = Boolean(parent);
  const status: SkillStatus =
    input.asCandidate || (revision && input.origin !== "owner-correction") ? "candidate" : "active";
  const meta: SkillMeta = {
    version: parent ? parent.meta.version + 1 : 1,
    wins: 0,
    losses: 0,
    parent: parent?.id ?? "",
    status,
    origin: input.origin,
    candidateUntil: status === "candidate" ? now + CANDIDATE_DAYS * DAY : 0,
  };
  const item = memory.remember({
    tier: "semantic",
    title: `Skill — ${goal} (v${meta.version})`.slice(0, 100),
    text: encodeSkill(goal, input.steps, meta),
    tags: [PROCEDURE_TAG, SKILL_TAG, `status:${status}`],
    source: input.source ?? `skill/${input.origin}`,
    confidence:
      input.origin === "owner-correction" ? 0.9 : revision ? (parent?.utility ?? 0.6) * 0.9 : 0.6,
    kind: "procedural",
    verified: input.origin === "owner-correction" || input.verified,
    distinct: true,
  });
  if (item.id === "withheld")
    return {
      written: false,
      id: null,
      status: null,
      reason: "the memory store refused the record",
    };
  if (parent && status === "active") supersedeParent(parent.id, item.id);
  return {
    written: true,
    id: item.id,
    status,
    reason: revision
      ? status === "candidate"
        ? "a revision waits for held-out cases"
        : "the owner's correction replaced the older version"
      : "learned",
  };
}

function supersedeParent(parentId: string, childId: string): void {
  const parent = getSkill(parentId);
  memory.supersede(parentId, childId);
  if (parent) setMeta(parent, { status: "retired" });
}

/* ---------------------------------------------------------------------- read */

/** The best active skill for this goal, or null. Unrelated goals never get invented steps. */
export function findSkill(goal: string): Skill | null {
  const want = words(goal);
  if (want.size < 2) return null;
  let best: { score: number; skill: Skill } | null = null;
  for (const skill of activeSkills()) {
    const overlap = jaccard(want, words(skill.goal));
    if (overlap < 0.34) continue;
    const score = overlap * (0.5 + skill.utility);
    if (!best || score > best.score) best = { score, skill };
  }
  return best?.skill ?? null;
}

/* ------------------------------------------------------------------- reflect */

export type Reflection = {
  utility: number;
  status: SkillStatus;
  quarantined: boolean;
  note: string;
};

/**
 * After a skill was used: a verified success gains credit, a verified failure loses it, an unverified
 * result changes nothing. A skill that keeps failing is quarantined and is no longer retrieved.
 */
export function reflectOnUse(input: {
  skillId: string;
  success: boolean;
  verified: boolean;
}): Reflection | null {
  const skill = getSkill(input.skillId);
  if (!skill) return null;
  if (!input.verified) {
    return {
      utility: skill.utility,
      status: skill.meta.status,
      quarantined: false,
      note: "unverified result: no credit either way",
    };
  }
  const wins = skill.meta.wins + (input.success ? 1 : 0);
  const losses = skill.meta.losses + (input.success ? 0 : 1);
  const utility = Math.max(
    0.02,
    Math.min(0.98, skill.utility + (input.success ? WIN_CREDIT : -LOSS_PENALTY)),
  );
  const quarantine =
    !input.success && utility < QUARANTINE_BELOW && losses >= QUARANTINE_AFTER_LOSSES;
  setMeta(
    skill,
    { wins, losses, ...(quarantine ? { status: "quarantined" as const } : {}) },
    utility,
  );
  return {
    utility,
    status: quarantine ? "quarantined" : skill.meta.status,
    quarantined: quarantine,
    note: quarantine
      ? `utility ${utility.toFixed(2)} after ${losses} failures: quarantined, no longer retrieved`
      : input.success
        ? `credit +${WIN_CREDIT}`
        : `penalty -${LOSS_PENALTY}`,
  };
}

/* ----------------------------------------------------------- validate / undo */

export type HeldOutCase = { goal: string; passed: boolean };

export type Promotion = { promoted: boolean; passRate: number; reason: string };

/**
 * A candidate becomes active only if it passes held-out cases at least as well as the version it
 * revises. The cases come from outside the run that produced the candidate.
 */
export function promoteCandidate(
  candidateId: string,
  heldOut: HeldOutCase[],
  parentRate = 0,
  now = Date.now(),
): Promotion {
  const candidate = getSkill(candidateId);
  if (!candidate || candidate.meta.status !== "candidate") {
    return { promoted: false, passRate: 0, reason: "this is not a candidate" };
  }
  if (candidate.meta.candidateUntil && now > candidate.meta.candidateUntil) {
    setMeta(candidate, { status: "retired" });
    return {
      promoted: false,
      passRate: 0,
      reason: "the candidate was not validated in time and is retired",
    };
  }
  const own = new Set(words(candidate.goal));
  const cases = heldOut.filter((row) => jaccard(own, words(row.goal)) < 1);
  if (cases.length < MIN_HELD_OUT) {
    return {
      promoted: false,
      passRate: 0,
      reason: `at least ${MIN_HELD_OUT} held-out cases are needed`,
    };
  }
  const passRate = cases.filter((row) => row.passed).length / cases.length;
  if (passRate < Math.max(0.8, parentRate)) {
    return {
      promoted: false,
      passRate,
      reason: `passed ${Math.round(passRate * 100)}% of held-out cases, below the bar of ${Math.round(Math.max(0.8, parentRate) * 100)}%`,
    };
  }
  setMeta(candidate, { status: "active", candidateUntil: 0 });
  if (candidate.meta.parent) supersedeParent(candidate.meta.parent, candidate.id);
  return {
    promoted: true,
    passRate,
    reason: "passed held-out cases; the older version is kept and can be restored",
  };
}

/** Put the older version back and quarantine the revision. Nothing is deleted. */
export function rollbackSkill(skillId: string): { restored: string | null; reason: string } {
  const current = getSkill(skillId);
  if (!current) return { restored: null, reason: "skill not found" };
  const parent = current.meta.parent ? getSkill(current.meta.parent) : null;
  if (!parent)
    return {
      restored: null,
      reason: "this is the first version: there is nothing older to restore",
    };
  patch(parent.id, { supersededAt: undefined, tier: "semantic" });
  setMeta(parent, { status: "active" });
  setMeta(current, { status: "quarantined" });
  return {
    restored: parent.id,
    reason: `version ${parent.meta.version} is active again; version ${current.meta.version} is quarantined`,
  };
}

/* ----------------------------------------------------------------- tidy up */

/** Merge near-duplicate active skills: the better one stays, the other is superseded (kept, not deleted). */
export function consolidateSkills(): { merged: number } {
  const live = activeSkills();
  const gone = new Set<string>();
  let merged = 0;
  for (let i = 0; i < live.length; i += 1) {
    const a = live[i];
    if (!a || gone.has(a.id)) continue;
    for (let j = i + 1; j < live.length; j += 1) {
      const b = live[j];
      if (!b || gone.has(b.id)) continue;
      const same = jaccard(
        words(`${a.goal} ${a.steps.map((s) => s.instruction).join(" ")}`),
        words(`${b.goal} ${b.steps.map((s) => s.instruction).join(" ")}`),
      );
      if (same < 0.8) continue;
      const [keep, drop] = a.utility >= b.utility ? [a, b] : [b, a];
      memory.supersede(drop.id, keep.id);
      setMeta(drop, { status: "retired" });
      gone.add(drop.id);
      merged += 1;
      if (drop.id === a.id) break;
    }
  }
  return { merged };
}

/** Archive a skill that is old, unused and weak, and retire a candidate nobody validated. */
export function pruneSkills(now = Date.now()): { archived: number; expired: number } {
  let archived = 0;
  let expired = 0;
  for (const skill of allSkills()) {
    if (
      skill.meta.status === "candidate" &&
      skill.meta.candidateUntil &&
      now > skill.meta.candidateUntil
    ) {
      setMeta(skill, { status: "retired" });
      patch(skill.id, { tier: "archived" });
      expired += 1;
      continue;
    }
    const idle = now - skill.lastUsedAt > STALE_DAYS * DAY;
    if (skill.meta.status === "active" && idle && skill.utility < 0.5) {
      setMeta(skill, { status: "retired" });
      patch(skill.id, { tier: "archived" });
      archived += 1;
    }
  }
  return { archived, expired };
}

/* ------------------------------------------------------------- study planning */

export type StudyFinding = { id: string; title: string };
export type StudyTask = { id: string; title: string; band: string; task: string };

/**
 * Which study tasks may start now. They run only in idle time, never while the kill switch is on or
 * the assistant is busy, never more often than the owner's idle cycle, and only at a dial level that
 * allows work without asking. At "ask" they are offered, not run.
 */
export function planStudy(input: {
  findings: StudyFinding[];
  level: "ask" | "balanced" | "full";
  busy: boolean;
  killSwitch: boolean;
  idleCycleMinutes: number;
  lastRunAt: number;
  now: number;
  successes?: Record<string, number>;
}): { run: StudyTask[]; propose: StudyTask[]; reason: string } {
  const none = (reason: string) => ({ run: [], propose: [], reason });
  if (input.killSwitch) return none("the kill switch is on");
  if (input.busy) return none("the assistant is busy; study waits for idle time");
  const gap = Math.max(5, input.idleCycleMinutes) * 60_000;
  if (input.now - input.lastRunAt < gap) return none("the idle cycle has not come round yet");
  const tasks: StudyTask[] = [];
  for (const finding of input.findings.slice(0, 3)) {
    const next = nextCurriculumTask({
      weakness: finding.title,
      successes: input.successes?.[finding.id] ?? 0,
    });
    if (next.run)
      tasks.push({ id: finding.id, title: finding.title, band: next.band, task: next.task });
  }
  if (!tasks.length) return none("no finding has reachable practice");
  if (input.level === "ask")
    return { run: [], propose: tasks, reason: "ask every time: offered, not started" };
  return { run: tasks, propose: [], reason: `${input.level}: study starts in idle time` };
}
