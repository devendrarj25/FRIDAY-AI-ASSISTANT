/**
 * FRIDAY · Self-Management control panels
 *
 * Real controls for the autonomy policy store, the autonomous improvement
 * core, the background scheduler, the governance approval gate and the desktop
 * self-maintenance bridge. Everything here reads and writes the live stores —
 * no mock state, no fake status. In the browser preview the desktop-only
 * maintenance bridge reports that it needs the installed app instead of
 * pretending work happened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Cpu, Play, RefreshCw, RotateCcw, ShieldCheck, Square } from "lucide-react";
import { toast } from "sonner";
import { HudPanel, StatTile, StatusPill } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { copyText } from "@/lib/friday/clipboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { autonomy, type AutonomySettings } from "@/lib/friday/self/autonomy";
import { governance, type GovItem } from "@/lib/friday/self/governance";
import { autonomousCore } from "@/lib/friday/self/autonomous-core";
import { backgroundTasks } from "@/lib/friday/self/background-tasks";
import { self } from "@/lib/friday/self/self-manager";
import {
  explainVerdict,
  onSelfProgress,
  selfApply,
  selfBridgeAvailable,
  selfHealth,
  selfIndex,
  selfScan,
  selfState,
  selfVerify,
  type ImpactEntry,
  type IndexSummary,
} from "@/lib/friday/self/maintenance-bridge";
import { approvalFirst } from "@/lib/friday/self/self-section";
import {
  useAutonomousCore,
  useAutonomy,
  useBackgroundTasks,
  useGovernance,
  useSelf,
} from "@/lib/friday/self/use-self";
import { cn } from "@/lib/utils";

const ago = (ts: number) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <p className="text-sm text-foreground">{label}</p>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <p className="text-sm text-foreground">{label}</p>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      <Input
        type="number"
        className="h-8 text-xs"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------ autonomy */

