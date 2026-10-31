/**
 * FRIDAY · error clinic and brain check panels
 *
 * Paste a failure and see the cause she reasons out, the evidence, where in the code it points and
 * the safest next step, in short Hinglish or English. The brain check runs the fixed offline
 * tasks and shows the numbers with their caveat. Both run in this window; nothing is sent out and
 * nothing is changed on this PC. The model comparison is the one exception: it asks the owner's own
 * model a fixed set of questions, so it runs only when he presses its button.
 */
import { useMemo, useState } from "react";
import { BookOpen, Play, Scale, Stethoscope } from "lucide-react";
import { ActionButton, EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import {
  diagnose,
  guidance,
  looksLikeFailure,
  prefersHinglish,
} from "@/lib/friday/brain/error-intelligence";
import { askFriday, askVerified, canAsk } from "@/lib/friday/ask";
import {
  CATEGORIES,
  coverage,
  runBank,
  type CategoryResult,
} from "@/lib/friday/self/benchmark-bank";
import { EXTERNAL_BENCHMARKS } from "@/lib/friday/self/external-eval";
import {
  describeBankReport,
  recordBankRun,
  reportBank,
  type BankReport,
} from "@/lib/friday/self/bank-history";
import { wilson } from "@/lib/friday/self/eval-stats";
import { coreBrain } from "@/lib/friday/brain/core-brain";
import { profileOf, recordCompare } from "@/lib/friday/brain/model-profile";
import { modelRegistry } from "@/lib/friday/brain/model-registry";
import { routeRefs } from "@/lib/friday/model-catalog";
import {
  describeSuites,
  runAllSuites,
  suiteHistory,
  type SuiteReport,
} from "@/lib/friday/self/eval-suites";
import {
  INSTRUCTION_TASKS,
  describeInstructionEval,
  describeRepeatedInstructionEval,
  runInstructionEval,
  runInstructionEvalRepeated,
  type InstructionEvalReport,
} from "@/lib/friday/self/instruction-eval";
import {
  EVAL_CLASSES,
  describeEval,
  runEvalHarness,
  type EvalReport,
} from "@/lib/friday/self/eval-harness";

import {
  comparePersonalRuns,
  describePersonalRun,
  parsePersonalTasks,
  personalHistory,
  recordPersonalRun,
  runPersonalEval,
  type PersonalRun,
} from "@/lib/friday/self/personal-eval";
import { STARTER_TASKS } from "@/lib/friday/self/personal-starter";
import { describeWays, type WayResult } from "@/lib/friday/self/retrieval-ab";
import { runRetrievalAb } from "@/lib/friday/self/retrieval-ab-run";
import { allSkills, type Skill } from "@/lib/friday/self/skill-loop";
import { exportSkillMd, importSkillMd } from "@/lib/friday/self/skills-standard";

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function ErrorClinicPanel() {
  const [text, setText] = useState("");
  const result = useMemo(() => {
    const raw = text.trim();
    if (!raw) return null;
    if (!looksLikeFailure(raw)) return { quiet: true as const };
    const diagnosis = diagnose({ text: raw });
    return {
      quiet: false as const,
      diagnosis,
      reply: guidance(diagnosis, prefersHinglish(raw) ? "hinglish" : "english"),
    };
  }, [text]);

  return (
    <HudPanel title="Error clinic" hint="paste a failure · nothing leaves this PC">
      <div className="grid gap-3">
        <label className="grid gap-1 text-meta text-muted-foreground">
          The error, log lines or a traceback
          <textarea
            className="h-28 rounded-surface border border-border bg-background p-2 text-data text-foreground"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Traceback (most recent call last): …"
            aria-label="Error text"
          />
        </label>
        {!result ? (
          <EmptyState
            title="Nothing pasted yet"
            hint="She names the likely cause with the evidence, where it points, and the safest next step. The pasted text is read as data, never run."
          />
        ) : result.quiet ? (
          <EmptyState
            title="That does not read like a failure"
            hint="Paste the error line or the traceback itself."
          />
        ) : (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Stethoscope className="size-4 text-accent" aria-hidden />
              <StatusPill
                label={`${pct(result.diagnosis.confidence)} sure`}
                tone={result.diagnosis.confidence >= 0.6 ? "accent" : "warning"}
              />
              <StatusPill
                label={result.diagnosis.retryable ? "a retry may help" : "a retry will not help"}
                tone={result.diagnosis.retryable ? "muted" : "warning"}
              />
            </div>
            <pre className="whitespace-pre-wrap break-words text-data text-foreground">
              {result.reply}
            </pre>
            {result.diagnosis.unknown.length ? (
              <p className="text-meta-sm text-muted-foreground">
                Not known: {result.diagnosis.unknown.join("; ")}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </HudPanel>
  );
}

export function BrainCheckPanel() {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [suites, setSuites] = useState<SuiteReport[]>([]);
  const [bank, setBank] = useState<CategoryResult[]>([]);
  const [bankReport, setBankReport] = useState<BankReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setReport(await runEvalHarness());
      setSuites(await runAllSuites());
      const bankResults = await runBank();
      setBankReport(reportBank(bankResults));
      recordBankRun(bankResults);
      setBank(bankResults);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <HudPanel
      title="Brain check"
      hint="fixed offline tasks"
      actions={
        <ActionButton
          icon={Play}
          label="Run"
          labelMode="inline"
          title="Run the fixed tasks once"
          busy={busy}
          onClick={() => void run()}
        />
      }
    >
      {error ? (
        <ErrorState title="The brain check failed" error={error} onRetry={() => void run()} />
      ) : !report ? (
        <EmptyState
          title="Not run yet"
          hint="Compares what FRIDAY had before, what she has now and a bare model on the same tasks. Offline, repeatable, no network."
        />
      ) : (
        <div className="grid gap-2">
          <p className="text-sm text-foreground">
            {report.tasks} tasks · before {pct(report.before)} · now {pct(report.after)} · bare{" "}
            {pct(report.bare)}
          </p>
          <ul className="grid gap-1">
            {EVAL_CLASSES.map((cls) => {
              const row = report.byClass[cls];
              return (
                <li key={cls} className="text-data text-muted-foreground">
                  {cls}: {row.before}/{row.total} → {row.after}/{row.total} (bare {row.bare})
                </li>
              );
            })}
          </ul>
          <p className="text-data text-warning">
            Held-out ({report.heldOut.tasks} tasks never used to tune): before{" "}
            {pct(report.heldOut.before)} · now {pct(report.heldOut.after)}
            {report.heldOut.failed.length ? ` · missed: ${report.heldOut.failed.join(", ")}` : ""}
          </p>
          <p className="text-meta-sm text-muted-foreground">{describeEval(report)}</p>
          {bank.length ? (
            <div className="grid gap-1" aria-label="Benchmark 1.0 bank">
              <p className="text-data text-foreground">
                Benchmark 1.0: {bank.length} of {CATEGORIES.length} categories scored here, no
                model, no network.
              </p>
              {bankReport
                ? describeBankReport(bankReport).map((line) => (
                    <p key={line} className="text-meta-sm text-muted-foreground">
                      {line}
                    </p>
                  ))
                : null}
              <ul className="grid gap-1">
                {coverage().map((row) => {
                  const own = bank.filter((item) => item.domain === row.domain);
                  const passed = own.reduce((sum, item) => sum + item.passed, 0);
                  const total = own.reduce((sum, item) => sum + item.total, 0);
                  const ci = wilson(passed, total);
                  return (
                    <li key={row.domain} className="text-data text-muted-foreground">
                      {row.domain}: {passed}/{total} tasks
                      {total
                        ? ` [${Math.round(ci.low * 100)}–${Math.round(ci.high * 100)}% at 95%]`
                        : ""}{" "}
                      · {row.app} scored here, {row.tests} by tests, {row.model} need a model,{" "}
                      {row.desktop + row.external} need a desktop or an outside benchmark
                    </li>
                  );
                })}
              </ul>
              <p className="text-meta-sm text-muted-foreground">
                Rules that must always hold are exact; the 85-task classes have a floor. A domain
                needs at least 50 task-runs before it gets a score. Outside benchmarks you run
                yourself, with your keys and a spend cap:{" "}
                {EXTERNAL_BENCHMARKS.map((item) => item.title).join(", ")}.
              </p>
            </div>
          ) : null}
          {suites.length ? (
            <div className="grid gap-1" aria-label="More suites">
              <p className="whitespace-pre-wrap text-data text-foreground">
                {describeSuites(suites)}
              </p>
              <p className="text-meta-sm text-muted-foreground">
                Earlier runs (passed of tasks, newest last):{" "}
                {suites
                  .map((suite) => {
                    const past = suiteHistory(suite.suite)
                      .slice(-6)
                      .map((row) => `${row.passed}/${row.tasks}`)
                      .join(" → ");
                    return `${suite.suite} ${past}`;
                  })
                  .join(" · ")}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </HudPanel>
  );
}

const PERSONAL_HINT = `One request per line:
kal ki meeting kab hai || must: kal, meeting || not: pata nahi || tag: calendar
2 plus 2 kitna hota hai || re: \\b4\\b || verified`;

export function PersonalEvalPanel() {
  const [text, setText] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [run, setRun] = useState<PersonalRun | null>(() => personalHistory().at(-1) ?? null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parsePersonalTasks(text), [text]);
  const history = personalHistory();
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const diff = run && previous ? comparePersonalRuns(previous, run) : null;

  const start = async () => {
    if (!parsed.tasks.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runPersonalEval(
        parsed.tasks,
        (prompt) => askVerified(prompt, { timeoutMs: 90_000 }),
        { repeats, onProgress: (done, total) => setProgress(`${done}/${total}`) },
      );
      recordPersonalRun(result);
      setRun(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <HudPanel
      title="My tasks"
      hint="your own requests, scored by rules"
      actions={
        <ActionButton
          icon={Play}
          label="Run"
          labelMode="inline"
          title="Ask each request once and score the answers"
          busy={busy}
          disabled={!canAsk() || !parsed.tasks.length}
          onClick={() => void start()}
        />
      }
    >
      <div className="grid gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          placeholder={PERSONAL_HINT}
          className="w-full rounded-md border border-border bg-background p-2 text-data text-foreground"
          aria-label="Your requests and what each answer must contain"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-meta-sm text-muted-foreground hover:text-foreground"
            onClick={() => setText(STARTER_TASKS)}
          >
            Load the starter set (25 typical requests, not yours)
          </button>
        </div>
        <label className="flex items-center gap-2 text-meta-sm text-muted-foreground">
          Tries per request
          <select
            value={repeats}
            onChange={(event) => setRepeats(Number(event.target.value))}
            className="rounded-md border border-border bg-background px-1 text-data"
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>{parsed.tasks.length} request(s) read</span>
        </label>
        {parsed.problems.length ? (
          <ul className="grid gap-1 text-meta-sm text-warning">
            {parsed.problems.slice(0, 5).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {!canAsk() ? (
          <p className="text-meta-sm text-muted-foreground">
            No model is ready to answer, so nothing can be run yet.
          </p>
        ) : null}
        {progress ? <p className="text-data text-muted-foreground">Running {progress}…</p> : null}
        {error ? (
          <ErrorState title="The run failed" error={error} onRetry={() => void start()} />
        ) : null}
        {run ? (
          <div className="grid gap-1">
            <pre className="whitespace-pre-wrap break-words text-data text-foreground">
              {describePersonalRun(run)}
            </pre>
            {diff ? (
              <p className="text-meta-sm text-muted-foreground">
                Since the run before: {diff.fixed.length} fixed, {diff.broke.length} broke
                {diff.p < 0.05 ? " (a real change)" : " (no measurable difference yet)"}.
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No run yet"
            hint="Put 20 to 30 of your real requests here. A request with nothing to check is refused, because it could never fail."
          />
        )}
      </div>
    </HudPanel>
  );
}

export function RetrievalAbPanel() {
  const [out, setOut] = useState<{ cases: number; results: WayResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [judge, setJudge] = useState("");
  const locals = useMemo(
    () => modelRegistry.available().map((record) => ({ id: record.id, name: record.name })),
    [],
  );
  const run = async () => {
    setBusy(true);
    try {
      setOut(await runRetrievalAb(30, judge));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <HudPanel
      title="Finding memories"
      hint="which way works on your notes"
      actions={
        <ActionButton
          icon={Scale}
          label="Compare"
          labelMode="inline"
          title="Ask each retrieval way for your own notes and compare"
          busy={busy}
          onClick={() => void run()}
        />
      }
    >
      <label className="mb-2 flex flex-wrap items-center gap-2 text-meta-sm text-muted-foreground">
        Judge model to try
        <select
          value={judge}
          onChange={(event) => setJudge(event.target.value)}
          className="rounded-md border border-border bg-background px-1 text-data"
          aria-label="Local chat model to use as the rerank judge for this comparison"
        >
          <option value="">the one assigned to Rerank (if any)</option>
          {locals.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <span>A small installed model is enough; only this comparison uses it.</span>
      </label>
      {error ? (
        <ErrorState title="The comparison failed" error={error} onRetry={() => void run()} />
      ) : !out ? (
        <EmptyState
          title="Not run yet"
          hint="Uses your saved memories: a question is made from each note's body and the note must come back. The embedding and rerank ways run only when their local model is running."
        />
      ) : out.cases < 5 ? (
        <p className="text-data text-muted-foreground">
          Only {out.cases} usable memory(ies) so far. Five or more are needed before a comparison
          means anything.
        </p>
      ) : (
        <div className="grid gap-1">
          <p className="text-data text-foreground">
            {out.cases} questions made from your own notes.
          </p>
          <pre className="whitespace-pre-wrap break-words text-data text-muted-foreground">
            {describeWays(out.results)}
          </pre>
        </div>
      )}
    </HudPanel>
  );
}

export function ModelComparePanel() {
  const [report, setReport] = useState<InstructionEvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [repeated, setRepeated] = useState<string | null>(null);
  const available = canAsk();
  const models = useMemo(
    () => modelRegistry.available().map((record) => ({ id: record.id, name: record.name })),
    [],
  );
  const stats = coreBrain.modelStats();
  const measured = models
    .map((model) => ({ model, profile: profileOf(model.id, stats) }))
    .filter((row) => row.profile.measured);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // One chosen model, or whichever FRIDAY routes to when none is chosen.
      const modelIds = chosen ? routeRefs([chosen]) : [];
      if (repeats > 1) {
        const many = await runInstructionEvalRepeated({
          repeats,
          rungs: [{ id: chosen || "default", label: chosen || "your configured models", modelIds }],
          ask: (prompt) =>
            askFriday(prompt, { timeoutMs: 60_000, ...(modelIds.length ? { modelIds } : {}) }),
          onProgress: (done, total) => setProgress(`${done} of ${total} asked`),
        });
        setRepeated(describeRepeatedInstructionEval(many));
        setReport(null);
        return;
      }
      setRepeated(null);
      const result = await runInstructionEval({
        rungs: [{ id: chosen || "default", label: chosen || "your configured models", modelIds }],
        ask: (prompt) =>
          askFriday(prompt, { timeoutMs: 60_000, ...(modelIds.length ? { modelIds } : {}) }),
        onProgress: (done, total) => setProgress(`${done} of ${total} asked`),
      });
      setReport(result);
      // A comparison is kept only for a model that was actually named, and only if it answered.
      if (chosen && result.unanswered === 0) {
        recordCompare(chosen, {
          tasks: result.tasks,
          bare: result.bare,
          loop: result.brain,
          calls: result.calls,
        });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <HudPanel
      title="Brain against my model"
      hint={`${INSTRUCTION_TASKS.length} fixed asks · uses your models`}
      actions={
        <ActionButton
          icon={Scale}
          label="Compare"
          labelMode="inline"
          title="Ask the chosen model the fixed asks, as it is and through FRIDAY's check-and-fix loop"
          busy={busy}
          disabled={!available}
          onClick={() => void run()}
        />
      }
    >
      {!available ? (
        <EmptyState
          title="Needs the desktop app"
          hint="The comparison asks your configured models, which the browser preview does not have."
        />
      ) : (
        <div className="grid gap-3">
          <label className="grid gap-1 text-meta text-muted-foreground">
            Model to compare (a named model keeps its result in its profile)
            <select
              className="rounded-surface border border-border bg-background p-2 text-foreground"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              aria-label="Model to compare"
            >
              <option value="">Whichever FRIDAY routes to</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-meta text-muted-foreground">
            Runs per ask (more runs show whether the rules are kept every time, and cost that many
            times the questions)
            <select
              className="rounded-surface border border-border bg-background p-2 text-foreground"
              value={repeats}
              onChange={(event) => setRepeats(Number(event.target.value))}
              aria-label="Runs per ask"
            >
              {[1, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 run" : `${n} runs`}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <ErrorState title="The comparison failed" error={error} onRetry={() => void run()} />
          ) : repeated ? (
            <p className="whitespace-pre-wrap text-data text-foreground">{repeated}</p>
          ) : !report ? (
            <EmptyState
              title={busy ? (progress ?? "Starting…") : "Not run yet"}
              hint="Sends about 20 to 45 short questions to the model (local models cost nothing; a paid cloud model may). Each is answered as it is, then through the loop that checks the rules of the ask and fixes a miss. Nothing is sent until you press Compare."
            />
          ) : (
            <p className="whitespace-pre-wrap text-data text-foreground">
              {describeInstructionEval(report)}
            </p>
          )}
          {measured.length ? (
            <ul className="grid gap-1" aria-label="Measured model profiles">
              {measured.map(({ model, profile }) => (
                <li key={model.id} className="text-data text-muted-foreground">
                  {model.name}: {profile.runs} live run(s)
                  {profile.passRate === null ? "" : ` · ${pct(profile.passRate)} passed her checks`}
                  {profile.avgMs === null ? "" : ` · ${profile.avgMs} ms`}
                  {profile.rulesKept === null
                    ? " · not compared"
                    : ` · rules kept ${pct(profile.rulesKept)} as it is, ${pct(profile.rulesKeptWithLoop ?? 0)} with the loop`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta-sm text-muted-foreground">
              No model has a measured profile yet. Profiles come from real runs and from Compare.
            </p>
          )}
        </div>
      )}
    </HudPanel>
  );
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>(() => allSkills());
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => setSkills(allSkills());
  const bring = () => {
    const done = importSkillMd(text);
    if (!done.parsed.ok) setNote(done.parsed.errors.join("; "));
    else if (!done.written?.written) setNote(`Not taken in: ${done.written?.reason ?? "refused"}`);
    else {
      setNote("Taken in as a candidate. It is not used until it passes held-out cases.");
      setText("");
      refresh();
    }
  };
  const share = async (skill: Skill) => {
    try {
      await navigator.clipboard.writeText(exportSkillMd(skill));
      setNote(`SKILL.md for "${skill.goal}" copied.`);
    } catch {
      setNote("The clipboard is not available here.");
    }
  };

  return (
    <HudPanel
      title="Skills"
      hint="learned, screened, and the open SKILL.md format"
      actions={
        <ActionButton
          icon={BookOpen}
          label="Refresh"
          labelMode="inline"
          title="Re-read the learned skills"
          onClick={refresh}
        />
      }
    >
      <div className="grid gap-3">
        {skills.length ? (
          <ul className="grid gap-1" aria-label="Learned skills">
            {skills.slice(0, 12).map((skill) => (
              <li key={skill.id} className="flex items-center justify-between gap-2 text-data">
                <span className="text-foreground">
                  {skill.goal} · v{skill.meta.version} · {skill.meta.status} · {skill.meta.wins}{" "}
                  won, {skill.meta.losses} lost · from {skill.meta.origin}
                </span>
                <button
                  type="button"
                  className="text-meta text-primary underline"
                  onClick={() => void share(skill)}
                >
                  Copy SKILL.md
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No learned skills yet"
            hint="A skill is learned only from a verified run or your correction. Text from the web, a file, a tool or a model is data, never a lesson."
          />
        )}
        <label className="grid gap-1 text-meta text-muted-foreground">
          Paste a SKILL.md to take in (it waits as a candidate; its scripts are never run)
          <textarea
            className="min-h-24 rounded-surface border border-border bg-background p-2 font-mono text-foreground"
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="SKILL.md to import"
          />
        </label>
        <div className="flex items-center gap-2">
          <ActionButton
            icon={BookOpen}
            label="Take in"
            labelMode="inline"
            title="Check the file against FRIDAY's skill rules and keep it as a candidate"
            disabled={!text.trim()}
            onClick={bring}
          />
          {note ? <p className="text-meta-sm text-muted-foreground">{note}</p> : null}
        </div>
      </div>
    </HudPanel>
  );
}
