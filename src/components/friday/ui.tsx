import {
  createElement,
  forwardRef,
  isValidElement,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronsDown, Inbox, List, Loader2, MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconForTitle } from "@/components/friday/button-icons";
import { toolbarFit, useMeasuredWidth } from "@/lib/friday/chat-level";
import { cn } from "@/lib/utils";

/**
 * Shared FRIDAY HUD primitives: neon panels, tiles, pills, rings, tables,
 * and the FRIDAY Glass controls (ActionButton, Toolbar, SectionTabs,
 * EmptyState, LoadingState). Pages build on these instead of hand-rolling
 * surfaces, so the Appearance settings reach every page. All are SSR-safe:
 * nothing reads `window` while rendering.
 */

type Tone = "primary" | "accent" | "warning" | "magenta" | "destructive" | "muted";

const toneText: Record<Tone, string> = {
  primary: "text-primary",
  accent: "text-accent",
  warning: "text-warning",
  magenta: "text-magenta",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

export function HudPanel({
  title,
  hint,
  actions,
  icon: Icon,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  /** Header icon (lucide). Without one, the title picks one, else the signal dot. */
  icon?: LucideIcon | undefined;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  // No icon given: one from the panel-title vocabulary, else the signal dot.
  const titleIcon = !Icon && title ? iconForTitle(title) : null;
  return (
    <section className={cn("hud-panel relative overflow-hidden rounded-surface", className)}>
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-[calc(1rem*var(--friday-density-scale,1))] py-[calc(0.625rem*var(--friday-density-scale,1))]">
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? (
              <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : titleIcon ? (
              createElement(titleIcon, {
                className: "size-4 shrink-0 text-primary",
                "aria-hidden": true,
              })
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_10px_2px_var(--color-primary)]" />
            )}
            <h2
              className="label-xs friday-panel-title glow-text truncate text-primary"
              title={title}
            >
              {title}
            </h2>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
            {actions}
          </div>
        </header>
      ) : null}
      <div className={cn("p-[calc(1rem*var(--friday-density-scale,1))]", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/** Legacy alias so older sections keep rendering. */
export function Panel(props: Parameters<typeof HudPanel>[0]) {
  return <HudPanel {...props} />;
}

export function StatTile({
  icon,
  label,
  value,
  state,
  tone = "primary",
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  state?: string;
  tone?: Tone;
}) {
  return (
    <div className="hud-tile motion-friday group relative overflow-hidden rounded-surface px-3 py-3 text-center transition-[border-color,transform] hover:-translate-y-px hover:border-primary/45">
      <div className={cn("flex items-center justify-center gap-1.5", toneText[tone])}>
        {icon}
        <span className="label-xs">{label}</span>
      </div>
      <p className="mt-2 font-display text-2xl font-bold leading-none text-foreground">{value}</p>
      {state ? <p className={cn("mt-1.5 text-meta", toneText[tone])}>{state}</p> : null}
    </div>
  );
}

export function StatusPill({ label, tone = "accent" }: { label: string; tone?: Tone }) {
  const bg: Record<Tone, string> = {
    primary: "bg-primary/12 text-primary border-primary/30",
    accent: "bg-accent/12 text-accent border-accent/30",
    warning: "bg-warning/12 text-warning border-warning/30",
    magenta: "bg-magenta/12 text-magenta border-magenta/30",
    destructive: "bg-destructive/12 text-destructive border-destructive/30",
    muted: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "friday-chip inline-flex items-center gap-1 rounded-ctl border px-1.5 py-0.5 text-meta-sm uppercase tracking-wider",
        bg[tone],
      )}
    >
      {label}
    </span>
  );
}

export function toneForStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (
    [
      "active",
      "online",
      "ready",
      "running",
      "optimal",
      "loaded",
      "completed",
      "up to date",
      "allowed",
      "installed",
      "available",
      "enabled",
    ].includes(s)
  )
    return "accent";
  if (["learning", "scheduled", "in progress", "update available", "ask", "degraded"].includes(s))
    return "warning";
  if (["offline", "failed", "blocked", "not installed"].includes(s)) return "destructive";
  if (["idle", "inactive", "unknown", "—"].includes(s)) return "muted";
  return "primary";
}

