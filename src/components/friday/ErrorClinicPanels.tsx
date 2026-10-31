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
import { Play, Scale, Stethoscope } from "lucide-react";
import { ActionButton, EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import {
  diagnose,
  guidance,
  looksLikeFailure,
  prefersHinglish,
} from "@/lib/friday/brain/error-intelligence";
import { askFriday, canAsk } from "@/lib/friday/ask";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setReport(await runEvalHarness());
      setSuites(await runAllSuites());
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
