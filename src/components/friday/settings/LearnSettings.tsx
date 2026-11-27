import { useEffect, useState } from "react";
import { Brain, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, HudPanel, ToggleRow } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { kernelApi } from "@/lib/friday/kernel-api";
import { adapterUndoTarget } from "@/lib/friday/llm-engine";
import { onGlossaryLearned } from "@/lib/friday/glossary-correction";
import { mirrorGlossarySetting, reconcileGlossarySetting } from "@/lib/friday/learn-from-me";
import { LEARN_DATA_CLASSES, acceptedLearnClasses, preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import {
  activateAdapter,
  finetuneAdapters,
  finetuneAvailable,
  onFinetuneActive,
  onFinetuneRun,
  type FinetuneAdapter,
} from "@/lib/friday/self/finetune";

type Words = { terms: string[] } | { error: string } | null;

/**
 * "Learn from me": what FRIDAY may learn on this PC, in the owner's hands.
 *  - an on-device adapter for the local model (off until he turns it on, one data class at a time);
 *  - the words he corrected, as hints for the ears (on by default, each word can be forgotten);
 *  - what changed, with Undo (the previous adapter, or the plain base model).
 * Everything stays on this PC. Nothing is read or written until the controls are used.
 */
export function LearnSettings() {
  const prefs = usePreferences();
  const adaptersOn = prefs.toggles["brainLearnAdapters"] === true;
  const glossaryOn = prefs.toggles["brainLearnGlossary"] !== false;
  const accepted = acceptedLearnClasses(prefs.fields["brainLearnClasses"]);
  const [reload, setReload] = useState(0);
  const [words, setWords] = useState<Words>(null);
  const [adapters, setAdapters] = useState<{
    list: FinetuneAdapter[];
    active: string | null;
  } | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const refresh = () => setReload((n) => n + 1);

  useEffect(() => {
    let alive = true;
    kernelApi.glossary
      .list(true)
      .then((out) => {
        if (!alive) return;
        setWords(out ? { terms: out.terms } : { error: "The kernel is offline." });
      })
      .catch((failure) => {
        if (alive)
          setWords({ error: failure instanceof Error ? failure.message : String(failure) });
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!finetuneAvailable()) return;
    let alive = true;
    finetuneAdapters()
      .then((out) => {
        if (!alive) return;
        setAdapters({ list: out.adapters, active: out.activeAdapter });
        setAdapterError(null);
      })
      .catch((failure) => {
        if (alive) setAdapterError(failure instanceof Error ? failure.message : String(failure));
      });
    const offRun = onFinetuneRun(() => setReload((n) => n + 1));
    const offActive = onFinetuneActive(() => setReload((n) => n + 1));
    return () => {
      alive = false;
      offRun?.();
      offActive?.();
    };
  }, [reload]);

  // A correction saved from the transcript refreshes this list straight away.
  useEffect(() => onGlossaryLearned(() => setReload((n) => n + 1)), []);

  const setGlossary = async (next: boolean) => {
    preferences.setToggle("brainLearnGlossary", next);
    if (!(await mirrorGlossarySetting(next)))
      toast.message("The kernel is offline. The choice is kept and applied when it is back.");
  };

  // The kernel reads this switch itself: after a restart or an offline toggle it is written again if it differs.
  useEffect(() => {
    void reconcileGlossarySetting(glossaryOn);
  }, [glossaryOn]);

  const pickClass = (id: string, on: boolean) => {
    const next = LEARN_DATA_CLASSES.map((entry) => entry.id).filter((entry) =>
      entry === id ? on : accepted.includes(entry),
    );
    preferences.setField("brainLearnClasses", next.join(","));
  };

  const forget = async (term: string | null) => {
    const out = term ? await kernelApi.glossary.forget(term) : await kernelApi.glossary.forgetAll();
    if (out) toast.success(term ? `Forgot "${term}"` : "Forgot every learned word");
    else toast.error("The kernel is offline, so nothing was forgotten");
    refresh();
  };

  const undo = async () => {
    const target = adapters ? adapterUndoTarget(adapters.list, adapters.active) : null;
    if (!target) return;
    const out = await activateAdapter(target.id);
    if (out.ok)
      toast.success(target.id ? `Back to adapter ${target.id}` : "Back on the plain base model");
    else toast.error(out.error ?? "That did not work");
    refresh();
  };

  const target = adapters ? adapterUndoTarget(adapters.list, adapters.active) : null;
  const changes = (adapters?.list ?? []).slice(0, 5);

  return (
    <HudPanel title="Learn from me" hint="on this PC only, nothing is uploaded" icon={Brain}>
      <p className="text-note text-muted-foreground">
        She learns only from what I wrote. SENSITIVE text, anything that looks like a secret, and
        anything that came from a tool, a web page, the screen, a file, an email or a connector is
        never used. Cloud answers are never used either.
      </p>

      <div className="mt-3 grid gap-2">
        <ToggleRow
          label="Learn from my verified tasks (on-device adapter)"
          hint="Off by default. Trains a small add-on for the local model, only while the PC is idle and on AC power. The base model file is never changed."
          on={adaptersOn}
          onToggle={() => preferences.setToggle("brainLearnAdapters", !adaptersOn)}
        />
        <fieldset className="grid gap-1.5" disabled={!adaptersOn}>
          <legend className="label-xs text-muted-foreground">
            What she may learn from{adaptersOn ? "" : " (turn learning on first)"}
          </legend>
          {LEARN_DATA_CLASSES.map((entry) => (
            <label key={entry.id} className="flex items-start gap-2 text-data text-foreground">
              <Checkbox
                checked={accepted.includes(entry.id)}
                disabled={!adaptersOn}
                onCheckedChange={(value) => pickClass(entry.id, value === true)}
                aria-label={entry.label}
              />
              <span>
                {entry.label}
                <span className="block text-meta-sm text-muted-foreground">{entry.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="mt-4 grid gap-2">
        <ToggleRow
          label="Learn the words I correct"
          hint="Words from lines I fixed become hints for the ears. On by default, local, and every word can be forgotten."
          on={glossaryOn}
          onToggle={() => setGlossary(!glossaryOn)}
        />
        {words === null ? (
          <p className="text-meta-sm text-muted-foreground">Reading learned words…</p>
        ) : "error" in words ? (
          <ErrorState
            title="Learned words could not be read"
            error={words.error}
            onRetry={refresh}
          />
        ) : words.terms.length === 0 ? (
          <p className="text-meta-sm text-muted-foreground">
            No learned words yet. They appear here after I correct a line.
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-1.5" aria-label="Learned words">
              {words.terms.map((term) => (
                <li key={term} className="flex items-center gap-1 text-data text-foreground">
                  {term}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Forget ${term}`}
                    onClick={() => forget(term)}
                  >
                    Forget
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" variant="outline" onClick={() => forget(null)}>
                Forget all
              </Button>
            </div>
            {glossaryOn ? null : (
              <p className="text-meta-sm text-muted-foreground">
                The switch is off, so these words are not used. Forget all removes them for good.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        <p className="label-xs text-muted-foreground">What changed</p>
        {!finetuneAvailable() ? (
          <EmptyState
            icon={Brain}
            title="Needs the desktop app"
            hint="Offline: adapters are trained and kept in the installed FRIDAY app."
          />
        ) : adapterError ? (
          <ErrorState title="Adapters could not be read" error={adapterError} onRetry={refresh} />
        ) : !adapters ? (
          <p className="text-meta-sm text-muted-foreground">Reading adapters…</p>
        ) : changes.length === 0 ? (
          <p className="text-meta-sm text-muted-foreground">
            Nothing has changed yet. The base model is running as it came.
          </p>
        ) : (
          <ul className="grid gap-1" aria-label="Adapter changes">
            {changes.map((adapter) => (
              <li key={adapter.id} className="text-data text-muted-foreground">
                <span className="text-foreground">{adapter.id}</span>
                {adapter.examples !== null ? ` · ${adapter.examples} examples` : ""}
                {adapter.loss !== null ? ` · loss ${adapter.loss.toFixed(3)}` : ""}
                {adapter.id === adapters.active ? " · in use" : ""}
              </li>
            ))}
          </ul>
        )}
        {target ? (
          <div>
            <Button size="sm" variant="outline" onClick={() => undo()}>
              <Undo2 className="size-4" />{" "}
              {target.id ? `Undo: back to ${target.id}` : "Undo: back to the plain base model"}
            </Button>
          </div>
        ) : null}
      </div>
    </HudPanel>
  );
}
