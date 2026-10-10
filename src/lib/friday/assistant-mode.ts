/**
 * FRIDAY assistant mode.
 *
 * Manual — typed and clicked turns only. The microphone stays closed and
 *          FRIDAY does not speak.
 * Auto   — the voice session. The microphone stays open, a real utterance is
 *          a turn without a push-to-talk button, and the reply is spoken.
 *          The wake word still counts. Turning Hands-free off requires the
 *          wake word again, and that choice is remembered. The in-memory
 *          flag still starts false until this session applies the Auto rule.
 *          Execution still waits for a yes.

 *
 * Everything here is real: FRIDAY's local faster-whisper transcriber, the
 * existing brain store for execution, and the voice library for speech. The
 * microphone is opened once for Auto mode, torn down when the mode goes back
 * to manual, and kept alive while the window is hidden.
 *
 * Safety: anything that looks like a consequential OS / file / app action is
 * never executed straight from speech. FRIDAY repeats it back and waits for a
 * spoken (or clicked) confirmation first.
 */

import { brain } from "./brain-engine";
import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { composer } from "./composer";
import { armChartOffer, voiceAutoGraph } from "./flow-modes";
import { preferences } from "./preferences";
import { mergeTurnExtra, turnAwarenessExtra } from "./turn-awareness";
import { conversationDigest } from "./brain/conversation-state";
import { attentionWindowMs } from "./attention-window";
import { preferSpoken } from "./conversation-style";
import { activeVoiceSettings, speakText, spokenSummary, stopSpeaking } from "./voice-library";
import {
  acceptsVoiceTurn,
  approvalFresh,
  backchannel,
  bindVoiceSurface,
  clarifyPrompt,
  endpointSilenceMs,
  foreignAssistant,
  holdInterrupted,
  duplicateFinalUtterance,
  nextSpokenCursor,
  isBoundConfirmation,
  isHoldSound,
  microphoneAllowed,
  pushVoiceAudit,
  speakerDecision,
  prosodyAffect,
  speakingProsody,
  spokenReplyAllowed,
  takeSpeakable,
  voiceClaimsAuthority,
  wakeOnCooldown,
  wantsContinue,
  type VoiceAudit,
} from "./voice-session";
import {
  applyCorrections,
  confidenceRepeat,
  languageId,
  learnCorrection,
  utteranceConfidence,
} from "./asr-bias";
import { noteArc } from "./conversation-arc";
import { voiceBudgets } from "./failure-guard";
import { applySession } from "./mic-session";
import { noteStyleCorrection } from "./response-policy";
import {
  outputReachable,
  voiceForLanguage,
  chooseTtsEngine,
  firstAudioLatency,
  switchMidSentence,
} from "./tts-ladder";
import {
  EMPTY_MIC_STATUS,
  noteMicHolders,
  probeMicrophone,
  voiceGate,
  type MicStatus,
} from "./voice-audio";
import { rememberDevice } from "./mic-truth";
import { readFeeling } from "./brain/affect";
import { DesktopDictation, sttInitialPrompt, sttStatus } from "./voice-stt";
import { isSelfEchoTranscript, isStopCommand, matchWakeWord } from "./wake-word";
import { alertsAudible } from "./settings-runtime";
import {
  EMPTY_CONDUCT,
  loadConduct,
  partialPlan,
  reduceVoice,
  saveConduct,
  toolNarration,
  type ConductState,
} from "./assistant-conduct";
import { searchExpertise } from "./brain/expertise";
import { formatGuidance, type OwnerGuidance } from "./doctor-engine";
import { speechTurnPlan } from "./speech-core";
import { chooseStt, whisperMutePlan } from "./speech-stt";
import {
  failureCause,
  mayAnnounce,
  ownerVoiceLang,
  recoveryDelayMs,
  resumeAfterSpokenReply,
  shouldRetryNow,
  voiceFailureLine,
} from "./voice-recovery";
import {
  TRANSCRIPT_ONLY,
  detectWake,
  wakeEngineStatus,
  type WakeEngineStatus,
  type WakeProbe,
} from "./wake-engine";
import {
  nextVoiceState,
  stateIsListening,
  stateIsSpeaking,
  stateLabel,
  type VoiceEvent,
  type VoiceState,
} from "./voice-state";

import {
  AFFIRM,
  DENY,
  approvalReason,
  commandNeedsApproval,
  setActionMode,
} from "./brain/action-risk";

export type AssistantMode = "manual" | "auto";

export type Caption = {
  id: string;
  who: "user" | "friday";
  text: string;
  at: number;
  /** Still being recognised / still being spoken. */
  partial?: boolean;
};

export type PendingConfirm = {
  command: string;
  reason: string;
  at: number;
};

/**
 * Anything FRIDAY needs to *show* rather than say. It is rendered inside the
 * caption box, which FRIDAY can expand herself when the content needs room.
 */
export type PanelDisplay =
  | { kind: "text"; title?: string; text: string }
  | { kind: "list"; title?: string; items: string[] }
  | { kind: "code"; title?: string; code: string; lang?: string }
  | { kind: "status"; title?: string; text: string; tone: "info" | "ok" | "warn" | "error" };

/**
 * One observable step of the voice pipeline: microphone → VAD segment →
 * faster-whisper transcript → wake-word match → brain. Auto Mode used to fail
 * silently, so every step is now recorded and shown in the UI.
 */
export type VoiceTrace = {
  at: number;
  stage: "speech" | "segment" | "dropped" | "transcribing" | "transcript" | "wake" | "error";
  detail: string;
};

export type AssistantModeState = {
  mode: AssistantMode;
  /** The recogniser is currently receiving audio. */
  listening: boolean;
  /** FRIDAY is speaking right now. */
  speaking: boolean;
  /** Wake word heard — follow-up commands need no wake word for a while. */
  awake: boolean;
  /** Last thing the wake-word engine heard (for the title-bar tooltip). */
  heard: string;
  /** Live partial transcript of what the user is saying right now. */
  interim: string;
  /** Short human status line for the Auto Mode screen. */
  status: string;
  /** Rolling captions for both sides of the conversation. */
  captions: Caption[];
  /** Consequential action waiting for an explicit yes/no. */
  pending: PendingConfirm | null;
  /** Set when the browser/OS refuses microphone access. */
  error: string | null;
  supported: boolean;
  /** A usable microphone was detected. */
  micReady: boolean;
  /** The verified state of the real Windows audio input hardware. */
  mic: MicStatus;
  /** Caption box is showing its tall form. FRIDAY can set this herself. */
  expanded: boolean;
  /** Rich content FRIDAY wants shown inside the caption box. */
  display: PanelDisplay | null;
  /** Voice output muted from the caption box controls. */
  muted: boolean;
  /** Microphone paused from the tray menu ("Pause listening"). */
  paused: boolean;
  /**
   * Hands-free conversation: once Auto Mode is on, speech is treated as a
   * request without repeating the wake word (how Siri/Gemini behave after the
   * first turn). Turning it off restores strict wake-word gating.
   */
  handsFree: boolean;
  /** Live instrumentation of the listen → transcribe → wake → brain pipeline. */
  voiceLog: VoiceTrace[];
  /**
   * The ONE explicit voice state. `listening`, `speaking` and the status line
   * are derived from it, so nothing in the UI has to infer what FRIDAY is
   * doing — every transition comes from a real pipeline event.
   */
  voiceState: VoiceState;
  /** Which wake detector is really active right now (and why). */
  wakeEngine: WakeEngineStatus;
  /** The last wake verdict, whichever engine produced it. */
  lastWake: { engine: string; detail: string; at: number } | null;
  /** Real speech-to-text facts for the diagnostics panel. */
  stt: {
    engine: string;
    model: string | null;
    ready: boolean;
    lastTranscript: string;
    lastError: string | null;
    lastLatencyMs: number | null;
  };
  /** Which engine actually produced the last spoken line. */
  tts: {
    engine: "neural" | "supertonic" | "sapi" | "formant" | "system" | "none" | null;
    voice: string;
    lastSpokenAt: number | null;
    lastError: string | null;
  };
};

/** How many pipeline steps the Auto Mode screen keeps. */
const MAX_VOICE_LOG = 30;

const STORAGE_KEY = "friday.assistant.mode";
const CONDUCT_KEY = "friday.assistant.conduct.v1";
const HANDS_FREE_KEY = "friday.assistant.handsfree";
const MAX_CAPTIONS = 40;
/**
 * How long follow-ups are accepted without repeating the wake word. Owned by
 * the shared preference so the Settings page and a conversational change move
 * the same number.
 */
