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
import { appControlNeedsApproval, selfLifecycleAction } from "./app-control";
import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { composer } from "./composer";
import { armChartOffer, voiceAutoGraph } from "./flow-modes";
import { decideAddressing, normalizeAddressMode, type AddressDecision } from "./addressing";
import {
  ambientContextForRoute,
  clearHeard,
  dropHeardOverflow,
  heardSummary,
  noteHeard,
} from "./heard-log";
import { allowRestart, encodeWav, preRollFrom } from "./pcm-capture";
import { desktopApi } from "./desktop";
import {
  dropLine,
  hearingCounters,
  hearingVerdict,
  keepUtteranceWavs,
  MIC_TEST_MS,
  recordFromStream,
} from "./voice-hearing";
import {
  isHoldKey,
  normalizeListenStyle,
  pttActive,
  pttAdmits,
  pttPress,
  pttRelease,
  pttToggle,
  resetPtt,
  type ListenStyle,
} from "./push-to-talk";
import { assessTone, type VoiceTone } from "./voice-tone";
import {
  beginVoiceTurn,
  markTurnStage,
  turnTraceLine,
  voiceTurn,
  whereItStopped,
} from "./voice-turn-trace";
import { registerVoiceHealth } from "./voice-health";
import { preferences } from "./preferences";
import { mergeTurnExtra, turnAwarenessExtra } from "./turn-awareness";
import { conversationDigest } from "./brain/conversation-state";
import { attentionWindowMs } from "./attention-window";
import { preferSpoken } from "./conversation-style";
import {
  activeVoiceSettings,
  lastSpeechRoute,
  speakText,
  spokenSummary,
  statusWithVoice,
  stopSpeaking,
} from "./voice-library";
import { formatVoiceProbeReport, noteVoiceCheck } from "./voice-doctor";
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
  createNarrator,
  whileBusy,
  isHoldSound,
  microphoneAllowed,
  pushVoiceAudit,
  speakerDecision,
  prosodyAffect,
  speakingProsody,
  spokenReplyAllowed,
  spokenRouteError,
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
import { applySession, savedInputPlan } from "./mic-session";
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
  listAudioDevices,
  noteMicHolders,
  probeMicrophone,
  voiceGate,
  type MicStatus,
} from "./voice-audio";
import { rememberDevice } from "./mic-truth";
import { readFeeling } from "./brain/affect";
import { DesktopDictation, reclaimUnowned, sttInitialPrompt, sttStatus } from "./voice-stt";
import { isSelfEchoTranscript, isStopCommand, matchWakeWord } from "./wake-word";
import { alertsAudible } from "./settings-runtime";
import {
  EMPTY_CONDUCT,
  loadConduct,
  offersShowHow,
  partialPlan,
  reduceVoice,
  saveConduct,
  toolNarration,
  type ConductState,
} from "./assistant-conduct";
import { searchExpertise } from "./brain/expertise";
import { formatGuidance, type OwnerGuidance } from "./doctor-engine";
import { speechTurnPlan } from "./speech-core";
import { chooseStt, liveSttFromStatus, rememberLiveStt, whisperMutePlan } from "./speech-stt";
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
  emptyHealMemory,
  healFault,
  noteHealFixed,
  planVoiceHeal,
  spokenRepairLine,
  type HealClass,
  type HealMemory,
} from "./voice-heal";
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
  tag?: "addressed" | "ambient" | "self";
  confidence?: number;
  language?: string;
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
  stage:
    "speech" | "segment" | "dropped" | "transcribing" | "transcript" | "wake" | "error" | "heal";
  detail: string;
  repeat?: number;
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
  onPttToggle?: (cb: (payload: unknown) => void) => () => void;
  setPttShortcut?: (on: boolean) => Promise<{ ok: boolean; accelerator: string; reason: string }>;
  onVoicePartial?: (cb: (payload: { text?: string }) => void) => () => void;
  onSystemResume?: (cb: () => void) => () => void;
  /** Real faster-whisper / edge-tts probes run by the main process. */
  verifyVoiceRuntime?: (payload?: { loadModel?: boolean; model?: string }) => Promise<{
    ok: boolean;
    python: string | null;
    checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  }>;
  meetingStatus?: () => Promise<{ meeting?: boolean; names?: string[] }>;
  onSttProgress?: (
    cb: (payload: { status?: string; progress?: number | null }) => void,
  ) => () => void;
  installStt?: () => Promise<{ ok: boolean; error?: string }>;
  installWakeEngine?: () => Promise<{ ok: boolean; ready?: boolean; error?: string }>;
  restartKernel?: () => Promise<{ ok: boolean }>;
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
  private healMemory: HealMemory = emptyHealMemory();
  private lastHealFault: HealClass | "none" = "none";
  /** Fix voice is the one confirm before a pinned PyAV reinstall. */
  private sttRepairConfirmed = false;
  private ttsPrefer: "auto" | "supertonic" | "sapi" = "auto";
  private wakeOnlyUnsub: (() => void) | null = null;
  private wakeOnlySpeechAt = 0;
  private quietHealSent = false;
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
  private holdTimers: ReturnType<typeof setTimeout>[] = [];
  private voicedChars = 0;
  /** A failed turn speaks its short line once. The partial answer is not restarted. */
  private voicedFaultFor = "";
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
  private followUpUntil = 0;
  private readonly micRestarts: number[] = [];
  private shownMicFault = "";
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
  /** What she says while work runs: varied, sparse, never twice the same. */
  private narrator = createNarrator();
  /** Requests heard while a turn ran; each runs once the one before has finished and been spoken. */
  private queuedCommands: string[] = [];
  private queueTimer: ReturnType<typeof setInterval> | null = null;
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
    this.state.supported = Boolean(navigator.mediaDevices?.getUserMedia);
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
    document.documentElement.classList.toggle("friday-hidden", document.hidden);
    document.addEventListener("visibilitychange", () => {
      document.documentElement.classList.toggle("friday-hidden", document.hidden);
      if (this.state.mode !== "auto" || this.state.paused) return;
      if (document.hidden) return;
      const track = voiceGate.micStream()?.getAudioTracks()[0];
      const dead = !track || track.readyState === "ended";
      const ctx = voiceGate.contextState();
      const suspended = ctx === "suspended" || ctx === "closed" || ctx === "missing";
      if (suspended && !dead) {
        this.applyVoiceHeal("audio-context-suspended", false);
        return;
      }
      if (dead) {
        this.applyVoiceHeal("mic-no-device", false);
        return;
      }
      if (!this.dictation?.active) this.noteVoiceTrigger("focus");
    });
    desktop()?.onSystemResume?.(() => {
      if (this.state.mode !== "auto" || this.state.paused) return;
      this.trace("segment", "sleep-resume — reopening the microphone");
      this.applyVoiceHeal("mic-no-device", false);
    });
    voiceGate.subscribe(() => {
      if (this.state.mode !== "auto" || this.quietHealSent) return;
      if (!voiceGate.quietNotice()) return;
      this.quietHealSent = true;
      this.applyVoiceHeal("vad-too-quiet", false);
    });
    desktop()?.onVoicePartial?.((payload) => {
      const text = String(payload?.text || "").trim();
      if (!text || this.state.mode !== "auto") return;
      this.state.interim = text;
      this.emit();
    });
    desktop()?.onSttProgress?.((payload) => {
      if (this.state.mode !== "auto") return;
      const text = String(payload?.status || "").slice(0, 80);
      if (!text) return;
      const pct =
        typeof payload?.progress === "number"
          ? ` ${Math.max(0, Math.min(100, Math.round(payload.progress)))}%`
          : "";
      this.state.status = `${text}${pct}`;
      this.emit();
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
      if (this.hotplugTimer) window.clearTimeout(this.hotplugTimer);
      this.hotplugTimer = window.setTimeout(() => {
        this.hotplugTimer = null;
        void this.reopenInput("hotplug");
      }, 400);
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

  private caption(
    who: Caption["who"],
    text: string,
    partial = false,
    meta?: { tag?: Caption["tag"]; confidence?: number; language?: string },
  ) {
    const list = this.state.captions.slice();
    const last = list[list.length - 1];
    if (last && last.partial && last.who === who) list.pop();
    list.push({
      id: captionId(),
      who,
      text,
      at: Date.now(),
      partial,
      ...(meta?.tag ? { tag: meta.tag } : {}),
      ...(typeof meta?.confidence === "number" ? { confidence: meta.confidence } : {}),
      ...(meta?.language ? { language: meta.language } : {}),
    });
    this.state.captions = list.slice(-MAX_CAPTIONS);
  }

  clearHeardLog() {
    clearHeard();
    this.emit();
  }

  /** Three seconds on the open Auto microphone, then the real transcriber. */
  async micTest(onLevel?: (level: number) => void): Promise<{ stage: string; line: string }> {
    const device = this.state.mic.deviceLabel || "default device";
    const stream = voiceGate.micStream();
    if (!stream) {
      const verdict = hearingVerdict({
        rms: 0,
        peak: 0,
        transcript: "",
        error: "no microphone stream",
        deviceLabel: device,
        contextRate: voiceGate.inputRate(),
      });
      this.trace("segment", `mic test: ${verdict.line}`);
      return verdict;
    }
    try {
      const clip = await recordFromStream(stream, MIC_TEST_MS, onLevel);
      const api = desktopApi();
      if (!api?.transcribe) {
        const verdict = hearingVerdict({
          rms: clip.rms,
          peak: clip.peak,
          transcript: "",
          error: "no transcribe bridge",
          deviceLabel: clip.deviceLabel || device,
          contextRate: clip.contextRate,
        });
        this.trace("segment", `mic test: ${verdict.line}`);
        return verdict;
      }
      const result = await api.transcribe({
        audioBytes: clip.wav,
        mime: "audio/wav",
        localOnly: true,
        ...(keepUtteranceWavs() ? { keepWav: true } : {}),
      });
      const verdict = hearingVerdict({
        rms: clip.rms,
        peak: clip.peak,
        transcript: result?.text || "",
        emptyReason: result?.emptyReason || result?.audio?.emptyReason || "",
        error: result?.ok ? "" : result?.error || "transcription failed",
        deviceLabel: clip.deviceLabel || device,
        contextRate: clip.contextRate,
      });
      this.trace("segment", `mic test: ${verdict.line}`);
      return verdict;
    } catch (error) {
      const verdict = hearingVerdict({
        rms: 0,
        peak: 0,
        transcript: "",
        error: String((error as Error)?.message || error),
        deviceLabel: device,
        contextRate: voiceGate.inputRate(),
      });
      this.trace("segment", `mic test: ${verdict.line}`);
      return verdict;
    }
  }

  /** One short line through the Auto speech path. Manual and chat stay silent. */
  async speakTest(): Promise<{ ok: boolean; engine: string; detail: string }> {
    if (!spokenReplyAllowed(this.state.mode, this.state.muted)) {
      const detail = "Speak test runs in Auto mode. Manual and chat stay silent.";
      this.trace("segment", `speak test: ${detail}`);
      return { ok: false, engine: "none", detail };
    }
    await this.playSpoken("Voice check.", this.speechGen);
    const engine = this.state.tts.engine || "none";
    const detail =
      engine === "none"
        ? this.state.tts.lastError || "no speech engine could speak"
        : `${engine} spoke`;
    this.trace("segment", `speak test: ${detail}`);
    return { ok: engine !== "none", engine, detail };
  }

  /** Counts for the debug report. No audio and no transcript text. */
  micDebug(): string {
    const report = this.dictation?.captureReport();
    const summary = heardSummary();
    const echo = voiceGate.echoCancellation();
    return [
      "pipeline listening",
      "owner auto-mode",
      `restarts ${this.micRestarts.length}`,
      `device ${this.state.mic.deviceLabel || "default"}`,
      `rate ${this.state.mic.sampleRate ?? "unknown"}`,
      `input clock ${voiceGate.inputRate() ?? "stopped"} Hz`,
      `echo ${echo === null ? "requested" : echo ? "on" : "off"}`,
      `fps ${report?.fps ?? 0}`,
      `queue ${report?.queue ?? 0}`,
      `dropped ${report?.dropped ?? 0}`,
      `heard ${summary.count} addressed ${summary.addressed} ambient ${summary.ambient} self ${summary.self}`,
      `histogram ${JSON.stringify(report?.histogram ?? {})}`,
    ].join("\n");
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

  /** Hot-plug, sleep, and resume. A missing saved device falls back and says so. */
  private async reopenInput(reason: "hotplug" | "resume") {
    if (this.state.mode !== "auto" || this.state.paused) return;
    applySession(reason === "hotplug" ? "hotplug" : "resume");
    const listed = await listAudioDevices();
    const saved = preferences.getSnapshot().voice.inputDeviceId || "";
    const plan = savedInputPlan(saved, listed.inputs);
    if (plan.cleared) preferences.setVoice({ inputDeviceId: "" });
    this.stopRecognition();
    const opened = await voiceGate.restart(plan.deviceId);
    const track = voiceGate.micStream()?.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const failure = voiceGate.lastCaptureFailure();
    this.state.status = opened ? plan.message : failure?.reason || plan.message;
    this.state.mic = {
      ...this.state.mic,
      available: opened,
      state: opened ? "available" : (failure?.state ?? "device-error"),
      deviceId: typeof settings.deviceId === "string" ? settings.deviceId : plan.deviceId,
      deviceLabel: track?.label || (opened ? "default device" : this.state.mic.deviceLabel),
      sampleRate:
        typeof settings.sampleRate === "number" ? settings.sampleRate : this.state.mic.sampleRate,
      reason: opened ? null : this.state.status,
    };
    this.state.micReady = opened;
    this.emit();
    if (reason === "hotplug") this.noteVoiceTrigger("device");
    else this.noteVoiceTrigger("focus");
  }

  /** The Auto listen style the owner picked. "always" keeps today's behaviour. */
  listenStyle(): ListenStyle {
    return normalizeListenStyle(preferences.getSnapshot().voice.listenStyle);
  }

  private pttCleanup: Array<() => void> = [];
  /** How the owner's last utterance sounded against their own baseline. */
  private lastTone: VoiceTone | null = null;

  voiceTone(): VoiceTone | null {
    return this.lastTone;
  }

  /** Hold Ctrl+Space in the window, or press the global toggle, to talk. */
  private armPushToTalk() {
    this.disarmPushToTalk();
    const api = desktop();
    let shortcutWanted: boolean | null = null;
    const syncShortcut = () => {
      const want = this.state.mode === "auto" && this.listenStyle() === "push-to-talk";
      if (want === shortcutWanted) return;
      shortcutWanted = want;
      void api?.setPttShortcut?.(want).then((row) => {
        if (want && row && !row.ok) this.trace("error", `push-to-talk shortcut: ${row.reason}`);
      });
    };
    syncShortcut();
    this.pttCleanup.push(preferences.subscribe(syncShortcut));
    const off = api?.onPttToggle?.(() => {
      if (this.listenStyle() !== "push-to-talk") return;
      const open = pttToggle();
      this.trace("speech", open ? "push-to-talk on" : "push-to-talk off");
      this.emit();
    });
    if (off) this.pttCleanup.push(off);
    if (typeof window !== "undefined") {
      const down = (event: KeyboardEvent) => {
        if (this.listenStyle() !== "push-to-talk" || !isHoldKey(event)) return;
        event.preventDefault();
        if (!pttActive()) this.trace("speech", "push-to-talk held");
        pttPress();
        this.emit();
      };
      const up = (event: KeyboardEvent) => {
        if (!pttActive() || (event.code !== "Space" && event.key !== "Control")) return;
        pttRelease();
        this.emit();
      };
      const blur = () => {
        pttRelease();
        this.emit();
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", blur);
      this.pttCleanup.push(() => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", blur);
      });
    }
    this.pttCleanup.push(() => {
      if (shortcutWanted) void api?.setPttShortcut?.(false);
    });
  }

  private disarmPushToTalk() {
    for (const cleanup of this.pttCleanup.splice(0)) {
      try {
        cleanup();
      } catch {
        /* already gone */
      }
    }
    resetPtt();
  }

  /** On-screen talk button: press and release, the same path as the key. */
  holdToTalk(down: boolean) {
    if (this.state.mode !== "auto" || this.listenStyle() !== "push-to-talk") return;
    if (down) pttPress();
    else pttRelease();
    this.emit();
  }

  /** Keyboard path for the on-screen button: one activation opens, the next closes. */
  togglePushToTalk() {
    if (this.state.mode !== "auto" || this.listenStyle() !== "push-to-talk") return;
    pttToggle();
    this.emit();
  }

  pushToTalkActive(): boolean {
    return pttActive();
  }

  private enterAuto() {
    this.armPushToTalk();
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
    this.disarmPushToTalk();
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
    clearHeard();
    this.followUpUntil = 0;
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
    this.state.status = "Preparing speech model…";
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
    this.state.stt = {
      ...this.state.stt,
      engine: this.state.stt.engine || ladder.engine,
    };
    void sttStatus(false, true, true)
      .then((state) => {
        if (!this.wantRunning || !microphoneAllowed(this.state.mode, this.state.paused)) return;
        const lang = preferences.getSnapshot().voice.recognitionLang || "hi-IN";
        const live = liveSttFromStatus(
          state,
          lang,
          preferences.getSnapshot().voice.privacyMode === true,
        );
        rememberLiveStt(live);
        const ready = live.status === "ready";
        this.state.stt = {
          ...this.state.stt,
          engine: live.engine,
          model: state.model ?? this.state.stt.model,
          ready,
          lastError: ready ? null : live.reason || state.reason || this.state.stt.lastError,
        };
        if (!ready) {
          this.state.listening = false;
          this.state.supported = false;
          const missing =
            live.reason ||
            state.reason ||
            "I can't hear you — local speech recognition is not installed. Install faster-whisper in Install Manager.";
          this.reportFailure(missing, "Local speech recognition not installed");
          this.scheduleSttRecovery(missing);
          this.armWakeOnly();
          return;
        }
        this.stopWakeOnly();
        this.resetVoiceRecovery();
        this.markHealFixed();
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
    const fault = this.state.error || "";
    if (/dependency-incompatible|metadata_errors/i.test(fault)) this.sttRepairConfirmed = true;
    this.applyVoiceHeal(fault || "stt-model-missing", true);
    this.noteVoiceTrigger("fix-voice");
  }

  private markHealFixed() {
    if (this.lastHealFault === "none") return;
    const line = noteHealFixed(this.lastHealFault);
    this.state.status = line;
    this.caption("friday", line);
    this.healMemory.attempts[this.lastHealFault] = [];
    this.healMemory.reported[this.lastHealFault] = false;
    this.lastHealFault = "none";
  }

  private applyVoiceHeal(fault: string, manual = false, execute = true) {
    const named = healFault(fault);
    const plan = planVoiceHeal({
      fault: named,
      now: Date.now(),
      memory: this.healMemory,
      auto: this.state.mode === "auto",
      manual,
    });
    this.healMemory = plan.memory;
    this.lastHealFault = plan.fault;
    this.trace("heal", plan.report || plan.action);
    if (plan.report) {
      this.state.status = plan.report;
      this.caption("friday", plan.report);
    }
    if (!execute || plan.action === "idle" || plan.action === "needs-you") {
      this.emit();
      return plan;
    }
    this.runHealAction(plan.action);
    this.emit();
    return plan;
  }

  private runHealAction(action: string) {
    if (action === "reopen-mic" || action === "reopen-default-mic" || action === "recheck-mic") {
      void this.reopenInput("resume");
      return;
    }
    if (action === "download-stt" || action === "verify-stt") {
      void desktop()?.installStt?.();
      return;
    }
    if (action === "reinstall-pinned-av") {
      if (!this.sttRepairConfirmed) {
        this.state.status =
          "dependency-incompatible: av with faster-whisper. Press Fix voice to install av>=17.0.0,<19 from PyPI.";
        return;
      }
      this.sttRepairConfirmed = false;
      void desktop()?.installStt?.();
      return;
    }
    if (
      action === "restart-stt-worker" ||
      action === "retry-segment" ||
      action === "next-stt-engine"
    ) {
      this.stopRecognition();
      this.wantRunning = true;
      this.startRecognition();
      return;
    }
    if (action === "restore-wake" || action === "redownload-wake") {
      void desktop()?.installWakeEngine?.();
      return;
    }
    if (action === "show-mic-privacy") {
      this.state.status = "Settings > Privacy > Microphone, allow desktop apps.";
      return;
    }
    if (action === "resume-audio-context") {
      void voiceGate.resumeAudio();
      return;
    }
    if (action === "recalibrate-vad") {
      voiceGate.recalibrate();
      return;
    }
    if (action === "raise-gain") {
      voiceGate.setSoftwareGain(2);
      return;
    }
    if (action === "tell-owner-level") {
      this.state.status =
        voiceGate.quietNotice() ||
        "The microphone level is very low. Raise the Windows input level.";
      return;
    }
    if (action === "next-tts-engine" || action === "reprobe-tts") {
      this.ttsPrefer = this.ttsPrefer === "auto" ? "supertonic" : "sapi";
      this.state.tts = { ...this.state.tts, engine: this.ttsPrefer };
      return;
    }
    if (action === "restart-kernel") {
      void desktop()?.restartKernel?.();
      return;
    }
    if (action === "drop-heard") {
      const dropped = dropHeardOverflow();
      this.trace("heal", `heard queue dropped ${dropped}`);
    }
  }

  private scheduleSttRecovery(reason: string) {
    if (!this.wantRunning) return;
    const plan = this.applyVoiceHeal(healFault(reason || "stt-engine-crash"), false, false);
    if (!plan.retry) return;
    const delay = plan.delayMs === 0 ? recoveryDelayMs(0) : plan.delayMs;
    this.sttRecoveryAttempt += 1;
    this.cancelVoiceRecoveryTimer();
    this.sttRecoveryTimer = window.setTimeout(() => {
      this.sttRecoveryTimer = null;
      if (this.wantRunning && !this.state.paused && this.state.mode === "auto") {
        this.startRecognition();
      }
    }, delay);
  }

  private stopWakeOnly() {
    this.wakeOnlyUnsub?.();
    this.wakeOnlyUnsub = null;
  }

  /** Wake still scores while the speech model is not ready. It does not invent a transcript. */
  private armWakeOnly() {
    if (this.wakeOnlyUnsub || this.dictation) return;
    let wasSpeech = false;
    this.wakeOnlyUnsub = voiceGate.subscribe((snapshot) => {
      if (this.dictation || this.state.mode !== "auto" || this.state.paused) return;
      if (snapshot.speech && !wasSpeech) {
        this.wakeOnlySpeechAt = performance.now();
        wasSpeech = true;
        return;
      }
      if (!snapshot.speech && wasSpeech) {
        wasSpeech = false;
        const from = this.wakeOnlySpeechAt;
        void this.scoreWakeOnly(from);
      }
    });
  }

  private async scoreWakeOnly(from: number) {
    if (this.state.stt.ready || !this.state.wakeEngine.ready) return;
    const samples = preRollFrom(from);
    if (samples.length < 1600) return;
    const probe = await detectWake({
      audioBytes: encodeWav(samples),
      mime: "audio/wav",
      wakeWord: wakeWord(),
    });
    if (!probe?.detected) return;
    const line = "My speech recognition is still starting, one moment";
    this.state.lastWake = { engine: probe.engine, detail: probe.detail, at: Date.now() };
    this.to("wake-matched");
    this.state.status = `speech recognition not ready (${this.state.stt.lastError || "not verified"})`;
    this.state.error = this.state.status;
    this.caption("friday", line);
    this.speak(line);
    this.emit();
  }

  private startDesktopDictation() {
    this.stopWakeOnly();
    if (!microphoneAllowed(this.state.mode, this.state.paused)) return;
    if (this.dictation?.active) return;
    reclaimUnowned(this.dictation);
    const dictation = new DesktopDictation({
      language: preferences.getSnapshot().voice.recognitionLang || "hi-IN",
      deviceId: preferences.getSnapshot().voice.inputDeviceId || null,
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
      admit: () => pttAdmits(this.listenStyle()),
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
      wakeProbe: async ({ audioBytes, mime }) => {
        if (!this.state.wakeEngine.ready) return null;
        const probe = await detectWake({ audioBytes, mime, wakeWord: wakeWord() });
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
        if (!this.state.stt.ready) {
          const line = "My speech recognition is still starting, one moment";
          this.state.status = `speech recognition not ready (${this.state.stt.lastError || "not verified"})`;
          this.state.error = this.state.status;
          this.caption("friday", line);
          this.speak(line);
        }
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
        } else if (event.stage === "transcript" && !event.detail.startsWith("(")) {
          this.state.interim = event.detail;
        } else if (event.stage === "dropped") {
          this.state.interim = "";
        }
        this.trace(event.stage, `${event.detail}${took}${size}`);
        if (
          event.stage === "dropped" &&
          /too short|too-short|no-frames|empty|no-speech|low-confidence|denoise-skipped/.test(
            event.detail,
          )
        ) {
          this.to("transcript");
        }
      },
      onFinal: (text, meta) => {
        this.lastTone = assessTone(meta?.prosody);
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
        beginVoiceTurn();
        markTurnStage("heard", true, "", `${trimmed.split(/\s+/).length} words`);
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
      onFault: (fault) => {
        this.noteMicFault(fault.message);
      },
      onError: (message) => {
        const current = this.dictation;
        this.state.error = `voice: ${message}`;
        this.state.stt = { ...this.state.stt, lastError: message };
        this.to("error");
        this.state.status = "Voice error";
        this.trace("error", message);
        this.emit();
        if (current?.active) return;
        try {
          current?.stop();
        } catch {
          /* already stopped */
        }
        if (this.dictation === current) this.dictation = null;
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
    this.stopWakeOnly();
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
    if (force) this.applyVoiceHeal("wake-model-missing", true);
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
    lines: string[];
    diagnostics: string;
  }> {
    const api = desktop();
    if (!api?.verifyVoiceRuntime) {
      const report = formatVoiceProbeReport([
        { id: "desktop", label: "Desktop runtime", ok: false, detail: "desktop app required" },
      ]);
      return {
        ok: false,
        checks: report.checks,
        lines: report.lines,
        diagnostics: report.diagnostics,
      };
    }
    // Verify the same speech model size the live worker uses.
    const sttSize = preferences.getSnapshot().voice.sttSize;
    const result = await api.verifyVoiceRuntime({
      loadModel: true,
      ...(sttSize && sttSize !== "auto" ? { model: sttSize } : {}),
    });
    const report = formatVoiceProbeReport(result?.checks ?? []);
    // Setup & Doctor reads these marks instead of "not checked".
    noteVoiceCheck(result?.checks ?? []);
    if (!result?.ok) {
      const failed = report.checks.find((check) => !check.ok);
      this.applyVoiceHeal(failed?.detail || "stt-model-missing", true);
    }
    this.state.stt = { ...this.state.stt, ready: Boolean(result?.ok) };
    if (result?.ok) this.noteVoiceTrigger("model-ready");
    for (const check of report.checks)
      this.trace(check.ok ? "segment" : "error", `${check.label}: ${check.detail}`);
    this.emit();
    return {
      ok: Boolean(result?.ok),
      checks: report.checks,
      lines: report.lines,
      diagnostics: report.diagnostics,
    };
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
    this.state.status = statusWithVoice(stateLabel(next));
    if (next !== from && detail) this.trace("segment", `${from} → ${next} (${event}) · ${detail}`);
    return true;
  }

  /** Record one pipeline step. Never throws, never blocks the audio path. */
  private trace(stage: VoiceTrace["stage"], detail: string) {
    const previous = this.state.voiceLog[this.state.voiceLog.length - 1];
    if (previous && previous.stage === stage && previous.detail === detail) {
      const repeat = (previous.repeat ?? 1) + 1;
      this.state.voiceLog = [
        ...this.state.voiceLog.slice(0, -1),
        { ...previous, at: Date.now(), repeat },
      ];
      this.emit();
      return;
    }
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
      this.trace(
        "dropped",
        dropLine("too-short", `"${text.trim()}" — too short and no verified speech signal`),
      );
      markTurnStage("routed", false, "too short and no verified speech signal");
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
      markTurnStage("routed", false, "unclear transcript — asked to repeat");
      this.caption("friday", repeat);
      this.speak(repeat);
      this.state.interim = "";
      this.emit();
      return;
    }
    text = corrected;
    this.state.heard = text.slice(0, 160);

    const waiting = brain.state.approval;
    if (
      waiting &&
      appControlNeedsApproval(waiting.tool) &&
      typeof waiting.at === "number" &&
      approvalFresh(waiting.at, Date.now())
    ) {
      if (isBoundConfirmation(text, (value) => AFFIRM.test(value))) {
        brain.approve(true);
        this.caption("user", text);
        this.caption("friday", "Approved.");
        this.emit();
        return;
      }
      if (isBoundConfirmation(text, (value) => DENY.test(value))) {
        brain.approve(false);
        this.caption("user", text);
        this.caption("friday", "Cancelled.");
        this.emit();
        return;
      }
    }

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
      markTurnStage("routed", false, "addressed to another assistant");
      this.remember("not-addressed", text, "ignored");
      this.noteAddress(text, {
        tag: "ambient",
        answer: false,
        reason: "other-assistant",
        confidence: 0.8,
        tools: false,
        closeFollowUp: false,
      });
      this.emit();
      return;
    }
    const decision = decideAddressing({
      text,
      mode: normalizeAddressMode(preferences.getSnapshot().voice.addressMode),
      wakeWord: wakeWord(),
      // Hands-free keeps the conversation open for the attention window after
      // FRIDAY last woke or answered, so a follow-up needs no name.
      followUpOpen:
        Date.now() < this.followUpUntil ||
        (this.state.handsFree && !this.wakeWordRequired && Date.now() < this.awakeUntil),
      lastSpoken: this.spokenText,
      recentlySpeaking: this.recentlySpeaking(),
      recentWork: [this.spokenText, brain.getSnapshot().runs[0]?.prompt || ""].join(" "),
    });
    // A push-to-talk turn is addressed by the key press itself: no wake word.
    if (this.listenStyle() === "push-to-talk" && decision.tag !== "self") {
      decision.tag = "addressed";
      decision.answer = true;
      decision.tools = true;
      decision.reason = "push-to-talk";
    }
    this.noteAddress(text, decision);
    if (decision.closeFollowUp) this.followUpUntil = 0;
    if (decision.tag === "self") {
      this.trace("dropped", "ignored FRIDAY's own voice (echo)");
      markTurnStage("routed", false, "FRIDAY's own voice (echo)");
      this.to("transcript");
      this.emit();
      return;
    }
    const awake = Date.now() < this.awakeUntil;
    const stop = isStopCommand(text);
    const accepted =
      microphoneAllowed(this.state.mode, this.state.paused) &&
      (stop || (decision.answer && decision.tools));
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
      markTurnStage(
        "routed",
        false,
        microphoneAllowed(this.state.mode, this.state.paused)
          ? `not meant for FRIDAY (${decision.tag}${decision.reason ? `: ${decision.reason}` : ""})`
          : "listening is paused or not in Auto mode",
      );
      this.to("wake-missed");
      this.state.status = "Say “FRIDAY …” to start";
      this.emit();
      return;
    }
    const command = (wake.matched ? wake.command : text).trim();
    if (wake.matched && !command && wakeOnCooldown(Date.now(), this.lastWakeAt)) {
      this.trace("dropped", "wake word repeated inside the cooldown");
      markTurnStage("routed", false, "wake word repeated inside the cooldown");
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
      this.queuedCommands = [];
      this.stopQueueTimer();
      markTurnStage("routed", true, "", "stop word");
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
    const lastCaption = this.state.captions[this.state.captions.length - 1];
    if (!(lastCaption?.who === "user" && lastCaption.text.includes(command))) {
      this.caption("user", command, false, { tag: "addressed" });
    }

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
    if (heardSensitive && !selfLifecycleAction(command)) {
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
    const spoken = voiceFailureLine(
      cause,
      this.spokenCauses.size + 1,
      ownerVoiceLang(preferences.getSnapshot().voice.recognitionLang),
    );
    const spokenLine = spokenRepairLine(message, spoken);
    this.caption("friday", spokenLine);
    if (!mayAnnounce(cause, this.spokenCauses)) {
      this.emit();
      return;
    }
    this.spokenCauses.add(cause);
    this.emit();
    this.speak(spokenLine);
  }

  private followMs(): number {
    const raw = Number(preferences.getSnapshot().voice.addressWindowSec);
    if (!Number.isFinite(raw) || raw <= 0) return 8000;
    return Math.min(60_000, raw * 1000);
  }

  private openFollowUp() {
    if (normalizeAddressMode(preferences.getSnapshot().voice.addressMode) === "name-only") return;
    this.followUpUntil = Date.now() + this.followMs();
  }

  private noteAddress(text: string, decision: AddressDecision) {
    const voice = preferences.getSnapshot().voice;
    const keepMin = Number(voice.heardKeepMin);
    const keepMs = Number.isFinite(keepMin) ? Math.max(0, keepMin) * 60_000 : 10 * 60_000;
    const keepRows = Number(voice.heardKeepRows);
    noteHeard(
      {
        at: Date.now(),
        text,
        tag: decision.tag,
        language: languageId(text),
        confidence: decision.confidence,
      },
      keepMs,
      Date.now(),
      Number.isFinite(keepRows) ? keepRows : 40,
    );
    this.caption(decision.tag === "self" ? "friday" : "user", text, false, {
      tag: decision.tag,
      confidence: decision.confidence,
      language: languageId(text),
    });
    this.trace("wake", `${decision.reason} · ${decision.confidence.toFixed(2)}`);
  }

  private noteMicFault(message: string) {
    if (this.shownMicFault === message) return;
    this.shownMicFault = message;
    this.state.error = message;
    this.trace("error", message);
    const now = Date.now();
    if (!allowRestart(this.micRestarts, now)) {
      this.state.status = "Press Reset microphone";
      this.emit();
      return;
    }
    this.micRestarts.push(now);
    this.applyVoiceHeal(message, true);
  }

  /** Tear the one microphone pipeline down and open it again. */
  resetMicrophone() {
    if (this.state.mode !== "auto") return;
    this.applyVoiceHeal("mic-no-device", true);
  }

  /** Run a command through the existing brain pipeline. */
  private dispatch(command: string) {
    // A light remark while a turn is running (how is it going, are you there)
    // is answered at once and the turn keeps going. A real request falls
    // through and still interrupts, as before.
    const live = brain.getSnapshot();
    const running = live.activeRunId
      ? live.runs.find((run) => run.id === live.activeRunId)
      : undefined;
    if (running && this.state.mode === "auto") {
      const decision = whileBusy(
        command,
        { task: running.prompt, elapsedMs: Date.now() - running.startedAt },
        { queued: this.queuedCommands.length },
      );
      if (decision.kind === "reply" || decision.kind === "queue") {
        if (decision.kind === "queue") {
          // She keeps working and keeps talking: the new request is heard, answered with a
          // short acknowledgement, and done right after this one.
          this.queuedCommands.push(command);
          this.remember("busy-queue", command, "queued behind the running turn");
          this.drainQueuedCommands();
        } else {
          this.remember("busy-reply", command, "answered while the turn keeps running");
        }
        this.caption("friday", decision.line);
        this.state.status =
          decision.kind === "queue" ? "Working — next request queued" : "Working — still on it";
        this.emit();
        this.speak(decision.line);
        return;
      }
    }
    this.clearHoldLines();
    this.dropPlayback();
    this.voicedRunId = "";
    this.voicedChars = 0;
    this.to("command-accepted");
    this.state.status = "Thinking…";
    this.emit();
    // Voice turns carry exactly the same attached capabilities and pinned
    // models as typed turns, so manual and auto mode stay continuous.
    const { extra, modelIds } = composer.directive();
    this.openFollowUp();
    const voiceNow = preferences.getSnapshot().voice;
    const ambient = ambientContextForRoute({
      privacy: voiceNow.privacyMode === true,
      allowAmbientCloud: voiceNow.allowAmbientCloud === true,
    });
    const merged = mergeTurnExtra(
      extra,
      turnAwarenessExtra(command, { kind: "voice" }),
      ambient ? `Heard nearby, untrusted:\n${ambient}` : "",
      this.lastTone && this.lastTone.label !== "steady" ? this.lastTone.line : "",
    );
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
    markTurnStage(
      "routed",
      result.accepted,
      result.message || result.reason || "the brain did not accept the turn",
      modelIds.length ? `${modelIds.length} model(s) preferred` : "auto",
    );
    if (!result.accepted) {
      this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
      this.reportFailure(
        result.message || "I couldn't start that request.",
        result.reason === "busy" ? "Still working on the last request" : "Nothing to run",
      );
      return;
    }
    this.armHoldLines(command);
  }

  /**
   * A turn that takes a while does not leave the owner in silence: a short
   * line after a couple of seconds, one more if it is still running, and
   * neither once the real answer is being spoken.
   */
  private armHoldLines(command: string) {
    this.clearHoldLines();
    if (this.state.mode !== "auto") return;
    this.narrator.begin();
    const startedAt = Date.now();
    const say = (kind: "first" | "later") => {
      const active = brain.getSnapshot().activeRunId;
      if (this.state.mode !== "auto" || !active) return;
      if (this.voicedChars > 0 || this.state.speaking || this.speechQueue.length) return;
      const line = this.narrator.say(kind, { text: command, elapsedMs: Date.now() - startedAt });
      if (!line) return;
      this.caption("friday", line);
      this.speak(line);
    };
    // A short line after a couple of seconds, then a different one now and then while it runs;
    // the narrator keeps these few and never repeats itself.
    this.holdTimers = [
      setTimeout(() => say("first"), 2500),
      setTimeout(() => say("later"), 14000),
      setTimeout(() => say("later"), 40000),
      setTimeout(() => say("later"), 90000),
    ];
  }

  /** Run the next queued request once nothing is running and nothing is being said. */
  private drainQueuedCommands() {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => {
      if (this.state.mode !== "auto" || this.state.paused || !this.queuedCommands.length) {
        this.stopQueueTimer();
        return;
      }
      if (brain.getSnapshot().activeRunId) return;
      if (this.state.speaking || this.speechQueue.length) return;
      const next = this.queuedCommands.shift();
      if (!this.queuedCommands.length) this.stopQueueTimer();
      if (next) this.dispatch(next);
    }, 700);
  }

  private stopQueueTimer() {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
  }

  private clearHoldLines() {
    for (const timer of this.holdTimers) clearTimeout(timer);
    this.holdTimers = [];
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
    this.clearHoldLines();
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
    if (!spokenReplyAllowed(this.state.mode, this.state.muted)) {
      markTurnStage(
        "spoken",
        false,
        this.state.muted ? "output is muted" : `${this.state.mode} mode does not speak`,
      );
      return;
    }
    if (!preferences.getSnapshot().voice.speakReplies) {
      markTurnStage("spoken", false, "Speak replies is turned off in Voice settings");
      return;
    }
    // Only ever speak the hearable form: no markdown, no code, two sentences.
    const spoken = spokenSummary(preferSpoken(text));
    if (!spoken) {
      markTurnStage("spoken", false, "the reply had nothing speakable (code or markdown only)");
      return;
    }
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
      prefer: this.ttsPrefer,
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
      affect: /!/.test(spoken)
        ? "urgent"
        : prosodyAffect(
            readFeeling(
              lastOwner,
              this.lastTone ? { prosody: (this.lastTone.arousal - 0.5) * 2 } : undefined,
            ).label,
          ),
      quiet: !alertsAudible(),
      whisper: voicePrefs.whisperMode === true,
    });
    const privacy = voicePrefs.privacyMode === true;
    const localVoice = fallen !== "neural" || privacy;
    const out = outputReachable({ deviceId: "default", volume: tone.volume });
    if (!out.ok) this.state.status = out.reason;
    this.spokenText = spoken;
    this.openFollowUp();
    return speakText(
      spoken,
      {
        ...tuning,
        lang: spokenLang.lang || tuning.lang || "hi-IN",
        rate: tone.rate,
        pitch: tone.pitch,
        volume: tone.volume,
        allowCloud: fallen === "neural" && !privacy,
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
          // The follow-up window counts from the end of her reply, not its start,
          // so a long answer does not use up the owner's turn.
          this.openFollowUp();
          if (this.state.handsFree) this.setAwake();
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
        const route = lastSpeechRoute();
        const engine =
          how === "none"
            ? "none"
            : route.engine.includes("supertonic")
              ? "supertonic"
              : route.engine === "sapi"
                ? "sapi"
                : how;
        this.state.tts = {
          engine,
          voice: route.voiceId || tuning.voiceName || "",
          lastSpokenAt: how === "none" ? this.state.tts.lastSpokenAt : Date.now(),
          lastError: how === "none" ? "no speech engine could speak the reply" : null,
        };
        if (how !== "none" && (route.note || (route.voiceId && !route.cloud))) {
          this.state.status = statusWithVoice(this.state.status);
        }
        this.trace("segment", `tts engine: ${how.toUpperCase()}`);
        markTurnStage(
          "spoken",
          how !== "none",
          "no speech engine could speak the reply",
          `${engine}${route.voiceId ? ` · ${route.voiceId}` : ""}`,
        );
        this.trace("segment", `turn: ${turnTraceLine(voiceTurn())}`);
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
        markTurnStage("spoken", false, detail);
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
    if (
      final &&
      this.state.mode === "auto" &&
      this.chartOfferedFor !== runId &&
      offersShowHow(brain.getSnapshot().runs.find((run) => run.id === runId)?.trace)
    ) {
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
      const detail = toolNarration(step);
      const toolKey = live && step ? `${live.id}:${step.id}` : "";
      if (detail && toolKey && toolKey !== this.narratedTool && !this.callHold) {
        this.narratedTool = toolKey;
        // Said only when the step has really taken a while, in different words each time.
        const line = this.narrator.say("tool", {
          text: live?.prompt || "",
          detail,
          elapsedMs: Date.now() - (live?.startedAt ?? Date.now()),
        });
        if (line && !this.state.speaking && !this.speechQueue.length && this.voicedChars === 0) {
          this.caption("friday", line);
          this.speak(line);
        }
      }
      if (live?.answer) {
        markTurnStage("model", true, "", live.answeredBy?.line || "answering");
        this.speakStreamed(live.id, live.answer, false);
      }
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
      markTurnStage("reply", false, "the model returned an empty reply");
      this.emit();
      return;
    }
    this.to("brain-replied");
    const failed = fresh.some((message) => {
      if (message.role === "user") return false;
      return runs.find((row) => row.id === message.runId)?.state === "failed";
    });
    const spoken = failed ? spokenRouteError(say) : say;
    markTurnStage(
      "model",
      !failed,
      spokenRouteError(say),
      runs.find((row) => row.id === fresh.find((m) => m.role !== "user")?.runId)?.answeredBy
        ?.line || "",
    );
    markTurnStage("reply", !failed, failed ? "the model call failed" : "", `${say.length} chars`);
    this.caption("friday", say);
    this.setAwake();
    // FRIDAY manages her own box: show structured content, expand when needed.
    const display = this.displayFor(say);
    if (display) this.show(display);
    else this.clearDisplay();
    this.emit();
    const runId = fresh.find((message) => message.role !== "user")?.runId || this.voicedRunId;
    if (failed && this.voicedRunId === runId && this.voicedChars > 0) {
      if (this.voicedFaultFor !== runId) {
        this.voicedFaultFor = runId;
        this.speak(spoken);
      }
      return;
    }
    if (failed) this.voicedFaultFor = runId || "reply";
    this.speakStreamed(runId || "reply", spoken, true);
  }
}

export const assistantMode = new AssistantModeStore();

// The self-check and a chat question about her voice read the live session.
registerVoiceHealth(() => {
  const live = assistantMode.getSnapshot();
  const counts = hearingCounters();
  return {
    mode: live.mode,
    listening: live.listening,
    paused: live.paused,
    micReady: live.micReady,
    micDetail: live.mic.reason || live.mic.state || "",
    sttReady: live.stt.ready,
    sttModel: live.stt.model || "",
    sttError: live.stt.lastError || "",
    heard: counts.heard,
    dropped: { ...counts.dropped },
    droppedTotal: counts.droppedTotal,
    ttsEngine: live.tts.engine || "",
    ttsError: live.tts.lastError || "",
    turnLine: turnTraceLine(voiceTurn()),
    stoppedAt: whereItStopped(voiceTurn()),
  };
});

bindVoiceSurface(() => {
  const live = assistantMode.getSnapshot();
  return { mode: live.mode, muted: live.muted };
});
