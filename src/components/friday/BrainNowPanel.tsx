/**
 * FRIDAY · what the Brain is doing now
 *
 * The last turn in plain terms: the route she took and how hard a steerable model was asked to think,
 * which models were chosen and why, what the ask required and whether the answer kept it, how many
 * sources and tools were used, then the live task graph (with its parallel groups), the approval
 * queue and the learning counts. It shows steps and reasons, never a model's hidden reasoning, and it
 * reads only what the app already holds in memory.
 */
import { useSyncExternalStore } from "react";
import { EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { coreBrain } from "@/lib/friday/brain/core-brain";
import { useGovernance, useTaskGraph } from "@/lib/friday/self/use-self";
import { memory } from "@/lib/friday/self/memory-engine";
import { modelRegistry } from "@/lib/friday/brain/model-registry";

const LIVE = new Set(["running", "queued", "paused", "interrupted"]);

export function BrainNowPanel() {
  useSyncExternalStore(coreBrain.subscribe, coreBrain.getSnapshot, coreBrain.getSnapshot);
  const turn = coreBrain.lastTurn();
  const graphs = useTaskGraph().graphs.filter((graph) => LIVE.has(graph.state));
  const governance = useGovernance();
  const pending = governance.pending.length;
  const names = new Map(modelRegistry.list().map((record) => [record.id, record.name]));

  return (
    <HudPanel title="Brain now" hint="last turn · steps and reasons, not hidden thinking">
      <div className="grid gap-3">
        {!turn ? (
          <EmptyState
            title="No turn yet"
            hint="Ask anything and this shows the route she took, the model she chose and why, what the ask required and whether the answer kept it."
          />
        ) : (
          <div className="grid gap-1.5">
            <p className="break-words text-sm text-foreground">{turn.prompt}</p>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={turn.route} tone="accent" />
              <StatusPill label={`thinking ${turn.effort}`} tone="muted" />
              <StatusPill
                label={
                  turn.verified === null
                    ? "not checked yet"
                    : turn.verified
                      ? "checked"
                      : "check failed"
                }
                tone={turn.verified === null ? "muted" : turn.verified ? "accent" : "warning"}
              />
              {turn.sources ? (
                <StatusPill label={`${turn.sources} source(s)`} tone="muted" />
              ) : null}
            </div>
            <p className="break-words text-data text-muted-foreground">
              Models:{" "}
              {turn.models.length
                ? turn.models.map((id) => names.get(id) ?? id).join(", ")
                : "none chosen"}{" "}
              · {turn.routing}
            </p>
            {turn.checked.length ? (
              <p className="text-data text-muted-foreground">Checked: {turn.checked.join(", ")}</p>
            ) : null}
            {turn.issues.length ? (
              <p className="break-words text-data text-warning">Issues: {turn.issues.join("; ")}</p>
            ) : null}
            {turn.tools.length ? (
              <p className="text-data text-muted-foreground">Tools: {turn.tools.join(", ")}</p>
            ) : null}
          </div>
        )}

        <div className="grid gap-1">
          <h3 className="text-meta uppercase tracking-wider text-muted-foreground">
            Tasks running
          </h3>
          {graphs.length === 0 ? (
            <p className="text-data text-muted-foreground">Nothing is running in the background.</p>
          ) : (
            <ul className="grid gap-1">
              {graphs.slice(0, 5).map((graph) => (
                <li key={graph.id} className="text-data text-muted-foreground">
                  <span className="text-foreground">{graph.request.slice(0, 80)}</span> ·{" "}
                  {graph.state} ·{" "}
                  {graph.nodes.filter((node) => ["done", "verified"].includes(node.state)).length}/
                  {graph.nodes.length} step(s)
                  {graph.nodes.some((node) => node.parts?.length) ? " · pieces run together" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-data text-muted-foreground">
          Waiting for your approval: {pending} · Memory records: {memory.getSnapshot().items.length}{" "}
          · Turns: {coreBrain.getSnapshot().turns}
        </p>
      </div>
    </HudPanel>
  );
}
