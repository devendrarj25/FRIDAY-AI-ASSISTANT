import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
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
  Trash2,
  Volume2,
  VolumeX,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NeuralCircuit } from "@/components/friday/NeuralCircuit";
import { ageOf, type LiveComponent } from "@/lib/friday/use-friday-live";
import {
  assistantMode,
  type AssistantModeState,
  type PanelDisplay,
} from "@/lib/friday/assistant-mode";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { useBrain } from "@/lib/friday/use-brain";
import { useFridayLive } from "@/lib/friday/use-friday-live";
import { cn } from "@/lib/utils";
import { AutonomyDial } from "@/components/friday/AutonomyDial";
import { rememberRun, voiceAutoGraph } from "@/lib/friday/flow-modes";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import { preferences } from "@/lib/friday/preferences";
import { autonomy } from "@/lib/friday/self/autonomy";
import { VoiceDiagnostics } from "@/components/friday/VoiceDiagnostics";

/**
 * Auto Mode main screen.
 *
 * The stage is the *same* live neural graphic Manual mode uses — same boxes,
 * same neon wires, same real event source — just rendered larger. Voice state
 * sits on top of it as compact HUD overlays, and everything FRIDAY says or
 * needs to show lands in the small caption box at the bottom, which she can
 * expand herself when content needs room.
 */

function DisplayPanel({ display }: { display: PanelDisplay }) {
  const toneClass =
    display.kind === "status"
      ? display.tone === "ok"
        ? "border-accent/40 text-accent"
        : display.tone === "warn"
          ? "border-warning/40 text-warning"
          : display.tone === "error"
            ? "border-destructive/40 text-destructive"
            : "border-primary/30 text-primary"
      : "border-primary/25 text-foreground/90";

  return (
    <div className={cn("rounded-md border bg-surface/60 p-2.5", toneClass)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="label-xs text-primary/70">{display.title ?? display.kind}</p>
        <button
          type="button"
          onClick={() => assistantMode.clearDisplay()}
          className="text-muted-foreground hover:text-primary"
          title="Dismiss"
        >
          <X className="size-3" />
        </button>
      </div>
      {display.kind === "code" ? (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
          {display.code}
        </pre>
      ) : display.kind === "list" ? (
        <ul className="space-y-1 text-xs text-foreground/90">
          {display.items.map((item, i) => (
            <li key={`${i}-${item.slice(0, 12)}`} className="flex gap-2">
              <span className="text-primary">›</span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{display.text}</p>
      )}
    </div>
  );
}

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

/** One HUD control: icon + label, one height, clear pressed and focus states. */
function HudButton({
  icon: Icon,
  label,
  title,
  active = false,
  onClick,
  className,
  ...pointer
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-pressed={active}
      onClick={onClick}
      {...pointer}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-primary/20 text-muted-foreground hover:border-primary/35 hover:text-primary active:bg-primary/15",
        className,
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}

/** Thin separator between HUD groups. */
function HudDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-primary/15" />;
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
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 active:bg-primary/15",
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
      <p className="font-mono text-[10px] text-muted-foreground">
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
                "w-20 shrink-0 font-mono text-[10px] uppercase",
                entry.stage === "error" || entry.stage === "dropped"
                  ? "text-destructive"
                  : entry.stage === "transcript"
                    ? "text-accent"
                    : "text-muted-foreground",
              )}
            >
              {entry.stage}
            </span>
            <span className="min-w-0 break-words font-mono text-[10px] text-muted-foreground">
              {entry.detail}
              {entry.repeat && entry.repeat > 1 ? ` x${entry.repeat}` : ""}
            </span>
          </li>
        ))}
    </ul>
  );
}

type CaptionPanel = "diagnostics" | "pipeline" | null;

