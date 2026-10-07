import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Brush,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  History,
  Pause,
  Play,
  PackageSearch,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  MetricBar,
  StatTile,
  StatusPill,
  toneForStatus,
} from "@/components/friday/ui";
import {
  categories,
  installerFunctions,
  liveUpdateScopes,
  type CatalogEntry,
} from "@/lib/friday/catalog";
import {
  formatEta,
  formatMb,
  installer,
  isJobActive,
  type Job,
  type JobPhase,
} from "@/lib/friday/installer-engine";
import { useInstaller } from "@/lib/friday/use-installer";
import { copyText } from "@/lib/friday/clipboard";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import { APP_VERSION } from "@/lib/friday/version";
import { THEMES } from "@/lib/friday/appearance";
import { packsForTree } from "@/lib/friday/marketplace";
import {
  formatInstallerExtra,
  publishInstallerSession,
  registerInstallerAsk,
  type InstallerFilter,
} from "@/lib/friday/installer-awareness";

export const Route = createFileRoute("/install-manager")({
  head: () => ({
    meta: [
      { title: "Install Manager — FRIDAY Console" },
      {
        name: "description",
        content:
          "Detect, verify, install, repair, update and roll back every runtime, AI engine, GPU stack, library and developer tool FRIDAY depends on — from official sources only.",
      },
      { property: "og:title", content: "Install Manager — FRIDAY Console" },
      {
        property: "og:description",
        content:
          "Live software management for the FRIDAY ecosystem: official installers, real-time download queue and honest update scopes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InstallManagerPage,
});

const methodLabel: Record<CatalogEntry["method"], string> = {
  winget: "winget",
  vendor: "vendor",
  pip: "pip",
  npm: "npm",
  cargo: "cargo",
  conda: "conda",
  "api-key": "api key",
  bundled: "bundled",
};

const requirementTone = {
  required: "text-destructive",
  recommended: "text-primary",
  optional: "text-muted-foreground",
} as const;

const logTone = {
  info: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const;

function phaseTone(phase: JobPhase) {
  if (phase === "Failed") return "destructive" as const;
  if (phase === "Manual") return "warning" as const;
  if (phase === "Cancelled") return "muted" as const;
  if (phase === "Done") return "accent" as const;
  if (phase === "Queued") return "muted" as const;
  if (phase === "Verifying") return "accent" as const;
  return "primary" as const;
}

function InstallManagerPage() {
  const state = useInstaller();
  const brainState = useBrain();
  const navigate = useNavigate();
  const [tab, setTab] = useState<InstallerFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [follow, setFollow] = useState(true);
  const [ask, setAsk] = useState("");
  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const logRef = useRef<HTMLUListElement | null>(null);

  const [notified, setNotified] = useState<string[]>([]);
  useEffect(() => {
    const fresh = state.jobs.filter((j) => !isJobActive(j.phase) && !notified.includes(j.id));
    if (fresh.length === 0) return;
    fresh.forEach((j) => {
      if (j.phase === "Done") toast.success(`${j.pkg} — ${j.detail}`);
      else if (j.phase === "Manual")
        toast.warning(`${j.pkg} needs a manual step`, { description: j.detail });
      else if (j.phase === "Failed") toast.error(`${j.pkg} failed`, { description: j.error });
      else toast(`${j.pkg} cancelled`);
    });
    setNotified((prev) => [...prev, ...fresh.map((j) => j.id)].slice(-80));
  }, [state.jobs, notified]);

  const entries = useMemo(() => {
    void state.extra;
    return installer.entries();
  }, [state.extra]);
  const allCategories = useMemo(() => {
    const set = new Set<string>(categories as string[]);
    entries.forEach((e) => set.add(e.category));
    return [...set];
  }, [entries]);

  const statuses = useMemo(() => {
    void state.installed;
    void state.latest;
    return new Map(entries.map((e) => [e.pkg, installer.statusOf(e)] as const));
  }, [entries, state.installed, state.latest]);

  const counts = useMemo(() => {
    const values = [...statuses.values()];
    return {
      all: entries.length,
      installed: values.filter((x) => x === "Up to date" || x === "Update available").length,
      updates: values.filter((x) => x === "Update available").length,
      missing: values.filter((x) => x === "Not installed").length,
      required: entries.filter((e) => e.requirement === "required" && !state.installed[e.pkg])
        .length,
    };
  }, [entries, statuses, state.installed]);

  const rows = useMemo(
    () =>
      entries.filter((e) => {
        const status = statuses.get(e.pkg)!;
        if (tab === "installed" && (status === "Not installed" || status === "Unknown"))
          return false;
        if (tab === "updates" && status !== "Update available") return false;
        if (tab === "missing" && status !== "Not installed") return false;
        if (tab === "required" && e.requirement !== "required") return false;
        if (category !== "all" && e.category !== category) return false;
        if (query.trim()) {
          const q = query.toLowerCase();
          const path = state.probe[e.pkg]?.path ?? "";
          if (
            !`${e.pkg} ${e.category} ${e.source} ${e.method} ${e.url} ${path}`
              .toLowerCase()
              .includes(q)
          )
            return false;
        }
        return true;
      }),
    [entries, statuses, tab, category, query, state.probe],
  );

  const perCategory = useMemo(
    () =>
      allCategories.map((c) => {
        const items = entries.filter((e) => e.category === c);
        const installed = items.filter((e) => state.installed[e.pkg]).length;
        return {
          name: c,
          total: items.length,
          installed,
          pct: items.length ? Math.round((installed / items.length) * 100) : 0,
        };
      }),
    [allCategories, entries, state.installed],
  );

  const scopes = useMemo(() => {
    const providers = entries.filter((e) => e.method === "api-key");
    return liveUpdateScopes({
      version: APP_VERSION,
      catalog: counts.all,
      installed: counts.installed,
      updates: counts.updates,
      requiredMissing: counts.required,
      providersConfigured: providers.filter((e) => state.installed[e.pkg]).length,
      providersTotal: providers.length,
      plugins: packsForTree("plugins").length,
      modules: packsForTree("modules").length,
      skills: packsForTree("skills").length,
      agents: packsForTree("agents").length,
      themes: THEMES.length,
    });
  }, [entries, counts, state.installed]);

  const activeJobs = state.jobs.filter((j) => isJobActive(j.phase));
  const finishedJobs = state.jobs
    .filter((j) => !isJobActive(j.phase))
    .slice(-6)
    .reverse();

  const jobFor = (pkg: string) => activeJobs.find((j) => j.pkg === pkg);
  const recent = brainState.messages.slice(-8);

  useEffect(() => {
    registerInstallerAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatInstallerExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerInstallerAsk(null);
  }, []);

  useEffect(() => {
    publishInstallerSession({
      desktop: state.bridge === "desktop",
      follow,
      tab,
      category,
      query,
      selectedPkg,
      scanning: state.scanning,
      verifying: state.verifying,
      lastScanAt: state.lastScanAt,
      entries,
      jobs: state.jobs,
      log: state.log,
      history: state.history,
      installed: counts.installed,
      updates: counts.updates,
      missing: counts.missing,
      requiredMissing: counts.required,
    });
  }, [state, follow, tab, category, query, selectedPkg, entries, counts]);

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = 0;
  }, [state.log, follow]);

  const run = (pkg: string, action: Parameters<typeof installer.enqueue>[1]) => {
    const job = installer.enqueue(pkg, action);
    if (job) toast(`${pkg} · ${action} queued`);
  };

  const copySession = () => {
    void copyText(formatInstallerExtra()).then((ok) =>
      ok ? toast.success("Install Manager session copied") : toast.error("Copying was blocked"),
    );
  };

  const copyValue = (label: string, value: string) => {
    if (!value) {
      toast.message(`No ${label} to copy`);
      return;
    }
    void copyText(value).then((ok) =>
      ok ? toast.success(`${label} copied`) : toast.error("Copying was blocked"),
    );
  };

  const askAbout = (pkg: string) => {
    if (brainState.activeRunId) return;
    setSelectedPkg(pkg);
    brain.send(`look at ${pkg} on the install manager`, { extra: formatInstallerExtra() });
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    const prompt = /install|scan|update|verify|catalog|package|toolchain/i.test(text)
      ? text
      : `${text} in the install manager`;
    brain.send(prompt, { extra: formatInstallerExtra() });
  };

  const onInstallRequired = () => {
    if (
      !window.confirm(
        `Queue ${counts.required || "all"} required package(s) from official sources?`,
      )
    )
      return;
    const n = installer.installMissingRequired();
    toast[n ? "success" : "message"](
      n ? `${n} required packages queued` : "All required packages present",
    );
  };

  const onUpdateAll = () => {
    if (
      !window.confirm(
        `Queue ${counts.updates || "pending"} catalog update(s) from official sources?`,
      )
    )
      return;
    const n = installer.updateAll();
    toast[n ? "success" : "message"](
      n ? `${n} updates queued` : "Everything is already up to date",
    );
  };

  return (
    <AppShell
      title="Install Manager"
      subtitle="Live software management — runtimes, AI engines, GPU stacks, libraries and dev tools from official sources · live"
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
            onClick={() => {
              installer.verifyAll();
              toast("Verifying installed packages…");
            }}
            disabled={state.verifying}
          >
            <ShieldCheck className="size-4" /> {state.verifying ? "Verifying…" : "Verify All"}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              installer.scanAll();
              toast("Detection scan started");
            }}
            disabled={state.scanning}
          >
            <PackageSearch className="size-4" />{" "}
            {state.scanning ? `Scanning ${Math.round(state.scanProgress)}%` : "Scan All"}
          </Button>
          <Button size="sm" variant="outline" onClick={onInstallRequired}>
            <Download className="size-4" /> Install Required
          </Button>
          <Button size="sm" variant="outline" onClick={onUpdateAll}>
            <Download className="size-4" /> Update all ({counts.updates})
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/doctor" })}>
            <Stethoscope className="size-4" /> Doctor →
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!state.online && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            Network offline — downloads are halted. Jobs resume automatically when the connection
            returns.
          </div>
        )}

        <HudPanel
          title="Environment Summary"
          hint={
            state.lastScanAt
              ? `last scan ${new Date(state.lastScanAt).toLocaleTimeString()}`
              : "no scan yet"
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile label="Catalog" value={counts.all} state="entries" />
              <StatTile label="Installed" value={counts.installed} state="detected" tone="accent" />
              <StatTile label="Updates" value={counts.updates} state="pending" tone="warning" />
              <StatTile label="Missing" value={counts.missing} state="available" tone="muted" />
              <StatTile
                label="Required missing"
                value={counts.required}
                state="blocking"
                tone="magenta"
              />
            </div>
            {state.scanning && (
              <MetricBar
                label="Detection scan"
                value={Math.round(state.scanProgress)}
                detail="probing PATH, registry, pip and npm manifests"
                tone="accent"
              />
            )}
          </div>
        </HudPanel>

        <HudPanel
          title="Software Catalog"
          hint={`${rows.length} shown · ${state.bridge === "desktop" ? "kernel bridge" : "preview engine"}`}
          actions={
            <FilterTabs
              value={tab}
              onChange={(key) => setTab(key as InstallerFilter)}
              tabs={[
                { key: "all", label: `All (${counts.all})` },
                { key: "installed", label: `Installed (${counts.installed})` },
                { key: "updates", label: `Updates (${counts.updates})` },
                { key: "missing", label: `Not installed (${counts.missing})` },
                { key: "required", label: `Required (${counts.required})` },
              ]}
            />
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search packages, paths, sources or methods…"
                  className="h-8 pl-8 font-mono text-xs"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {["all", ...allCategories].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`label-xs rounded-sm border px-2 py-1 transition-colors ${
                      category === c
                        ? "border-primary/60 bg-primary/15 text-primary"
                        : "border-border/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {c === "all" ? "All categories" : c}
                  </button>
                ))}
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No catalog entries match this filter.
              </p>
            ) : (
              <DataTable
                pinLast
                columns={[
                  "Package",
                  "Category",
                  "Installed",
                  "Latest",
                  "Source",
                  "Path",
                  "Method",
                  "Size",
                  "Status",
                  "Action",
                ]}
                rows={rows.map((e) => {
                  const status = statuses.get(e.pkg)!;
                  const installedVersion = state.installed[e.pkg] ?? null;
                  const job = jobFor(e.pkg);
                  const probe = state.probe[e.pkg];
                  const path = probe?.path || (e.method === "api-key" ? "Models › Providers" : "");
                  return [
                    <span key="n" className="flex items-center gap-2 text-foreground">
                      <Wrench className={`size-3.5 ${requirementTone[e.requirement]}`} />
                      <button
                        type="button"
                        className="text-left hover:underline"
                        title={e.notes ?? e.pkg}
                        onClick={() => setSelectedPkg(e.pkg)}
                      >
                        {e.pkg}
                      </button>
                    </span>,
                    <span key="c" className="label-xs text-muted-foreground">
                      {e.category}
                    </span>,
                    <span key="v" className="font-mono text-xs text-foreground">
                      {installedVersion ?? "—"}
                    </span>,
                    <span key="l" className="font-mono text-xs text-muted-foreground">
                      {installer.latestOf(e)}
                    </span>,
                    <a
                      key="s"
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                    >
                      {e.source}
                      <ExternalLink className="size-3" />
                    </a>,
                    <span
                      key="p"
                      className="max-w-[220px] truncate font-mono text-xs text-muted-foreground"
                      title={path || "not probed"}
                    >
                      {path || "—"}
                    </span>,
                    <Badge key="m" variant="outline" className="label-xs">
                      {methodLabel[e.method]}
                    </Badge>,
                    <span key="z" className="font-mono text-xs text-muted-foreground">
                      {e.size}
                    </span>,
                    job ? (
                      <StatusPill
                        key="st"
                        label={`${job.phase} ${Math.round(job.progress)}%`}
                        tone={phaseTone(job.phase)}
                      />
                    ) : (
                      <StatusPill key="st" label={status} tone={toneForStatus(status)} />
                    ),
                    <div key="a" className="flex items-center gap-1">
                      {job ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-muted-foreground"
                          onClick={() => installer.cancel(job.id)}
                        >
                          <X className="size-3" /> Cancel
                        </Button>
                      ) : status === "Not installed" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => run(e.pkg, "install")}
                        >
                          <Download className="size-3" /> Install
                        </Button>
                      ) : (
                        <>
                          {status === "Update available" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => run(e.pkg, "update")}
                            >
                              <Download className="size-3" /> Update
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            title="Repair installation"
                            onClick={() => run(e.pkg, "repair")}
                          >
                            <Wrench className="size-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-muted-foreground"
                            title={`Roll back to ${state.previous[e.pkg] ?? "previous build"}`}
                            disabled={!state.previous[e.pkg]}
                            onClick={() => run(e.pkg, "rollback")}
                          >
                            <RotateCcw className="size-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-destructive"
                            title="Uninstall"
                            onClick={() => run(e.pkg, "uninstall")}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        title="Copy install path"
                        onClick={() => copyValue("Path", path)}
                      >
                        <Copy className="size-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        title="Ask FRIDAY about this package"
                        onClick={() => askAbout(e.pkg)}
                      >
                        Ask
                      </Button>
                    </div>,
                  ];
                })}
              />
            )}
          </div>
        </HudPanel>

        <div className="grid gap-4 lg:grid-cols-2">
          <HudPanel
            title="Install Queue"
            hint={`${activeJobs.length} active · ${state.concurrency} parallel`}
            actions={
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => installer.setPaused(!state.paused)}
                >
                  {state.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                  {state.paused ? "Resume" : "Pause"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => installer.setConcurrency(state.concurrency + 1)}
                >
                  +1
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => installer.clearFinished()}
                >
                  Clear
                </Button>
              </div>
            }
          >
            {activeJobs.length === 0 && finishedJobs.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Queue idle. Install, update or repair a package to start a job.
              </p>
            ) : (
              <ul className="space-y-3">
                {activeJobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
                {finishedJobs.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center justify-between gap-2 rounded-sm border border-border/50 px-2 py-1.5"
                  >
                    <span className="min-w-0 truncate text-xs text-foreground">
                      {job.pkg}{" "}
                      <span className="text-muted-foreground">· {job.error ?? job.detail}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <StatusPill label={job.phase} tone={phaseTone(job.phase)} />
                      {job.phase !== "Done" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => installer.retry(job.id)}
                        >
                          <RefreshCw className="size-3" /> Retry
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </HudPanel>

          <HudPanel
            title="Coverage by Category"
            hint={`${counts.installed}/${counts.all} installed`}
          >
            <ul className="space-y-2">
              {perCategory.map((c) => (
                <li key={c.name}>
                  <MetricBar
                    label={`${c.name} · ${c.installed}/${c.total}`}
                    value={c.pct}
                    tone={c.pct > 70 ? "accent" : c.pct > 35 ? "primary" : "warning"}
                  />
                </li>
              ))}
            </ul>
          </HudPanel>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <HudPanel
            title="Update Manager"
            hint="live counts — confirmation required to queue"
            actions={
              <Button size="sm" className="h-6 px-2 text-[11px]" onClick={onUpdateAll}>
                <Download className="size-3" /> Update all ({counts.updates})
              </Button>
            }
          >
            <DataTable
              columns={["Scope", "Current", "Latest", "Status"]}
              rows={scopes.map((u) => [
                <span key="s" className="text-foreground" title={u.detail}>
                  {u.scope}
                </span>,
                <span key="c" className="font-mono text-xs text-muted-foreground">
                  {u.current}
                </span>,
                <span key="l" className="font-mono text-xs text-foreground">
                  {u.latest}
                </span>,
                <StatusPill key="st" label={u.state} tone={toneForStatus(u.state)} />,
              ])}
            />
          </HudPanel>

          <HudPanel title="Installer Capabilities" hint="all wired to the engine">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {installerFunctions.map((f) => (
                <div
                  key={f.label}
                  className="flex items-center justify-between gap-2 rounded-sm border border-border/50 px-2 py-1.5"
                >
                  <span className="flex items-center gap-1.5 text-xs text-foreground">
                    <CheckCircle2
                      className={`size-3.5 ${f.state === "Manual" ? "text-warning" : "text-success"}`}
                    />
                    {f.label}
                  </span>
                  <span className="label-xs text-muted-foreground">{f.state}</span>
                </div>
              ))}
            </div>
          </HudPanel>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <HudPanel
            title={showHistory ? "Install History" : "Installer Log"}
            hint={showHistory ? `${state.history.length} events` : `${state.log.length} lines`}
            actions={
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => setShowHistory((v) => !v)}
              >
                <History className="size-3" /> {showHistory ? "Show log" : "Show history"}
              </Button>
            }
          >
            {showHistory ? (
              state.history.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No install history yet.
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {state.history.map((h) => (
                    <li key={h.id} className="flex gap-2">
                      <span className="text-muted-foreground">
                        {new Date(h.at).toLocaleTimeString()}
                      </span>
                      <span className="uppercase text-primary/80">{h.action.padEnd(9, " ")}</span>
                      <span className="text-foreground/90">{h.pkg}</span>
                      <span className="text-muted-foreground">
                        {h.from ?? "—"} → {h.to ?? "—"}
                      </span>
                      <span
                        className={
                          h.result === "success"
                            ? "text-success"
                            : h.result === "failed"
                              ? "text-destructive"
                              : "text-warning"
                        }
                      >
                        {h.result}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ul ref={logRef} className="max-h-64 space-y-1 overflow-y-auto font-mono text-[11px]">
                {state.log.map((l) => (
                  <li key={l.id} className="flex gap-2">
                    <span className="text-muted-foreground">{l.at}</span>
                    <span className={`uppercase ${logTone[l.level]}`}>
                      {l.level.padEnd(5, " ")}
                    </span>
                    <span className="text-foreground/90">{l.line}</span>
                  </li>
                ))}
              </ul>
            )}
          </HudPanel>

          <HudPanel
            title="Maintenance"
            hint={`cache ${formatMb(state.cacheMb)}`}
            bodyClassName="flex flex-wrap gap-2 p-4"
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const n = installer.fixIssues();
                toast[n ? "success" : "message"](
                  n ? `${n} jobs queued to fix issues` : "No issues detected",
                );
              }}
            >
              <Wrench className="size-4" /> Fix Issues
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                toast.success(`Cache cleared — ${formatMb(installer.clearCache())} reclaimed`)
              }
            >
              <Brush className="size-4" /> Clean Cache
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const last = state.history.find(
                  (h) => h.result === "success" && h.action !== "rollback",
                );
                if (!last) {
                  toast.message("Nothing to roll back yet");
                  return;
                }
                installer.enqueue(last.pkg, "rollback");
                toast(`Rolling back ${last.pkg}`);
              }}
            >
              <RotateCcw className="size-4" /> Rollback Last
            </Button>
            <Button size="sm" variant="outline" onClick={onInstallRequired}>
              <Download className="size-4" /> Install Required
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                installer.verifyAll();
                toast("Re-probing PATH, hashes and env — same as Verify All");
              }}
            >
              <ShieldCheck className="size-4" /> Verify Config
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                installer.resetEnvironment();
                toast(
                  state.bridge === "desktop"
                    ? "Environment reset — re-probing this machine"
                    : "Environment reset to detected baseline",
                );
              }}
            >
              <Trash2 className="size-4" /> Reset State
            </Button>
            <p className="w-full text-[11px] text-muted-foreground">
              Downloads come from the vendor URLs above, are checksum- and signature-verified,
              installed silently and logged on this page (persisted with installer state). Desktop
              FRIDAY also writes telemetry under{" "}
              <span className="font-mono">&lt;FRIDAY_ROOT&gt;/logs</span>. Progress, retries and
              rollbacks survive a reload. User data under the FRIDAY root is never destroyed by
              install, update or rollback.
            </p>
          </HudPanel>
        </div>

        <HudPanel
          title="Ask FRIDAY"
          hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            FRIDAY can see this live catalog (status, official source, probed path, queue, log). Say
            scan install manager, install python, install required, or installer status — those
            commands call the same engine.
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
                No chat yet this session. Type below, or ask her what the catalog is missing.
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
              placeholder="Scan install manager · install python · installer status"
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
      </div>
    </AppShell>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-foreground">
          {job.pkg}
          <span className="ml-2 label-xs text-muted-foreground">{job.action}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[10px] text-muted-foreground">
            {job.phase === "Downloading" ? formatEta(job.etaSeconds) : ""}
          </span>
          <StatusPill label={job.phase} tone={phaseTone(job.phase)} />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => installer.cancel(job.id)}
          >
            <X className="size-3" />
          </Button>
        </div>
      </div>
      <MetricBar
        label={job.detail}
        value={Math.round(job.progress)}
        tone={
          job.phase === "Verifying" ? "accent" : job.phase === "Failed" ? "destructive" : "primary"
        }
      />
    </li>
  );
}
