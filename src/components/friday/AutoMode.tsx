import {
  Activity,
  ArrowDown,
  Check,
  Copy,
  Ear,
  Eraser,
  Hand,
  ListTree,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Trash2,
  Volume2,
  VolumeX,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { NeuralCircuit } from "@/components/friday/NeuralCircuit";
import { ageOf, type LiveComponent } from "@/lib/friday/use-friday-live";
import { assistantMode, type AssistantModeState } from "@/lib/friday/assistant-mode";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { useBrain } from "@/lib/friday/use-brain";
import { useFridayLive } from "@/lib/friday/use-friday-live";
import { usePreferences } from "@/lib/friday/use-preferences";
import { cn } from "@/lib/utils";
import { AutonomyDial } from "@/components/friday/AutonomyDial";
import { rememberRun, voiceAutoGraph } from "@/lib/friday/flow-modes";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import { preferences } from "@/lib/friday/preferences";
import { autonomy } from "@/lib/friday/self/autonomy";
import { copyText } from "@/lib/friday/clipboard";
import {
  isTypingTarget,
  levelForKey,
  useMeasuredWidth,
  useVoiceLevel,
  voiceBarFit,
  voiceDisplayLevel,
  voiceLevel,
  type ChatLevel,
} from "@/lib/friday/chat-level";
import { VoiceDiagnostics } from "@/components/friday/VoiceDiagnostics";
import {
  HudButton,
  HudDivider,
  HudGroup,
  VoiceLevelSwitch,
  VoiceTools,
  type VoiceTool,
} from "@/components/friday/VoiceControlBar";
import { ConfirmationCard, VoiceTranscript } from "@/components/friday/VoiceTranscript";

/**
 * Auto Mode main screen.
 *
 * The stage is the *same* live neural graphic Manual mode uses — same boxes,
 * same neon wires, same real event source — just rendered larger. Voice state
 * sits above it in one control bar (Listen, Speak, Safety, Tools), and
 * everything FRIDAY says or needs to show lands in the caption box below.
 *
 * Three levels (chat-level.ts, saved under friday.voice.level.v1): Compact
 * shows the last two caption lines, Expanded the whole caption box (FRIDAY
 * can lift Compact to Expanded for code or long text), and Transcript drops
 * the graphic for a centred conversation. The microphone chip and Stop
 * everything are on the bar at every level.
 */

function selectCircuitNode(node: LiveComponent) {
  assistantMode.show({
    kind: "list",
    title: `${node.label} · ${node.state}`,
    items: [
      node.active ? (node.action ?? node.status) : node.status,
      ...node.details.map((detail) => `${detail.k}: ${detail.v}`),
      node.active
        ? "last activity: now"
        : node.activeAt
          ? `last activity: ${ageOf(node.activeAt, Date.now()) ?? "now"}`
          : "",
    ].filter(Boolean),
  });
}

/** A caption-strip button; `pressed` marks an open panel. */
function StripButton({
  icon: Icon,
  label,
  title,
  pressed,
  tone,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  pressed?: boolean;
  tone?: "warning" | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={pressed}
      className={cn(
        "inline-flex items-center gap-1 rounded-ctl px-1.5 py-0.5 transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 active:bg-primary/15",
        pressed && "bg-primary/10 text-primary",
        tone === "warning" && "text-warning",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/** Live voice pipeline trace: mic → segment → transcript → wake word. */
function VoicePipelineLog({ voice }: { voice: AssistantModeState }) {
  if (!voice.voiceLog.length) {
    return (
      <p className="text-meta-sm text-muted-foreground">
        No pipeline step yet. Speak in Auto mode and each step shows here.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {voice.voiceLog
        .slice(-30)
        .reverse()
        .map((entry, index) => (
          <li key={`${entry.at}-${entry.stage}-${index}`} className="flex gap-2">
            <span
              className={cn(
                "w-20 shrink-0 text-meta-sm uppercase",
                entry.stage === "error" || entry.stage === "dropped"
                  ? "text-destructive"
                  : entry.stage === "transcript"
                    ? "text-accent"
                    : "text-muted-foreground",
              )}
            >
              {entry.stage}
            </span>
            <span className="min-w-0 break-words text-meta-sm text-muted-foreground">
              {entry.detail}
              {entry.repeat && entry.repeat > 1 ? ` x${entry.repeat}` : ""}
            </span>
          </li>
        ))}
    </ul>
  );
}

type CaptionPanel = "diagnostics" | "pipeline" | null;

/** Words for the mic chip's accessible name: what the microphone is doing. */
function micState(voice: AssistantModeState): string {
  if (voice.error) return "error";
  if (voice.paused) return "paused";
  if (voice.listening) return "listening";
  return "off";
}

export function AutoMode() {
  const voice = useAssistantMode();
  const brainState = useBrain();
  const live = useFridayLive();
  const prefs = usePreferences();
  // No router in a static render; Voice settings then simply does nothing.
  const router = useRouter({ warn: false });
  const saved = useVoiceLevel();
  const level = voiceDisplayLevel(saved, voice.expanded);
  const full = level === 3;
  const scroller = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const barWidth = useMeasuredWidth(barRef);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Diagnostics and the pipeline open beside the captions, never inside them.
  const [panel, setPanel] = useState<CaptionPanel>(null);
  const togglePanel = (next: Exclude<CaptionPanel, null>) =>
    setPanel((open) => (open === next ? null : next));

  // Only the last couple of exchanges at Compact; full history otherwise.
  const tall = level >= 2 || panel !== null;
  const visible = tall ? voice.captions : voice.captions.slice(-2);
  const working = live.components.some((c) => c.active);
  // No layout animation while speech streams in or out.
  const streaming = Boolean(voice.interim) || voice.speaking;

  useEffect(() => {
    if (!follow) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [voice.captions, voice.interim, voice.display, voice.pending, level, tall, follow]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const run = brainState.runs.find((r) => r.id === brainState.activeRunId);
  const stage = run?.stages.find((s) => s.state === "running");

  /** The owner's pick is saved; Compact and Expanded also drive `expanded`. */
  const selectLevel = (next: ChatLevel) => {
    voiceLevel.set(next);
    if (next !== 3) assistantMode.setExpanded(next === 2);
  };

  const copyTranscript = () => {
    const text = assistantMode.transcript();
    if (!text) return;
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1200);
    });
  };

  const openVoiceFlow = () => {
    const prefsNow = preferences.getSnapshot();
    const dial = autonomy.getSnapshot();
    const graph = rememberRun(
      voiceAutoGraph({
        voiceState: voice.voiceState,
        error: voice.error,
        paused: voice.paused,
        wakeWord: prefsNow.voice.wakeWord,
        lastWake: voice.lastWake?.detail || "",
        approvalLevel: dial.approvalLevel,
        halted: dial.halted,
        attentionWindow: prefsNow.fields["attentionWindow"] || "",
        stt: voice.stt,
        tts: voice.tts,
      }),
    );
    const live =
      voice.mode === "auto" &&
      voice.voiceState !== "OFF" &&
      voice.voiceState !== "ERROR" &&
      voice.voiceState !== "PAUSED";
    flowStudio.openBoard(graph, live ? "watch" : "chart");
  };

  const openVoiceSettings = () => {
    void router?.navigate({ to: "/settings", search: { section: "voice" } as never });
  };

  // Secondary tools, in the order they move into More on a narrow bar.
  const tools: VoiceTool[] = [
    {
      id: "flow",
      label: "Voice flow",
      icon: Workflow,
      onSelect: openVoiceFlow,
      render: () => (
        <HudButton
          icon={Workflow}
          title="Open this voice session as a live flow"
          label="Voice flow"
          onClick={openVoiceFlow}
        />
      ),
    },
    {
      id: "settings",
      label: "Voice settings",
      icon: Settings2,
      onSelect: openVoiceSettings,
      render: () => (
        <HudButton
          icon={Settings2}
          title="Open Settings, Voice"
          label="Voice settings"
          onClick={openVoiceSettings}
        />
      ),
    },
    ...(full
      ? [
          {
            id: "diagnostics",
            label: "Diagnostics",
            icon: Activity,
            onSelect: () => togglePanel("diagnostics"),
            render: () => (
              <HudButton
                icon={Activity}
                label="Diagnostics"
                title={
                  panel === "diagnostics" ? "Close voice diagnostics" : "Open voice diagnostics"
                }
                active={panel === "diagnostics"}
                onClick={() => togglePanel("diagnostics")}
              />
            ),
          },
          {
            id: "pipeline",
            label: "Pipeline",
            icon: ListTree,
            onSelect: () => togglePanel("pipeline"),
            render: () => (
              <HudButton
                icon={ListTree}
                label="Pipeline"
                title={
                  panel === "pipeline" ? "Close the voice pipeline" : "Open the voice pipeline"
                }
                active={panel === "pipeline"}
                onClick={() => togglePanel("pipeline")}
              />
            ),
          },
        ]
      : []),
  ];
  const shownTools = voiceBarFit(barWidth, tools.length);

  // The microphone state and Stop everything are on this bar at every level.
  const bar = (
    <div
      ref={barRef}
      className={cn(
        "voice-bar flex max-w-full shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3 text-meta-sm",
        full && "pb-3",
      )}
    >
      <HudGroup label="Listen">
        {/* What the microphone is doing right now. Never hidden, never moved
            into More. */}
        <span
          role="status"
          aria-live="polite"
          aria-label={`Microphone ${micState(voice)}: ${voice.status}`}
          data-mic={micState(voice)}
          className={cn(
            "voice-mic-chip inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2",
            voice.error
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : voice.listening
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-primary/25 bg-primary/5 text-muted-foreground",
          )}
        >
          {voice.listening ? <Mic className="size-3 pulse-dot" /> : <MicOff className="size-3" />}
          {voice.status}
        </span>
        <HudButton
          icon={Ear}
          onClick={() => assistantMode.toggleHandsFree()}
          title="Hands-free: speak without repeating the wake word"
          active={voice.handsFree || voice.awake}
          label={
            voice.handsFree && !voice.error
              ? "hands-free · just talk"
              : voice.awake && !voice.error
                ? "awake · go ahead"
                : "say “FRIDAY …”"
          }
        />
        {assistantMode.listenStyle() === "push-to-talk" ? (
          <HudButton
            icon={Hand}
            // Keyboard activation (Enter or Space on the focused button) toggles.
            onClick={(event) => {
              if (event.detail === 0) assistantMode.togglePushToTalk();
            }}
            onPointerDown={() => assistantMode.holdToTalk(true)}
            onPointerUp={() => assistantMode.holdToTalk(false)}
            onPointerLeave={() => assistantMode.holdToTalk(false)}
            title="Hold to talk. Ctrl+Space in this window, Ctrl+Alt+Space toggles from anywhere."
            active={assistantMode.pushToTalkActive()}
            label={
              assistantMode.pushToTalkActive() ? "listening · release to send" : "hold to talk"
            }
          />
        ) : null}
        <HudButton
          icon={voice.paused ? Play : Pause}
          onClick={() => assistantMode.setPaused(!voice.paused)}
          active={voice.paused}
          label={voice.paused ? "Resume listening" : "Pause listening"}
        />
        <HudButton
          icon={RotateCcw}
          onClick={() => assistantMode.resetMicrophone()}
          title="Close and reopen the microphone"
          label="Reset microphone"
        />
      </HudGroup>

      {voice.speaking || full ? (
        <>
          <HudDivider />
          <HudGroup label="Speak">
            {voice.speaking ? (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-ctl border border-primary/40 bg-primary/10 px-2 text-primary">
                <Volume2 className="size-3" /> speaking
              </span>
            ) : null}
            {full ? (
              <HudButton
                icon={voice.muted ? VolumeX : Volume2}
                onClick={() => assistantMode.toggleMuted()}
                active={voice.muted}
                title={voice.muted ? "Unmute FRIDAY" : "Mute FRIDAY"}
                label={voice.muted ? "Unmute voice" : "Mute voice"}
              />
            ) : null}
          </HudGroup>
        </>
      ) : null}

      <HudDivider />
      {/* How much FRIDAY may do without asking, and the kill switch */}
      <HudGroup label="Safety">
        <AutonomyDial compact />
      </HudGroup>

      <HudDivider />
      <HudGroup label="Tools">
        <VoiceTools tools={tools} shown={shownTools} />
      </HudGroup>

      {run ? (
        <span className="inline-flex h-6 items-center gap-1.5 rounded-ctl border border-primary/30 bg-primary/5 px-2 text-primary">
          <Loader2 className="size-3 animate-spin" />
          {stage?.label ?? run.intentLabel}
        </span>
      ) : null}
      {voice.error ? (
        <span className="inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-ctl border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">
          <span className="min-w-0 break-words">{voice.error}</span>
          <button
            type="button"
            title="Fix voice"
            className="inline-flex shrink-0 items-center gap-1 rounded-ctl border border-destructive/40 px-1.5 py-0.5 transition-colors hover:bg-destructive/15 active:bg-destructive/25"
            onClick={() => assistantMode.fixVoice()}
          >
            <Wrench className="size-3" />
            Fix voice
          </button>
        </span>
      ) : null}

      <span
        className={cn(
          "ml-auto inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2 text-meta-sm",
          working
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-primary/25 bg-primary/8 text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            working ? "bg-accent pulse-dot" : "bg-muted-foreground",
          )}
        />
        {working ? "WORKING" : "IDLE"}
      </span>
      {full ? <VoiceLevelSwitch level={level} onSelect={selectLevel} /> : null}
    </div>
  );

  /* Real session numbers — no simulation, straight from the stores */
  const sessionNumbers = (
    <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-meta-sm text-muted-foreground">
      <span>
        runs <span className="text-primary">{live.session.runs}</span>
      </span>
      <span>
        avg <span className="text-primary">{live.session.avgMs || 0}ms</span>
      </span>
      <span>
        tokens <span className="text-primary">{live.session.tokens}</span>
      </span>
      <span>
        tasks <span className="text-primary">{live.session.tasks}</span>
      </span>
      <span>
        errors{" "}
        <span className={live.session.errors ? "text-destructive" : "text-accent"}>
          {live.session.errors}
        </span>
      </span>
    </div>
  );

  const captionTools = (
    <>
      <StripButton
        icon={follow ? Pause : Play}
        label={follow ? "follow" : "paused"}
        title={follow ? "Pause auto-scroll" : "Resume auto-scroll"}
        onClick={() => setFollow((f) => !f)}
      />
      <StripButton
        icon={copied ? Check : Copy}
        label={copied ? "copied" : "copy"}
        title="Copy transcript"
        onClick={copyTranscript}
      />
      <StripButton
        icon={Eraser}
        label="clear"
        title="Clear captions"
        onClick={() => assistantMode.clearCaptions()}
      />
      <StripButton
        icon={Trash2}
        label="delete heard"
        title="Delete the heard log on this PC"
        onClick={() => assistantMode.clearHeardLog()}
      />
    </>
  );

  return (
    // Alt+1/2/3 size the voice window only while focus is inside it and not
    // in a text field; Esc closes an open side pane. No global shortcut, and
    // Ctrl+Space / Ctrl+Alt+Space (push-to-talk) are never touched here.
    <div
      className="friday-voice contents"
      onKeyDown={(event) => {
        if (event.key === "Escape" && panel) {
          setPanel(null);
          return;
        }
        if (isTypingTarget(event.target)) return;
        const next = levelForKey(event);
        if (next) {
          event.preventDefault();
          selectLevel(next);
        }
      }}
    >
      {/* The screen is chrome: a stray Ctrl+A or drag must not grey every
          label. Captions and the diagnostic panels stay selectable. */}
      <div className="flex h-full min-h-0 select-none flex-col gap-2">
        {full ? (
          // Transcript: the control bar alone, no graphic and no circuit.
          <div className="hud-panel voice-glass relative flex shrink-0 flex-col rounded-lg">
            {bar}
          </div>
        ) : (
          /* Stage: the real live graphic, bigger. HUD and stats are flex rows
             (same tokens as the old overlays) so they never sit on the boxes. */
          <div className="hud-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg">
            {bar}

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <NeuralCircuit large onSelectNode={selectCircuitNode} />
            </div>

            <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
              {voice.pending ? <ConfirmationCard pending={voice.pending} /> : null}

              <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
                {sessionNumbers}
                <p className="shrink-0 text-right font-display text-xs font-bold uppercase tracking-[0.22em] text-primary glow-text">
                  {voice.status}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* FRIDAY's own box: captions + anything she needs to show.
            Diagnostics and the pipeline open in their own pane beside the
            captions, so the captions never move. */}
        <div
          className={cn(
            "hud-panel flex shrink-0 flex-col overflow-hidden rounded-lg transition-[height] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            full ? "voice-glass min-h-0 flex-1" : tall ? "h-[42vh]" : "h-[5.6rem]",
            streaming && "transition-none",
          )}
        >
          {full ? null : (
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-3 py-1">
              <p className="label-xs text-primary/60">
                Live captions{voice.display ? " · showing" : ""}
              </p>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-meta-sm text-muted-foreground">
                <StripButton
                  icon={Activity}
                  label={`diagnostics · ${voice.voiceState.toLowerCase()}`}
                  title={
                    panel === "diagnostics" ? "Close voice diagnostics" : "Open voice diagnostics"
                  }
                  pressed={panel === "diagnostics"}
                  onClick={() => togglePanel("diagnostics")}
                />
                <StripButton
                  icon={ListTree}
                  label={`pipeline · ${voice.voiceLog.length}`}
                  title={
                    panel === "pipeline" ? "Close the voice pipeline" : "Open the voice pipeline"
                  }
                  pressed={panel === "pipeline"}
                  onClick={() => togglePanel("pipeline")}
                />
                <span aria-hidden className="h-3.5 w-px bg-primary/15" />
                <StripButton
                  icon={voice.muted ? VolumeX : Volume2}
                  label={voice.muted ? "muted" : "voice"}
                  title={voice.muted ? "Unmute FRIDAY" : "Mute FRIDAY"}
                  tone={voice.muted ? "warning" : undefined}
                  onClick={() => assistantMode.toggleMuted()}
                />
                {captionTools}
                <VoiceLevelSwitch level={level} onSelect={selectLevel} />
              </div>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <div
                ref={scroller}
                role="log"
                aria-label="Live captions"
                aria-live="polite"
                aria-busy={Boolean(voice.interim)}
                onScroll={(event) => {
                  // Scrolling up to read stops following, as the follow button does.
                  if (!tall || !follow) return;
                  const el = event.currentTarget;
                  if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) setFollow(false);
                }}
                className={cn(
                  "voice-captions min-h-0 flex-1 select-text space-y-1 overflow-y-auto px-3 py-1.5",
                  full && "px-4 py-3",
                )}
              >
                <VoiceTranscript
                  captions={visible}
                  interim={voice.interim}
                  display={voice.display}
                  pending={full ? voice.pending : null}
                  layout={full ? "bubble" : "line"}
                  showTime={full && prefs.toggles["chatTimestamps"] === true}
                />
              </div>
              {tall && !follow ? (
                <button
                  type="button"
                  onClick={() => setFollow(true)}
                  className="absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-primary/30 bg-card px-2.5 py-0.5 text-meta-sm text-primary shadow-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <ArrowDown className="size-3" /> Jump to latest
                </button>
              ) : null}
            </div>

            {panel ? (
              <aside
                aria-label={panel === "diagnostics" ? "Voice diagnostics" : "Voice pipeline"}
                className="min-h-0 select-text overflow-y-auto border-t border-primary/15 px-3 py-1.5 max-md:max-h-[55%] md:w-[min(52%,640px)] md:border-l md:border-t-0"
              >
                {/* The real values behind the pipeline: mic, VAD, wake engine,
                    STT, TTS and session — plus the real runtime self-test.
                    Mounted only while open, so its live meters cost nothing
                    while FRIDAY is just listening. */}
                {panel === "diagnostics" ? (
                  <VoiceDiagnostics voice={voice} />
                ) : (
                  <VoicePipelineLog voice={voice} />
                )}
              </aside>
            ) : null}
          </div>

          {full ? (
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-primary/15 px-3 py-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta-sm text-muted-foreground">
                {captionTools}
              </div>
              {sessionNumbers}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
