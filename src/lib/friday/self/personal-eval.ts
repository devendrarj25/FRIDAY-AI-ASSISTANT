/**
 * FRIDAY · the owner's own tasks as an eval
 *
 * The fixed bank is written by someone else, so it cannot say where FRIDAY fails on the owner's real work.
 * This takes 20 to 30 of his real requests, each with a plain expectation (words the answer must or must not
 * contain, a pattern, "must be verified"), runs them through the same verified path as chat, and scores them
 * with rules only: no model grades a model. Results are kept so two runs can be compared task by task with the
 * same statistics as the bank. Nothing leaves this PC unless the task itself uses a cloud model he allowed.
 *
 * Task file, JSON: [{ "id": "mail-1", "prompt": "...", "must": ["..."], "mustNot": ["..."],
 *   "pattern": "regex", "verified": true, "tags": ["mail"] }]
 * Task file, lines: prompt || must: a, b || not: c || re: ^pattern$ || verified || tag: mail
 */

import { readLocalState, writeState } from "../persist";
import type { VerifiedResult } from "../brain/verified-run";
import { comparePaired, wilson } from "./eval-stats";

export type PersonalTask = {
  id: string;
  prompt: string;
  must: string[];
  mustNot: string[];
  pattern?: string;
  verified: boolean;
  tags: string[];
};

export type ParsedTasks = { tasks: PersonalTask[]; problems: string[] };

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];

function checkPattern(
  pattern: string | undefined,
  where: string,
  problems: string[],
): string | undefined {
  if (!pattern) return undefined;
  try {
    new RegExp(pattern, "i");
    return pattern;
  } catch {
    problems.push(`${where}: the pattern "${pattern}" is not a valid regular expression`);
    return undefined;
  }
}

export function parsePersonalTasks(text: string): ParsedTasks {
  const problems: string[] = [];
  const tasks: PersonalTask[] = [];
  const raw = String(text || "").trim();
  if (!raw) return { tasks, problems: ["there is nothing to read"] };
  const add = (task: PersonalTask) => {
    if (!task.prompt) return void problems.push(`${task.id}: the request is empty`);
    if (!task.must.length && !task.mustNot.length && !task.pattern && !task.verified) {
      return void problems.push(`${task.id}: it says nothing to check, so it could never fail`);
    }
    if (tasks.some((other) => other.id === task.id)) task.id = `${task.id}-${tasks.length + 1}`;
    tasks.push(task);
  };
  if (raw.startsWith("[")) {
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      return { tasks, problems: ["the JSON could not be read"] };
    }
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const item = (row ?? {}) as Record<string, unknown>;
      const id = String(item["id"] || `task-${index + 1}`);
      const pattern = checkPattern(
        item["pattern"] ? String(item["pattern"]) : undefined,
        id,
        problems,
      );
      add({
        id,
        prompt: String(item["prompt"] || "").trim(),
        must: list(item["must"]),
        mustNot: list(item["mustNot"]),
        ...(pattern ? { pattern } : {}),
        verified: item["verified"] === true,
        tags: list(item["tags"]),
      });
    });
    return { tasks, problems };
  }
  raw.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const [prompt = "", ...parts] = text.split("||").map((part) => part.trim());
    const id = `task-${index + 1}`;
    const task: PersonalTask = { id, prompt, must: [], mustNot: [], verified: false, tags: [] };
    for (const part of parts) {
      const [key = "", ...rest] = part.split(":");
      const value = rest.join(":").trim();
      const words = value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean);
      const name = key.trim().toLowerCase();
      if (name === "must") task.must.push(...words);
      else if (name === "not") task.mustNot.push(...words);
      else if (name === "re") {
        const pattern = checkPattern(value, id, problems);
        if (pattern) task.pattern = pattern;
      } else if (name === "tag") task.tags.push(...words);
      else if (name === "verified") task.verified = true;
      else problems.push(`${id}: "${part}" is not a known part (must, not, re, tag, verified)`);
    }
    add(task);
  });
  return { tasks, problems };
}

export type Judgement = { passed: boolean; why: string[] };

/** Rules only. The answer is lower-cased once; words are plain substrings so a Hindi or Hinglish word works. */
export function scoreAnswer(
  task: PersonalTask,
  result: Pick<VerifiedResult, "answer" | "verified">,
): Judgement {
  const why: string[] = [];
  const answer = String(result.answer || "");
  const low = answer.toLowerCase();
  if (!answer.trim()) why.push("no answer came back");
  for (const word of task.must)
    if (!low.includes(word.toLowerCase())) why.push(`missing "${word}"`);
  for (const word of task.mustNot)
    if (low.includes(word.toLowerCase())) why.push(`contains "${word}"`);
  if (task.pattern && !new RegExp(task.pattern, "i").test(answer))
    why.push(`does not match ${task.pattern}`);
  if (task.verified && !result.verified) why.push("the answer was not verified");
  return { passed: why.length === 0, why };
}