const AWAKE_MS = () => attentionWindowMs();
/** A spoken failure is once per cause for this session. The screen keeps the detail. */

/** The configured name, matched through the shared local wake-word engine. */
function wakeWord(): string {
  return preferences.getSnapshot().voice.wakeWord.trim() || "friday";
}

/** Hearable form — owned by the one TTS helper. */
export { spokenSummary } from "./voice-library";

/**
 * Risk wording, confirmation vocabulary and the Manual/Auto approval rule all
 * live in brain/action-risk.ts so the voice path and the typed chat path judge
 * a command identically. Nothing is duplicated here.
 */

/** Pick the closest installed voice for the configured name/language. */
/** The desktop bridge (tray + window control). Null in the browser preview. */
type VoiceDesktop = {
  showWindow?: () => void;
  reportVoiceState?: (state: {
    mode: string;
    listening: boolean;
    paused: boolean;
    muted?: boolean;
  }) => void;
  onVoicePause?: (cb: (payload: { paused: boolean }) => void) => () => void;
  onVoicePartial?: (cb: (payload: { text?: string }) => void) => () => void;
  /** Real faster-whisper / edge-tts probes run by the main process. */
  verifyVoiceRuntime?: (payload?: { loadModel?: boolean }) => Promise<{
    ok: boolean;
    python: string | null;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }>;
  meetingStatus?: () => Promise<{ meeting?: boolean; names?: string[] }>;
};
const desktop = (): VoiceDesktop | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: VoiceDesktop }).friday ?? null);

let cid = 0;
const captionId = () => `cap-${Date.now().toString(36)}-${(cid += 1).toString(36)}`;

class AssistantModeStore {
  private listeners = new Set<() => void>();
  /** On-device transcription is Auto Mode's only recognition engine. */
  private dictation: DesktopDictation | null = null;
  private wantRunning = false;
  /** A start already in flight must not open a second capture. */
  private recognitionPending = false;
  /** True after Install Manager reports the offline voice package. */
  private offlineVoiceReady = false;
  /**
   * When local speech recognition is genuinely unavailable, starting it again
   * immediately only repeats the same failure. Bounded retry uses the kernel
   * delays (0 / 2s / 8s, three attempts); after that FRIDAY stops looping and
   * hands the owner the same step-by-step guidance Doctor/chat use.
   */
  private sttBlockedUntil = 0;
  private sttRecoveryAttempt = 0;
  private sttRecoveryTimer: number | null = null;
  private sttGaveUp = false;
  /** Causes already spoken this session. */
  private spokenCauses = new Set<string>();
  private lastFailure = "";
  /** Last text handed to the speech synthesiser, used for echo rejection. */
  private spokenText = "";
  /**
   * True only when the owner saved Hands-free off. A missing key leaves Auto
   * mode as the hands-free conversation and does not write the key.
   */
  private wakeWordRequired = false;
  /** Barge-in and a mode change drop every queued clip from an older turn. */
  private speechGen = 0;
  private unfinished = "";
  private backchannelUsed = false;
  private speechQueue: string[] = [];
  private draining = false;
  /** How much of the live answer has already been handed to speech. */
  private voicedRunId = "";
  private voicedChars = 0;
  /** User lines already shown before the brain echoes them into captions. */
  private pendingUserEcho = 0;
  /** Last finalized transcript, so the same utterance is not run twice. */
  private lastFinalText = "";
  private lastFinalAt = 0;
  private chartOfferedFor = "";
  /** Hangover so echo STT that arrives after tts-end is still rejected. */
  private echoUntil = 0;
  private hydrated = false;
  private spokenUpTo = 0;
  private unBrain: (() => void) | null = null;
  private awakeUntil = 0;
  private awakeTimer: number | null = null;
  /** Last accepted wake, so a second copy of the name inside the cooldown is ignored. */
  private lastWakeAt = 0;
  private conduct: ConductState = { ...EMPTY_CONDUCT, orders: [], journal: [] };
  private hotplugTimer: number | null = null;
  private callHold = false;
  private speculative = "";
  /** "brain" already dispatched. "conduct" waits for the final line. */
  private speculativeKind: "" | "brain" | "conduct" = "";
  private narratedTool = "";
  private partialText = "";
  private partialAt = 0;
  /** What was heard and what was decided. Not spoken, and not a second log store. */
  private audit: VoiceAudit[] = [];
  private turnClock = {
    heardAt: null as number | null,
    finalAt: null as number | null,
    tokenAt: null as number | null,
    audioAt: null as number | null,
  };

  state: AssistantModeState = {
    // FRIDAY starts awake: auto mode is the default until the owner switches
    // to manual, and that choice is then remembered across restarts.
    mode: "auto",
    listening: false,
    speaking: false,
    awake: false,
    heard: "",
    interim: "",
    status: "Auto mode",

    captions: [],
    pending: null,
    error: null,
    supported: false,
    micReady: false,
    mic: EMPTY_MIC_STATUS,
    expanded: false,
    display: null,
    muted: false,
    paused: false,
    // Wake word required by default: FRIDAY listens continuously but stays
    // passive until she is actually called. Hands-free is an explicit opt-in.
    handsFree: false,

    voiceLog: [],
    voiceState: "OFF",
    wakeEngine: TRANSCRIPT_ONLY,
    lastWake: null,
    stt: {
      engine: "faster-whisper",
      model: null,
      ready: false,
      lastTranscript: "",
      lastError: null,
      lastLatencyMs: null,
    },
    tts: { engine: null, voice: "", lastSpokenAt: null, lastError: null },
  };

