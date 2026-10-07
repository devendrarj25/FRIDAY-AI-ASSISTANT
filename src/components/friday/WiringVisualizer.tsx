/**
 * FRIDAY · live wiring visualizer
 *
 * Renders FLOW_CHART layers with each node's real probe. Switches go through
 * the existing governance Allow/Reject controls. Locked nodes never render
 * a toggle.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { useGovernance } from "@/lib/friday/self/use-self";
import { governance } from "@/lib/friday/self/governance";
import {
  probeWiring,
  requestWiringSwitch,
  wiringPanel,
  type WiringHealth,
  type WiringReport,
} from "@/lib/friday/wiring";
import { flowStudio } from "@/lib/friday/flow-studio-store";

function useWiringPanel() {
  return useSyncExternalStore(
    wiringPanel.subscribe,
    wiringPanel.getSnapshot,
    wiringPanel.getSnapshot,
  );
}

function healthTone(state: WiringHealth): "accent" | "muted" | "destructive" {
  if (state === "working") return "accent";
  if (state === "error") return "destructive";
  return "muted";
}

export function WiringVisualizerHost() {
  const panel = useWiringPanel();
  const gov = useGovernance();
  const [report, setReport] = useState<WiringReport | null>(null);

  useEffect(() => {
    if (!panel.open) return;
    const tick = () => setReport(probeWiring());
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [panel.open, gov.lastChangeAt, panel.lastResult?.at]);

  const pending = useMemo(
    () => gov.pending.filter((item) => item.title.startsWith("Wiring:")),
    [gov.pending],
  );

  const layers = useMemo(() => {
    if (!report) return [];
    const order: Array<{ id: string; title: string; nodes: typeof report.nodes }> = [];
    for (const node of report.nodes) {
      const existing = order.find((layer) => layer.id === node.layer);
      if (existing) existing.nodes.push(node);
      else order.push({ id: node.layer, title: node.layerTitle, nodes: [node] });
    }
    return order;
  }, [report]);

  return (
    <Dialog
      open={panel.open}
      onOpenChange={(open) => (open ? wiringPanel.open() : wiringPanel.close())}
    >
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-4 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="font-display text-sm font-bold uppercase tracking-[0.16em] text-primary">
            System wiring
          </DialogTitle>
          <DialogDescription>
            Live probe of every FLOW_CHART box against its real module. Permission, privacy,
            governance, billing, and tool-authority are locked — status only, no switch.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => flowStudio.open("master", "chart")}>
            Graph
          </Button>
          <Button size="sm" variant="outline" onClick={() => flowStudio.open("master", "watch")}>
            Watch
          </Button>
        </div>

        {panel.lastResult ? (
          <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 font-mono text-[11px] text-foreground">
            Last switch: {panel.lastResult.stage} — {panel.lastResult.detail}
          </p>
        ) : null}

        {pending.length ? (
          <HudPanel title="Waiting approval" hint={`${pending.length} wiring change(s)`}>
            <div className="grid gap-2">
              {pending.map((item) => (
                <div key={item.id} className="rounded-md border border-border/60 bg-card/40 p-3">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.rationale}</p>
                  {item.dryRun ? (
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      dry-run · {item.dryRun.detail}
                    </p>
                  ) : null}
                  {item.stage === "waiting-approval" ? (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => governance.approve(item.id)}>
                        Allow
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => governance.reject(item.id)}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </HudPanel>
        ) : null}

        <div className="flex max-h-[min(70vh,44rem)] min-h-[20rem] flex-col gap-3 overflow-y-auto pr-1">
          {layers.map((layer) => (
            <HudPanel
              key={layer.id}
              title={layer.title}
              hint={`${layer.nodes.length} nodes`}
              className="shrink-0"
              bodyClassName="grid gap-2 p-3"
            >
              {layer.nodes.map((node) => (
                <div
                  key={node.id}
                  className="grid gap-1 rounded-md border border-border/60 bg-card/30 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-foreground">{node.label}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusPill label={node.state} tone={healthTone(node.state)} />
                      {node.locked ? <StatusPill label="locked" tone="warning" /> : null}
                    </div>
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground">{node.module}</p>
                  <p className="text-xs text-muted-foreground">{node.status}</p>
                  {node.switchable ? (
                    <ToggleRow
                      label={`${node.label} path`}
                      hint="Goes through owner approval, then re-probes this node"
                      on={Boolean(node.switchOn)}
                      onToggle={() => {
                        requestWiringSwitch(node.id, !node.switchOn);
                      }}
                    />
                  ) : null}
                </div>
              ))}
            </HudPanel>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
