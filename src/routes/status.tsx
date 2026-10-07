import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Activity, Boxes, Brain, Layers, Plug, Puzzle, Users, Workflow } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  HudPanel,
  MetricBar,
  StatTile,
  StatusPill,
  toneForStatus,
} from "@/components/friday/ui";
import { useCapabilities } from "@/lib/friday/capability-trees";
import { useStartup } from "@/lib/friday/startup";
import { useModels } from "@/lib/friday/use-models";
import { useLedger, useMemory } from "@/lib/friday/self/use-self";
import { serviceTone, useServiceHealth } from "@/lib/friday/use-service-health";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { statsFor } from "@/lib/friday/self/mastery";
import { RuntimePanel, SubsystemPanel } from "@/components/friday/SystemOverviewPanels";
import { systemMap } from "@/lib/friday/system-map";
import { ConnectivityPanel } from "@/components/friday/ConnectivityPanel";
import { doctor } from "@/lib/friday/doctor-engine";
import { refreshEnvironment } from "@/lib/friday/environment";
import {
  brainCoreStatus,
  discoveryStatus,
  modelsPresence,
  presenceLabel,
  presenceStatus,
} from "@/lib/friday/status-presentation";
import { wiringPanel } from "@/lib/friday/wiring";

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "Status — FRIDAY Console" },
      {
        name: "description",
        content:
          "Live FRIDAY status board: brain core, agents, plugins, models and workflow health with a real-time activity feed.",
      },
      { property: "og:title", content: "Status — FRIDAY Console" },
      { property: "og:description", content: "Real-time health of every FRIDAY subsystem." },
    ],
  }),
  component: StatusPage,
});

