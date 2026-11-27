import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, HudPanel, LoadingState, StatusPill } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import type { InstallerCatalog, InstallerCatalogRow } from "@/lib/friday/desktop";
import { installer, isJobActive as isInstallerJobActive } from "@/lib/friday/installer-engine";
import {
  catalogNotices,
  catalogPhase,
  consentWording,
  dialOf,
  doctorView,
  groupRows,
  INSTALLER_SCOPES,
  windowRows,
  installTargetOf,
  lastCheckedLine,
  refreshLabel,
  refreshOutcomeText,
  refreshWaitMs,
  rowActions,
  rowsInScope,
  updateOutcome,
  type AutonomyDial,
  type FitGroup,
  type FitState,
  type InstallerScope,
  type InstallTarget,
  type RowView,
  type TargetLookups,
} from "@/lib/friday/installer-fit";
import { onVisibleSecond } from "@/lib/friday/frame-clock";
import { modelById, modelByTag } from "@/lib/friday/model-catalog";
import { isJobActive as isModelJobActive, models } from "@/lib/friday/models-engine";
import { autonomy } from "@/lib/friday/self/autonomy";
import { useInstaller } from "@/lib/friday/use-installer";
import { useInstallerCatalog, type CatalogState } from "@/lib/friday/use-installer-catalog";
import { useModels } from "@/lib/friday/use-models";
import { cn } from "@/lib/utils";

const FIT_TONE = { supported: "accent", limited: "warning", unsupported: "muted" } as const;
const LEVEL_TONE = {
  block: "text-destructive",
  limit: "text-warning",
  info: "text-muted-foreground",
} as const;

type Pending = {
  title: string;
  lines: string[];
  confirmLabel: string;
  run: () => void;
};

export type InstallerFitViewProps = {
  scope: InstallerScope;
  title: string;
  hint?: string;
  /** `state.offline` is the browser preview: the catalogue only exists in the installed app. */
  state: CatalogState;
  now: number;
  /** Groups open at the start; the unsupported one is folded unless named here. */
  initiallyOpen?: readonly FitState[];
  query?: string;
  lookups: TargetLookups;
  /** Is a download or an update of this row already running. */
  isBusy: (row: InstallerCatalogRow, target: InstallTarget | null) => boolean;
  onInstall: (row: InstallerCatalogRow, target: InstallTarget) => void;
  onUpdate: (row: InstallerCatalogRow) => Promise<Pending | null>;
  onRepair: (id: string, action: "install" | "repair") => void;
  onRefresh: () => Promise<void> | void;
  onRetry: () => void;
};

/** "Refresh list": disabled with a countdown while the main process rate-limits it, painted by the shared one-second clock. */
function RefreshListButton({
  catalog,
  busy,
  now,
  onRefresh,
}: {
  catalog: InstallerCatalog | null;
  busy: boolean;
  now: number;
  onRefresh: () => Promise<void> | void;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const refreshing = busy || Boolean(catalog?.refreshing);
  const [locked, setLocked] = useState(() => refreshWaitMs(catalog, now) > 0);
  useEffect(() => {
    const paint = (t: number): boolean => {
      const wait = refreshWaitMs(catalog, t);
      if (textRef.current) textRef.current.textContent = refreshLabel(wait, refreshing);
      setLocked(wait > 0);
      return wait > 0;
    };
    if (!paint(Date.now())) return undefined;
    const off = onVisibleSecond((t) => {
      if (!paint(t)) off();
    });
    return off;
  }, [catalog, refreshing]);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={locked || refreshing}
      title="Ask the official sources for the newest versions. The saved list stays on screen meanwhile."
      onClick={() => onRefresh()}
    >
      <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
      <span ref={textRef}>{refreshLabel(refreshWaitMs(catalog, now), refreshing)}</span>
    </Button>
  );
}

