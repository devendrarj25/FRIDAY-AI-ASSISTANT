/**
 * FRIDAY boot screen: the one thing on screen while FRIDAY starts.
 *
 * It sits in the middle of the window with the FRIDAY mark, says why this start is a start (the first one, a restart,
 * a start with Windows, or a normal one), and shows the real work: a bar that follows the stages the main process
 * finishes (electron/boot-plan.cjs), the stage being worked on, and a short list of every stage with its state.
 * It leaves when FRIDAY reports ready, not after a fixed time, and never in the browser preview. Opening the window
 * again while FRIDAY runs in the tray does not show it: the page is still alive.
 *
 * Drawing is cheap on purpose: the bar is one transformed element, nothing blurs the page behind it, and the only
 * loop is a four-a-second clock in the hook.
 */
import { useEffect } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { FridayOrb } from "@/components/friday/FridayOrb";
import { useBootSequence } from "@/lib/friday/desktop";
import type { StageState } from "@/lib/friday/boot-progress";
import { cn } from "@/lib/utils";

const ICONS: Record<StageState, typeof CheckCircle2> = {
  done: CheckCircle2,
  warn: CircleAlert,
  missing: XCircle,
  active: LoaderCircle,
  waiting: CircleDashed,
  skipped: MinusCircle,
};

const TONES: Record<StageState, string> = {
  done: "text-success",
  warn: "text-warning",
  missing: "text-destructive",
  active: "text-primary",
  waiting: "text-muted-foreground/60",
  skipped: "text-muted-foreground/60",
};

const seconds = (ms: number) => `${Math.floor(ms / 1000)}s`;

/** The static splash in index.html is replaced as soon as the real screen (or the app) is on screen. */
function useSplashHandoff() {
  useEffect(() => {
    const splash = document.getElementById("friday-splash");
    if (!splash) return;
    splash.classList.add("friday-splash-out");
    const timer = setTimeout(() => splash.remove(), 220);
    return () => clearTimeout(timer);
  }, []);
}

export function BootScreen() {
  const { plan, progress, shownPercent, elapsedMs, gate, done, leaving, dismiss } =
    useBootSequence();
  useSplashHandoff();
  if (done) return null;

  const percent = Math.round(shownPercent);
  const title = plan?.title ?? "Starting FRIDAY";
  const detail = plan?.detail ?? "Loading everything she needs.";
  const notReady = progress?.ready && !progress.readyOk;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 grid place-items-center bg-background transition-opacity duration-200",
        leaving ? "opacity-0" : "opacity-100",
      )}
      role="status"
      aria-live="polite"
      aria-busy={!progress?.ready}
    >
      <div className="w-full max-w-md px-6 text-center">
        <FridayOrb size={132} live className="mx-auto" />
        <p className="mt-5 font-display text-4xl font-bold tracking-[0.3em] text-primary glow-text">
          FRIDAY
        </p>
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-meta text-muted-foreground">{detail}</p>

        <div className="mt-6">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ? percent : undefined}
            aria-label="FRIDAY start-up progress"
          >
            {progress ? (
              <div
                className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-500 ease-out"
                style={{ transform: `scaleX(${Math.max(0.02, percent / 100)})` }}
              />
            ) : (
              <div className="friday-boot-indeterminate h-full w-1/3 rounded-full bg-primary" />
            )}
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-xs text-muted-foreground">
            <span className="truncate text-foreground">
              {progress?.currentLabel ?? "Initializing…"}
            </span>
            <span className="shrink-0 pl-3 tabular-nums">
              {progress ? `${percent}%` : ""} · {seconds(elapsedMs)}
            </span>
          </div>
          {progress?.currentDetail ? (
            <p className="mt-1 truncate text-left text-meta text-muted-foreground">
              {progress.currentDetail}
            </p>
          ) : null}
        </div>

        {progress ? (
          <ul className="mt-5 grid grid-cols-1 gap-x-4 gap-y-1 text-left sm:grid-cols-2">
            {progress.stages.map((stage) => {
              const Icon = ICONS[stage.state];
              return (
                <li
                  key={stage.id}
                  className={cn(
                    "flex items-center gap-2 text-meta",
                    stage.state === "skipped" || stage.state === "waiting"
                      ? "text-muted-foreground/70"
                      : "text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0",
                      TONES[stage.state],
                      stage.state === "active" && "animate-spin",
                    )}
                  />
                  <span className="truncate">{stage.label}</span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {notReady ? (
          <p className="mt-4 text-meta text-warning">
            FRIDAY started, but not everything is ready: {progress?.blockers}
          </p>
        ) : null}
        {gate === "stuck" || notReady ? (
          <button
            type="button"
            onClick={dismiss}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-meta text-foreground hover:bg-muted"
          >
            {notReady ? "Continue" : "Taking longer than usual: continue anyway"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
