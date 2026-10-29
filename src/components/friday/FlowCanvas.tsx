/**
 * FRIDAY · one flow canvas.
 *
 * Boxes move, wires reconnect, and the drawing uses canvas tokens.
 * The rest of the app keeps its own look.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type EdgeProps,
  type NodeProps,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { motionAllowed, type FlowGraph, type FlowRunEvent } from "@/lib/friday/flow-graph";
import type { CanvasAction, FlowPlacement } from "@/lib/friday/flow-edit";
import { flowElements, wireMotion } from "@/lib/friday/flow-render";

const NO_EVENTS: FlowRunEvent[] = [];

export type FlowNodeData = Record<string, unknown> & {
  label: string;
  status: string;
  risk: string;
  kind: string;
  locked: boolean;
  pinned: boolean;
  bookmarked: boolean;
  detail: string;
  privacy: string;
};

function token(name: string): string {
  if (typeof document === "undefined") return "transparent";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "transparent";
}

const FlowBox = memo(function FlowBox({ data, selected }: NodeProps) {
  const row = data as FlowNodeData;
  const marks = [
    row.status,
    row.kind,
    row.risk,
    row.privacy === "sensitive" ? "sensitive" : "",
    row.locked ? "locked" : "",
    row.pinned ? "pinned" : "",
    row.bookmarked ? "bookmark" : "",
  ].filter(Boolean);
  return (
    <div
      className={`flow-box w-40 rounded-md border bg-card px-2 py-1.5 text-foreground ${row.status === "running" ? "flow-live" : ""}`}
      data-kind={row.kind}
      data-status={row.status}
      data-risk={row.risk}
    >
      <NodeResizer
        isVisible={selected && !row.locked}
        minWidth={96}
        minHeight={48}
        onResizeEnd={(_event, params) => {
          const resize = (data as { onResize?: (width: number, height: number) => void }).onResize;
          if (params.width && params.height) resize?.(params.width, params.height);
        }}
      />
      <Handle type="target" position={Position.Top} className="flow-port" />
      <p className="truncate text-xs text-foreground">{row.label}</p>
      <p className="font-mono text-[10px] text-muted-foreground">{marks.join(" · ")}</p>
      {row.detail.split("\n")[0]?.startsWith("not recorded") ? (
        <p className="truncate font-mono text-[10px] text-muted-foreground">not recorded</p>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="flow-port" />
    </div>
  );
});

function FlowWire(props: EdgeProps) {
  const points = (props.data?.["waypoints"] as { x: number; y: number }[] | undefined) || [];
  const [smooth, smoothX, smoothY] = getSmoothStepPath(props);
  const path = points.length
    ? `M ${props.sourceX} ${props.sourceY} ${points.map((point) => `L ${point.x} ${point.y}`).join(" ")} L ${props.targetX} ${props.targetY}`
    : smooth;
  const travel = Boolean(props.data?.["travel"]);
  const reduce = Boolean(props.data?.["reduce"]);
  const countLabel = String(props.data?.["countLabel"] || "");
  const labelX = points.length ? (props.sourceX + props.targetX) / 2 : smoothX;
  const labelY = points.length ? (props.sourceY + props.targetY) / 2 : smoothY;
  const edgeLabel = travel ? null : props.label;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className={`flow-wire flow-wire-${String(props.data?.["kind"] || "control")}`}
        {...(edgeLabel === undefined || edgeLabel === null ? {} : { label: edgeLabel })}
      />
      {travel && !reduce ? (
        <circle r={4} className="flow-marker">
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {travel ? (
        <EdgeLabelRenderer>
          <div
            className="flow-wire-static nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {reduce ? <span className="flow-marker-static" /> : null}
            <span className="font-mono text-[10px] text-foreground">{countLabel}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes: NodeTypes = { flow: FlowBox };
const edgeTypes: EdgeTypes = { wire: FlowWire };
const SNAP_GRID: [number, number] = [16, 16];
const HIDE_ATTRIBUTION = { hideAttribution: true };

export function FlowCanvas({
  graph,
  placement,
  query,
  selectedId,
  highlight = [],
  onSelect,
  onPick,
  onAction,
  live,
  events = NO_EVENTS,
  sketch = false,
  contrast = false,
}: {
  graph: FlowGraph;
  placement?: FlowPlacement;
  query: string;
  selectedId: string;
  highlight?: string[];
  onSelect: (id: string) => void;
  onPick?: (ids: string[]) => void;
  onAction?: (action: CanvasAction) => void;
  live: boolean;
  events?: FlowRunEvent[];
  sketch?: boolean;
  contrast?: boolean;
}) {
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = live && motionAllowed(Boolean(reduce) === false);
  const model = useMemo(() => flowElements(graph, query, placement), [graph, query, placement]);
  const actRef = useRef(onAction);
  const onSelectRef = useRef(onSelect);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    actRef.current = onAction;
    onSelectRef.current = onSelect;
    onPickRef.current = onPick;
  });
  const highlightKey = highlight.join("\0");
  const nodes: Node[] = useMemo(() => {
    const lit = highlightKey ? new Set(highlightKey.split("\0")) : null;
    return model.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onResize: (width: number, height: number) =>
          actRef.current?.({ type: "resize", id: node.id, w: width, h: height }),
      },
      ...(lit && !lit.has(node.id) ? { style: { opacity: 0.35 } } : {}),
    }));
  }, [model, highlightKey]);
  const edges: Edge[] = useMemo(
    () =>
      model.edges.map((edge) => {
        const motion = live ? wireMotion(edge, events) : { active: false, label: "" };
        return {
          ...edge,
          type: "wire",
          animated: animate,
          data: {
            ...edge.data,
            kind: edge.kind,
            ...(motion.active ? { travel: true, reduce, countLabel: motion.label } : {}),
          },
        };
      }),
    [model, animate, live, events, reduce],
  );
  const emit = useCallback((action: CanvasAction) => {
    actRef.current?.(action);
  }, []);
  const onSelection = useCallback(({ nodes: picked }: { nodes: Node[] }) => {
    onPickRef.current?.(picked.map((node) => node.id));
    const first = picked[0];
    if (first) onSelectRef.current(first.id);
  }, []);
  const onDragStop = useCallback(
    (_event: unknown, node: Node) => {
      emit({ type: "place", id: node.id, x: node.position.x, y: node.position.y });
    },
    [emit],
  );
  const onDeleteNodes = useCallback(
    (deleted: Node[]) => {
      emit({ type: "delete-nodes", ids: deleted.map((node) => node.id) });
    },
    [emit],
  );
  const onDeleteEdges = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) emit({ type: "delete-edge", edgeId: edge.id });
    },
    [emit],
  );
  const onReconnectEdge = useCallback(
    (edge: Edge, connection: Connection) => {
      if (connection.source && connection.target) {
        emit({
          type: "reconnect",
          edgeId: edge.id,
          source: connection.source,
          target: connection.target,
        });
      }
    },
    [emit],
  );
  const onConnectEdge = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        emit({
          type: "connect",
          source: connection.source,
          target: connection.target,
          kind: "control",
        });
      }
    },
    [emit],
  );
  const onInsert = useCallback(
    (_event: unknown, edge: Edge) => {
      emit({ type: "insert", edgeId: edge.id, label: "Step" });
    },
    [emit],
  );
  return (
    <div
      className={`flow-stage relative h-[46vh] min-h-[320px] overflow-hidden rounded-md border border-border ${sketch ? "flow-sketch" : ""} ${contrast ? "flow-contrast" : ""}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable
        nodesConnectable={Boolean(onAction)}
        elementsSelectable
        edgesReconnectable={Boolean(onAction)}
        selectionOnDrag
        panOnScroll
        snapToGrid
        snapGrid={SNAP_GRID}
        multiSelectionKeyCode="Shift"
        deleteKeyCode="Delete"
        onlyRenderVisibleElements={graph.nodes.length > 80}
        proOptions={HIDE_ATTRIBUTION}
        onNodeClick={(_event, node) => onSelectRef.current(node.id)}
        onNodeDragStop={onDragStop}
        onNodesDelete={onDeleteNodes}
        onEdgesDelete={onDeleteEdges}
        onReconnect={onReconnectEdge}
        onConnect={onConnectEdge}
        onEdgeDoubleClick={onInsert}
        onSelectionChange={onSelection}
        className="bg-background"
      >
        <MiniMap
          pannable
          zoomable
          className="!bg-card"
          nodeColor={(node) => {
            const status = String((node.data as FlowNodeData | undefined)?.status || "");
            if (status === "failed") return token("--destructive");
            if (status === "running") return token("--primary");
            if (status === "ok") return token("--success");
            return token("--muted");
          }}
        />
        <Controls showInteractive={false} />
        <Background gap={16} />
      </ReactFlow>
      <span className="sr-only">{selectedId}</span>
    </div>
  );
}
