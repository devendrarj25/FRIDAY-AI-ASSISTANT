import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, RotateCw, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FlowStudioHost } from "@/components/friday/FlowStudio";
import { featureForPath } from "@/lib/friday/flow-adapters";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BootScreen } from "@/components/friday/BootScreen";
import { ImportBar } from "@/components/friday/ImportBar";
import { TitleStrip } from "@/components/friday/TitleStrip";
import {
  desktopApi,
  useDesktopRuntime,
  useWorkspaceRootState,
  type CompanionRemoteState,
} from "@/lib/friday/desktop";
import { WorkspaceSetup } from "@/components/friday/WorkspaceSetup";
import { useAppVersion } from "@/lib/friday/version";
import { useAppearance } from "@/lib/friday/appearance";
import { useCharacterLink } from "@/lib/friday/character/link";
import {
  NAV_GROUPS,
  ALL_NAV_ITEMS,
  SETTINGS_NAV,
  SIDEBAR_PREF_EVENT,
  companionFeatures,
  importTargetLabel,
  resolveLandingPath,
} from "@/lib/friday/navigation";
import { capabilityRegistry, resourceRunnable } from "@/lib/friday/brain/capability-registry";
import { modelRegistry } from "@/lib/friday/brain/model-registry";
import { modelRegistry as usageRegistry } from "@/lib/friday/model-registry";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { doctor, isProblem, isWarning } from "@/lib/friday/doctor-engine";
import { knownConnectors } from "@/lib/friday/connectors";
import { buildCompanionLive } from "@/lib/friday/companion-live";
import { brain } from "@/lib/friday/brain-engine";
import { observeBrain } from "@/lib/friday/brain/observe";
import { usePreferences } from "@/lib/friday/use-preferences";
import { memory } from "@/lib/friday/self/memory-engine";
import { prefOn } from "@/lib/friday/settings-runtime";
import { githubCheck } from "@/lib/friday/github-updates";
import { taskGraph } from "@/lib/friday/self/task-graph";
import { library } from "@/lib/friday/library-engine";
import { projectWorkspaces } from "@/lib/friday/project-workspace-engine";
import { formatOwnerDeskLine, hydrateOwnerDesk } from "@/lib/friday/owner-desk-hydrate";
import { publishBrowserSession } from "@/lib/friday/browser-awareness";
import { liveBrowserAvailable, loadSettings, loadTabs } from "@/lib/friday/live-browser";
import { WiringVisualizerHost } from "@/components/friday/WiringVisualizer";
import { SessionLock } from "@/components/friday/settings/SessionLock";
import { cn } from "@/lib/utils";

const ALL_ITEMS = ALL_NAV_ITEMS;

/**
 * Nested <AppShell> (every page) must not remount chrome. The root route wraps
 * the outlet once; inner calls only render the page frame so sidebar scroll
 * survives navigation. Not a second sidebar store.
 */
const ShellPresenceContext = createContext(false);

/** Restored if chrome ever remounts (workspace hydrate). Live navigation keeps the same <nav>. */
let savedSidebarScroll = 0;

type AppShellProps = {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Main window mode: no scrolling, children own the full height. */
  fill?: boolean;
  children: ReactNode;
};

function AppShellPage({ title, subtitle, actions, fill = false, children }: AppShellProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <main className={cn("min-h-0 flex-1 p-3", fill ? "overflow-hidden" : "overflow-y-auto")}>
      {title ? (
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-sm font-bold uppercase tracking-[0.16em] text-primary glow-text">
              {title}
            </h1>
            {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => flowStudio.open(featureForPath(pathname), "chart")}
            >
              Flow
            </Button>
            {actions}
          </div>
        </div>
      ) : null}
      {importTargetLabel(pathname) ? (
        <ImportBar target={importTargetLabel(pathname)!} className="mb-3" />
      ) : null}
      {fill ? <div className="h-full min-h-0">{children}</div> : children}
    </main>
  );
}