function AutonomyPanel() {
  const settings = useAutonomy();
  const patch = (p: Partial<AutonomySettings>) => autonomy.update(p);

  return (
    <HudPanel
      title="Autonomy & policy"
      hint="How much FRIDAY may do on her own. Saved to disk — a restart keeps this exact policy."
      actions={
        <div className="flex items-center gap-2">
          <StatusPill
            label={settings.autonomyEnabled ? settings.approvalLevel : "paused"}
            tone={settings.autonomyEnabled ? "accent" : "muted"}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              autonomy.reset();
              toast.success("Autonomy policy reset to FRIDAY's defaults");
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Defaults
          </Button>
        </div>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Toggle
          label="Autonomous work"
          hint="Master switch for the idle improvement worker."
          checked={settings.autonomyEnabled}
          onChange={(v) => patch({ autonomyEnabled: v })}
        />
        <Choice
          label="Approval level"
          hint="Strict asks for everything · balanced auto-runs safe work · trusted also auto-runs reviewed work."
          value={settings.approvalLevel}
          onChange={(approvalLevel) => patch({ approvalLevel })}
          options={[
            { value: "strict", label: "Strict — ask every time" },
            { value: "balanced", label: "Balanced — safe work runs" },
            { value: "trusted", label: "Trusted — safe + reviewed run" },
          ]}
        />
        <Choice
          label="Update policy"
          hint="How new FRIDAY builds are handled once verified."
          value={settings.updatePolicy}
          onChange={(updatePolicy) => patch({ updatePolicy })}
          options={[
            { value: "manual", label: "Manual — never install on its own" },
            { value: "stage", label: "Stage — prepare, then ask" },
            { value: "auto-safe", label: "Auto-safe — install verified builds" },
          ]}
        />
        <Toggle
          label="Research"
          hint="Read from the approved source list while improving herself."
          checked={settings.researchEnabled}
          onChange={(v) => patch({ researchEnabled: v })}
        />
        <Toggle
          label="Learning"
          hint="Promote outcomes into long-term knowledge."
          checked={settings.learningEnabled}
          onChange={(v) => patch({ learningEnabled: v })}
        />
        <Toggle
          label="Verified learning only"
          hint="Only remember outcomes that passed verification."
          checked={settings.learnVerifiedOnly}
          onChange={(v) => patch({ learnVerifiedOnly: v })}
        />
        <Toggle
          label="Sandbox required"
          hint="Every code change is dry-run in the sandbox first."
          checked={settings.sandboxRequired}
          onChange={(v) => patch({ sandboxRequired: v })}
        />
        <Toggle
          label="Backups before changes"
          hint="Write a restorable checkpoint before applying anything."
          checked={settings.backupsEnabled}
          onChange={(v) => patch({ backupsEnabled: v })}
        />
        <Toggle
          label="Automatic rollback"
          hint="Undo instantly when an apply or verification fails."
          checked={settings.autoRollback}
          onChange={(v) => patch({ autoRollback: v })}
        />
        <Toggle
          label="Local-only security scope"
          hint="Never probe anything beyond this PC and its own workspace."
          checked={settings.securityScopeLocalOnly}
          onChange={(v) => patch({ securityScopeLocalOnly: v })}
        />
        <Toggle
          label="Parallel specialists"
          hint="Let several models work on one turn when it helps."
          checked={settings.parallelSpecialists}
          onChange={(v) => patch({ parallelSpecialists: v })}
        />
        <Choice
          label="Model preference"
          hint="Which engines FRIDAY reaches for first."
          value={settings.modelPreference}
          onChange={(modelPreference) => patch({ modelPreference })}
          options={[
            { value: "local-first", label: "Local first" },
            { value: "balanced", label: "Balanced" },
            { value: "cloud-first", label: "Cloud first" },
          ]}
        />
        <NumberField
          label="Research depth"
          hint="Passes per idle cycle."
          value={settings.researchDepth}
          min={1}
          max={10}
          onChange={(researchDepth) => patch({ researchDepth })}
        />
        <NumberField
          label="Max parallel models"
          hint="Upper bound for one multi-model turn."
          value={settings.maxParallelModels}
          min={1}
          max={8}
          onChange={(maxParallelModels) => patch({ maxParallelModels })}
        />
        <NumberField
          label="Max concurrent tasks"
          hint="Autonomous work stops above this many running tasks."
          value={settings.maxConcurrentTasks}
          min={1}
          max={8}
          onChange={(maxConcurrentTasks) => patch({ maxConcurrentTasks })}
        />
        <NumberField
          label="Idle cycle (minutes)"
          hint="How often the improvement pass runs."
          value={settings.idleCycleMinutes}
          min={5}
          max={240}
          onChange={(idleCycleMinutes) => patch({ idleCycleMinutes })}
        />
        <NumberField
          label="Memory retention (days)"
          hint="How long non-permanent memories are kept."
          value={settings.memoryRetentionDays}
          min={7}
          max={730}
          onChange={(memoryRetentionDays) => patch({ memoryRetentionDays })}
        />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Approved research sources · {settings.researchSources.join(", ")}
      </p>
    </HudPanel>
  );
}

/* ------------------------------------------------- core + background jobs */

function CorePanel() {
  const core = useAutonomousCore();
  const [busy, setBusy] = useState(false);

  const runCycle = async () => {
    setBusy(true);
    try {
      const cycle = await autonomousCore.cycle();
      toast[cycle ? "success" : "message"](
        cycle ? cycle.note : "Skipped — FRIDAY is already busy or autonomy is off",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <HudPanel
      title="Autonomous core"
      hint="Health → project review → research → proposals, on every idle cycle."
      actions={
        <div className="flex items-center gap-2">
          <StatusPill
            label={core.running ? "running" : "stopped"}
            tone={core.running ? "accent" : "muted"}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => (core.running ? autonomousCore.stop() : autonomousCore.start())}
          >
            {core.running ? (
              <>
                <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Start
              </>
            )}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void runCycle()}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy && "animate-spin")} /> Run cycle
          </Button>
        </div>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {core.health.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No health readings yet — run a cycle to collect them.
          </p>
        ) : (
          core.health.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{h.label}</p>
                <p className="truncate text-[11px] text-muted-foreground">{h.detail}</p>
              </div>
              <StatusPill label={h.ok ? "ok" : "problem"} tone={h.ok ? "accent" : "destructive"} />
            </div>
          ))
        )}
      </div>
      <div className="mt-3 grid max-h-[200px] gap-1.5 overflow-y-auto pr-1">
        {core.cycles.map((c) => (
          <p key={c.at} className="font-mono text-[11px] text-muted-foreground/80">
            {ago(c.at)} · {c.discovered} found · {c.researched} researched · {c.note}
          </p>
        ))}
      </div>
    </HudPanel>
  );
}