  private snapshot: AssistantModeState = this.state;
  private traySignature = "";

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.hydrate();
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    this.reportToTray();
  }

  /** The tray tooltip must always show the REAL microphone state. */
  private reportToTray() {
    const signature = `${this.state.mode}|${this.state.listening}|${this.state.paused}|${this.state.muted}`;
    if (signature === this.traySignature) return;
    this.traySignature = signature;
    try {
      desktop()?.reportVoiceState?.({
        mode: this.state.mode,
        listening: this.state.listening,
        paused: this.state.paused,
        muted: this.state.muted,
      });
    } catch {
      /* browser preview — no tray to update */
    }
  }

  /**
   * "Pause listening" (tray) — really closes the microphone; resuming restarts
   * recognition only when auto mode is still on.
   */
  setPaused(paused: boolean) {
    if (this.state.paused === paused) return;
    this.state.paused = paused;
    if (paused) {
      this.stopRecognition();
      this.cancelSpeech();
      this.to("pause");
      this.state.status = "Microphone paused";
    } else if (this.state.mode === "auto") {
      // An explicit resume is the owner asking again: retry immediately.
      this.resetVoiceRecovery();
      this.to("resume");
      this.startRecognition();
    } else {
      this.to("stopped");
    }
    this.emit();
  }

  togglePaused() {
    this.setPaused(!this.state.paused);
  }

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    this.state.supported = Boolean(
      typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia,
    );
    void preferences.hydrate();
    try {
      const saved = readLocalState<AssistantMode>(STORAGE_KEY);
      if (saved === "auto" || saved === "manual") this.state.mode = saved;
      setActionMode(this.state.mode);
      const savedHands = readLocalState<boolean>(HANDS_FREE_KEY);
      if (savedHands === true) this.state.handsFree = true;
      else if (savedHands === false) this.wakeWordRequired = true;
      else if (this.state.mode === "auto") this.state.handsFree = true;
    } catch {
      /* storage blocked — keep the auto default */
    }
    // The selected FRIDAY folder is authoritative for the remembered mode.
    restoreFromDisk<AssistantMode>(STORAGE_KEY, (mode) => {
      if ((mode === "auto" || mode === "manual") && mode !== this.state.mode) this.setMode(mode);
    });
    restoreFromDisk<boolean>(HANDS_FREE_KEY, (on) => this.setHandsFree(Boolean(on)));
    const savedConduct = readLocalState<unknown>(CONDUCT_KEY);
    if (savedConduct) this.conduct = loadConduct(savedConduct);
    restoreFromDisk<unknown>(CONDUCT_KEY, (value) => {
      this.conduct = loadConduct(value);
    });
    let pauseCalls = preferences.getSnapshot().voice.pauseDuringCalls !== false;
    let voiceSnap = JSON.stringify(preferences.getSnapshot().voice);
    preferences.subscribe(() => {
      const next = preferences.getSnapshot().voice.pauseDuringCalls !== false;
      const nextVoice = JSON.stringify(preferences.getSnapshot().voice);
      const voiceChanged = nextVoice !== voiceSnap;
      voiceSnap = nextVoice;
      if (next !== pauseCalls) {
        pauseCalls = next;
        if (this.state.mode === "auto") void this.refreshMeeting();
      }
      if (voiceChanged) this.noteVoiceTrigger("settings");
    });

    // The window can be hidden in the tray while FRIDAY stays alive, so the
    // microphone must KEEP running when the page is hidden (the renderer is
    // hidden, not destroyed, and backgroundThrottling is off in main.cjs).
    // Only re-arm recognition when the page becomes visible again in case
    // Chromium dropped the stream while the window was down.
    document.addEventListener("visibilitychange", () => {
      if (this.state.mode !== "auto" || this.state.paused) return;
      if (!document.hidden && !this.dictation?.active) this.noteVoiceTrigger("focus");
    });
    // "Pause listening" from the tray really stops the microphone here.
    desktop()?.onVoicePause?.((payload) => this.setPaused(Boolean(payload?.paused)));
    desktop()?.onVoicePartial?.((payload) => {
      const text = String(payload?.text || "").trim();
      if (!text || this.state.mode !== "auto" || this.state.paused || this.callHold) return;
      this.state.interim = text;
      const now = Date.now();
      const stableMs = text === this.partialText ? now - this.partialAt : 0;
      const plan = partialPlan({
        text,
        previous: this.partialText,
        stableMs,
        started: Boolean(this.speculative),
      });
      if (text !== this.partialText) {
        this.partialText = text;
        this.partialAt = now;
      }
      if (plan === "cancel" && this.speculative) {
        if (this.speculativeKind === "brain") {
          brain.stop();
          this.dropPlayback();
        }
        this.speculative = "";
        this.speculativeKind = "";
      } else if (plan === "start" && !this.speculative) {
        const wake = matchWakeWord(text, wakeWord());
        const words = text.split(/\s+/).filter(Boolean).length;
        const accepted = acceptsVoiceTurn({
          mode: this.state.mode,
          paused: this.state.paused,
          wakeMatched: wake.matched,
          awake: Date.now() < this.awakeUntil,
          handsFree: this.state.handsFree,
          wakeWordRequired: this.wakeWordRequired,
          words,
          stop: false,
        });
        const command = (wake.matched ? wake.command : text).trim();
        const preview = reduceVoice(this.conduct, command, now, {
          quiet: !alertsAudible(),
          meeting: this.callHold,
          address: preferences.getSnapshot().voice.addressName,
        });
        if (preview.handled) {
          this.speculative = command;
          this.speculativeKind = "conduct";
        } else if (
          accepted &&
          command &&
          !commandNeedsApproval(command, this.state.mode) &&
          !voiceClaimsAuthority(command)
        ) {
          this.speculative = command;
          this.speculativeKind = "brain";
          this.dispatch(command);
        }
      }
      this.emit();
    });
    // A headset being plugged/unplugged kills the audio track: rebuild it.
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      this.stopRecognition();
      void this.probeMic();
      if (this.hotplugTimer) window.clearTimeout(this.hotplugTimer);
      this.hotplugTimer = null;
      const session = applySession("hotplug", "a2dp");
      if (session.reopen) this.noteVoiceTrigger("device");
    });
    if (this.state.mode === "auto") this.enterAuto();
    this.emit();
    void import("./installer-engine").then(({ installer }) => {
      let lastWhisper = Boolean(installer.getSnapshot().installed["faster-whisper"]);
      installer.subscribe(() => {
        const now = Boolean(installer.getSnapshot().installed["faster-whisper"]);
        if (installer.getSnapshot().installed["supertonic"]) this.offlineVoiceReady = true;
        if (now && (!lastWhisper || this.sttGaveUp)) {
          this.resetVoiceRecovery();
          this.noteVoiceTrigger("install-finished");
          this.noteVoiceTrigger("model-ready");
        }
        lastWhisper = now;
      });
    });
  }

  setMode(mode: AssistantMode) {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    // Keep the shared approval policy in step with the switch.
    setActionMode(mode);
    try {
      writeState(STORAGE_KEY, mode);
    } catch {
      /* non-fatal */
    }
    if (mode === "auto") {
      this.noteVoiceTrigger("toggle");
      this.enterAuto();
    } else this.leaveAuto();
    this.emit();
  }

  toggle() {
    this.setMode(this.state.mode === "auto" ? "manual" : "auto");
  }

  /* ------------------------------------------------------------ captions */

  /** The brain echo of a line already captioned from speech is not a second turn. */
  private captionUserTurn(text: string) {
    if (this.pendingUserEcho > 0) {
      this.pendingUserEcho -= 1;
      return;
    }
    this.caption("user", text);
  }

  private caption(who: Caption["who"], text: string, partial = false) {
    const list = this.state.captions.slice();
    const last = list[list.length - 1];
    if (last && last.partial && last.who === who) list.pop();
    list.push({ id: captionId(), who, text, at: Date.now(), partial });
    this.state.captions = list.slice(-MAX_CAPTIONS);
  }

  clearCaptions() {
    this.state.captions = [];
    this.state.display = null;
    this.spokenUpTo = brain.getSnapshot().messages.length;
    this.emit();
  }

  /**
   * Mirror the shared transcript into Auto Mode captions without speaking.
   * Used when the owner loads or replaces a saved conversation so the HUD
   * stays the same talk, not a second copy that then gets read aloud.
   */
  adoptTranscript() {
    const { messages } = brain.getSnapshot();
    this.spokenUpTo = messages.length;
    this.state.captions = messages.slice(-MAX_CAPTIONS).map((message) => ({
      id: captionId(),
      who: message.role === "user" ? ("user" as const) : ("friday" as const),
      text: message.text,
      at: message.at,
    }));
    this.state.display = null;
    this.emit();
  }

  /* ------------------------------------------- caption box (display panel) */

  /** Expand / collapse the caption box. Used by the UI and by FRIDAY. */
  setExpanded(expanded: boolean) {
    if (this.state.expanded === expanded) return;
    this.state.expanded = expanded;
    this.emit();
  }

  toggleExpanded() {
    this.setExpanded(!this.state.expanded);
  }

  /** FRIDAY shows something in her own box, expanding it when it needs room. */
  show(display: PanelDisplay | null, options: { expand?: boolean } = {}) {
    this.state.display = display;
    if (display && (options.expand ?? this.needsRoom(display))) this.state.expanded = true;
    this.emit();
  }

  clearDisplay() {
    if (!this.state.display) return;
    this.state.display = null;
    this.emit();
  }

  private needsRoom(display: PanelDisplay) {
    if (display.kind === "code") return true;
    if (display.kind === "list") return display.items.length > 3;
    if (display.kind === "text") return display.text.length > 220;
    return false;
  }

  /**
   * Hands-free conversation on/off. The owner’s choice is remembered.
   * Auto mode turns it on in memory when nothing was saved, without writing
   * the key, so a fresh profile is not persisted as an explicit opt-in.
   */
  setHandsFree(on: boolean, persist = true) {
    this.wakeWordRequired = !on;
    if (this.state.handsFree === on) {
      if (persist) {
        try {
          writeState(HANDS_FREE_KEY, on);
        } catch {
          /* non-fatal */
        }
      }
      return;
    }
    this.state.handsFree = on;
    if (persist) {
      try {
        writeState(HANDS_FREE_KEY, on);
      } catch {
        /* non-fatal */
      }
    }
    this.emit();
  }

  toggleHandsFree() {
    this.setHandsFree(!this.state.handsFree);
  }

  setMuted(muted: boolean) {
    if (this.state.muted === muted) return;
    this.state.muted = muted;
    if (whisperMutePlan(muted).stop) this.cancelSpeech();
    this.emit();
  }

  toggleMuted() {
    this.setMuted(!this.state.muted);
  }

  /** Full transcript, for the copy control on the caption box. */
  transcript() {
    return this.state.captions
      .map((c) => `${c.who === "user" ? "You" : "FRIDAY"}: ${c.text}`)
      .join("\n");
  }

  /* ------------------------------------------------------------ auto mode */

  /**
   * The real hardware answer: device list plus a live capture attempt with an
   * automatic fallback to the Windows default input. Only a verified failure
   * is ever reported as "no microphone".
   */
  async probeMic(): Promise<MicStatus> {
    const preferred = preferences.getSnapshot().voice.inputDeviceId || null;
    const status = await probeMicrophone(preferred, voiceGate.micStream());
    this.state.mic = status;
    this.state.micReady = status.available;
    if (status.available) {
      if (this.state.error?.startsWith("microphone")) this.state.error = null;
    } else if (status.state === "permission-required") {
      this.state.error = "microphone: permission required";
    } else if (status.reason) {
      this.state.error = `microphone: ${status.reason}`;
    }
    this.emit();
    return status;
  }

  private enterAuto() {
    // Same runtime, different shape: the brain now knows replies are spoken.
    brain.setAutoMode(true);
    if (!this.wakeWordRequired) this.state.handsFree = true;
    this.state.error = null;
    // Turning Auto Mode on is an explicit request — retry the engine now.
    this.resetVoiceRecovery();
    this.to("session-start");
    this.state.status = "Starting microphone…";
    void this.refreshWakeEngine(true);
    this.spokenUpTo = brain.getSnapshot().messages.length;
    this.unBrain = brain.subscribe(() => this.speakNewReplies());
    const preferred = preferences.getSnapshot().voice.inputDeviceId || null;
    // Acquire on the Auto Mode click before any other await so AudioContext
    // can resume. A throwaway probeMicrophone capture afterwards would fight
    // Windows exclusive-mode devices and leave the analyser silent.
    void voiceGate.acquire("auto-mode", preferred || undefined).then(async (opened) => {
      if (this.state.mode !== "auto") {
        voiceGate.release("auto-mode");
        return;
      }
      if (!opened) {
        const failed = voiceGate.lastCaptureFailure();
        if (failed) {
          this.state.mic = {
            ...EMPTY_MIC_STATUS,
            state: failed.state,
            available: false,
            reason: failed.reason,
          };
          this.state.micReady = false;
          this.reportFailure(
            failed.reason
              ? `I can't hear you — ${failed.reason}.`
              : "I can't hear you — no working microphone was found.",
            "Microphone unavailable",
          );
          this.scheduleSttRecovery(failed.reason || "microphone did not open");
          this.emit();
          return;
        }
        const status = await this.probeMic();
        if (!status.available) {
          if (status.state === "permission-required") {
            this.reportFailure(
              this.voiceOwnerGuidance(
                status.reason || "Windows has not granted FRIDAY microphone permission.",
              ),
              "Voice needs you",
            );
            this.scheduleSttRecovery(
              status.reason || "Windows has not granted FRIDAY microphone permission.",
            );
            return;
          }
          this.reportFailure(
            status.reason
              ? `I can't hear you — ${status.reason}.`
              : "I can't hear you — no working microphone was found.",
            "Microphone unavailable",
          );
          this.scheduleSttRecovery(
            status.reason
              ? `I can't hear you — ${status.reason}.`
              : "I can't hear you — no working microphone was found.",
          );
        }
        return;
      }
      const track = voiceGate.micStream()?.getAudioTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      this.state.mic = {
        ...EMPTY_MIC_STATUS,
        state: "available",
        available: true,
        deviceId: settings.deviceId ?? preferred,
        deviceLabel: track?.label || "Default microphone",
        channels: (settings as { channelCount?: number }).channelCount ?? null,
        sampleRate: (settings as { sampleRate?: number }).sampleRate ?? null,
        reason: null,
      };
      this.state.micReady = true;
      const worked = typeof settings.deviceId === "string" ? settings.deviceId : null;
      const previous = preferences.getSnapshot().voice.inputDeviceId || null;
      const next = rememberDevice(worked, previous);
      if (next && next !== previous) preferences.setVoice({ inputDeviceId: next });
      if (this.state.error?.startsWith("microphone")) this.state.error = null;
      this.emit();
    });
    void this.refreshMeeting();
    this.startRecognition();
  }

  /** A known call app pauses listening. No spoken line, so the call is not interrupted. */
  private async refreshMeeting() {
    if (preferences.getSnapshot().voice.pauseDuringCalls === false) {
      const wasHeld = this.callHold;
      this.callHold = false;
      if (wasHeld && this.state.mode === "auto" && !this.state.paused) this.startRecognition();
      return;
    }
    let meeting = false;
    try {
      const row = await desktop()?.meetingStatus?.();
      noteMicHolders(row?.names ?? []);
      meeting = Boolean(row?.meeting);
    } catch {
      noteMicHolders([]);
      /* the desktop bridge is absent in the browser preview */
    }
    if (meeting === this.callHold) return;
    this.callHold = meeting;
    if (meeting) {
      this.stopRecognition();
      this.state.status = "Paused — a call is open";
    } else if (this.state.mode === "auto" && !this.state.paused) {
      this.startRecognition();
    }
    this.emit();
  }

  private persistConduct() {
    writeState(CONDUCT_KEY, saveConduct(this.conduct));
  }

  private leaveAuto() {
    this.to("session-stop");
    brain.setAutoMode(false);
    this.unBrain?.();
    this.unBrain = null;
    this.stopRecognition();
    this.dropPlayback();
    this.cancelVoiceRecoveryTimer();
    if (this.hotplugTimer) window.clearTimeout(this.hotplugTimer);
    this.hotplugTimer = null;
    this.callHold = false;
    this.speculative = "";
    this.speculativeKind = "";
    this.narratedTool = "";
    this.partialText = "";
    voiceGate.setSpeakingGuard(false);
    voiceGate.duck(false);
    voiceGate.release("auto-mode");
    voiceGate.stop();
    if (this.awakeTimer) window.clearTimeout(this.awakeTimer);
    this.awakeTimer = null;
    this.awakeUntil = 0;
    this.state.awake = false;
    this.state.interim = "";
    this.state.pending = null;
    this.to("stopped");
    this.state.speaking = false;
    this.state.status = "Manual mode";
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* not available */
    }
  }

  /** Start FRIDAY's own on-device transcriber. Browser cloud speech is never used. */
  private startRecognition() {
    if (this.callHold) return;
    if (!microphoneAllowed(this.state.mode, this.state.paused)) {
      this.wantRunning = false;
      return;
    }
    if (this.recognitionPending || this.dictation?.active) return;
    this.recognitionPending = true;
    this.wantRunning = true;
    if (this.dictation) {
      this.recognitionPending = false;
      return;
    }
    if (Date.now() < this.sttBlockedUntil) {
      this.recognitionPending = false;
      return;
    }
    this.state.status = "Checking local speech recognition…";
    this.emit();
    const ladder = chooseStt({
      whisperCpp: false,
      modelReady: false,
      fasterWhisper: true,
      moonshine: false,
      english: false,
      cloudAllowed: false,
      network: typeof navigator === "undefined" ? false : navigator.onLine,
      cli: "whisper-cli",
      model: "ggml-base.bin",
      wav: "turn.wav",
    });
    this.state.stt = { ...this.state.stt, engine: ladder.engine };
    void sttStatus(false, true, true)
      .then((state) => {
        if (!this.wantRunning || !microphoneAllowed(this.state.mode, this.state.paused)) return;
        this.state.stt = {
          ...this.state.stt,
          engine: state.engine,
          model: state.model ?? this.state.stt.model,
          ready: Boolean(state.ready && state.engine === "faster-whisper"),
          lastError: state.ready
            ? this.state.stt.lastError
            : state.reason || this.state.stt.lastError,
        };
        if (!state.available || state.engine !== "faster-whisper" || state.ready === false) {
          this.state.listening = false;
          this.state.supported = false;
          this.reportFailure(
            state.reason ||
              "I can't hear you — local speech recognition is not installed. Install faster-whisper in Install Manager.",
            "Local speech recognition not installed",
          );
          this.scheduleSttRecovery(
            state.reason ||
              "I can't hear you — local speech recognition is not installed. Install faster-whisper in Install Manager.",
          );
          return;
        }
        this.resetVoiceRecovery();
        this.state.supported = true;
        this.startDesktopDictation();
      })
      .finally(() => {
        this.recognitionPending = false;
      });
  }

  /** Owner (or a real install) asked again — same as a manual kernel restart. */
  resetVoiceRecovery() {
    this.sttGaveUp = false;
    this.sttRecoveryAttempt = 0;
    this.sttBlockedUntil = 0;
    this.cancelVoiceRecoveryTimer();
  }

  private cancelVoiceRecoveryTimer() {
    if (this.sttRecoveryTimer !== null) {
      window.clearTimeout(this.sttRecoveryTimer);
      this.sttRecoveryTimer = null;
    }
  }

  private voiceOwnerGuidance(reason: string): string {
    const knowledge = searchExpertise(`${reason} faster-whisper microphone`, 1)[0];
    const steps = knowledge?.steps?.length
      ? knowledge.steps
      : [
          "Open Install Manager and install faster-whisper — that is FRIDAY's on-device transcriber.",
          "Windows Settings → Privacy & security → Microphone: allow FRIDAY.exe.",
          "Switch Auto Mode off and on so FRIDAY retries for real.",
        ];
    const guidance: OwnerGuidance = {
      kind: "needs-owner",
      checkId: "voice-stt",
      title: "Voice input stopped",
      reason,
      steps,
      retryable: true,
    };
    return formatGuidance(guidance);
  }

  /** Immediate retry for install, model, settings, device, focus, toggle, and Fix voice. */
  noteVoiceTrigger(trigger: string) {
    if (!shouldRetryNow(trigger)) return;
    if (this.state.mode !== "auto" || this.state.paused) return;
    this.resetVoiceRecovery();
    this.startRecognition();
  }

  fixVoice() {
    speechTurnPlan("fix voice", preferences.getSnapshot().voice.recognitionLang || "hi-IN");
    this.noteVoiceTrigger("fix-voice");
  }

  private scheduleSttRecovery(reason: string) {
    if (!this.wantRunning) return;
    const delay = recoveryDelayMs(this.sttRecoveryAttempt);
    this.sttRecoveryAttempt += 1;
    this.cancelVoiceRecoveryTimer();
    this.sttRecoveryTimer = window.setTimeout(() => {
      this.sttRecoveryTimer = null;
      if (this.wantRunning && !this.state.paused && this.state.mode === "auto") {
        this.startRecognition();
      }
    }, delay);
  }

  private startDesktopDictation() {
    if (!microphoneAllowed(this.state.mode, this.state.paused)) return;
    if (this.dictation?.active) return;
    const dictation = new DesktopDictation({
      language: preferences.getSnapshot().voice.recognitionLang || "hi-IN",
      localOnly: true,
      silenceMs: () =>
        endpointSilenceMs(Date.now() < this.awakeUntil || this.state.handsFree, this.state.interim),
      initialPrompt: () => {
        const voice = preferences.getSnapshot().voice;
        return sttInitialPrompt({
          preference: voice.recognitionLang,
          topic: conversationDigest(),
          vocab: [voice.addressName, voice.wakeWord, voice.voiceName].filter(Boolean),
        });
      },
      onSpeechStart: () => {
        this.turnClock = {
          heardAt: Date.now(),
          finalAt: null,
          tokenAt: null,
          audioAt: null,
        };
        // Barge-in: FRIDAY stops talking the moment the owner starts.
        if (this.state.speaking) {
          this.trace("speech", "barge-in — stopping playback");
          this.cancelSpeech();
        }
        this.to("vad-speech");
        this.emit();
      },
      // Low-latency wake scoring on the RAW audio when openWakeWord is really
      // installed with a model for this wake word; null → transcript fallback.
      wakeProbe: async ({ audioBase64, mime }) => {
        if (!this.state.wakeEngine.ready) return null;
        const probe = await detectWake({ audioBase64, mime, wakeWord: wakeWord() });
        if (probe) {
          this.state.lastWake = { engine: probe.engine, detail: probe.detail, at: Date.now() };
          this.emit();
        }
        return probe;
      },
      onEarlyWake: (probe) => {
        this.state.lastWake = {
          engine: probe.engine,
          detail: `early ${probe.detail}`,
          at: Date.now(),
        };
        this.to("wake-matched");
        this.emit();
      },
      onDiagnostic: (event) => {
        const size = event.bytes ? ` · ${Math.round(event.bytes / 1024)}kB` : "";
        const took = event.ms ? ` · ${event.ms}ms` : "";
        // Whisper transcribes a whole utterance at once — there is no true
        // word-by-word stream. This is the closest honest approximation of
        // "live": show a working indicator while whisper is running, then
        // the real recognized text the moment it comes back, instead of the
        // interim caption staying permanently empty (`interim` used to only
        // ever be cleared, never set — AutoMode's "Live speech streams
        // inside this same box" caption had nothing to show).
        if (event.stage === "transcribing") {
          this.state.interim = "…";
        } else if (event.stage === "transcript" && event.detail !== "(empty transcript)") {
          this.state.interim = event.detail;
        } else if (event.stage === "dropped") {
          this.state.interim = "";
        }
        this.trace(event.stage, `${event.detail}${took}${size}`);
        if (
          event.stage === "dropped" &&
          /too short|empty transcript|no-speech/.test(event.detail)
        ) {
          this.to("transcript");
        }
      },
      onFinal: (text, meta) => {
        const trimmed = text.trim();
        if (duplicateFinalUtterance(this.lastFinalText, trimmed, Date.now() - this.lastFinalAt)) {
          this.trace("dropped", "duplicate finalized utterance");
          this.state.interim = "";
          this.to("transcript");
          this.emit();
          return;
        }
        this.lastFinalText = trimmed;
        this.lastFinalAt = Date.now();
        if (this.recentlySpeaking() && this.isSelfEcho(text)) {
          this.trace("dropped", "ignored FRIDAY's own voice (echo)");
          this.to("transcript");
          return;
        }
        this.state.interim = "";
        this.state.stt = {
          ...this.state.stt,
          lastTranscript: text.slice(0, 200),
          lastError: null,
          lastLatencyMs: meta?.ms ?? null,
        };
        this.handleHeard(text, meta?.wake ?? null);
      },
      onStateChange: (listening) => {
        if (listening === "listening") this.to("mic-opened");
        else if (listening === "thinking") this.to("transcribe-start");
        // listening / status come from `to()`. Do not resurrect "Listening…"
        // (or clear a real error) when the machine stayed in ERROR/PAUSED.
        if (listening === "listening" && this.state.voiceState !== "ERROR") {
          this.state.error = null;
        }
        this.emit();
      },
      onError: (message) => {
        this.state.error = `voice: ${message}`;
        this.state.stt = { ...this.state.stt, lastError: message };
        this.to("error");
        this.state.status = "Voice error";
        this.trace("error", message);
        this.emit();
        this.dictation = null;
        this.scheduleSttRecovery(`voice: ${message}`);
      },
    });
    this.dictation = dictation;
    void dictation.start().then((ok) => {
      if (this.dictation !== dictation) return;
      if (!ok) {
        this.dictation = null;
        this.state.listening = false;
        this.state.supported = false;
        this.reportFailure(
          this.state.error ||
            "I can't start listening — local speech recognition is not installed. Install faster-whisper in Install Manager.",
          "Local speech recognition not installed",
        );
        this.scheduleSttRecovery(
          this.state.error ||
            "I can't start listening — local speech recognition is not installed. Install faster-whisper in Install Manager.",
        );
      } else {
        this.resetVoiceRecovery();
      }
    });
  }

  private stopRecognition() {
    this.wantRunning = false;
    const dictation = this.dictation;
    this.dictation = null;
    try {
      dictation?.stop();
    } catch {
      /* already stopped */
    }
    this.state.listening = false;
    this.emit();
  }

  /**
   * Ask the main process which wake detector is really available and remember
   * it, so the HUD and diagnostics show the truth rather than an assumption.
   */
  async refreshWakeEngine(force = false): Promise<WakeEngineStatus> {
    const status = await wakeEngineStatus(wakeWord(), force);
    this.state.wakeEngine = status;
    this.trace(
      "wake",
      status.ready
        ? `wake engine: ${status.engine} (${status.model ?? "model"})`
        : `wake engine: transcript fallback — ${status.reason ?? "openWakeWord unavailable"}`,
    );
    this.emit();
    return status;
  }

  /**
   * Real post-install verification: faster-whisper imports AND loads its model,
   * edge-tts imports AND lists a voice. Only then is voice genuinely ready.
   */
  async verifyVoiceRuntime(): Promise<{
    ok: boolean;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }> {
    const api = desktop();
    if (!api?.verifyVoiceRuntime)
      return {
        ok: false,
        checks: [
          { id: "desktop", label: "Desktop runtime", ok: false, detail: "desktop app required" },
        ],
      };
    const result = await api.verifyVoiceRuntime({ loadModel: true });
    this.state.stt = { ...this.state.stt, ready: Boolean(result?.ok) };
    if (result?.ok) this.noteVoiceTrigger("model-ready");
    for (const check of result?.checks ?? [])
      this.trace(check.ok ? "segment" : "error", `${check.label}: ${check.detail}`);
    this.emit();
    return { ok: Boolean(result?.ok), checks: result?.checks ?? [] };
  }

  /**
   * The single place the voice state changes. Every caller reports a real
   * pipeline EVENT; the transition table decides the state, and `listening` /
   * `speaking` / the status line are derived from it, so the UI can never show
   * "Listening…" while the microphone is shut.
   */
  private to(event: VoiceEvent, detail?: string) {
    const from = this.state.voiceState;
    const next = nextVoiceState(from, event);
    if (!next) {
      // Not a legal event here — recorded, never silently applied.
      if (detail)
        this.trace("dropped", `${event} ignored in ${from}${detail ? ` · ${detail}` : ""}`);
      return false;
    }
    this.state.voiceState = next;
    this.state.listening = stateIsListening(next);
    this.state.speaking = stateIsSpeaking(next);
    this.state.status = stateLabel(next);
    if (next !== from && detail) this.trace("segment", `${from} → ${next} (${event}) · ${detail}`);
    return true;
  }

  /** Record one pipeline step. Never throws, never blocks the audio path. */
  private trace(stage: VoiceTrace["stage"], detail: string) {
    this.state.voiceLog = [
      ...this.state.voiceLog.slice(-(MAX_VOICE_LOG - 1)),
      { at: Date.now(), stage, detail },
    ];
    this.emit();
  }

  private setAwake() {
    this.awakeUntil = Date.now() + AWAKE_MS();
    this.state.awake = true;
    if (this.awakeTimer) window.clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => {
      if (Date.now() >= this.awakeUntil) {
        this.state.awake = false;
        this.state.status = this.state.pending
          ? "Waiting for confirmation"
          : stateLabel(this.state.voiceState);
        this.emit();
      }
    }, AWAKE_MS() + 200);
  }

  private handleHeard(text: string, probe: WakeProbe | null = null) {
    // Noise gate: the recogniser sometimes turns a cough, a keyboard or the TV
    // into a one or two word "command". Anything short that the signal-level
    // VAD never classified as speech is dropped instead of acted on.
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    this.trace("transcript", text.slice(0, 160));
    // Whisper transcription takes real time (often 1-3s for a short clip), so
    // the old 1.5s window had usually already expired by the time the text
    // arrived — which silently ate short commands, "friday" included.
    if (words <= 2 && !isStopCommand(text) && !voiceGate.heardSpeechWithin(6000)) {
      this.trace("dropped", `"${text.trim()}" — too short and no verified speech signal`);
      this.state.interim = "";
      this.emit();
      return;
    }
    const corrected = applyCorrections(text);
    const heardLang = languageId(corrected);
    noteStyleCorrection(corrected);
    const repeat = confidenceRepeat(corrected, utteranceConfidence(corrected));
    if (/\bnot\b.+\bbut\b/i.test(text)) learnCorrection(text, corrected);
    noteArc({
      topic: corrected.slice(0, 120),
      feeling: heardLang,
      at: Date.now(),
      source: "voice",
    });
    if (repeat && !isStopCommand(corrected)) {
      this.caption("friday", repeat);
      this.speak(repeat);
      this.state.interim = "";
      this.emit();
      return;
    }
    text = corrected;
    this.state.heard = text.slice(0, 160);

    // 1. A consequential command is waiting for a yes/no.
    if (this.state.pending) {
      if (!approvalFresh(this.state.pending.at, Date.now())) {
        this.state.pending = null;
        this.remember("approval-expired", text, "dropped");
        this.caption("friday", "That confirmation expired. Ask again if you still want it.");
        this.state.status = "Confirmation expired";
        this.emit();
        this.speak("That confirmation expired. Ask again if you still want it.");
        return;
      }
      if (isBoundConfirmation(text, (value) => AFFIRM.test(value))) {
        const cmd = this.state.pending.command;
        this.state.pending = null;
        this.to("confirm-resolved");
        this.remember("confirmed", text, cmd);
        this.caption("user", text);
        this.state.status = "Confirmed — running";
        this.emit();
        this.dispatch(cmd);
        return;
      }
      if (DENY.test(text)) {
        this.state.pending = null;
        this.caption("user", text);
        this.caption("friday", "Cancelled. Nothing was executed.");
        this.state.status = "Cancelled";
        this.emit();
        this.speak("Cancelled. Nothing was executed.");
        return;
      }
      // Anything else while a confirmation is open is ignored on purpose.
      this.emit();
      return;
    }

    // openWakeWord is the ACTIVE detector whenever it really ran on this clip;
    // the transcript matcher stays as the documented fallback (and still does
    // the work of splitting the wake word off the command).
    const transcriptWake = matchWakeWord(text, wakeWord());
    // Either detector waking FRIDAY is enough. openWakeWord scores raw audio
    // and can miss a clearly spoken name (weak or missing model); the
    // transcript matcher is a real, equal detection path, not a consolation
    // prize — so a name that is visible in the transcript always counts.
    const matched = Boolean(probe?.detected) || transcriptWake.matched;
    const wake = {
      matched,
      command: transcriptWake.command,
      detail: probe
        ? transcriptWake.matched && !probe.detected
          ? `${probe.detail} · transcript matched "${transcriptWake.token}"`
          : probe.detail
        : transcriptWake.detail,
    };
    this.state.lastWake = {
      engine: probe?.detected ? probe.engine : "transcript",
      detail: wake.detail,
      at: Date.now(),
    };
    if (foreignAssistant(text) && !matched) {
      this.trace("dropped", "addressed to another assistant");
      this.remember("not-addressed", text, "ignored");
      this.emit();
      return;
    }
    const awake = Date.now() < this.awakeUntil;
    const accepted = acceptsVoiceTurn({
      mode: this.state.mode,
      paused: this.state.paused,
      wakeMatched: wake.matched,
      awake,
      handsFree: this.state.handsFree,
      wakeWordRequired: this.wakeWordRequired,
      words,
      stop: isStopCommand(text),
    });
    this.trace(
      "wake",
      wake.matched
        ? wake.detail
        : accepted
          ? awake
            ? "already awake — no wake word needed"
            : "hands-free — treated as a request"
          : "no wake word, not awake, not a hands-free turn",
    );
    if (!accepted) {
      this.to("wake-missed");
      this.state.status = "Say “FRIDAY …” to start";
      this.emit();
      return;
    }
    const command = (wake.matched ? wake.command : text).trim();
    if (wake.matched && !command && wakeOnCooldown(Date.now(), this.lastWakeAt)) {
      this.trace("dropped", "wake word repeated inside the cooldown");
      this.remember("wake-cooldown", text, "dropped");
      this.emit();
      return;
    }
    if (wake.matched) this.lastWakeAt = Date.now();
    this.turnClock = { ...this.turnClock, finalAt: Date.now() };
    this.to("wake-matched");
    // "FRIDAY, stop" is an interruption, never a task: cut the reply short and
    // go straight back to listening instead of sending "stop" to the brain.
    if (isStopCommand(text)) {
      this.trace("wake", "stop word — cancelling speech and the in-flight turn");
      this.cancelSpeech();
      this.state.status = "Stopped — listening";
      this.emit();
      return;
    }

    this.setAwake();
    // Heard while FRIDAY is hidden in the tray: bring her up so the owner can
    // see the answer, exactly as if the tray icon had been clicked.
    if (typeof document !== "undefined" && document.hidden) {
      try {
        desktop()?.showWindow?.();
      } catch {
        /* browser preview — nothing to un-hide */
      }
    }

    if (!command) {
      this.caption("friday", "Yes?");
      this.state.status = "Awake — go ahead";
      this.emit();
      this.speak("Yes?");
      return;
    }
    this.caption("user", command);

    if (wantsContinue(command) && this.unfinished) {
      const rest = this.unfinished;
      this.unfinished = "";
      this.remember("continue", command, "resumed");
      this.speak(`Continuing. ${rest}`);
      return;
    }
    if (this.speculative && command === this.speculative && this.speculativeKind === "brain") {
      this.speculative = "";
      this.speculativeKind = "";
      this.remember("speculative", command, "already-started");
      return;
    }
    if (this.speculative) {
      if (this.speculativeKind === "brain") {
        brain.stop();
        this.dropPlayback();
      }
      this.speculative = "";
      this.speculativeKind = "";
    }
    const voicePrefs = preferences.getSnapshot().voice;
    const conduct = reduceVoice(this.conduct, command, Date.now(), {
      quiet: !alertsAudible(),
      meeting: this.callHold,
      address: voicePrefs.addressName,
    });
    if (conduct.handled) {
      this.conduct = conduct.state;
      this.persistConduct();
      if (conduct.halt) {
        this.cancelSpeech();
        this.state.pending = null;
      }
      this.remember(conduct.decision, command, conduct.action);
      this.caption("friday", conduct.spoken);
      this.state.status = conduct.spoken;
      this.emit();
      this.speak(conduct.spoken);
      return;
    }
    const cue = backchannel({
      hold: isHoldSound(command),
      usedThisTurn: this.backchannelUsed,
      mode: this.state.mode,
    });
    if (cue) {
      this.backchannelUsed = true;
      this.remember("backchannel", command, "held");
      this.speak(cue);
      return;
    }

    // 2. Consequential actions, and speech that tries to rewrite the rules,
    // always get an explicit confirmation. Speech never approves itself.
    // A speaker score is an extra signal only. No saved voiceprint means
    // the line is still heard, and a match still does not run the action.
    const heardSensitive =
      voiceClaimsAuthority(command) || commandNeedsApproval(command, this.state.mode);
    const speaker = speakerDecision({
      similarity: null,
      enrolled: false,
      sensitive: heardSensitive,
    });
    if (!speaker.allow) {
      const refused = "That did not match the saved voice. Confirm it on the desktop.";
      this.remember("speaker-mismatch", command, "blocked");
      this.caption("friday", refused);
      this.speak(refused);
      this.emit();
      return;
    }
    if (heardSensitive) {
      this.state.pending = {
        command,
        reason: approvalReason("exec", this.state.mode),
        at: Date.now(),
      };
      const ask = `Confirm: should I ${command}? Say yes to proceed, or no to cancel.`;
      this.caption("friday", ask);
      this.to("confirm-required");
      this.state.status = "Waiting for confirmation";
      this.emit();
      this.speak(ask);
      this.remember("needs-approval", command, "paused");
      return;
    }

    const clarify = clarifyPrompt(command);
    if (clarify) {
      this.remember("clarify", command, "asked");
      this.caption("friday", clarify);
      this.speak(clarify);
      this.emit();
      return;
    }

    this.backchannelUsed = false;
    this.remember("accepted", command, "dispatch");
    this.emit();
    this.dispatch(command);
  }

  /**
   * Say (and show) that a voice turn could not go through. Silence is itself a
   * bug in Auto Mode: the owner is not looking at the screen, so every failed
   * stage has to be audible as well as visible.
   */
  private reportFailure(message: string, status = "Voice error") {
    this.to("error");
    this.state.error = `${message}\nFix voice`;
    this.state.status = status;
    const cause = failureCause(message);
    this.lastFailure = cause;
    this.caption("friday", message);
    if (!mayAnnounce(cause, this.spokenCauses)) {
      this.emit();
      return;
    }
    this.spokenCauses.add(cause);
    const spoken = voiceFailureLine(
      cause,
      this.spokenCauses.size,
      ownerVoiceLang(preferences.getSnapshot().voice.recognitionLang),
    );
    this.emit();
    this.speak(spoken);
  }

  /** Run a command through the existing brain pipeline. */
  private dispatch(command: string) {
    this.dropPlayback();
    this.voicedRunId = "";
    this.voicedChars = 0;
    this.to("command-accepted");
    this.state.status = "Thinking…";
    this.emit();
    // Voice turns carry exactly the same attached capabilities and pinned
    // models as typed turns, so manual and auto mode stay continuous.
    const { extra, modelIds } = composer.directive();
    const merged = mergeTurnExtra(extra, turnAwarenessExtra(command, { kind: "voice" }));
    const payload = {
      ...(merged ? { extra: merged } : {}),
      ...(modelIds.length ? { modelIds } : {}),
      routingSurface: "voice" as const,
    };
    this.pendingUserEcho += 1;
    let result = brain.send(command, payload);
    // A new spoken command is an interrupt: stop the in-flight turn, then start.
    if (!result.accepted && result.reason === "busy") {
      brain.stop();
      result = brain.send(command, payload);
    }
    if (!result.accepted) {
      this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
      this.reportFailure(
        result.message || "I couldn't start that request.",
        result.reason === "busy" ? "Still working on the last request" : "Nothing to run",
      );
    }
  }

  /** Confirm / cancel from the Auto Mode screen (same path as speech). */
  confirmPending(ok: boolean) {
    const pending = this.state.pending;
    if (!pending) return;
    if (!approvalFresh(pending.at, Date.now())) {
      this.state.pending = null;
      this.remember("approval-expired", pending.command, "dropped");
      this.caption("friday", "That confirmation expired. Ask again if you still want it.");
      this.state.status = "Confirmation expired";
      this.emit();
      return;
    }
    this.state.pending = null;
    this.to("confirm-resolved");
    if (ok) {
      this.state.status = "Confirmed — running";
      this.emit();
      this.dispatch(pending.command);
    } else {
      this.caption("friday", "Cancelled. Nothing was executed.");
      this.state.status = "Cancelled";
      this.emit();
      this.speak("Cancelled. Nothing was executed.");
    }
  }

  /** Stop playback without touching the brain. A newer clip must not start. */
  private dropPlayback(hold = true) {
    if (hold && (this.state.speaking || this.speechQueue.length)) {
      const held = holdInterrupted([this.spokenText, ...this.speechQueue]);
      if (held) this.unfinished = held;
    }
    this.speechGen += 1;
    this.speechQueue = [];
    stopSpeaking();
    voiceGate.setSpeakingGuard(false);
    this.state.speaking = false;
    this.echoUntil = Date.now() + 800;
  }

  private cancelSpeech() {
    this.dropPlayback();
    brain.stop();
    this.to("barge-in");
  }

  private recentlySpeaking(): boolean {
    return this.state.speaking || Date.now() < this.echoUntil;
  }

  /** True when the recognised text is just FRIDAY's own voice coming back. */
  private isSelfEcho(heard: string): boolean {
    return isSelfEchoTranscript(heard, this.spokenText);
  }

  private remember(decision: string, heard: string, action: string) {
    this.audit = pushVoiceAudit(this.audit, {
      at: Date.now(),
      heard: heard.slice(0, 160),
      decision,
      action: action.slice(0, 160),
    });
  }

  private speak(text: string) {
    if (this.turnClock.tokenAt == null) this.turnClock = { ...this.turnClock, tokenAt: Date.now() };
    if (!spokenReplyAllowed(this.state.mode, this.state.muted)) return;
    if (!preferences.getSnapshot().voice.speakReplies) return;
    // Only ever speak the hearable form: no markdown, no code, two sentences.
    const spoken = spokenSummary(preferSpoken(text));
    if (!spoken) return;
    this.speechQueue.push(spoken);
    void this.drainSpeech();
  }

  private async drainSpeech() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.speechQueue.length) {
        if (!spokenReplyAllowed(this.state.mode, this.state.muted)) {
          this.speechQueue = [];
          break;
        }
        const spoken = this.speechQueue.shift();
        if (!spoken) break;
        const gen = this.speechGen;
        await this.playSpoken(spoken, gen);
        if (gen !== this.speechGen) break;
      }
    } finally {
      this.draining = false;
      if (this.speechQueue.length && spokenReplyAllowed(this.state.mode, this.state.muted)) {
        void this.drainSpeech();
      }
    }
  }

  /**
   * Play one clip. A barge-in bumps speechGen, and a late neural buffer from
   * the old clip must not start. The microphone stays open so the owner can
   * interrupt; isSelfEcho drops FRIDAY's own voice.
   */
  private playSpoken(spoken: string, gen: number): Promise<void> {
    if (gen !== this.speechGen) return Promise.resolve();
    if (!spokenReplyAllowed(this.state.mode, this.state.muted)) return Promise.resolve();
    if (this.turnClock.audioAt == null) {
      this.turnClock = { ...this.turnClock, audioAt: Date.now() };
      const latency = firstAudioLatency(this.turnClock.tokenAt, this.turnClock.audioAt);
      if (latency != null) {
        voiceBudgets({ listenMs: 1000, audioMs: latency, idleCpu: [0.2], memoryMb: [100, 100] });
      }
    }
    const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    const engine = chooseTtsEngine({
      network: online,
      supertonicReady: this.offlineVoiceReady,
      privacy: preferences.getSnapshot().voice.privacyMode === true,
      prefer: "auto",
    });
    const fallen = switchMidSentence({
      networkDropped: !online,
      current: engine,
      supertonicReady: this.offlineVoiceReady,
    });
    this.state.tts = { ...this.state.tts, engine: fallen };
    const tuning = activeVoiceSettings();
    const voicePrefs = preferences.getSnapshot().voice;
    const spokenLang = voiceForLanguage(voicePrefs.speechLang || voicePrefs.recognitionLang);
    const lastOwner =
      [...this.state.captions].reverse().find((row) => row.who === "user")?.text ?? "";
    const tone = speakingProsody({
      baseRate: tuning.rate,
      basePitch: tuning.pitch,
      baseVolume: tuning.volume,
      affect: /!/.test(spoken) ? "urgent" : prosodyAffect(readFeeling(lastOwner).label),
      quiet: !alertsAudible(),
      whisper: voicePrefs.whisperMode === true,
    });
    const privacy = voicePrefs.privacyMode === true;
    const localVoice = fallen !== "neural" || privacy;
    const out = outputReachable({ deviceId: "default", volume: tone.volume });
    if (!out.ok) this.state.status = out.reason;
    this.spokenText = spoken;
    return speakText(
      spoken,
      {
        ...tuning,
        lang: spokenLang.lang || tuning.lang || "hi-IN",
        rate: tone.rate,
        pitch: tone.pitch,
        volume: tone.volume,
        ...(localVoice
          ? {
              voiceName: "",
              kind: (fallen === "sapi" || privacy ? "system" : "neural") as "system" | "neural",
            }
          : {}),
      },
      {
        onStart: () => {
          if (gen !== this.speechGen) return;
          this.echoUntil = Date.now() + 120_000;
          if (this.to("tts-start")) this.pauseForSpeech();
          this.emit();
        },
        onEnd: () => {
          if (gen !== this.speechGen) return;
          this.echoUntil = Date.now() + 1500;
          this.to("tts-end");
          if (this.state.pending && this.state.voiceState !== "WAITING_CONFIRMATION") {
            this.to("confirm-required");
          }
          // Stay honest: tts-end is ignored in ERROR/PAUSED, so do not
          // overwrite the failure/paused status with "Listening…".
          if (
            this.state.mode === "auto" &&
            this.state.voiceState !== "ERROR" &&
            this.state.voiceState !== "PAUSED" &&
            this.state.voiceState !== "OFF" &&
            this.state.voiceState !== "STOPPING"
          ) {
            this.resumeAfterSpeech();
          }
          this.emit();
        },
      },
    )
      .then((how) => {
        if (gen !== this.speechGen) return;
        this.state.tts = {
          engine: how,
          voice: tuning.voiceName || "",
          lastSpokenAt: how === "none" ? this.state.tts.lastSpokenAt : Date.now(),
          lastError: how === "none" ? "no speech engine could speak the reply" : null,
        };
        this.trace("segment", `tts engine: ${how.toUpperCase()}`);
        if (how !== "none") return;
        this.to("tts-failed");
        this.state.speaking = false;
        voiceGate.setSpeakingGuard(false);
        this.echoUntil = Date.now() + 400;
        this.state.error =
          "voice output failed — no speech engine could speak the reply (install a voice in Install Manager)";
        this.emit();
      })
      .catch((error: unknown) => {
        if (gen !== this.speechGen) return;
        const detail = String((error as Error)?.message || error);
        this.state.tts = { ...this.state.tts, engine: "none", lastError: detail };
        this.to("tts-failed");
        this.state.speaking = false;
        voiceGate.setSpeakingGuard(false);
        this.state.error = `voice output failed — ${detail}`;
        this.emit();
      });
  }

  /** Speak finished sentences of a live answer, then the tail when it ends. */
  private speakStreamed(runId: string, text: string, final: boolean) {
    if (!text.trim()) return;
    if (this.voicedRunId !== runId) {
      this.voicedRunId = runId;
      this.voicedChars = 0;
    }
    const rewind = nextSpokenCursor(this.voicedChars, text.length);
    if (rewind.rewritten) {
      this.unfinished = "";
      this.dropPlayback(false);
      this.voicedChars = 0;
    }
    if (text.length < this.voicedChars) return;
    const pending = text.slice(this.voicedChars);
    const chunk = takeSpeakable(pending, final);
    if (!chunk.spoken) return;
    this.voicedChars += chunk.consumed;
    this.speak(chunk.spoken);
    if (final && this.state.mode === "auto" && this.chartOfferedFor !== runId) {
      this.chartOfferedFor = runId;
      const line = armChartOffer(
        "voice",
        voiceAutoGraph({
          voiceState: this.state.voiceState,
          error: this.state.error,
          paused: this.state.paused,
          wakeWord: preferences.getSnapshot().voice.wakeWord,
          lastWake: this.state.lastWake?.detail || "",
          stt: this.state.stt,
          tts: this.state.tts,
        }),
      );
      this.caption("friday", line);
      this.speak(line);
    }
  }

  /** Keep the local listener live so speech can interrupt FRIDAY (barge-in). */
  private pauseForSpeech() {
    voiceGate.setSpeakingGuard(true);
    voiceGate.duck(false);
  }

  private resumeAfterSpeech() {
    voiceGate.setSpeakingGuard(false);
    voiceGate.duck(false);
    if (
      resumeAfterSpokenReply({
        mode: this.state.mode,
        paused: this.state.paused,
        dictationActive: Boolean(this.dictation?.active),
      })
    ) {
      this.startRecognition();
    }
  }

  /**
   * Turn a real reply into something worth *showing* in the caption box.
   * Only structure that is actually present in the answer is surfaced —
   * nothing is invented.
   */
  private displayFor(text: string): PanelDisplay | null {
    const fence = /```(\w+)?\n([\s\S]*?)```/.exec(text);
    if (fence) {
      const lang = fence[1];
      return {
        kind: "code",
        title: "Output",
        code: fence[2]?.trim() ?? "",
        ...(lang ? { lang } : {}),
      };
    }

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const bullets = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
    if (bullets.length >= 2) {
      return {
        kind: "list",
        title: "Details",
        items: bullets.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "")),
      };
    }
    if (text.length > 260) return { kind: "text", title: "Details", text };
    return null;
  }

  /** Read back FRIDAY's answers while auto mode is on. */
  private speakNewReplies() {
    if (!spokenReplyAllowed(this.state.mode, false)) return;
    const { messages, activeRunId, runs } = brain.getSnapshot();
    if (messages.length === 0) {
      if (this.spokenUpTo !== 0 || this.state.captions.length) {
        this.clearCaptions();
        this.spokenUpTo = 0;
      }
      return;
    }
    if (activeRunId) {
      // Caption the owner's line as soon as it lands. A finished sentence of
      // the live answer is spoken now; the tail waits until the turn ends.
      const pending = messages.slice(this.spokenUpTo);
      let consumed = 0;
      for (const message of pending) {
        if (message.role !== "user") break;
        this.captionUserTurn(message.text);
        consumed += 1;
      }
      this.spokenUpTo += consumed;
      const live = runs.find((run) => run.id === activeRunId);
      const step = [...(live?.trace ?? [])].reverse().find((row) => row.state === "running");
      const narration = toolNarration(step);
      const toolKey = live && step ? `${live.id}:${step.id}` : "";
      if (narration && toolKey && toolKey !== this.narratedTool && !this.callHold) {
        this.narratedTool = toolKey;
        this.speak(narration);
      }
      if (live?.answer) this.speakStreamed(live.id, live.answer, false);
      return;
    }
    if (messages.length <= this.spokenUpTo) {
      this.spokenUpTo = messages.length;
      return;
    }
    const fresh = messages.slice(this.spokenUpTo);
    this.spokenUpTo = messages.length;
    for (const message of fresh) {
      if (message.role === "user") this.captionUserTurn(message.text);
    }
    const say = fresh
      .filter((m) => m.role !== "user")
      .map((m) => m.text)
      .join(". ")
      .trim();
    if (!say) {
      this.emit();
      return;
    }
    this.to("brain-replied");
    this.caption("friday", say);
    this.setAwake();
    // FRIDAY manages her own box: show structured content, expand when needed.
    const display = this.displayFor(say);
    if (display) this.show(display);
    else this.clearDisplay();
    this.emit();
    const runId = fresh.find((message) => message.role !== "user")?.runId || this.voicedRunId;
    this.speakStreamed(runId || "reply", say, true);
  }
}

export const assistantMode = new AssistantModeStore();

bindVoiceSurface(() => {
  const live = assistantMode.getSnapshot();
  return { mode: live.mode, muted: live.muted };
});
