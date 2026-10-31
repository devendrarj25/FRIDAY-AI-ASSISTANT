/**
 * FRIDAY · more fixed suites for the Brain
 *
 * The offline harness (`eval-harness.ts`) measures diagnosis, self-knowledge, safe change, refusal and
 * injection; the instruction loop (`instruction-eval.ts`) measures rule-keeping on the owner's own model.
 * These add the three measures a Brain also owes the owner: does retrieval find the right fact (and the
 * newest one for a question about now), does the route and thinking effort fit the kind of ask, and does
 * a long task finish without repeating a step. All are offline and date-free: a fixed corpus, a fixed
 * clock and scripted runners. Every suite has a stated pass rule and every report carries its tasks.
 * Results are kept (last twelve per suite) so a trend can be shown.
 */

import { classifyCognitiveRoute, reasoningEffortFor } from "../brain/cognitive-route";
import { rankByRetrieval, type RankSignals } from "../brain/retrieval";
import { readLocalState, writeState } from "../persist";
import { DEFAULT_AUTONOMY } from "./autonomy";
import { wilson } from "./eval-stats";
import { evaluateChange, PROTECTED_POLICY_FILES } from "./governance";
import { TaskGraphEngine } from "./task-graph";

export type SuiteReport = {
  suite: "retrieval" | "routing" | "long-horizon" | "reliability" | "gates";
  tasks: number;
  passed: number;
  /** One line per task that failed, so the miss can be read. */
  misses: string[];
  /** Extra measures that are not a pass rate (for example recall at 3). */
  extra: Record<string, number>;
};

const rate = (report: SuiteReport) => (report.tasks ? report.passed / report.tasks : 0);
export const suiteRate = rate;

/* ------------------------------------------------------------------- retrieval */

const NOW = Date.UTC(2026, 9, 30);
const DAY = 86_400_000;

type Row = RankSignals & { key: string };
const row = (
  key: string,
  title: string,
  text: string,
  ageDays: number,
  extra: Partial<Row> = {},
): Row => ({
  key,
  title,
  text,
  confidence: 0.8,
  source: "user",
  provenance: "user",
  verified: true,
  updatedAt: NOW - ageDays * DAY,
  freshnessAt: NOW - ageDays * DAY,
  ...extra,
});

const CORPUS: Row[] = [
  row("city-new", "owner city", "the owner lives in Pune since this year", 20),
  row("city-old", "owner city", "the owner lived in Jaipur before the move", 600),
  row("phone-new", "owner phone", "the owner uses a Pixel 9 phone", 30),
  row("phone-old", "owner phone", "the owner used an old Moto G phone first", 900),
  row("editor", "editor preference", "the owner prefers VS Code with dark theme for coding", 90),
  row(
    "lang",
    "language preference",
    "the owner writes in Hinglish and wants short Hindi plus English replies",
    60,
  ),
  row("backup", "backup habit", "the owner backs up the D drive every Sunday night", 120),
  row(
    "project",
    "tender project",
    "the tender project deadline is the 15th and needs the eligibility sheet",
    15,
  ),
  row("gpu", "hardware", "the PC has an RTX 3060 GPU with 12 GB VRAM and 32 GB RAM", 200),
  row("bank", "bank csv", "the bank export is a CSV with Date, Amount and Narration columns", 45),
  row("wake", "wake word", "the wake word is Friday and hands free stays off by default", 70),
  row("music", "music taste", "the owner likes old Hindi songs while working late at night", 300),
];

const RETRIEVAL_TASKS: { id: string; query: string; expect: string; pastQuestion?: boolean }[] = [
  { id: "city-now", query: "where does the owner live now", expect: "city-new" },
  {
    id: "city-before",
    query: "where did the owner live originally",
    expect: "city-old",
    pastQuestion: true,
  },
  { id: "phone-now", query: "which phone does the owner use right now", expect: "phone-new" },
  {
    id: "phone-earlier",
    query: "what phone did the owner use earlier",
    expect: "phone-old",
    pastQuestion: true,
  },
  { id: "editor", query: "which editor does the owner prefer for coding", expect: "editor" },
  { id: "language", query: "in what language should replies be written", expect: "lang" },
  { id: "backup", query: "when does the owner back up the D drive", expect: "backup" },
  { id: "deadline", query: "what is the tender deadline", expect: "project" },
  { id: "gpu", query: "how much VRAM does the GPU have", expect: "gpu" },
  { id: "bank", query: "what columns does the bank csv export have", expect: "bank" },
  { id: "wake", query: "what is the wake word", expect: "wake" },
  { id: "hinglish-city", query: "owner abhi kahan rehta hai", expect: "city-new" },
];