function RowCard({
  view,
  props,
  askConfirm,
}: {
  view: RowView;
  props: InstallerFitViewProps;
  askConfirm: (pending: Pending) => void;
}) {
  const { row } = view;
  const target = installTargetOf(row, props.lookups);
  const busy = props.isBusy(row, target);
  const actions = rowActions(row, { target, busy });
  return (
    <article
      aria-label={view.name}
      data-fit-row={view.id}
      data-fit-state={view.fitState}
      className="space-y-1.5 rounded-surface border border-border/60 bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">{view.name}</h3>
        {view.recommended ? <StatusPill label="Recommended" tone="primary" /> : null}
        {view.badges.map((badge) => (
          <span key={badge.id} title={badge.title}>
            <StatusPill label={badge.label} tone={badge.tone} />
          </span>
        ))}
        {actions.update ? (
          <Button
            size="sm"
            variant="outline"
            disabled={actions.update.disabled}
            title={actions.update.title}
            onClick={async () => {
              const pending = await props.onUpdate(row);
              if (pending) askConfirm(pending);
            }}
          >
            <RefreshCw className="size-3.5" /> {actions.update.label}
          </Button>
        ) : null}
        {actions.install && target ? (
          <Button
            size="sm"
            disabled={actions.install.disabled}
            title={actions.install.title}
            onClick={() => {
              const run = () => props.onInstall(row, target);
              const confirm = actions.install?.confirm;
              if (confirm)
                askConfirm({
                  title: confirm.title,
                  lines: confirm.lines,
                  confirmLabel: actions.install?.label ?? "Install",
                  run,
                });
              else run();
            }}
          >
            <Download className="size-3.5" /> {actions.install.label}
          </Button>
        ) : null}
      </div>
      <p className="font-mono text-meta text-muted-foreground">
        {view.installedText} · {view.latestText} · via {view.sourceText} · {view.checkedText}
        {view.upstreamVersion ? ` · host newest ${view.upstreamVersion}` : ""}
      </p>
      <p className="label-xs text-muted-foreground/80">{view.category}</p>
      {view.hint ? <p className="text-xs text-primary">{view.hint}</p> : null}
      {view.engineLine ? (
        <p className="text-meta text-muted-foreground">{view.engineLine}</p>
      ) : null}
      {view.servedLine ? (
        <p className="text-meta text-muted-foreground">{view.servedLine}</p>
      ) : null}
      {view.reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs">
          {view.reasons.map((line) => (
            <li key={line.text} className={LEVEL_TONE[line.level]}>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
      {view.needs.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">What it would need:</span> {view.needs.join("; ")}.
        </p>
      ) : null}
      {view.alternative ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">Use instead:</span> {view.alternative.name}
        </p>
      ) : null}
      {actions.note ? <p className="text-meta text-muted-foreground">{actions.note}</p> : null}
    </article>
  );
}

function Group({
  group,
  open,
  toggle,
  props,
  askConfirm,
}: {
  group: FitGroup;
  open: boolean;
  toggle: () => void;
  props: InstallerFitViewProps;
  askConfirm: (pending: Pending) => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const [all, setAll] = useState(false);
  const { shown, hidden } = windowRows(group.state, group.rows, all);
  return (
    <section data-fit-group={group.state} className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Chevron className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="label-xs text-primary">{group.title}</span>
        <StatusPill label={String(group.rows.length)} tone={FIT_TONE[group.state]} />
        <span className="min-w-0 text-meta text-muted-foreground">{group.hint}</span>
      </button>
      {open ? (
        group.rows.length === 0 ? (
          <p className="pl-6 text-xs text-muted-foreground">Nothing in this list.</p>
        ) : (
          <div className="space-y-2">
            {shown.map((view) => (
              <RowCard key={view.id} view={view} props={props} askConfirm={askConfirm} />
            ))}
            {hidden > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setAll(true)}>
                Show all ({hidden} more)
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

/**
 * Downloads by what THIS PC can run: Ready, Works with limits, Not supported (folded, one click away, never hiding a
 * row), each row with its installed and latest version, source, update badge and the buttons it may have. Drawn from
 * props so every state (loading, offline, error with Retry, empty, ready, stale) shows without a desktop.
 */
export function InstallerFitView(props: InstallerFitViewProps) {
  const { state, scope, now } = props;
  const kinds = INSTALLER_SCOPES[scope];
  const catalog = state.catalog;
  const phase = catalogPhase({
    desktop: !state.offline,
    catalog,
    error: state.error,
    inScope: catalog ? rowsInScope(catalog, kinds) : 0,
  });
  const groups = catalog ? groupRows(catalog, { kinds, query: props.query ?? "", now }) : [];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const isOpen = (group: FitGroup) =>
    open[group.state] ??
    (!group.collapsedByDefault || Boolean(props.initiallyOpen?.includes(group.state)));
  const notices = catalog ? catalogNotices(catalog) : [];
  const doctor = scope === "installManager" && catalog ? catalog.doctor.map(doctorView) : [];

  return (
    <HudPanel
      title={props.title}
      hint={catalog ? `${lastCheckedLine(catalog, now)}` : (props.hint ?? "what this PC can run")}
      actions={
        <RefreshListButton
          catalog={catalog}
          busy={state.refreshing}
          now={now}
          onRefresh={props.onRefresh}
        />
      }
    >
      <div className="space-y-3" data-fit-panel={scope} data-fit-phase={phase}>
        {phase === "loading" ? (
          <LoadingState label="Reading what this PC can run…" rows={4} />
        ) : phase === "offline" ? (
          <EmptyState
            title="The fit list appears in the installed FRIDAY app"
            hint="It reads this PC's hardware, so it has nothing to show in a browser preview."
          />
        ) : phase === "error" ? (
          <ErrorState
            title="The download list could not be read"
            error={state.error}
            onRetry={props.onRetry}
          />
        ) : (
          <>
            {notices.map((notice) => (
              <p
                key={notice.id}
                role="status"
                data-fit-notice={notice.id}
                className={cn(
                  "text-meta",
                  notice.tone === "warning" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {notice.text}
              </p>
            ))}
            {state.error ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-surface border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <span>The last read failed ({state.error}). The saved list is shown.</span>
                <Button size="sm" variant="outline" onClick={props.onRetry}>
                  <RefreshCw className="size-3" /> Retry
                </Button>
              </div>
            ) : null}
            {phase === "empty" ? (
              <EmptyState
                title="Nothing to list yet"
                hint="The catalogue has no downloads for this page."
              />
            ) : (
              groups.map((group) => (
                <Group
                  key={group.state}
                  group={group}
                  open={isOpen(group)}
                  toggle={() => setOpen((prev) => ({ ...prev, [group.state]: !isOpen(group) }))}
                  props={props}
                  askConfirm={setPending}
                />
              ))
            )}
            {doctor.length > 0 ? (
              <section data-fit-doctor className="space-y-2">
                <p className="label-xs text-primary">Doctor</p>
                {doctor.map((item) => (
                  <div
                    key={item.id}
                    data-doctor-row={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-surface border border-border/60 bg-muted/20 px-3 py-2"
                  >
                    <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-sm text-foreground">{item.label}</span>
                    <StatusPill label={item.statusLabel} tone={item.tone} />
                    <span className="w-full text-meta text-muted-foreground">{item.detail}</span>
                    {item.repair ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => props.onRepair(item.repair!.id, item.repair!.action)}
                      >
                        {item.repair.label}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
      <AlertDialog open={pending !== null} onOpenChange={(next) => !next && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5">
                {pending?.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const run = pending?.run;
                setPending(null);
                run?.();
              }}
            >
              {pending?.confirmLabel ?? "OK"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HudPanel>
  );
}

/** "Checked 3 min ago" moves on the shared one-second clock, and the panel re-renders at most every 30 s. */
function useAgeClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => onVisibleSecond((t) => setNow((prev) => (t - prev >= 30_000 ? t : prev))), []);
  return now;
}

const lookups: TargetLookups = {
  installerHas: (id) => installer.entries().some((entry) => entry.pkg === id),
  voiceModelId: (catalogId) => (modelById.has(catalogId) ? catalogId : null),
  modelIdForTag: (tag) => modelByTag(tag)?.id ?? null,
};

/**
 * The connected panel: the Install Manager passes `scope="installManager"` (tools, engines, runtime packs), the Models
 * page `scope="models"` (voice models and curated chat models). Both read the one catalogue store.
 */
export function InstallerFitPanel({
  scope,
  title,
  query,
}: {
  scope: InstallerScope;
  title?: string;
  query?: string;
}) {
  const catalogState = useInstallerCatalog();
  const clock = useAgeClock();
  const installerState = useInstaller();
  const modelsState = useModels();

  const onUpdate = async (row: InstallerCatalogRow): Promise<Pending | null> => {
    const settings = autonomy.getSnapshot();
    const dial: AutonomyDial = dialOf(settings.approvalLevel, settings.halted);
    const first = await catalogState.update(row.id, dial);
    const outcome = updateOutcome(first, row.name);
    if (outcome.kind === "consent") {
      const words = consentWording(row, dial);
      return {
        ...words,
        confirmLabel: "Update",
        run: () => {
          void catalogState.update(row.id, dial, { granted: true }).then((result) => {
            const done = updateOutcome(result, row.name);
            if (done.kind === "started") toast.success(done.text);
            else toast.error(done.text);
          });
        },
      };
    }
    if (outcome.kind === "started") toast.success(outcome.text);
    else toast.error(outcome.text);
    return null;
  };

  return (
    <InstallerFitView
      scope={scope}
      title={title ?? (scope === "models" ? "Models this PC can run" : "Downloads for this PC")}
      state={catalogState}
      now={Math.max(clock, catalogState.catalog?.generatedAt ?? 0)}
      {...(query !== undefined ? { query } : {})}
      lookups={lookups}
      isBusy={(_row, target) =>
        target?.via === "installer"
          ? installerState.jobs.some((j) => j.pkg === target.id && isInstallerJobActive(j.phase))
          : target?.via === "models"
            ? modelsState.jobs.some((j) => j.modelId === target.id && isModelJobActive(j.phase))
            : false
      }
      onInstall={(row, target) => {
        if (target.via === "installer") {
          const job = installer.enqueue(target.id, "install");
          if (job) toast(`${row.name} · install queued`);
          else toast.error(`${row.name} is not in the installer list yet`);
        } else {
          models.install(target.id);
          toast(`${row.name} · download started`);
        }
      }}
      onUpdate={onUpdate}
      onRepair={(id, action) => {
        const job = installer.enqueue(id, action);
        if (job) toast(`${id} · ${action} queued`);
        else
          toast.error(
            `${id} cannot be ${action === "install" ? "installed" : "repaired"} from here yet`,
          );
      }}
      onRefresh={async () => {
        toast(refreshOutcomeText(await catalogState.refreshList()));
      }}
      onRetry={() => void catalogState.load()}
    />
  );
}
