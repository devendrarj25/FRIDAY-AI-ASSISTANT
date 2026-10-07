import { useEffect, useId, useRef, useState } from "react";
import {
  Blocks,
  Bot,
  Boxes,
  Brain,
  CheckCircle2,
  Database,
  GitFork,
  ListTodo,
  Plug,
  Send,
  ShieldCheck,
  Sparkle,
  Target,
  Workflow,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FridayOrb } from "@/components/friday/FridayOrb";
import type { ComponentId, LiveComponent } from "@/lib/friday/use-friday-live";
import { useFridayLive } from "@/lib/friday/use-friday-live";
import { cn } from "@/lib/utils";

/**
 * FRIDAY's live execution surface.
 *
 * The large brand mark stays exactly as it was — same size, same breathing
 * animation. Around it sit compact status boxes for every core component,
 * wired to the core with thin neon circuits. Wires only carry current for the
 * components the CURRENT run actually uses; everything else stays a quiet,
 * connected idle trace. No simulated activity anywhere.
 */

const ICONS: Record<ComponentId, LucideIcon> = {
  brain: Brain,
  intent: Target,
  planner: GitFork,
  agent: Bot,
  skill: Sparkle,
  tool: Wrench,
  plugin: Plug,
  module: Blocks,
  model: Boxes,
  memory: Database,
  workflow: Workflow,
  task: ListTodo,
  result: Send,
  verification: ShieldCheck,
};

const STATE_LABEL: Record<LiveComponent["state"], string> = {
  idle: "idle",
  listening: "listening",
  working: "working",
  speaking: "speaking",
  done: "done",
  blocked: "blocked",
};