/** Left / Right / Home / End move between tabs, as a tab list should. */
function tabKeys(
  event: KeyboardEvent<HTMLElement>,
  keys: string[],
  value: string,
  onChange: (key: string) => void,
) {
  const i = keys.indexOf(value);
  const next =
    event.key === "ArrowRight"
      ? keys[(i + 1) % keys.length]
      : event.key === "ArrowLeft"
        ? keys[(i - 1 + keys.length) % keys.length]
        : event.key === "Home"
          ? keys[0]
          : event.key === "End"
            ? keys[keys.length - 1]
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  onChange(next);
  const list = event.currentTarget;
  queueMicrotask(() => {
    list.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(next)}"]`)?.focus();
  });
}

/**
 * The sliding thumb of an iOS segmented control. The selected segment is
 * measured once per change and on resize (no animation loop); the thumb only
 * moves by transform. Classic hides the thumb in CSS.
 */
export function useSlidingThumb(active: string | number) {
  const listRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const thumb = thumbRef.current;
    if (!list || !thumb) return;
    const place = () => {
      const el = list.querySelector<HTMLElement>(
        '[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"]',
      );
      if (!el) {
        thumb.style.width = "0px";
        return;
      }
      thumb.style.width = `${el.offsetWidth}px`;
      thumb.style.transform = `translateX(${el.offsetLeft}px)`;
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, [active]);
  return { listRef, thumbRef };
}

/**
 * Tab and filter changes: the chosen tab lights up at once (optimistic), while
 * the page content it controls updates as a low-priority transition, so a
 * heavy page never makes the click feel late.
 */
function useTransitionValue<T>(value: T, onChange: (next: T) => void) {
  const [shown, setShown] = useOptimistic(value);
  const [, startTransition] = useTransition();
  const change = (next: T) => {
    startTransition(() => {
      setShown(next);
      onChange(next);
    });
  };
  return [shown, change] as const;
}

/** One choice out of a few, as an iOS segmented control. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  const [shown, pick] = useTransitionValue(value, onChange);
  const { listRef, thumbRef } = useSlidingThumb(shown);
  return (
    <div
      ref={listRef}
      role="group"
      aria-label={label}
      className={cn("friday-seg inline-flex gap-1", className)}
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {options.map((item) => {
        const on = shown === item.id;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={on}
            onClick={() => pick(item.id)}
            className={cn(
              "friday-btn inline-flex items-center justify-center gap-1.5 rounded-ctl border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              on
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function FilterTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [shown, pick] = useTransitionValue(value, onChange);
  const { listRef, thumbRef } = useSlidingThumb(shown);
  return (
    <div
      ref={listRef}
      role="tablist"
      className="friday-seg flex flex-wrap gap-1.5"
      onKeyDown={(e) =>
        tabKeys(
          e,
          tabs.map((t) => t.key),
          shown,
          pick,
        )
      }
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={shown === t.key}
          tabIndex={shown === t.key ? 0 : -1}
          data-tab-key={t.key}
          onClick={() => pick(t.key)}
          className={cn(
            "friday-btn rounded-ctl border px-2 py-1 text-meta transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            shown === t.key
              ? "border-primary/50 bg-primary/15 text-primary glow-ring"
              : "border-border bg-surface text-muted-foreground hover:border-primary/30 hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Ring({
  value,
  label,
  sub,
  tone = "primary",
  size = 84,
}: {
  value: number;
  label: string;
  sub?: string;
  tone?: Tone;
  size?: number;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const stroke =
    tone === "accent"
      ? "var(--color-accent)"
      : tone === "warning"
        ? "var(--color-warning)"
        : tone === "magenta"
          ? "var(--color-magenta)"
          : "var(--color-primary)";
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="size-full -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-border)" strokeWidth="7" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${(c * value) / 100} ${c}`}
            style={{ filter: `drop-shadow(0 0 6px ${stroke})` }}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center leading-none">
          <span className="font-display text-sm font-bold text-foreground">{value}%</span>
        </div>
      </div>
      <p className={cn("label-xs", toneText[tone])}>{label}</p>
      {sub ? <p className="text-meta-sm text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function MetricBar({
  label,
  value,
  detail,
  tone = "primary",
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: Tone;
}) {
  const bg: Record<Tone, string> = {
    primary: "bg-primary",
    accent: "bg-accent",
    warning: "bg-warning",
    magenta: "bg-magenta",
    destructive: "bg-destructive",
    muted: "bg-muted-foreground",
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="label-xs text-muted-foreground">{label}</span>
          <span className={cn("text-meta", toneText[tone])}>{value}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", bg[tone])}
            style={{ width: `${value}%`, boxShadow: "0 0 8px currentColor" }}
          />
        </div>
        {detail ? (
          <p className="mt-1 truncate text-meta-sm text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Rows drawn at first; the rest follow on request, so a long catalogue opens quickly. */
