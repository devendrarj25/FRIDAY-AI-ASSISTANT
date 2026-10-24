import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
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
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
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
  EmptyState,
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
  serviceIdFor,
  type Job,
  type JobPhase,
  type ServiceRow,
} from "@/lib/friday/installer-engine";
import { INSTALL_SECTIONS, type InstallSection } from "@/lib/friday/installer-sections";
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
  const [section, setSection] = useState<InstallSection>("software");
  const [tab, setTab] = useState<InstallerFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  // Filtering a long list follows typing at low priority, so the field never lags.
  const deferredQuery = useDeferredValue(query);
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
    const ids = fresh.map((j) => j.id);
    queueMicrotask(() => setNotified((prev) => [...prev, ...ids].slice(-80)));
  }, [state.jobs, notified]);

  const entries = useMemo(() => {
    void state.extra;
    return installer.entries();
  }, [state.extra]);
  const selectedEntry = selectedPkg ? (entries.find((e) => e.pkg === selectedPkg) ?? null) : null;
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
        if (deferredQuery.trim()) {
          const q = deferredQuery.toLowerCase();
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
    [entries, statuses, tab, category, deferredQuery, state.probe],
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

  // Versions, states and services follow the machine: the installer store re-reads
  // them on the shared poller while this page is open and visible.
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
          <Button size="sm" variant="ghost" onClick={() => copySession()}>
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
          <Button size="sm" variant="outline" onClick={() => navigate({ to: "/doctor" })}>
            <Stethoscope className="size-4" /> Doctor →
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!state.online && (
          <div className="rounded-surface border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
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

        <FilterTabs
          tabs={INSTALL_SECTIONS.map((item) => ({
            key: item.key,
            label:
              item.key === "queue" && activeJobs.length
                ? `${item.label} (${activeJobs.length})`
                : item.key === "services" && state.services.some((x) => x.running)
                  ? `${item.label} (${state.services.filter((x) => x.running).length} on)`
                  : item.label,
          }))}
          value={section}
          onChange={(key) => setSection(key as InstallSection)}
        />

        {section === "software" && (
          <>
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
                  <FilterTabs
                    tabs={[
                      { key: "all", label: "All categories" },
                      ...allCategories.map((c) => ({ key: c, label: c })),
                    ]}
                    value={category}
                    onChange={setCategory}
                    wrap
                  />
                </div>

                {rows.length === 0 ? (
                  <EmptyState title="No catalog entries match this filter." />
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
                      const path =
                        probe?.path || (e.method === "api-key" ? "Models › Providers" : "");
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
                        <span
                          key="l"
                          className="font-mono text-xs text-muted-foreground"
                          title={
                            installer.latestKnown(e)
                              ? "newest version, read from the official source just now"
                              : "no official source names a newer version for this tool"
                          }
                        >
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
                          <span key="st" className="flex items-center gap-1">
                            <StatusPill label={status} tone={toneForStatus(status)} />
                            {installer.serviceOf(e.pkg)?.running ? (
                              <StatusPill label="running" tone="accent" />
                            ) : null}
                          </span>
                        ),
                        <div key="a" className="flex items-center gap-1">
                          {job ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-note text-muted-foreground"
                              onClick={() => installer.cancel(job.id)}
                            >
                              <X className="size-3" /> Cancel
                            </Button>
                          ) : status === "Not installed" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-note"
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
                                  className="h-6 px-2 text-note"
                                  onClick={() => run(e.pkg, "update")}
                                >
                                  <Download className="size-3" /> Update
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-note"
                                title="Repair installation"
                                onClick={() => run(e.pkg, "repair")}
                              >
                                <Wrench className="size-3" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-note text-muted-foreground"
                                title={`Roll back to ${state.previous[e.pkg] ?? "previous build"}`}
                                disabled={!state.previous[e.pkg]}
                                onClick={() => run(e.pkg, "rollback")}
                              >
                                <RotateCcw className="size-3" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-note text-destructive"
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
                            className="h-6 px-2 text-note"
                            title="Copy install path"
                            onClick={() => copyValue("Path", path)}
                          >
                            <Copy className="size-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-note"
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
            {selectedEntry ? (
              <PackageDetails
                entry={selectedEntry}
                onClose={() => setSelectedPkg(null)}
                onRun={run}
                onAsk={askAbout}
                onCopy={copyValue}
              />
            ) : null}
          </>
        )}

        {section === "queue" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <HudPanel
              title="Install Queue"
              hint={`${activeJobs.length} active · ${state.concurrency} parallel`}
              actions={
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-note"
                    onClick={() => installer.setPaused(!state.paused)}
                  >
                    {state.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                    {state.paused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-note"
                    onClick={() => installer.setConcurrency(state.concurrency + 1)}
                  >
                    +1
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-note"
                    onClick={() => installer.clearFinished()}
                  >
                    Clear
                  </Button>
                </div>
              }
            >
              {activeJobs.length === 0 && finishedJobs.length === 0 ? (
                <EmptyState title="Queue idle. Install, update or repair a package to start a job." />
              ) : (
                <ul className="space-y-3">
                  {activeJobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                  {finishedJobs.map((job) => (
                    <li
                      key={job.id}
                      className="flex items-center justify-between gap-2 rounded-ctl border border-border/50 px-2 py-1.5"
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
                            className="h-6 px-2 text-note"
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
              title="Update Manager"
              hint="live counts — confirmation required to queue"
              actions={
                <Button size="sm" className="h-6 px-2 text-note" onClick={onUpdateAll}>
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
          </div>
        )}

        {section === "services" && <ServicesPanel />}

        {section === "health" && (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
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
              <HudPanel title="Installer Capabilities" hint="all wired to the engine">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {installerFunctions.map((f) => (
                    <div
                      key={f.label}
                      className="flex items-center justify-between gap-2 rounded-ctl border border-border/50 px-2 py-1.5"
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
              <p className="w-full text-note text-muted-foreground">
                Downloads come from the vendor URLs above, are checksum- and signature-verified,
                installed silently and logged on this page (persisted with installer state). Desktop
                FRIDAY also writes telemetry under{" "}
                <span className="font-mono">&lt;FRIDAY_ROOT&gt;/logs</span>. Progress, retries and
                rollbacks survive a reload. User data under the FRIDAY root is never destroyed by
                install, update or rollback.
              </p>
            </HudPanel>
          </>
        )}

        {section === "activity" && (
          <HudPanel
            title={showHistory ? "Install History" : "Installer Log"}
            hint={showHistory ? `${state.history.length} events` : `${state.log.length} lines`}
            actions={
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-note"
                onClick={() => setShowHistory((v) => !v)}
              >
                <History className="size-3" /> {showHistory ? "Show log" : "Show history"}
              </Button>
            }
          >
            {showHistory ? (
              state.history.length === 0 ? (
                <EmptyState title="No install history yet." />
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto text-data">
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
              <ul ref={logRef} className="max-h-64 space-y-1 overflow-y-auto text-data">
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
        )}

        {section === "ask" && (
          <HudPanel
            title="Ask FRIDAY"
            hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
          >
            <p className="mb-2 text-xs text-muted-foreground">
              FRIDAY can see this live catalog (status, official source, probed path, queue, log).
              Say scan install manager, install python, install required, or installer status —
              those commands call the same engine.
            </p>
            <div className="mb-3 max-h-48 space-y-2 overflow-auto text-sm">
              {recent.length ? (
                recent.map((line) => (
                  <p key={line.id} className="whitespace-pre-wrap">
                    <span className="mr-2 text-note-sm uppercase tracking-widest text-muted-foreground">
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
        )}
      </div>
    </AppShell>
  );
}

/** Start / Stop / Restart for one service, with what is happening and what is allowed. */
function ServiceButtons({ row, busy }: { row: ServiceRow; busy?: string | undefined }) {
  const act = (op: "start" | "stop" | "restart") => {
    void installer.serviceAction(row.id, op).then((result) => {
      if (result.ok) toast.success(`${row.id} — ${result.message}`);
      else toast.error(`${row.id} — ${result.message}`);
    });
  };
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-note"
        disabled={Boolean(busy) || !row.canStart}
        title={row.installed ? "Start it" : "Install it first"}
        onClick={() => act("start")}
      >
        <Power className="size-3" /> {busy === "start" ? "Starting…" : "Start"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-note"
        disabled={Boolean(busy) || !row.canStop}
        onClick={() => act("stop")}
      >
        <Square className="size-3" /> {busy === "stop" ? "Stopping…" : "Stop"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-note"
        disabled={Boolean(busy) || !row.canStop}
        title="Stop it and start it again"
        onClick={() => act("restart")}
      >
        <RotateCcw className="size-3" /> {busy === "restart" ? "Restarting…" : "Restart"}
      </Button>
    </div>
  );
}

const IDLE_CHOICES = [
  { minutes: 0, label: "Never stop them" },
  { minutes: 10, label: "After 10 idle minutes" },
  { minutes: 20, label: "After 20 idle minutes" },
  { minutes: 60, label: "After 1 idle hour" },
  { minutes: 180, label: "After 3 idle hours" },
];

function ServicesPanel() {
  const state = useInstaller();
  const desktop = state.bridge === "desktop";
  return (
    <HudPanel
      title="Background services"
      hint={`${state.services.filter((x) => x.running).length} running · checked every 15 s`}
      actions={
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-note"
          onClick={() => void installer.refreshServices()}
        >
          <RefreshCw className="size-3" /> Refresh
        </Button>
      }
    >
      {!desktop ? (
        <EmptyState title="Services need the desktop app." />
      ) : state.services.length === 0 ? (
        <EmptyState title="Reading the services on this PC…" />
      ) : (
        <div className="space-y-3">
          <p className="text-note text-muted-foreground">
            FRIDAY starts a service when work needs it and stops the ones she started when they sit
            unused, and when she quits. A service that was already running is never stopped unless
            you press Stop. Windows services (databases) ask for administrator approval.
          </p>
          <DataTable
            columns={["Service", "What it is", "State", "Who started it", "Control"]}
            rows={state.services.map((row) => [
              <span key="n" className="text-foreground">
                {row.id}
              </span>,
              <span key="k" className="text-xs text-muted-foreground">
                {row.note}
                {row.needsAdmin ? " · Windows service" : ""}
              </span>,
              <StatusPill
                key="s"
                label={
                  state.serviceBusy[row.id]
                    ? "working…"
                    : row.running
                      ? "running"
                      : row.installed
                        ? "stopped"
                        : "not installed"
                }
                tone={row.running ? "accent" : row.installed ? "muted" : "warning"}
              />,
              <span key="o" className="text-xs text-muted-foreground">
                {row.running
                  ? row.ownedByFriday
                    ? `FRIDAY · idle ${row.idleMinutes ?? 0} min`
                    : "already running; left alone"
                  : "—"}
              </span>,
              <ServiceButtons key="c" row={row} busy={state.serviceBusy[row.id]} />,
            ])}
          />
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Stop the ones FRIDAY started:</span>
            <select
              aria-label="When to stop services FRIDAY started"
              value={state.serviceIdleMinutes}
              onChange={(event) => void installer.setServiceIdle(Number(event.target.value))}
              className="h-8 rounded-ctl border border-border bg-surface px-2 text-meta text-foreground outline-none focus:border-primary/50"
            >
              {IDLE_CHOICES.map((choice) => (
                <option key={choice.minutes} value={choice.minutes}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </HudPanel>
  );
}

/** How FRIDAY gets this package, in the words the owner would use. */
function installRoute(entry: CatalogEntry): string {
  switch (entry.method) {
    case "winget":
      return "winget; if winget is missing or refuses, the vendor's own installer from its official release feed, checked against the vendor's SHA-256";
    case "pip":
      return "pip, into FRIDAY's own Python";
    case "npm":
      return "npm, globally";
    case "vendor":
      return "the vendor's installer or archive, downloaded from several official sources and checked against a pinned SHA-256";
    case "bundled":
      return "unpacked from what FRIDAY ships with, then kept current from the official release";
    case "api-key":
      return "a key you add in Models › Providers";
    default:
      return entry.method;
  }
}

function PackageDetails({
  entry,
  onClose,
  onRun,
  onAsk,
  onCopy,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onRun: (pkg: string, action: Parameters<typeof installer.enqueue>[1]) => void;
  onAsk: (pkg: string) => void;
  onCopy: (label: string, value: string) => void;
}) {
  const state = useInstaller();
  const status = installer.statusOf(entry);
  const installed = state.installed[entry.pkg] ?? null;
  const probe = state.probe[entry.pkg];
  const service = installer.serviceOf(entry.pkg);
  const busyJob = state.jobs.find((j) => j.pkg === entry.pkg && isJobActive(j.phase));
  const lastJob = [...state.jobs]
    .reverse()
    .find((j) => j.pkg === entry.pkg && !isJobActive(j.phase));
  const facts: [string, string][] = [
    ["Installed", installed ?? "not installed"],
    [
      "Newest",
      installer.latestKnown(entry)
        ? `${installer.latestOf(entry)} (read from the official source)`
        : "no official source names a newer version",
    ],
    ["Where", probe?.path || "—"],
    ["Installed by", probe?.manager ?? entry.method],
    ["How FRIDAY installs it", installRoute(entry)],
    ["Size", entry.size],
    ["Needs", entry.needs?.length ? entry.needs.join(", ") : "nothing else"],
  ];
  return (
    <HudPanel
      title="Package details"
      hint={`${entry.pkg} · ${entry.category}`}
      actions={
        <Button size="sm" variant="ghost" className="h-6 px-2 text-note" onClick={onClose}>
          <X className="size-3" /> Close
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={busyJob ? busyJob.phase : status} tone={toneForStatus(status)} />
          <Badge variant="outline" className="label-xs">
            {entry.requirement}
          </Badge>
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
          >
            {entry.source}
            <ExternalLink className="size-3" />
          </a>
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words font-mono text-xs text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {entry.notes ? <p className="text-note text-muted-foreground">{entry.notes}</p> : null}
        {probe?.manual ? <p className="text-note text-warning">By hand: {probe.manual}</p> : null}
        {lastJob && lastJob.phase !== "Done" ? (
          <p className="text-note text-muted-foreground">
            Last attempt: {lastJob.phase} — {lastJob.error ?? lastJob.detail}
          </p>
        ) : null}
        {service ? (
          <div className="flex flex-wrap items-center gap-3 rounded-ctl border border-border/60 px-3 py-2">
            <span className="text-sm">
              Service:{" "}
              <span className={service.running ? "text-success" : "text-muted-foreground"}>
                {service.running ? "running" : service.installed ? "stopped" : "not installed"}
              </span>
            </span>
            <ServiceButtons row={service} busy={state.serviceBusy[service.id]} />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {!installed ? (
            <Button
              size="sm"
              disabled={Boolean(busyJob)}
              onClick={() => onRun(entry.pkg, "install")}
            >
              <Download className="size-4" /> Install
            </Button>
          ) : (
            <>
              {status === "Update available" ? (
                <Button
                  size="sm"
                  disabled={Boolean(busyJob)}
                  onClick={() => onRun(entry.pkg, "update")}
                >
                  <Download className="size-4" /> Update to {installer.latestOf(entry)}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busyJob)}
                onClick={() => onRun(entry.pkg, "verify")}
              >
                <ShieldCheck className="size-4" /> Verify
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busyJob)}
                onClick={() => onRun(entry.pkg, "repair")}
              >
                <Wrench className="size-4" /> Repair
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(busyJob) || !state.previous[entry.pkg]}
                onClick={() => onRun(entry.pkg, "rollback")}
              >
                <RotateCcw className="size-4" /> Roll back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={Boolean(busyJob)}
                onClick={() => onRun(entry.pkg, "uninstall")}
              >
                <Trash2 className="size-4" /> Uninstall
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => onCopy("Path", probe?.path ?? "")}>
            <Copy className="size-4" /> Copy path
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAsk(entry.pkg)}>
            Ask FRIDAY
          </Button>
        </div>
      </div>
    </HudPanel>
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
          <span className="text-meta-sm text-muted-foreground">
            {job.phase === "Downloading" ? formatEta(job.etaSeconds) : ""}
          </span>
          <StatusPill label={job.phase} tone={phaseTone(job.phase)} />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-note text-muted-foreground"
            aria-label="Cancel this install"
            title="Cancel this install"
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
