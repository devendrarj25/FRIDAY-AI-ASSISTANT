/**
 * FRIDAY · Workflow Visual Builder
 *
 * React Flow canvas over the existing workflow.json step chain. Nodes are the
 * pack's real steps (skill / tool / agent / module / connector / note). Edges
 * are sequential order — the same `steps[]` WorkflowEngine / runWorkflowPack
 * already execute. Saves go through saveWorkflowPack → installPack(); write/exec
 * steps keep the same owner-approval + dry-run gate. This is not a second
 * workflow engine or schema.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, Loader2, Play, Plug, Plus, Puzzle, Sparkles, StickyNote, Wrench } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterTabs, HudPanel, StatusPill, toneForStatus } from "@/components/friday/ui";
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import {
  capabilityRegistry,
  type CapabilityResource,
} from "@/lib/friday/brain/capability-registry";
import {
  blankWorkflowDraft,
  listWorkflowStepCatalog,
  runWorkflowPack,
  saveWorkflowPack,
  type WorkflowDraft,
  type WorkflowRunResult,
  type WorkflowStep,
  type WorkflowStepCatalogEntry,
  type WorkflowStepKind,
} from "@/lib/friday/brain/workflow-forge";
import { toast } from "sonner";

export const Route = createFileRoute("/workflow-visual")({
  head: () => ({
    meta: [
      { title: "Visual Builder — FRIDAY Console" },
      {
        name: "description",
        content:
          "Node graph of installed FRIDAY workflow.json packs. Edits save through the existing installPack path.",
      },
    ],
  }),
  component: WorkflowVisualRoute,
});

const STEP_KINDS: WorkflowStepKind[] = ["skill", "tool", "agent", "module", "connector", "note"];

const KIND_ICON = {
  skill: Sparkles,
  tool: Wrench,
  agent: Bot,
  module: Puzzle,
  connector: Plug,
  note: StickyNote,
} as const;

export type VisualPack = {
  id: string;
  name: string;
  category: string;
  schedule: string;
  summary: string;
  risk: string;
  origin: "app" | "workspace" | "";
  steps: Array<{
    id: string;
    label: string;
    kind: string;
    ref: string;
    risk: string;
  }>;
};

export type StepNodeData = Record<string, unknown> & {
  label: string;
  kind: WorkflowStepKind;
  ref: string;
  risk: "safe" | "write" | "exec";
  catalogName: string;
  health: string;
  agentWorkflows: string;
  runLabel: string;
};

function asKind(value: string): WorkflowStepKind {
  return STEP_KINDS.includes(value as WorkflowStepKind) ? (value as WorkflowStepKind) : "note";
}

function asRisk(value: string): "safe" | "write" | "exec" {
  return value === "write" || value === "exec" ? value : "safe";
}

export function asWorkflowStep(
  step: {
    id?: string;
    label: string;
    kind: string;
    ref: string;
    risk: string;
  },
  index: number,
): WorkflowStep {
  return {
    id: step.id || `s${index + 1}`,
    label: step.label,
    kind: asKind(step.kind),
    ref: step.ref,
    risk: asRisk(step.risk),
  };
}

export function catalogToStep(entry: WorkflowStepCatalogEntry, index: number): WorkflowStep {
  const n = index + 1;
  return {
    id: `s${n}`,
    label: entry.name,
    kind: entry.kind,
    ref: entry.kind === "note" ? `note-${n}` : entry.id,
    risk: entry.risk,
  };
}

export function packToDraft(pack: VisualPack): WorkflowDraft {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.summary,
    category: pack.category || "saved",
    schedule: pack.schedule || "on demand",
    steps: (pack.steps.length ? pack.steps : blankWorkflowDraft().steps).map(asWorkflowStep),
    risk: asRisk(pack.risk),
  };
}

export function riskTone(risk: string): "accent" | "warning" | "destructive" | "muted" {
  if (risk === "exec") return "destructive";
  if (risk === "write") return "warning";
  if (risk === "safe") return "accent";
  return "muted";
}

function lookupResource(
  step: WorkflowStep,
  resources: CapabilityResource[],
): CapabilityResource | undefined {
  const kind = step.kind === "connector" ? "tool" : step.kind;
  const ref = step.ref.toLowerCase();
  const tail = ref.split("/").pop() || ref;
  return resources.find((item) => {
    if (step.kind !== "note" && item.type !== kind && item.type !== "workflow") return false;
    const itemRef = item.ref.toLowerCase();
    const itemId = item.id.toLowerCase();
    return (
      itemRef === ref ||
      itemId === ref ||
      itemId.endsWith(`/${tail}`) ||
      itemRef.endsWith(`/${tail}`) ||
      itemRef === tail ||
      item.name.toLowerCase() === step.label.toLowerCase()
    );
  });
}

export function stepDisplay(
  step: WorkflowStep,
  catalog: WorkflowStepCatalogEntry[],
  resources: CapabilityResource[],
  run?: WorkflowRunResult | null,
): Pick<StepNodeData, "catalogName" | "health" | "agentWorkflows" | "runLabel"> {
  const entry = catalog.find(
    (item) => item.id === step.ref || item.id.endsWith(`/${step.ref}`) || item.name === step.label,
  );
  const resource = lookupResource(step, resources);
  const result = run?.steps.find((item) => item.id === step.id);
  let runLabel = "";
  if (result?.skipped) runLabel = "dry-run skip";
  else if (result) runLabel = result.ok ? "ok" : "failed";
  return {
    catalogName: resource?.name || entry?.name || step.label,
    health: resource?.health || "",
    agentWorkflows: (resource?.workflows || []).join(", "),
    runLabel,
  };
}

export function sequentialEdges(steps: WorkflowStep[]): Edge[] {
  return steps.slice(1).map((step, index) => ({
    id: `e-${steps[index]!.id}-${step.id}`,
    source: steps[index]!.id,
    target: step.id,
  }));
}

export function stepsToFlow(
  steps: WorkflowStep[],
  catalog: WorkflowStepCatalogEntry[] = [],
  resources: CapabilityResource[] = [],
  run?: WorkflowRunResult | null,
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const nodes: Node<StepNodeData>[] = steps.map((step, index) => ({
    id: step.id,
    type: step.kind,
    position: { x: 48, y: 24 + index * 132 },
    data: {
      label: step.label,
      kind: step.kind,
      ref: step.ref,
      risk: step.risk,
      ...stepDisplay(step, catalog, resources, run),
    },
  }));
  const branched = steps.some((step) => step.when || step.parallel);
  return { nodes, edges: branched ? branchEdges(steps) : sequentialEdges(steps) };
}

/** Same step ids. A condition or parallel group is still one steps[] entry. */
export function branchEdges(steps: WorkflowStep[]): Edge[] {
  return steps.slice(1).map((step, index) => ({
    id: `e-${steps[index]!.id}-${step.id}`,
    source: steps[index]!.id,
    target: step.id,
    label: step.when || (step.parallel ? `parallel:${step.parallel}` : ""),
  }));
}