export type TaskOutcome = {
  id: string;
  tags: string[];
  runs: boolean[];
  why: string[];
  ms: number;
};

export type PersonalRun = {
  at: number;
  repeats: number;
  outcomes: TaskOutcome[];
  /** pass@1: the first attempt of each task. */
  passed: number;
  total: number;
  /** pass@k: any attempt passed. */
  passedAny: number;
  interval: { low: number; high: number };
  byTag: Record<string, { passed: number; total: number }>;
};

export type Ask = (prompt: string) => Promise<Pick<VerifiedResult, "answer" | "verified">>;

export async function runPersonalEval(
  tasks: readonly PersonalTask[],
  ask: Ask,
  options: {
    repeats?: number;
    now?: () => number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PersonalRun> {
  const now = options.now ?? Date.now;
  const repeats = Math.max(1, Math.min(5, Math.floor(options.repeats ?? 1)));
  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    const runs: boolean[] = [];
    const why: string[] = [];
    const started = now();
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      try {
        const judged = scoreAnswer(task, await ask(task.prompt));
        runs.push(judged.passed);
        if (!judged.passed && !why.length) why.push(...judged.why);
      } catch (error) {
        runs.push(false);
        if (!why.length)
          why.push(
            `the run failed: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              160,
            ),
          );
      }
    }
    outcomes.push({ id: task.id, tags: task.tags, runs, why, ms: Math.max(0, now() - started) });
    options.onProgress?.(outcomes.length, tasks.length);
  }
  const passed = outcomes.filter((row) => row.runs[0]).length;
  const byTag: PersonalRun["byTag"] = {};
  for (const row of outcomes) {
    for (const tag of row.tags) {
      const entry = (byTag[tag] ??= { passed: 0, total: 0 });
      entry.total += 1;
      if (row.runs[0]) entry.passed += 1;
    }
  }
  return {
    at: now(),
    repeats,
    outcomes,
    passed,
    total: outcomes.length,
    passedAny: outcomes.filter((row) => row.runs.some(Boolean)).length,
    interval: wilson(passed, outcomes.length),
    byTag,
  };
}

/** Task by task, on the tasks both runs had. Positive delta favours the newer run. */
export function comparePersonalRuns(older: PersonalRun, newer: PersonalRun) {
  const ids = older.outcomes
    .map((row) => row.id)
    .filter((id) => newer.outcomes.some((row) => row.id === id));
  const pick = (run: PersonalRun) =>
    ids.map((id) => Boolean(run.outcomes.find((row) => row.id === id)?.runs[0]));
  const paired = comparePaired(pick(older), pick(newer));
  return {
    ...paired,
    fixed: ids.filter((id, i) => !pick(older)[i] && pick(newer)[i]),
    broke: ids.filter((id, i) => pick(older)[i] && !pick(newer)[i]),
  };
}

export function describePersonalRun(run: PersonalRun): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const head = `${run.passed}/${run.total} passed the first time [${pct(run.interval.low)}–${pct(run.interval.high)} at 95%]${
    run.repeats > 1 ? `, ${run.passedAny}/${run.total} in at least one of ${run.repeats} tries` : ""
  }.`;
  const failed = run.outcomes.filter((row) => !row.runs[0]).slice(0, 6);
  const lines = failed.map((row) => `  ${row.id}: ${row.why[0] ?? "failed"}`);
  const tags = Object.entries(run.byTag).map(([tag, row]) => `${tag} ${row.passed}/${row.total}`);
  return [
    head,
    tags.length ? `By kind: ${tags.join(", ")}.` : "",
    ...(lines.length ? ["Missed:", ...lines] : []),
  ]
    .filter(Boolean)
    .join("\n");
}

const KEY = "friday.personal-eval.v1";
let history: PersonalRun[] | null = null;

export function personalHistory(): PersonalRun[] {
  if (!history) {
    const stored = readLocalState<PersonalRun[]>(KEY);
    history = Array.isArray(stored) ? stored.slice(-12) : [];
  }
  return history;
}

export function recordPersonalRun(run: PersonalRun): void {
  history = [...personalHistory(), run].slice(-12);
  writeState(KEY, history);
}

export function resetPersonalHistoryForTests(): void {
  history = [];
  writeState(KEY, []);
}
