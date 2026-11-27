import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HardDriveDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { desktopApi, type CoreStatus } from "@/lib/friday/desktop";
import { useLivePoll } from "@/lib/friday/use-live-poll";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";

/**
 * Brain settings: the FRIDAY Core switch (off by default; the stored choice is honoured by the desktop app).
 * The variant line comes from the read-only `brainCoreStatus` bridge call (never a key, port or endpoint). It is read
 * on the shared poller while this panel is open and again when the switch changes. Install opens the Install Manager.
 */
export function BrainSettings() {
  const navigate = useNavigate();
  const prefs = usePreferences();
  const on = prefs.toggles["brainCoreEnabled"] === true;
  const desktop = desktopApi() !== null;
  const [status, setStatus] = useState<CoreStatus | null>(null);

  const { error, refresh } = useLivePoll(
    "brain.core-status",
    async () => {
      const read = desktopApi()?.brainCoreStatus;
      if (!read) throw new Error("Core status is not available in this build");
      setStatus(await read());
    },
    8_000,
    desktop,
  );
  useEffect(() => {
    if (desktop) void refresh();
  }, [on, desktop, refresh]);

  let line: string;
  if (!desktop)
    line = "Offline: open the FRIDAY desktop app to apply this switch and see Core status.";
  else if (error && !status) line = `Core status could not be read: ${error}`;
  else if (!status) line = "Reading Core status…";
  else if (!status.installed)
    line = "Not installed yet. Until Core is installed, FRIDAY keeps using her current brain.";
  else {
    const name = status.fridayName || "FRIDAY Core";
    const variant = status.variant ? ` (${status.variant})` : "";
    line = status.ready
      ? `${name}${variant}: running and ready`
      : status.running
        ? `${name}${variant}: starting`
        : `${name}${variant}: installed, ${on ? "starting soon" : "off"}`;
  }

  return (
    <HudPanel title="Brain">
      <ToggleRow
        label="FRIDAY Core (local brain engine)"
        hint="Off by default"
        on={on}
        onToggle={() => preferences.setToggle("brainCoreEnabled", !on)}
      />
      <p className="mt-2 text-note text-muted-foreground">{line}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => navigate({ to: "/install-manager" })}>
          <HardDriveDownload className="size-4" /> Install FRIDAY Core →
        </Button>
        {desktop && error ? (
          <Button size="sm" variant="outline" onClick={() => refresh()}>
            Retry
          </Button>
        ) : null}
      </div>
    </HudPanel>
  );
}