export function orderStepsFromGraph(
  steps: WorkflowStep[],
  nodes: Array<{ id: string; position: { x: number; y: number } }>,
  edges: Array<{ source: string; target: string }>,
): WorkflowStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const nodeIds = nodes.map((node) => node.id).filter((id) => byId.has(id));
  const yOf = (id: string) => nodes.find((node) => node.id === id)?.position.y ?? 0;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) incoming.set(id, 0);
  let linked = false;
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    linked = true;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  }
  if (!linked) {
    return [...nodeIds]
      .sort((a, b) => yOf(a) - yOf(b) || a.localeCompare(b))
      .map((id) => byId.get(id)!)
      .filter(Boolean);
  }
  const starts = nodeIds
    .filter((id) => (incoming.get(id) || 0) === 0)
    .sort((a, b) => yOf(a) - yOf(b));
  const ordered: WorkflowStep[] = [];
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (step) ordered.push(step);
    for (const next of outgoing.get(id) || []) {
      incoming.set(next, Math.max(0, (incoming.get(next) || 1) - 1));
      if ((incoming.get(next) || 0) === 0 && !seen.has(next)) queue.unshift(next);
    }
  }
  for (const id of [...nodeIds].sort((a, b) => yOf(a) - yOf(b))) {
    if (seen.has(id)) continue;
    const step = byId.get(id);
    if (step) ordered.push(step);
  }
  return ordered;
}

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const Icon = KIND_ICON[data.kind] ?? StickyNote;
  return (
    <div
      className="min-w-[16rem] max-w-[22rem] rounded-sm border border-primary/40 bg-surface px-2 py-2 shadow-none"
      data-kind={data.kind}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !bg-primary" />
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-[11px] text-primary">{data.label}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {data.catalogName !== data.label ? `${data.catalogName} · ` : ""}
            {data.ref || "—"}
          </p>
          <div className="flex flex-wrap gap-1">
            <StatusPill label={data.kind} tone="primary" />
            <StatusPill label={data.risk} tone={riskTone(data.risk)} />
            {data.health ? (
              <StatusPill label={data.health} tone={toneForStatus(data.health)} />
            ) : null}
            {data.runLabel ? (
              <StatusPill label={data.runLabel} tone={toneForStatus(data.runLabel)} />
            ) : null}
          </div>
          {data.agentWorkflows ? (
            <p className="font-mono text-[10px] text-muted-foreground">
              agent chain · {data.agentWorkflows}
            </p>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!size-2 !bg-primary" />
    </div>
  );
}

const EMPTY_STEPS: WorkflowStep[] = [];

const nodeTypes: NodeTypes = {
  skill: StepNode,
  tool: StepNode,
  agent: StepNode,
  module: StepNode,
  connector: StepNode,
  note: StepNode,
};

function itemToPack(item: CapabilityItem): VisualPack {
  return {
    id: item.id,
    name: item.name,
    category: item.category || item.segment || "saved",
    schedule: item.schedule || "on demand",
    summary: item.summary || item.description || "",
    risk: item.risk,
    origin: item.origin,
    steps: (item.steps || []).map((step, index) => ({
      id: step.id || `s${index + 1}`,
      label: step.label,
      kind: step.kind,
      ref: step.ref,
      risk: step.risk,
    })),
  };
}

export function WorkflowVisualBuilder({
  packs: injectedPacks,
  catalog: injectedCatalog,
  selectedId,
  onSelect,
  onSaved,
}: {
  packs?: VisualPack[];
  catalog?: WorkflowStepCatalogEntry[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onSaved?: (id?: string) => Promise<void> | void;
} = {}) {
  const { supported, items, refresh } = useCapabilities("workflows");
  const livePacks = useMemo(
    () => (injectedPacks ? injectedPacks : items.map(itemToPack)),
    [injectedPacks, items],
  );
  const [catalog, setCatalog] = useState<WorkflowStepCatalogEntry[]>(injectedCatalog ?? []);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [watchConsent, setWatchConsent] = useState(false);
  const [log, setLog] = useState("");
  const [run, setRun] = useState<WorkflowRunResult | null>(null);
  const snapshot = useSyncExternalStore(
    capabilityRegistry.subscribe,
    capabilityRegistry.getSnapshot,
    capabilityRegistry.getSnapshot,
  );
  const resources = snapshot.resources;

  const catalogSource = injectedCatalog ?? null;
  const [seenCatalog, setSeenCatalog] = useState(catalogSource);
  if (catalogSource && seenCatalog !== catalogSource) {
    setSeenCatalog(catalogSource);
    setCatalog(catalogSource);
  }
  useEffect(() => {
    if (injectedCatalog) return;
    return deferEffect(() => {
      void listWorkflowStepCatalog()
        .then(setCatalog)
        .catch(() => setCatalog([]));
    });
  }, [injectedCatalog, supported]);

  const selected =
    livePacks.find((row) => row.id === selectedId || row.name === selectedId) || null;
  const selectedKey = selected?.id ?? "";
  const [seenPack, setSeenPack] = useState(selectedKey);
  if (selected && seenPack !== selected.id) {
    setSeenPack(selected.id);
    setDraft(packToDraft(selected));
    setRun(null);
  }

  const steps = draft?.steps ?? EMPTY_STEPS;
  const { nodes: seededNodes, edges: seededEdges } = useMemo(
    () => stepsToFlow(steps, catalog, resources, run),
    [steps, catalog, resources, run],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(seededNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(seededEdges);

  useEffect(() => {
    setNodes((current) => {
      const sameChain =
        current.length === seededNodes.length &&
        current.every((node, index) => node.id === seededNodes[index]?.id);
      if (!sameChain) return seededNodes;
      return current.map((node, index) => {
        const next = seededNodes[index]!;
        return { ...node, type: next.type, data: next.data };
      });
    });
    setEdges(seededEdges);
  }, [seededNodes, seededEdges, setEdges, setNodes]);

  const commitSteps = useCallback((nextSteps: WorkflowStep[]) => {
    setDraft((current) => (current ? { ...current, steps: nextSteps } : current));
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!draft) return;
      setEdges((current) =>
        addEdge({ ...connection, id: `e-${connection.source}-${connection.target}` }, current),
      );
      const nextEdges = [
        ...edges.filter(
          (edge) => edge.source !== connection.source && edge.target !== connection.target,
        ),
        {
          id: `e-${connection.source}-${connection.target}`,
          source: String(connection.source),
          target: String(connection.target),
        },
      ];
      commitSteps(orderStepsFromGraph(draft.steps, nodes, nextEdges));
    },
    [commitSteps, draft, edges, nodes, setEdges],
  );

  const onDragStop = useCallback(() => {
    if (!draft) return;
    commitSteps(orderStepsFromGraph(draft.steps, nodes, edges));
  }, [commitSteps, draft, edges, nodes]);

  const removeNode = useCallback(
    (id: string) => {
      if (!draft || draft.steps.length <= 1) return;
      commitSteps(draft.steps.filter((step) => step.id !== id));
    },
    [commitSteps, draft],
  );

  const addFromCatalog = useCallback(
    (entry: WorkflowStepCatalogEntry) => {
      if (!draft) {
        const created = blankWorkflowDraft();
        created.steps = [catalogToStep(entry, 0)];
        setDraft(created);
        return;
      }
      commitSteps([...draft.steps, catalogToStep(entry, draft.steps.length)]);
    },
    [commitSteps, draft],
  );

  const onNew = () => {
    setDraft(blankWorkflowDraft());
    setRun(null);
    onSelect?.(null);
  };

  const onSave = async () => {
    if (!draft) return;
    setBusy("save");
    setLog("");
    try {
      const result = await saveWorkflowPack(draft, {
        onProgress: (next) => setLog(next.log.map((line) => line.text).join("\n")),
      });
      setLog(result.log.map((line) => line.text).join("\n"));
      if (result.stage === "done") {
        toast.success(`Saved ${result.workflowId} (disabled).`);
        if (result.workflowId) onSelect?.(result.workflowId);
        await refresh();
        await onSaved?.(result.workflowId ?? undefined);
      } else {
        toast.error(result.error || "Could not save that workflow.");
      }
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    const id = draft?.id || selected?.id;
    if (!id) {
      toast.error(
        supported
          ? "Save the pack first, then test it."
          : "This change needs the FRIDAY desktop app.",
      );
      return;
    }
    setBusy("test");
    try {
      const result = await runWorkflowPack(id, { allowDisabled: true, dryRun: true });
      setRun(result);
      setLog(
        [
          `${result.name} — ${result.steps.length} step(s)`,
          ...result.steps.map(
            (step, index) =>
              `${index + 1}. ${step.ok ? "ok" : "fail"}${step.skipped ? " (dry-run skip)" : ""} — ${step.label}: ${step.detail}`,
          ),
        ].join("\n"),
      );
      if (result.ok) toast.success(`${result.name} dry-ran ${result.steps.length} step(s).`);
      else toast.error(result.error || "Workflow test failed.");
    } finally {
      setBusy(null);
    }
  };

  const needle = catalogQuery.trim().toLowerCase();
  const catalogRows = catalog.filter((entry) => {
    if (!needle) return true;
    return `${entry.kind} ${entry.id} ${entry.name} ${entry.risk}`.toLowerCase().includes(needle);
  });
  const writeExec = steps.some((step) => step.risk === "write" || step.risk === "exec");

  return (
    <HudPanel
      title="Visual Builder"
      hint={draft ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "pick a pack"}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onNew}>
            <Plus className="size-3.5" /> New workflow
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={!draft?.id || busy !== null}
            onClick={() => void onTest()}
          >
            {busy === "test" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Test
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={!draft || busy !== null || !draft.name.trim()}
            onClick={() => void onSave()}
          >
            {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="workflow-visual-builder">
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
            value={selected?.id || ""}
            onChange={(event) => {
              const id = event.target.value || null;
              onSelect?.(id);
              const pack = livePacks.find((row) => row.id === id);
              setDraft(pack ? packToDraft(pack) : blankWorkflowDraft());
              setRun(null);
            }}
            aria-label="Open installed workflow"
          >
            <option value="">
              {livePacks.length ? "Open an installed workflow…" : "No installed workflows"}
            </option>
            {livePacks.map((pack) => (
              <option key={pack.id || pack.name} value={pack.id}>
                {pack.name}
              </option>
            ))}
          </select>
          <Input
            value={draft?.name || ""}
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, name: event.target.value } : current))
            }
            placeholder="Workflow name"
            className="h-8 font-mono text-xs"
            disabled={!draft || busy !== null}
          />
        </div>
        {draft ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Trigger — {draft.schedule || "on demand"}
            {draft.category ? ` · ${draft.category}` : ""}
            {writeExec ? " · write/exec steps still need owner approval before a real run" : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Open a pack to see its real steps as a graph, or start a New workflow and pick steps
            from the installed catalog.
          </p>
        )}
        <p className="font-mono text-[11px] text-muted-foreground">
          {watchConsent
            ? "Watching is on for this page. Password and secret fields are still left out. Local only."
            : "Watching is off. Password and secret fields are never recorded."}{" "}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => setWatchConsent((on) => !on)}
          >
            {watchConsent ? "Stop watching" : "I consent"}
          </Button>
        </p>
        <div
          className="workflow-visual-canvas h-[28rem] overflow-hidden rounded-sm border border-primary/20 bg-surface"
          data-testid="workflow-visual-canvas"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onDragStop}
            onNodesDelete={(deleted) => {
              for (const node of deleted) removeNode(node.id);
            }}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={16} size={1} color="hsl(var(--primary) / 0.15)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <Input
          value={catalogQuery}
          onChange={(event) => setCatalogQuery(event.target.value)}
          placeholder="Filter installed skills, agents, tools, connectors…"
          className="h-8 font-mono text-xs"
          disabled={busy !== null}
        />
        <div
          className="flex max-h-32 flex-wrap gap-1 overflow-auto"
          data-testid="workflow-visual-catalog"
        >
          {catalogRows.slice(0, 40).map((entry) => (
            <Button
              key={`${entry.kind}:${entry.id}`}
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={busy !== null}
              onClick={() => addFromCatalog(entry)}
            >
              {entry.kind} · {entry.name}
              {entry.risk !== "safe" ? ` · ${entry.risk}` : ""}
            </Button>
          ))}
        </div>
        {nodes.length > 1 ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy !== null || !draft || draft.steps.length <= 1}
            onClick={() => {
              const last = nodes[nodes.length - 1];
              if (last) removeNode(last.id);
            }}
          >
            Remove last step
          </Button>
        ) : null}
        {log ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {log}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            Drag to reorder, connect to set step order, pick a catalog item to add. Save writes
            workflow.json through installPack and stays disabled until you enable it. Test dry-runs
            the live pack (write/exec steps are not executed).
          </p>
        )}
      </div>
    </HudPanel>
  );
}

function WorkflowVisualRoute() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <AppShell
      title="Workflows"
      subtitle="Visual Builder — installed workflow.json steps as a node graph"
    >
      <WorkflowVisualBuilder selectedId={selectedId} onSelect={setSelectedId} />
    </AppShell>
  );
}
