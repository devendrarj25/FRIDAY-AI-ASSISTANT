import { useState } from "react";
import { Gauge, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { PickRow } from "@/components/friday/settings/fields";
import { desktopApi } from "@/lib/friday/desktop";
import {
  ENGINE_PREFER_CHOICES,
  enginePreferOf,
  preferences,
  type EnginePrefer,
} from "@/lib/friday/preferences";
import {
  benchMessage,
  engineLabel,
  llmEngineAvailable,
  readEngineState,
  startBench,
  stopBench,
  type BenchResult,
  type EngineState,
} from "@/lib/friday/llm-engine";
import { useLivePoll } from "@/lib/friday/use-live-poll";
import { usePreferences } from "@/lib/friday/use-preferences";

const ENGINE_WORDS: Record<EnginePrefer, string> = {
  auto: engineLabel("auto"),
  own: engineLabel("own"),
  official: engineLabel("official"),
};

/**
 * The two chat engines on this PC: FRIDAY Runtime LLM (her own llama.cpp build) and the official llama.cpp.
 * `controls` adds the choice (stored as `brain.engine.prefer`) and the benchmark, which only the owner starts and
 * never runs during a voice turn; without it the panel only reads (the Install Manager). The state is read on the
 * shared poller while the panel is open, and again after every change.
 */
export function LlmEnginePanel({ controls = true }: { controls?: boolean }) {
  const prefs = usePreferences();
  const prefer = enginePreferOf(prefs.fields["brainEnginePrefer"]);
  const desktop = desktopApi() !== null && llmEngineAvailable();
  const [state, setState] = useState<EngineState | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);

  const { error, refresh } = useLivePoll(
    "brain.llm-engine",
    async () => {
      const next = await readEngineState(prefer);
      if (!next.ok) throw new Error(next.error ?? "The engines could not be read");
      setState(next);
    },
    15_000,
    desktop,
  );

  const pick = (next: EnginePrefer) => {
    preferences.setField("brainEnginePrefer", next);
    void refresh();
  };

  const bench = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await startBench());
    } finally {
      setRunning(false);
      void refresh();
    }
  };

  return (
    <HudPanel title="Chat engine" hint="FRIDAY Runtime LLM and llama.cpp, side by side">
      {!desktop ? (
        <EmptyState
          icon={Gauge}
          title="Needs the desktop app"
          hint="Offline: the engine choice and the benchmark run in the installed FRIDAY app."
        />
      ) : error && !state ? (
        <ErrorState
          title="The engines could not be read"
          error={error}
          onRetry={() => void refresh()}
        />
      ) : !state ? (
        <p className="text-meta-sm text-muted-foreground">Reading the engines…</p>
      ) : (
        <div className="grid gap-3">
          {error ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="text-meta-sm text-muted-foreground">
                Showing the last reading
              </p>
              <Button size="sm" variant="outline" onClick={() => refresh()}>
                Retry
              </Button>
            </div>
          ) : null}
          {state.rows?.status ? (
            <p className="text-data text-foreground">{state.rows.status}</p>
          ) : null}
          <ul className="grid gap-1" aria-label="Engines on this PC">
            {(state.doctor ?? []).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 text-data">
                <span className="text-foreground">{row.name}</span>
                <StatusPill label={row.detail} tone={row.ok ? "accent" : "warning"} />
              </li>
            ))}
          </ul>
          {controls ? (
            <>
              <PickRow
                label="Chat engine"
                hint="Automatic uses the engine the benchmark found faster on this PC, and the official one until it has run."
                value={prefer}
                picks={ENGINE_PREFER_CHOICES}
                words={ENGINE_WORDS}
                onPick={pick}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={running} onClick={() => bench()}>
                  <Gauge className="size-4" /> {running ? "Benchmarking…" : "Benchmark engines"}
                </Button>
                {running ? (
                  <Button size="sm" variant="ghost" onClick={() => stopBench()}>
                    <Square className="size-4" /> Stop benchmark
                  </Button>
                ) : null}
                {!running && result && !result.ok ? (
                  <Button size="sm" variant="outline" onClick={() => bench()}>
                    Retry
                  </Button>
                ) : null}
              </div>
              {running ? (
                <p role="status" className="text-meta-sm text-muted-foreground">
                  Measuring the own engine, then the official one, one after the other. This can
                  take a few minutes and stops at once if you press Stop.
                </p>
              ) : result ? (
                <p
                  role={result.ok ? "status" : "alert"}
                  className="text-meta-sm text-muted-foreground"
                >
                  {benchMessage(result)}
                </p>
              ) : null}
              {state.thresholdsUnverified ? (
                <p className="text-meta-sm text-muted-foreground">
                  The own build must match the official output for 16 tokens and be 5 percent faster
                  to win. Those limits are a first estimate and have not been measured on a PC yet.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </HudPanel>
  );
}
