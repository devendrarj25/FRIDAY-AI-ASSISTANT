import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Brain,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Gauge,
  Lightbulb,
  ListChecks,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { SelfCoreSection } from "@/components/friday/SelfCore";
import { FridayOrb } from "@/components/friday/FridayOrb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  StatTile,
  StatusPill,
  ToggleRow,
  toneForStatus,
} from "@/components/friday/ui";
import { brain } from "@/lib/friday/brain-engine";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useBrain } from "@/lib/friday/use-brain";
import { agentSpecs, identity, type AgentId } from "@/lib/friday/brain-catalog";
import { identity as fridayIdentity } from "@/lib/friday/brain/identity";
import { knowledgeStatus } from "@/lib/friday/brain/knowledge-base";
import { workspaceTilesFromScan } from "@/lib/friday/brain/section-sync";
import { useWorkspaceScan } from "@/lib/friday/desktop";
import { memoryTiers } from "@/lib/friday/self/memory-engine";
import { useLedger, useMemory } from "@/lib/friday/self/use-self";
import { brainKnowledge } from "@/lib/friday/brain/knowledge-base";
import { vectorIndex } from "@/lib/friday/brain/vector-index";
import { useBrainKnowledge, useVectorIndex } from "@/lib/friday/brain/use-brain-memory";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/brain")({
  head: () => ({
    meta: [
      { title: "Brain — FRIDAY Orchestration Core" },
      {
        name: "description",
        content:
          "FRIDAY's brain: intent analysis, agent selection, model routing, memory recall, permission-gated tools, self-improvement and the startup update flow.",
      },
      { property: "og:title", content: "Brain — FRIDAY Orchestration Core" },
      {
        property: "og:description",
        content:
          "The reasoning layer that turns a request into agents, models, memory and validated answers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BrainPage,
});

const STAGE_TONE = {
  pending: "muted",
  running: "warning",
  done: "accent",
  blocked: "destructive",
  skipped: "muted",
} as const;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "flow", label: "Request flow" },
  { key: "agents", label: "Agents" },
  { key: "knowledge", label: "Knowledge" },
  { key: "improve", label: "Self-improvement" },
  { key: "updates", label: "Updates" },
  { key: "workspace", label: "Workspace" },
  { key: "personality", label: "Personality" },
];

