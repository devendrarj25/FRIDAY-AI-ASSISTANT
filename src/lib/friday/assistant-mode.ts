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

import { describeDownload, type SttProgressPayload, type VoiceDownload } from "./voice-download";
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
import {
  allowRestart,
  encodeWav,
  preRollFrom,
  subscribeCaptureFrames,
  TARGET_RATE,
} from "./pcm-capture";
import { LiveWords } from "./voice-engine/live-words";
import { whisperLanguageArg } from "./voice-stt";
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
import { registerVoiceHealth, registerVoiceRepair } from "./voice-health";
import { preferences } from "./preferences";
import { canStreamSpeechToText, speakWithCloud } from "./voice-engine/voice-cloud-client";
import { createStreamingSpeak } from "./voice-engine/streaming-speak";
import { StageClock } from "./voice-engine/latency-monitor";
import { createRealtimeStt } from "./voice-engine/sarvam-realtime-stt";
import { ShadowLedger, shadowVerdict, verdictLine } from "./voice-engine/shadow-evaluation";
import {
  SttBillingReconciler,
  createUtteranceArbiter,
  type Utterance,
} from "./voice-engine/stt-authority";
import { createWakeFrameFeed } from "./voice-engine/voice-frame-assembler";
import { classifyNoteCommand, minutesPrompt, translationPrompt, voiceNotes } from "./voice-notes";
import { loadLedger, sanitizeCloudPrefs, saveLedger } from "./voice-engine/voice-cloud-settings";
import { looksSensitive } from "./brain/memory-policy";
import { mergeTurnExtra, turnAwarenessExtra } from "./turn-awareness";
import { conversationDigest } from "./brain/conversation-state";
import { attentionWindowMs } from "./attention-window";
import { preferSpoken, socialRegister } from "./conversation-style";
import { chooseFresh, vary, type RepeatBucket } from "./brain/anti-repeat";
import { diagnoseVoice, problemLine, type SelfCheckResult } from "./voice-selfcheck";
import { SUPERVISOR_COOLDOWN_MS, superviseVoice } from "./voice-supervisor";
import {
  activeVoiceSettings,
  lastSpeechRoute,
  prefetchSpeech,
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
  confirmationVerdict,
  createNarrator,
  whileBusy,
  isHoldSound,
  judgeInterruption,
  microphoneAllowed,
  pushVoiceAudit,
  speakerDecision,
  prosodyAffect,
  speakingProsody,
  spokenReplyAllowed,
  spokenRouteError,
  takeSpeakable,
  utteranceIncomplete,
  voiceClaimsAuthority,
  wakeOnCooldown,
  wantsContinue,
  type VoiceAudit,
} from "./voice-session";
import { completionLine, parseBackgroundRequest } from "./voice-engine/background-request";
import {
  BargeInDetector,
  BargeShadow,
  classifyVoiceControl,
} from "./voice-engine/interruption-controller";
import { speechRms } from "./character/speech-audio";
import { splitLongSpeech } from "./voice-engine/language-segmenter";
import { prepareForSpeech } from "./voice-engine/text-normalizer";
import { askBrain } from "./self/ask-brain";
import {
  attachVoiceTaskSpeaker,
  releaseTaskUpdates,
  runTaskControl,
  startVoiceTask,
} from "./voice-engine/voice-tasks";
import { earlyClause, realtimeSilenceMs, realtimeStatus } from "./voice-realtime";
import {
  applyCorrections,
  confidenceRepeat,
  heardConfidence,
  heardReadBack,
  needsHeardConfirmation,
  type HeardQuality,
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
import { affect, readFeeling } from "./brain/affect";
import { DesktopDictation, reclaimUnowned, sttInitialPrompt, sttStatus } from "./voice-stt";
import { isPlainStop, isSelfEchoTranscript, isStopCommand, matchWakeWord } from "./wake-word";
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

import { approvalReason, commandNeedsApproval, setActionMode } from "./brain/action-risk";

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
  /** A speech model or the speech engine being checked, fetched or installed (null when nothing is). */
  download: VoiceDownload | null;
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
/** After the live wake scorer hears the name, the next line is addressed to her for this long (ms). */
const LIVE_WAKE_MS = 8_000;
/** Live captions send audio only while speech was heard this recently (ms). */
const CAPTION_TAIL_MS = 1_500;

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
/** How long a read-back waits for the owner's yes or no. */
const HEARD_CONFIRM_MS = 25_000;
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
  onSttProgress?: (cb: (payload: SttProgressPayload) => void) => () => void;
  installStt?: (options?: { upgrade?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    skippedInstall?: boolean;
    updateAvailable?: boolean;
  }>;
  installWakeEngine?: () => Promise<{ ok: boolean; ready?: boolean; error?: string }>;
  restartKernel?: () => Promise<{ ok: boolean }>;
};
const desktop = (): VoiceDesktop | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: VoiceDesktop }).friday ?? null);

let cid = 0;
const captionId = () => `cap-${Date.now().toString(36)}-${(cid += 1).toString(36)}`;

