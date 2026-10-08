import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  Download,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { HudPanel, StatTile, StatusPill } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { ownerWave7Steps, verifyPackPlan } from "@/lib/friday/free-board";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  doctor,
  isHealthy,
  isProblem,
  isWarning,
  type DoctorCheck,
  type DoctorStatus,
} from "@/lib/friday/doctor-engine";
import { useDoctor } from "@/lib/friday/use-doctor";
import { copyText } from "@/lib/friday/clipboard";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import {
  filterChecks,
  formatDoctorExtra,
  publishDoctorSession,
  registerDoctorAsk,
  summarizeDoctorProblems,
  type DoctorFilter,
} from "@/lib/friday/doctor-awareness";

export const Route = createFileRoute("/doctor")({
  head: () => ({
    meta: [
      { title: "Setup & Doctor — FRIDAY Console" },
      {
        name: "description",
        content:
          "Step-by-step FRIDAY installation guide plus a live doctor that finds real setup problems, explains the cause and applies safe, reversible repairs.",
      },
      { property: "og:title", content: "Setup & Doctor — FRIDAY Console" },
      {
        property: "og:description",
        content: "Install guide, real self-diagnosis and guarded auto-repair for FRIDAY.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DoctorPage,
});

const INSTALL_STEPS = [
  {
    title: "1 · Download the installer",
    body: "Grab FRIDAY-Setup-x.y.z.exe from the Import & Build page (Build EXE) or from your release folder. Keep the .exe and the checksum file together.",
    issue:
      "SmartScreen blocks the file → More info → Run anyway (the build is unsigned by default).",
  },
  {
    title: "2 · Approve the installer",
    body: "Approve elevation for the installer when Windows asks. The installed FRIDAY app itself runs as your signed-in user. Choose a data folder on a fast drive (e.g. D:\\FRIDAY).",
    issue:
      "Error 1603 usually means an old FRIDAY is still running — close it from the tray, then retry.",
  },
  {
    title: "3 · Pick your primary folder",
    body: "On first launch FRIDAY asks for one root folder. Everything under it is scanned, indexed into local vector memory and watched for changes.",
    issue: "Folder not writable → pick a path outside OneDrive and outside Program Files.",
  },
  {
    title: "4 · Install the runtime pieces",
    body: "Open Install Manager and install Python kernel deps, the local model runtime (Ollama or llama.cpp) and the vector database. FRIDAY verifies each one.",
    issue: "Port 8765 already in use → change bridge.port in config/kernel.yaml and restart.",
  },
  {
    title: "5 · Pull your models",
    body: "Models page → pull the brain, coder and embedding models. GPU acceleration is selected automatically when CUDA is available.",
    issue:
      "Model loads on CPU → update the NVIDIA driver, then re-run the hardware detection on this page.",
  },
  {
    title: "6 · Verify",
    body: "Come back here and run Deep Doctor. Every check must be green before FRIDAY takes autonomous actions.",
    issue: "Any red check shows its cause, the dependency it needs and the exact fix command.",
  },
];

const FILTERS: DoctorFilter[] = ["all", "problems", "warnings", "healthy", "fixable", "owner"];

function statusTone(status: DoctorStatus) {
  if (status === "Ready" || status === "Running") return "accent" as const;
  if (status === "Repairing") return "primary" as const;
  if (status === "Warning" || status === "Outdated") return "warning" as const;
  return "destructive" as const;
}

const logTone = {
  info: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const;

function DoctorPage() {
  const state = useDoctor();
  const brainState = useBrain();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<DoctorFilter>("all");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState("");
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLUListElement | null>(null);

  const counts = useMemo(
    () => ({
      ok: state.checks.filter((c) => isHealthy(c.status)).length,
      warn: state.checks.filter((c) => isWarning(c.status)).length,
      fail: state.checks.filter((c) => isProblem(c.status)).length,
      fixable: state.checks.filter((c) => c.fixable && !isHealthy(c.status)).length,
      owner: state.checks.filter((c) => c.repairKind === "needs-owner").length,
    }),
    [state.checks],
  );

  const visible = useMemo(
    () => filterChecks(state.checks, { filter, query }),
    [state.checks, filter, query],
  );

  const groups = useMemo(() => {
    const map = new Map<string, DoctorCheck[]>();
    visible.forEach((c) => {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    });
    return [...map.entries()];
  }, [visible]);

  const busy = state.scanning || state.repairing.length > 0;
  const ownerSteps = doctor.pendingOwnerGuidance();
  const recent = brainState.messages.slice(-8);
  const problems = summarizeDoctorProblems(state.checks);

  useEffect(() => {
    registerDoctorAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatDoctorExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerDoctorAsk(null);
  }, []);

  useEffect(() => {
    publishDoctorSession({
      desktop: state.desktop,
      follow,
      filter,
      query,
      selectedIds: selected,
      scanning: state.scanning,
      mode: state.mode,
      lastScanAt: state.lastScanAt,
      lastDeep: state.lastDeep,
      durationMs: state.durationMs,
      checks: state.checks,
      log: state.log,
      repairing: state.repairing,
      rollbacks: state.rollbacks.length,
    });
  }, [state, follow, filter, query, selected]);

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = 0;
  }, [state.log, follow]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectFixable = () =>
    setSelected(state.checks.filter((c) => c.fixable && !isHealthy(c.status)).map((c) => c.id));

  const copyCommand = (text: string) => {
    void copyText(text).then((ok) =>
      ok ? toast.success("Command copied") : toast.error("Copying was blocked"),
    );
  };

  const copyReport = () => {
    void copyText(doctor.report()).then((ok) =>
      ok ? toast.success("Diagnostic report copied") : toast.error("Copying was blocked"),
    );
  };

  const copySession = () => {
    void copyText(formatDoctorExtra()).then((ok) =>
      ok ? toast.success("Copied the live doctor session.") : toast.error("Could not copy."),
    );
  };

  const onFixAll = () => {
    if (!window.confirm("Apply every safe automatic repair? Risky changes keep a rollback point."))
      return;
    const run = doctor.fixAllSafe();
    void run.then((n) => toast[n ? "success" : "info"](`${n} safe repair(s) applied`));
  };

  const onAutoDiagnose = () => {
    if (
      !window.confirm(
        "Run a deep scan, then apply every safe automatic repair? Risky changes keep a rollback point.",
      )
    )
      return;
    const run = doctor.autoDiagnose();
    void run.then((n) =>
      toast[n ? "success" : "info"](
        n ? `${n} issue(s) repaired automatically` : "No safe repairs were needed",
      ),
    );
  };

  const copyCheck = (check: DoctorCheck) => {
    const text = [
      `${check.label} [${check.status}]`,
      check.detail,
      check.cause ? `cause: ${check.cause}` : "",
      check.fix ? `fix: ${check.fix}` : "",
      check.command ? `command: ${check.command}` : "",
      ...(check.steps || []).map((step, index) => `${index + 1}. ${step}`),
    ]
      .filter(Boolean)
      .join("\n");
    void copyText(text).then((ok) =>
      ok ? toast.success("Check copied") : toast.error("Copying was blocked"),
    );
  };

  const askAbout = (check: DoctorCheck) => {
    if (brainState.activeRunId) return;
    brain.send(`explain ${check.label} on setup and doctor`, { extra: formatDoctorExtra() });
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    const prompt = /doctor|setup|scan|repair|diagnos/i.test(text) ? text : `${text} in the doctor`;
    brain.send(prompt, { extra: formatDoctorExtra() });
  };

  return (
    <AppShell
      title="Setup & Doctor"
      subtitle="Installation guide, real diagnosis and guarded repairs · live"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void copySession()}>
            <Copy className="size-4" /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFollow((value) => !value)}>
            {follow ? <Pause className="size-4" /> : <Play className="size-4" />}
            {follow ? "Pause follow" : "Follow"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doctor.scan({ deep: false })}
            disabled={busy}
          >
            <ScanSearch className="size-4" /> Scan Now
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doctor.scan({ deep: false })}
            disabled={busy}
          >
            <Stethoscope className="size-4" /> Quick Doctor
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doctor.scan({ deep: true })}
            disabled={busy}
          >
            <Activity className="size-4" /> Deep Doctor
          </Button>
          <Button size="sm" onClick={onAutoDiagnose} disabled={busy}>
            <Wand2 className={state.mode === "auto" ? "size-4 animate-pulse" : "size-4"} /> Auto
            Diagnose
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void doctor.scan({ deep: state.lastDeep })}
            disabled={busy}
          >
            <RefreshCw className={state.scanning ? "size-4 animate-spin" : "size-4"} /> Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast(verifyPackPlan().join(" "))}
            disabled={busy}
          >
            <ShieldCheck className="size-4" /> Verify all packs
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/install-manager" })}
          >
            Install Manager →
          </Button>
        </div>
      }
    >
      <details className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
        <summary>Windows voice and free-model check</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          {ownerWave7Steps().map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label="Healthy"
          value={counts.ok}
          state="checks passing"
          tone="accent"
          icon={<CheckCircle2 className="size-4" />}
        />
        <StatTile
          label="Warnings"
          value={counts.warn}
          state="non-blocking"
          tone="warning"
          icon={<AlertTriangle className="size-4" />}
        />
        <StatTile
          label="Problems"
          value={counts.fail}
          state="fix before use"
          tone="destructive"
          icon={<XCircle className="size-4" />}
        />
        <StatTile
          label="Safe repairs"
          value={counts.fixable}
          state="one-click available"
          tone="primary"
          icon={<Wrench className="size-4" />}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <Button
            key={item}
            size="sm"
            variant={filter === item ? "default" : "outline"}
            onClick={() => setFilter(item)}
          >
            {item}
            {item === "owner" && counts.owner ? ` (${counts.owner})` : ""}
          </Button>
        ))}
      </div>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter live checks by name, group, cause"
        className="mt-2 h-8 font-mono text-xs"
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={counts.fixable === 0} onClick={selectFixable}>
          Select all fixable
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={selected.length === 0}
          onClick={() => setSelected([])}
        >
          Clear selection
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selected.length === 0}
          onClick={() =>
            void doctor.fixSelected(selected).then((n) => {
              setSelected([]);
              toast[n ? "success" : "error"](
                `${n}/${selected.length} selected repair(s) succeeded`,
              );
            })
          }
        >
          <Wrench className="size-4" /> Fix Selected ({selected.length})
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || counts.fixable === 0}
          onClick={onFixAll}
        >
          <ShieldCheck className="size-4" /> Fix All Safe Issues
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || counts.fixable === 0}
          onClick={onFixAll}
        >
          <Wand2 className="size-4" /> Safe Auto Fix
        </Button>
        <Button size="sm" variant="outline" onClick={copyReport}>
          <ClipboardCopy className="size-4" /> Copy report
        </Button>
        <Button size="sm" variant="outline" onClick={() => void doctor.exportReport()}>
          <Download className="size-4" /> Export report
        </Button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {state.lastScanAt
            ? `last ${state.lastDeep ? "deep" : "quick"} scan ${new Date(state.lastScanAt).toLocaleTimeString()} · ${state.durationMs} ms · ${state.desktop ? "live system" : "preview"} · ${visible.length}/${state.checks.length} shown`
            : "no scan yet"}
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {groups.map(([group, items]) => (
            <HudPanel key={group} title={group} hint={`${items.length} checks`}>
              <ul className="space-y-2">
                {items.map((c) => (
                  <li key={c.id} className="rounded-sm border border-border bg-surface px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Checkbox
                          checked={selected.includes(c.id)}
                          onCheckedChange={() => toggle(c.id)}
                          disabled={!c.fixable}
                          aria-label={`Select ${c.label}`}
                        />
                        <p className="truncate text-sm text-foreground">{c.label}</p>
                      </div>
                      <StatusPill label={c.status.toLowerCase()} tone={statusTone(c.status)} />
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {c.detail}
                    </p>
                    {c.cause ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        <span className="text-warning">Cause · </span>
                        {c.cause}
                      </p>
                    ) : null}
                    {c.steps && c.steps.length ? (
                      c.steps.map((step, index) => (
                        <p
                          key={`${c.id}-step-${index}`}
                          className="mt-1 text-xs text-muted-foreground"
                        >
                          {index + 1}. {step}
                        </p>
                      ))
                    ) : c.fix ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="text-accent">Fix · </span>
                        {c.fix}
                      </p>
                    ) : null}
                    {c.before && c.before !== c.status ? (
                      <p className="mt-1 font-mono text-[10px] text-primary">
                        before → after: {c.before} → {c.status}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {c.command ? (
                        <button
                          type="button"
                          onClick={() => copyCommand(c.command as string)}
                          className="flex items-center gap-1.5 rounded-sm border border-primary/25 bg-background px-2 py-1 font-mono text-[10px] text-primary hover:border-primary/60"
                        >
                          <ClipboardCopy className="size-3" /> {c.command}
                        </button>
                      ) : null}
                      {c.fixable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          disabled={busy}
                          onClick={() => void doctor.fix(c.id)}
                        >
                          <Wrench className="size-3" />
                          {state.repairing.includes(c.id) ? "Repairing…" : "Repair"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => copyCheck(c)}
                      >
                        <Copy className="size-3" /> Copy
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={Boolean(brainState.activeRunId)}
                        onClick={() => askAbout(c)}
                      >
                        Ask
                      </Button>
                      {c.repairKind === "needs-owner" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          disabled={busy}
                          onClick={() => void doctor.scan({ deep: false })}
                        >
                          <RefreshCw className="size-3" /> Re-check
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </HudPanel>
          ))}
          {groups.length === 0 ? (
            <HudPanel title="Diagnostics" hint="no data">
              <p className="text-xs text-muted-foreground">
                {state.scanning ? "Scanning your system…" : "Run a scan to inspect this machine."}
              </p>
            </HudPanel>
          ) : null}
        </div>

        <div className="space-y-4">
          <HudPanel
            title="Ask FRIDAY"
            hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
          >
            <p className="mb-2 text-xs text-muted-foreground">
              FRIDAY can see this live scan (checks, causes, safe repairs, owner steps, repair log).
              Say quick doctor, deep doctor, auto diagnose, or what did the doctor find — those
              buttons call the same engine.
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
                  No chat yet this session. Type below, or ask her what the doctor found.
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
                placeholder="Quick doctor · deep doctor · auto diagnose"
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
          </HudPanel>

          {ownerSteps.length ? (
            <HudPanel title="Needs you" hint={`${ownerSteps.length} owner-only`}>
              <ul className="space-y-3">
                {ownerSteps.map((g) => (
                  <li
                    key={g.checkId}
                    className="rounded-sm border border-border bg-surface px-3 py-2"
                  >
                    <p className="text-sm text-foreground">{g.title}</p>
                    <p className="mt-1 text-xs text-warning">{g.reason}</p>
                    {g.steps.map((step, index) => (
                      <p
                        key={`${g.checkId}-${index}`}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        {index + 1}. {step}
                      </p>
                    ))}
                    {g.retryable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-6 px-2 text-[11px]"
                        disabled={busy}
                        onClick={() => void doctor.scan({ deep: false })}
                      >
                        <RefreshCw className="size-3" /> Re-check
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </HudPanel>
          ) : null}

          <HudPanel
            title="Repair log"
            hint={`${state.log.length} lines`}
            actions={
              <Button size="sm" variant="ghost" onClick={() => doctor.clearLog()}>
                <Trash2 className="size-3.5" /> Clear log
              </Button>
            }
          >
            <ul ref={logRef} className="max-h-64 space-y-1 overflow-auto font-mono text-[10px]">
              {state.log.map((l) => (
                <li key={l.id} className={logTone[l.level]}>
                  <span className="text-muted-foreground">{l.at}</span> {l.line}
                </li>
              ))}
            </ul>
            {problems ? (
              <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-destructive">
                {problems}
              </pre>
            ) : null}
          </HudPanel>

          {state.rollbacks.length ? (
            <HudPanel title="Rollback points" hint="backups kept before risky repairs">
              <ul className="space-y-2">
                {state.rollbacks.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
                  >
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {r.checkId} · {new Date(r.at).toLocaleTimeString()}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => void doctor.rollback(r.id)}
                    >
                      <RotateCcw className="size-3" /> Roll back
                    </Button>
                  </li>
                ))}
              </ul>
            </HudPanel>
          ) : null}

          <HudPanel title="Installation guide" hint="Windows · step by step">
            <ol className="space-y-3">
              {INSTALL_STEPS.map((s) => (
                <li key={s.title} className="rounded-sm border border-border bg-surface px-3 py-2">
                  <p className="text-sm text-primary">{s.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
                  <p className="mt-1.5 flex gap-1.5 text-[11px] text-warning">
                    <Wrench className="mt-0.5 size-3 shrink-0" />
                    {s.issue}
                  </p>
                </li>
              ))}
            </ol>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-success" />
              FRIDAY never uploads your files — every check above runs on this PC.
            </p>
          </HudPanel>
        </div>
      </div>
    </AppShell>
  );
}
