import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Boxes,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  Link2,
  MonitorCog,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
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
  modelSourceLine,
  providerKnowledgeLine,
  PROVIDER_KNOWLEDGE_VIEW,
} from "@/lib/friday/knowledge-age";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  explainChoice,
  probeOwnerMessage,
  refreshOwnerMessage,
  signupGuide,
} from "@/lib/friday/free-board";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  categories,
  checkSupport,
  modelCatalog,
  modelById,
  providerById,
  providers,
  routingTasks,
  supportedFormats,
  type ModelCategory,
  type ModelSpec,
  type ProviderId,
  type RoutingTask,
} from "@/lib/friday/model-catalog";
import {
  formatEta,
  formatGb,
  isJobActive,
  models as engine,
  type Job,
} from "@/lib/friday/models-engine";
import { billing, type AccessTier } from "@/lib/friday/billing";
import { useBilling } from "@/lib/friday/use-billing";
import { modelRegistry } from "@/lib/friday/model-registry";
import { useModelRegistry } from "@/lib/friday/use-model-registry";
import { sourceCount } from "@/lib/friday/model-sources";
import { useModels } from "@/lib/friday/use-models";

const modelsPageClock = Date.now();

export const Route = createFileRoute("/models")({
  head: () => ({
    meta: [
      { title: "Models Manager — FRIDAY" },
      {
        name: "description",
        content:
          "Detect, download, import, connect, benchmark and route every local and cloud AI model FRIDAY uses — Ollama, LM Studio, llama.cpp, vLLM, OpenAI, Claude, Gemini and more.",
      },
      { property: "og:title", content: "Models Manager — FRIDAY" },
      {
        property: "og:description",
        content:
          "One orchestration layer for local engines and cloud providers, with live telemetry and task routing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ModelsPage,
});

const TABS = [
  { key: "catalog", label: "Catalog" },
  { key: "installed", label: "Installed" },
  { key: "providers", label: "Providers" },
  { key: "routing", label: "Routing & Modes" },
  { key: "runtime", label: "Live Runtime" },
  { key: "benchmarks", label: "Benchmarks" },
  { key: "connect", label: "Import & Connect" },
  { key: "activity", label: "Activity" },
];

const logTone = {
  info: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const;

function phaseTone(phase: Job["phase"]) {
  if (phase === "Failed") return "destructive" as const;
  if (phase === "Cancelled" || phase === "Queued") return "muted" as const;
  if (phase === "Done") return "accent" as const;
  return "primary" as const;
}

function ModelsPage() {
  const state = useModels();
  const registry = useModelRegistry();
  const [tab, setTab] = useState("catalog");
  const [category, setCategory] = useState<"all" | ModelCategory>("all");
  const [kind, setKind] = useState<"all" | "local" | "cloud">("all");
  const [query, setQuery] = useState("");
  const [routeDraft, setRouteDraft] = useState("");
  const [routePreview, setRoutePreview] = useState("No dry run yet.");
  const [notified, setNotified] = useState<string[]>([]);

  useEffect(() => {
    const fresh = state.jobs.filter((j) => !isJobActive(j.phase) && !notified.includes(j.id));
    if (fresh.length === 0) return;
    fresh.forEach((j) => {
      const name = modelById.get(j.modelId)?.name ?? j.modelId;
      if (j.phase === "Done") toast.success(`${name} — ${j.detail}`);
      else if (j.phase === "Failed") toast.error(`${name} failed`, { description: j.error });
      else toast(`${name} cancelled`);
    });
    setNotified((prev) => [...prev, ...fresh.map((j) => j.id)].slice(-60));
  }, [state.jobs, notified]);

  const statuses = useMemo(() => {
    // statusOf reads the shared registry; these revisions keep it synchronized.
    void state.installed;
    void state.providerState;
    return new Map(modelCatalog.map((m) => [m.id, engine.statusOf(m.id)] as const));
  }, [state.installed, state.providerState]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modelCatalog.filter((m) => {
      if (kind !== "all" && m.kind !== kind) return false;
      if (category !== "all" && m.category !== category) return false;
      if (tab === "installed" && statuses.get(m.id) === "Not installed") return false;
      if (tab === "installed" && m.kind === "cloud" && statuses.get(m.id) === "Available")
        return false;
      if (!q) return true;
      return `${m.name} ${m.provider} ${m.category} ${m.params} ${m.format} ${m.license}`
        .toLowerCase()
        .includes(q);
    });
  }, [query, kind, category, tab, statuses]);

  /**
   * What this exact PC can run well today — measured against the detected
   * VRAM/RAM — and what it could run with a bigger card. Both lists only
   * contain models FRIDAY has a real download source for.
   */
  const { recommended, stretch } = useMemo(() => {
    const local = modelCatalog.filter((m) => m.kind === "local" && sourceCount(m.id) > 0);
    const fits = local
      .filter((m) => {
        const level = checkSupport(m, state.system).level;
        return level === "Supported" || level === "Optimal";
      })
      .sort((a, b) => b.sizeGb - a.sizeGb)
      .slice(0, 6);
    const bigger = local
      .filter((m) => !fits.includes(m) && m.vramGb > state.system.vramGb)
      .sort((a, b) => a.vramGb - b.vramGb)
      .slice(0, 5);
    return { recommended: fits, stretch: bigger };
  }, [state.system]);

  const counts = useMemo(() => {
    const values = [...statuses.values()];
    const local = modelCatalog.filter((m) => m.kind === "local" && state.installed[m.id]);
    return {
      total: modelCatalog.length,
      installed: local.length,
      updates: values.filter((v) => v === "Update available").length,
      cloud: providers.filter((p) => p.kind === "cloud" && state.providerState[p.id]?.apiKey)
        .length,
      diskGb: local.reduce((sum, m) => sum + m.sizeGb, 0),
      running: Object.values(state.runtimes).filter((r) => r.state === "Running").length,
    };
  }, [statuses, state.installed, state.providerState, state.runtimes]);

  const activeJobs = state.jobs.filter((j) => isJobActive(j.phase));
  const vramUsed = Object.values(state.runtimes).reduce((s, r) => s + r.vramGb, 0);
  const totalTps = Object.values(state.runtimes).reduce((s, r) => s + r.tokensPerSec, 0);

  return (
    <AppShell
      title="Models Manager"
      subtitle="Universal orchestration for local engines and cloud providers"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => engine.probeSystem()}>
            <MonitorCog className="size-4" />
            Check system
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => engine.scan()}
            disabled={state.scanning}
          >
            <RefreshCw className={state.scanning ? "size-4 animate-spin" : "size-4"} />
            {state.scanning ? `Scanning ${Math.round(state.scanProgress)}%` : "Detect models"}
          </Button>
          <Button size="sm" onClick={() => engine.updateAll()}>
            <Download className="size-4" />
            Update all
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Free models</h2>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => toast(refreshOwnerMessage())}>
                Refresh free list
              </Button>
              <Button size="sm" variant="outline" onClick={() => toast(probeOwnerMessage())}>
                Test my free models
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{explainChoice("chat")}</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {signupGuide().map((row) => (
              <li key={row.id}>
                <a className="underline" href={row.href} target="_blank" rel="noreferrer">
                  {row.label}
                </a>
                <span> — {row.dataUse}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* -------------------------------------------------------- overview */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile
            icon={<Boxes className="size-3.5" />}
            label="Catalog"
            value={counts.total}
            state={`${providers.length} providers`}
          />
          <StatTile
            icon={<CheckCircle2 className="size-3.5" />}
            label="Installed"
            value={counts.installed}
            state={formatGb(counts.diskGb)}
            tone="accent"
          />
          <StatTile
            icon={<Download className="size-3.5" />}
            label="Updates"
            value={counts.updates}
            state={counts.updates ? "action needed" : "up to date"}
            tone={counts.updates ? "warning" : "accent"}
          />
          <StatTile
            icon={<KeyRound className="size-3.5" />}
            label="Cloud keys"
            value={counts.cloud}
            state="connected"
            tone="magenta"
          />
          <StatTile
            icon={<Zap className="size-3.5" />}
            label="Running"
            value={counts.running}
            state={`${totalTps.toFixed(0)} tok/s`}
            tone="accent"
          />
          <StatTile
            icon={<Cpu className="size-3.5" />}
            label="VRAM"
            value={`${vramUsed.toFixed(1)}G`}
            state={`of ${state.system.vramGb || "—"} GB`}
            tone="warning"
          />
        </div>

        <HudPanel
          title="System support"
          hint={
            state.system.probedAt
              ? `probed ${new Date(state.system.probedAt).toLocaleTimeString()}`
              : "not probed"
          }
          actions={
            <StatusPill
              label={state.bridge === "desktop" ? "kernel bridge" : "preview mode"}
              tone={state.bridge === "desktop" ? "accent" : "muted"}
            />
          }
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ["Operating system", state.system.os],
                [
                  "CPU",
                  state.system.probedAt
                    ? `${state.system.cpu} · ${state.system.cores} threads`
                    : "unknown",
                ],
                [
                  "System RAM",
                  state.system.probedAt && state.system.ramGb
                    ? `${state.system.ramGb} GB`
                    : "unknown",
                ],
                ["GPU", state.system.gpu],
                [
                  "VRAM",
                  state.system.probedAt
                    ? state.system.vramGb
                      ? `${state.system.vramGb} GB`
                      : "unknown"
                    : "unknown",
                ],
                ["Accelerator", state.system.cuda ?? "unknown"],
                [
                  "Free disk",
                  state.system.probedAt && state.system.diskFreeGb
                    ? `${state.system.diskFreeGb} GB`
                    : "unknown",
                ],
                ["Execution device", state.device],
              ].map(([k, v]) => (
                <div key={k} className="hud-tile rounded-md px-3 py-2">
                  <p className="label-xs text-muted-foreground">{k}</p>
                  <p className="truncate font-mono text-[12px] text-foreground">{v}</p>
                </div>
              ))}
            </div>
            <div className="space-y-3">
              <MetricBar
                label="VRAM in use"
                value={
                  state.system.vramGb
                    ? Math.min(100, Math.round((vramUsed / state.system.vramGb) * 100))
                    : 0
                }
                detail={`${vramUsed.toFixed(1)} GB resident across ${counts.running} loaded model(s)`}
                tone="warning"
              />
              <MetricBar
                label="Model storage"
                value={
                  state.system.diskFreeGb > 0
                    ? Math.min(100, Math.round((counts.diskGb / state.system.diskFreeGb) * 100))
                    : 0
                }
                detail={
                  state.system.diskFreeGb > 0
                    ? `${formatGb(counts.diskGb)} of ${state.system.diskFreeGb} GB free disk`
                    : "free disk unknown"
                }
                tone="primary"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="label-xs text-muted-foreground">Device</span>
                <FilterTabs
                  tabs={[
                    { key: "auto", label: "Auto" },
                    { key: "gpu", label: "GPU" },
                    { key: "cpu", label: "CPU" },
                  ]}
                  value={state.device}
                  onChange={(k) => engine.setDevice(k as typeof state.device)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {supportedFormats.map((f) => (
                  <Badge key={f.format} variant="outline" className="label-xs" title={f.note}>
                    {f.format}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </HudPanel>

        {/* ------------------------------------------------------ active jobs */}
        {activeJobs.length > 0 ? (
          <HudPanel title="Transfer queue" hint={`${activeJobs.length} active`}>
            <div className="space-y-3">
              {activeJobs.map((job) => (
                <div
                  key={job.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusPill label={job.phase} tone={phaseTone(job.phase)} />
                      <span className="truncate text-sm">{modelById.get(job.modelId)?.name}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${job.progress}%`, boxShadow: "0 0 8px currentColor" }}
                      />
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                      {job.detail}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => engine.cancel(job.id)}>
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </HudPanel>
        ) : null}

        <FilterTabs tabs={TABS} value={tab} onChange={setTab} />

        {/* --------------------------------------------------------- catalog */}
        {(tab === "catalog" || tab === "installed") && (
          <HudPanel
            title={tab === "installed" ? "Installed models" : "Master catalog"}
            hint={`${filtered.length} of ${modelCatalog.length}`}
            actions={
              <div className="flex items-center gap-2">
                <div className="relative hidden sm:block">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models…"
                    className="h-8 w-52 pl-7 font-mono text-xs"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.discovering}
                  onClick={() => void engine.discover(query)}
                >
                  {state.discovering ? "Searching online…" : "Search online"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.discovering}
                  onClick={() => void engine.discover(query, "latest")}
                  title="Newest releases first, straight from the public index"
                >
                  Latest
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.discovering}
                  onClick={() => void engine.aiRefreshCatalog(query)}
                  title="Let FRIDAY's cloud model suggest current models — each one verified before it is listed"
                >
                  <Zap className="size-3.5" />
                  AI refresh
                </Button>
              </div>
            }
          >
            {state.discovered.length > 0 || state.discoveryError ? (
              <div className="mb-3 rounded-md border border-border/60 bg-muted/20 p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label-xs text-muted-foreground">
                    {state.discoveryError
                      ? state.discoveryError
                      : `${state.discovered.length} models found online${
                          state.discoveryAt
                            ? ` · ${new Date(state.discoveryAt).toLocaleTimeString()}`
                            : ""
                        }`}
                  </span>
                  {state.discovered.length ? (
                    <Button size="sm" variant="ghost" onClick={() => engine.clearDiscovery()}>
                      Clear
                    </Button>
                  ) : null}
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {state.discovered.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{d.name}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {d.vendor} · {d.format} · {d.params} · {d.source}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Badge variant="outline" className="label-xs">
                          {d.category}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void engine.installDiscovered(d)}
                        >
                          {d.installedLocally ? "Refresh" : "Install"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {tab === "catalog" && (recommended.length > 0 || stretch.length > 0) ? (
              <div className="mb-3 grid gap-2 lg:grid-cols-2">
                <div className="rounded-md border border-border/60 bg-muted/20 p-2">
                  <p className="label-xs mb-1.5 text-muted-foreground">
                    Recommended for this PC · {state.system.gpu || "CPU"} · {state.system.vramGb} GB
                    VRAM · {state.system.ramGb} GB RAM
                  </p>
                  <div className="space-y-1">
                    {recommended.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{m.name}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {m.category} · {formatGb(m.sizeGb)} · {sourceCount(m.id)} source(s)
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(state.installed[m.id])}
                          onClick={() => engine.install(m.id)}
                        >
                          {state.installed[m.id] ? "Installed" : "Download"}
                        </Button>
                      </div>
                    ))}
                    {recommended.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        No catalog model fits this machine yet — run a hardware scan.
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 bg-muted/20 p-2">
                  <p className="label-xs mb-1.5 text-muted-foreground">
                    Bigger rigs · downloadable, needs more VRAM/RAM
                  </p>
                  <div className="space-y-1">
                    {stretch.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{m.name}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {m.category} · {formatGb(m.sizeGb)} · wants {m.vramGb} GB VRAM
                          </div>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => engine.install(m.id)}>
                          <Download className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            <div className="mb-3 space-y-2">
              <FilterTabs
                tabs={[
                  { key: "all", label: "All sources" },
                  { key: "local", label: "Local" },
                  { key: "cloud", label: "Cloud" },
                ]}
                value={kind}
                onChange={(k) => setKind(k as typeof kind)}
              />
              <FilterTabs
                tabs={[
                  { key: "all", label: "All types" },
                  ...categories.map((c) => ({ key: c, label: c })),
                ]}
                value={category}
                onChange={(k) => setCategory(k as typeof category)}
              />
            </div>

            <DataTable
              columns={["Model", "Provider", "Type", "Size / Ctx", "Support", "Status", "Actions"]}
              rows={filtered.map((m) => {
                const status = statuses.get(m.id)!;
                const support = checkSupport(m, state.system);
                const runtime = state.runtimes[m.id];
                const busy = state.jobs.some((j) => j.modelId === m.id && isJobActive(j.phase));
                return [
                  <div key="n" className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{m.name}</span>
                      {m.caps.includes("vision") ? (
                        <Badge variant="outline" className="label-xs">
                          vision
                        </Badge>
                      ) : null}
                      {m.caps.includes("tools") ? (
                        <Badge variant="outline" className="label-xs">
                          tools
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {m.params} · {m.quant} · {m.format} · {m.license}
                      {m.kind === "local" ? ` · ${sourceCount(m.id)} download source(s)` : ""}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {modelSourceLine(m, modelsPageClock)}
                    </p>
                  </div>,
                  <span key="p" className="font-mono text-[11px] text-muted-foreground">
                    {providerById.get(m.provider)?.name}
                  </span>,
                  <span key="c" className="font-mono text-[11px] text-muted-foreground">
                    {m.category}
                  </span>,
                  <span key="s" className="font-mono text-[11px] text-muted-foreground">
                    {m.kind === "cloud" ? "hosted" : formatGb(m.sizeGb)} · {m.ctxK}k
                  </span>,
                  <span key="sup" title={support.reason}>
                    <StatusPill label={support.level} tone={support.tone} />
                  </span>,
                  <span key="st" className="flex items-center gap-1.5">
                    <StatusPill
                      label={status}
                      tone={toneForStatus(status === "Installed" ? "ready" : status)}
                    />
                    {runtime ? (
                      <StatusPill
                        label={runtime.state}
                        tone={runtime.state === "Running" ? "accent" : "primary"}
                      />
                    ) : null}
                  </span>,
                  <div key="a" className="flex items-center gap-1">
                    {m.kind === "local" && status !== "Installed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => engine.install(m.id)}
                      >
                        <Download className="size-3.5" />
                        {status === "Update available" ? "Update" : "Download"}
                      </Button>
                    ) : null}
                    {runtime ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => engine.unload(m.id)}
                        title="Unload"
                      >
                        <Square className="size-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => engine.load(m.id)}
                        title="Load"
                      >
                        <Play className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => engine.benchmark(m.id)}
                      title="Benchmark"
                    >
                      <Gauge className="size-3.5" />
                    </Button>
                    {m.kind === "local" && state.installed[m.id] ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => engine.remove(m.id)}
                        title="Delete"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    ) : null}
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                      className="grid size-8 place-items-center rounded-sm text-muted-foreground hover:text-primary"
                      title="Official source"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>,
                ];
              })}
            />
          </HudPanel>
        )}

        {/* -------------------------------------------------------- providers */}
        {tab === "providers" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <BillingPanel />
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
              <Button size="sm" variant="outline" onClick={() => engine.syncKnowledge()}>
                <RefreshCw className="size-4" />
                Sync now
              </Button>
              <Button size="sm" variant="outline" onClick={() => engine.healProviders()}>
                Heal
              </Button>
              {registry.hint ? (
                <p className="font-mono text-[10px] text-muted-foreground">{registry.hint}</p>
              ) : null}
            </div>
            {(["local", "cloud"] as const).map((group) => (
              <HudPanel
                key={group}
                title={group === "local" ? "Local providers" : "Cloud providers"}
                hint={`${providers.filter((p) => p.kind === group).length} supported`}
              >
                <ul className="space-y-2.5">
                  {providers
                    .filter((p) => p.kind === group)
                    .map((p) => {
                      const ps = state.providerState[p.id]!;
                      return (
                        <li key={p.id} className="hud-tile rounded-md px-3 py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-medium">{p.name}</span>
                                <StatusPill
                                  label={ps.online ? "Online" : "Offline"}
                                  tone={ps.online ? "accent" : "muted"}
                                />
                                {ps.apiKey ? <StatusPill label="key set" tone="magenta" /> : null}
                              </div>
                              <p className="truncate font-mono text-[10px] text-muted-foreground">
                                {ps.endpoint}
                              </p>
                              <p className="truncate font-mono text-[10px] text-muted-foreground">
                                {p.detect} · {ps.models} model(s) ·{" "}
                                {ps.latencyMs != null ? `${ps.latencyMs} ms` : ps.error}
                              </p>
                              <p className="truncate text-[10px] text-muted-foreground">
                                {providerKnowledgeLine(
                                  PROVIDER_KNOWLEDGE_VIEW[p.id],
                                  modelsPageClock,
                                )}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => engine.testProvider(p.id)}
                                title="Health check"
                              >
                                <RadioTower className="size-3.5" />
                              </Button>
                              {p.docs ? (
                                <a
                                  href={p.docs}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="grid size-8 place-items-center rounded-sm text-muted-foreground hover:text-primary"
                                >
                                  <ExternalLink className="size-3.5" />
                                </a>
                              ) : null}
                            </div>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">{p.notes}</p>
                          <ProviderUse
                            providerId={p.id}
                            name={p.name}
                            connected={Boolean(ps.apiKey) || (group === "local" && ps.online)}
                            found={ps.models}
                            models={registry.models}
                            cloud={group === "cloud"}
                          />
                        </li>
                      );
                    })}
                </ul>
              </HudPanel>
            ))}
          </div>
        )}

        {/* ---------------------------------------------------------- routing */}
        {tab === "routing" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <HudPanel title="Task routing" hint="one model per job">
              <div className="space-y-2">
                {routingTasks.map((task) => {
                  const options = modelCatalog.filter(
                    (m) =>
                      task.accepts.includes(m.category) &&
                      engine.statusOf(m.id) !== "Not installed" &&
                      engine.statusOf(m.id) !== "Available",
                  );
                  const current = state.routing[task.key];
                  return (
                    <div
                      key={task.key}
                      className="hud-tile grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] items-center gap-3 rounded-md px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{task.label}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {task.hint}
                        </p>
                      </div>
                      <select
                        value={current ?? ""}
                        onChange={(e) =>
                          engine.assign(task.key as RoutingTask, e.target.value || null)
                        }
                        className="h-8 w-full rounded-sm border border-border bg-surface px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/50"
                      >
                        <option value="">— unassigned —</option>
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({providerById.get(m.provider)?.name})
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </HudPanel>

            <HudPanel
              title="Multi-model mode"
              hint={`${state.multiModel.length} selected`}
              actions={
                <div className="flex items-center gap-2">
                  <span className="label-xs text-muted-foreground">parallel</span>
                  <Switch
                    checked={state.parallel}
                    onCheckedChange={(v) => engine.setParallel(v)}
                    aria-label="Parallel execution"
                  />
                </div>
              }
            >
              <p className="mb-2 text-[11px] text-muted-foreground">
                Selected models answer the same prompt together in the chat panel —{" "}
                {state.parallel ? "fanned out in parallel" : "run one after another"}.
              </p>
              <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {modelCatalog
                  .filter(
                    (m) =>
                      ["Chat", "Reasoning", "Coding", "Multimodal"].includes(m.category) &&
                      engine.statusOf(m.id) !== "Not installed" &&
                      engine.statusOf(m.id) !== "Available",
                  )
                  .map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{m.name}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {providerById.get(m.provider)?.name} · {m.category}
                        </p>
                      </div>
                      <Switch
                        checked={state.multiModel.includes(m.id)}
                        onCheckedChange={() => engine.toggleMulti(m.id)}
                        aria-label={`Use ${m.name} in multi-model mode`}
                      />
                    </li>
                  ))}
              </ul>
            </HudPanel>
            <div className="lg:col-span-2">
              <HudPanel title="Routing playground" hint="dry run, no model is called">
                <div className="space-y-2">
                  <textarea
                    value={routeDraft}
                    onChange={(event) => setRouteDraft(event.target.value)}
                    placeholder="Ask something. This only builds a route plan."
                    className="h-20 w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void engine.previewPrompt(routeDraft).then(setRoutePreview);
                    }}
                  >
                    Dry run
                  </Button>
                  <p className="font-mono text-[11px] text-muted-foreground">{routePreview}</p>
                </div>
              </HudPanel>
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------- runtime */}
        {tab === "runtime" && (
          <HudPanel title="Loaded models — live telemetry" hint={`${counts.running} running`}>
            {Object.keys(state.runtimes).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No model loaded. Press <Play className="inline size-3.5" /> on any installed model
                to bring it online.
              </p>
            ) : (
              <DataTable
                columns={[
                  "Model",
                  "State",
                  "Tokens/s",
                  "Latency",
                  "VRAM",
                  "CPU / GPU",
                  "Requests",
                  "",
                ]}
                rows={Object.values(state.runtimes).map((rt) => {
                  const m = modelById.get(rt.modelId)!;
                  return [
                    <div key="n" className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {providerById.get(m.provider)?.name} · ctx {m.ctxK}k
                      </p>
                    </div>,
                    <StatusPill
                      key="s"
                      label={rt.state}
                      tone={rt.state === "Running" ? "accent" : "primary"}
                    />,
                    <span key="t" className="font-mono text-[11px] text-accent">
                      {rt.tokensPerSec.toFixed(1)}
                    </span>,
                    <span key="l" className="font-mono text-[11px] text-muted-foreground">
                      {rt.latencyMs} ms
                    </span>,
                    <span key="v" className="font-mono text-[11px] text-warning">
                      {rt.vramGb.toFixed(1)} GB
                    </span>,
                    <span key="c" className="font-mono text-[11px] text-muted-foreground">
                      {rt.cpuPct}% / {rt.gpuPct}%
                    </span>,
                    <span key="r" className="font-mono text-[11px] text-muted-foreground">
                      {rt.requests}
                    </span>,
                    <Button
                      key="a"
                      size="sm"
                      variant="ghost"
                      onClick={() => engine.unload(rt.modelId)}
                    >
                      <Square className="size-3.5" />
                      Unload
                    </Button>,
                  ];
                })}
              />
            )}
          </HudPanel>
        )}

        {/* ------------------------------------------------------- benchmarks */}
        {tab === "benchmarks" && (
          <HudPanel
            title="Benchmarks & comparison"
            hint={`${Object.keys(state.benchmarks).length} measured`}
          >
            {Object.keys(state.benchmarks).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No benchmark yet — press <Gauge className="inline size-3.5" /> on a model in the
                catalog.
              </p>
            ) : (
              <DataTable
                columns={[
                  "Model",
                  "Tokens/s",
                  "First token",
                  "Prompt tok/s",
                  "Quality",
                  "Peak VRAM",
                  "Measured",
                ]}
                rows={Object.values(state.benchmarks)
                  .sort((a, b) => b.tokensPerSec - a.tokensPerSec)
                  .map((b) => {
                    const m = modelById.get(b.modelId)!;
                    return [
                      <span key="n" className="font-medium">
                        {m.name}
                      </span>,
                      <span key="t" className="font-mono text-[11px] text-accent">
                        {b.tokensPerSec}
                      </span>,
                      <span key="f" className="font-mono text-[11px] text-muted-foreground">
                        {b.firstTokenMs} ms
                      </span>,
                      <span key="p" className="font-mono text-[11px] text-muted-foreground">
                        {b.promptTokensPerSec}
                      </span>,
                      <span key="q" className="font-mono text-[11px] text-primary">
                        {b.scoreQuality}
                      </span>,
                      <span key="v" className="font-mono text-[11px] text-warning">
                        {b.peakVramGb} GB
                      </span>,
                      <span key="a" className="font-mono text-[10px] text-muted-foreground">
                        {new Date(b.at).toLocaleTimeString()}
                      </span>,
                    ];
                  })}
              />
            )}
          </HudPanel>
        )}

        {/* --------------------------------------------------- import/connect */}
        {tab === "connect" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <ConnectPanel state={state} />
            <ImportPanel state={state} />
          </div>
        )}

        {/* --------------------------------------------------------- activity */}
        {tab === "activity" && (
          <HudPanel
            title="Model activity log"
            hint={`${state.log.length} lines`}
            actions={
              <StatusPill
                label={
                  state.lastScanAt
                    ? `scanned ${new Date(state.lastScanAt).toLocaleTimeString()}`
                    : "never scanned"
                }
                tone="muted"
              />
            }
          >
            <ul className="max-h-[28rem] space-y-1 overflow-y-auto font-mono text-[11px]">
              {state.log.map((l) => (
                <li key={l.id} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground/70">{l.at}</span>
                  <span className={logTone[l.level]}>{l.line}</span>
                </li>
              ))}
            </ul>
          </HudPanel>
        )}
      </div>
    </AppShell>
  );
}

/* --------------------------------------------------------------- sub-panels */

function ProviderUse({
  providerId,
  name,
  connected,
  found,
  models,
  cloud,
}: {
  providerId: string;
  name: string;
  connected: boolean;
  found: number;
  models: ReturnType<typeof useModelRegistry>["models"];
  cloud: boolean;
}) {
  const rows = models.filter((model) => model.providerId === providerId);
  const usable = rows.filter(
    (model) => model.visibility === "show" || (model.visibility == null && model.eligible),
  );
  const cooling = rows.filter((model) => model.visibility === "disabled");
  const hidden = rows.filter((model) => model.visibility === "hide");
  const reasons = new Map<string, number>();
  for (const row of hidden) {
    const reason = row.reason || "hidden";
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  const reasonLine = [...reasons.entries()]
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(", ");
  const pick = usable[0];
  return (
    <div className="mt-2 space-y-1.5">
      <p className="font-mono text-[10px] text-muted-foreground">
        {connected ? "connected" : "not connected"} · {found} found · USABLE NOW {usable.length} ·
        HIDDEN {hidden.length}
        {cooling.length ? ` · limited ${cooling.length}` : ""}
        {reasonLine ? ` · ${reasonLine}` : ""}
      </p>
      {cloud ? (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void billing.setOwnerDeclaration(providerId, { ownerFreeTier: true }).then(() => {
                void modelRegistry.refresh(true);
                toast.success(`${name} — this key is treated as the free tier`);
              });
            }}
          >
            Treat key as free tier
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void billing.setPaidAccess(true);
              toast.success("Paid access is on. Paid and cost-unknown models can appear.");
            }}
          >
            Allow paid
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!pick}
            onClick={() => {
              if (!pick) return;
              void modelRegistry.setRouteMode("manual").then(() => {
                modelRegistry.clearSelection();
                modelRegistry.toggle(pick.id);
                toast.success(`${pick.choiceLabel || pick.label} is the manual pick`);
              });
            }}
          >
            Pick model
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => engine.testProviderChat(providerId as ProviderId)}
          >
            Test chat
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectPanel({ state }: { state: ReturnType<typeof useModels> }) {
  const cloud = providers.filter((p) => p.kind === "cloud");
  const [provider, setProvider] = useState<ProviderId>(cloud[0]!.id);
  const [key, setKey] = useState("");
  const [endpoint, setEndpoint] = useState("");

  const selected = providerById.get(provider)!;
  const ps = state.providerState[provider]!;
  const tier = useBilling().tiers[provider] || "auto";

  return (
    <HudPanel title="Connect a cloud provider" hint="your key, stored locally">
      <div className="space-y-3">
        <div>
          <p className="label-xs mb-1 text-muted-foreground">Provider</p>
          <select
            value={provider}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              setProvider(id);
              setEndpoint("");
              setKey("");
            }}
            className="h-9 w-full rounded-sm border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-primary/50"
          >
            {cloud.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="label-xs mb-1 text-muted-foreground">API base URL</p>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={selected.endpoint}
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <p className="label-xs mb-1 text-muted-foreground">
            {selected.auth === "cloud-iam" ? "Access credentials" : "API key"}
          </p>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            placeholder="sk-…"
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <p className="label-xs mb-1 text-muted-foreground">Models to use from this provider</p>
          <select
            value={tier}
            onChange={(e) => {
              const next = e.target.value as AccessTier;
              void billing.setProviderTier(provider, next);
              toast.success(
                next === "free"
                  ? `${selected.name} — free models only`
                  : next === "paid"
                    ? `${selected.name} — paid models only (still needs paid access on)`
                    : `${selected.name} — automatic free/paid detection`,
              );
            }}
            className="h-9 w-full rounded-sm border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-primary/50"
          >
            <option value="auto">Auto — detect free and paid models</option>
            <option value="free">Free models only</option>
            <option value="paid">Paid models only</option>
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            A stored key never authorises spending on its own — paid models stay blocked until paid
            AI access is turned on below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (!key.trim()) {
                toast.error("Enter a key first");
                return;
              }
              engine.connectProvider(provider, key, endpoint);
              setKey("");
              toast.success(`${selected.name} connected`);
            }}
          >
            <Link2 className="size-4" />
            Connect
          </Button>
          <Button size="sm" variant="outline" onClick={() => engine.testProvider(provider)}>
            <RadioTower className="size-4" />
            Test
          </Button>
          {ps.apiKey ? (
            <Button size="sm" variant="ghost" onClick={() => engine.disconnectProvider(provider)}>
              <Trash2 className="size-4 text-destructive" />
              Disconnect
            </Button>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {selected.notes} Auth: {selected.auth}. Health check:{" "}
          <span className="font-mono">{selected.detect}</span>.
        </p>

        <div className="border-t border-border pt-3">
          <p className="label-xs mb-2 text-muted-foreground">Connected</p>
          <div className="flex flex-wrap gap-1.5">
            {cloud
              .filter((p) => state.providerState[p.id]?.apiKey)
              .map((p) => (
                <StatusPill key={p.id} label={p.name} tone="magenta" />
              ))}
            {cloud.every((p) => !state.providerState[p.id]?.apiKey) ? (
              <span className="text-[11px] text-muted-foreground">
                No cloud provider connected yet.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </HudPanel>
  );
}

function ImportPanel({ state }: { state: ReturnType<typeof useModels> }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState("GGUF");
  const [sizeGb, setSizeGb] = useState("4");
  const [provider, setProvider] = useState<ProviderId>("llamacpp");

  const submit = () => {
    if (!name.trim() || !path.trim()) {
      toast.error("Name and file path are required");
      return;
    }
    engine.importModel({
      name: name.trim(),
      path: path.trim(),
      format,
      sizeGb: Number(sizeGb) || 0,
      provider,
    });
    toast.success(`${name} imported`);
    setName("");
    setPath("");
  };

  return (
    <HudPanel title="Import a local model" hint="GGUF · Safetensors · ONNX · PyTorch">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="label-xs mb-1 text-muted-foreground">Display name</p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My fine-tune 7B"
              className="h-9 text-xs"
            />
          </div>
          <div>
            <p className="label-xs mb-1 text-muted-foreground">Runtime</p>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              className="h-9 w-full rounded-sm border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-primary/50"
            >
              {providers
                .filter((p) => p.kind === "local")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div>
          <p className="label-xs mb-1 text-muted-foreground">Model file or folder</p>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\FRIDAY\models\my-model.gguf"
              className="h-9 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const picked = await window.friday?.pickFolder?.();
                if (picked) setPath(picked);
                else
                  toast(
                    "Folder picker is available in the desktop app — type the path here in preview.",
                  );
              }}
            >
              <Upload className="size-4" />
              Browse
            </Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="label-xs mb-1 text-muted-foreground">Format</p>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="h-9 w-full rounded-sm border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-primary/50"
            >
              {supportedFormats.map((f) => (
                <option key={f.format} value={f.format}>
                  {f.format} — {f.note}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="label-xs mb-1 text-muted-foreground">Size (GB)</p>
            <Input
              value={sizeGb}
              onChange={(e) => setSizeGb(e.target.value)}
              inputMode="decimal"
              className="h-9 font-mono text-xs"
            />
          </div>
        </div>
        <Button size="sm" onClick={submit}>
          <Plus className="size-4" />
          Import model
        </Button>

        <div className="border-t border-border pt-3">
          <p className="label-xs mb-2 text-muted-foreground">Imported ({state.imported.length})</p>
          {state.imported.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Nothing imported yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {state.imported.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{m.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {m.format} · {formatGb(m.sizeGb)} · {providerById.get(m.provider)?.name} ·{" "}
                      {m.path}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => engine.removeImport(m.id)}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </HudPanel>
  );
}

/**
 * Billing safety. FRIDAY must never spend money on her own: paid inference is
 * locked here, in the main process, and a stored API key does not unlock it.
 */
function BillingPanel() {
  const state = useBilling();
  const desktop = state.bridge === "desktop";

  return (
    <HudPanel title="Billing safety" hint={state.summary}>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="hud-tile flex items-start justify-between gap-3 rounded-md px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Paid AI access</span>
            <span className="block text-[11px] text-muted-foreground">
              Off by default. While off, only free and local models can answer.
            </span>
          </span>
          <Switch
            checked={state.billing.paidAccess}
            disabled={!desktop || state.billing.killSwitch}
            onCheckedChange={(on) => {
              void billing.setPaidAccess(on);
              toast[on ? "warning" : "success"](
                on ? "Paid AI access enabled — models may now bill" : "Paid AI access disabled",
              );
            }}
          />
        </label>

        <label className="hud-tile flex items-start justify-between gap-3 rounded-md px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Automatic paid routing</span>
            <span className="block text-[11px] text-muted-foreground">
              Let Auto mode pick a paid model. Off = only models you pick explicitly may bill.
            </span>
          </span>
          <Switch
            checked={state.billing.autoPaidUsage}
            disabled={!desktop || !state.billing.paidAccess || state.billing.killSwitch}
            onCheckedChange={(on) => void billing.setAutoPaidUsage(on)}
          />
        </label>

        <label className="hud-tile flex items-start justify-between gap-3 rounded-md px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Emergency kill switch</span>
            <span className="block text-[11px] text-muted-foreground">
              Blocks every paid model instantly, whatever else is set.
            </span>
          </span>
          <Switch
            checked={state.billing.killSwitch}
            disabled={!desktop}
            onCheckedChange={(on) => {
              void billing.setKillSwitch(on);
              toast[on ? "warning" : "success"](
                on ? "Kill switch engaged — paid models blocked" : "Kill switch released",
              );
            }}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <StatusPill
          label={`Effective policy: ${state.policy}`}
          tone={
            state.policy === "allow-paid" || state.policy === "paid-only" ? "magenta" : "accent"
          }
        />
        {state.billing.grantScope !== "off" ? (
          <StatusPill label={`Grant: ${state.billing.grantScope}`} tone="magenta" />
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!desktop || state.billing.killSwitch}
          onClick={() => {
            void billing.grant("session");
            toast.warning("Paid models unlocked for this session (1 hour)");
          }}
        >
          <KeyRound className="size-4" />
          Allow paid for 1 hour
        </Button>
        {state.billing.grantScope !== "off" ? (
          <Button size="sm" variant="ghost" onClick={() => void billing.grant("off")}>
            <X className="size-4" />
            Revoke grant
          </Button>
        ) : null}
        {!desktop ? (
          <span className="text-[11px] text-muted-foreground">
            Preview mode — paid access can only be changed in the desktop app.
          </span>
        ) : null}
        {state.billing.killSwitch ? (
          <span className="text-[11px] text-muted-foreground">
            Kill switch is on, so paid access stays locked.
          </span>
        ) : null}
      </div>
    </HudPanel>
  );
}
