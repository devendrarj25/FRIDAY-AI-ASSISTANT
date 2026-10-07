import { useEffect, useRef, useState } from "react";
import { Minus, Mic, MicOff, Wifi, WifiOff, X } from "lucide-react";
// Pulls in the `window.friday` global type declaration.
import "@/lib/friday/bridge";
import { NotificationCenter } from "@/components/friday/NotificationCenter";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { useNetwork } from "@/lib/friday/use-network";
import { cn } from "@/lib/utils";

/**
 * The custom FRIDAY title strip. The native Windows title bar is hidden
 * (`frame: false` in electron/main.cjs) so this is the only chrome: brand on
 * the left, live FPS / network / clock and window controls on the right.
 *
 * Performance: one rAF loop that only commits state once per second, one 1s
 * clock interval and event-driven network status. Nothing polls the system.
 */

export function TitleStrip() {
  const [fps, setFps] = useState(60);
  const net = useNetwork();
  const [now, setNow] = useState<Date | null>(null);
  const mode = useAssistantMode();
  const frames = useRef(0);

  // Live FPS — measured every frame, published once per second, and suspended
  // entirely while the window is hidden so a minimised FRIDAY costs nothing.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let stopped = false;
    const loop = (t: number) => {
      if (stopped) return;
      if (document.hidden) {
        frames.current = 0;
        last = t;
        raf = requestAnimationFrame(loop);
        return;
      }
      frames.current += 1;
      if (t - last >= 1000) {
        setFps(Math.round((frames.current * 1000) / (t - last)));
        frames.current = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Clock — a single shared interval, paused while the window is hidden.
  useEffect(() => {
    setNow(new Date());
    let id = 0;
    const start = () => {
      window.clearInterval(id);
      id = window.setInterval(() => setNow(new Date()), 1000);
    };
    const onVisibility = () => {
      if (document.hidden) window.clearInterval(id);
      else {
        setNow(new Date());
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const desktop = typeof window !== "undefined" ? window.friday : undefined;
  const minimize = () => desktop?.minimizeWindow?.();
  const close = () => desktop?.closeWindow?.();

  // Windows caption conventions on the custom strip: double-click toggles
  // maximize/restore, right-click opens the window's system menu.
  const onDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    desktop?.toggleMaximizeWindow?.();
  };
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    desktop?.openWindowSystemMenu?.();
  };

  const fpsTone = fps >= 50 ? "text-accent" : fps >= 30 ? "text-warning" : "text-destructive";
  const auto = mode.mode === "auto";

  return (
    <header
      className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-primary/20 bg-sidebar px-3 select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <p className="min-w-0 truncate font-display text-[13px] font-bold tracking-[0.2em] text-primary glow-text">
        FRIDAY <span className="text-muted-foreground">— PERSONAL AI ASSISTANT</span>
      </p>

      <div
        className="flex min-w-0 shrink items-center gap-2 overflow-hidden font-mono text-[11px] text-muted-foreground"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => assistantMode.toggle()}
          role="switch"
          aria-checked={auto}
          aria-label={auto ? "Auto mode — switch to manual" : "Manual mode — switch to auto"}
          title={
            mode.error
              ? `Auto mode: ${mode.error}`
              : auto
                ? `${mode.status}${mode.heard ? ` · heard: ${mode.heard}` : ""}`
                : "Manual mode — FRIDAY only acts on what you type"
          }
          className={cn(
            "relative flex h-6 items-center rounded-full border px-0.5 transition-colors duration-300",
            auto
              ? "border-accent/60 bg-accent/10 shadow-[0_0_14px_-4px_var(--color-accent)]"
              : "border-primary/30 bg-primary/5 hover:border-primary/60",
          )}
        >
          {/* sliding neon pill */}
          <span
            className={cn(
              "absolute top-0.5 h-5 w-[4.6rem] rounded-full transition-all duration-300 ease-out",
              auto
                ? "left-[4.9rem] bg-accent/25 shadow-[0_0_12px_-2px_var(--color-accent)]"
                : "left-0.5 bg-primary/20 shadow-[0_0_12px_-2px_var(--color-primary)]",
            )}
          />
          <span
            className={cn(
              "relative z-10 flex w-[4.6rem] items-center justify-center gap-1 text-[10px] tracking-[0.12em] transition-colors duration-300",
              auto ? "text-muted-foreground" : "text-primary",
            )}
          >
            <MicOff className="size-3" />
            MANUAL
          </span>
          <span
            className={cn(
              "relative z-10 flex w-[4.6rem] items-center justify-center gap-1 text-[10px] tracking-[0.12em] transition-colors duration-300",
              auto ? "text-accent" : "text-muted-foreground",
            )}
          >
            <Mic className={auto && mode.listening ? "size-3 pulse-dot" : "size-3"} />
            AUTO
          </span>
        </button>
        <span className="hidden text-primary/25 sm:inline">|</span>
        <span className={`hidden sm:inline ${fpsTone}`} title="Live frames per second">
          {fps} FPS
        </span>
        <span className="hidden text-primary/25 sm:inline">|</span>
        <span
          className={
            net.online ? "flex items-center gap-1" : "flex items-center gap-1 text-destructive"
          }
          title={
            net.online
              ? [
                  `Connectivity: ${net.detail}`,
                  `FRIDAY now: ${net.appMbps > 0.01 ? `${net.appMbps.toFixed(2)} Mbps` : "idle"}`,
                  net.liveDownMbps >= 0
                    ? `Machine: ↓${net.liveDownMbps.toFixed(1)} ↑${Math.max(0, net.liveUpMbps).toFixed(1)} Mbps`
                    : net.machineDetail
                      ? `Machine counters unavailable: ${net.machineDetail}`
                      : null,

                  net.latencyMs >= 0 ? `Latency ${Math.round(net.latencyMs)} ms` : null,
                  net.downMbps >= 0 ? `Link speed ${net.downMbps.toFixed(1)} Mbps` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `Offline · ${net.detail}`
          }
        >
          {net.online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
          {net.label}
        </span>
        <span className="hidden text-primary/25 lg:inline">|</span>
        <span className="hidden text-foreground lg:inline" suppressHydrationWarning>
          {now ? now.toLocaleTimeString("en-GB", { hour12: false }) : "--:--:--"}
        </span>
        <span className="hidden text-primary/25 xl:inline">|</span>
        <span className="hidden xl:inline" suppressHydrationWarning>
          {now ? now.toLocaleDateString("en-GB") : "--/--/----"}
        </span>
        <span className="hidden text-primary/25 2xl:inline">|</span>
        <span className="hidden 2xl:inline" suppressHydrationWarning>
          {now ? now.toLocaleDateString("en-GB", { weekday: "long" }) : "—"}
        </span>

        <div className="ml-1 flex items-center gap-1">
          <NotificationCenter />
          <button
            type="button"
            onClick={minimize}
            aria-label="Minimize FRIDAY"
            title="Minimize"
            className="grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close FRIDAY"
            title="Close"
            className="grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
