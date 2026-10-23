/**
 * FRIDAY · Connectivity panel
 *
 * Shows how much of FRIDAY is actually wired together right now — derived from
 * real files by the main process, never a hand-maintained list. It also links
 * the System page, which had no entry point anywhere in the UI.
 */
import { Link } from "@tanstack/react-router";
import { Cable, MonitorCog, RefreshCw } from "lucide-react";
import { HudPanel, MetricBar, StatusPill } from "@/components/friday/ui";
import { connectedPercent, connectivity, useConnectivity } from "@/lib/friday/connectivity";

export function ConnectivityPanel() {
  const { graph, bridge, loading, error } = useConnectivity();
  const percent = connectedPercent(graph);
  const issues = graph?.issues ?? [];
  // The installed app carries routes and kernel sources compiled or packed;
  // a 0/0 there would read as broken wiring.
  const compiled = graph?.summary.sourceAvailable === false;

  return (
    <HudPanel
      title="Connections"
      hint={bridge === "desktop" ? `${percent}% wired` : "desktop only"}
      actions={
        <div className="flex items-center gap-2">
          <Link
            to="/system"
            className="inline-flex items-center gap-1 rounded-surface border border-border/60 px-2 py-1 text-note text-muted-foreground transition-colors hover:text-foreground"
          >
            <MonitorCog className="size-3" /> System
          </Link>
          <button
            type="button"
            onClick={() => void connectivity.refresh()}
            disabled={bridge !== "desktop" || loading}
            className="inline-flex items-center gap-1 rounded-surface border border-border/60 px-2 py-1 text-note text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} /> Rescan
          </button>
        </div>
      }
    >
      {bridge !== "desktop" ? (
        <p className="text-xs text-muted-foreground">
          The wiring graph is computed by the desktop app — open FRIDAY on Windows to see it.
        </p>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : !graph ? (
        <p className="text-xs text-muted-foreground">Scanning project wiring…</p>
      ) : (
        <div className="space-y-3">
          <MetricBar label="Overall wiring" value={percent} />
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "IPC", value: `${graph.summary.ipc}`, sub: "handlers bridged" },
              {
                label: "Kernel",
                value: compiled
                  ? "in bundle"
                  : `${graph.summary.kernelCalled}/${graph.summary.kernelMethods}`,
                sub: "methods in use",
              },
              {
                label: "Pages",
                value: compiled
                  ? "in bundle"
                  : `${graph.summary.navEntries}/${graph.summary.pages}`,
                sub: "reachable",
              },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-border/50 bg-card/40 p-2">
                <div className="font-mono text-sm text-foreground">{c.value}</div>
                <div className="text-note text-muted-foreground">{c.label}</div>
                <div className="text-note-sm text-muted-foreground/70">{c.sub}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cable className="size-3.5" />
            {issues.length ? (
              <StatusPill label={`${issues.length} to review`} tone="warning" />
            ) : (
              <StatusPill label="fully connected" tone="accent" />
            )}
            <span className="ml-auto text-meta">
              {new Date(graph.at).toLocaleTimeString([], { hour12: false })}
            </span>
          </div>
          {issues.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-auto text-note">
              {issues.slice(0, 12).map((issue) => (
                <li key={`${issue.kind}:${issue.id}`} className="flex items-start gap-2">
                  <span
                    className={
                      issue.severity === "error"
                        ? "mt-1 size-1.5 shrink-0 rounded-full bg-destructive"
                        : "mt-1 size-1.5 shrink-0 rounded-full bg-primary"
                    }
                  />
                  <span className="font-mono text-muted-foreground">{issue.id}</span>
                  <span className="text-muted-foreground/80">{issue.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </HudPanel>
  );
}
