import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, HudPanel, LoadingState, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { cn } from "@/lib/utils";
import {
  healthView,
  pcSections,
  pcSummaryLine,
  type PcRow,
  type RowState,
} from "@/lib/friday/pc-status";
import type { usePcStatus } from "@/lib/friday/use-pc-status";

export type PcStatusState = ReturnType<typeof usePcStatus>;

const VALUE_TONE: Record<RowState, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  bad: "text-destructive",
  unknown: "text-muted-foreground/70",
};

const HEALTH_PILL = {
  ok: { label: "Healthy", tone: "accent" },
  tight: { label: "Tight", tone: "warning" },
  critical: { label: "Critical", tone: "destructive" },
  unknown: { label: "Measuring", tone: "muted" },
} as const;

function Rows({ rows }: { rows: PcRow[] }) {
  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 text-xs">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cn("break-words text-right font-mono", VALUE_TONE[row.state])}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Live PC detection: what the main process measured about this PC (system, processor, memory, graphics and CUDA, disks,
 * network, power, health) and what the resource governor is doing about it. `compact` is the short form for the
 * Status page. Loading, offline and error (with Retry) are the shared page states; nothing here invents a number.
 */
export function PcStatusPanel({
  state,
  compact = false,
}: {
  /** From `usePcStatus()`, called once by the page so its other numbers read the same facts. */
  state: PcStatusState;
  compact?: boolean;
}) {
  const { view, busy, refresh } = state;
  const facts = view.phase === "ready" ? view.facts : null;
  const governor = view.phase === "ready" ? view.governor : null;
  const health = healthView(facts);
  const pill = HEALTH_PILL[health.level];
  const sections = pcSections(facts, governor);
  const shown = compact
    ? sections.filter((s) => s.id === "memory" || s.id === "governor")
    : sections;

  return (
    <HudPanel
      title="This PC, measured now"
      hint={
        view.phase === "ready"
          ? pcSummaryLine(facts, governor)
          : view.phase === "loading"
            ? "measuring…"
            : "everything measured on this PC"
      }
      actions={
        <Button size="sm" variant="outline" disabled={busy} onClick={() => refresh()}>
          <RefreshCw className={cn("size-4", busy && "animate-spin")} /> Refresh PC details
        </Button>
      }
    >
      {view.phase === "loading" ? (
        <LoadingState label="Measuring this PC…" rows={4} />
      ) : view.phase === "offline" ? (
        <EmptyState
          title="PC details appear in the installed FRIDAY app"
          hint="This view reads the real machine, so it has nothing to show in a browser preview."
        />
      ) : view.phase === "error" ? (
        <ErrorState title="This PC could not be read" error={view.message} onRetry={refresh} />
      ) : (
        <div className="space-y-4">
          <div
            className="flex flex-wrap items-start gap-3 rounded-ctl border border-border bg-surface px-3 py-2"
            data-pc-health={health.level}
          >
            <StatusPill label={pill.label} tone={pill.tone} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">{health.title}</p>
              {health.reasons.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {health.reasons.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <div className={cn("grid gap-4", compact ? "md:grid-cols-2" : "lg:grid-cols-2")}>
            {shown.map((section) => (
              <div key={section.id} data-pc-section={section.id}>
                <p className="label-xs mb-2 text-primary">{section.title}</p>
                <Rows rows={section.rows} />
              </div>
            ))}
          </div>
        </div>
      )}
    </HudPanel>
  );
}
