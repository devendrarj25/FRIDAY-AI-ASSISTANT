/**
 * FRIDAY · desktop companion — settings panel.
 *
 * Everything here is live: each control writes straight through the character
 * IPC bridge to the real overlay window, and the health readout is the actual
 * asset/GPU probe reported by electron/character/runtime.cjs. In the browser
 * preview (no bridge) the panel explains that the companion is desktop-only
 * instead of pretending to work.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RotateCw, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill, ToggleRow, toneForStatus } from "@/components/friday/ui";
import { Slider } from "@/components/ui/slider";
import { Link } from "@tanstack/react-router";
import { characterBridge } from "@/lib/friday/character/bridge";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import type {
  CharacterHealth,
  CharacterPlacement,
  CharacterSettings,
} from "@/lib/friday/character/types";
import { cn } from "@/lib/utils";

const PLACEMENTS: { id: CharacterPlacement; label: string }[] = [
  { id: "free", label: "Free (drag)" },
  { id: "corner", label: "Screen corner" },
  { id: "active-window", label: "Follow active window" },
  { id: "title-bar", label: "On FRIDAY title bar" },
  { id: "mouse", label: "Near mouse" },
];

const CORNERS: CharacterSettings["corner"][] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];

const QUALITIES: CharacterSettings["quality"][] = ["high", "balanced", "battery"];

export function CompanionSettings() {
  const bridge = characterBridge();
  const [settings, setSettings] = useState<CharacterSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ lastError: string | null; recovered: number } | null>(
    null,
  );
  const [trackerSupported, setTrackerSupported] = useState(false);
  const [health, setHealth] = useState<CharacterHealth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const voicePrefs = usePreferences();

  const loadHealth = useCallback(async () => {
    if (!bridge) return;
    try {
      setHealth(await bridge.characterHealth());
    } catch {
      /* the runtime reports its own errors through health components */
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void (async () => {
      try {
        const payload = await bridge.characterGet();
        if (!alive) return;
        setSettings(payload.settings);
        setRunning(payload.running);
        setStatus(payload.status);
        setTrackerSupported(payload.trackerSupported);
      } catch (error) {
        toast.error(`Companion unavailable — ${String((error as Error).message ?? error)}`);
      }
      await loadHealth();
    })();
    // The overlay reports its own probe a moment after it starts.
    const timer = window.setInterval(() => void loadHealth(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge, loadHealth]);

  const patch = async (next: Partial<CharacterSettings>) => {
    if (!bridge) return;
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));
    try {
      const payload = await bridge.characterSet(next);
      setSettings(payload.settings);
      setRunning(payload.running);
      setStatus(payload.status);
    } catch (error) {
      toast.error(`Could not apply — ${String((error as Error).message ?? error)}`);
    }
  };

  const maintenance = async (
    id: string,
    label: string,
    action: () => Promise<{ ok?: boolean; error?: string; health?: CharacterHealth }>,
  ) => {
    if (busy) return;
    setBusy(id);
    try {
      const result = await action();
      if (result?.health) setHealth(result.health);
      else await loadHealth();
      if (result && result.ok === false)
        toast.error(`${label} failed — ${result.error ?? "unknown"}`);
      else toast.success(`${label} complete`);
    } catch (error) {
      toast.error(`${label} failed — ${String((error as Error).message ?? error)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!bridge) {
    return (
      <HudPanel title="Desktop Companion" hint="desktop only">
        <p className="text-sm text-muted-foreground">
          The 2D companion is a Windows desktop overlay. Open FRIDAY's installed app to enable it —
          it cannot run inside the browser preview.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          The overlay itself renders the{" "}
          <Link to="/character" className="text-primary underline underline-offset-4">
            companion stage
          </Link>
          , which you can open here to preview her look and animations.
        </p>
      </HudPanel>
    );
  }

  if (!settings) {
    return (
      <HudPanel title="Desktop Companion">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading companion state…
        </p>
      </HudPanel>
    );
  }

  return (
    <div className="space-y-4">
      <HudPanel
        title="Desktop Companion"
        hint={running ? "overlay running" : "overlay stopped"}
        actions={
          <div className="flex items-center gap-2">
            <StatusPill
              label={running ? "LIVE" : settings.enabled ? "STARTING" : "OFF"}
              tone={running ? "accent" : settings.enabled ? "warning" : "muted"}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void maintenance("restart", "Restart", async () => {
                  await bridge.characterRestart();
                  return { ok: true };
                })
              }
              disabled={busy !== null || !settings.enabled}
            >
              <RotateCw className="size-4" /> Restart
            </Button>
          </div>
        }
      >
        <ToggleRow
          label="Enable the 2D companion"
          hint="a transparent, always-on-top character driven by real FRIDAY state"
          on={settings.enabled}
          onToggle={() => {
            const next = !settings.enabled;
            void (next ? bridge.characterStart() : bridge.characterStop()).then(() => {
              setSettings((prev) => (prev ? { ...prev, enabled: next } : prev));
              setRunning(next);
              void loadHealth();
            });
          }}
        />
        <ToggleRow
          label="Start with FRIDAY"
          hint="show the companion as soon as the app boots"
          on={settings.autoStart}
          onToggle={() => void patch({ autoStart: !settings.autoStart })}
        />
        <ToggleRow
          label="Always on top"
          on={settings.alwaysOnTop}
          onToggle={() => void patch({ alwaysOnTop: !settings.alwaysOnTop })}
        />
        <ToggleRow
          label="Click-through when idle"
          hint="mouse events pass to the app underneath until you hover the character"
          on={settings.clickThrough}
          onToggle={() => void patch({ clickThrough: !settings.clickThrough })}
        />
        <ToggleRow
          label="Eye + head gaze tracking"
          hint={
            trackerSupported
              ? "follows the real cursor"
              : "cursor tracking unavailable on this system"
          }
          on={settings.gaze}
          onToggle={() => void patch({ gaze: !settings.gaze })}
        />
        <ToggleRow
          label="Speech bubble"
          hint="shows the line FRIDAY is actually speaking"
          on={settings.speechBubble}
          onToggle={() => void patch({ speechBubble: !settings.speechBubble })}
        />
        <ToggleRow
          label="Mini chat on the overlay"
          hint="typed there, requests run through the same brain as the main window"
          on={settings.miniChat}
          onToggle={() => void patch({ miniChat: !settings.miniChat })}
        />
        <ToggleRow
          label="Speak replies in Auto mode"
          hint="Manual and chat stay silent"
          on={voicePrefs.voice.speakReplies}
          onToggle={() => {
            const next = !voicePrefs.voice.speakReplies;
            preferences.setVoice({ speakReplies: next });
            void patch({ voiceReplies: next });
          }}
        />
        <ToggleRow
          label="Reduce motion"
          hint="calmer idle animation, lighter on the GPU"
          on={settings.reduceMotion}
          onToggle={() => void patch({ reduceMotion: !settings.reduceMotion })}
        />
        <ToggleRow
          label="Hide over fullscreen apps"
          on={settings.hideOnFullscreen}
          onToggle={() => void patch({ hideOnFullscreen: !settings.hideOnFullscreen })}
        />
        <ToggleRow
          label="Hide when FRIDAY is idle"
          on={settings.hideWhenIdle}
          onToggle={() => void patch({ hideWhenIdle: !settings.hideWhenIdle })}
        />
        <ToggleRow
          label="Greet on start"
          on={settings.greeting}
          onToggle={() => void patch({ greeting: !settings.greeting })}
        />

        {status?.lastError ? (
          <p className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive">
            {status.lastError}
            {status.recovered ? ` · recovered ${status.recovered}×` : ""}
          </p>
        ) : null}
      </HudPanel>

      <HudPanel title="Placement & Rendering">
        <p className="label-xs text-muted-foreground">Placement</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {PLACEMENTS.map((p) => (
            <Chip
              key={p.id}
              label={p.label}
              active={settings.placement === p.id}
              onClick={() => void patch({ placement: p.id })}
            />
          ))}
        </div>

        {settings.placement === "corner" ? (
          <>
            <p className="label-xs mt-3 text-muted-foreground">Corner</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {CORNERS.map((c) => (
                <Chip
                  key={c}
                  label={c.replace("-", " ")}
                  active={settings.corner === c}
                  onClick={() => void patch({ corner: c })}
                />
              ))}
            </div>
          </>
        ) : null}

        <p className="label-xs mt-3 text-muted-foreground">Quality</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {QUALITIES.map((q) => (
            <Chip
              key={q}
              label={q}
              active={settings.quality === q}
              onClick={() => void patch({ quality: q })}
            />
          ))}
        </div>

        <div className="mt-4 space-y-3">
          <SliderRow
            label="Size"
            detail={`${settings.width} px`}
            value={settings.width}
            min={120}
            max={520}
            step={10}
            onChange={(v) => void patch({ width: v })}
          />
          <SliderRow
            label="Opacity"
            detail={`${Math.round(settings.opacity * 100)}%`}
            value={Math.round(settings.opacity * 100)}
            min={20}
            max={100}
            step={5}
            onChange={(v) => void patch({ opacity: v / 100 })}
          />
          <SliderRow
            label="Follow speed"
            detail={settings.followSpeed.toFixed(2)}
            value={Math.round(settings.followSpeed * 100)}
            min={5}
            max={100}
            step={5}
            onChange={(v) => void patch({ followSpeed: v / 100 })}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void bridge.characterResetPosition()}>
            Reset position
          </Button>
        </div>
      </HudPanel>

      <HudPanel
        title="Companion Assets & Health"
        hint={health ? `asset ${health.assetVersion}` : "probing"}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void maintenance("install", "Install", () => bridge.characterInstall())
              }
              disabled={busy !== null}
            >
              {busy === "install" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Install
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void maintenance("repair", "Repair", () => bridge.characterRepair())}
              disabled={busy !== null}
            >
              {busy === "repair" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Wrench className="size-4" />
              )}
              Repair
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void maintenance("update", "Update", () => bridge.characterUpdate())}
              disabled={busy !== null}
            >
              {busy === "update" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Update
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void maintenance("remove", "Remove", () => bridge.characterRemove())}
              disabled={busy !== null}
            >
              {busy === "remove" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Remove
            </Button>
          </div>
        }
      >
        {health ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Fact k="Installed" v={health.installedVersion ?? "not installed"} />
              <Fact k="Up to date" v={health.outdated ? "update available" : "yes"} />
              <Fact k="GPU acceleration" v={health.gpu.accelerated ? "on" : "software"} />
              <Fact k="WebGL2" v={health.gpu.webgl2 || "unknown"} />
              <Fact
                k="Last probe"
                v={
                  health.probe
                    ? `${health.probe.fps} fps · ${health.probe.frameMs.toFixed(1)} ms · ${health.probe.api}`
                    : "waiting for overlay"
                }
              />
              <Fact k="Assets folder" v={health.root ?? "—"} />
            </div>
            <div className="space-y-1.5">
              {health.components.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{c.label}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {c.detail || c.location}
                    </p>
                  </div>
                  <StatusPill label={c.status.toUpperCase()} tone={toneForStatus(c.status)} />
                </div>
              ))}
            </div>
            {health.probe?.error ? (
              <p className="font-mono text-[11px] text-destructive">{health.probe.error}</p>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading companion health…
          </p>
        )}
      </HudPanel>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm border px-2.5 py-1 font-mono text-[11px] capitalize transition-colors",
        active
          ? "border-primary/50 bg-primary/12 text-primary"
          : "border-primary/20 text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function SliderRow({
  label,
  detail,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  detail: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="label-xs text-muted-foreground">{label}</p>
        <span className="font-mono text-[11px] text-primary">{detail}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Number(next[0] ?? value))}
      />
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{k}</p>
      <div className="hud-tile mt-1 truncate rounded-sm px-2.5 py-1.5 font-mono text-xs text-foreground">
        {v}
      </div>
    </div>
  );
}
