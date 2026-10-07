import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, BellOff, Check, Maximize2, Minimize2, Monitor, Sparkles, X } from "lucide-react";
import { askFriday, canAsk } from "@/lib/friday/ask";
import { notifications, type Notification } from "@/lib/friday/notifications";
import { stage } from "@/lib/friday/stage";
import { wireNotifications } from "@/lib/friday/notification-wiring";
import { useNotifications } from "@/lib/friday/use-notifications";
import { cn } from "@/lib/utils";

/**
 * The title-strip notification hub: one toggle for everything FRIDAY wants to
 * warn about, report or ask approval for. Content comes from the live
 * subsystems (doctor, governance, tasks, autonomy, network) — nothing here is
 * generated for display.
 */

const TONE: Record<string, string> = {
  info: "text-primary",
  success: "text-accent",
  warn: "text-warning",
  error: "text-destructive",
  action: "text-accent",
};

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Human label for where an alert takes you, shown on the entry itself. */
function whereLabel(route?: string): string {
  if (!route) return "no page linked";
  const name = route.replace(/^\//, "").replace(/-/g, " ") || "main screen";
  return name;
}

export function NotificationCenter() {
  const state = useNotifications();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    wireNotifications();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = state.unread;

  /** Take the owner to exactly where this alert came from. */
  const openItem = useCallback(
    (item: Notification) => {
      notifications.markRead(item.id);
      if (!item.route) return;
      setOpen(false);
      void navigate({ to: item.route });
    },
    [navigate],
  );

  /**
   * FRIDAY explains the alert herself: what it means, what it affects and the
   * exact steps to fix it. The answer is stored on the alert, so it is written
   * once and stays available afterwards.
   */
  const explain = useCallback(async (item: Notification) => {
    if (item.advice || !canAsk()) return;
    setAsking(item.id);
    try {
      const answer = await askFriday(
        [
          "One of my own subsystems raised this alert. Explain it to my owner.",
          `Source: ${item.source}`,
          `Where: ${item.route ?? "no page linked"}`,
          `Title: ${item.title}`,
          `Detail: ${item.detail || "(none recorded)"}`,
          "",
          "Answer in at most 6 short lines: what it means, what it affects, and",
          "numbered steps to fix it. If it needs no action, say so plainly.",
        ].join("\n"),
        { system: "You are FRIDAY explaining your own system alerts.", timeoutMs: 60_000 },
      );
      notifications.attachAdvice(item.id, answer);
    } catch (error) {
      notifications.attachAdvice(
        item.id,
        `I could not reach a model to explain this: ${(error as Error).message}`,
      );
    } finally {
      setAsking(null);
    }
  }, []);

  /** Put an alert on the main screen — with its visual when it carries one. */
  const showOnScreen = (item: Notification) => {
    if (item.present) {
      stage.show({ ...item.present, id: `notify-${item.id}` });
    } else {
      stage.show({
        id: `notify-${item.id}`,
        kind: "text",
        title: item.title,
        body: item.detail || "No further detail was recorded.",
        source: item.source,
      });
    }
    notifications.markRead(item.id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) notifications.markAllRead();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          notifications.toggle();
        }}
        aria-label={
          state.enabled
            ? `Notifications${unread ? ` — ${unread} unread` : ""}`
            : "Notifications paused"
        }
        title={
          state.enabled
            ? `FRIDAY notifications${unread ? ` — ${unread} unread` : ""} · right-click to pause`
            : "Notifications paused — right-click to resume"
        }
        className={cn(
          "relative grid size-6 place-items-center rounded-sm transition-colors",
          state.enabled ? "text-muted-foreground hover:text-primary" : "text-muted-foreground/50",
          open && "bg-primary/15 text-primary",
        )}
      >
        {state.enabled ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
        {state.enabled && unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-3.5 place-items-center rounded-full bg-accent px-1 text-[8px] leading-3.5 font-bold text-background">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            "hud-panel absolute top-8 right-0 z-50 flex flex-col",
            expanded ? "max-h-[85vh] w-[40rem]" : "max-h-[70vh] w-[22rem]",
            " rounded-md border border-primary/25 bg-sidebar shadow-[0_10px_40px_-10px_var(--color-primary)]",
          )}
        >
          <div className="flex items-center justify-between border-b border-primary/15 px-3 py-2">
            <p className="label-xs text-primary/70">FRIDAY NOTIFICATIONS</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-label={expanded ? "Collapse notifications" : "Expand notifications"}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-primary"
              >
                {expanded ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
              </button>
              <button
                type="button"
                onClick={() => notifications.toggle()}
                className="rounded-sm px-1.5 py-0.5 text-[10px] tracking-wider text-muted-foreground hover:text-primary"
              >
                {state.enabled ? "PAUSE" : "RESUME"}
              </button>
              <button
                type="button"
                onClick={() => notifications.clear()}
                className="rounded-sm px-1.5 py-0.5 text-[10px] tracking-wider text-muted-foreground hover:text-destructive"
              >
                CLEAR
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {state.enabled
                  ? "Nothing needs your attention."
                  : "Notifications are paused — FRIDAY is not recording alerts."}
              </p>
            ) : (
              state.items.map((item) => (
                <div
                  key={item.id}
                  className="group border-b border-primary/10 px-3 py-2 last:border-b-0 hover:bg-primary/5"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-1 size-1.5 shrink-0 rounded-full bg-current",
                        TONE[item.level],
                      )}
                    />
                    <div
                      className={cn("min-w-0 flex-1", item.route && "cursor-pointer")}
                      role={item.route ? "button" : undefined}
                      tabIndex={item.route ? 0 : undefined}
                      onClick={() => openItem(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") openItem(item);
                      }}
                    >
                      <p className={cn("truncate text-xs font-medium", TONE[item.level])}>
                        {item.title}
                      </p>
                      {item.detail ? (
                        <p
                          className={cn(
                            "mt-0.5 text-[11px] text-muted-foreground",
                            expanded ? "whitespace-pre-wrap" : "line-clamp-3",
                          )}
                        >
                          {item.detail}
                        </p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
                        <span>{item.source}</span>
                        <span>·</span>
                        <span>{ago(item.at)} ago</span>
                        <span>·</span>
                        <span className="truncate">{whereLabel(item.route)}</span>
                        {item.route ? <span className="text-primary">open</span> : null}
                      </div>
                      {item.advice ? (
                        <p className="mt-1 border-l border-accent/40 pl-2 text-[11px] whitespace-pre-wrap text-accent/90">
                          {item.advice}
                        </p>
                      ) : null}
                      {asking === item.id ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          FRIDAY is working out what this means…
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {!item.advice ? (
                        <button
                          type="button"
                          onClick={() => void explain(item)}
                          disabled={asking === item.id}
                          aria-label="Ask FRIDAY to explain and fix this"
                          title="Ask FRIDAY what this means and how to fix it"
                          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-accent disabled:opacity-40"
                        >
                          <Sparkles className="size-3" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => showOnScreen(item)}
                        aria-label="Show on main screen"
                        title="Show this on the main screen"
                        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-primary"
                      >
                        <Monitor className="size-3" />
                      </button>
                      {!item.read ? (
                        <button
                          type="button"
                          onClick={() => notifications.markRead(item.id)}
                          aria-label="Mark as read"
                          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-accent"
                        >
                          <Check className="size-3" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => notifications.dismiss(item.id)}
                        aria-label="Dismiss"
                        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-destructive"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
