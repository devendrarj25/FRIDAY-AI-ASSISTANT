import { useNavigate } from "@tanstack/react-router";
import { HardDriveDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { desktopApi } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";

/**
 * Brain settings: the FRIDAY Core switch (off by default; the stored choice is honoured by the desktop app).
 * No bridge call exposes the Core variant or its install status yet, so this panel says so plainly instead of
 * inventing a state. The Install button opens the existing Install Manager.
 */
export function BrainSettings() {
  const navigate = useNavigate();
  const prefs = usePreferences();
  const on = prefs.toggles["brainCoreEnabled"] === true;
  const desktop = desktopApi() !== null;

  return (
    <HudPanel title="Brain">
      <ToggleRow
        label="FRIDAY Core (local brain engine)"
        hint="Off by default"
        on={on}
        onToggle={() => preferences.setToggle("brainCoreEnabled", !on)}
      />
      <p className="mt-2 text-note text-muted-foreground">
        {desktop
          ? "Variant and install status show after the next update. Until Core is installed, FRIDAY keeps using her current brain."
          : "Offline: open the FRIDAY desktop app to apply this switch and see Core status."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => navigate({ to: "/install-manager" })}>
          <HardDriveDownload className="size-4" /> Install FRIDAY Core →
        </Button>
      </div>
    </HudPanel>
  );
}