function readSidebarCollapsed(defaultExpanded: boolean): boolean {
  if (typeof window === "undefined") return !defaultExpanded;
  const stored = localStorage.getItem("friday.sidebar.collapsed");
  if (stored === "0") return false;
  if (stored === "1") return true;
  return !defaultExpanded;
}

function HeaderChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "accent" | "primary";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[11px]",
        tone === "accent"
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      <span className="size-1.5 rounded-full bg-current pulse-dot" />
      <span className="text-muted-foreground">{label}:</span>
      <span>{value}</span>
    </span>
  );
}

export function AppShell(props: AppShellProps) {
  const inShell = useContext(ShellPresenceContext);
  if (inShell) return <AppShellPage {...props} />;
  return <AppShellChrome>{props.children}</AppShellChrome>;
}

function AppShellChrome({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const prefs = usePreferences();
  const defaultExpanded = (prefs.fields["sidebarDefault"] ?? "Expanded") === "Expanded";
  // Collapsed by default on first run unless Settings → Appearance says Expanded.
  const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed(defaultExpanded));
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    el.scrollTop = savedSidebarScroll;
  }, []);
  // Desktop only: workspace scan on startup + hot-reload notifications.
  useDesktopRuntime();
  // Saved theme / font / density / motion, applied on every page.
  useAppearance();
  // Desktop companion: publish real FRIDAY state to the overlay (no-op in web).
  useCharacterLink();
  // First run: FRIDAY cannot work before it has a primary folder to scan.
  const workspaceRoot = useWorkspaceRootState();
  // One version for the whole app (package.json → installed EXE version).
  const appVersion = useAppVersion();

  useEffect(() => {
    setCollapsed(readSidebarCollapsed(defaultExpanded));
    const onPref = () => setCollapsed(readSidebarCollapsed(defaultExpanded));
    window.addEventListener(SIDEBAR_PREF_EVENT, onPref);
    window.addEventListener("storage", onPref);
    return () => {
      window.removeEventListener(SIDEBAR_PREF_EVENT, onPref);
      window.removeEventListener("storage", onPref);
    };
  }, [defaultExpanded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("friday.landing.applied")) return;
    sessionStorage.setItem("friday.landing.applied", "1");
    const dest = resolveLandingPath(prefs.fields["landingPage"]);
    if (dest && dest !== pathname) {
      void navigate({ to: dest });
    }
  }, [navigate, pathname, prefs.fields]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        void navigate({ to: "/settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    const api = desktopApi() as { reportBusy?: (busy: boolean) => void } | null;
    const send = () => api?.reportBusy?.(taskGraph.busy());
    send();
    const unsub = taskGraph.subscribe(send);
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!prefOn("updateCheck", false)) return;
    void githubCheck().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onBye = () => {
      if (prefOn("clearWorkingOnQuit", false)) memory.clearTier("working");
    };
    window.addEventListener("beforeunload", onBye);
    return () => window.removeEventListener("beforeunload", onBye);
  }, []);

  useEffect(() => {
    void hydrateOwnerDesk();
    void (async () => {
      const [saved, settings] = await Promise.all([loadTabs(), loadSettings()]);
      publishBrowserSession({
        desktop: liveBrowserAvailable(),
        mounted: false,
        tabs: (saved.tabs ?? []).map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title || tab.url,
        })),
        activeId: saved.activeId,
        engine: settings.searchEngine,
        proxyMode: settings.proxyMode,
      });
    })();
  }, []);

  // Single source of truth for the phone: the sections here AND the one
  // capability registry the brain routes with (models, tools, skills, agents,
  // modules, plugins, workflows) are published to the companion. A capability
  // added anywhere shows up on the phone with no companion-specific wiring.
  // Coarse live facts (voice state, doctor totals, connectors, cloud health)
  // ride in the same file so a desktop change reaches an already-open phone
  // without a refresh or restart.
  useEffect(() => {
    // The registry notifies on every live health tick, and most ticks carry an
    // identical list. Publishing each one rewrote the companion file and made
    // the "config reloaded" toast reappear, so an unchanged snapshot is simply
    // not published.
    let lastPublished = "";
    let remoteCache: CompanionRemoteState | null = null;
    const publish = () => {
      const snapshot = capabilityRegistry.getSnapshot();
      const doc = doctor.getSnapshot();
      const voice = assistantMode.getSnapshot();
      const cloud = (() => {
        try {
          return [
            ...new Set(
              modelRegistry
                .list()
                .filter((model) => model.kind === "cloud" && model.available)
                .map((model) => model.provider),
            ),
          ];
        } catch {
          return [] as string[];
        }
      })();
      const usage = (() => {
        try {
          return usageRegistry.getSnapshot();
        } catch {
          return {
            routeMode: "auto",
            policy: "free-preferred",
            selected: [] as string[],
            models: [] as Array<{ id: string; coolingDown: boolean }>,
          };
        }
      })();
      const observed = observeBrain();
      const brainSnap = brain.getSnapshot();
      const activeRun = brainSnap.runs.find((run) => run.id === brainSnap.activeRunId);
      const runningStage = activeRun?.stages.find((stage) => stage.state === "running");
      const inFlight = Boolean(activeRun);
      const payload = {
        features: companionFeatures(),
        capabilities: snapshot.resources.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          ref: r.ref,
          available: r.available,
          health: r.health,
          detail: r.detail,
          runnable: resourceRunnable(r),
        })),
        live: buildCompanionLive({
          voice: voice.voiceState,
          listening: voice.listening,
          error: Boolean(voice.error),
          mode: voice.mode,
          doctorProblems: doc.checks.filter((c) => isProblem(c.status)).length,
          doctorWarnings: doc.checks.filter((c) => isWarning(c.status)).length,
          doctorScanning: doc.scanning,
          connectors: knownConnectors().map((c) => ({
            id: c.id,
            name: c.name,
            connected: c.connected,
          })),
          cloud,
          routeMode: usage.routeMode,
          policy: usage.policy,
          selected: usage.selected,
          coolingModelIds: usage.models
            .filter((model) => model.coolingDown)
            .map((model) => model.id),
          workGoal: inFlight ? observed.goal : null,
          workStep: inFlight ? runningStage?.label || observed.intent?.label || null : null,
          workStatus: inFlight ? activeRun?.state || null : null,
          workTool: inFlight ? observed.tool : null,
          remote: remoteCache,
          ...(formatOwnerDeskLine() ? { desk: formatOwnerDeskLine() } : {}),
        }),
      };
      const signature = JSON.stringify(payload);
      if (signature === lastPublished) return;
      lastPublished = signature;
      void desktopApi()?.publishCompanionFeatures?.(payload);
    };
    const refreshRemote = () => {
      const api = desktopApi();
      if (!api?.companionRemote) {
        remoteCache = null;
        publish();
        return;
      }
      void api
        .companionRemote()
        .then((state) => {
          remoteCache = state ?? null;
          publish();
        })
        .catch(() => {
          remoteCache = null;
          publish();
        });
    };
    publish();
    refreshRemote();
    const remoteTimer = window.setInterval(refreshRemote, 15000);
    const offCap = capabilityRegistry.subscribe(publish);
    const offDoc = doctor.subscribe(publish);
    const offVoice = assistantMode.subscribe(publish);
    const offUsage = usageRegistry.subscribe(publish);
    const offBrain = brain.subscribe(publish);
    const offLibrary = library.subscribe(publish);
    const offProjects = projectWorkspaces.subscribe(publish);
    return () => {
      window.clearInterval(remoteTimer);
      offCap();
      offDoc();
      offVoice();
      offUsage();
      offBrain();
      offLibrary();
      offProjects();
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem("friday.sidebar.collapsed", c ? "0" : "1");
      return !c;
    });
  };

  if (workspaceRoot === undefined) return null;
  if (workspaceRoot === null) return <WorkspaceSetup />;

  return (
    <ShellPresenceContext.Provider value={true}>
      <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
        <BootScreen />
        <FlowStudioHost />
        {/* The only FRIDAY branding: the custom top strip. */}
        <TitleStrip />
        <div className="friday-interactive-region flex min-h-0 flex-1">
          <aside
            className={cn(
              "hidden shrink-0 flex-col border-r border-primary/20 bg-sidebar transition-[width] duration-200 lg:flex",
              collapsed ? "w-16" : "w-60",
            )}
          >
            {/* Scrollable navigation — same DOM across routes (root chrome). */}
            <nav
              ref={navRef}
              className="min-h-0 flex-1 overflow-y-auto p-2"
              onScroll={(event) => {
                savedSidebarScroll = event.currentTarget.scrollTop;
              }}
            >
              {NAV_GROUPS.map((group) => (
                <div key={group.group} className="mb-3">
                  {!collapsed ? (
                    <p className="label-xs px-2.5 py-1.5 text-primary/50">{group.group}</p>
                  ) : (
                    <div className="mx-2 my-2 border-t border-primary/10" />
                  )}
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const active = pathname === item.to;
                      return (
                        <Link
                          key={item.to}
                          to={item.to}
                          title={item.label}
                          className={cn(
                            "flex items-center gap-2.5 rounded-sm border px-2.5 py-2 text-sm transition-all",
                            collapsed && "justify-center px-0",
                            active
                              ? "border-primary/50 bg-primary/12 text-primary glow-ring"
                              : "border-transparent text-muted-foreground hover:border-primary/25 hover:bg-primary/6 hover:text-foreground",
                          )}
                        >
                          <item.icon className="size-4 shrink-0" />
                          {!collapsed ? <span className="truncate">{item.label}</span> : null}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>

            {/* Fixed bottom: collapse + single settings, then version */}
            <div className="shrink-0 border-t border-primary/15 p-2">
              <div className={cn("flex gap-1.5", collapsed && "flex-col")}>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="grid flex-1 place-items-center rounded-sm border border-primary/20 bg-surface py-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                >
                  {collapsed ? (
                    <ChevronsRight className="size-4" />
                  ) : (
                    <ChevronsLeft className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Restart FRIDAY"
                  title="Restart FRIDAY"
                  onClick={() => {
                    const api = desktopApi();
                    void (api?.restartApp ?? api?.confirmRestart)?.(
                      "Restart requested from the sidebar.",
                    );
                  }}
                  className="grid flex-1 place-items-center rounded-sm border border-primary/20 bg-surface py-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                >
                  <RotateCw className="size-4" />
                </button>
                <Link
                  to="/settings"
                  aria-label="Settings"
                  className={cn(
                    "grid flex-1 place-items-center rounded-sm border py-2 transition-colors",
                    pathname === "/settings"
                      ? "border-primary/50 bg-primary/12 text-primary"
                      : "border-primary/20 bg-surface text-muted-foreground hover:border-primary/50 hover:text-primary",
                  )}
                >
                  <Settings className="size-4" />
                </Link>
              </div>
              {!collapsed ? (
                <div className="hud-tile mt-2 rounded-md px-2.5 py-2">
                  <p className="font-mono text-[11px] text-primary">FRIDAY {appVersion.label}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    Build {appVersion.build}
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-center font-mono text-[9px] text-muted-foreground">
                  {appVersion.label}
                </p>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-primary/15 bg-sidebar px-2 py-1.5 lg:hidden">
              {ALL_ITEMS.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "whitespace-nowrap rounded-sm border px-2.5 py-1.5 font-mono text-[11px]",
                    pathname === item.to
                      ? "border-primary/50 bg-primary/12 text-primary"
                      : "border-transparent text-muted-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
              <Link
                to={SETTINGS_NAV.to}
                className={cn(
                  "whitespace-nowrap rounded-sm border px-2.5 py-1.5 font-mono text-[11px]",
                  pathname === SETTINGS_NAV.to
                    ? "border-primary/50 bg-primary/12 text-primary"
                    : "border-transparent text-muted-foreground",
                )}
              >
                {SETTINGS_NAV.label}
              </Link>
            </nav>

            {children}
          </div>
        </div>
        <WiringVisualizerHost />
        <SessionLock />
      </div>
    </ShellPresenceContext.Provider>
  );
}

export { HudPanel as Panel, StatusDot } from "@/components/friday/ui";