function ComponentBox({
  node,
  large = false,
  onSelect,
  maxDetails = 3,
}: {
  node: LiveComponent;
  large?: boolean;
  onSelect?: (node: LiveComponent) => void;
  maxDetails?: number;
}) {
  const Icon = ICONS[node.id];
  const { active, tone } = node;
  const details = large ? node.details.slice(0, Math.max(0, maxDetails)) : node.details;

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(node) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(node);
            }
          : undefined
      }
      className={cn(
        "gpu-layer pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-md border backdrop-blur-[1px] transition-[box-shadow,border-color] duration-300",
        large ? "w-[13.5rem] px-2.5 py-2" : "w-[8.6rem] px-2 py-1.5",
        onSelect && "cursor-pointer",
        active && "node-glow",
      )}
      style={{
        left: `${node.x}%`,
        top: `${node.y}%`,
        borderColor: active
          ? `color-mix(in oklab, ${tone} 75%, transparent)`
          : `color-mix(in oklab, ${tone} 26%, transparent)`,
        background: active
          ? `color-mix(in oklab, ${tone} 14%, var(--color-surface))`
          : `color-mix(in oklab, ${tone} 5%, var(--color-surface))`,
        boxShadow: active ? `0 0 20px -4px ${tone}` : "none",
      }}
    >
      <div className={cn("flex items-center gap-1.5", node.side === "right" && "flex-row-reverse")}>
        <Icon className={cn("shrink-0", large ? "size-3.5" : "size-3")} style={{ color: tone }} />
        <span
          className={cn(
            "label-xs min-w-0 flex-1 truncate",
            large ? "text-[11px]" : "text-[9px]",
            node.side === "right" && "text-right",
          )}
          style={{ color: tone }}
        >
          {node.label}
        </span>
        {active ? (
          <span
            className="size-1.5 shrink-0 rounded-full pulse-dot"
            style={{ background: tone, color: tone }}
          />
        ) : null}
      </div>

      {/* One-line live summary: what this component is doing right now. */}
      <p
        className={cn(
          "truncate font-mono leading-tight",
          large ? "text-[10px]" : "text-[9px]",
          active ? "text-foreground/85" : "text-muted-foreground",
          node.side === "right" && "text-right",
        )}
        title={active ? node.action : node.status}
      >
        {(active ? node.action : node.status) ?? node.status}
      </p>

      {/* Real per-component readouts — Auto Mode stage only, so Manual mode
          keeps its exact compact layout. */}
      {large && details.length ? (
        <div
          className={cn(
            "mt-1 space-y-0.5 border-t border-border/50 pt-1",
            node.side === "right" && "text-right",
          )}
        >
          {details.map((d) => (
            <p
              key={d.k}
              className="flex items-baseline gap-1.5 truncate font-mono text-[10px] leading-tight"
              style={node.side === "right" ? { flexDirection: "row-reverse" } : undefined}
              title={`${d.k}: ${d.v}`}
            >
              <span className="shrink-0 text-muted-foreground/70">{d.k}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/85">{d.v}</span>
            </p>
          ))}
        </div>
      ) : null}

      {large && typeof node.progress === "number" ? (
        <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-border">
          <span
            className="block h-full rounded-full transition-[width] duration-200"
            style={{ width: `${node.progress}%`, background: tone }}
          />
        </span>
      ) : null}

      {large ? (
        <div
          className={cn(
            "mt-1 flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider",
            node.side === "right" && "flex-row-reverse",
          )}
        >
          <span
            className={cn(
              "size-1 rounded-full",
              (node.state === "working" ||
                node.state === "listening" ||
                node.state === "speaking") &&
                "pulse-dot",
            )}
            style={{
              background: node.state === "idle" ? "var(--color-muted-foreground)" : tone,
            }}
          />
          <span
            style={{ color: node.state === "idle" ? undefined : tone }}
            className={node.state === "idle" ? "text-muted-foreground/70" : undefined}
          >
            {STATE_LABEL[node.state]}
          </span>
          {node.age ? <span className="text-muted-foreground/60">· {node.age}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `large` only changes presentation (bigger boxes, wider spread, bigger rings
 * and mark) for the Auto Mode stage. The data, wiring and animations stay
 * identical, and Manual mode renders exactly as before.
 */
export function NeuralCircuit({
  large = false,
  onSelectNode,
}: { large?: boolean; onSelectNode?: (node: LiveComponent) => void } = {}) {
  const gid = useId();
  const liveRaw = useFridayLive();
  // Auto Mode slots are height-bound: measure the stage once (and on resize)
  // and show only as many readout lines as fit without boxes ever touching.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setStageH(entry?.contentRect.height ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Slot pitch = 82% of the canvas spread across 6 gaps; a box needs ~62px of
  // chrome plus ~13px per readout line, and 10px of breathing room.
  const slotPx = stageH ? (stageH * 0.86) / 6 : 0;
  const maxDetails = !large ? 3 : Math.max(0, Math.min(3, Math.floor((slotPx - 76 - 10) / 13)));
  // Auto Mode boxes are much taller (they carry real readouts), so they are
  // laid out as two fixed-slot columns: evenly spaced, never overlapping.
  const live = large
    ? (() => {
        const bySide = { left: [] as LiveComponent[], right: [] as LiveComponent[] };
        for (const c of [...liveRaw.components].sort((a, b) => a.y - b.y)) bySide[c.side].push(c);
        const place = (list: LiveComponent[], x: number): LiveComponent[] =>
          list.map((c, i) => ({
            ...c,
            x,
            y: list.length > 1 ? 7 + (i * 86) / (list.length - 1) : 50,
          }));
        const placed = [...place(bySide.left, 12), ...place(bySide.right, 88)];
        const order = new Map(liveRaw.components.map((c, i) => [c.id, i]));
        placed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        return { ...liveRaw, components: placed };
      })()
    : liveRaw;
  const anyActive = live.components.some((c) => c.active);

  return (
    <div
      ref={stageRef}
      className="neural-circuit relative isolate size-full overflow-hidden rounded-lg"
    >
      <span className="panel-grid pointer-events-none absolute inset-0 opacity-[0.12]" />

      {/* Neon circuit wires: thin + connected when idle, energised only where
          the current run is genuinely working. */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={`${gid}-core`}>
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="34" fill={`url(#${gid}-core)`} />

        {live.components.map((c) => {
          const ax = c.side === "left" ? c.x + 5 : c.x - 5;
          const bx = c.side === "left" ? 34 : 66;
          const d = `M ${ax} ${c.y} H ${bx} L 50 50`;
          return (
            <g key={c.id}>
              <path
                d={d}
                fill="none"
                stroke={c.tone}
                strokeOpacity={c.active ? 0.4 : 0.18}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {c.active ? (
                <path
                  className="circuit-flow"
                  d={d}
                  fill="none"
                  stroke={c.tone}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: `drop-shadow(0 0 4px ${c.tone})` }}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Component boxes hugging both sides of the mark */}
      <div className="pointer-events-none absolute inset-0">
        {live.components.map((c) => (
          <ComponentBox
            key={c.id}
            node={c}
            large={large}
            maxDetails={maxDetails}
            {...(onSelectNode ? { onSelect: onSelectNode } : {})}
          />
        ))}
      </div>

      {/* The large FRIDAY mark — unchanged size, always breathing */}
      <div className="relative grid size-full place-items-center">
        <div className="relative grid place-items-center">
          <span
            className={cn(
              "absolute aspect-square rounded-full border border-primary/15 orb-spin-slow gpu-layer",
              large ? "w-[600px] max-w-[52vh]" : "w-[420px] max-w-[38vh]",
            )}
          />
          <span
            className={cn(
              "absolute aspect-square rounded-full border border-accent/20 orb-spin-rev gpu-layer",
              large ? "w-[470px] max-w-[41vh]" : "w-[330px] max-w-[30vh]",
            )}
          />
          <span
            className={cn(
              "absolute aspect-square rounded-full border border-magenta/20 orb-spin-slow gpu-layer",
              large ? "w-[340px] max-w-[30vh]" : "w-[240px] max-w-[22vh]",
            )}
          />
          <FridayOrb
            size={large ? 310 : 220}
            live
            className={large ? "max-w-[27vh]" : "max-w-[20vh]"}
          />

          {/* REAL action + emotion, directly under the logo */}
          <div className={cn("absolute w-64 text-center", large ? "-bottom-16" : "-bottom-14")}>
            <p
              className={cn(
                "font-display font-bold tracking-[0.3em] text-primary glow-text",
                large ? "text-lg" : "text-base",
              )}
            >
              FRIDAY
            </p>
            <p
              className={cn(
                "mt-0.5 truncate font-mono text-accent",
                large ? "text-[11px]" : "text-[10px]",
              )}
            >
              <span className="text-muted-foreground">ACTION:</span> {live.action}
              {anyActive && live.stageCount ? ` · ${live.stageIndex + 1}/${live.stageCount}` : ""}
            </p>
            <p
              className={cn(
                "truncate font-mono text-magenta",
                large ? "text-[11px]" : "text-[10px]",
              )}
            >
              <span className="text-muted-foreground">EMOTION:</span> {live.emotion}
            </p>
          </div>
        </div>
      </div>

      {/* Manual mode keeps the corner badge. Auto Mode parks the same badge
          on the HUD row so it cannot sit on the Verification box. */}
      {large ? null : (
        <span
          className={cn(
            "absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[10px]",
            anyActive
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-primary/25 bg-primary/8 text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              anyActive ? "bg-accent pulse-dot" : "bg-muted-foreground",
            )}
          />
          {anyActive ? "WORKING" : "IDLE"}
        </span>
      )}
    </div>
  );
}