function BackgroundPanel() {
  const bg = useBackgroundTasks();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string) => {
    setBusy(id);
    try {
      const result = await backgroundTasks.runNow(id);
      toast[result?.ok === false ? "error" : "message"](
        result ? `${result.job} — ${result.note}` : "Another job is running right now",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <HudPanel
      title="Background work"
      hint="Scheduled upkeep — health, memory, connection and self-improvement."
      actions={
        <div className="flex items-center gap-2">
          <StatusPill
            label={bg.running ? "scheduled" : "paused"}
            tone={bg.running ? "accent" : "muted"}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => (bg.running ? backgroundTasks.stop() : backgroundTasks.start())}
          >
            {bg.running ? "Pause" : "Resume"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-2">
        {bg.jobs.map((job) => (
          <div
            key={job.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm text-foreground">{job.label}</p>
              <p className="font-mono text-[11px] text-muted-foreground/80">
                every {job.everyMinutes}m · last {ago(job.lastAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === job.id}
                onClick={() => void run(job.id)}
              >
                <Play className="mr-1.5 h-3.5 w-3.5" /> Run now
              </Button>
              <Switch
                checked={job.enabled}
                onCheckedChange={(v) => backgroundTasks.setEnabled(job.id, v)}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid max-h-[180px] gap-1 overflow-y-auto pr-1">
        {bg.runs.map((r) => (
          <p
            key={r.id}
            className={cn(
              "font-mono text-[11px]",
              r.ok ? "text-muted-foreground/80" : "text-destructive",
            )}
          >
            {ago(r.at)} · {r.job} · {r.ms}ms · {r.note}
          </p>
        ))}
      </div>
    </HudPanel>
  );
}

/* ---------------------------------------------------------- governance */

const riskTone = { safe: "accent", review: "warning", risky: "destructive" } as const;

function GovernancePanel() {
  const gov = useGovernance();
  const waiting = gov.pending.filter((i) => i.stage === "waiting-approval");
  const listed: GovItem[] = approvalFirst(gov.items).slice(0, Math.max(8, waiting.length));

  return (
    <HudPanel
      title="Approval gate"
      hint="Every risky action stops here. Nothing is applied before you allow it."
      actions={
        <div className="flex items-center gap-2">
          <StatusPill
            label={waiting.length ? `${waiting.length} waiting` : "clear"}
            tone={waiting.length ? "warning" : "accent"}
          />
          <Button size="sm" variant="ghost" onClick={() => governance.clearSettled()}>
            Clear settled
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!waiting.length}
            onClick={() => {
              void copyText(JSON.stringify(waiting, null, 2)).then((ok) =>
                toast[ok ? "success" : "error"](
                  ok ? "Waiting approvals copied" : "Copying was blocked",
                ),
              );
            }}
          >
            Copy waiting
          </Button>
        </div>
      }
    >
      {gov.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been proposed yet. Findings appear here the moment FRIDAY discovers one.
        </p>
      ) : (
        <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
          {listed.map((item) => (
            <div key={item.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.rationale}</p>
                  {item.evidence.length > 0 && (
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                      {item.evidence.join(" · ")}
                    </p>
                  )}
                  {item.dryRun && (
                    <p
                      className={cn(
                        "mt-1 text-[11px]",
                        item.dryRun.ok ? "text-emerald-300" : "text-rose-300",
                      )}
                    >
                      dry-run · {item.dryRun.detail}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label={item.risk} tone={riskTone[item.risk]} />
                  <StatusPill label={item.stage} tone="muted" />
                </div>
              </div>
              {item.stage === "waiting-approval" && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => governance.approve(item.id)}>
                    Allow
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => governance.reject(item.id)}>
                    Reject
                  </Button>
                </div>
              )}
              {item.error && <p className="mt-1 text-[11px] text-destructive">{item.error}</p>}
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                {item.kind} · {ago(item.updatedAt)}
                {item.autoApproved ? " · auto-approved" : ""}
                {item.checkpoint ? ` · checkpoint ${item.checkpoint}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </HudPanel>
  );
}

/* ------------------------------------------------- desktop self-maintenance */

function MaintenancePanel() {
  const available = selfBridgeAvailable();
  const live = useSelf();
  const [index, setIndex] = useState<IndexSummary | null>(null);
  const [pending, setPending] = useState<ImpactEntry[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const state = await selfState();
    if (!mounted.current || !state) return;
    setIndex(state.index);
    setPending(state.pending ?? []);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = window.setInterval(() => void refresh(), 8_000);
    const off = onSelfProgress((p) => {
      if (!mounted.current) return;
      setProgress(`${p.stage} — ${p.detail}`);
      if (p.status === "done" || p.status === "failed") void refresh();
    });
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
      off?.();
    };
  }, [refresh]);

  const guard = async (label: string, fn: () => Promise<void>) => {
    if (!available) {
      toast.message(`${label} runs in the installed FRIDAY desktop app.`);
      return;
    }
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <HudPanel
      title="Self-maintenance"
      hint="FRIDAY's own source index, change impact and safe apply — with backups and rollback."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            label={available ? "desktop" : "preview"}
            tone={available ? "accent" : "muted"}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void guard("Index rebuild", async () => {
                const summary = await selfIndex(true);
                setIndex(summary);
                toast.success(summary ? `${summary.totals.files} files indexed` : "Index rebuilt");
              })
            }
          >
            <Cpu className="mr-1.5 h-3.5 w-3.5" /> Rebuild index
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void guard("Change scan", async () => {
                const result = await selfScan();
                toast.message(result ? `${result.changes} change(s) detected` : "Nothing to scan");
              })
            }
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy && "animate-spin")} /> Scan changes
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void guard("Health check", async () => {
                const health = await selfHealth();
                toast[health?.ok ? "success" : "error"](
                  health?.detail ?? "Health check unavailable",
                );
              })
            }
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Health check
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void guard("Verify workspace", async () => {
                const verified = await selfVerify([]);
                toast[verified.ok ? "success" : "error"](
                  verified.ok
                    ? `${verified.checks.filter((c) => c.ok).length}/${verified.checks.length} check(s) passed`
                    : (verified.error ?? "Verification failed"),
                );
              })
            }
          >
            Verify workspace
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !live.lastApplyBackup}
            onClick={() =>
              void guard("Rollback last", async () => {
                const undone = await self.undoLastApply();
                toast[undone.ok ? "success" : "error"](
                  undone.ok ? "Previous files restored" : (undone.error ?? "Rollback failed"),
                );
              })
            }
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Rollback last
          </Button>
        </div>
      }
    >
      {index ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Indexed files"
            value={String(index.totals.files)}
            state={ago(index.at)}
          />
          <StatTile
            label="Dependency edges"
            value={String(index.totals.edges)}
            state={`${index.externals} external`}
            tone="accent"
          />
          <StatTile
            label="Unresolved"
            value={String(index.totals.broken)}
            state={index.totals.broken ? "needs attention" : "all imports resolve"}
            tone={index.totals.broken ? "destructive" : "accent"}
          />
          <StatTile
            label="Entry points"
            value={String(index.entryPoints.length)}
            state={index.root}
            tone="magenta"
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {available
            ? "No index yet — rebuild it to map FRIDAY's own source."
            : "Self-maintenance reads FRIDAY's installed files, so it reports live data inside the desktop app."}
        </p>
      )}

      {progress && (
        <p className="mt-3 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Activity className="h-3.5 w-3.5" /> {progress}
        </p>
      )}

      <div className="mt-3 grid gap-2">
        {pending.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-foreground">{entry.summary}</p>
                <p className="text-xs text-muted-foreground">{explainVerdict(entry.verdict)}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                  {entry.files
                    .slice(0, 4)
                    .map((f) => `${f.state} ${f.path}`)
                    .join(" · ")}
                  {entry.files.length > 4 ? ` · +${entry.files.length - 4} more` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill
                  label={entry.verdict}
                  tone={entry.verdict === "blocked" ? "destructive" : "warning"}
                />
                <Button
                  size="sm"
                  disabled={busy || entry.verdict === "blocked"}
                  onClick={() =>
                    void guard("Apply", async () => {
                      const result = await selfApply(entry.id, "manual");
                      if (result.backup) self.rememberApplyBackup(result.backup);
                      toast[result.ok ? "success" : "error"](
                        result.ok
                          ? `Applied${result.restartRequired ? " — restart required" : ""}`
                          : (result.error ?? "Apply failed"),
                      );
                    })
                  }
                >
                  Apply safely
                </Button>
              </div>
            </div>
            {entry.blockers.length > 0 && (
              <p className="mt-1 text-[11px] text-destructive">
                {entry.blockers.map((b) => `${b.file}: ${b.reason}`).join(" · ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </HudPanel>
  );
}

export function SelfAutonomyPanels() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  void tick;

  return (
    <>
      <AutonomyPanel />
      <div className="grid gap-4 xl:grid-cols-2">
        <CorePanel />
        <BackgroundPanel />
      </div>
      <GovernancePanel />
      <MaintenancePanel />
    </>
  );
}