export const TABLE_ROW_STEP = 80;

export function DataTable({
  columns,
  rows,
  pinLast = false,
  step = TABLE_ROW_STEP,
}: {
  columns: string[];
  rows: ReactNode[][];
  /** Keep the final (action) column reachable when the table scrolls sideways. */
  pinLast?: boolean;
  /** How many rows to draw before "Show more". */
  step?: number;
}) {
  const [shownCount, setShownCount] = useState(step);
  const total = rows.length;
  const limit = Math.max(step, shownCount);
  const visible = total > limit ? rows.slice(0, limit) : rows;
  const last = columns.length - 1;
  const pinCls = (isLast: boolean, head: boolean) =>
    pinLast && isLast
      ? `sticky right-0 z-10 pl-3 pr-2 ${head ? "bg-card" : "bg-card/95 backdrop-blur-sm"} before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border/60`
      : "pr-4";
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-primary/20 text-left">
            {columns.map((c, j) => (
              <th
                key={c}
                className={`label-xs whitespace-nowrap py-2 font-normal text-primary/70 ${pinCls(j === last, true)}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr
              key={i}
              className="border-b border-border/60 transition-colors last:border-0 hover:bg-primary/6"
            >
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`whitespace-nowrap py-2 align-middle ${pinCls(j === last, false)}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > limit ? (
        <div className="flex flex-wrap items-center justify-center gap-2 py-3">
          <span className="text-meta text-muted-foreground">
            Showing {limit} of {total}
          </span>
          <ActionButton
            icon={ChevronsDown}
            label={`Show ${Math.min(step, total - limit)} more`}
            labelMode="inline"
            onClick={() => setShownCount(limit + step)}
          />
          <ActionButton
            icon={List}
            label={`Show all ${total}`}
            labelMode="inline"
            onClick={() => setShownCount(total)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ToggleRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 py-2 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{label}</p>
        {hint ? <p className="truncate text-meta-sm text-muted-foreground">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          "friday-btn friday-switch relative h-5 w-9 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          on ? "border-accent/60 bg-accent/30" : "border-border bg-muted",
        )}
      >
        <span
          className={cn(
            "friday-switch-thumb absolute top-0.5 size-3.5 rounded-full transition-all",
            on
              ? "left-[1.15rem] bg-accent shadow-[0_0_8px_var(--color-accent)]"
              : "left-0.5 bg-muted-foreground",
          )}
        />
      </button>
    </div>
  );
}

export function Sparkline({ series, tone = "accent" }: { series: number[]; tone?: Tone }) {
  const max = Math.max(...series, 1);
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * 100},${30 - (v / max) * 28}`)
    .join(" ");
  const stroke = tone === "accent" ? "var(--color-accent)" : "var(--color-primary)";
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full">
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
        style={{ filter: `drop-shadow(0 0 4px ${stroke})` }}
      />
    </svg>
  );
}

export function StatusDot({ state }: { state: "ready" | "loading" | "offline" }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        state === "ready" && "bg-accent shadow-[0_0_8px_var(--color-accent)]",
        state === "loading" && "bg-warning pulse-dot",
        state === "offline" && "bg-muted-foreground",
      )}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  FRIDAY Glass controls                                              */
/* ------------------------------------------------------------------ */

type ActionButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  label: string;
  /** "auto" follows Settings › Button labels; "inline" always shows the text. */
  labelMode?: "auto" | "inline";
  /** The sliding label opens upward by default; "below" for top bars. */
  labelSide?: "above" | "below";
  /** Shows a spinner instead of the icon and disables the button. */
  busy?: boolean;
  children?: ReactNode;
};

/**
 * Icon + label. The label is always in the DOM right after the icon and in
 * the accessible name; it slides out on hover or keyboard focus (~180 ms,
 * width and opacity only, overlaid so neighbours never move), or sits
 * inline when labelMode is "inline" or Button labels is "Always".
 */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  {
    icon: Icon,
    label,
    labelMode = "auto",
    labelSide = "above",
    busy = false,
    variant = "outline",
    size = "sm",
    className,
    children,
    title,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={title ?? label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      data-label-mode={labelMode === "inline" ? "inline" : undefined}
      data-label-side={labelSide === "below" ? "below" : undefined}
      className={cn("action-btn relative h-8 gap-1.5 px-2.5", className)}
      {...rest}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="size-4" aria-hidden="true" />
      )}
      <span className="action-label">{label}</span>
      {children}
    </Button>
  );
});

export type ToolbarAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Primary actions never move into More. */
  primary?: boolean;
};

/** Rough width of one ActionButton at the default size, in px. */
function actionWidth(action: ToolbarAction, inline: boolean): number {
  return inline ? 44 + action.label.length * 7 : 40;
}

/**
 * A row of actions that wraps, and on a narrow container moves the
 * secondary actions into one More menu (same handlers, keyboard reachable).
 * The split is the pure `toolbarFit` from chat-level.ts.
 */
export function Toolbar({
  actions,
  labelMode = "auto",
  className,
  children,
}: {
  actions: ToolbarAction[];
  labelMode?: "auto" | "inline";
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref);
  const inline = labelMode === "inline";
  const primary = actions.filter((a) => a.primary);
  const secondary = actions.filter((a) => !a.primary);
  const fixed = primary.reduce((sum, a) => sum + actionWidth(a, inline) + 6, 0);
  const shown =
    width > 0
      ? toolbarFit(
          secondary.map((a) => actionWidth(a, inline) + 6),
          width - fixed,
          40,
        )
      : secondary.length;
  const render = (a: ToolbarAction) => (
    <ActionButton
      key={a.id}
      icon={a.icon}
      label={a.label}
      labelMode={labelMode}
      disabled={a.disabled}
      onClick={a.onSelect}
    />
  );
  const more = secondary.slice(shown);
  return (
    <div
      ref={ref}
      role="toolbar"
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {primary.map(render)}
      {secondary.slice(0, shown).map(render)}
      {more.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ActionButton icon={MoreHorizontal} label="More" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {more.map((a) => (
              <DropdownMenuItem key={a.id} disabled={Boolean(a.disabled)} onSelect={a.onSelect}>
                <a.icon className="size-4" /> {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {children}
    </div>
  );
}

export type SectionTab = { key: string; label: string; icon?: LucideIcon; count?: number };

/** Tabs for a page's sections: icon, label and an optional live count. */
export function SectionTabs({
  tabs,
  value,
  onChange,
  label = "Sections",
}: {
  tabs: SectionTab[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
}) {
  const [shown, pick] = useTransitionValue(value, onChange);
  const { listRef, thumbRef } = useSlidingThumb(shown);
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className="friday-seg flex min-w-0 flex-wrap gap-1 border-b border-primary/15 pb-1"
      onKeyDown={(e) =>
        tabKeys(
          e,
          tabs.map((t) => t.key),
          shown,
          pick,
        )
      }
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {tabs.map((t) => {
        const on = shown === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-tab-key={t.key}
            onClick={() => pick(t.key)}
            className={cn(
              "friday-btn relative inline-flex items-center gap-1.5 rounded-ctl px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              on
                ? "bg-primary/12 text-primary after:absolute after:inset-x-2 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:bg-primary/6 hover:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
            {t.label}
            {typeof t.count === "number" ? (
              <span className="rounded-ctl bg-primary/15 px-1 text-meta-sm text-primary">
                {t.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Nothing to show yet: an icon, one sentence, and the next step. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-surface border border-dashed border-primary/20 px-4 py-8 text-center",
        className,
      )}
    >
      <Icon className="size-5 text-primary/70" aria-hidden="true" />
      <p className="text-sm text-foreground">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground">{hint}</p> : null}
      {action && isValidElement(action) ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * Still loading: static skeleton rows (no animation of its own, so a page
 * that waits costs nothing) and a screen-reader status line.
 */
export function LoadingState({
  label = "Loading…",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={cn("space-y-2", className)}>
      <p className="flex items-center gap-2 text-meta text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {label}
      </p>
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-3 rounded-ctl bg-primary/8"
          style={{ width: `${92 - i * 14}%` }}
        />
      ))}
    </div>
  );
}