export function runRetrievalSuite(): SuiteReport {
  let first = 0;
  let top3 = 0;
  const misses: string[] = [];
  for (const task of RETRIEVAL_TASKS) {
    const hits = rankByRetrieval(CORPUS, task.query, (item) => item, {
      k: 3,
      now: NOW,
      minScore: 0.05,
    });
    const keys = hits.map((hit) => hit.item.key);
    if (keys[0] === task.expect) first += 1;
    else misses.push(`${task.id}: wanted ${task.expect}, got ${keys[0] ?? "nothing"}`);
    if (keys.includes(task.expect)) top3 += 1;
  }
  return {
    suite: "retrieval",
    tasks: RETRIEVAL_TASKS.length,
    passed: first,
    misses,
    extra: { recallAt3: top3 / RETRIEVAL_TASKS.length },
  };
}

/* --------------------------------------------------------------------- routing */

const ROUTING_TASKS: {
  id: string;
  prompt: string;
  kind: string;
  action: string;
  effort: string;
}[] = [
  { id: "hello", prompt: "hello", kind: "chat", action: "fast-path", effort: "low" },
  { id: "thanks", prompt: "thanks", kind: "chat", action: "fast-path", effort: "low" },
  {
    id: "news",
    prompt: "what is the latest news on the budget today",
    kind: "chat",
    action: "research",
    effort: "medium",
  },
  {
    id: "price",
    prompt: "current price of a 1 TB SSD right now",
    kind: "chat",
    action: "research",
    effort: "medium",
  },
  {
    id: "delete",
    prompt: "delete all the old backup folders from the D drive",
    kind: "task",
    action: "multi-verify",
    effort: "high",
  },
  {
    id: "install",
    prompt: "install this package and overwrite the config file",
    kind: "task",
    action: "multi-verify",
    effort: "high",
  },
  {
    id: "code",
    prompt: "refactor this function to handle empty input",
    kind: "code",
    action: "deep-reasoning",
    effort: "high",
  },
  {
    id: "why",
    prompt: "why does the build fail only on Windows",
    kind: "reasoning",
    action: "deep-reasoning",
    effort: "high",
  },
];

export function runRoutingSuite(): SuiteReport {
  let passed = 0;
  const misses: string[] = [];
  for (const task of ROUTING_TASKS) {
    const route = classifyCognitiveRoute({ prompt: task.prompt, kind: task.kind });
    const effort = reasoningEffortFor(route.action);
    if (route.action === task.action && effort === task.effort) passed += 1;
    else
      misses.push(
        `${task.id}: wanted ${task.action}/${task.effort}, got ${route.action}/${effort}`,
      );
  }
  return { suite: "routing", tasks: ROUTING_TASKS.length, passed, misses, extra: {} };
}

/* ---------------------------------------------------------------- long horizon */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scripted long tasks on a throwaway engine: a six-step task with one flaky step must finish with no
 * finished step run twice, and a group asked for "at the same time" with one flaky piece must repeat
 * only that piece. These are the guarantees a Windows restart or a failed tool must not break.
 */
