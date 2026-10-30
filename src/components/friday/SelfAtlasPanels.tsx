/**
 * FRIDAY · Self Atlas and PC reliability panels
 *
 * What FRIDAY reads about herself and this PC, with the source, age and confidence of every fact.
 * The data is the live probe result from the desktop app. A fact that was not read says so; the
 * browser preview, which has no probes, says that instead of showing a decorative "healthy".
 */
import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import {
  ActionButton,
  EmptyState,
  HudPanel,
  LoadingState,
  StatusPill,
} from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { livePoller } from "@/lib/friday/live-poll";
import {
  ATLAS_GROUP_ORDER,
  ATLAS_GROUP_TITLES,
  ageText,
  refreshAtlas,
  refreshReliability,
  type AtlasStatus,
} from "@/lib/friday/self-atlas";
import { useSelfAtlas } from "@/lib/friday/use-self-atlas";
import { useSecondsTick } from "@/lib/friday/use-clock-tick";

type Tone = "accent" | "warning" | "destructive" | "muted";

const TONE: Record<AtlasStatus, Tone> = {
  ok: "accent",
  warn: "warning",
  bad: "destructive",
  unknown: "muted",
};

const LABEL: Record<AtlasStatus, string> = {
  ok: "read",
  warn: "look",
  bad: "problem",
  unknown: "not inspected",
};

export function SelfAtlasPanels() {
  const view = useSelfAtlas();
  const { atlas, reliability, available, loading, error, refresh } = view;
  useSecondsTick(15);

  useEffect(() => {
    if (!available) return;
    // The shared poller owns the schedule; both reads reuse a fresh answer.
    return livePoller().subscribe(
      "self.atlas",
      async () => {
        await refreshAtlas();
        await refreshReliability();
      },
      20_000,
    );
  }, [available]);

  if (!available) {
    return (
      <HudPanel title="Self Atlas" hint="desktop app only">
        <EmptyState
          title="Self Atlas needs the desktop app"
          hint="The browser preview has no probes, so there is nothing to read and nothing is guessed. Open FRIDAY on this PC to see where she lives, what is running and how this machine is doing."
        />
      </HudPanel>
    );
  }

  const refreshAction = (
    <ActionButton
      icon={RefreshCw}
      label="Refresh"
      labelMode="inline"
      title="Read the probes again now"
      busy={loading}
      onClick={() => void refresh()}
    />
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2" data-self-atlas>
      <HudPanel
        title="Self Atlas"
        hint={atlas ? `read ${ageText(atlas.readAt)}` : "not read yet"}
        actions={refreshAction}
      >
        {error && !atlas ? (
          <ErrorState
            title="The atlas could not be read"
            error={error}
            onRetry={() => void refresh()}
          />
        ) : !atlas ? (
          <LoadingState label="Reading my own folders, processes and settings…" rows={4} />
        ) : atlas.facts.length === 0 ? (
          <EmptyState title="No facts were read" hint="Press Refresh to read the probes again." />
        ) : (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">{atlas.summary}</p>
            {ATLAS_GROUP_ORDER.map((group) => {
              const rows = atlas.facts.filter((fact) => fact.group === group);
              if (!rows.length) return null;
              return (
                <section key={group} aria-label={ATLAS_GROUP_TITLES[group]}>
                  <h3 className="mb-1 text-meta uppercase tracking-wider text-muted-foreground">
                    {ATLAS_GROUP_TITLES[group]}
                  </h3>
                  <ul className="grid gap-1.5">
                    {rows.map((fact) => (
                      <li
                        key={`${fact.group}:${fact.id}`}
                        className="rounded-ctl border border-border/60 px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-foreground">{fact.label}</span>
                          <StatusPill label={LABEL[fact.status]} tone={TONE[fact.status]} />
                        </div>
                        <p className="break-words text-data text-muted-foreground">
                          {fact.status === "unknown" ? "not inspected" : fact.value}
                        </p>
                        {fact.note ? (
                          <p className="break-words text-data text-warning">{fact.note}</p>
                        ) : null}
                        <p className="text-meta-sm text-muted-foreground/80">
                          {fact.source} · read {ageText(fact.readAt)} ·{" "}
                          {Math.round(fact.confidence * 100)}% sure
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </HudPanel>

      <HudPanel
        title="This PC — reliability"
        hint={reliability ? `read ${ageText(reliability.detectedAt)}` : "not read yet"}
      >
        {error && !reliability ? (
          <ErrorState
            title="The PC probes could not be read"
            error={error}
            onRetry={() => void refresh()}
          />
        ) : !reliability ? (
          <LoadingState label="Reading crash records, startup entries and updates…" rows={4} />
        ) : !reliability.supported ? (
          <EmptyState
            title="These probes read Windows only"
            hint={reliability.items[0]?.detail ?? "Not supported on this machine."}
          />
        ) : (
          <ul className="grid gap-1.5">
            {reliability.items.map((item) => (
              <li key={item.id} className="rounded-ctl border border-border/60 px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">{item.label}</span>
                  <StatusPill label={LABEL[item.state]} tone={TONE[item.state]} />
                </div>
                <p className="break-words text-data text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </HudPanel>
    </div>
  );
}
