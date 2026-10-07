import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { Row } from "@/components/friday/settings/fields";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { desktopApi, revealWorkspaceFolder, useWorkspaceRootState } from "@/lib/friday/desktop";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { useAppVersion } from "@/lib/friday/version";
import { doctor } from "@/lib/friday/doctor-engine";
import { attentionWindowSeconds, clampAttentionSeconds } from "@/lib/friday/attention-window";

type AdvancedBridge = {
  confirmRestart?: (message: string) => Promise<unknown>;
  quitApp?: () => Promise<boolean>;
  openDevTools?: () => Promise<boolean>;
  setAlwaysOnTop?: (enabled: boolean) => Promise<boolean>;
};

export function AdvancedSettings() {
  const prefs = usePreferences();
  const kernelStatus = useKernelStatus();
  const workspaceRoot = useWorkspaceRootState();
  const appVersion = useAppVersion();
  const [busy, setBusy] = useState<string | null>(null);
  const isOn = (k: string) => prefs.toggles[k] === true;

  const run = async (id: string, label: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(`${label} failed — ${String((error as Error).message ?? error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <HudPanel title="Advanced">
      <dl className="space-y-2 font-mono text-[11px] text-muted-foreground">
        <Row k="kernel host" v={kernelStatus.host} />
        <Row k="kernel version" v={kernelStatus.version} />
        <Row k="gpu" v={kernelStatus.gpu} />
        <Row k="data dir" v={kernelStatus.dataDir} />
        <Row k="app version" v={appVersion.label} />
        <Row k="build" v={appVersion.build} />
      </dl>
      <div className="mt-4 space-y-2">
        <label className="label-xs text-muted-foreground" htmlFor="workspace">
          Workspace root
        </label>
        <Input
          id="workspace"
          readOnly
          value={workspaceRoot || "unknown"}
          className="border-primary/25 bg-surface font-mono text-xs"
        />
      </div>
      <div className="mt-4 space-y-1">
        <div className="flex items-center justify-between">
          <p className="label-xs text-muted-foreground">Voice attention window</p>
          <span className="font-mono text-[11px] text-primary">{attentionWindowSeconds()} s</span>
        </div>
        <Slider
          min={10}
          max={300}
          step={5}
          value={[attentionWindowSeconds()]}
          onValueChange={(next) =>
            preferences.setField(
              "attentionWindow",
              String(clampAttentionSeconds(Number(next[0] ?? 45))),
            )
          }
          onValueCommit={() => void preferences.flush()}
        />
      </div>
      <ToggleRow
        label="Keep the main window always on top"
        on={isOn("alwaysOnTop")}
        onToggle={() => {
          const next = !isOn("alwaysOnTop");
          preferences.setToggle("alwaysOnTop", next);
          const api = desktopApi() as AdvancedBridge | null;
          void api?.setAlwaysOnTop?.(next);
        }}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.dispatchEvent(new Event("friday.session-lock"))}
        >
          Lock now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy === "kernel"}
          onClick={() => {
            void run("kernel", "Restart kernel", async () => {
              const api = desktopApi() as AdvancedBridge | null;
              if (!api?.confirmRestart) {
                toast.error("The kernel only runs in the desktop app");
                return;
              }
              await api.confirmRestart("Restart FRIDAY to reload the local kernel.");
            });
          }}
        >
          Restart kernel
        </Button>
        <Button size="sm" variant="outline" onClick={() => revealWorkspaceFolder("data")}>
          Open data folder
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy === "diagnostics"}
          onClick={() => {
            void run("diagnostics", "Export diagnostics", async () => {
              const file = await doctor.exportReport();
              toast.success(file ? `Diagnostics written to ${file}` : "Diagnostics exported");
            });
          }}
        >
          Export diagnostics
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const blob = new Blob([preferences.exportJson()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `friday-preferences-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Preferences exported");
          }}
        >
          Export settings JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const api = desktopApi() as AdvancedBridge | null;
            if (!api?.openDevTools) {
              toast.error("Developer tools open in the FRIDAY desktop app");
              return;
            }
            void api.openDevTools();
          }}
        >
          Open developer tools
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (
              !window.confirm(
                "Reset every Settings preference to shipped defaults? Memory, models and credentials stay.",
              )
            ) {
              return;
            }
            preferences.reset();
            toast.success("Settings restored to shipped defaults");
          }}
        >
          Reset all settings
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const api = desktopApi() as AdvancedBridge | null;
            if (!api?.quitApp) {
              toast.error("Quitting is only available in the desktop app");
              return;
            }
            if (
              window.confirm(
                "Quit FRIDAY completely? The wake word and background work will stop until you start her again.",
              )
            ) {
              void api.quitApp();
            }
          }}
        >
          Quit FRIDAY
        </Button>
      </div>
    </HudPanel>
  );
}