type LocalFinalMeta = Parameters<ConstructorParameters<typeof DesktopDictation>[0]["onFinal"]>[1];

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
  /**
   * Set while the owner has started to talk over FRIDAY. Playback is paused, but the answer is NOT cancelled until
   * the words show it is a real interruption: a "haan" or "hmm" just carries on, like ChatGPT's voice and Gemini Live.
   */
  private interruptHold: { at: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** The newest piece of the answer that arrived while it was paused, replayed on resume. */
  private deferredStream: { runId: string; text: string; final: boolean } | null = null;
  private backchannelUsed = false;
  /** Shows the words while the owner is still speaking (opt-in, `voice.liveWords`). */
  private liveWords: LiveWords | null = null;
  private liveWordsTimer: ReturnType<typeof setInterval> | null = null;
  private speechQueue: string[] = [];
  private draining = false;
  /** How much of the live answer has already been handed to speech. */
  private voicedRunId = "";
  private holdTimers: ReturnType<typeof setTimeout>[] = [];
  private voicedChars = 0;
  /** The start of the answer that has been spoken, to tell a rewrite from more text. */
  private voicedPrefix = "";
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
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Named stamps of this turn (speech start, speech requested, first sound) and of an interruption. */
  private turnStages = new StageClock();
  private interruptStages = new StageClock();
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
    download: null,

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
      if (voiceChanged) {
        this.noteVoiceTrigger("settings");
        // Privacy mode, the cloud switch or a streaming switch turned off ends the open cloud connections now, not at
        // the next clause: nothing may stay connected to a provider the owner just switched off.
        const voice = preferences.getSnapshot().voice;
        const cloud = voice.cloudVoice;
        if (voice.privacyMode === true || !cloud.cloudEnabled || !cloud.streaming) {
          void this.streamSpeaker?.stop();
          this.streamSpeaker = null;
        }
        if (voice.privacyMode === true || !cloud.cloudEnabled || !cloud.streamCaptions) {
          void this.stopCloudCaptions();
        }
        // Playing while it arrives is fixed when the stream is made, so changing it makes a new one.
        if (this.streamSpeaker && this.streamSpeakerPlayback !== (cloud.streamPlayback === true)) {
          void this.streamSpeaker.stop();
          this.streamSpeaker = null;
        }
      }
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
      this.superviseTick();
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
      const next = describeDownload(payload);
      if (!next) return;
      if (this.downloadTimer) clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
      this.state.download = next.stage === "check" && !next.updateAvailable ? null : next;
      if (this.state.mode === "auto") {
        this.state.status = next.percent == null ? next.label : `${next.label} ${next.percent}%`;
      }
      // A finished or failed row stays long enough to be read, then goes.
      if (next.stage === "ready" || next.stage === "failed" || next.stage === "check") {
        this.downloadTimer = setTimeout(
          () => {
            this.state.download = null;
            this.downloadTimer = null;
            this.emit();
          },
          next.stage === "failed" ? 20000 : 4000,
        );
      }
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
      .filter((c) => c.tag !== "ambient")
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
  /** How long the last utterance took to say, for speed against his own usual speed. */
  private lastSpeechMs: number | null = null;
  /** What the speech model said about the last utterance: how sure it was of the words and the language. */
  private lastHeardQuality: HeardQuality | null = null;
  /** Words she read back and is waiting to hear "yes" or "no" for, before she acts on them. */
  private pendingHeard: { command: string; at: number } | null = null;

  /** The speech model's own scores for the last utterance, for the diagnostics panel. */
  heardQuality(): HeardQuality | null {
    return this.lastHeardQuality;
  }

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
    this.ensureLiveWake();
    // Her own look at her ears and voice a few seconds after Auto starts; silent unless something is wrong.
    if (this.autoCheckTimer) clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null;
      if (this.state.mode === "auto") void this.selfCheckVoice(false);
    }, 6000);
    this.startBargeShadow();
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
    this.interventions = 0;
    this.lastIntervention = "";
    this.reportedStuck = false;
    this.announcedReady = false;
    this.supervisedAt.clear();
    if (this.autoCheckTimer) clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = null;
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer = null;
    this.to("session-stop");
    brain.setAutoMode(false);
    this.unBrain?.();
    this.unBrain = null;
    this.stopRecognition();
    this.dropPlayback();
    void this.streamSpeaker?.stop();
    this.streamSpeaker = null;
    void this.stopCloudCaptions();
    this.stopLiveWake();
    this.stopBargeShadow();
    // Nothing from this Auto session may survive into the next one: queued requests, a paused reply, a spent wake.
    this.queuedCommands = [];
    this.stopQueueTimer();
    this.liveWakeAt = 0;
    this.translateTo = null;
    this.deferredStream = null;
    this.unfinished = "";
    if (this.interruptHold?.timer) clearTimeout(this.interruptHold.timer);
    this.interruptHold = null;
    // A note that was running stops with the microphone: the banner must never show a recording that is not heard.
    voiceNotes.stop();
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
        // The microphone may have opened before the engine was known ready; say it now if so.
        if (this.state.voiceState === "LISTENING") this.announceReady();
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

  /**
   * The Fix voice button: she looks at her own microphone, speech engine, voice and wake engine, mends
   * exactly what is broken, and says what she found in the owner's language.
   */
  fixVoice() {
    speechTurnPlan("fix voice", preferences.getSnapshot().voice.recognitionLang || "hi-IN");
    void this.selfCheckVoice(true);
  }

  private announcedReady = false;

  /**
   * Once per Auto session, when the microphone is really open and the speech engine is ready, one short
   * line so the owner hears that she is up. Never while muted, never again until Auto is turned off and on.
   */
  private announceReady() {
    if (this.announcedReady || this.state.mode !== "auto" || this.state.muted || this.state.paused)
      return;
    if (!this.state.stt.ready) return;
    this.announcedReady = true;
    const line = this.variedLine("ready", this.lastOwnerLine);
    this.caption("friday", line);
    this.speak(line);
  }

  /** When the session entered its present state, for the supervisor. */
  private stateSince = Date.now();
  private supervisedAt = new Map<string, number>();
  private lastSupervisorTick = 0;
  /** How many times she has pulled herself out of a stuck state this session, and the last one. */
  private interventions = 0;
  private lastIntervention = "";
  private reportedStuck = false;

  /**
   * The supervisor's turn, run from the microphone analyser's own beat (no timer of its own): if the session
   * has sat in one state longer than that state can last, mend it through the one heal policy, quietly.
   */
  private superviseTick() {
    const now = Date.now();
    if (now - this.lastSupervisorTick < 5000) return;
    this.lastSupervisorTick = now;
    const verdict = superviseVoice({
      mode: this.state.mode,
      paused: this.state.paused,
      state: this.state.voiceState,
      ageMs: now - this.stateSince,
      brainActive: Boolean(brain.getSnapshot().activeRunId),
      speechQueued: this.speechQueue.length > 0,
      speaking: voiceGate.isSpeakingGuarded(),
      downloading: Boolean(this.state.download && this.state.download.stage === "download"),
    });
    if (!verdict.act) return;
    if (now - (this.supervisedAt.get(verdict.state) ?? 0) < SUPERVISOR_COOLDOWN_MS) return;
    this.supervisedAt.set(verdict.state, now);
    this.interventions += 1;
    this.lastIntervention = `${verdict.state}: ${verdict.reason}`;
    this.trace("heal", `supervisor: ${verdict.reason}`);
    if (verdict.remedy === "self-check") {
      void this.selfCheckVoice(false);
      return;
    }
    if (verdict.remedy === "reopen-mic" || verdict.remedy === "restart-speech") {
      this.applyVoiceHeal(verdict.fault, false);
    }
    this.forceListening(verdict.reason);
    // Never fail silently: the first few are mended quietly, a run of them is said once.
    if (this.interventions >= 3 && !this.reportedStuck) {
      this.reportedStuck = true;
      const line = chooseFresh(
        `stuck:${socialRegister(this.lastOwnerLine)}`,
        socialRegister(this.lastOwnerLine) === "en"
          ? [
              "I keep getting stuck and recovering. If it goes on, open Voice diagnostics.",
              "My voice pipeline has stalled a few times and I reset it each time. Voice diagnostics shows where.",
            ]
          : [
              "Main baar baar atak rahi hoon, har baar khud theek kar leti hoon. Rukta rahe to Voice diagnostics dekhna.",
              "Meri voice pipeline kuch baar ruki, maine har baar reset ki. Kahan ruki, Voice diagnostics me dikhega.",
            ],
      );
      this.caption("friday", line);
      this.emit();
    }
  }

  /** Let go of a stuck state: back to listening with nothing half-done left behind. */
  private forceListening(reason: string) {
    this.clearHoldLines();
    this.state.interim = "";
    this.state.voiceState = "LISTENING";
    this.state.listening = true;
    this.state.speaking = false;
    this.state.status = statusWithVoice(stateLabel("LISTENING"));
    this.stateSince = Date.now();
    this.trace("segment", `back to listening — ${reason}`);
    this.emit();
  }

  private lastCheck: { at: number; ok: boolean; faults: string[] } | null = null;
  interventionCount(): number {
    return this.interventions;
  }
  lastInterventionText(): string {
    return this.lastIntervention;
  }
  lastCheckSummary() {
    return this.lastCheck;
  }

  private selfChecking = false;
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Check the voice and heal what is wrong. `manual` is the owner pressing Fix voice (she always answers);
   * otherwise it is her own check on entering Auto, which stays silent unless it finds a fault.
   */
  async selfCheckVoice(manual: boolean): Promise<SelfCheckResult | null> {
    if (this.selfChecking) return null;
    const api = desktop();
    const register = socialRegister(this.lastOwnerLine);
    if (!api?.verifyVoiceRuntime) {
      if (manual) {
        const line = "Voice repair runs in the installed FRIDAY app.";
        this.state.status = line;
        this.caption("friday", line);
        this.emit();
      }
      return null;
    }
    this.selfChecking = true;
    try {
      if (manual) {
        const line = vary("checking", { register });
        this.state.status = line;
        this.caption("friday", line);
        this.emit();
      }
      const fault = this.state.error || "";
      if (/dependency-incompatible|metadata_errors/i.test(fault)) this.sttRepairConfirmed = true;
      // A speech engine that is already loaded and ready is not loaded a second time just to look at it.
      const verified = await this.verifyVoiceRuntime({
        heal: false,
        loadModel: !this.state.stt.ready,
      });
      const result = diagnoseVoice({
        micReady: this.state.micReady,
        micError: fault || null,
        sttReady: this.state.stt.ready,
        sttModel: this.state.stt.model,
        sttError: this.state.stt.lastError,
        ttsEngine: this.state.tts.engine,
        ttsError: this.state.tts.lastError,
        wakeReady: this.state.wakeEngine.ready,
        wakeEngine: this.state.wakeEngine.engine,
        probes: verified.checks,
      });
      this.trace("heal", `self-check: ${result.ok ? "all good" : result.faults.join(", ")}`);
      this.lastCheck = { at: Date.now(), ok: result.ok, faults: [...result.faults] };
      if (result.ok) {
        if (manual) {
          const line = vary("allGood", { register });
          this.state.status = line;
          this.caption("friday", line);
          this.speak(line);
        }
        this.noteVoiceTrigger(manual ? "fix-voice" : "model-ready");
        this.emit();
        return result;
      }
      let started = 0;
      for (const named of result.faults) {
        const plan = this.applyVoiceHeal(named, true);
        if (plan.action !== "idle" && plan.action !== "needs-you") started += 1;
      }
      const line = problemLine(result, register, { fixing: started > 0 });
      this.state.status = line;
      this.caption("friday", line);
      this.speak(line);
      this.noteVoiceTrigger("fix-voice");
      this.emit();
      return result;
    } finally {
      this.selfChecking = false;
    }
  }

  private markHealFixed() {
    if (this.lastHealFault === "none") return;
    const line = noteHealFixed(this.lastHealFault);
    // The status line and the voice diagnostics carry this. It is housekeeping,
    // not something she said, so it stays out of the conversation captions.
    this.state.status = line;
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
      silenceMs: () => {
        const open = Date.now() < this.awakeUntil || this.state.handsFree;
        const base = endpointSilenceMs(open, this.state.interim);
        return realtimeSilenceMs(
          base,
          this.realtimeActive(),
          open,
          utteranceIncomplete(this.state.interim),
        );
      },
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
        this.turnStages.finish();
        this.turnStages.reset();
        this.turnStages.mark("micSpeechStart");
        this.turnClock = {
          heardAt: Date.now(),
          finalAt: null,
          tokenAt: null,
          audioAt: null,
        };
        // Barge-in: FRIDAY stops talking the moment the owner starts.
        if (this.state.speaking) {
          this.trace("speech", "barge-in — pausing playback, listening to what is said");
          this.holdForInterruption();
        }
        this.to("vad-speech");
        if (
          preferences.getSnapshot().voice.liveWords === true &&
          this.state.mode === "auto" &&
          !this.state.paused &&
          !this.state.speaking
        ) {
          this.startLiveWords();
        }
        void this.ensureCloudCaptions();
        this.ensureLiveWake();
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
        const trimmed = text.trim();
        // Which recogniser may make the turn is decided in one place (stt-authority.ts). By default the local text goes
        // straight through; when the owner made Sarvam the authority it waits briefly for the cloud sentence.
        if (trimmed) this.rememberLocalMeta(trimmed, meta);
        const decision = this.sttArbiter().local(trimmed);
        if (decision.action === "hold")
          this.trace("segment", "local text held for the Sarvam sentence");
      },
      onStateChange: (listening) => {
        if (listening === "listening") {
          this.to("mic-opened");
          this.announceReady();
        } else if (listening === "thinking") this.to("transcribe-start");
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
    const status = await wakeEngineStatus(wakeWord(), force);
    // Look first, repair only what is missing: a recheck of a wake model that is there used to download it again.
    if (force && !status.ready) this.applyVoiceHeal("wake-model-missing", true);
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
  async verifyVoiceRuntime(options: { heal?: boolean; loadModel?: boolean } = {}): Promise<{
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
      loadModel: options.loadModel !== false,
      ...(sttSize && sttSize !== "auto" ? { model: sttSize } : {}),
    });
    const report = formatVoiceProbeReport(result?.checks ?? []);
    // Setup & Doctor reads these marks instead of "not checked".
    noteVoiceCheck(result?.checks ?? []);
    if (!result?.ok) {
      // Only a part the voice cannot work without starts a repair. An optional part that is not installed
      // (local voice, silero, smart-turn, speaker) is not a fault, and used to start a speech-model download.
      const failed = report.checks.find((check) => !check.ok && !check.optional);
      if (failed && options.heal !== false)
        this.applyVoiceHeal(failed.detail || "stt-model-missing", true);
    }
    this.state.stt = { ...this.state.stt, ready: Boolean(result?.ok) };
    if (result?.ok) this.noteVoiceTrigger("model-ready");
    for (const check of report.checks) {
      // An optional part that is not installed is information, never an error.
      this.trace(
        check.ok || check.optional ? "segment" : "error",
        check.optional ? check.label : `${check.label}: ${check.detail}`,
      );
    }
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
    if (event === "transcribe-start" || event === "transcript" || event === "session-stop")
      this.stopLiveWords();
    if (next !== from) this.stateSince = Date.now();
    this.state.voiceState = next;
    this.state.listening = stateIsListening(next);
    this.state.speaking = stateIsSpeaking(next);
    this.state.status = statusWithVoice(stateLabel(next));
    if (next !== from && detail) this.trace("segment", `${from} → ${next} (${event}) · ${detail}`);
    if (next === "LISTENING" && from !== "LISTENING") releaseTaskUpdates();
    return true;
  }

  /** The owner's last words, so a short line can answer in the language they are using. */
  private lastOwnerLine = "";

  /** A short reply that differs from the last few of its kind and follows the owner's language. */
  private variedLine(bucket: RepeatBucket, heard: string): string {
    // One word (just her name) says nothing about the language; the last full line does.
    const said = heard.trim().split(/\s+/).length >= 2 ? heard : this.lastOwnerLine || heard;
    return vary(bucket, { register: socialRegister(said) });
  }

  /** A background task update, said in Auto mode (Chat and Manual stay silent) and shown in the captions. */
  announceTask(text: string) {
    this.caption("friday", text);
    this.speak(text);
  }

  /** Whether a task update may be spoken now: not while the owner talks or FRIDAY answers. */
  taskBusy(): "listening-to-owner" | "speaking" | "idle" {
    const v = this.state.voiceState;
    if (
      v === "SPEECH_DETECTED" ||
      v === "TRANSCRIBING" ||
      v === "WAKE_DETECTED" ||
      v === "COMMAND_LISTENING"
    )
      return "listening-to-owner";
    if (v === "THINKING" || v === "SPEAKING" || v === "WAITING_CONFIRMATION") return "speaking";
    return "idle";
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
    if (words >= 2) this.lastOwnerLine = text;
    this.trace("transcript", text.slice(0, 160));
    if (this.settleInterruption(text)) {
      this.state.interim = "";
      this.emit();
      return;
    }
    // Whisper transcription takes real time (often 1-3s for a short clip), so
    // the old 1.5s window had usually already expired by the time the text
    // arrived — which silently ate short commands, "friday" included.
    // The recogniser's own scores count as evidence too: the level meter in the window and
    // the capture the recogniser hears can differ, and a short command that Whisper is sure
    // about (clear audio, confident language) should not be eaten for want of a meter bar.
    const sure =
      this.lastHeardQuality !== null && heardConfidence(text, this.lastHeardQuality) >= 0.8;
    if (
      words <= 2 &&
      !this.isStopHeard(text, false) &&
      !sure &&
      !voiceGate.heardSpeechWithin(6000)
    ) {
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
    if (repeat && !this.isStopHeard(corrected, false)) {
      markTurnStage("routed", false, "unclear transcript — asked to repeat");
      this.caption("friday", repeat);
      this.speak(repeat);
      this.state.interim = "";
      this.emit();
      return;
    }
    text = corrected;
    this.state.heard = text.slice(0, 160);

    // She read the words back and is waiting: a yes goes ahead with them, a no drops them, anything else is a new request.
    const readBack = this.pendingHeard;
    this.pendingHeard = null;
    if (readBack && Date.now() - readBack.at <= HEARD_CONFIRM_MS) {
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")) {
        this.caption("user", text);
        this.remember("heard-confirmed", readBack.command, "owner confirmed the read-back");
        // A yes confirms what was HEARD. A consequential command still has to be approved as an action.
        this.routeCommand(readBack.command);
        return;
      }
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "no")) {
        const again =
          languageId(readBack.command) === "en" ? "Okay, say it again." : "Theek hai, dobara bolo.";
        this.caption("user", text);
        this.caption("friday", again);
        this.state.status = "Listening";
        this.emit();
        this.speak(again);
        return;
      }
    }

    const waiting = brain.state.approval;
    if (
      waiting &&
      appControlNeedsApproval(waiting.tool) &&
      typeof waiting.at === "number" &&
      approvalFresh(waiting.at, Date.now())
    ) {
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")) {
        brain.approve(true);
        this.caption("user", text);
        this.caption("friday", "Approved.");
        this.emit();
        return;
      }
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "no")) {
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
        const expired = this.variedLine("expired", text);
        this.caption("friday", expired);
        this.state.status = "Confirmation expired";
        this.emit();
        this.speak(expired);
        return;
      }
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")) {
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
      if (confirmationVerdict(text) === "no") {
        this.state.pending = null;
        this.caption("user", text);
        const dropped = this.variedLine("cancelled", text);
        this.caption("friday", dropped);
        this.state.status = "Cancelled";
        this.emit();
        this.speak(dropped);
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
      wakeHeard: Date.now() - this.liveWakeAt < LIVE_WAKE_MS,
      followUpOpen:
        Date.now() < this.followUpUntil ||
        (this.state.handsFree && !this.wakeWordRequired && Date.now() < this.awakeUntil),
      lastSpoken: this.spokenText,
      recentlySpeaking: this.recentlySpeaking(),
      speaking: this.state.speaking,
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
    // While a note or meeting is being written, or translation is on, every line counts: the owner started it, so
    // the lines need no wake word, and a stop phrase ends it without her name.
    if (
      this.state.mode === "auto" &&
      microphoneAllowed(this.state.mode, this.state.paused) &&
      (voiceNotes.active() || this.translateTo)
    ) {
      const line = (wake.matched && wake.command ? wake.command : text).trim();
      if (this.handleNoteSpeech(line, wake.matched)) return;
    }
    const awake = Date.now() < this.awakeUntil;
    const stop = this.isStopHeard(text, wake.matched);
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
    if (accepted) this.liveWakeAt = 0; // a live wake covers one line, then it is spent
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
    this.turnStages.mark("sttFinalReceived");
    this.turnStages.mark("brainRequestStarted");
    this.to("wake-matched");
    // Task words ("cancel the task", "pause the task", "resume the task") act on background work only.
    // A plain stop below ends speech and never touches a task.
    const control = classifyVoiceControl(command || text);
    if (
      control.kind === "cancel-task" ||
      control.kind === "pause-task" ||
      control.kind === "resume-task"
    ) {
      this.trace("wake", `task control — ${control.kind}`);
      markTurnStage("routed", true, "", "task control");
      const said = runTaskControl(control);
      if (said) this.speak(said);
      this.state.status = "Listening";
      this.emit();
      return;
    }
    // "Do this in the background": the work becomes a voice task that runs the real Brain turn; the answer is
    // announced when it finishes. The Brain takes one turn at a time, so a new question during the task waits.
    const background = parseBackgroundRequest(command || text);
    if (background && this.state.mode === "auto") {
      this.trace("wake", "background request — started as a voice task");
      markTurnStage("routed", true, "", "background task");
      const made = startVoiceTask(background.label, async (_task, context) => {
        await context.checkpoint();
        const stopOnCancel = () => brain.stop();
        context.signal.addEventListener("abort", stopOnCancel, { once: true });
        try {
          const done = await askBrain(background.request, { brain, timeoutMs: 300_000 });
          await context.checkpoint();
          return completionLine(done.answer) || "Finished.";
        } finally {
          context.signal.removeEventListener("abort", stopOnCancel);
        }
      });
      if (!made.ok) this.speak(made.error);
      this.state.status = "Listening";
      this.emit();
      return;
    }
    // Voice notes, meeting notes and live translation: only on the owner's words, shown while they run.
    if (this.handleNoteSpeech(command || text)) return;
    // "FRIDAY, stop" is an interruption, never a task: cut the reply short and
    // go straight back to listening instead of sending "stop" to the brain.
    if (this.isStopHeard(text, wake.matched)) {
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
      const ready = this.variedLine("wake", text);
      this.caption("friday", ready);
      this.state.status = "Awake — go ahead";
      this.emit();
      this.speak(ready);
      return;
    }
    const lastCaption = this.state.captions[this.state.captions.length - 1];
    if (!(lastCaption?.who === "user" && lastCaption.text.includes(command))) {
      this.caption("user", command, false, { tag: "addressed" });
    }

    // A fluent sentence is not proof it was said: when the speech model itself was unsure (a weak per-token score, or a
    // weak guess about the language), read the words back and act only on a yes. A stop command is never held up.
    if (
      needsHeardConfirmation(
        command,
        this.lastHeardQuality,
        this.isStopHeard(command, wake.matched),
      )
    ) {
      const ask = heardReadBack(command);
      this.pendingHeard = { command, at: Date.now() };
      markTurnStage("routed", false, "read back — waiting for a yes");
      this.trace("segment", `unsure of "${command.slice(0, 80)}" — read back, waiting for a yes`);
      this.caption("friday", ask);
      this.state.status = "Waiting for yes or no";
      this.emit();
      this.speak(ask);
      return;
    }

    this.routeCommand(command);
  }

  /**
   * An addressed, understood command on its way to the Brain: continue a paused reply, held for a read-back, the
   * conduct words, a backchannel, the approval a consequential command needs, a clarifying question, or dispatch.
   * A read-back "yes" comes through here too, so confirming what was heard never approves the action itself.
   */
  private routeCommand(command: string) {
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
    // "haan" or "hmm" while she is speaking is the owner following along: she does not talk over herself.
    if (isHoldSound(command) && this.state.speaking) {
      this.remember("backchannel", command, "following along");
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

    const clarify = clarifyPrompt(
      command,
      Date.now() < this.followUpUntil && Boolean(this.spokenText.trim()),
    );
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
    this.voicedPrefix = "";
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
    affect.noteVoice({ tone: this.lastTone, speechMs: this.lastSpeechMs });
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
      const dropped = this.variedLine("cancelled", this.lastOwnerLine);
      this.caption("friday", dropped);
      this.state.status = "Cancelled";
      this.emit();
      this.speak(dropped);
    }
  }

  /** Follow the utterance that just began, showing its words as they settle. Never starts an action. */
  private startLiveWords() {
    const api = desktopApi();
    if (!api?.transcribe) return;
    this.liveWords ??= new LiveWords({
      audioSince: (from, maxMs) => {
        const all = preRollFrom(from, 0);
        const keep = Math.round((maxMs / 1000) * TARGET_RATE);
        return {
          samples: all.length > keep ? all.subarray(all.length - keep) : all,
          rate: TARGET_RATE,
        };
      },
      encodeWav,
      transcribe: async (wav) => {
        const voice = preferences.getSnapshot().voice;
        const language = whisperLanguageArg(voice.recognitionLang) || undefined;
        const out = await api.transcribe!({
          audioBytes: wav,
          mime: "audio/wav",
          language,
          localOnly: true,
          ...(voice.sttSize && voice.sttSize !== "auto"
            ? { model: voice.sttSize, sttSize: voice.sttSize }
            : {}),
        });
        return out?.ok ? { ok: true, text: out.text ?? "" } : { ok: false };
      },
      speaking: () => voiceGate.heardSpeechWithin(1200),
      onUpdate: (update) => {
        if (this.state.mode !== "auto" || this.state.paused || this.state.speaking) return;
        this.state.interim = update.shown;
        this.emit();
      },
    });
    this.liveWords.start(performance.now() - 400);
    if (this.liveWordsTimer) return;
    this.liveWordsTimer = setInterval(() => {
      const follower = this.liveWords;
      if (!follower?.isActive()) return this.stopLiveWords(false);
      void follower.tick();
    }, 400);
  }

  private stopLiveWords(stopFollower = true) {
    if (stopFollower) this.liveWords?.stop();
    if (this.liveWordsTimer) clearInterval(this.liveWordsTimer);
    this.liveWordsTimer = null;
  }

  /** Pause the voice the moment the owner starts talking; the answer keeps being written. */
  private holdForInterruption() {
    if (this.interruptHold) return;
    this.bargeShadow.liveFired(performance.now(), {
      playbackLevel: speechRms(),
      micLevel: this.bargeMicLevel,
    });
    this.interruptStages.reset();
    this.interruptStages.mark("interruptCandidate");
    this.clearHoldLines();
    this.dropPlayback();
    // The stop was asked of the player here; the speaker itself was not measured.
    this.interruptStages.mark("playbackLastAudibleSample");
    this.to("barge-in");
    this.interruptHold = { at: Date.now(), timer: null };
    this.armInterruptTimer(4000);
  }

  private armInterruptTimer(ms: number) {
    const hold = this.interruptHold;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      if (this.interruptHold !== hold) return;
      // Still hearing speech: the words have not been recognised yet. Wait, up to twenty seconds in all.
      if (Date.now() - hold.at < 20000 && voiceGate.heardSpeechWithin(2000)) {
        this.armInterruptTimer(2000);
        return;
      }
      this.trace("speech", "nothing was said that needs an answer — carrying on");
      this.resumeAfterInterruption();
    }, ms);
  }

  /** The owner only nodded along, or it was noise: say what was paused, then keep following the answer. */
  private resumeAfterInterruption() {
    const hold = this.interruptHold;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    this.interruptHold = null;
    this.interruptStages.finish();
    this.interruptStages.reset();
    const rest = this.unfinished;
    this.unfinished = "";
    const later = this.deferredStream;
    this.deferredStream = null;
    if (rest) this.speak(rest);
    if (later) this.speakStreamed(later.runId, later.text, later.final);
    this.emit();
  }

  /** The words were a real interruption: now the answer in progress is stopped for good. */
  private confirmInterruption() {
    const hold = this.interruptHold;
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    this.interruptHold = null;
    this.deferredStream = null;
    this.interruptStages.mark("interruptConfirmed");
    this.interruptStages.finish();
    this.interruptStages.reset();
    brain.stop();
  }

  /** True when this line only resumed the paused reply and needs no further handling. */
  private settleInterruption(text: string): boolean {
    if (!this.interruptHold) return false;
    const verdict = judgeInterruption(text, {
      waitingForAnswer: Boolean(this.state.pending || this.pendingHeard),
      selfEcho: this.isSelfEcho(text),
    });
    if (verdict === "resume") {
      this.trace("speech", `"${text.trim().slice(0, 40)}" is not an interruption — carrying on`);
      this.remember("following-along", text, "resumed");
      this.resumeAfterInterruption();
      return true;
    }
    this.confirmInterruption();
    return false;
  }

  /** Stop playback without touching the brain. A newer clip must not start. */
  private dropPlayback(hold = true) {
    if (hold && (this.state.speaking || this.speechQueue.length)) {
      const held = holdInterrupted([this.spokenText, ...this.speechQueue]);
      if (held) this.unfinished = held;
    }
    this.speechGen += 1;
    this.speechQueue = [];
    this.bargeDetector.playbackEnded();
    this.streamSpeaker?.cancel();
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
    return isSelfEchoTranscript(heard, this.spokenText, { speaking: this.state.speaking });
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
    this.turnStages.mark("brainFirstToken");
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
    // Numbers, money, dates and acronyms are said as words in the language of each span; the owner's
    // pronunciation entries win. The echo filter then compares against what is really spoken.
    const prepared = prepareForSpeech(spoken, preferences.getSnapshot().voice.pronunciations);
    if (!prepared) {
      markTurnStage("spoken", false, "the reply had nothing speakable (code or markdown only)");
      return;
    }
    this.speechQueue.push(prepared);
    if (this.speechQueue.length === 1 && this.state.speaking) this.prefetchNext(this.speechGen);
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

  /** How a reply will be spoken: the engine, the owner's voice settings, the mood of the moment. */
  private speakPlan(spoken: string) {
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
    const cloudClip = privacy ? undefined : this.cloudClipFor();
    const argTuning = {
      ...tuning,
      lang: spokenLang.lang || tuning.lang || "hi-IN",
      rate: tone.rate,
      pitch: tone.pitch,
      volume: tone.volume,
      allowCloud: fallen === "neural" && !privacy,
      expressive: voicePrefs.expressiveSpeech !== false,
      ...(localVoice
        ? {
            voiceName: "",
            kind: (fallen === "sapi" || privacy ? "system" : "neural") as "system" | "neural",
          }
        : {}),
      ...(cloudClip ? { cloudClip } : {}),
    };
    return { fallen, tuning, privacy, tone, argTuning };
  }

  /** Start making the audio of the next waiting sentence so the gap between two sentences stays short. */
  private prefetchNext(gen: number) {
    const next = this.speechQueue[0];
    if (!next || gen !== this.speechGen) return;
    try {
      const plan = this.speakPlan(next);
      if (plan.argTuning.kind !== "system") prefetchSpeech(next, plan.argTuning);
    } catch {
      /* the sentence is simply made when its turn comes */
    }
  }

  private cloudSpeechKeys: Record<string, boolean> = {};
  private cloudSpeechKeysAt = 0;
  private cloudSpeechBlockedUntil = 0;
  private cloudLedger: ReturnType<typeof loadLedger> | null = null;
  private streamSpeaker: ReturnType<typeof createStreamingSpeak> | null = null;
  private streamSpeakerPlayback = false;
  private liveWakeAt = 0;
  private translateTo: "en" | "hi" | null = null;

  /** The target language while live translation is on, or null. */
  translationTarget(): "en" | "hi" | null {
    return this.translateTo;
  }

  /**
   * Notes by voice. A start phrase begins a text-only note or meeting (nothing is recorded as audio), what is
   * heard after it is written as lines instead of going to the Brain, and a stop phrase ends it; a meeting then
   * gets minutes from the Brain as a background task. Live translation answers each line with its translation.
   * Returns true when the line was handled here.
   */
  /**
   * Is this line a stop? The short words always are. A longer phrase ("please stop", "bas karo", "ek minute") counts
   * only when she is called by name, speaking, or awake, so a sentence between two other people cannot cancel her work.
   */
  private isStopHeard(text: string, named: boolean): boolean {
    if (isPlainStop(text)) return true;
    if (!isStopCommand(text)) return false;
    return named || this.state.speaking || this.recentlySpeaking() || Date.now() < this.awakeUntil;
  }

  private handleNoteSpeech(heard: string, named = false): boolean {
    if (this.state.mode !== "auto") return false;
    const command = classifyNoteCommand(heard);
    const active = voiceNotes.active();
    if (command?.kind === "start") {
      if (active) {
        this.speak("A note is already running. Say stop note to finish it.");
      } else {
        voiceNotes.purge(preferences.getSnapshot().voice.notesRetentionDays);
        voiceNotes.start(command.note);
        this.trace("wake", `${command.note} started by voice`);
        this.speak(
          command.note === "meeting"
            ? "Meeting notes shuru. I am writing down what I hear as text, no audio. Say stop meeting to finish."
            : "Note shuru. I am writing down what I hear as text, no audio. Say stop note to finish.",
        );
      }
      markTurnStage("routed", true, "", "note");
      this.emit();
      return true;
    }
    if (command?.kind === "stop") {
      const done = active ? voiceNotes.stop() : null;
      if (!done) {
        this.speak("No note is running.");
      } else {
        this.speak(`Saved ${done.lines.length} line${done.lines.length === 1 ? "" : "s"}.`);
        if (done.kind === "meeting" && done.lines.length >= 3) this.startMinutes(done.id);
      }
      markTurnStage("routed", true, "", "note");
      this.emit();
      return true;
    }
    if (command?.kind === "translate-on" || command?.kind === "translate-off") {
      this.translateTo = command.kind === "translate-on" ? command.to : null;
      this.speak(
        this.translateTo
          ? `Translating to ${this.translateTo === "en" ? "English" : "Hindi"}. Say stop translating to end.`
          : "Translation off.",
      );
      markTurnStage("routed", true, "", "translation");
      this.emit();
      return true;
    }
    // A confirmation or another pending question is never swallowed into a note.
    if (this.state.pending) return false;
    // A spoken stop ends her speech only; it is never written into the note or sent for translation.
    if (this.isStopHeard(heard, named)) return false;
    if (active) {
      voiceNotes.append(heard);
      markTurnStage("routed", true, "", "note line");
      this.state.status = "Writing the note";
      this.emit();
      return true;
    }
    if (this.translateTo) {
      const to = this.translateTo;
      markTurnStage("routed", true, "", "translation");
      const made = startVoiceTask("Translation", async (_task, context) => {
        await context.checkpoint();
        const done = await askBrain(translationPrompt(heard, to), { brain, timeoutMs: 60_000 });
        await context.checkpoint();
        return completionLine(done.answer, 400) || "I could not translate that.";
      });
      // A full queue is said, not swallowed: the line was heard but cannot be translated yet.
      if (!made.ok) this.speak(made.error);
      this.emit();
      return true;
    }
    return false;
  }

  private startMinutes(id: string) {
    const note = voiceNotes.getSnapshot().notes.find((n) => n.id === id);
    if (!note) return;
    startVoiceTask("Meeting minutes", async (_task, context) => {
      await context.checkpoint();
      const done = await askBrain(minutesPrompt(note), { brain, timeoutMs: 300_000 });
      await context.checkpoint();
      voiceNotes.setSummary(id, done.answer);
      return "The meeting minutes are saved with the note.";
    });
  }

  private bargeDetector = new BargeInDetector();
  /** What the detector and the live pause did on this PC's devices, kept across restarts (shadow-evaluation.ts). */
  private bargeLedger = ShadowLedger.load(
    typeof localStorage === "undefined" ? null : localStorage,
  );
  private bargeShadow = new BargeShadow(700, (outcome) => this.bargeLedger.record(outcome));
  private bargeShadowOff: (() => void) | null = null;
  private bargeMicLevel = 0;
  private bargeSavedAt = 0;

  private saveBargeLedger() {
    this.bargeLedger.save(typeof localStorage === "undefined" ? null : localStorage);
    this.bargeSavedAt = Date.now();
  }

  /**
   * Shadow barge-in: the acoustic detector (`BargeInDetector`) runs on the shared capture with the real speaker
   * level, and is only compared with what the live path did. It changes nothing she does. The comparison shows,
   * on the owner's own microphone and speakers, where the guard and the detector disagree.
   */
  private startBargeShadow() {
    if (this.bargeShadowOff) return;
    // The shadow is a measurement: when the capture has no free listener it is simply not run.
    try {
      this.bargeLedger.beginSession();
      this.bargeShadowOff = subscribeCaptureFrames((samples, rate, atMono) => {
        if (this.state.mode !== "auto" || !this.state.speaking) return;
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const v = Number(samples[i]) || 0;
          sum += v * v;
        }
        const micLevel = samples.length ? Math.sqrt(sum / samples.length) : 0;
        const playbackLevel = speechRms();
        this.bargeMicLevel = micLevel;
        // Time spent playing with the detector listening: the denominator of "false interruptions per hour".
        if (rate > 0) this.bargeLedger.addExposure((samples.length / rate) * 1000);
        const fired = this.bargeDetector.push({
          t: atMono,
          speech: voiceGate.heardSpeechWithin(250),
          micLevel,
          playbackLevel,
        });
        if (fired) this.bargeShadow.detectorFired(performance.now(), { playbackLevel, micLevel });
        if (Date.now() - this.bargeSavedAt > 30_000) this.saveBargeLedger();
      });
    } catch {
      this.bargeShadowOff = null;
    }
  }

  private stopBargeShadow() {
    this.bargeShadowOff?.();
    this.bargeShadowOff = null;
    this.bargeDetector.playbackEnded();
    this.bargeShadow.tick(performance.now() + 10_000); // settle pairings that were still waiting
    this.saveBargeLedger();
  }

  /** One line for Voice diagnostics. */
  bargeShadowLine(): string {
    return this.bargeShadow.line(performance.now());
  }

  /**
   * Whether the evidence on this PC would support letting the acoustic detector make the interruption decision.
   * Advice for a person: nothing here switches the decision, and the live path stays the only one that acts.
   */
  bargeShadowVerdictLine(): string {
    this.bargeShadow.tick(performance.now());
    return verdictLine(shadowVerdict(this.bargeLedger.report()));
  }

  /** The measurements as JSON for a bug report or the hardware validation record. */
  bargeShadowReport(): string {
    this.bargeShadow.tick(performance.now());
    const report = this.bargeLedger.report();
    return JSON.stringify({ report, verdict: shadowVerdict(report) }, null, 2);
  }

  resetBargeShadow() {
    this.bargeLedger.reset();
    this.saveBargeLedger();
  }

  private wakeFeed: ReturnType<typeof createWakeFrameFeed> | null = null;

  /**
   * Live wake scoring (opt-in, `voice.liveWake`): the one shared capture is cut into 80 ms frames and scored on this
   * PC by the wake worker. It runs only in Auto mode with the wake word required (hands-free off), not paused,
   * not muted and not while FRIDAY speaks. A hit opens the same awake window a matched wake phrase opens. Without
   * an openWakeWord model the feed says so once and stops; the normal wake matching is unchanged.
   */
  private ensureLiveWake() {
    if (this.wakeFeed || this.state.mode !== "auto") return;
    const voice = preferences.getSnapshot().voice;
    if (voice.liveWake !== true) return;
    this.wakeFeed = createWakeFrameFeed({
      sessionId: "auto",
      wakeWord: voice.wakeWord || "friday",
      allowed: () =>
        this.state.mode === "auto" &&
        !this.state.paused &&
        !this.state.muted &&
        !this.state.speaking &&
        !this.state.handsFree &&
        preferences.getSnapshot().voice.liveWake === true,
      onWake: ({ score }) => {
        this.lastWakeAt = Date.now();
        this.liveWakeAt = Date.now();
        this.setAwake();
        this.trace("segment", `wake word heard live (score ${score.toFixed(2)})`);
        this.emit();
      },
      onStatus: (status, detail) => {
        this.liveWakeNote = detail ? `${status} — ${detail}` : status;
        if (status === "unavailable") {
          this.trace("segment", `live wake unavailable — ${detail ?? "no model"}`);
        }
      },
    });
    this.wakeFeed.start();
  }

  private stopLiveWake() {
    this.wakeFeed?.stop();
    this.wakeFeed = null;
    this.liveWakeNote = "";
  }

  private liveWakeNote = "";

  /** One line for Voice diagnostics: off, listening, blocked, or why it cannot run. */
  liveWakeLine(): string {
    if (preferences.getSnapshot().voice.liveWake !== true) return "off (Settings → Voice)";
    if (!this.wakeFeed) return "on, waiting for Auto mode";
    const stats = this.wakeFeed.stats();
    const base = this.liveWakeNote || "starting";
    return stats.unavailable
      ? base
      : `${base} · ${stats.chunks} chunks scored · last score ${stats.lastScore.toFixed(2)}`;
  }

  /** The local recogniser's measurements for a finished utterance, kept until the arbiter lets that text through. */
  private localFinalMeta = new Map<string, LocalFinalMeta>();
  private rememberLocalMeta(text: string, meta: LocalFinalMeta) {
    if (this.localFinalMeta.size >= 8) {
      const oldest = this.localFinalMeta.keys().next().value;
      if (oldest !== undefined) this.localFinalMeta.delete(oldest);
    }
    this.localFinalMeta.set(text, meta);
  }

  private sttArbiterInstance: ReturnType<typeof createUtteranceArbiter> | null = null;
  /** The one gate between a finished utterance (either recogniser) and a Brain turn. */
  private sttArbiter() {
    this.sttArbiterInstance ??= createUtteranceArbiter({
      authority: () => sanitizeCloudPrefs(preferences.getSnapshot().voice.cloudVoice).sttAuthority,
      cloudHealthy: () => this.captionStt?.stats().status === "open",
      gate: () => this.cloudSttGate(),
      submit: (utterance) => this.acceptFinalUtterance(utterance),
    });
    return this.sttArbiterInstance;
  }

  /**
   * The cloud permissions, asked again for every Sarvam final that wants to start a turn: cloud voice on, Sarvam
   * allowed, privacy mode off, a saved key, quota left. Nothing is counted here.
   */
  private cloudSttGate(): { ok: boolean; reason?: string } {
    const voice = preferences.getSnapshot().voice;
    const cloud = sanitizeCloudPrefs(voice.cloudVoice);
    if (voice.privacyMode === true) return { ok: false, reason: "privacy mode is on" };
    if (!cloud.cloudEnabled || !cloud.allowedProviders.includes("sarvam"))
      return { ok: false, reason: "cloud voice or Sarvam is switched off" };
    this.cloudLedger ??= loadLedger(typeof localStorage === "undefined" ? null : localStorage);
    const verdict = canStreamSpeechToText(
      {
        prefs: cloud,
        keys: this.cloudSpeechKeys,
        privacyMode: false,
        online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
      },
      this.cloudLedger,
    );
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.error };
  }

  /** A finished utterance that the arbiter let through: from here it is one turn, whichever engine heard it. */
  private acceptFinalUtterance(utterance: Utterance) {
    const text = utterance.text;
    const meta = utterance.source === "local" ? this.localFinalMeta.get(text) : undefined;
    this.localFinalMeta.delete(text);
    if (utterance.source === "sarvam")
      this.trace("segment", "the Sarvam sentence starts this turn");
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
    // Only his own voice teaches the baseline: FRIDAY's own speech coming back through the microphone, and a
    // repeated line, were being measured as him, which pushed his "usual" voice and made every real turn read tense.
    this.lastTone = assessTone(meta?.prosody);
    this.lastSpeechMs = meta?.durationMs ?? null;
    this.lastHeardQuality = meta?.quality ?? null;
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
  }

  private captionStt: ReturnType<typeof createRealtimeStt> | null = null;
  private captionOff: (() => void) | null = null;
  private captionStarting = false;
  private captionBlockedUntil = 0;
  private readonly captionBilling = new SttBillingReconciler();

  /**
   * Live partial words from Sarvam, shown as the caption while the owner speaks. Off by default; it sends the
   * microphone audio of each utterance to Sarvam, so it needs the toggle, cloud voice on, the provider allowed, a
   * saved key, privacy mode off and quota left. It only draws words: the one turn that reaches the Brain is still
   * made by the existing recognition path, so a caption can never start a second turn.
   */
  private async ensureCloudCaptions() {
    if (this.captionStt || this.captionStarting || Date.now() < this.captionBlockedUntil) return;
    const voice = preferences.getSnapshot().voice;
    const cloud = sanitizeCloudPrefs(voice.cloudVoice);
    if (!cloud.streamCaptions || this.state.mode !== "auto" || voice.privacyMode === true) return;
    const api = desktopApi();
    if (!api?.voiceStreamOpen) return;
    this.captionStarting = true;
    try {
      if (Date.now() - this.cloudSpeechKeysAt > 60_000) {
        this.cloudSpeechKeysAt = Date.now();
        this.cloudSpeechKeys = (await api.voiceCloudKeyStatus?.().catch(() => null)) ?? {};
      }
      const store = typeof localStorage === "undefined" ? null : localStorage;
      this.cloudLedger ??= loadLedger(store);
      const ledger = this.cloudLedger;
      const gate = canStreamSpeechToText(
        {
          prefs: cloud,
          keys: this.cloudSpeechKeys,
          privacyMode: false, // privacy mode already returned above
          online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
        },
        ledger,
      );
      if (!gate.ok) {
        this.captionBlockedUntil = Date.now() + 60_000;
        this.trace("segment", `live captions skipped — ${gate.error}`);
        return;
      }
      const stt = createRealtimeStt({
        api,
        sessionId: "auto",
        // First send and first partial are stamped on the turn clock, so the self-test can show a real measurement.
        clock: this.turnStages,
        onTranscript: (event) => {
          if (event.type !== "partial") return;
          if (this.state.mode !== "auto" || this.state.paused || this.state.speaking) return;
          this.state.interim = event.text;
          this.emit();
        },
        // A finished Sarvam sentence goes to the arbiter, which lets it start a turn only in the owner's
        // "Sarvam's final text starts the turn" mode and only while every cloud gate still passes. A partial never does.
        onFinalTurn: (final) => {
          const decision = this.sttArbiter().cloudFinal(final.text, final.language, final.turnId);
          if (decision.action === "drop" && decision.reason === "blocked")
            this.trace(
              "segment",
              `Sarvam text not used — ${decision.detail ?? "a cloud gate is closed"}`,
            );
        },
        // The provider's own count replaces the client's estimate; it is recorded once when the stream closes.
        onBilledSeconds: (seconds) => this.captionBilling.reportBilled(seconds),
        onStatus: (status, detail) => {
          if (status === "closed" || status === "failed" || status === "retrying")
            this.sttArbiter().cloudLost(); // a held local sentence is used now, not after the wait
          if (status !== "failed") return;
          this.captionBlockedUntil = Date.now() + 60_000;
          this.trace("segment", `live captions stopped — ${detail ?? "the stream failed"}`);
          void this.stopCloudCaptions();
        },
      });
      // The name she answers to and the wake word help the recogniser spell them (saaras:v4 takes up to 50 terms).
      const keyterms = [voice.addressName, voice.wakeWord]
        .map((t) => String(t || "").trim())
        .filter(Boolean);
      const opened = await stt.start({
        language: "auto",
        hinglish: true,
        ...(keyterms.length ? { keyterms } : {}),
      });
      if (!opened.ok) {
        this.captionBlockedUntil = Date.now() + 60_000;
        this.trace("segment", `live captions skipped — ${opened.error ?? "refused"}`);
        return;
      }
      ledger.record("sarvam", 0.01); // one request counted when the stream opens
      saveLedger(store, ledger);
      this.captionStt = stt;
      try {
        this.captionOff = subscribeCaptureFrames((samples, rate) => {
          if (!this.captionStt || this.state.mode !== "auto") return;
          // Privacy mode, the cloud switch or the caption switch turned off mid-session ends the stream at once.
          const live = preferences.getSnapshot().voice;
          if (
            live.privacyMode === true ||
            !live.cloudVoice.cloudEnabled ||
            !live.cloudVoice.streamCaptions
          ) {
            void this.stopCloudCaptions();
            return;
          }
          if (this.state.paused || this.state.muted || this.state.speaking) return;
          if (!voiceGate.heardSpeechWithin(CAPTION_TAIL_MS)) return;
          if (this.captionStt.pushFrame(samples, rate))
            this.captionBilling.addSentSeconds(samples.length / rate);
        });
      } catch {
        // No free capture listener: the stream is closed again instead of running with nothing to send.
        this.captionOff = null;
        void this.stopCloudCaptions();
      }
    } finally {
      this.captionStarting = false;
    }
  }

  private async stopCloudCaptions() {
    this.captionOff?.();
    this.captionOff = null;
    const stt = this.captionStt;
    this.captionStt = null;
    this.sttArbiter().cloudLost();
    if (stt) {
      await stt.finish().catch(() => undefined);
      // The provider reports what it billed when the session ends; give it a moment, then record once: its figure
      // if it came, the client's own count if the stream dropped first.
      for (let waited = 0; waited < 800 && !this.captionBilling.hasBilled; waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
      await stt.stop().catch(() => undefined);
      const owed = this.captionBilling.take();
      if (owed.seconds > 0) {
        const store = typeof localStorage === "undefined" ? null : localStorage;
        this.cloudLedger ??= loadLedger(store);
        this.cloudLedger.record("sarvam", owed.seconds / 60);
        saveLedger(store, this.cloudLedger);
        this.trace(
          "segment",
          `Sarvam captions billed ${owed.seconds.toFixed(1)} s (${owed.source === "provider" ? "provider's count" : "estimate"})`,
        );
      }
    }
  }

  /** One persistent Sarvam stream shared by the clauses of a reply; the REST call is its fallback. */
  private streamingSpeak() {
    const api = desktopApi();
    this.streamSpeakerPlayback =
      sanitizeCloudPrefs(preferences.getSnapshot().voice.cloudVoice).streamPlayback === true;
    this.streamSpeaker ??= createStreamingSpeak({
      api,
      rest: async (provider, request) =>
        (await api?.voiceCloudSpeak?.(provider, request)) ?? {
          ok: false,
          error: "cloud speech runs in the installed desktop app",
        },
      clock: this.turnStages,
      // Play while it arrives only when the owner switched it on and the browser can do it.
      media:
        sanitizeCloudPrefs(preferences.getSnapshot().voice.cloudVoice).streamPlayback &&
        typeof MediaSource !== "undefined"
          ? (globalThis as unknown as { MediaSource: never; Audio: never; URL: never })
          : null,
      note: (line) => this.trace("segment", line),
    });
    return this.streamSpeaker;
  }

  /**
   * The owner's chosen cloud voice (Sarvam or Azure), or nothing. It is asked once per clause; a refusal (quota,
   * privacy, no key, an error) hands the clause to the normal ladder and pauses the cloud for a minute so one
   * failure never adds delay to every clause. Text that looks sensitive is never sent.
   */
  private cloudClipFor():
    | ((
        text: string,
        lang: string,
        tone: { rate: number; pitch: number; volume: number },
      ) => Promise<{
        audioBase64: string;
        mime: string;
        engine: string;
        voice?: string;
        audio?: unknown;
        release?: () => void;
      } | null>)
    | undefined {
    const cloud = sanitizeCloudPrefs(preferences.getSnapshot().voice.cloudVoice);
    const provider = cloud.speakWith;
    if (!provider || !cloud.cloudEnabled || !cloud.allowedProviders.includes(provider))
      return undefined;
    return async (text, lang, tone) => {
      if (Date.now() < this.cloudSpeechBlockedUntil || looksSensitive(text)) return null;
      const api = desktopApi();
      if (Date.now() - this.cloudSpeechKeysAt > 60_000) {
        this.cloudSpeechKeysAt = Date.now();
        this.cloudSpeechKeys = (await api?.voiceCloudKeyStatus?.().catch(() => null)) ?? {};
      }
      const store = typeof localStorage === "undefined" ? null : localStorage;
      this.cloudLedger ??= loadLedger(store);
      const ledger = this.cloudLedger;
      const out = await speakWithCloud(
        provider,
        {
          text,
          language: lang,
          pace: tone.rate,
          prefs: cloud,
          keys: this.cloudSpeechKeys,
          privacyMode: preferences.getSnapshot().voice.privacyMode === true,
          online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
        },
        {
          ledger,
          persistLedger: () => saveLedger(store, ledger),
          ...(provider === "sarvam" && cloud.streaming
            ? {
                speak: (
                  p: string,
                  r: { text: string; language: string; speaker?: string; pace?: number },
                ) => this.streamingSpeak().speak(p, r),
              }
            : {}),
        },
      );
      if (!out.ok) {
        this.cloudSpeechBlockedUntil = Date.now() + 60_000;
        this.trace("segment", `cloud voice skipped — ${out.error}`);
        return null;
      }
      return {
        audioBase64: out.audioBase64,
        mime: out.mime,
        engine: provider,
        ...(out.audio ? { audio: out.audio } : {}),
        ...(out.release ? { release: out.release } : {}),
      };
    };
  }

  /**
   * Play one clip. A barge-in bumps speechGen, and a late neural buffer from
   * the old clip must not start. The microphone stays open so the owner can
   * interrupt; isSelfEcho drops FRIDAY's own voice.
   */
  private playSpoken(spoken: string, gen: number): Promise<void> {
    if (gen !== this.speechGen) return Promise.resolve();
    if (!spokenReplyAllowed(this.state.mode, this.state.muted)) return Promise.resolve();
    // "Requested" is not "heard": the first sound is stamped separately, when the player really starts.
    this.turnStages.mark("firstSpeakableSentence");
    this.turnStages.mark("ttsRequestStarted");
    if (this.turnClock.audioAt == null) {
      this.turnClock = { ...this.turnClock, audioAt: Date.now() };
      const latency = firstAudioLatency(this.turnClock.tokenAt, this.turnClock.audioAt);
      if (latency != null) {
        voiceBudgets({ listenMs: 1000, audioMs: latency, idleCpu: [0.2], memoryMb: [100, 100] });
      }
    }
    const plan = this.speakPlan(spoken);
    const { fallen, tuning, privacy, tone } = plan;
    this.state.tts = { ...this.state.tts, engine: fallen };
    const out = outputReachable({ deviceId: "default", volume: tone.volume });
    if (!out.ok) this.state.status = out.reason;
    this.spokenText = spoken;
    this.openFollowUp();
    // The next sentence, if it is already waiting, is made while this one plays.
    this.prefetchNext(gen);
    return speakText(spoken, plan.argTuning, {
      onStart: () => {
        if (gen !== this.speechGen) return;
        this.turnStages.mark("playbackFirstSample");
        this.bargeDetector.playbackStarted(performance.now());
        this.echoUntil = Date.now() + 120_000;
        if (this.to("tts-start")) this.pauseForSpeech();
        this.emit();
      },
      onEnd: () => {
        if (gen !== this.speechGen) return;
        this.bargeDetector.playbackEnded();
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
    })
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
  /** The opt-in realtime timing is on, in Auto mode, with listening not paused. */
  private realtimeActive(): boolean {
    return realtimeStatus({
      enabled: preferences.getSnapshot().voice.realtimeExperiment === true,
      surface: this.state.mode === "auto" ? "auto" : "manual",
      paused: this.state.paused,
      gpuVramGb: 0,
      s2sRuntimeInstalled: false,
      paidAccess: false,
      cloudKey: false,
      privacyMode: true,
    }).active;
  }

  private speakStreamed(runId: string, text: string, final: boolean) {
    if (!text.trim()) return;
    if (this.interruptHold) {
      // Paused for a possible interruption: keep the newest text and say it if the owner only nodded along.
      this.deferredStream = { runId, text, final };
      return;
    }
    if (this.voicedRunId !== runId) {
      this.voicedRunId = runId;
      this.voicedChars = 0;
      this.voicedPrefix = "";
    }
    const rewind = nextSpokenCursor(this.voicedChars, text.length, {
      prefix: this.voicedPrefix,
      text,
    });
    if (rewind.rewritten) {
      this.unfinished = "";
      this.dropPlayback(false);
      this.voicedChars = 0;
      this.voicedPrefix = "";
    }
    if (text.length < this.voicedChars) return;
    const pending = text.slice(this.voicedChars);
    let chunk = takeSpeakable(pending, final);
    if (!chunk.spoken && this.voicedChars === 0 && this.realtimeActive())
      chunk = earlyClause(pending);
    if (!chunk.spoken) return;
    this.voicedChars += chunk.consumed;
    this.voicedPrefix = text.slice(0, this.voicedChars);
    for (const part of splitLongSpeech(chunk.spoken)) this.speak(part);
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
attachVoiceTaskSpeaker(
  (text) => assistantMode.announceTask(text),
  () => assistantMode.taskBusy(),
);

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
    wakeEngine: live.wakeEngine.engine,
    voiceState: live.voiceState,
    download: live.download
      ? `${live.download.label}${live.download.percent == null ? "" : ` ${live.download.percent}%`}`
      : "",
    interventions: assistantMode.interventionCount(),
    lastIntervention: assistantMode.lastInterventionText(),
    lastCheck: assistantMode.lastCheckSummary(),
  };
});

// A spoken "fix your voice" runs the same check-and-mend as the Fix voice button and says what it found.
registerVoiceRepair(async () => {
  const result = await assistantMode.selfCheckVoice(true);
  if (!result) return "My voice repair runs in the installed app. Open FRIDAY and ask again.";
  if (result.ok)
    return "I checked my microphone, speech recognition and voice. All of it is working.";
  const broken = result.parts.filter((part) => !part.ok && !part.optional);
  return `I found a problem with ${broken.map((part) => `${part.label} (${part.detail})`).join("; ")} and started the repair. Give it a moment, then ask me again.`;
});

bindVoiceSurface(() => {
  const live = assistantMode.getSnapshot();
  return { mode: live.mode, muted: live.muted };
});
