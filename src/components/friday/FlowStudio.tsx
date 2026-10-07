/**
 * FRIDAY · Flow Studio panel.
 *
 * One place to watch, read, and stage a flow. The list is the accessible
 * view of the same graph the canvas draws.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FilterTabs, HudPanel, StatusPill } from "@/components/friday/ui";
import { brain } from "@/lib/friday/brain-engine";
import { FLOW_PAGE_FEATURES, graphForFeature } from "@/lib/friday/flow-adapters";
import { coverageGraph } from "@/lib/friday/flow-coverage";
import {
  applyOption,
  applyOverlay,
  askChart,
  CANVAS_MODES,
  commitDraft,
  companionSnapshot,
  explainTour,
  exportD2,
  exportDot,
  exportJsonCanvas,
  exportLocalTrace,
  exportPdf,
  exportPng,
  importDot,
  importExternal,
  importFlowPack,
  lineageOf,
  optionFields,
  projectMode,
  proposeFinding,
  rollbackDraft,
  runFromHere,
  scrubWithBreaks,
  semanticZoom,
  wiringDoctor,
  type CanvasMode,
  type FlowOverlay,
  type ZoomBand,
} from "@/lib/friday/flow-depth";
import {
  createDraft,
  diffGraphs,
  editDraft,
  explainGraph,
  exportMermaid,
  exportSvg,
  flowHash,
  fromCode,
  importMermaid,
  redoDraft,
  replayRun,
  riskTier,
  toCode,
  undoDraft,
  type FlowDraft,
  type FlowGraph,
} from "@/lib/friday/flow-graph";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import { probeWiringNode, requestWiringSwitch } from "@/lib/friday/wiring";
import { AutonomyDial } from "@/components/friday/AutonomyDial";
import { FlowCanvas } from "@/components/friday/FlowCanvas";
import { FlowCodePane } from "@/components/friday/FlowCodePane";
import {
  canvasDo,
  emptyPlacement,
  type CanvasAction,
  type FlowPlacement,
} from "@/lib/friday/flow-edit";
import { applyWire, makeReal, packInternals, productionHost } from "@/lib/friday/flow-bind";
import { applyModeDraft } from "@/lib/friday/flow-modes";
import { acceptImport } from "@/lib/friday/flow-codec";
import { flowLine } from "@/lib/friday/flow-copy";
import { layoutWithElk } from "@/lib/friday/flow-layout";
import { configureFlowSession } from "@/lib/friday/flow-tools";
import { autonomy } from "@/lib/friday/self/autonomy";
import { flowElements } from "@/lib/friday/flow-render";

function useStudio() {
  return useSyncExternalStore(flowStudio.subscribe, flowStudio.getSnapshot, flowStudio.getSnapshot);
}

export function FlowStudioHost() {
  const studio = useStudio();
  const [mapOn, setMapOn] = useState(false);
  return (
    <Dialog
      open={studio.open}
      onOpenChange={(open) => {
        if (!open) flowStudio.close();
      }}
    >
      <DialogContent className="flex max-h-[92vh] max-w-6xl flex-col gap-3 overflow-y-auto">
        <FlowStudioBody
          key={`${studio.feature}:${studio.boardStamp}:${mapOn}`}
          mapOn={mapOn}
          onMap={setMapOn}
        />
      </DialogContent>
    </Dialog>
  );
}

function FlowStudioBody({ mapOn, onMap }: { mapOn: boolean; onMap: (value: boolean) => void }) {
  const studio = useStudio();
  const base = useMemo(
    () =>
      mapOn || !studio.board
        ? mapOn
          ? coverageGraph()
          : graphForFeature(studio.feature)
        : studio.board,
    [mapOn, studio.feature, studio.board],
  );
  const [draft, setDraft] = useState<FlowDraft>(() => createDraft(base));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState(0);
  const [code, setCode] = useState("");
  const [codeIssue, setCodeIssue] = useState("");
  const [mermaid, setMermaid] = useState("");
  const [switchDetail, setSwitchDetail] = useState("");
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("flowchart");
  const [band, setBand] = useState<ZoomBand>("layer");
  const [overlay, setOverlay] = useState<FlowOverlay | "">("");
  const [breaks, setBreaks] = useState<string[]>([]);
  const [traceOn, setTraceOn] = useState(false);
  const [tour, setTour] = useState("");
  const [findings, setFindings] = useState<string[]>([]);
  const [forgeNote, setForgeNote] = useState("");
  const [placement, setPlacement] = useState<FlowPlacement>(emptyPlacement);
  const [placePast, setPlacePast] = useState<FlowPlacement[]>([]);
  const [sketch, setSketch] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);
  const [pendingImport, setPendingImport] = useState<FlowGraph | null>(null);
  const [inside, setInside] = useState<FlowGraph | null>(null);
  const graph = draft.current;
  const watched = useMemo(() => {
    if (studio.mode !== "watch") return graph;
    const slice = studio.events.slice(0, Math.max(0, cursor));
    const stopped = scrubWithBreaks(graph, slice, studio.generation, breaks);
    return stopped.graph;
  }, [graph, studio.mode, studio.events, studio.generation, cursor, breaks]);
  const live = useMemo(() => {
    if (studio.mode !== "watch") return watched;
    return replayRun(graph, studio.events, studio.generation);
  }, [graph, watched, studio]);
  const shown = useMemo(() => {
    const source = cursor > 0 && studio.mode === "watch" ? watched : live;
    const zoomed = semanticZoom(source, band, selected);
    const projected = projectMode(zoomed, canvasMode);
    return overlay ? applyOverlay(projected, studio.events, overlay) : projected;
  }, [cursor, studio.mode, studio.events, watched, live, band, selected, canvasMode, overlay]);
  const node = shown.nodes.find((item) => item.id === selected) || null;
  const fields = node ? optionFields(node) : [];
  const lineage = node ? lineageOf(shown, node.id) : [];
  const fromHere = node ? runFromHere(graph, node.id) : null;
  const cost = studio.events.some((event) => typeof event.cost === "number")
    ? String(studio.events.reduce((sum, event) => sum + (event.cost || 0), 0))
    : "unknown";
  const phone = companionSnapshot(shown, { authenticated: false });

  function onAction(action: CanvasAction) {
    const settings = autonomy.getSnapshot();
    configureFlowSession({
      graph,
      placement,
      level: settings.approvalLevel,
      halted: settings.halted,
    });
    const result = canvasDo({ graph, placement, past: [], future: [] }, action);
    if (result.issues.length) {
      setCodeIssue(result.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setPlacePast((past) => [...past, placement].slice(-40));
    setPlacement(result.state.placement);
    const next = result.state.graph;
    const edge = next.edges[next.edges.length - 1];
    if (
      (action.type === "connect" || action.type === "reconnect") &&
      edge?.binding?.real &&
      settings.approvalLevel === "full" &&
      !settings.halted
    ) {
      const applied = applyWire({
        binding: edge.binding,
        risk: "write",
        level: settings.approvalLevel,
        halted: settings.halted,
        host: productionHost(),
        actor: "owner",
        why: "Canvas rewire",
        source: "owner",
        approved: true,
        at: placePast.length + 1,
        journal: [],
      });
      setCodeIssue(applied.reason);
    } else if (action.type === "connect" || action.type === "reconnect") {
      setCodeIssue(
        edge?.binding?.real
          ? flowLine("ask")
          : edge?.binding?.reason ||
              "This wire only describes the code. Make it real before it can change FRIDAY.",
      );
    }
    stage(next);
  }

  function stage(next: FlowGraph) {
    const result = editDraft(draft.base.id === next.id ? draft : createDraft(base), next);
    setDraft(result.draft);
    setCodeIssue(result.issues.map((issue) => issue.message).join(" "));
  }

  function download(name: string, bytes: string | Uint8Array, type: string) {
    const copy = new ArrayBuffer(typeof bytes === "string" ? 0 : bytes.byteLength);
    if (typeof bytes !== "string") new Uint8Array(copy).set(bytes);
    const body: BlobPart = typeof bytes === "string" ? bytes : copy;
    const blob = new Blob([body], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-sm font-bold uppercase tracking-[0.16em] text-primary">
          Flow · {shown.title}
        </DialogTitle>
        <DialogDescription>
          Same boxes as the chart. Unknown stays unknown. Replay does not run a step again.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs
          value={studio.view}
          onChange={(view) => flowStudio.setView(view as "graph" | "list" | "code" | "blocks")}
          tabs={[
            { key: "graph", label: "Graph" },
            { key: "list", label: "List" },
            { key: "blocks", label: "Blocks" },
            { key: "code", label: "Code" },
          ]}
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a box"
          className="h-8 max-w-xs font-mono text-xs"
          aria-label="Search flow boxes"
        />
        <StatusPill tone="muted" label={riskTier(shown)} />
        <StatusPill
          tone={shown.trusted ? "accent" : "warning"}
          label={shown.trusted ? "trusted" : "untrusted"}
        />
        {shown.enabled === false ? <StatusPill tone="warning" label="disabled" /> : null}
        <Button size="sm" variant="outline" onClick={() => onMap(!mapOn)}>
          {mapOn ? "Page" : "Full map"}
        </Button>
        <AutonomyDial />
      </div>
      <p className="font-mono text-[10px] text-muted-foreground" aria-label="Flow legend">
        Shapes follow the kind. Solid control, dashed data, dotted event, double approval. Status is
        written on the box.
      </p>
      <FilterTabs
        value={canvasMode}
        onChange={(value) => setCanvasMode(value as CanvasMode)}
        tabs={CANVAS_MODES.map((mode) => ({ key: mode, label: mode }))}
      />
      <FilterTabs
        value={band}
        onChange={(value) => setBand(value as ZoomBand)}
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "layer", label: "Layer" },
          { key: "node", label: "Node" },
          { key: "internals", label: "Ports" },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        {(["latency", "cost", "errors", "privacy", "risk", "usage"] as FlowOverlay[]).map(
          (item) => (
            <Button
              key={item}
              size="sm"
              variant="outline"
              onClick={() => setOverlay((current) => (current === item ? "" : item))}
            >
              {overlay === item ? `${item} on` : item}
            </Button>
          ),
        )}
      </div>
      {studio.mode === "watch" ? (
        <HudPanel
          title="Live run"
          hint="Cancel uses the existing stop. Step only moves the recording."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => brain.stop()}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCursor((value) => Math.min(studio.events.length, value + 1))}
            >
              Step
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCursor(studio.events.length)}>
              Live
            </Button>
            <Button size="sm" variant="outline" onClick={() => flowStudio.clearEvents()}>
              Delete recording
            </Button>
            <label className="font-mono text-[11px] text-muted-foreground">
              scrub
              <input
                className="ml-2 align-middle"
                type="range"
                min={0}
                max={Math.max(studio.events.length, 0)}
                value={cursor}
                aria-label="Replay scrubber"
                onChange={(event) => setCursor(Number(event.target.value))}
              />
            </label>
            <span className="font-mono text-[11px] text-muted-foreground">cost {cost}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSpeed((value) => (value === 1 ? 2 : 1))}
            >
              {speed}x
            </Button>
          </div>
        </HudPanel>
      ) : null}
      {studio.view === "graph" ? (
        <FlowCanvas
          graph={shown}
          placement={placement}
          query={query}
          selectedId={selected}
          highlight={lineage}
          live={studio.mode === "watch" && cursor === 0}
          events={studio.events}
          sketch={sketch}
          contrast={contrast}
          onSelect={setSelected}
          onPick={(ids) =>
            setPicked((current) =>
              current.length === ids.length && current.every((id, index) => id === ids[index])
                ? current
                : ids,
            )
          }
          onAction={onAction}
        />
      ) : null}
      {studio.view === "list" ? (
        <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="Flow boxes">
          {flowElements(shown, query)
            .nodes.filter((item) => !item.hidden)
            .map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full rounded-md border border-border bg-card px-2 py-1 text-left text-xs text-foreground"
                  onClick={() => setSelected(item.id)}
                >
                  {item.data.label} · {item.data.status} · {item.data.risk}
                  {item.data.locked ? " · locked" : ""}
                  {item.data.detail ? ` · ${item.data.detail.slice(0, 80)}` : ""}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
      {studio.view === "blocks" ? (
        <ul className="max-h-80 space-y-2 overflow-y-auto" aria-label="Flow blocks">
          {shown.nodes.map((item) => (
            <li
              key={item.id}
              className="flow-box rounded-md border border-border bg-card p-2 text-xs"
            >
              <p>{item.label}</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {item.kind} · in{" "}
                {item.ports
                  .filter((port) => port.direction === "in")
                  .map((port) => port.type)
                  .join(", ") || "any"}{" "}
                · out{" "}
                {item.ports
                  .filter((port) => port.direction === "out")
                  .map((port) => port.type)
                  .join(", ") || "any"}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {studio.view === "code" ? (
        <div className="grid gap-1">
          <FlowCodePane
            value={code || toCode(shown)}
            onIssue={setCodeIssue}
            onValid={(text) => {
              setCode(text);
              const parsed = fromCode(text);
              if (!parsed.graph || parsed.issues.length) {
                setCodeIssue(
                  parsed.issues.map((issue) => issue.message).join(" ") || "Invalid graph.",
                );
                return;
              }
              setCodeIssue("");
              stage(parsed.graph);
            }}
          />
          {codeIssue ? (
            <span className="font-mono text-[11px] text-muted-foreground">{codeIssue}</span>
          ) : null}
        </div>
      ) : null}
      {node ? (
        <HudPanel title={node.label} hint={node.module || "unwired"}>
          <p className="text-xs text-muted-foreground">{node.detail || "unknown"}</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {node.status} · {node.risk} · lineage {lineage.join(", ") || "none"} · ports{" "}
            {node.ports.map((port) => `${port.direction}:${port.type}`).join(", ")}
          </p>
          {shown.edges
            .filter(
              (edge) =>
                edge.binding?.bindable === false &&
                edge.binding.reason &&
                (edge.source === node.id || edge.target === node.id),
            )
            .slice(0, 3)
            .map((edge) => (
              <p key={edge.id} className="mt-1 font-mono text-[11px] text-muted-foreground">
                {edge.binding?.reason}
              </p>
            ))}
          {fields.map((field) => (
            <label
              key={field.key}
              className="mt-1 grid font-mono text-[11px] text-muted-foreground"
            >
              {field.label}
              <input
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
                aria-label={field.label}
                value={field.value}
                onChange={(event) => {
                  const next = applyOption(graph, node.id, field.key, event.target.value);
                  setCodeIssue(next.issues.map((issue) => issue.message).join(" "));
                  if (!next.issues.length) stage(next.graph);
                }}
              />
              <span>{field.help}</span>
            </label>
          ))}
          {fromHere ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              Run from here stays a dry run
              {fromHere.needsApproval
                ? " and waits for approval before a write or exec."
                : "."}{" "}
              {fromHere.steps.length} steps. Nothing was executed.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setBreaks((current) =>
                  current.includes(node.id)
                    ? current.filter((id) => id !== node.id)
                    : [...current, node.id],
                )
              }
            >
              {breaks.includes(node.id) ? "Breakpoint on" : "Breakpoint"}
            </Button>
            {shown.trusted === false ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void import("@/lib/friday/flow-diagram").then(
                    async ({ buildFromDiagram, diagramBlocksBuild }) => {
                      const blocked = diagramBlocksBuild(shown);
                      if (blocked) {
                        setForgeNote(blocked);
                        return;
                      }
                      const { forgeWorkflow } = await import("@/lib/friday/brain/workflow-forge");
                      const result = await buildFromDiagram(shown, {
                        forge: async (goal) => {
                          const run = await forgeWorkflow(goal);
                          return {
                            stage: run.stage,
                            ...(run.error ? { error: run.error } : {}),
                            log: run.log,
                          };
                        },
                      });
                      setForgeNote(`${result.stage}. ${result.reason}`);
                    },
                  );
                }}
              >
                Build this diagram
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void import("@/lib/friday/brain/workflow-forge").then(async ({ forgeWorkflow }) => {
                  const run = await forgeWorkflow(`Draw a step named ${node.label}`);
                  const forged = makeReal(
                    { kind: "descriptive", ref: node.id, value: node.label, real: false },
                    { stage: run.stage, ok: run.stage === "done" && !run.error },
                  );
                  setForgeNote(
                    `${forged.reason} ${run.stage}${run.error ? `: ${run.error}` : ""}. A step stays disabled until you enable it.`,
                  );
                });
              }}
            >
              Code this step
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setInside(
                  packInternals({
                    id: node.id,
                    kind: node.kind,
                    name: node.label,
                    ...(node.module ? { file: node.module } : {}),
                  }),
                )
              }
            >
              Open internals
            </Button>
          </div>
          {forgeNote ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{forgeNote}</p>
          ) : null}
          {node.locked ? (
            <p className="mt-2 text-xs text-foreground">Locked. No switch.</p>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSwitchDetail(requestWiringSwitch(node.id, true).detail)}
              >
                Allow
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSwitchDetail(requestWiringSwitch(node.id, false).detail)}
              >
                Reject
              </Button>
            </div>
          )}
          {switchDetail ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{switchDetail}</p>
          ) : null}
          {probeWiringNode(node.id)?.status ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              probe {probeWiringNode(node.id)?.state} · {probeWiringNode(node.id)?.status}
            </p>
          ) : (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">probe unknown</p>
          )}
        </HudPanel>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setMermaid(exportMermaid(shown))}>
          Mermaid
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMermaid(exportDot(shown))}>
          DOT
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMermaid(exportD2(shown))}>
          D2
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMermaid(exportJsonCanvas(shown))}>
          JSON Canvas
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download("friday-flow.svg", exportSvg(shown), "image/svg+xml")}
        >
          SVG
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void exportPdf(shown).then((bytes) =>
              download("friday-flow.pdf", bytes, "application/pdf"),
            );
          }}
        >
          PDF
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download("friday-flow.png", exportPng(shown), "image/png")}
        >
          PNG
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const previous = placePast[placePast.length - 1];
            if (previous) {
              setPlacement(previous);
              setPlacePast((past) => past.slice(0, -1));
            }
            setDraft(undoDraft(draft));
          }}
        >
          Undo
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAction({ type: "tidy" })}>
          Tidy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void layoutWithElk(shown).then((laid) => {
              onAction({
                type: "layout",
                positions: Object.fromEntries(laid.positions.map((item) => [item.id, item])),
              });
            });
          }}
        >
          Auto-layout
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSketch((value) => !value)}>
          {sketch ? "Sketch on" : "Sketch"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setContrast((value) => !value)}>
          {contrast ? "Contrast on" : "Contrast"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => flowStudio.showWork()}>
          Show work
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAction({ type: "align", ids: picked, axis: "x" })}
        >
          Align
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAction({ type: "distribute", ids: picked, axis: "x" })}
        >
          Distribute
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onAction({
              type: "group",
              id: "lane",
              title: "Lane",
              nodeIds: picked.length ? picked : [selected].filter(Boolean),
            })
          }
        >
          Group
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onAction({
              type: "duplicate",
              ids: picked.length ? picked : [selected].filter(Boolean),
            })
          }
        >
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => flowStudio.setRetention(flowStudio.retention() === 200 ? 40 : 200)}
        >
          Keep {flowStudio.retention()}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDraft(redoDraft(draft))}>
          Redo
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDraft(rollbackDraft(draft))}>
          Roll back
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const result = commitDraft(draft, true);
            setDraft(result.draft);
            const current = result.draft.current;
            if (current.id === "chat-turn" || current.id === "voice-auto") {
              const settings = autonomy.getSnapshot();
              const applied = applyModeDraft({
                graph: current,
                level: settings.approvalLevel,
                halted: settings.halted,
                host: productionHost(),
                at: result.draft.past.length + 1,
                journal: [],
                approved: settings.approvalLevel === "full",
              });
              setCodeIssue(applied.reason);
              return;
            }
            setCodeIssue(result.reason);
          }}
        >
          Apply draft
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const rows = wiringDoctor({
              graph: shown,
              routes: Object.keys(FLOW_PAGE_FEATURES),
              features: FLOW_PAGE_FEATURES,
            });
            setFindings(
              rows.map(
                (row) => `${row.severity} ${row.message}. ${proposeFinding(row).steps[0] || ""}`,
              ),
            );
          }}
        >
          Wiring check
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTour(explainTour(shown, "english").slice(0, 6).join(" "))}
        >
          How this works
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTour(askChart(shown, "explain this flow"))}
        >
          Ask the chart
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const line = explainTour(shown, "english")[0] || "";
            const api = window.friday as
              { speakNeural?: (payload: { text: string }) => Promise<unknown> } | undefined;
            if (!api?.speakNeural) {
              setTour(
                line
                  ? `${line} Speech is not available in this window.`
                  : "Speech is not available in this window.",
              );
              return;
            }
            void api.speakNeural({ text: line });
            setTour(line);
          }}
        >
          Speak
        </Button>
        <label className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={traceOn}
            aria-label="Local trace export"
            onChange={(event) => setTraceOn(event.target.checked)}
          />
          Local trace
        </label>
        {traceOn ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMermaid(exportLocalTrace(studio.events, true) || "")}
          >
            Save trace
          </Button>
        ) : null}
      </div>
      {tour ? <p className="font-mono text-[11px] text-muted-foreground">{tour}</p> : null}
      {findings.length ? (
        <ul
          className="max-h-24 overflow-y-auto font-mono text-[11px] text-muted-foreground"
          aria-label="Wiring findings"
        >
          {findings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p className="font-mono text-[11px] text-muted-foreground">
        Phone snapshot: {phone.reason}. Mutations {phone.mutations ? "on" : "off"}.
      </p>
      {mermaid ? (
        <textarea
          className="h-24 rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground"
          readOnly
          value={mermaid}
          aria-label="Flow export"
        />
      ) : null}
      <label className="grid gap-1 font-mono text-[11px] text-muted-foreground">
        Import Mermaid, DOT, or a pack (stays off until you accept it)
        <textarea
          className="h-20 rounded-md border border-border bg-background p-2 text-foreground"
          value=""
          placeholder="flowchart, digraph, or JSON"
          onChange={(event) => {
            const text = event.target.value;
            if (text.trim().startsWith("digraph")) {
              const imported = importDot(text);
              setCodeIssue(imported.issues.map((issue) => issue.message).join(" "));
              if (imported.graph.nodes.length) setPendingImport(imported.graph);
              return;
            }
            if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
              const packed = importFlowPack(text, flowHash(text));
              const external = packed.graph.nodes.length ? packed : importExternal("n8n", text);
              setCodeIssue(external.issues.map((issue) => issue.message).join(" "));
              if (external.graph.nodes.length) setPendingImport(external.graph);
              return;
            }
            const imported = importMermaid(text);
            setCodeIssue(imported.issues.map((issue) => issue.message).join(" "));
            if (
              imported.graph.nodes.length &&
              !imported.issues.some((issue) => issue.code === "untrusted")
            ) {
              setPendingImport(imported.graph);
            }
          }}
        />
      </label>
      {pendingImport ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[11px] text-muted-foreground">
            Import is off. {pendingImport.nodes.length} boxes. Accept to place it on the canvas.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(createDraft(acceptImport(pendingImport)));
              setPendingImport(null);
            }}
          >
            Accept import
          </Button>
        </div>
      ) : null}
      {inside ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          Internals: {inside.title}. {inside.nodes.length} boxes. {inside.edges.length} wires.
        </p>
      ) : null}
      <p className="flow-legend font-mono text-[11px] text-muted-foreground">
        <span>
          <i data-kind="trigger" /> trigger
        </span>
        <span>
          <i data-kind="model" /> model
        </span>
        <span>
          <i data-kind="skill" /> skill
        </span>
        <span>
          <i data-kind="tool" /> tool
        </span>
        <span>
          <i data-kind="approval" /> approval
        </span>
        <span>solid control · dashed data · dotted event · double approval</span>
        <span>
          {flowLine("legend")} {flowLine("legend", "hi")}
        </span>
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {explainGraph(shown, "explain this flow").split("\n").slice(0, 4).join(" ")}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        diff {JSON.stringify(diffGraphs(draft.base, graph))}
      </p>
    </>
  );
}
