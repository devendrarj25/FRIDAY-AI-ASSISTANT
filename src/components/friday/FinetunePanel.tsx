/**
 * Local fine-tuning, in one panel: readiness of this PC, a training run proposed from the owner's own verified
 * successes (it still waits for his approval in the approval gate), the trained adapters, and the switch back to
 * the plain base model. Everything runs on this PC. It needs the installed desktop app.
 */
import { useEffect, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { modelRegistry } from "@/lib/friday/brain/model-registry";
import {
  MIN_EXAMPLES,
  activateAdapter,
  buildTrainingSet,
  cancelFinetune,
  finetuneAdapters,
  finetuneAvailable,
  finetuneProbe,
  finetuneState,
  onFinetuneActive,
  onFinetuneRun,
  proposeFinetune,
  removeAdapter,
  type FinetuneAdapter,
  type FinetuneReadiness,
  type FinetuneRun,
} from "@/lib/friday/self/finetune";

type View = {
  readiness: FinetuneReadiness;
  runs: FinetuneRun[];
  adapters: FinetuneAdapter[];
  active: string | null;
};

export function FinetunePanel() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  // Read again on every reload, which a finished run or a switched adapter triggers.
  const examples = reload >= 0 ? buildTrainingSet().length : 0;
  const bases = useMemo(
    () => modelRegistry.available().map((record) => ({ id: record.id, name: record.name })),
    [],
  );

  useEffect(() => {
    let alive = true;
    Promise.all([finetuneProbe(), finetuneState(), finetuneAdapters()])
      .then(([readiness, state, adapters]) => {
        if (!alive) return;
        setView({
          readiness,
          runs: state.runs.slice(0, 5),
          adapters: adapters.adapters,
          active: adapters.activeAdapter ?? state.activeAdapter,
        });
        setError(null);
      })
      .catch((failure) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      });
    const offRun = onFinetuneRun(() => setReload((n) => n + 1));
    const offActive = onFinetuneActive(() => setReload((n) => n + 1));
    return () => {
      alive = false;
      offRun?.();
      offActive?.();
    };
  }, [reload]);

  const refresh = () => setReload((n) => n + 1);

  const propose = async () => {
    if (!base) return;
    setBusy(true);
    try {
      const out = await proposeFinetune({ base });
      if (out.started) toast.success("Training started on this PC");
      else toast.message(out.reason ?? "Training did not start");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const act = async (label: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    const out = await run();
    if (out.ok) toast.success(label);
    else toast.error(out.error ?? "That did not work");
    refresh();
  };

  return (
    <HudPanel title="Local fine-tune" hint="train on your own verified runs, on this PC">
      {!finetuneAvailable() ? (
        <EmptyState
          icon={Cpu}
          title="Needs the desktop app"
          hint="Local training runs in the installed FRIDAY app, with its own Python environment."
        />
      ) : error ? (
        <ErrorState title="Fine-tune status could not be read" error={error} onRetry={refresh} />
      ) : !view ? (
        <p className="text-meta-sm text-muted-foreground">Checking this PC…</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={view.readiness.ready ? "ready" : "not ready"}
              tone={view.readiness.ready ? "accent" : "warning"}
            />
            <span className="text-meta-sm text-muted-foreground">{view.readiness.detail}</span>
          </div>
          <p className="text-data text-foreground">
            {examples} verified example(s) of {MIN_EXAMPLES} needed. Owner corrections and unchecked
            runs are never used.
          </p>
          <label className="flex flex-wrap items-center gap-2 text-meta-sm text-muted-foreground">
            Base model
            <select
              value={base}
              onChange={(event) => setBase(event.target.value)}
              className="rounded-md border border-border bg-background px-1 text-data"
              aria-label="Base model to train an adapter for"
            >
              <option value="">choose one</option>
              {bases.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!base || busy || !view.readiness.ready || examples < MIN_EXAMPLES}
              onClick={() => void propose()}
            >
              Propose training
            </Button>
          </label>
          {view.runs.length ? (
            <ul className="grid gap-1">
              {view.runs.map((run) => (
                <li
                  key={run.id}
                  className="flex items-center justify-between gap-2 text-data text-muted-foreground"
                >
                  <span>
                    {run.base} · {run.examples} examples · {run.state}
                    {run.state === "running" ? ` ${Math.round(run.progress * 100)}%` : ""}
                    {run.loss !== null ? ` · loss ${run.loss.toFixed(3)}` : ""}
                  </span>
                  {run.state === "running" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void act("Training stopped", cancelFinetune)}
                    >
                      Stop
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {view.adapters.length ? (
            <ul className="grid gap-1" aria-label="Trained adapters">
              {view.adapters.map((adapter) => (
                <li key={adapter.id} className="flex items-center justify-between gap-2 text-data">
                  <span className="text-foreground">
                    {adapter.id}
                    {adapter.base ? ` · ${adapter.base}` : ""}
                    {adapter.id === view.active ? " · in use" : ""}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={adapter.id === view.active}
                      onClick={() =>
                        void act("Adapter switched on", () => activateAdapter(adapter.id))
                      }
                    >
                      Use
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`Delete adapter ${adapter.id}?`))
                          void act("Adapter removed", () => removeAdapter(adapter.id));
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta-sm text-muted-foreground">No adapter trained yet.</p>
          )}
          {view.active ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void act("Back on the plain base model", () => activateAdapter(null))}
            >
              Switch back to the plain base model
            </Button>
          ) : null}
        </div>
      )}
    </HudPanel>
  );
}