export async function runLongHorizonSuite(): Promise<SuiteReport> {
  const misses: string[] = [];
  let passed = 0;
  const settle = async (engine: TaskGraphEngine) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await sleep(5);
      if (!engine.list().some((g) => g.state === "running" || g.state === "queued")) return;
    }
  };

  // 1. six steps, one transient failure: finishes, every step ran once except the flaky one.
  {
    const engine = new TaskGraphEngine();
    const runs: Record<string, number> = {};
    engine.registerRunner("goal", async ({ node }) => {
      runs[node.title] = (runs[node.title] ?? 0) + 1;
      if (node.title === "step four" && runs[node.title] === 1) throw new Error("socket hang up");
      return { result: `done ${node.title}`, checked: true };
    });
    const { id } = engine.submit(
      "step one\n2. step two\n3. step three\n4. step four\n5. step five\n6. step six",
    );
    await settle(engine);
    const graph = engine.get(id);
    const onceEach = Object.entries(runs).every(([title, n]) =>
      title === "step four" ? n === 2 : n === 1,
    );
    if (graph?.state === "completed" && onceEach) passed += 1;
    else misses.push(`six-steps: state ${graph?.state}, runs ${JSON.stringify(runs)}`);
  }

  // 2. a together-group with one flaky piece repeats only that piece.
  {
    const engine = new TaskGraphEngine();
    const runs: Record<string, number> = {};
    engine.registerRunner("goal", async ({ node }) => {
      runs[node.title] = (runs[node.title] ?? 0) + 1;
      if (node.title === "flaky piece" && runs[node.title] === 1) throw new Error("socket hang up");
      return { result: "ok", checked: true };
    });
    const { id } = engine.submit("steady piece and flaky piece and quiet piece in parallel");
    await settle(engine);
    const ok =
      engine.get(id)?.state === "completed" &&
      runs["steady piece"] === 1 &&
      runs["quiet piece"] === 1 &&
      runs["flaky piece"] === 2;
    if (ok) passed += 1;
    else misses.push(`together-group: ${JSON.stringify(runs)}`);
  }

  // 3. a later step receives the earlier steps' results as data.
  {
    const engine = new TaskGraphEngine();
    let seen: string[] = [];
    engine.registerRunner("goal", async ({ node, earlier }) => {
      if (node.title === "report") seen = earlier;
      return { result: `output of ${node.title}`, files: [`${node.title}.csv`], checked: true };
    });
    const { id } = engine.submit("fetch\n2. clean\n3. report");
    await settle(engine);
    if (engine.get(id)?.state === "completed" && seen.length === 2) passed += 1;
    else misses.push(`shared-context: saw ${seen.length} earlier result(s)`);
  }

  return { suite: "long-horizon", tasks: 3, passed, misses, extra: {} };
}

/* ----------------------------------------------------------------- reliability */

/**
 * Pass-k: the share of tasks that passed on EVERY one of k repeated runs. One lucky pass hides an
 * unreliable system; this does not. `run` is called k times per task and answers whether it passed.
 */
export async function passAllOfK(
  tasks: string[],
  k: number,
  run: (task: string, attempt: number) => Promise<boolean>,
): Promise<SuiteReport> {
  const runs = Math.max(1, Math.min(10, Math.floor(k)));
  let always = 0;
  let any = 0;
  const misses: string[] = [];
  for (const task of tasks) {
    let wins = 0;
    for (let attempt = 0; attempt < runs; attempt += 1) {
      if (await run(task, attempt)) wins += 1;
    }
    if (wins === runs) always += 1;
    else misses.push(`${task}: passed ${wins} of ${runs}`);
    if (wins > 0) any += 1;
  }
  return {
    suite: "reliability",
    tasks: tasks.length,
    passed: always,
    misses,
    extra: { k: runs, passAtLeastOnce: tasks.length ? any / tasks.length : 0 },
  };
}

/* --------------------------------------------------------------------- history */

const HISTORY_KEY = "friday.eval-history.v1";
const KEEP = 12;
export type HistoryRow = { at: number; suite: string; tasks: number; passed: number };
let history: HistoryRow[] | null = null;

function loadHistory(): HistoryRow[] {
  if (!history) history = readLocalState<HistoryRow[]>(HISTORY_KEY) ?? [];
  return history;
}

/** Keep a result, newest last, at most twelve per suite. */
export function recordSuite(report: SuiteReport, at = Date.now()): void {
  const rows = loadHistory();
  rows.push({ at, suite: report.suite, tasks: report.tasks, passed: report.passed });
  const kept: HistoryRow[] = [];
  const count = new Map<string, number>();
  for (const item of [...rows].reverse()) {
    const n = (count.get(item.suite) ?? 0) + 1;
    count.set(item.suite, n);
    if (n <= KEEP) kept.unshift(item);
  }
  history = kept;
  writeState(HISTORY_KEY, kept);
}