const relative = (at: number | null | undefined) => {
  if (!at) return "never";
  const diff = Date.now() - at;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

const ttlLabel = (ms: number) => {
  if (!ms) return "no expiry";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

function BrainPage() {
  const navigate = useNavigate();
  const state = useBrain();
  const voicePrefs = usePreferences();
  const memoryState = useMemory();
  const ledgerState = useLedger();
  const knowledge = useBrainKnowledge();
  const vector = useVectorIndex();
  const scan = useWorkspaceScan();
  const fridayPersona = useSyncExternalStore(
    fridayIdentity.subscribe,
    fridayIdentity.getSnapshot,
    fridayIdentity.getSnapshot,
  );
  const workspaceTiles = useMemo(() => workspaceTilesFromScan(scan), [scan]);
  const [tab, setTab] = useState("overview");
  const [input, setInput] = useState("");
  const [tick, setTick] = useState(0);

  // Keeps "last sync / last write" labels honest without re-rendering the page
  // on every frame.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  void tick;

  useEffect(() => {
    if (tab === "updates") brain.refreshUpdatesIfStale();
  }, [tab]);

  const run = state.runs[0];
  const activeAgents = useMemo(
    () => agentSpecs.filter((a) => state.agentsEnabled[a.id]).length,
    [state.agentsEnabled],
  );

  const tierRows = useMemo(
    () =>
      memoryTiers.map((spec) => {
        const count = memoryState.counts[spec.id] ?? 0;
        return { spec, count, pressure: Math.min(100, Math.round((count / spec.cap) * 100)) };
      }),
    [memoryState.counts],
  );

  const learning = useMemo(() => {
    const tasks = ledgerState.tasks ?? [];
    const done = tasks.filter((t) => t.status === "done").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const finished = done + failed;
    return {
      total: tasks.length,
      done,
      failed,
      running,
      successRate: finished ? Math.round((done / finished) * 100) : 0,
      recent: tasks.slice(0, 8),
    };
  }, [ledgerState.tasks]);

  const kbStats = useMemo(() => {
    // `knowledge` is the external-store revision that invalidates these stats.
    void knowledge;
    return brainKnowledge.stats();
  }, [knowledge]);

  const submit = () => {
    if (!input.trim()) return;
    brain.send(input);
    setInput("");
  };

  return (
    <AppShell
      title="Brain"
      subtitle={`${identity.name} · orchestration core`}
      actions={
        <Button size="sm" variant="outline" onClick={() => brain.propose()}>
          <Sparkles className="size-4" /> Self-review
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile
            icon={<Brain className="size-4" />}
            label="Brain core"
            value={state.activeRunId ? "Thinking" : "Active"}
            state={`${state.stats.requests} requests`}
          />
          <StatTile
            icon={<Users className="size-4" />}
            label="Agents"
            value={activeAgents}
            state={`${agentSpecs.length} defined`}
            tone="accent"
          />
          <StatTile
            icon={<ListChecks className="size-4" />}
            label="Tool calls"
            value={state.stats.toolCalls}
            state={`${state.stats.approvals} approvals`}
            tone="warning"
          />
          <StatTile
            icon={<Brain className="size-4" />}
            label="Memories"
            value={state.memory.length}
            state={`${state.memory.filter((m) => m.pinned).length} pinned`}
            tone="magenta"
          />
          <StatTile
            icon={<Cpu className="size-4" />}
            label="Avg run"
            value={`${(state.stats.avgMs / 1000).toFixed(1)}s`}
            state="end to end"
          />
          <StatTile
            icon={<Lightbulb className="size-4" />}
            label="Suggestions"
            value={state.suggestions.filter((s) => s.state === "pending").length}
            state="await confirmation"
            tone="warning"
          />
        </div>

        {state.approval ? (
          <HudPanel title="Approval required" hint={state.approval.risk}>
            <div className="flex flex-wrap items-start gap-3">
              <ShieldAlert className="mt-0.5 size-4 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {identity.name} wants to run{" "}
                  <span className="font-mono text-primary">{state.approval.tool}</span>
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  risk: {state.approval.risk} · {state.approval.reason}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => brain.approve(false)}>
                  Deny
                </Button>
                <Button size="sm" onClick={() => brain.approve(true)}>
                  Allow once
                </Button>
              </div>
            </div>
          </HudPanel>
        ) : null}

        <FilterTabs tabs={TABS} value={tab} onChange={setTab} />

        {tab === "overview" ? (
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <HudPanel
                title="Memory overview"
                hint={`${memoryState.items.length} records · last write ${relative(memoryState.lastWriteAt)}`}
                actions={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void navigate({ to: "/memory" })}
                  >
                    Open Memory →
                  </Button>
                }
              >
                <DataTable
                  columns={["Tier", "Records", "Cap", "Retention", "Pressure"]}
                  rows={tierRows.map(({ spec, count, pressure }) => [
                    <span key="t" className="text-foreground">
                      {spec.label}
                    </span>,
                    <span key="c" className="font-mono text-[11px] text-primary">
                      {count}
                    </span>,
                    <span key="p" className="font-mono text-[11px] text-muted-foreground">
                      {spec.cap}
                    </span>,
                    <span key="r" className="font-mono text-[11px] text-muted-foreground">
                      {ttlLabel(spec.ttlMs)}
                    </span>,
                    <span key="g" className="flex items-center gap-2">
                      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-border">
                        <span
                          className={cn(
                            "block h-full",
                            pressure > 85 ? "bg-warning" : "bg-primary",
                          )}
                          style={{ width: `${pressure}%` }}
                        />
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {pressure}%
                      </span>
                    </span>,
                  ])}
                />
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  Tiers expire and consolidate on their own — pinned records are never swept.
                </p>
              </HudPanel>

              <HudPanel
                title="Vector index"
                hint={
                  vector.available
                    ? `${vector.backend} · live`
                    : (vector.reason ?? "checking kernel…")
                }
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <StatTile
                    icon={<Database className="size-4" />}
                    label="Backend"
                    value={vector.backend ?? "—"}
                    state={vector.available ? "available" : "unavailable"}
                    tone={vector.available ? "accent" : "muted"}
                  />
                  <StatTile
                    icon={<RefreshCw className="size-4" />}
                    label="Synced"
                    value={vector.synced}
                    state={`last ${relative(vector.lastSyncAt)}`}
                  />
                </div>
                <div className="mt-3">
                  <ToggleRow
                    label="Auto-sync memory to the durable index"
                    hint="new semantic, episodic and permanent records every 5 minutes"
                    on={vector.autoSync}
                    onToggle={() => vectorIndex.setAutoSync(!vector.autoSync)}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={vector.busy}
                    onClick={() => void vectorIndex.syncLocalMemory()}
                  >
                    <RefreshCw className={cn("size-4", vector.busy && "animate-spin")} /> Sync now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={vector.busy}
                    onClick={() => void vectorIndex.reindex()}
                  >
                    Rebuild index
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void vectorIndex.refresh()}>
                    Refresh status
                  </Button>
                </div>
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  checked {relative(vector.checkedAt)}
                  {vector.reason ? ` · ${vector.reason}` : ""}
                </p>
              </HudPanel>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <HudPanel
                title="Learning signal"
                hint={`${learning.total} ledger tasks · ${learning.successRate}% success`}
              >
                <div className="grid gap-2 sm:grid-cols-4">
                  <StatTile
                    icon={<CheckCircle2 className="size-4" />}
                    label="Completed"
                    value={learning.done}
                    state="verified runs"
                    tone="accent"
                  />
                  <StatTile
                    icon={<ShieldAlert className="size-4" />}
                    label="Failed"
                    value={learning.failed}
                    state="repair candidates"
                    tone={learning.failed ? "warning" : "muted"}
                  />
                  <StatTile
                    icon={<Activity className="size-4" />}
                    label="Running"
                    value={learning.running}
                    state="in flight"
                  />
                  <StatTile
                    icon={<Gauge className="size-4" />}
                    label="Success"
                    value={`${learning.successRate}%`}
                    state="derived, not estimated"
                    tone="magenta"
                  />
                </div>
                <ul className="mt-3 space-y-1.5">
                  {learning.recent.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-foreground">{t.title}</span>
                      <StatusPill label={t.status} tone={toneForStatus(t.status)} />
                    </li>
                  ))}
                  {learning.recent.length ? null : (
                    <li className="font-mono text-[11px] text-muted-foreground">
                      No tasks recorded yet.
                    </li>
                  )}
                </ul>
              </HudPanel>

              <HudPanel
                title="Brain knowledge"
                hint={`${kbStats.entries} entries · updated ${relative(knowledge.updatedAt)}`}
              >
                <div className="grid gap-2 sm:grid-cols-3">
                  <StatTile
                    icon={<Brain className="size-4" />}
                    label="Entries"
                    value={kbStats.entries}
                    state={`${kbStats.permanent} permanent`}
                  />
                  <StatTile
                    icon={<ShieldAlert className="size-4" />}
                    label="Consent"
                    value={kbStats.awaitingConsent}
                    state="await your yes/no"
                    tone={kbStats.awaitingConsent ? "warning" : "muted"}
                  />
                  <StatTile
                    icon={<ListChecks className="size-4" />}
                    label="Unfinished"
                    value={kbStats.unfinishedTasks}
                    state="resume on restart"
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Object.entries(kbStats.byKind).map(([kind, count]) => (
                    <StatusPill key={kind} label={`${kind} ${count}`} tone="muted" />
                  ))}
                  {Object.keys(kbStats.byKind).length ? null : (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Nothing learned yet — knowledge is written from real runs.
                    </p>
                  )}
                </div>
              </HudPanel>
            </div>
          </div>
        ) : null}

        {tab === "flow" ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <HudPanel title="Conversation" hint={state.activeRunId ? "thinking" : "idle"}>
              <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1 text-sm">
                {state.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(m.role === "user" ? "ml-auto max-w-[85%]" : "max-w-[92%]")}
                  >
                    {m.role === "user" ? (
                      <p className="rounded-md bg-primary px-3 py-2 text-primary-foreground">
                        {m.text}
                      </p>
                    ) : (
                      <div className="rounded-md border border-primary/20 bg-surface px-3 py-2">
                        <p className="label-xs mb-1 text-primary">{identity.name}</p>
                        <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">
                          {m.text}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={`Give ${identity.name} a goal…`}
                  className="min-h-16 resize-none border-primary/25 bg-surface font-mono text-sm"
                />
                <div className="flex items-center justify-between gap-2">
                  <Button size="sm" variant="ghost" onClick={() => brain.clearChat()}>
                    <Trash2 className="size-4" /> Clear session
                  </Button>
                  <Button
                    size="sm"
                    onClick={submit}
                    disabled={!input.trim() || !!state.activeRunId}
                  >
                    <Send className="size-4" /> Send
                  </Button>
                </div>
              </div>
            </HudPanel>

            <div className="space-y-4">
              <HudPanel
                title="Request flow"
                hint={
                  run ? `${run.intentLabel} · ${Math.round(run.confidence * 100)}%` : "no run yet"
                }
              >
                {run ? (
                  <ol className="space-y-1.5">
                    {run.stages.map((s) => (
                      <li
                        key={s.id}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2"
                      >
                        <span
                          className={cn(
                            "mt-1.5 size-2 rounded-full",
                            s.state === "done" && "bg-accent shadow-[0_0_8px_var(--color-accent)]",
                            s.state === "running" && "bg-warning pulse-dot",
                            s.state === "pending" && "bg-muted-foreground/50",
                            s.state === "blocked" && "bg-destructive",
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-xs text-foreground">{s.label}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {s.detail}
                          </p>
                        </div>
                        <StatusPill label={s.state} tone={STAGE_TONE[s.state]} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Send a request to watch the pipeline execute.
                  </p>
                )}
              </HudPanel>

              <HudPanel title="Agents on this run">
                {run?.agents.length ? (
                  <DataTable
                    columns={["Agent", "Task", "Model", "State", "Tokens"]}
                    rows={run.agents.map((a) => [
                      <span key="n" className="text-foreground">
                        {a.name}
                      </span>,
                      <span key="t" className="font-mono text-[11px] text-muted-foreground">
                        {a.task}
                      </span>,
                      <span key="m" className="font-mono text-[11px] text-primary">
                        {a.modelLabel}
                      </span>,
                      <StatusPill key="s" label={a.state} tone={toneForStatus(a.state)} />,
                      <span key="k" className="font-mono text-[11px] text-muted-foreground">
                        {a.tokens || "—"}
                      </span>,
                    ])}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Agents are selected per request from intent.
                  </p>
                )}
              </HudPanel>

              <HudPanel
                title="Memory recalled"
                hint="Brain session layers — Memory page uses the six-tier store"
              >
                {run?.recalled.length ? (
                  <ul className="space-y-1.5">
                    {run.recalled.map((r) => (
                      <li key={r.id} className="text-xs">
                        <span className="font-mono text-[10px] text-primary">[{r.layer}]</span>{" "}
                        <span className="text-foreground">{r.title}</span>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {r.snippet}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nothing recalled for the current run.
                  </p>
                )}
              </HudPanel>
            </div>
          </div>
        ) : null}

        {tab === "agents" ? (
          <HudPanel
            title="Agent system"
            hint={`${activeAgents}/${agentSpecs.length} active`}
            actions={
              <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/agents" })}>
                Open Agents →
              </Button>
            }
          >
            <DataTable
              columns={["Agent", "Duty", "Routed task", "Tools", "Risk", "State"]}
              rows={agentSpecs.map((a) => [
                <span key="n" className="text-foreground">
                  {a.name}
                </span>,
                <span key="d" className="text-xs text-muted-foreground">
                  {a.duty}
                </span>,
                <span key="t" className="font-mono text-[11px] text-primary">
                  {a.task}
                </span>,
                <span key="o" className="font-mono text-[10px] text-muted-foreground">
                  {a.tools.join(", ")}
                </span>,
                <StatusPill
                  key="r"
                  label={a.risk}
                  tone={
                    a.risk === "safe" ? "accent" : a.risk === "write" ? "warning" : "destructive"
                  }
                />,
                <button
                  key="s"
                  type="button"
                  onClick={() => brain.toggleAgent(a.id as AgentId)}
                  className="font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                >
                  {state.agentsEnabled[a.id] ? "Active — pause" : "Paused — activate"}
                </button>,
              ])}
            />
          </HudPanel>
        ) : null}

        {tab === "knowledge" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <HudPanel
              title="What FRIDAY has learned"
              hint={`${knowledge.entries.length} entries · updated ${relative(knowledge.updatedAt)}`}
            >
              <DataTable
                columns={["Kind", "Title", "Source", "Confidence", ""]}
                rows={knowledge.entries.slice(0, 60).map((entry) => [
                  <StatusPill key="k" label={entry.kind} tone="muted" />,
                  <span key="t" className="text-foreground">
                    {entry.title}
                    {entry.permanent ? (
                      <span className="ml-2 font-mono text-[10px] text-accent">permanent</span>
                    ) : null}
                    {knowledgeStatus(entry) !== "known" ? (
                      <span className="ml-2 font-mono text-[10px] text-warning">
                        {knowledgeStatus(entry)}
                      </span>
                    ) : null}
                  </span>,
                  <span key="s" className="font-mono text-[11px] text-muted-foreground">
                    {entry.source}
                  </span>,
                  <span key="c" className="font-mono text-[11px] text-primary">
                    {Math.round(entry.confidence * 100)}%
                  </span>,
                  <button
                    key="f"
                    type="button"
                    onClick={() => brainKnowledge.forget(entry.id)}
                    className="font-mono text-[10px] text-destructive hover:underline"
                  >
                    forget
                  </button>,
                ])}
              />
              {knowledge.entries.length ? null : (
                <p className="font-mono text-[11px] text-muted-foreground">
                  Nothing learned yet — entries are written from real runs, never seeded.
                </p>
              )}
            </HudPanel>
            <div className="space-y-4">
              <HudPanel title="Awaiting your consent" hint={`${knowledge.consent.length} pending`}>
                <ul className="space-y-3">
                  {knowledge.consent.map((req) => (
                    <li key={req.id} className="border-b border-border/60 pb-3 last:border-0">
                      <p className="text-sm text-foreground">{req.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{req.body}</p>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {req.reason} · {relative(req.at)}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => brainKnowledge.decideConsent(req.id, false)}
                        >
                          Deny
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => brainKnowledge.decideConsent(req.id, true)}
                        >
                          Remember it
                        </Button>
                      </div>
                    </li>
                  ))}
                  {knowledge.consent.length ? null : (
                    <li className="font-mono text-[11px] text-muted-foreground">
                      Nothing is waiting for approval.
                    </li>
                  )}
                </ul>
              </HudPanel>
              <HudPanel title="Unfinished work" hint={`${kbStats.unfinishedTasks} to resume`}>
                <ul className="space-y-2">
                  {knowledge.tasks
                    .filter((t) => t.status !== "done")
                    .slice(0, 10)
                    .map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-foreground">{t.title}</span>
                        <StatusPill label={t.status} tone={toneForStatus(t.status)} />
                      </li>
                    ))}
                  {kbStats.unfinishedTasks ? null : (
                    <li className="font-mono text-[11px] text-muted-foreground">
                      Everything FRIDAY started is finished.
                    </li>
                  )}
                </ul>
              </HudPanel>
            </div>
          </div>
        ) : null}

        {tab === "improve" ? (
          <HudPanel
            title="Self-improvement"
            hint="nothing applies without your confirmation"
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/self-management" })}
              >
                Open Self-Management →
              </Button>
            }
          >
            <ul className="space-y-2">
              {state.suggestions.map((s) => (
                <li
                  key={s.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border/60 py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill label={s.kind} tone="primary" />
                      <StatusPill
                        label={`${s.impact} impact`}
                        tone={s.impact === "high" ? "warning" : "muted"}
                      />
                      <p className="text-sm text-foreground">{s.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                  </div>
                  {s.state === "pending" ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => brain.resolveSuggestion(s.id, false)}
                      >
                        Dismiss
                      </Button>
                      <Button size="sm" onClick={() => brain.resolveSuggestion(s.id, true)}>
                        Apply
                      </Button>
                    </div>
                  ) : (
                    <StatusPill label={s.state} tone={s.state === "applied" ? "accent" : "muted"} />
                  )}
                </li>
              ))}
            </ul>
          </HudPanel>
        ) : null}

        {tab === "updates" ? (
          <HudPanel
            title="Startup update flow"
            hint={state.checkingUpdates ? "checking…" : "confirm before install"}
            actions={
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void brain.checkUpdates()}
                  disabled={state.checkingUpdates}
                >
                  <RefreshCw className={cn("size-4", state.checkingUpdates && "animate-spin")} />{" "}
                  Check now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/settings",
                      search: { section: "updates" } as never,
                    })
                  }
                >
                  Open Updates settings →
                </Button>
              </div>
            }
          >
            <DataTable
              columns={["Target", "Channel", "Installed", "Latest", "Notes", ""]}
              rows={state.updates.map((u) => [
                <span key="t" className="text-foreground">
                  {u.label}
                </span>,
                <span key="c" className="font-mono text-[10px] text-muted-foreground">
                  {u.channel}
                </span>,
                <span key="i" className="font-mono text-[11px] text-muted-foreground">
                  {u.installed}
                </span>,
                <span key="l" className="font-mono text-[11px] text-primary">
                  {u.latest}
                </span>,
                <span
                  key="n"
                  className="block max-w-[22rem] truncate text-xs text-muted-foreground"
                >
                  {u.notes}
                </span>,
                u.state === "available" ? (
                  <Button key="a" size="sm" onClick={() => brain.applyUpdate(u.id)}>
                    <Download className="size-4" /> Install
                  </Button>
                ) : (
                  <StatusPill
                    key="a"
                    label={u.state}
                    tone={
                      u.state === "installed" || u.state === "up-to-date" ? "accent" : "warning"
                    }
                  />
                ),
              ])}
            />
          </HudPanel>
        ) : null}

        {tab === "workspace" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <HudPanel
              title="FRIDAY workspace"
              hint={
                scan?.root
                  ? `${scan.folders?.length ?? scan.present?.length ?? 0} folders · scanned ${relative(scan.scannedAt)}`
                  : "one root, kept organised"
              }
              actions={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/workspace" })}
                >
                  Open Folders →
                </Button>
              }
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {workspaceTiles.map((f) => (
                  <div key={f.name} className="hud-tile rounded-md px-2.5 py-2">
                    <p className="font-mono text-xs text-primary">FRIDAY/{f.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{f.note}</p>
                  </div>
                ))}
              </div>
            </HudPanel>
            <HudPanel title="Task scheduler">
              <ul className="space-y-2">
                {state.schedule.map((j) => (
                  <li
                    key={j.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 py-1.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{j.title}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {j.when} · {j.agent} · last {j.lastRun}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => brain.toggleJob(j.id)}
                      className="font-mono text-[10px] text-primary hover:underline"
                    >
                      {j.enabled ? "enabled" : "paused"}
                    </button>
                  </li>
                ))}
              </ul>
            </HudPanel>
          </div>
        ) : null}

        {tab === "personality" ? (
          <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
            <HudPanel bodyClassName="grid place-items-center p-6">
              <FridayOrb size={140} />
              <p className="mt-3 font-display text-xl font-bold tracking-[0.2em] text-primary glow-text">
                {identity.name}
              </p>
              <p className="label-xs mt-1 text-accent">{identity.role}</p>
              <p className="mt-2 text-center font-mono text-[11px] text-muted-foreground">
                Creator {identity.owner} · {identity.handle}
              </p>
              <p className="mt-2 text-center text-xs text-muted-foreground">{identity.voice}</p>
            </HudPanel>
            <div className="space-y-4">
              <HudPanel title="Behaviour">
                <div className="flex flex-wrap gap-1.5">
                  {(fridayPersona.profile.traits.length
                    ? fridayPersona.profile.traits
                    : identity.traits
                  ).map((t) => (
                    <StatusPill key={t} label={t} tone="primary" />
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{identity.charter}</p>
              </HudPanel>
              <HudPanel title="Brain settings">
                <ToggleRow
                  label="Confirm important changes"
                  hint="write and exec tools always ask first"
                  on={state.settings.confirmImportant}
                  onToggle={() => brain.toggleSetting("confirmImportant")}
                />
                <ToggleRow
                  label="Learn from conversations"
                  hint="write memories after each run"
                  on={state.settings.autoLearn}
                  onToggle={() => brain.toggleSetting("autoLearn")}
                />
                <ToggleRow
                  label="Multi-model answers"
                  hint="run every selected agent, then merge"
                  on={state.settings.multiModel}
                  onToggle={() => brain.toggleSetting("multiModel")}
                />
                <ToggleRow
                  label="Use knowledge base"
                  hint="recall approved documents"
                  on={state.settings.useKnowledge}
                  onToggle={() => brain.toggleSetting("useKnowledge")}
                />
                <ToggleRow
                  label="Use project memory"
                  hint="recall per-repository facts"
                  on={state.settings.useProjectMemory}
                  onToggle={() => brain.toggleSetting("useProjectMemory")}
                />
                <ToggleRow
                  label="Spoken replies"
                  hint="Auto mode only. Manual and chat stay silent"
                  on={voicePrefs.voice.speakReplies}
                  onToggle={() => {
                    const next = !voicePrefs.voice.speakReplies;
                    preferences.setVoice({ speakReplies: next });
                    if (state.settings.voiceReplies !== next) brain.toggleSetting("voiceReplies");
                  }}
                />
                <ToggleRow
                  label="Propose improvements"
                  hint="self-review after every third run"
                  on={state.settings.selfImprove}
                  onToggle={() => brain.toggleSetting("selfImprove")}
                />
                <ToggleRow
                  label="Check updates on startup"
                  hint="app, plugins, modules, agents, providers"
                  on={state.settings.checkUpdatesOnStart}
                  onToggle={() => brain.toggleSetting("checkUpdatesOnStart")}
                />
              </HudPanel>
            </div>
          </div>
        ) : null}

        <SelfCoreSection />

        <HudPanel title="Brain log" hint={`${state.log.length} lines`}>
          <pre className="max-h-56 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed">
            {state.log.map((l) => (
              <div
                key={l.id}
                className={
                  l.level === "ok"
                    ? "text-accent"
                    : l.level === "warn"
                      ? "text-warning"
                      : l.level === "error"
                        ? "text-destructive"
                        : "text-muted-foreground"
                }
              >
                <span className="text-primary/60">{l.at}</span> {l.line}
              </div>
            ))}
          </pre>
        </HudPanel>

        <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <CheckCircle2 className="size-3 text-accent" /> FRIDAY orchestrates models — she never
          retrains or claims ownership of them.
        </p>
      </div>
    </AppShell>
  );
}
