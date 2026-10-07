import { toast } from "sonner";
import { Bell, BellOff, CheckCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { notifications } from "@/lib/friday/notifications";
import { useNotifications } from "@/lib/friday/use-notifications";
import { EditField } from "@/components/friday/settings/fields";
import {
  formatOwnerDate,
  requestDesktopNotificationPermission,
} from "@/lib/friday/settings-runtime";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";

/**
 * Notification settings driven by the same store the title-strip hub reads, so
 * every switch and button here changes what FRIDAY actually records and shows.
 */
export function NotificationSettings() {
  const state = useNotifications();
  const prefs = usePreferences();
  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));

  return (
    <div className="space-y-4">
      <HudPanel
        title="Notifications"
        hint={`${state.items.length} recorded · ${state.unread} unread`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => notifications.markAllRead()}>
              <CheckCheck className="size-4" /> Mark all read
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                notifications.clear();
                toast.success("Notification history cleared");
              }}
            >
              <Trash2 className="size-4" /> Clear
            </Button>
          </div>
        }
      >
        <ToggleRow
          label="Record notifications from FRIDAY's subsystems"
          on={state.enabled}
          onToggle={() => notifications.toggle()}
        />
        <ToggleRow
          label="Desktop notifications (Windows toasts)"
          on={isOn("notifications")}
          onToggle={() => {
            const next = !isOn("notifications");
            preferences.setToggle("notifications", next);
            if (next) {
              void requestDesktopNotificationPermission().then((permission) => {
                if (permission === "denied") {
                  toast.warning("Windows blocked desktop notifications for this app");
                }
              });
            }
          }}
        />
        <ToggleRow label="Sound on alerts" on={isOn("sounds")} onToggle={() => flip("sounds")} />
        <ToggleRow
          label="Speak critical alerts out loud"
          on={isOn("speakAlerts")}
          onToggle={() => flip("speakAlerts")}
        />
        <ToggleRow
          label="Do not disturb (mute toasts, sounds and spoken alerts)"
          on={isOn("doNotDisturb")}
          onToggle={() => flip("doNotDisturb")}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          The hub still records alerts. Only the noise is paused.
        </p>
        <ToggleRow
          label="Quiet hours"
          on={isOn("quietHours")}
          onToggle={() => flip("quietHours")}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <EditField
            label="Quiet hours start (HH:MM)"
            value={prefs.fields["quietStart"] || "22:00"}
            onChange={(value) => preferences.setField("quietStart", value)}
          />
          <EditField
            label="Quiet hours end (HH:MM)"
            value={prefs.fields["quietEnd"] || "07:00"}
            onChange={(value) => preferences.setField("quietEnd", value)}
          />
        </div>
        <ToggleRow
          label="Alert when a task finishes"
          on={isOn("notifyTaskDone")}
          onToggle={() => flip("notifyTaskDone")}
        />
        <ToggleRow
          label="Alert when a task fails or needs approval"
          on={isOn("notifyTaskFail")}
          onToggle={() => flip("notifyTaskFail")}
        />
        <ToggleRow
          label="Alert on updates, downloads and installs"
          on={isOn("notifyUpdates")}
          onToggle={() => flip("notifyUpdates")}
        />
        <ToggleRow
          label="Alert on health / doctor warnings"
          on={isOn("notifyHealth")}
          onToggle={() => flip("notifyHealth")}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              notifications.push({
                id: `settings-test-${Date.now()}`,
                level: "info",
                title: "Notification test",
                detail: "This alert came from Settings → Notifications.",
                source: "settings",
                route: "/settings",
              });
              if (state.enabled) toast.success("Test notification sent to the hub");
              else toast.warning("Recording is off — turn it on to receive alerts");
            }}
          >
            <Bell className="size-4" /> Send test alert
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void requestDesktopNotificationPermission().then((permission) => {
                toast.info(`Desktop notification permission: ${permission}`);
              });
            }}
          >
            Allow desktop toasts
          </Button>
          {!state.enabled ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <BellOff className="size-3" /> new alerts are not being recorded
            </span>
          ) : null}
        </div>
      </HudPanel>

      <HudPanel title="Recent Alerts" hint="live from the notification hub">
        <ul className="space-y-2">
          {state.items.slice(0, 10).map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border/60 pb-2 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{item.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {item.source} · {formatOwnerDate(item.at)} · {item.detail}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill
                  label={item.level}
                  tone={
                    item.level === "error"
                      ? "destructive"
                      : item.level === "warn"
                        ? "warning"
                        : item.level === "success"
                          ? "accent"
                          : "primary"
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => notifications.dismiss(item.id)}
                >
                  dismiss
                </Button>
              </div>
            </li>
          ))}
          {!state.items.length ? (
            <li className="text-[11px] text-muted-foreground">nothing recorded yet</li>
          ) : null}
        </ul>
      </HudPanel>
    </div>
  );
}
