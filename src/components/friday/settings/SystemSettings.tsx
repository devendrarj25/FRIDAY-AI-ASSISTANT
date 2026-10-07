import { useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Activity, FolderOpen, Gauge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { HudPanel, MetricBar, StatusPill, ToggleRow } from "@/components/friday/ui";
import { useLiveMetrics, useSystemSample } from "@/lib/friday/use-live-metrics";
import { useNetwork } from "@/lib/friday/use-network";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { desktopApi, revealWorkspaceFolder } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import {
  SENSE_IDS,
  SENSE_LABEL,
  SENSE_TOGGLE,
  approvedFolderList,
  isSenseId,
  senseHint,
  stopAllPatch,
  switchesFromToggles,
  watchingLine,
} from "@/lib/friday/senses";
import { usePreferences } from "@/lib/friday/use-preferences";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { cameraSnapshot, setCameraEnabled } from "@/lib/friday/camera-awareness";
import {
  controlNotes,
  controlRows,
  panicPlan,
  subscribeControl,
} from "@/lib/friday/control-center";
import { setScreenVision, screenVisionSnapshot } from "@/lib/friday/screen-awareness";
import { autonomy } from "@/lib/friday/self/autonomy";
import { useAutonomy, useLedger } from "@/lib/friday/self/use-self";
import { useAppVersion } from "@/lib/friday/version";
import { models } from "@/lib/friday/models-engine";

/**
 * Performance & system panel. Every number is a real reading — CPU/RAM/GPU from
 * the main-process sampler, throughput from the measured network probe, kernel
 * facts from the running Python kernel.
 */
export function SystemSettings() {
  const navigate = useNavigate();
  const metrics = useLiveMetrics();
  const sample = useSystemSample();
  const net = useNetwork();
  const kernel = useKernelStatus();
  const version = useAppVersion();
  const prefs = usePreferences();
  const dial = useAutonomy();
  const voice = useSyncExternalStore(
    assistantMode.subscribe,
    assistantMode.getSnapshot,
    assistantMode.getSnapshot,
  );
  const noted = useSyncExternalStore(subscribeControl, controlNotes, controlNotes);
  const ledger = useLedger();
  const latest = ledger.tasks.reduce<(typeof ledger.tasks)[number] | null>(
    (best, task) => (!best || task.startedAt > best.startedAt ? task : best),
    null,
  );
  const rows = controlRows({
    toggles: prefs.toggles,
    halted: dial.halted,
    level: dial.approvalLevel,
    listening: voice.mode === "auto" && voice.listening,
    handsFree: voice.handsFree,
    screenOn: screenVisionSnapshot().enabled,
    cameraOn: cameraSnapshot().enabled,
    consent: false,
    lastEventAt: noted.senseAt,
    lastReceipt: latest?.title ?? noted.receipt,
  });
  const stopRow = (id: string) => {
    if (id.startsWith("sense:")) {
      const sense = id.slice("sense:".length);
      if (isSenseId(sense)) preferences.setToggle(SENSE_TOGGLE[sense], false);
      return;
    }
    if (id === "listener:mic") {
      assistantMode.setMode("manual");
      return;
    }
    if (id === "listener:hands-free") {
      assistantMode.setHandsFree(false);
      return;
    }
    if (id === "recorder:screen") {
      void setScreenVision({ enabled: false });
      return;
    }
    if (id === "recorder:camera") {
      void setCameraEnabled(false);
      return;
    }
    if (id === "autonomy:dial") autonomy.stopEverything();
  };
  const panic = () => {
    const plan = panicPlan();
    autonomy.stopEverything();
    preferences.update({ toggles: plan.toggles });
    assistantMode.setHandsFree(false);
    assistantMode.setMode("manual");
    void setScreenVision({ enabled: false });
    void setCameraEnabled(false);
    toast.success("Stopped. Senses are off.");
  };

  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const num = (k: string, fallback: number) => Number(prefs.fields[k] ?? String(fallback));

  return (
    <div className="space-y-4">
      <HudPanel
        title="Live System"
        hint={metrics.live ? "measured on this machine" : "desktop app only"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={metrics.uptime} tone="accent" />
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/system" })}>
              Open Hardware →
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <MetricBar
            label={metrics.cpu.label}
            value={metrics.cpu.value}
            detail={metrics.cpu.detail}
          />
          <MetricBar
            label={metrics.ram.label}
            value={metrics.ram.value}
            detail={metrics.ram.detail}
            tone="accent"
          />
          <MetricBar
            label={metrics.gpu.label}
            value={metrics.gpu.value}
            detail={metrics.gpu.detail}
            tone="magenta"
          />
          <MetricBar
            label={metrics.vram.label}
            value={metrics.vram.value}
            detail={metrics.vram.detail}
            tone="warning"
          />
        </div>
        <dl className="mt-4 space-y-1 font-mono text-[11px] text-muted-foreground">
          <Row k="cpu" v={sample ? `${sample.cpu.model} · ${sample.cpu.cores} cores` : "—"} />
          <Row k="gpu" v={sample?.gpu.name ?? sample?.gpu.reason ?? "—"} />
          <Row
            k="network"
            v={
              net.online
                ? `${net.downMbps > 0 ? `${net.downMbps.toFixed(1)} Mbps` : "measuring"} · ${net.latencyMs >= 0 ? `${net.latencyMs} ms` : "—"} (${net.source})`
                : "offline"
            }
          />
          {/* Why the OS adapter counters are missing — a real reason, never silence. */}
          {net.machineDetail ? <Row k="machine counters" v={net.machineDetail} /> : null}
          {sample?.network && !sample.network.available && sample.network.reason ? (
            <Row k="adapter probe" v={sample.network.reason} />
          ) : null}

          <Row k="kernel" v={`${kernel.host} · ${kernel.version}`} />
          <Row k="app" v={`${version.label} · build ${version.build}`} />
        </dl>
      </HudPanel>

      <HudPanel
        title="What FRIDAY is watching"
        hint={watchingLine(switchesFromToggles(prefs.toggles))}
      >
        {SENSE_IDS.map((id) => (
          <ToggleRow
            key={id}
            label={SENSE_LABEL[id]}
            hint={senseHint(id)}
            on={prefs.toggles[SENSE_TOGGLE[id]] === true}
            onToggle={() =>
              preferences.setToggle(SENSE_TOGGLE[id], prefs.toggles[SENSE_TOGGLE[id]] !== true)
            }
          />
        ))}
        <label className="mt-3 block font-mono text-[11px] text-muted-foreground">
          Approved folders ({approvedFolderList(prefs.fields["senseFolders"]).length})
          <input
            value={prefs.fields["senseFolders"] ?? ""}
            onChange={(event) => preferences.setField("senseFolders", event.target.value)}
            placeholder="notes, Downloads"
            className="mt-1 h-8 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs text-foreground"
          />
        </label>
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => preferences.update({ toggles: stopAllPatch() })}
          >
            Stop all watching
          </Button>
        </div>
      </HudPanel>

      <HudPanel title="Owner control" hint="Each sense, listener, and recorder, with a stop">
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{row.label}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {row.on ? "ON" : "OFF"} · {row.detail}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!row.on}
                onClick={() => stopRow(row.id)}
              >
                Stop
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={panic}>
            Panic
          </Button>
        </div>
      </HudPanel>

      <HudPanel title="Performance">
        <ToggleRow
          label="GPU-accelerated rendering"
          on={isOn("gpuRender")}
          onToggle={() => flip("gpuRender")}
        />
        <ToggleRow
          label="Skip heavy self-improvement when FRIDAY is unfocused or fullscreen"
          on={isOn("throttleFullscreen")}
          onToggle={() => flip("throttleFullscreen")}
        />
        <ToggleRow
          label="Pause heavy autonomy work on battery"
          on={isOn("pauseOnBattery")}
          onToggle={() => flip("pauseOnBattery")}
        />
        <ToggleRow
          label="Keep local models loaded between requests"
          on={isOn("keepModelsWarm")}
          onToggle={() => flip("keepModelsWarm")}
        />
        <ToggleRow
          label="Unload idle models to free VRAM"
          on={isOn("unloadIdleModels")}
          onToggle={() => flip("unloadIdleModels")}
        />
        <Tune
          label="CPU budget for background work"
          field="cpuBudget"
          value={num("cpuBudget", 50)}
          suffix="%"
        />
        <Tune
          label="Idle timeout before models unload"
          field="modelIdleMinutes"
          value={num("modelIdleMinutes", 10)}
          min={1}
          max={60}
          suffix=" min"
        />
        <Tune
          label="Telemetry sample interval"
          field="sampleSeconds"
          value={num("sampleSeconds", 2)}
          min={1}
          max={30}
          suffix=" s"
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const api = desktopApi() as { systemMetrics?: () => Promise<unknown> } | null;
              if (!api?.systemMetrics) {
                toast.error("Live sampling runs in the FRIDAY desktop app");
                return;
              }
              void api.systemMetrics().then(() => toast.success("Telemetry refreshed"));
            }}
          >
            <RefreshCw className="size-4" /> Refresh telemetry
          </Button>
          <Button size="sm" variant="outline" onClick={() => revealWorkspaceFolder("logs")}>
            <FolderOpen className="size-4" /> Open logs folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void preferences.flush().then(() => toast.success("Performance settings saved"));
            }}
          >
            <Gauge className="size-4" /> Save performance settings
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const running = Object.values(models.getSnapshot().runtimes).filter(
                (rt) => rt.state === "Running" || rt.state === "Loading",
              );
              if (!running.length) {
                toast.info("No local models are loaded");
                return;
              }
              running.forEach((rt) => models.unload(rt.modelId));
              toast.success(`Unloaded ${running.length} model(s)`);
            }}
          >
            Unload loaded models
          </Button>
        </div>
      </HudPanel>

      <HudPanel title="Storage" hint="real volumes on this machine">
        {sample?.disks.length ? (
          <div className="space-y-2">
            {sample.disks.map((disk) => (
              <MetricBar
                key={disk.id}
                label={`Volume ${disk.id}`}
                value={Math.round(disk.percent)}
                detail={`${disk.freeGb.toFixed(0)} GB free of ${disk.totalGb.toFixed(0)} GB`}
              />
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            <Activity className="mr-1 inline size-3" />
            Volume readings are reported by the FRIDAY desktop app.
          </p>
        )}
      </HudPanel>
    </div>
  );
}

function Tune({
  label,
  field,
  value,
  min = 0,
  max = 100,
  suffix,
}: {
  label: string;
  field: string;
  value: number;
  min?: number;
  max?: number;
  suffix: string;
}) {
  return (
    <div className="mt-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="label-xs text-muted-foreground">{label}</p>
        <span className="font-mono text-[11px] text-primary">
          {value}
          {suffix}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={(next) => preferences.setField(field, String(next[0] ?? value))}
        onValueCommit={() => void preferences.flush()}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt>{k}</dt>
      <dd className="truncate text-foreground">{v}</dd>
    </div>
  );
}