const ICONS = {
  brain: Brain,
  boxes: Boxes,
  users: Users,
  puzzle: Puzzle,
  plug: Plug,
  hexagon: Layers,
  workflow: Workflow,
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

const uptimeSince = (at: number | null) => {
  if (!at) return "—";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  const h = Math.floor(s / 3600);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m`;
};

function StatusPage() {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const models = useModels();
  const { tasks } = useLedger();
  const mem = useMemory();
  const startup = useStartup();
  const services = useServiceHealth();
  const kernel = useKernelStatus();

  // Opening the board is an explicit "show me now": every owner re-reads its
  // source once. The live samplers keep it current from there.
  useEffect(() => {
    void caps.refresh();
    void refreshEnvironment();
    void doctor.scan({ deep: false });
    void systemMap.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = (tree: string) => caps.counts[tree]?.enabled ?? 0;
  const installedModels = useMemo(
    () => Object.values(models.installed).filter(Boolean).length,
    [models.installed],
  );

  // Real counts. A subsystem with nothing installed honestly reports 0 —
  // no decorative numbers anywhere on this page.
  const running = tasks.filter((t) => t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "timeout").length;
  const brain = brainCoreStatus(kernel.connected, running);
  const modelPresence = modelsPresence(installedModels);
  const agentPresence = presenceLabel(enabled("agents"));
  const skillPresence = presenceLabel(enabled("skills"));
  const pluginPresence = presenceLabel(enabled("plugins"));
  const modulePresence = presenceLabel(enabled("modules"));
  const workflowPresence = presenceLabel(enabled("workflows"));

  const coreOverview = [
    { label: "Brains", value: 1, state: brain.status, icon: "brain" },
    {
      label: "Models",
      value: installedModels,
      state: modelPresence.state,
      icon: "boxes",
    },
    {
      label: "Agents",
      value: enabled("agents"),
      state: agentPresence,
      icon: "users",
    },
    {
      label: "Skills",
      value: enabled("skills"),
      state: skillPresence,
      icon: "puzzle",
    },
    {
      label: "Plugins",
      value: enabled("plugins"),
      state: pluginPresence,
      icon: "plug",
    },
    {
      label: "Modules",
      value: enabled("modules"),
      state: modulePresence,
      icon: "hexagon",
    },
    {
      label: "Workflows",
      value: enabled("workflows"),
      state: workflowPresence,
      icon: "workflow",
    },
  ];

  const bootedAt = useMemo(
    () => (tasks.length ? Math.min(...tasks.map((t) => t.startedAt)) : null),
    [tasks],
  );
  const up = uptimeSince(bootedAt);

  const components = [
    {
      name: "Brain Core",
      status: brain.status,
      details: brain.details,
      uptime: up,
    },
    {
      name: "Memory System",
      status: mem.items.length ? "Ready" : "Idle",
      details: `${mem.items.length} records stored`,
      uptime: up,
    },
    {
      name: "Agents",
      status: presenceStatus(enabled("agents")),
      details: `${enabled("agents")} of ${caps.counts["agents"]?.total ?? 0} enabled`,
      uptime: up,
    },
    {
      name: "Plugins",
      status: presenceStatus(enabled("plugins")),
      details: `${enabled("plugins")} of ${caps.counts["plugins"]?.total ?? 0} enabled`,
      uptime: up,
    },
    {
      name: "Models",
      status: modelPresence.status,
      details: installedModels ? `${installedModels} models installed` : "no models installed",
      uptime: up,
    },
    {
      name: "Workflows",
      status: presenceStatus(enabled("workflows")),
      details: `${enabled("workflows")} of ${caps.counts["workflows"]?.total ?? 0} enabled`,
      uptime: up,
    },
    {
      name: "Capability Discovery",
      status: discoveryStatus(caps.supported),
      details: caps.supported
        ? `${caps.items.length} capabilities · scanned ${caps.scannedAt ? clock(caps.scannedAt) : "—"}`
        : "desktop app only",
      uptime: up,
    },
    {
      name: "System Health",
      status: !kernel.connected ? "Offline" : failed ? "Degraded" : "Ready",
      details: !kernel.connected
        ? "kernel not connected"
        : failed
          ? `${failed} failed task${failed === 1 ? "" : "s"}`
          : "no issues detected",
      uptime: up,
    },
    // The verified start-up flow: only reported in the desktop app, where the
    // services, kernel and workspace can actually be probed.
    ...(startup.supported && startup.state
      ? [
          {
            name: "Startup Flow",
            status:
              startup.state.state === "ready"
                ? "Ready"
                : startup.state.state === "degraded"
                  ? "Degraded"
                  : "Failed",
            details:
              startup.state.blockers.length || startup.state.warnings.length
                ? [...startup.state.blockers, ...startup.state.warnings].join(" · ")
                : `verified in ${Math.round((startup.state.ms ?? 0) / 100) / 10}s`,
            uptime: up,
          },
          ...startup.state.services.map((service) => ({
            name: `Service · ${service.name}`,
            status:
              service.state === "running" || service.state === "started"
                ? "Online"
                : service.state === "repaired"
                  ? "Recovered"
                  : "Offline",
            details: service.detail,
            uptime: up,
          })),
        ]
      : []),
  ];

  // Live feed = the real task ledger, newest first.
  const liveFeed = useMemo(
    () =>
      [...tasks]
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, 12)
        .map((task) => ({
          at: clock(task.endedAt ?? task.startedAt),
          source: task.kind,
          detail: task.error ?? task.title,
          tone:
            task.status === "failed" || task.status === "timeout"
              ? "warning"
              : task.status === "running"
                ? "accent"
                : task.status === "done"
                  ? "primary"
                  : "muted",
        })),
    [tasks],
  );

  const skillStats = caps.items
    .filter((item) => item.tree === "skills")
    .map((item) => statsFor(tasks, item.id, item.name));
  const learning = skillStats.filter((s) => s.executions > 0 && s.mastery < 55).length;
  const ready = skillStats.filter((s) => s.mastery >= 55).length;
  const overallMastery = skillStats.length
    ? Math.round(skillStats.reduce((n, s) => n + s.mastery, 0) / skillStats.length)
    : 0;

  return (
    <AppShell
      title="FRIDAY Status"
      subtitle="Subsystem board · every FRIDAY capability reporting in"
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => wiringPanel.open()}>
            System wiring
          </Button>
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/system" })}>
            Open Hardware →
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <HudPanel title="System Overview" hint="live">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            {coreOverview.map((c) => {
              const Icon = ICONS[c.icon as keyof typeof ICONS];
              return (
                <StatTile
                  key={c.label}
                  icon={<Icon className="size-4" />}
                  label={c.label}
                  value={c.value}
                  state={c.state}
                  tone={
                    c.state === "Offline" || c.value === 0
                      ? "muted"
                      : c.state === "Active"
                        ? "accent"
                        : "primary"
                  }
                />
              );
            })}
          </div>
        </HudPanel>

        <div className="grid gap-4 xl:grid-cols-2">
          <ConnectivityPanel />
          <SubsystemPanel />
        </div>
        <RuntimePanel />

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <HudPanel title="Detailed Status" hint={`${components.length} components`}>
            <DataTable
              columns={["Component", "Status", "Details", "Uptime"]}
              rows={components.map((c) => [
                <span key="n" className="flex items-center gap-2 text-foreground">
                  <span
                    className={
                      c.status === "Active"
                        ? "size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
                        : c.status === "Degraded" || c.status === "Failed" || c.status === "Offline"
                          ? "size-1.5 rounded-full bg-warning"
                          : "size-1.5 rounded-full bg-muted-foreground/50"
                    }
                  />
                  {c.name}
                </span>,
                <StatusPill key="s" label={c.status} tone={toneForStatus(c.status)} />,
                <span key="d" className="text-muted-foreground">
                  {c.details}
                </span>,
                <span key="u" className="font-mono text-xs text-muted-foreground">
                  {c.uptime}
                </span>,
              ])}
            />
          </HudPanel>

          <div className="space-y-4">
            <HudPanel title="Live Feed" hint={liveFeed.length ? "all activity" : "idle"}>
              {liveFeed.length ? (
                <ul className="space-y-2">
                  {liveFeed.map((e, i) => (
                    <li
                      key={i}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 text-xs"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground">{e.at}</span>
                      <span
                        className={
                          e.tone === "accent"
                            ? "truncate text-accent"
                            : e.tone === "warning"
                              ? "truncate text-warning"
                              : e.tone === "magenta"
                                ? "truncate text-magenta"
                                : e.tone === "muted"
                                  ? "truncate text-muted-foreground"
                                  : "truncate text-primary"
                        }
                      >
                        {e.source}
                      </span>
                      <span className="truncate text-muted-foreground">{e.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No activity recorded yet.
                </p>
              )}
            </HudPanel>

            <HudPanel title="Skill Learning Progress">
              <MetricBar
                label="Learning"
                value={overallMastery}
                detail={
                  skillStats.length
                    ? `${learning} learning · ${ready} ready to use`
                    : "no skills installed"
                }
                tone="accent"
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <StatTile
                  label="Learning"
                  value={learning}
                  state="in progress"
                  tone={learning ? "warning" : "muted"}
                />
                <StatTile
                  icon={<Activity className="size-4" />}
                  label="Ready"
                  value={ready}
                  state="to use"
                  tone={ready ? "accent" : "muted"}
                />
              </div>
            </HudPanel>

            <HudPanel
              title="Live Services"
              hint={
                services.supported && services.health
                  ? `${services.health.online}/${services.health.total} online · ${services.health.state}`
                  : "desktop app only"
              }
            >
              {services.supported && services.health ? (
                <ul className="space-y-2">
                  {services.health.services.map((s) => (
                    <li
                      key={s.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
                    >
                      <span className="min-w-0">
                        <span className="text-foreground">{s.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {s.detail || "—"}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {s.latencyMs !== null ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {s.latencyMs}ms
                          </span>
                        ) : null}
                        <StatusPill
                          label={serviceTone(s.state)}
                          tone={toneForStatus(serviceTone(s.state))}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Service probes run in the FRIDAY desktop app.
                </p>
              )}
            </HudPanel>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
