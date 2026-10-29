import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HudPanel } from "@/components/friday/ui";
import { usePreferences } from "@/lib/friday/use-preferences";
import { prefNumber, prefOn } from "@/lib/friday/settings-runtime";

/**
 * Idle lock overlay. Covers the console after Settings → Security session
 * timeout, or immediately from Lock now. Unlock is a click — this is a privacy
 * cover, not a password vault.
 */
export function SessionLock() {
  const prefs = usePreferences();
  const enabled = prefOn("autoLock", false);
  const timeoutMs = prefNumber("sessionTimeout", 30, 1, 240) * 60_000;
  const [locked, setLocked] = useState(false);
  const [lockedBy, setLockedBy] = useState<"idle" | "now">("idle");

  useEffect(() => {
    const onLock = () => {
      setLockedBy("now");
      setLocked(true);
    };
    window.addEventListener("friday.session-lock", onLock);
    return () => window.removeEventListener("friday.session-lock", onLock);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const onVis = () => {
      if (document.hidden) return;
      last = Date.now();
    };
    window.addEventListener("pointerdown", bump, true);
    window.addEventListener("keydown", bump, true);
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(() => {
      if (Date.now() - last >= timeoutMs) {
        setLockedBy("idle");
        setLocked(true);
      }
    }, 5000);
    return () => {
      window.removeEventListener("pointerdown", bump, true);
      window.removeEventListener("keydown", bump, true);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [enabled, timeoutMs, prefs.toggles, prefs.fields]);

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/92 p-6">
      <HudPanel
        title="FRIDAY is locked"
        hint={lockedBy === "now" ? "locked now" : "session idle timeout"}
      >
        <p className="text-sm text-muted-foreground">
          The console is covered. Unlock to continue. This is not a password gate — secrets stay in
          the encrypted store either way.
        </p>
        <Button size="sm" className="mt-4" onClick={() => setLocked(false)}>
          Unlock
        </Button>
      </HudPanel>
    </div>
  );
}
