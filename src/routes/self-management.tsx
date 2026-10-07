import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  Database,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { SelfAutonomyPanels } from "@/components/friday/SelfAutonomyPanels";
import { HudPanel, StatTile, StatusPill } from "@/components/friday/ui";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/friday/clipboard";
import { doctor } from "@/lib/friday/doctor-engine";
import { useDoctor } from "@/lib/friday/use-doctor";
import { memoryTiers } from "@/lib/friday/self/memory-engine";
import { diagnoseNow, currentDiagnosis } from "@/lib/friday/self/self-section";
import { self } from "@/lib/friday/self/self-manager";
import { ledger } from "@/lib/friday/self/task-ledger";
import {
  useCapabilityMatrix,
  useLedger,
  useMemory,
  useSelf,
  useTaskGraph,
} from "@/lib/friday/self/use-self";
import { devPipeline, type DevRunState } from "@/lib/friday/self/dev-pipeline";
import { systemMap, type MapStatus } from "@/lib/friday/system-map";
import { useDevPipeline, useSystemMap } from "@/lib/friday/use-system-map";
import { taskGraph } from "@/lib/friday/self/task-graph";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/self-management")({
  head: () => ({
    meta: [
      { title: "Self-Management — FRIDAY Console" },
      {
        name: "description",
        content:
          "FRIDAY's self-diagnosis, self-repair, self-upgrade and self-growth center with a six-tier memory, a live task ledger and approval gates on every risky change.",
      },
      { property: "og:title", content: "Self-Management — FRIDAY Console" },
      {
        property: "og:description",
        content:
          "Watch FRIDAY diagnose, repair, upgrade and improve itself — every action tracked, reversible and approved.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SelfManagementPage,
});

type Tone = "primary" | "accent" | "warning" | "magenta" | "destructive" | "muted";

const levelTone: Record<string, Tone> = {
  ok: "accent",
  warn: "warning",
  error: "destructive",
  unknown: "muted",
};

const stateTone: Record<string, Tone> = {
  done: "accent",
  running: "warning",
  "awaiting-approval": "warning",
  failed: "destructive",
  "rolled-back": "warning",
  queued: "muted",
  cancelled: "muted",
  timeout: "destructive",
};

const devTone: Record<DevRunState, Tone> = {
  running: "warning",
  "waiting-approval": "warning",
  applied: "accent",
  blocked: "muted",
  failed: "destructive",
  rejected: "muted",
  "rolled-back": "warning",
};

const mapTone: Record<MapStatus, Tone> = {
  ready: "accent",
  running: "primary",
  degraded: "warning",
  idle: "muted",
  stopped: "destructive",
  missing: "destructive",
  unknown: "muted",
};

const ago = (ts: number) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

function SelfManagementPage() {
  const navigate = useNavigate();
  const state = useSelf();
  const mem = useMemory();
  const tasks = useLedger();
  const dev = useDevPipeline();
  const map = useSystemMap();
  const doc = useDoctor();
  const abilities = useCapabilityMatrix();
  const graphState = useTaskGraph();
  const [request, setRequest] = useState("");
  const [tick, setTick] = useState(0);
  const [diagnosing, setDiagnosing] = useState(false);
  const [mapProblemsOnly, setMapProblemsOnly] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  void tick;

  useEffect(() => {
    self.pulse();
    systemMap.refresh();
    const id = window.setInterval(() => {
      self.pulse();
      systemMap.refresh();
    }, 8_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    self.pulse();
  }, [doc.lastScanAt]);

  const startDev = () => {
    const text = request.trim();
    if (!text) {
      toast.message("Describe the improvement first");
      return;
    }
    devPipeline.start(text);
    setRequest("");
  };

  const runDiagnose = () => {
    setDiagnosing(true);
    void diagnoseNow()
      .then((result) => {
        toast[result.problems ? "message" : "success"](
          result.problems
            ? `${result.problems} issue(s) — see proposals and Setup & Doctor`
            : "Nothing flagged on this pass",
        );
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setDiagnosing(false));
  };

  const copyReport = () => {
    void copyText(currentDiagnosis()).then((ok) =>
      toast[ok ? "success" : "error"](ok ? "Diagnosis copied" : "Copying was blocked"),
    );
  };

  const openProposals = state.proposals.filter((p) => p.state === "open");
  const running = tasks.tasks.filter(
    (t) => t.status === "running" || t.status === "awaiting-approval",
  );
  const mapRows = mapProblemsOnly
    ? map.entries.filter(
        (entry) =>
          entry.status === "degraded" || entry.status === "stopped" || entry.status === "missing",
      )
    : map.entries;
  const liveGraphs = graphState.graphs.filter((g) =>
    ["queued", "running", "paused"].includes(g.state),
  );

  return (
    <AppShell
      title="Self-Management"
      subtitle={`Diagnosis · repair · upgrade · growth — pulsed ${ago(state.lastPulseAt)}`}
    >
      <div className="grid gap-4">
        {/* -------------------------------------------------- health signals */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {state.signals.map((s) => (
            <StatTile
              key={s.id}
              label={s.label}
              value={
                s.level === "ok"
                  ? "Healthy"
                  : s.level === "unknown"
                    ? "Unknown"
                    : s.level === "warn"
                      ? "Attention"
                      : "Problem"
              }
              state={s.detail}
              tone={levelTone[s.level] ?? "muted"}
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={diagnosing} onClick={runDiagnose}>
            <ShieldCheck className={cn("mr-1.5 h-3.5 w-3.5", diagnosing && "animate-pulse")} />{" "}
            Diagnose now
          </Button>
          <Button size="sm" variant="outline" onClick={copyReport}>
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy report
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/doctor" })}>
            Open Doctor →
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({ to: "/settings", search: { section: "updates" } as never })
            }
          >
            Open Updates →
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/tasks" })}>
            Open Tasks →
          </Button>
        </div>

        <HudPanel
          title="Last diagnosis"
          hint={state.lastPulseAt ? `folded ${ago(state.lastPulseAt)}` : "run Diagnose now"}
        >
          <p className="max-h-[220px] overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
            {currentDiagnosis()}
          </p>
        </HudPanel>

        {abilities.scores.length > 0 && (
          <HudPanel
            title="Measured ability"
            hint={
              abilities.at
                ? `updated ${ago(abilities.at)}`
                : "declared baselines until real runs exist"
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {abilities.scores.map((score) => (
                <StatTile
                  key={score.domain}
                  label={score.label}
                  value={`${score.score}`}
                  state={
                    score.provisional
                      ? "baseline — no measured runs yet"
                      : `${score.successes}/${score.runs} verified`
                  }
                  tone={score.provisional ? "muted" : score.score >= 70 ? "accent" : "warning"}
                />
              ))}
            </div>
          </HudPanel>
        )}

        {/* ------------------------------------------------ pending approvals */}
        {tasks.approvals.length > 0 && (
          <HudPanel title="Waiting for your approval">
            <div className="grid gap-2">
              {tasks.approvals.map((a) => (
                <div
                  key={a.taskId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2"
                >
                  <p className="text-sm text-foreground">{a.question}</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => ledger.answerApproval(a.taskId, true)}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => ledger.answerApproval(a.taskId, false)}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </HudPanel>
        )}

        {/* --------------------------- autonomy · core · approvals · maintenance */}
        <SelfAutonomyPanels />

        <div className="grid gap-4 xl:grid-cols-2">
          {/* ------------------------------------------------------ proposals */}
          <HudPanel
            title="Improvements FRIDAY proposes"
            actions={
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => self.pulse()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Re-check
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const n = self.autoSafeFix();
                    toast[n ? "success" : "message"](
                      n ? `${n} safe repair(s) started` : "Nothing safe to repair right now",
                    );
                  }}
                >
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Auto safe fix
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!openProposals.length}
                  onClick={() => {
                    const n = self.dismissOpen();
                    toast.message(n ? `${n} proposal(s) dismissed` : "Nothing open to dismiss");
                  }}
                >
                  Dismiss all
                </Button>
              </div>
            }
          >
            {openProposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No proposals. FRIDAY only suggests changes when a real signal — a failed task, a
                broken check, a missing dependency — justifies one.
              </p>
            ) : (
              <div className="grid gap-2">
                {openProposals.map((p) => (
                  <div key={p.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{p.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{p.rationale}</p>
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                          evidence · {p.evidence}
                        </p>
                      </div>
                      <StatusPill
                        label={p.risk}
                        tone={
                          p.risk === "safe"
                            ? "accent"
                            : p.risk === "review"
                              ? "warning"
                              : "destructive"
                        }
                      />
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (p.kind === "maintenance") {
                            if (!self.adopt(p)) {
                              toast.error("That change is no longer pending — rescan the project.");
                            }
                            return;
                          }
                          if (p.kind === "repair") {
                            const checkId = p.id.split(":")[1];
                            const check = doctor.getSnapshot().checks.find((c) => c.id === checkId);
                            if (!check) {
                              toast.error("That check is no longer reported — re-run the doctor.");
                              return;
                            }
                            self.repair(check);
                            return;
                          }
                          self.grow(p);
                        }}
                      >
                        Start <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => self.dismiss(p.id)}>
                        <Ban className="mr-1.5 h-3.5 w-3.5" /> Dismiss
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </HudPanel>

          {/* ----------------------------------------------------- lifecycles */}
          <HudPanel title="Lifecycles">
            {state.lifecycles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing has run yet. Repairs, upgrades and improvements show every stage here as
                they happen.
              </p>
            ) : (
              <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1">
                {state.lifecycles.map((lc) => (
                  <div key={lc.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{lc.title}</p>
                      <StatusPill label={lc.state} tone={stateTone[lc.state] ?? "muted"} />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {lc.taskId} · {ago(lc.startedAt)}
                    </p>
                    <ol className="mt-2 grid gap-1">
                      {lc.stages.map((s) => (
                        <li key={s.id} className="flex items-start gap-2 text-xs">
                          <span
                            className={cn(
                              "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                              s.state === "done" && "bg-emerald-400",
                              s.state === "running" && "bg-amber-400 animate-pulse",
                              s.state === "failed" && "bg-rose-400",
                              s.state === "skipped" && "bg-muted-foreground/50",
                              s.state === "pending" && "bg-muted-foreground/25",
                            )}
                          />
                          <span className="text-muted-foreground">
                            <span className="text-foreground/90">{s.label}</span>
                            {s.detail ? ` — ${s.detail}` : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {lc.summary && (
                      <p className="mt-2 text-xs text-muted-foreground">{lc.summary}</p>
                    )}
                    {lc.state === "running" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2"
                        onClick={() => self.cancel(lc.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </HudPanel>
        </div>

        {/* ------------------------------------------------------------ memory */}
        <HudPanel
          title="Memory"
          hint={`${mem.items.length} records across ${memoryTiers.length} tiers`}
          actions={
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/memory" })}>
              <Database className="size-4" /> Open Memory →
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {memoryTiers.map((t) => (
              <div key={t.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</p>
                <p className="text-xl font-semibold text-foreground">{mem.counts[t.id]}</p>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t.note}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Search, teach, pin, forget, backup and the vector index live in the Memory section.
          </p>
        </HudPanel>

        {/* --------------------------------------------- brain / core development */}
        <HudPanel
          title="Brain & core development"
          actions={
            <StatusPill
              label={dev.busy ? "working" : `${dev.runs.length} run(s)`}
              tone={dev.busy ? "warning" : "muted"}
            />
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="Describe an improvement — e.g. make voice replies faster"
              className="h-9 flex-1 min-w-[240px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") startDev();
              }}
            />
            <Button size="sm" onClick={startDev} disabled={dev.busy}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Analyze & plan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => devPipeline.clearHistory()}>
              Clear history
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            FRIDAY analyses the request against her own source map, plans the change, scans the
            workspace with a restorable backup and stops for your approval before anything is
            applied.
          </p>
          <div className="mt-3 grid gap-2">
            {dev.runs.slice(0, 6).map((run) => (
              <div key={run.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm text-foreground">{run.request}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{run.summary}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill label={run.state} tone={devTone[run.state] ?? "muted"} />
                    {run.state === "waiting-approval" && (
                      <>
                        <Button size="sm" onClick={() => devPipeline.approve(run.id)}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => devPipeline.reject(run.id)}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {run.state === "applied" && run.backup && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void devPipeline.rollback(run.id).then((undone) => {
                            toast[undone.ok ? "success" : "error"](
                              undone.ok
                                ? "Previous files restored"
                                : (undone.error ?? "Rollback failed"),
                            );
                          });
                        }}
                      >
                        Rollback
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {run.stages.map((s) => (
                    <span
                      key={s.id}
                      title={s.detail}
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                        s.state === "done"
                          ? "border-emerald-500/40 text-emerald-300"
                          : s.state === "running"
                            ? "border-amber-500/40 text-amber-300"
                            : s.state === "failed"
                              ? "border-rose-500/40 text-rose-300"
                              : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {s.label}
                    </span>
                  ))}
                </div>
                {run.plan.length > 0 && (
                  <ul className="mt-2 grid gap-0.5 text-[11px] text-muted-foreground">
                    {run.plan.map((step, i) => (
                      <li key={i}>· {step}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                  {run.id} · {ago(run.createdAt)}
                  {run.areas.length ? ` · ${run.areas.join(", ")}` : ""}
                </p>
              </div>
            ))}
            {dev.runs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No development runs yet. Describe an improvement above and FRIDAY will inspect her
                own code before proposing anything.
              </p>
            )}
          </div>
        </HudPanel>

        {/* ------------------------------------------------- application map */}
        <HudPanel
          title="Application map"
          actions={
            <div className="flex items-center gap-2">
              <StatusPill
                label={map.health.ok ? "healthy" : `${map.health.errors.length} problem(s)`}
                tone={map.health.ok ? "accent" : "destructive"}
              />
              <Button size="sm" variant="outline" onClick={() => systemMap.refresh()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMapProblemsOnly((on) => !on)}>
                {mapProblemsOnly ? "Show all" : "Problems only"}
              </Button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {map.groups.map((g) => (
              <StatTile
                key={g.group}
                label={g.group}
                value={`${g.ready}/${g.total}`}
                state={
                  g.problems
                    ? `${g.problems} problem(s)${g.idle ? ` · ${g.idle} idle` : ""}`
                    : g.idle
                      ? `all reporting · ${g.idle} not configured`
                      : "all reporting"
                }
                tone={g.problems ? "destructive" : "accent"}
              />
            ))}
          </div>
          <div className="mt-3 grid max-h-[300px] gap-1.5 overflow-y-auto pr-1">
            {mapRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {mapProblemsOnly
                  ? "No degraded, stopped, or missing components."
                  : "Map is empty — Refresh after Diagnose now."}
              </p>
            ) : (
              mapRows.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{entry.label}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground/70">
                      {entry.id}
                      {entry.version ? ` · ${entry.version}` : ""} · {entry.detail}
                    </p>
                  </div>
                  <StatusPill label={entry.status} tone={mapTone[entry.status] ?? "muted"} />
                </div>
              ))
            )}
          </div>
        </HudPanel>

        {/* ------------------------------------------------------ task ledger */}
        <HudPanel
          title="Task ledger"
          actions={
            <div className="flex gap-2">
              <StatusPill
                label={`${running.length} running`}
                tone={running.length ? "warning" : "accent"}
              />
              <Button size="sm" variant="ghost" onClick={() => ledger.clearHistory()}>
                Clear history
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!running.length}
                onClick={() => ledger.cancelAll()}
              >
                Cancel all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void copyText(JSON.stringify(tasks.tasks, null, 2)).then((ok) =>
                    toast[ok ? "success" : "error"](ok ? "Ledger copied" : "Copying was blocked"),
                  );
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy ledger
              </Button>
              <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/tasks" })}>
                Open Tasks →
              </Button>
            </div>
          }
        >
          {tasks.tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tasks yet. Every diagnosis, repair, upgrade and improvement gets its own ID here.
            </p>
          ) : (
            <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
              {tasks.tasks.map((t) => (
                <div key={t.id} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {t.status === "done" ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : t.status === "failed" || t.status === "timeout" ? (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      ) : (
                        <Clock className="h-4 w-4 text-amber-400" />
                      )}
                      <p className="text-sm text-foreground">
                        <span className="text-muted-foreground">{t.kind}</span> · {t.title}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill label={t.status} tone={stateTone[t.status] ?? "muted"} />
                      {(t.status === "running" || t.status === "awaiting-approval") && (
                        <Button size="sm" variant="ghost" onClick={() => ledger.cancel(t.id)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground/70">
                    {t.id} · {ago(t.startedAt)}
                    {t.error ? ` · ${t.error}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </HudPanel>

        <HudPanel
          title="Durable work"
          hint={`${graphState.queue.length} queued · same graph as Tasks`}
          actions={
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/tasks" })}>
              Open Tasks →
            </Button>
          }
        >
          {liveGraphs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No owner or idle graphs running. Long requests checkpoint here so a restart can
              continue instead of starting over.
            </p>
          ) : (
            <div className="grid gap-2">
              {liveGraphs.map((graph) => {
                const done = graph.nodes.filter(
                  (n) => n.state === "completed" || n.state === "verified",
                );
                const current = graph.nodes.find(
                  (n) => n.state === "running" || n.state === "ready",
                );
                return (
                  <div
                    key={graph.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{graph.request}</p>
                      <p className="font-mono text-[11px] text-muted-foreground/70">
                        {done.length}/{graph.nodes.length} subtasks
                        {current ? ` · next: ${current.title}` : ""}
                        {graph.priority === "idle" ? " · idle self-work" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill label={graph.state} tone={stateTone[graph.state] ?? "muted"} />
                      {graph.state === "running" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => taskGraph.interrupt(graph.id)}
                        >
                          Interrupt
                        </Button>
                      )}
                      {graph.state === "paused" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => taskGraph.resume(graph.id)}
                        >
                          Resume
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </HudPanel>
      </div>
    </AppShell>
  );
}
