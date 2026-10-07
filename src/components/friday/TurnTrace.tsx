/**
 * FRIDAY · live per-turn reasoning trace
 *
 * Sits once on the conversation strip, beside the model line.
 * The chart icon opens this turn. The step count opens the same steps.
 */

import { useState } from "react";
import { ChevronDown, GitBranch, ListChecks, Loader2 } from "lucide-react";
import { StatusPill } from "@/components/friday/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { lastDecision } from "@/lib/friday/brain/decision-trace";
import { useBrain } from "@/lib/friday/use-brain";
import { lanesFromSteps, type TraceLaneView } from "@/lib/friday/brain/turn-trace";
import { chatEvents, chatTurnGraph, rememberRun } from "@/lib/friday/flow-modes";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import { modelRegistry } from "@/lib/friday/model-registry";
import { preferences } from "@/lib/friday/preferences";
import { cn } from "@/lib/utils";

export function TurnTrace({ runId }: { runId: string }) {
  const state = useBrain();
  const run = state.runs.find((item) => item.id === runId);
  const steps = run?.trace ?? [];
  const lanes = lanesFromSteps(steps);
  const [openLane, setOpenLane] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const isRunning =
    run?.state === "running" || state.activeRunId === runId || lanes.some((l) => l.running);
  const isFailed = lanes.some((l) => l.failed);

  if (!lanes.length && !isRunning) return null;

  const latestStep = steps[steps.length - 1];
  const totalMs = lanes.reduce((sum, l) => sum + (l.ms ?? 0), 0);

  const runningLabel = latestStep?.label ? `${latestStep.label}…` : "working…";
  const completedLabel = `${steps.length} ${steps.length === 1 ? "step" : "steps"}${totalMs ? ` · ${totalMs}ms` : ""}`;

  const openChart = () => {
    const newest = state.runs[0]?.id === runId;
    const decision = newest ? lastDecision() : null;
    const toggles = preferences.getSnapshot().toggles;
    const graph = rememberRun(
      chatTurnGraph({
        steps,
        message: run?.prompt || "",
        response: run?.answer || "",
        ...(decision?.modelIds?.length ? { modelIds: decision.modelIds } : {}),
        ...(decision?.routing ? { routing: decision.routing } : {}),
        ...(run?.answeredBy?.line ? { answeredBy: run.answeredBy.line } : {}),
        strategy: modelRegistry.getSnapshot().strategy,
        safeTools: toggles["safeTools"] ? "true" : "false",
        rememberChats: toggles["rememberChats"] ? "true" : "false",
      }),
    );
    const live = run?.state === "running" || state.activeRunId === runId;
    flowStudio.openBoard(graph, live ? "watch" : "chart");
    flowStudio.beginRun(runId);
    flowStudio.noteMany(runId, chatEvents(steps));
  };

  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label="Show this turn as a flow chart"
        title="Show this turn as a flow chart"
        onClick={openChart}
        className="inline-flex size-5 items-center justify-center rounded-full border border-primary/20 text-primary/80 hover:bg-primary/10"
      >
        <GitBranch className="size-3" />
      </button>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-mono transition-colors",
              "border border-primary/20 bg-background/80 hover:bg-primary/10 hover:border-primary/40",
              isRunning && "border-warning/40 text-warning bg-warning/5 animate-pulse",
              !isRunning && isFailed && "border-destructive/40 text-destructive bg-destructive/5",
              !isRunning && !isFailed && "text-muted-foreground hover:text-foreground",
            )}
            title="Click to view reasoning and execution steps"
          >
            {isRunning ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-warning" />
            ) : isFailed ? (
              <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            ) : (
              <ListChecks className="size-3 shrink-0 text-primary/70" />
            )}
            <span className="max-w-[180px] truncate">
              {isRunning ? runningLabel : completedLabel}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          className="max-h-96 w-80 overflow-y-auto border-primary/20 bg-popover/95 p-3 text-xs shadow-xl backdrop-blur-sm"
        >
          <div className="mb-2 flex items-center justify-between border-b border-primary/15 pb-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  isRunning
                    ? "bg-warning animate-ping"
                    : isFailed
                      ? "bg-destructive"
                      : "bg-accent shadow-[0_0_6px_var(--color-accent)]",
                )}
              />
              <span className="text-xs font-semibold text-primary">Working Flow & Steps</span>
            </div>
            <span className="font-mono text-[9px] text-muted-foreground">
              {isRunning ? "in progress" : `${totalMs}ms total`}
            </span>
          </div>

          {!lanes.length ? (
            <div className="py-4 text-center font-mono text-[11px] text-muted-foreground">
              <Loader2 className="mx-auto mb-1 size-4 animate-spin text-warning" />
              Initializing turn pipeline…
            </div>
          ) : (
            <div className="space-y-1">
              {lanes.map((lane) => (
                <TraceLaneRow
                  key={lane.lane}
                  view={lane}
                  open={openLane === lane.lane || (openLane === null && lane.running)}
                  onToggle={() =>
                    setOpenLane((current) => (current === lane.lane ? "" : lane.lane))
                  }
                />
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TraceLaneRow({
  view,
  open,
  onToggle,
}: {
  view: TraceLaneView;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = view.failed ? "destructive" : view.running ? "warning" : "accent";
  const status = view.failed ? "failed" : view.running ? "running" : `${view.ms}ms`;
  return (
    <div className="rounded border border-primary/10 bg-background/40 p-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors",
          "hover:bg-primary/8",
        )}
      >
        <StatusPill label={status} tone={tone} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {view.lane}
        </span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : "",
          )}
        />
      </button>
      {open ? (
        <ul className="mt-1 space-y-1 border-l border-primary/20 py-0.5 pl-2">
          {view.steps.map((step) => (
            <li
              key={step.id}
              className="font-mono text-[10px] leading-relaxed text-muted-foreground"
            >
              <span className="font-medium text-primary">{step.label}</span>
              <span className="text-muted-foreground/70"> · {step.nodeId}</span>
              {typeof step.ms === "number" ? (
                <span className="text-muted-foreground/70"> · {step.ms}ms</span>
              ) : step.state === "running" ? (
                <span className="font-medium text-warning"> · running</span>
              ) : null}
              {step.detail ? (
                <p className="mt-0.5 whitespace-pre-wrap rounded border border-primary/10 bg-primary/5 p-1 text-[10px] text-foreground/80">
                  {step.detail}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