export function suiteHistory(suite?: string): HistoryRow[] {
  return loadHistory().filter((item) => !suite || item.suite === suite);
}

export function clearSuiteHistoryForTests(): void {
  history = [];
  writeState(HISTORY_KEY, []);
}

export async function runAllSuites(): Promise<SuiteReport[]> {
  const reports = [
    runRetrievalSuite(),
    runRoutingSuite(),
    await runLongHorizonSuite(),
    runGateSuite().report,
  ];
  for (const report of reports) recordSuite(report);
  return reports;
}

export function describeSuites(reports: SuiteReport[]): string {
  return reports
    .map((report) => {
      const extra = Object.entries(report.extra)
        .map(
          ([key, value]) =>
            `${key} ${Number.isInteger(value) ? value : Math.round(value * 100) + "%"}`,
        )
        .join(", ");
      const ci = wilson(report.passed, report.tasks);
      const range =
        report.suite === "gates" || !report.tasks
          ? ""
          : ` [${Math.round(ci.low * 100)}–${Math.round(ci.high * 100)}% at 95%]`;
      return `${report.suite}: ${report.passed}/${report.tasks}${range}${extra ? ` (${extra})` : ""}${
        report.misses.length ? ` · missed: ${report.misses.slice(0, 3).join("; ")}` : ""
      }`;
    })
    .join("\n");
}

/* ------------------------------------------------------------- security gates */

export type GateResult = { id: string; ok: boolean; detail: string };

/**
 * Release gates: each is exact, and one failure fails the whole report. They read the real code paths
 * (the protected-file list, the change verdict at every dial, the shipped defaults); they do not average.
 * `kernelYaml` is the text of `config/kernel.yaml`, which only a node-side caller can read; without it
 * that gate is listed as not checked instead of passing.
 */
export function runGateSuite(input: { kernelYaml?: string } = {}): {
  report: SuiteReport;
  gates: GateResult[];
  notChecked: string[];
} {
  const gates: GateResult[] = [];
  const notChecked: string[] = [];
  const levels = ["strict", "balanced", "trusted", "full"] as const;
  for (const file of PROTECTED_POLICY_FILES) {
    const refused = levels.every(
      (level) => evaluateChange({ paths: [file], level }).allow === "refuse",
    );
    gates.push({
      id: `protected-file:${file}`,
      ok: refused,
      detail: refused ? "refused at every dial" : "a dial lets it through",
    });
  }
  const staged = levels.map((level) => evaluateChange({ paths: ["docs/notes.md"], level }));
  gates.push({
    id: "change-never-applied",
    ok: staged.every((verdict) => verdict.applied === false && verdict.reversible === true),
    detail: "a verdict stages or asks, it never applies",
  });
  gates.push({
    id: "halt-refuses",
    ok: levels.every(
      (level) =>
        evaluateChange({ paths: ["docs/notes.md"], level, halted: true }).allow === "refuse",
    ),
    detail: "Stop everything refuses a change at every dial",
  });
  gates.push({
    id: "fresh-install-balanced",
    ok: DEFAULT_AUTONOMY.approvalLevel === "balanced" && DEFAULT_AUTONOMY.halted === false,
    detail: `default dial is ${DEFAULT_AUTONOMY.approvalLevel}`,
  });
  if (input.kernelYaml === undefined) {
    notChecked.push("kernel-auto-approve-exec-false");
  } else {
    const line = /^\s*auto_approve_exec:\s*(\S+)/m.exec(input.kernelYaml);
    gates.push({
      id: "kernel-auto-approve-exec-false",
      ok: line?.[1] === "false",
      detail: `auto_approve_exec is ${line?.[1] ?? "missing"}`,
    });
  }
  const failed = gates.filter((gate) => !gate.ok);
  return {
    report: {
      suite: "gates",
      tasks: gates.length,
      passed: gates.length - failed.length,
      misses: failed.map((gate) => `${gate.id}: ${gate.detail}`),
      extra: { notChecked: notChecked.length },
    },
    gates,
    notChecked,
  };
}