export function AutoMode() {
  const voice = useAssistantMode();
  const brainState = useBrain();
  const live = useFridayLive();
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  // Diagnostics and the pipeline open beside the captions, never inside them.
  const [panel, setPanel] = useState<CaptionPanel>(null);
  const togglePanel = (next: Exclude<CaptionPanel, null>) =>
    setPanel((open) => (open === next ? null : next));

  useEffect(() => {
    if (!follow) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [voice.captions, voice.interim, voice.display, voice.expanded, follow]);

  const run = brainState.runs.find((r) => r.id === brainState.activeRunId);
  const stage = run?.stages.find((s) => s.state === "running");

  const copyTranscript = () => {
    const text = assistantMode.transcript();
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  // Only the last couple of exchanges when collapsed; full history expanded.
  const tall = voice.expanded || panel !== null;
  const visible = tall ? voice.captions : voice.captions.slice(-2);
  const working = live.components.some((c) => c.active);

  return (
    // The screen is chrome: a stray Ctrl+A or drag must not grey every label.
    // Captions and the diagnostic panels stay selectable for copying.
    <div className="flex h-full min-h-0 select-none flex-col gap-2">
      {/* Stage: the real live graphic, bigger. HUD and stats are flex rows
          (same tokens as the old overlays) so they never sit on the boxes. */}
      <div className="hud-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg">
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3 font-mono text-[10px]">
          {/* 1. What the voice session is doing right now */}
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2",
              voice.listening
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-primary/25 bg-primary/5 text-muted-foreground",
            )}
          >
            {voice.listening ? <Mic className="size-3 pulse-dot" /> : <MicOff className="size-3" />}
            {voice.status}
          </span>
          {voice.speaking ? (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 px-2 text-primary">
              <Volume2 className="size-3" /> speaking
            </span>
          ) : null}
          {run ? (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-primary/30 bg-primary/5 px-2 text-primary">
              <Loader2 className="size-3 animate-spin" />
              {stage?.label ?? run.intentLabel}
            </span>
          ) : null}

          <HudDivider />
          {/* 2. How FRIDAY listens */}
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

          <HudDivider />
          {/* 3. How much FRIDAY may do without asking */}
          <AutonomyDial compact />

          <HudDivider />
          <HudButton
            icon={Workflow}
            title="Open this voice session as a live flow"
            label="Voice flow"
            onClick={() => {
              const prefs = preferences.getSnapshot();
              const dial = autonomy.getSnapshot();
              const graph = rememberRun(
                voiceAutoGraph({
                  voiceState: voice.voiceState,
                  error: voice.error,
                  paused: voice.paused,
                  wakeWord: prefs.voice.wakeWord,
                  lastWake: voice.lastWake?.detail || "",
                  approvalLevel: dial.approvalLevel,
                  halted: dial.halted,
                  attentionWindow: prefs.fields["attentionWindow"] || "",
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
            }}
          />
          {voice.error ? (
            <span className="inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">
              <span className="min-w-0 break-words">{voice.error}</span>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-destructive/40 px-1.5 py-0.5 transition-colors hover:bg-destructive/15 active:bg-destructive/25"
                onClick={() => assistantMode.fixVoice()}
              >
                <Wrench className="size-3" />
                Fix voice
              </button>
            </span>
          ) : null}

          <span
            className={cn(
              "ml-auto inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 font-mono text-[10px]",
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
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <NeuralCircuit large onSelectNode={selectCircuitNode} />
        </div>

        <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
          {voice.pending ? (
            <div className="mx-auto w-[min(560px,96%)] rounded-md border border-warning/50 bg-warning/10 p-3 backdrop-blur-sm">
              <p className="label-xs text-warning">Confirmation required</p>
              <p className="mt-1 text-sm text-foreground">{voice.pending.command}</p>
              <p className="mt-1 text-xs text-muted-foreground">{voice.pending.reason}</p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => assistantMode.confirmPending(true)}
                  className="rounded-sm border border-accent/50 bg-accent/15 px-3 py-1.5 font-mono text-[11px] text-accent hover:bg-accent/25"
                >
                  YES · run it
                </button>
                <button
                  type="button"
                  onClick={() => assistantMode.confirmPending(false)}
                  className="rounded-sm border border-primary/25 px-3 py-1.5 font-mono text-[11px] text-muted-foreground hover:border-destructive/60 hover:text-destructive"
                >
                  NO · cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
            {/* Real session numbers — no simulation, straight from the stores */}
            <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
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

            <p className="shrink-0 text-right font-display text-xs font-bold uppercase tracking-[0.22em] text-primary glow-text">
              {voice.status}
            </p>
          </div>
        </div>
      </div>

      {/* FRIDAY's own box: compact captions + anything she needs to show.
          Diagnostics and the pipeline open in their own pane beside the
          captions, so the captions never move. */}
      <div
        className={cn(
          "hud-panel flex shrink-0 flex-col overflow-hidden rounded-lg transition-[height] duration-300 ease-out",
          tall ? "h-[42vh]" : "h-[5.6rem]",
        )}
      >
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-3 py-1">
          <p className="label-xs text-primary/60">
            Live captions{voice.display ? " · showing" : ""}
          </p>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 font-mono text-[10px] text-muted-foreground">
            <StripButton
              icon={Activity}
              label={`diagnostics · ${voice.voiceState.toLowerCase()}`}
              title={panel === "diagnostics" ? "Close voice diagnostics" : "Open voice diagnostics"}
              pressed={panel === "diagnostics"}
              onClick={() => togglePanel("diagnostics")}
            />
            <StripButton
              icon={ListTree}
              label={`pipeline · ${voice.voiceLog.length}`}
              title={panel === "pipeline" ? "Close the voice pipeline" : "Open the voice pipeline"}
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
            <button
              type="button"
              onClick={() => assistantMode.toggleExpanded()}
              className="inline-flex items-center gap-1 rounded-sm border border-primary/30 px-2 py-0.5 text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 active:bg-primary/20"
              title={voice.expanded ? "Collapse box" : "Expand box"}
            >
              {voice.expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronUp className="size-3.5" />
              )}
              {voice.expanded ? "collapse" : "expand"}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            ref={scroller}
            className="min-h-0 flex-1 select-text space-y-1 overflow-y-auto px-3 py-1.5"
          >
            {voice.captions.length === 0 && !voice.interim && !voice.display ? (
              <p className="text-xs text-muted-foreground">
                Nothing heard yet. Say “FRIDAY” followed by what you need.
              </p>
            ) : null}

            {visible.map((c) => (
              <div key={c.id} className="flex gap-2 text-sm">
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] uppercase",
                    c.who === "user" ? "text-accent" : "text-primary",
                  )}
                >
                  {c.who === "user" ? "you" : "friday"}
                </span>
                <span className="min-w-0 text-foreground/90">
                  {c.text}
                  {c.tag ? (
                    <span className="ml-2 font-mono text-[10px] uppercase text-muted-foreground">
                      {c.tag}
                      {c.language ? ` · ${c.language}` : ""}
                      {typeof c.confidence === "number" ? ` · ${c.confidence.toFixed(2)}` : ""}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}

            {/* Live speech streams inside this same box */}
            {voice.interim ? (
              <div className="flex gap-2 text-sm opacity-70">
                <span className="shrink-0 font-mono text-[10px] uppercase text-accent">you</span>
                <span className="min-w-0 italic text-foreground/70">{voice.interim}</span>
              </div>
            ) : null}

            {voice.display ? <DisplayPanel display={voice.display} /> : null}
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
      </div>
    </div>
  );
}
