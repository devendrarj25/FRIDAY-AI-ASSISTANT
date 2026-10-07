import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared FRIDAY HUD primitives: neon panels, tiles, pills, rings, tables. */

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
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("hud-panel relative overflow-hidden rounded-md", className)}>
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-[calc(1rem*var(--friday-density-scale,1))] py-[calc(0.625rem*var(--friday-density-scale,1))]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_10px_2px_var(--color-primary)]" />
            <h2 className="label-xs glow-text truncate text-primary">{title}</h2>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {hint ? (
              <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>
            ) : null}
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
    <div className="hud-tile group relative overflow-hidden rounded-md px-3 py-3 text-center transition-colors hover:border-primary/45">
      <div className={cn("flex items-center justify-center gap-1.5", toneText[tone])}>
        {icon}
        <span className="label-xs">{label}</span>
      </div>
      <p className="mt-2 font-display text-2xl font-bold leading-none text-foreground">{value}</p>
      {state ? <p className={cn("mt-1.5 font-mono text-[11px]", toneText[tone])}>{state}</p> : null}
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
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
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

export function FilterTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
            value === t.key
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
      {sub ? <p className="font-mono text-[10px] text-muted-foreground">{sub}</p> : null}
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
          <span className={cn("font-mono text-[11px]", toneText[tone])}>{value}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", bg[tone])}
            style={{ width: `${value}%`, boxShadow: "0 0 8px currentColor" }}
          />
        </div>
        {detail ? (
          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  pinLast = false,
}: {
  columns: string[];
  rows: ReactNode[][];
  /** Keep the final (action) column reachable when the table scrolls sideways. */
  pinLast?: boolean;
}) {
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
          {rows.map((row, i) => (
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
        {hint ? (
          <p className="truncate font-mono text-[10px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
          on ? "border-accent/60 bg-accent/30" : "border-border bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3.5 rounded-full transition-all",
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
