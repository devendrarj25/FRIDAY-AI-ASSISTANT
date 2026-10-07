import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleDot,
  Copy,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import { copyText } from "@/lib/friday/clipboard";
import { isDesktopApp } from "@/lib/friday/desktop";
import { ledger, type TaskRecord, type TaskStatus } from "@/lib/friday/self/task-ledger";
import { useBackgroundTasks, useLedger, useTaskGraph } from "@/lib/friday/self/use-self";
import { graphProgress, taskGraph, type TaskGraph } from "@/lib/friday/self/task-graph";
import type { TimelineRow } from "@/lib/friday/self/run-receipt";
import { backgroundTasks } from "@/lib/friday/self/background-tasks";
import { registerTaskRunners } from "@/lib/friday/self/task-runners";
import { extractDeadline, looksLikeHorizonGoal } from "@/lib/friday/self/horizon-goals";
import {
  filterGraphs,
  filterLedger,
  formatTasksExtra,
  graphIsLive,
  publishTasksSession,
  registerTasksAsk,
  summarizeTaskErrors,
  type TasksFilter,
} from "@/lib/friday/tasks-awareness";
import { localDayWindow, receiptsFromWork, summarizeDay } from "@/lib/friday/assistant-conduct";

export const Route = createFileRoute("/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks — FRIDAY" },
      {
        name: "description",
        content:
          "Live task graph and ledger: queue, approve, interrupt, resume, retry and watch checkpointed work.",
      },
      { property: "og:title", content: "Tasks — FRIDAY" },
      { property: "og:description", content: "Live FRIDAY task graph with approval gates." },
    ],
  }),
  component: TasksPage,
});

const LIVE: TaskStatus[] = ["queued", "running", "awaiting-approval"];
const FILTERS: TasksFilter[] = [
  "all",
  "live",
  "queued",
  "paused",
  "failed",
  "done",
  "idle",
  "waiting",
];

