import { useMemo, useState } from "react";
import { RadioTower, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill } from "@/components/friday/ui";
import { desktopApi } from "@/lib/friday/desktop";
import {
  formatTokens,
  modelLiveState,
  useModelLive,
  type LiveState,
} from "@/lib/friday/model-live";
import { useModelRegistry } from "@/lib/friday/use-model-registry";

/** Worst first, so a model that needs attention is never below the fold. */
const SEVERITY: Record<LiveState, number> = {
  Quarantined: 0,
  "Rate limited": 1,
  "Cooling down": 2,
  Recovering: 3,
  Blocked: 4,
  Active: 5,
  Ready: 6,
};

const ago = (at: number, now: number) => {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
};

/**
 * What the router is doing right now: its settings, the last models it tried and
 * why, and for every model it has used the state, tokens and countdown. Reads the
 * live store, so a request, a failure or a cooldown shows up here as it happens.
 */
export function ModelsLivePanel() {
  const live = useModelLive();
  const registry = useModelRegistry();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const now = live.now || live.at;

  const names = useMemo(
    () =>
      new Map(
        registry.models.map((m) => [
          m.id,
          {
            label: m.choiceLabel || m.displayName || m.modelName || m.label || m.id,
            provider: m.providerName || m.provider,
          },
        ]),
      ),
    [registry.models],
  );

  const rows = useMemo(() => {
    const ids = new Set([
      ...Object.keys(live.byId),
      ...registry.models.filter((m) => m.coolingDown).map((m) => m.id),
    ]);
    return [...ids]
      .map((id) => {
        const row = live.byId[id];
        return { id, row, view: modelLiveState(row, now) };
      })
      .sort(
        (a, b) =>
          SEVERITY[a.view.state] - SEVERITY[b.view.state] ||
          (b.row?.lastAt ?? 0) - (a.row?.lastAt ?? 0),
      );
  }, [live.byId, registry.models, now]);

  const cooling = rows.filter((r) => r.view.retryInMs > 0).length;
  const quarantined = rows.filter((r) => r.view.state === "Quarantined").length;
  const test = async (id: string) => {
    setNotes((prev) => ({ ...prev, [id]: "testing…" }));
    try {
      const res = await desktopApi()?.modelHealth?.(id);
      const text = !res
        ? "no desktop bridge"
        : res.ok
          ? `answered${res.latencyMs ? ` in ${res.latencyMs} ms` : ""}`
          : (res as { blocked?: boolean; error?: string }).blocked
            ? `not tested — ${(res as { error?: string }).error ?? "blocked by a rule"}`
            : `did not answer — ${(res as { error?: string }).error ?? "no reason given"}`;
      setNotes((prev) => ({ ...prev, [id]: text }));
    } catch (err) {
      setNotes((prev) => ({ ...prev, [id]: String((err as Error).message ?? err) }));
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <HudPanel title="Router" hint="live, from the main process">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Mode</dt>
          <dd>{registry.routeMode}</dd>
          <dt className="text-muted-foreground">Cost policy</dt>
          <dd>{registry.policy}</dd>
          <dt className="text-muted-foreground">Quality</dt>
          <dd>{registry.qualityTarget}</dd>
          <dt className="text-muted-foreground">Strategy</dt>
          <dd>{registry.strategy}</dd>
          <dt className="text-muted-foreground">Picked models</dt>
          <dd>{registry.selected.length ? registry.selected.length : "Auto"}</dd>
          <dt className="text-muted-foreground">Requests</dt>
          <dd>{live.totals.requests}</dd>
          <dt className="text-muted-foreground">Tokens today</dt>
          <dd title="Counted from text length unless the provider reported usage">
            ≈ {formatTokens(live.totals.todayTokens)}
          </dd>
          <dt className="text-muted-foreground">Cooling / quarantined</dt>
          <dd>
            {cooling} / {quarantined}
          </dd>
        </dl>
        <p className="mt-2 text-note text-muted-foreground">{registry.hint}</p>
      </HudPanel>

      <HudPanel title="Last models tried" hint="newest first">
        {live.decisions.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing has been routed yet. Ask FRIDAY something and the choice shows here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...live.decisions].reverse().map((d, i) => (
              <li key={`${d.at}-${i}`} className="text-sm">
                <span className="font-medium">{names.get(d.modelId)?.label ?? d.modelId}</span>{" "}
                <span className="text-muted-foreground">
                  {d.outcome}
                  {d.latencyMs ? ` · ${d.latencyMs} ms` : ""} · {ago(d.at, now)}
                </span>
                {d.why ? <p className="text-note text-muted-foreground">{d.why}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </HudPanel>

      <HudPanel
        title="Usage"
        hint="counts only, no prompt text is kept"
        actions={
          <Button
            size="sm"
            variant="ghost"
            title="Reset all usage counts"
            onClick={() => void import("@/lib/friday/model-live").then((m) => m.modelLive.reset())}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        }
      >
        <p className="text-sm">
          {live.totals.requests} requests · ≈ {formatTokens(live.totals.tokens)} tokens in total
        </p>
        <p className="mt-1 text-note text-muted-foreground">
          Tokens are counted from text length (about four characters each) unless the provider
          reports its own number.
        </p>
      </HudPanel>

      <div className="lg:col-span-3">
        <HudPanel title="Model status" hint={`${rows.length} model(s) the router has touched`}>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No model has been used yet. Status, tokens and cooldowns appear here as soon as one
              is.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map(({ id, row, view }) => (
                <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={id}>
                      {names.get(id)?.label ?? id}
                      <span className="ml-2 text-meta text-muted-foreground">
                        {names.get(id)?.provider ?? row?.providerId ?? ""}
                      </span>
                    </p>
                    <p className="text-note text-muted-foreground">{view.detail}</p>
                    {notes[id] ? <p className="text-note text-primary">{notes[id]}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-meta text-muted-foreground">
                    <span title="requests answered / failed">
                      {row?.answered ?? 0} ok · {row?.failed ?? 0} failed
                      {row?.blocked ? ` · ${row.blocked} blocked` : ""}
                    </span>
                    <span title="tokens in / out, all time">
                      ≈ {formatTokens(row?.promptTokens ?? 0)} in /{" "}
                      {formatTokens(row?.completionTokens ?? 0)} out
                    </span>
                    {row?.latencyMs ? <span>{row.latencyMs} ms</span> : null}
                    <span>{ago(row?.lastAt ?? 0, now)}</span>
                    <StatusPill label={view.state} tone={view.tone} />
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Send one test request"
                      onClick={() => void test(id)}
                    >
                      <RadioTower className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </HudPanel>
      </div>
    </div>
  );
}
