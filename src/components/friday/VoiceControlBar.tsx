import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Bluetooth,
  Ear,
  MicOff,
  MoreHorizontal,
  PenLine,
  RotateCcw,
  Settings2,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CHAT_LEVELS, VOICE_LEVEL_LABELS, type ChatLevel } from "@/lib/friday/chat-level";
import { PANEL_BUTTON, useSlidingThumb } from "@/components/friday/ui";
import {
  micFaultPanelModel,
  micLiveText,
  micPanelState,
  OPEN_PRIVACY_LABEL,
  showBluetoothNotice,
} from "@/components/friday/mic-fault-panel-model";
import { desktopApi } from "@/lib/friday/desktop";
import { faultView, type MicAccess } from "@/lib/friday/mic-faults";
import { useNetwork } from "@/lib/friday/use-network";
import { voiceGate, type MicState } from "@/lib/friday/voice-audio";
import type { VoicePhase, VoiceState } from "@/lib/friday/voice-state";
import { LATENCY_BUDGET_MS, type LatencySummary } from "@/lib/friday/voice-engine/latency-monitor";
import {
  latencyChipModel,
  phaseChipModel,
  type PhaseChipModel,
} from "@/components/friday/voice-live-status-model";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the Auto (voice) window's control bar: one HUD button
 * shape, labelled groups (Listen, Speak, Safety, Tools), the Compact /
 * Expanded / Transcript switch, and a More menu for tools that do not fit.
 * The bar itself is assembled in AutoMode.tsx
 * from the live stores; nothing here holds voice state.
 *
 * Labels stay in the DOM right after their icon. On a narrow bar styles.css
 * hides the text (never removes it) and slides the label out on hover or
 * keyboard focus instead.
 */

/** One HUD control: icon + label, one height, clear pressed and focus states. */
export function HudButton({
  icon: Icon,
  label,
  title,
  active = false,
  flips = false,
  onClick,
  className,
  ...pointer
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  active?: boolean;
  /** The visible label itself flips with the state (Pause, Resume), so aria-pressed is left off: never both. */
  flips?: boolean;
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
      aria-label={label}
      {...(flips ? {} : { "aria-pressed": active })}
      data-label={label}
      onClick={onClick}
      {...pointer}
      className={cn(
        "voice-btn friday-btn inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 relative before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']",
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
export function HudDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-primary/15" />;
}

/**
 * A named group of controls. It does not box its children, so the HUD row
 * still wraps control by control at the window minimum.
 */
export function HudGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="contents">
      {children}
    </div>
  );
}

/** Compact | Expanded | Transcript. Alt+1/2/3 in the voice window does the same. */
export function VoiceLevelSwitch({
  level,
  onSelect,
}: {
  level: ChatLevel;
  onSelect: (level: ChatLevel) => void;
}) {
  const { listRef, thumbRef } = useSlidingThumb(level);
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label="Voice window size"
      className="voice-level-switch friday-seg inline-flex shrink-0 items-stretch whitespace-nowrap rounded-ctl border border-primary/25 text-meta-sm [html:not([data-ui-style='glass'])_&]:h-6 [html:not([data-ui-style='glass'])_&]:overflow-hidden"
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {CHAT_LEVELS.map((value, index) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={level === value}
          aria-label={`${VOICE_LEVEL_LABELS[value]} (Alt+${value})`}
          title={`${VOICE_LEVEL_LABELS[value]} (Alt+${value})`}
          onClick={() => onSelect(value)}
          className={cn(
            "friday-btn px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
            index > 0 && "border-l border-primary/15",
            level === value
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-primary/5 hover:text-primary",
          )}
        >
          {VOICE_LEVEL_LABELS[value]}
        </button>
      ))}
    </div>
  );
}

export type VoiceTool = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  render: () => ReactNode;
};

/**
 * Tools that fit render as HUD buttons; the rest move into one More menu
 * with the same handlers. The mic chip and Stop everything are never tools.
 */