function LogIcon({ level }: { level: "info" | "ok" | "warn" | "error" }) {
  if (level === "ok") return <Check className="size-3.5 text-success" />;
  if (level === "warn") return <ShieldAlert className="size-3.5 text-warning" />;
  if (level === "error") return <X className="size-3.5 text-destructive" />;
  return <CircleDot className="size-3.5 text-muted-foreground" />;
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function TaskPanel({ task, question }: { task: TaskRecord; question: string | undefined }) {
  const running = LIVE.includes(task.status);
  return (
    <Panel key={task.id} title={task.id} hint={`${time(task.startedAt)} · ${task.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{task.title}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge
              variant={task.status === "awaiting-approval" ? "default" : "outline"}
              className="label-xs"
            >
              {task.status}
            </Badge>
            {running ? (
              <span className="font-mono text-[11px] text-muted-foreground">{task.progress}%</span>
            ) : null}
            {task.error ? (
              <span className="font-mono text-[11px] text-destructive">{task.error}</span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {question ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => ledger.answerApproval(task.id, false)}
              >
                Deny
              </Button>
              <Button size="sm" onClick={() => ledger.answerApproval(task.id, true)}>
                Approve step
              </Button>
            </>
          ) : running ? (
            <Button size="sm" variant="outline" onClick={() => ledger.cancel(task.id)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {question ? (
        <p className="mt-3 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          {question}
        </p>
      ) : null}

      <ol className="mt-4 space-y-2 border-l border-border pl-4">
        {task.logs.slice(-8).map((log, i) => (
          <li key={`${task.id}-${i}-${log.at}`} className="relative flex items-start gap-2.5">
            <span className="absolute -left-[1.36rem] top-1 grid size-4 place-items-center rounded-full bg-card">
              {running && i === task.logs.slice(-8).length - 1 ? (
                <Loader2 className="size-3.5 animate-spin text-primary" />
              ) : (
                <LogIcon level={log.level} />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-sm">{log.line}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{time(log.at)}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function RunTimeline({ rows }: { rows: TimelineRow[] | undefined }) {
  if (!rows?.length) return null;
  return (
    <ol className="mt-1 space-y-1 text-muted-foreground">
      {rows.map((row) => (
        <li key={row.stepId}>
          <span className="text-foreground">{row.action}</span>
          {" · "}
          <Badge variant="outline" className="label-xs">
            {row.source}
            {row.confidence == null ? "" : ` ${row.confidence.toFixed(2)}`}
            {row.ageMs == null ? "" : ` · ${row.ageMs} ms`}
          </Badge>
          {row.handoff ? (
            <Badge variant="outline" className="label-xs">
              {row.handoff}
            </Badge>
          ) : null}
          <span className="block">
            {row.checked ? "postcondition held" : "postcondition missed"}
            {row.postcondition ? `: ${row.postcondition}` : ""}
            {row.result ? ` · ${row.result}` : ""}
          </span>
          {row.undoHint ? <span className="block">undo · {row.undoHint}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function GraphRow({
  graph,
  position,
  open,
  onToggle,
  blocker,
  onBlocker,
}: {
  graph: TaskGraph;
  position?: number | undefined;
  open: boolean;
  onToggle: () => void;
  blocker: string;
  onBlocker: (value: string) => void;
}) {
  const progress = graphProgress(graph);
  const current = graph.nodes.find(
    (n) =>
      n.state === "running" ||
      n.state === "ready" ||
      n.state === "retrying" ||
      n.state === "waiting" ||
      n.state === "interrupted",
  );
  const queued = graph.state === "queued";
  const openGraph =
    graph.state === "queued" ||
    graph.state === "running" ||
    graph.state === "paused" ||
    graph.state === "interrupted";
  const finished =
    graph.state === "completed" || graph.state === "failed" || graph.state === "cancelled";
  return (
    <li className="border-b border-border/60 pb-2 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <button type="button" className="min-w-0 text-left" onClick={onToggle}>
          <span className="block truncate text-sm">{graph.request}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {progress.done}/{progress.total} subtasks
            {position ? ` · #${position} in line` : ""}
            {current ? ` · next: ${current.title}` : ""}
            {graph.priority === "idle" ? " · idle self-work" : ""}
            {graph.horizon?.deadline ? ` · ${graph.horizon.deadline}` : ""}
          </span>
          {current?.checkpoint?.nextAction ? (
            <span className="block font-mono text-[11px] text-muted-foreground">
              checkpoint → {current.checkpoint.nextAction}
            </span>
          ) : null}
          {graph.horizon?.blockers?.length ? (
            <span className="block font-mono text-[11px] text-destructive">
              blocker: {graph.horizon.blockers.at(-1)}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Badge variant="outline" className="label-xs">
            {graph.state}
          </Badge>
          {queued ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => taskGraph.moveInQueue(graph.id, -1)}>
                <ArrowUp className="size-3.5" /> Up
              </Button>
              <Button size="sm" variant="ghost" onClick={() => taskGraph.moveInQueue(graph.id, 1)}>
                <ArrowDown className="size-3.5" /> Down
              </Button>
            </>
          ) : null}
          {graph.state === "running" ? (
            <Button size="sm" variant="outline" onClick={() => taskGraph.interrupt(graph.id)}>
              Interrupt
            </Button>
          ) : null}
          {graph.state === "running" || queued ? (
            <Button size="sm" variant="ghost" onClick={() => taskGraph.pause(graph.id)}>
              Pause
            </Button>
          ) : null}
          {graph.state === "paused" || graph.state === "interrupted" || queued ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                graph.state === "paused" || graph.state === "interrupted"
                  ? taskGraph.resume(graph.id)
                  : void taskGraph.pump()
              }
            >
              {graph.state === "paused" || graph.state === "interrupted" ? "Resume" : "Run next"}
            </Button>
          ) : null}
          {graph.state === "failed" || graph.state === "cancelled" ? (
            <Button size="sm" variant="outline" onClick={() => taskGraph.retry(graph.id)}>
              <RotateCcw className="size-3.5" /> Retry
            </Button>
          ) : null}
          {finished ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const again = taskGraph.requeue(graph.id);
                if (again) toast.success("Queued the same request again.");
              }}
            >
              Run again
            </Button>
          ) : null}
          {openGraph ? (
            <Button size="sm" variant="ghost" onClick={() => taskGraph.cancel(graph.id)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1 font-mono text-[11px]">
            {graph.nodes.map((node) => (
              <li key={node.id} className="flex items-start gap-2">
                {node.state === "verified" || node.state === "completed" ? (
                  <Check className="mt-0.5 size-3.5 text-success" />
                ) : node.state === "running" || node.state === "retrying" ? (
                  <Loader2 className="mt-0.5 size-3.5 animate-spin text-primary" />
                ) : node.state === "failed" ? (
                  <X className="mt-0.5 size-3.5 text-destructive" />
                ) : (
                  <CircleDot className="mt-0.5 size-3.5 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className={cn(node.state === "failed" && "text-destructive")}>
                    {node.title} · {node.state}
                    {node.purpose === "outcome" ? " · outcome" : ""}
                  </span>
                  {node.error ? <span className="block text-destructive">{node.error}</span> : null}
                  <RunTimeline rows={node.checkpoint?.timeline} />
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void copyText(graph.request).then((ok) =>
                  ok ? toast.success("Copied the request.") : toast.error("Could not copy."),
                )
              }
            >
              <Copy className="size-3.5" /> Copy request
            </Button>
          </div>
          {openGraph ? (
            <div className="flex gap-2">
              <Input
                value={blocker}
                onChange={(e) => onBlocker(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const reason = blocker.trim();
                    if (!reason) return;
                    taskGraph.replanBlocked(graph.id, reason);
                    onBlocker("");
                    toast.success("Replanned remaining work around the blocker.");
                  }
                }}
                placeholder="Record a blocker and replan the unfinished tail"
                className="h-8 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!blocker.trim()}
                onClick={() => {
                  const reason = blocker.trim();
                  if (!reason) return;
                  taskGraph.replanBlocked(graph.id, reason);
                  onBlocker("");
                  toast.success("Replanned remaining work around the blocker.");
                }}
              >
                Record blocker
              </Button>
            </div>
          ) : null}
          <pre className="max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {graph.logs.length
              ? graph.logs
                  .slice(-12)
                  .map((log) => `${time(log.at)} [${log.level}] ${log.line}`)
                  .join("\n")
              : "no graph logs yet"}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

function TasksPage() {
  const desktop = isDesktopApp();
  const brainState = useBrain();
  const { graphs, queue, runningId, idlePaused } = useTaskGraph();
  const { tasks, approvals } = useLedger();
  const background = useBackgroundTasks();
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<TasksFilter>("all");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState("");
  const [draft, setDraft] = useState("");
  const [blocker, setBlocker] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const streamRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    registerTaskRunners();
  }, []);

  useEffect(() => {
    registerTasksAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatTasksExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerTasksAsk(null);
  }, []);

  useEffect(() => {
    publishTasksSession({
      desktop,
      follow,
      filter,
      query,
      runningId,
      idlePaused,
      graphs,
      queue,
      tasks,
      approvals,
    });
  }, [desktop, follow, filter, query, runningId, idlePaused, graphs, queue, tasks, approvals]);

  useEffect(() => {
    if (!follow) return;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [graphs, follow]);

  const visibleGraphs = useMemo(
    () => filterGraphs(graphs, { filter, query }),
    [graphs, filter, query],
  );
  const visibleLedger = useMemo(
    () => filterLedger(tasks, { filter, query }),
    [tasks, filter, query],
  );
  const live = visibleLedger.filter((t) => LIVE.includes(t.status));
  const history = visibleLedger.filter((t) => !LIVE.includes(t.status)).slice(0, 40);
  const questionFor = (id: string) => approvals.find((a) => a.taskId === id)?.question;
  const errors = summarizeTaskErrors(graphs, tasks);
  const recent = brainState.messages.slice(-8);

  const queueWork = () => {
    const text = draft.trim();
    if (!text) return;
    registerTaskRunners();
    const deadline = extractDeadline(text);
    taskGraph.submit(
      text,
      looksLikeHorizonGoal(text)
        ? { horizon: { goal: text, ...(deadline ? { deadline } : {}) } }
        : {},
    );
    setDraft("");
    toast.success("Queued on the live task graph.");
  };

  const copyBuffer = async () => {
    const ok = await copyText(formatTasksExtra());
    if (ok) toast.success("Copied the live task session.");
    else toast.error("Could not copy.");
  };

  const onClear = () => {
    if (!window.confirm("Clear finished graphs and ledger history? Live work stays.")) return;
    ledger.clearHistory();
    taskGraph.clearFinished();
  };

  const onCancelAll = () => {
    if (!window.confirm("Cancel every live ledger task and open graph?")) return;
    ledger.cancelAll();
    for (const graph of graphs) {
      if (
        graph.state === "queued" ||
        graph.state === "running" ||
        graph.state === "paused" ||
        graph.state === "interrupted"
      ) {
        taskGraph.cancel(graph.id);
      }
    }
  };

  const onPauseAll = () => {
    const n = taskGraph.pauseAll();
    if (n) toast.success(`Paused ${n} running graph(s).`);
    else toast.message("Nothing running to pause.");
  };

  const onResumePaused = () => {
    const n = taskGraph.resumeAllPaused();
    if (n) toast.success(`Resumed ${n} held graph(s).`);
    else toast.message("Nothing is waiting to resume.");
  };

  const onApproveAll = () => {
    const pending = [...approvals];
    for (const row of pending) ledger.answerApproval(row.taskId, true);
  };

  const onDenyAll = () => {
    const pending = [...approvals];
    for (const row of pending) ledger.answerApproval(row.taskId, false);
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    const prompt = /task|queue|graph/i.test(text) ? text : `${text} in the tasks`;
    brain.send(prompt, { extra: formatTasksExtra() });
  };

  const latest = tasks.reduce((max, task) => Math.max(max, task.startedAt || 0), 0);
  const day = latest > 0 ? localDayWindow(latest) : null;
  const digest = summarizeDay({
    dayKey: day?.dayKey ?? "no receipts yet",
    orders: [],
    receipts: day ? receiptsFromWork({ tasks, start: day.start, end: day.end }) : [],
  });

  return (
    <AppShell
      title="Tasks"
      subtitle="Goal → plan → tools → verification · live"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void copyBuffer()}>
            <Copy className="size-3.5" /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFollow((value) => !value)}>
            {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {follow ? "Pause follow" : "Follow"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onPauseAll}>
            Pause all
          </Button>
          <Button size="sm" variant="ghost" onClick={onResumePaused}>
            Resume paused
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelAll}>
            Cancel all
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            <Trash2 className="size-3.5" /> Clear history
          </Button>
          <Button size="sm" variant="outline" onClick={() => void taskGraph.pump()}>
            <RefreshCw className="size-3.5" /> Pump
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Panel title="What FRIDAY did" hint={day?.dayKey ?? "no receipts yet"}>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{digest.digest}</p>
        </Panel>
        <Panel
          title="Queue"
          hint={`${visibleGraphs.length}/${graphs.length} graphs · ${queue.length} in line · ${graphs.filter((graph) => graphIsLive(graph.state)).length} live · ${approvals.length} waiting${idlePaused ? " · idle paused" : ""}`}
        >
          <div className="mb-2 flex flex-wrap gap-1.5">
            {FILTERS.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={filter === item ? "default" : "outline"}
                onClick={() => setFilter(item)}
              >
                {item}
              </Button>
            ))}
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter the live graph and ledger"
            className="mb-2 h-8 font-mono text-xs"
          />
          <div className="mb-3 flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  queueWork();
                }
              }}
              placeholder="Queue a multi-step job on the live graph"
              className="h-8 text-sm"
            />
            <Button size="sm" disabled={!draft.trim()} onClick={queueWork}>
              <Plus className="size-3.5" /> Queue
            </Button>
          </div>
          <ul
            ref={streamRef}
            className="max-h-[min(28rem,calc(100vh-14rem))] space-y-3 overflow-auto"
          >
            {visibleGraphs.length ? (
              visibleGraphs.map((graph) => (
                <GraphRow
                  key={graph.id}
                  graph={graph}
                  position={queue.find((entry) => entry.id === graph.id)?.position}
                  open={openId === graph.id || graph.id === runningId}
                  onToggle={() => setOpenId((id) => (id === graph.id ? null : graph.id))}
                  blocker={openId === graph.id ? blocker : ""}
                  onBlocker={setBlocker}
                />
              ))
            ) : (
              <li className="text-sm text-muted-foreground">
                No graphs match this filter. Queue a numbered list or a “then” job, or ask FRIDAY to
                run it in the background.
              </li>
            )}
          </ul>
          {errors ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-destructive">
              {errors}
            </pre>
          ) : null}
        </Panel>

        <Panel
          title="Ask FRIDAY"
          hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            FRIDAY can see this live graph and ledger (queue, checkpoints, waiting approvals, last
            errors). Say task status, interrupt, resume, pause, pause all, cancel, retry, or run the
            task again — those buttons call the same engine.
          </p>
          <div className="mb-3 max-h-48 space-y-2 overflow-auto text-sm">
            {recent.length ? (
              recent.map((line) => (
                <p key={line.id} className="whitespace-pre-wrap">
                  <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                    {line.role === "user" ? "You" : "FRIDAY"}
                  </span>
                  {line.text}
                </p>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">
                No chat yet this session. Type below, or ask her what is running.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  askFriday();
                }
              }}
              placeholder="Task status · interrupt · resume task · pause all"
              className="h-8 text-sm"
              disabled={Boolean(brainState.activeRunId)}
            />
            <Button
              size="sm"
              disabled={!ask.trim() || Boolean(brainState.activeRunId)}
              onClick={askFriday}
            >
              Ask
            </Button>
          </div>
        </Panel>

        {live.length ? (
          <>
            {approvals.length ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={onApproveAll}>
                  Approve all
                </Button>
                <Button size="sm" variant="outline" onClick={onDenyAll}>
                  Deny all
                </Button>
              </div>
            ) : null}
            {live.map((task) => (
              <TaskPanel key={task.id} task={task} question={questionFor(task.id)} />
            ))}
          </>
        ) : (
          <Panel title="No task running" hint="live ledger">
            <p className="text-sm text-muted-foreground">
              FRIDAY has nothing on the live ledger right now. Chat, install, import, scan and
              repair still appear here with their own id, progress and approval gate — the graph
              above is the multi-step queue.
            </p>
          </Panel>
        )}

        {history.length ? (
          <Panel title="History" hint={`${history.length} completed`}>
            <ul className="space-y-2">
              {history.map((task) => (
                <li
                  key={task.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 pb-2 text-sm last:border-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{task.title}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {task.kind} · {time(task.startedAt)}
                      {task.error ? ` · ${task.error}` : ""}
                    </span>
                  </span>
                  <Badge variant="outline" className="label-xs">
                    {task.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel
          title="Background jobs"
          hint={background.running ? "scheduler on" : "scheduler idle"}
        >
          <ul className="space-y-2">
            {background.jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 last:border-0"
              >
                <span className="min-w-0">
                  <span className="block text-sm">{job.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    every {job.everyMinutes}m
                    {job.lastAt ? ` · last ${time(job.lastAt)}` : " · not run yet"}
                    {job.enabled ? "" : " · off"}
                  </span>
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => backgroundTasks.setEnabled(job.id, !job.enabled)}
                  >
                    {job.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void backgroundTasks.runNow(job.id)}
                  >
                    Run now
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] text-muted-foreground">
            {background.runs.length
              ? background.runs
                  .slice(0, 8)
                  .map((run) => `${time(run.at)} ${run.ok ? "ok" : "fail"} ${run.job} ${run.note}`)
                  .join("\n")
              : "No background runs recorded yet."}
          </pre>
        </Panel>
      </div>
    </AppShell>
  );
}
