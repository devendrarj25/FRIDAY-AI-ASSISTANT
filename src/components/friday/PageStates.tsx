import { useEffect, useRef } from "react";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Home, RotateCcw, TriangleAlert, WifiOff } from "lucide-react";
import { ActionButton } from "@/components/friday/ui";
import { isDesktopApp } from "@/lib/friday/desktop";
import { onVisibleSecond } from "@/lib/friday/frame-clock";
import { ageLabel, liveness, type Liveness } from "@/lib/friday/page-state";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { useNetwork } from "@/lib/friday/use-network";
import { reportRendererError } from "@/lib/error-reporting";
import { cn } from "@/lib/utils";

/**
 * Shared page states: error with Retry, the kernel-down banner, the Live
 * badge and the route-level error screen. Loading and empty states are the
 * EmptyState and LoadingState primitives in ui.tsx.
 */

export function ErrorState({
  title = "This could not be loaded",
  error,
  onRetry,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const detail = error instanceof Error ? error.message : error ? String(error) : "";
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-surface border border-destructive/40 bg-destructive/5 px-4 py-8 text-center",
        className,
      )}
    >
      <TriangleAlert className="size-5 text-destructive" aria-hidden="true" />
      <p className="text-sm text-foreground">{title}</p>
      {detail ? (
        <p className="max-w-lg break-words text-data text-muted-foreground">{detail}</p>
      ) : null}
      {onRetry ? (
        <ActionButton
          icon={RotateCcw}
          label="Retry"
          labelMode="inline"
          title="Try loading this again"
          onClick={onRetry}
        />
      ) : null}
    </div>
  );
}

/**
 * Shown above every page while the desktop kernel or the network is down.
 * The pages keep what is stored on this PC; live data resumes by itself
 * (the kernel poller reconnects), so there is nothing to click.
 */
export function OfflineBanner() {
  const desktop = isDesktopApp();
  const kernel = useKernelStatus();
  const net = useNetwork();
  const kernelDown = desktop && !kernel.connected;
  const netDown = !net.online;
  if (!kernelDown && !netDown) return null;
  return (
    <div
      role="status"
      data-offline-banner
      className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-surface border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {kernelDown
          ? "The FRIDAY kernel is not connected. Pages show what is stored on this PC and update on their own when it comes back."
          : "No network. Local features keep working; cloud models and online checks resume when the connection returns."}
      </span>
    </div>
  );
}

const livenessText: Record<Liveness, string> = {
  live: "Live",
  stale: "Waiting",
  offline: "Offline",
};

/**
 * "Live · updated 4 s ago". The age text is written straight into the node
 * once a second by the shared one-second clock (paused while hidden), so the
 * badge never re-renders a page on a timer.
 */
export function LiveBadge({
  at,
  everyMs,
  offline = false,
  error = null,
  verb = "updated",
  className,
}: {
  at: number | null | undefined;
  everyMs: number;
  offline?: boolean;
  error?: string | null;
  /** "updated", "scanned", "last entry": what the age is measured from. */
  verb?: string;
  className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const paint = (now: number) => {
    const state = liveness({ at, now, everyMs, offline, error });
    if (labelRef.current) labelRef.current.textContent = livenessText[state];
    if (textRef.current) {
      textRef.current.textContent = error
        ? `last try failed`
        : at
          ? `${verb} ${ageLabel(at, now)}`
          : "no data yet";
    }
    if (dotRef.current) dotRef.current.dataset["state"] = state;
  };
  useEffect(() => {
    paint(Date.now());
    return onVisibleSecond(paint);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paint reads the latest props
  }, [at, everyMs, offline, error, verb]);
  return (
    <span
      data-live-badge
      className={cn("inline-flex items-center gap-1.5 text-meta text-muted-foreground", className)}
      title={error ?? undefined}
    >
      <span ref={dotRef} data-state="stale" aria-hidden="true" className="live-dot" />
      <span ref={labelRef} className="text-foreground">
        {livenessText[liveness({ at, now: 0, everyMs, offline, error })]}
      </span>
      <span aria-hidden="true">·</span>
      <span ref={textRef} suppressHydrationWarning>
        {at ? verb : "no data yet"}
      </span>
    </span>
  );
}

/**
 * Route-level error screen (router `defaultErrorComponent`): the message, a
 * Retry that re-runs the route, and a way back to the Main window. It renders
 * inside the app shell, so the sidebar stays usable.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => {
    reportRendererError(error, { boundary: "route_error_component" });
  }, [error]);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10">
      <ErrorState
        title="This page hit a problem"
        error={error}
        onRetry={() => {
          void router.invalidate();
          reset();
        }}
      />
      <div className="flex justify-center">
        <Link
          to="/"
          className="friday-btn inline-flex h-8 items-center gap-1.5 rounded-ctl border px-3 text-xs text-foreground hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Home className="size-4" aria-hidden="true" />
          Go to Main window
        </Link>
      </div>
    </div>
  );
}