export function VoiceTools({ tools, shown }: { tools: VoiceTool[]; shown: number }) {
  const inline = tools.slice(0, shown);
  const more = tools.slice(shown);
  return (
    <>
      {inline.map((tool) => (
        <span key={tool.id} className="contents">
          {tool.render()}
        </span>
      ))}
      {more.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More voice tools"
              title="More voice tools"
              className="inline-flex h-6 items-center rounded-ctl border border-primary/20 px-2 text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <MoreHorizontal className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="voice-glass-menu w-48">
            {more.map((tool) => (
              <DropdownMenuItem key={tool.id} onSelect={tool.onSelect}>
                <tool.icon className="size-4" /> {tool.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}

const PHASE_TONE: Record<PhaseChipModel["tone"], string> = {
  idle: "border-primary/25 bg-primary/5 text-muted-foreground",
  active: "border-accent/40 bg-accent/10 text-accent",
  warn: "border-warning/40 bg-warning/10 text-warning",
  stopped: "border-primary/20 bg-transparent text-muted-foreground",
};

/** What FRIDAY is doing right now, in one word. Only the confirm and stopped chips are polite live regions (four extra announcements a turn otherwise); it shows state and opens nothing. */
export function PhaseChip({
  phase,
  voiceState,
  pending,
}: {
  phase: VoicePhase;
  voiceState: VoiceState;
  pending: boolean;
}) {
  const chip = phaseChipModel({ phase, voiceState, pending });
  const announce = chip.key === "confirm" || chip.key === "stopped";
  return (
    <span
      {...(announce ? { role: "status", "aria-live": "polite" as const } : {})}
      data-phase={chip.key}
      title={chip.title}
      className={cn(
        "voice-phase-chip inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2",
        PHASE_TONE[chip.tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          chip.tone === "active" && "pulse-dot",
        )}
      />
      {chip.label}
    </span>
  );
}

/** The mode chips that only exist while the mode is on: Hands-free and Dictating. State only, no controls. */
export function ModeChips({ handsFree, dictating }: { handsFree: boolean; dictating: boolean }) {
  if (!handsFree && !dictating) return null;
  const chip =
    "inline-flex h-6 items-center gap-1.5 rounded-ctl border border-primary/25 bg-primary/5 px-2 text-primary";
  return (
    <>
      {handsFree ? (
        <span data-chip="hands-free" className={chip}>
          <Ear className="size-3" aria-hidden />
          Hands-free
        </span>
      ) : null}
      {dictating ? (
        <span data-chip="dictating" className={chip}>
          <PenLine className="size-3" aria-hidden />
          Dictating
        </span>
      ) : null}
    </>
  );
}

export function LatencyChip({ summary }: { summary: Pick<LatencySummary, "last"> | null }) {
  const chip = latencyChipModel(summary);
  if (!chip) return null;
  return (
    <span
      data-chip="latency"
      aria-label={`Last reply took ${chip.label} to her first sound, against ${LATENCY_BUDGET_MS} ms`}
      title={`Time from the end of your words to her first sound, against ${LATENCY_BUDGET_MS} ms`}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2",
        chip.overBudget
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-primary/25 bg-primary/5 text-muted-foreground",
      )}
    >
      <Timer className="size-3" aria-hidden />
      {chip.label}
    </span>
  );
}

/** The gate's fault and Bluetooth notice as one string, so the store read stays stable between renders. */
function gateKey(): string {
  const failure = voiceGate.lastCaptureFailure();
  return `${failure ? `${failure.state}\u0001${failure.reason}` : ""}\u0002${voiceGate.bluetoothNotice()}`;
}

/**
 * Plain-words microphone fault panel for Auto mode. A denied or restricted Windows switch gets the privacy
 * button and Retry, a busy or ended device gets Retry and the wait, a Bluetooth headset gets a one-time
 * dismissible note. The words are announced politely through one live region. It draws `micFaultPanelModel`.
 */
export function MicFaultPanel({ onRetry }: { onRetry: () => void }) {
  const key = useSyncExternalStore(
    (fn) => voiceGate.subscribe(() => fn()),
    gateKey,
    () => "\u0002",
  );
  const net = useNetwork();
  const [failureText = "", btLine = ""] = key.split("\u0002");
  const [state = "", ...reason] = failureText.split("\u0001");
  const fault = state
    ? faultView({ state: state as MicState, reason: reason.join("\u0001") })
    : null;
  const [answer, setAnswer] = useState<{ for: string; status: MicAccess } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [tries, setTries] = useState({ for: "", n: 0 });
  const attempt = tries.for === state ? tries.n : 0;
  const [dismissed, setDismissed] = useState("");

  /** Ask Windows why the microphone did not open, so the message names the real cause. */
  const checkAccess = async () => {
    const ask = desktopApi()?.micAccessStatus;
    if (!ask) return;
    setChecking(true);
    setCheckError("");
    try {
      const reply = await ask();
      setAnswer(reply.ok ? { for: state, status: reply.status } : null);
    } catch {
      setCheckError("Windows did not answer the microphone check.");
    } finally {
      setChecking(false);
    }
  };

  // A new fault kind is the trigger; its text alone does not re-ask Windows.
  useEffect(() => {
    if (state) queueMicrotask(() => void checkAccess());
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Windows' answer belongs to the fault it was asked for; a different or cleared fault drops it.
  const access = state && answer?.for === state ? answer.status : null;

  const model = micFaultPanelModel(fault, access, {
    attempt,
    autoRetry: fault?.state === "device-offline" || fault?.state === "no-microphone",
  });
  const page = micPanelState({ model, checking, online: net.online, checkError });
  const retry = () => {
    setTries({ for: state, n: attempt + 1 });
    onRetry();
    void checkAccess();
  };
  const openPrivacy = () => {
    const open = desktopApi()?.openMicPrivacySettings;
    if (!open) return Promise.resolve();
    return open().then((result) => {
      if (!result.ok)
        setCheckError("Windows Settings did not open. Open Privacy, then Microphone.");
    });
  };
  const bluetooth = showBluetoothNotice(btLine, dismissed) ? btLine : "";
  if (page.page === "none" && !bluetooth) return null;

  return (
    <div className="flex max-w-full flex-col gap-1.5 px-3 pt-2 text-meta-sm" data-mic-fault-panel>
      <p role="status" aria-live="polite" className="sr-only">
        {micLiveText(model)}
      </p>
      {page.page === "loading" ? (
        <p className="text-muted-foreground">Checking the microphone…</p>
      ) : null}
      {page.page === "offline" ? (
        <p className="text-muted-foreground">
          Offline. The microphone and local voice keep working.
        </p>
      ) : null}
      {page.page === "error" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-destructive" role="alert">
          <span className="min-w-0 break-words">{page.detail}</span>
          <button type="button" onClick={retry} className={PANEL_BUTTON}>
            <RotateCcw className="size-3" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}
      {page.page === "fault" ? (
        <div
          data-mic-fault={page.model.kind}
          className="flex flex-wrap items-center gap-1.5 rounded-ctl border border-warning/40 bg-warning/10 px-2 py-1 text-warning"
        >
          <MicOff className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{page.model.message}</span>
          {page.model.backoff ? (
            <span className="text-muted-foreground">{page.model.backoff}</span>
          ) : null}
          {page.model.showSettings ? (
            <button type="button" onClick={openPrivacy} className={PANEL_BUTTON}>
              <Settings2 className="size-3" aria-hidden="true" />
              {OPEN_PRIVACY_LABEL}
            </button>
          ) : null}
          {page.model.retry ? (
            <button type="button" onClick={retry} className={PANEL_BUTTON}>
              <RotateCcw className="size-3" aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {bluetooth ? (
        <div
          data-mic-bluetooth
          className="flex flex-wrap items-center gap-1.5 rounded-ctl border border-primary/25 bg-primary/5 px-2 py-1 text-muted-foreground"
        >
          <Bluetooth className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{bluetooth}</span>
          <button
            type="button"
            aria-label="Dismiss Bluetooth notice"
            onClick={() => setDismissed(bluetooth)}
            className={PANEL_BUTTON}
          >
            <X className="size-3" aria-hidden="true" />
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
