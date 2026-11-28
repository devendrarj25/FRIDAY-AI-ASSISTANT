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
import {
  brain,
  scrubSendContext,
  VOICE_SEND,
  type QuickAnswer,
  type TurnHints,
} from "./brain-engine";
import { billing } from "./billing";
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
  cleanedLevel,
  encodeWav,
  preRollFrom,
  subscribeCaptureFrames,
  TARGET_RATE,
} from "./pcm-capture";
import { LiveWords, livePassDeps } from "./voice-engine/live-words";
import { tidyTranscript, type TidyChange } from "./voice-engine/transcript-tidy";
import {
  buildTurnRecord,
  languageMix,
  preferStreamLang,
  ScriptPolicyTally,
  shapeHeardText,
  STREAM_LANG_MIN_CONF,
  streamLocale,
  streamWanted,
  subscribeStreamTurns,
  TurnTracker,
  type StreamPlan,
  type StreamTurn,
  type TurnRecord,
} from "./voice-engine/stream-session";
import { commandHints, streamHotwords } from "./voice-engine/hotwords";
import type { CommandHit, CommandRegistryEntry } from "./voice-engine/command-lane";
import { judgeAddressedness } from "./voice-engine/addressedness";
import { detectSelfRepair, repairAuditLine } from "./voice-engine/self-repair";
import { whisperLanguageArg } from "./voice-stt";
import { desktopApi, isBootHolding, whenBootDone } from "./desktop";
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
  pttCloseNow,
  pttFocusLost,
  pttPhase,
  pttPress,
  pttRelease,
  pttSetAllowed,
  pttTailMs,
  pttToggle,
  resetPtt,
  setPttTailMs,
  subscribePtt,
  type ListenStyle,
  type PttPhase,
} from "./push-to-talk";
import { wakeThreshold } from "./wake-room";
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
import { createStreamingSpeak, pickClauseRule } from "./voice-engine/streaming-speak";
import {
  alignedAnchors,
  reinsertParts,
  stripDeliveryTags,
  type TagAnchor,
} from "./voice-engine/delivery-tags";
import { StageClock, voiceLatency, type LatencyMonitor } from "./voice-engine/latency-monitor";
import { createRealtimeStt } from "./voice-engine/sarvam-realtime-stt";
import { ShadowLedger, shadowVerdict, verdictLine } from "./voice-engine/shadow-evaluation";
import { SoakRecorder } from "./voice-engine/soak-recorder";
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
import { identity as replyIdentity } from "./brain/identity";
import { replyLanguageLine } from "./brain/turn-hints";
import { attentionWindowMs } from "./attention-window";
import { preferSpoken, socialRegister } from "./conversation-style";
import { chooseFresh, vary, type RepeatBucket } from "./brain/anti-repeat";
import { diagnoseVoice, problemLine, type SelfCheckResult } from "./voice-selfcheck";
import { SUPERVISOR_COOLDOWN_MS, superviseVoice } from "./voice-supervisor";
import { startPrewarm, cancelPrewarm, ackClipFor, readyAckClipIds } from "./voice-prewarm";
import { playAckSamples, stopAckClip } from "./voice-engine/ack-player";
import { clearEchoReference, echoDiagnostics } from "./voice-engine/echo-live";
import { prewarmLine, type PrewarmOutcome } from "./voice-engine/prewarm";
import type { PlayedReply } from "./voice-engine/played-text";
import {
  activeVoiceSettings,
  beginPlayedReply,
  billingAllowsPaidNow,
  cloudFallbackVoice,
  duckSpeech,
  lastClipUsedPcm,
  lastSpeechRoute,
  localVoiceReadiness,
  neuralVoiceStatus,
  pcmPlaybackNote,
  playbackEndsAt,
  playedReplyCut,
  playbackPressure,
  playedReplySnapshot,
  prefetchSpeech,
  refreshOutputDevices,
  resetPcmPlayback,
  speakText,
  spokenSummary,
  statusWithVoice,
  stopSpeaking,
} from "./voice-library";
import { formatVoiceProbeReport, noteVoiceCheck } from "./voice-doctor";
import {
  acceptsVoiceTurn,
  approvalFresh,
  approvalTtlMs,
  backchannel,
  bindVoiceSurface,
  clarifyPrompt,
  endpointSilenceMs,
  foreignAssistant,
  holdInterrupted,
  duplicateFinalUtterance,
  nextSpokenCursor,
  isBoundConfirmation,
  replyLanguage,
  confirmationVerdict,
  createNarrator,
  busyReply,
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
  confirmQuestion,
  effectiveConfirmLevel,
  heardNeedsReadBack,
  heardQuestion,
  voiceConfirmKind,
  voiceNeedsConfirmation,
  wakeOnCooldown,
  wantsContinue,
  type VoiceAudit,
} from "./voice-session";
import {
  buildConfirmDigest,
  digestLine as confirmDigestLine,
  explainDigestAnswer,
  onBargeIn,
  ownerSaidCancelTask,
  strictest,
  type AsrBand as ConfirmAsrBand,
  type BargeInPlan,
  type ConfirmDigest,
  type TaskRiskClass,
} from "./voice-engine/confirm-digest";
import { TaskSpeechRouter, toVoiceTaskEvent } from "./voice-engine/task-announcer";
import { renderVoiceContext, type VoiceContextMeta } from "./brain/voice-context";
import { completionLine, parseBackgroundRequest } from "./voice-engine/background-request";
import {
  BARGE_LADDER,
  BargeInDetector,
  BargeLadder,
  BargeShadow,
  echoCleanSourceLive,
  echoReferenceRunning,
  InterruptGate,
  interruptedPlayedMs,
  sanitizeInterruptGate,
  bargeFromController,
  classifyInterruption,
  type GateInput,
  type GateVerdict,
  type InterruptionDecision,
  type InterruptionInput,
  type LadderVerdict,
} from "./voice-engine/interruption-controller";
import { acousticFeatures } from "./voice-engine/interrupt-acoustic";
import { StreamSincResampler } from "./voice-engine/audio-format";
import {
  FRAME_MS as TURN_FRAME_MS,
  createTurnEngine,
  step,
  type BargeVerdict,
  type TurnCommand,
  type TurnEngineState,
  type TurnExpect,
  type TurnInput,
} from "./voice-engine/turn-engine";
import { CalibrationBook, type EotLang } from "./voice-engine/endpoint-calibration";
import {
  createTurnMetricsRecorder,
  type ControlEv,
  type TraceEvent,
  type TurnMetrics,
} from "./voice-engine/turn-metrics";
import { speechRms } from "./character/speech-audio";
import { firstClauseCut } from "./voice-engine/clause-chunker";
import { splitLongSpeech, splitSpokenSentences } from "./voice-engine/language-segmenter";
import { usesHindiVoice } from "./voice-engine/speech-prep";
import { prepareForSpeech } from "./voice-engine/text-normalizer";
import { askBrain } from "./self/ask-brain";
import { autonomy } from "./self/autonomy";
import { taskGraph } from "./self/task-graph";
import {
  clearPendingChange,
  pendingChange,
  spokenYesNeedsScreen,
  setHandsFreeReader,
} from "./brain/settings-intents";
import { ownerVoiceOrigin } from "./self/turn-provenance";
import {
  applyTaskRoute,
  attachVoiceTaskNarrator,
  attachVoiceTaskSpeaker,
  attachVoiceTaskWork,
  cancelAllVoiceTasks,
  dropInterruptedVoiceTasks,
  isReadOnlyRequest,
  listVoiceTasks,
  redoInterruptedVoiceTasks,
  restoreInterruptedVoiceTasks,
  narrationEventFor,
  releaseTaskUpdates,
  routerTasks,
  setTaskFocus,
  speakableLabel,
  startVoiceTask,
  taskFocusId,
  progressLinesFor,
  taskPrefsFrom,
  taskStatusLine,
  voiceTaskActions,
  type TaskWork,
  withoutChangeOfMind,
  type TaskUpdate,
} from "./voice-engine/voice-tasks";
import { TERMINAL, type VoiceTask } from "./voice-engine/task-orchestrator";
import { quickLaneEligible } from "./brain/quick-lane";
import { SpeechArbiter, type SpeechPriority } from "./voice-engine/speech-arbiter";
import {
  APPROVAL_REPEAT_MS,
  ROLLUP_GAP_MS,
  ROLLUP_MIN_TASKS,
  createNarrationMemory,
  digestLine,
  holdDigest,
  narrate,
  sanitizeForSpeech,
  STATUS_LINES,
  statusLine,
  type NarrateEvent,
  type NarrationLang,
  type StatusKey,
} from "./voice-engine/narration-policy";
import { createFinalDeduper } from "./voice-engine/final-dedupe";
import { routeCommandLane, routeUtterance, type Route } from "./voice-engine/utterance-router";
import {
  ackStillDue,
  shouldAck,
  type AckDecision,
  type AckTurnKind,
} from "./voice-engine/instant-ack";
import {
  ackLane,
  expectedAnswerMs,
  recordFirstClause,
  type FirstClauseHistory,
} from "./voice-engine/expected-answer";
import type { LadderLane } from "./voice-engine/brain-bridge";
import { notifications } from "./notifications";
import { earlyClause, realtimeSilenceMs, realtimeStatus } from "./voice-realtime";
import {
  applyCorrections,
  heardConfidence,
  type HeardQuality,
  languageId,
  learnCorrection,
} from "./asr-bias";
import { noteArc } from "./conversation-arc";
import { voiceBudgets } from "./failure-guard";
import { applySession, faultLanguage, plainFaultLine, savedInputPlan } from "./mic-session";
import { MIC_PRIVACY_LINK } from "./mic-faults";
import { noteStyleCorrection } from "./response-policy";
import {
  cachedOutputSinkId,
  noVoiceFailure,
  outputReachable,
  voiceForLanguage,
  chooseTtsEngine,
  firstAudioLatency,
  switchMidSentence,
} from "./tts-ladder";
import {
  EMPTY_MIC_STATUS,
  listAudioDevices,
  noteEarsTurn,
  noteMicHolders,
  probeMicrophone,
  voiceGate,
  type MicStatus,
} from "./voice-audio";
import { rememberDevice } from "./mic-truth";
import { affect, readFeeling } from "./brain/affect";
import {
  DesktopDictation,
  reclaimUnowned,
  sttHotwords,
  sttInitialPrompt,
  sttStatus,
  type ListeningPause,
} from "./voice-stt";
import {
  isPlainStop,
  isSelfEchoTranscript,
  isStopCommand,
  matchWakeWord,
  normalizeTranscript,
} from "./wake-word";
import {
  parseThreshold,
  parseVocabulary,
  refreshVoiceProfile,
  scoreUtterance,
  speakerInput,
  voiceProfileBuilt,
  voiceTurnGate,
  type VoiceSettingsView,
} from "./voice-profile";
import type { VoiceMatchResult } from "./desktop";
import { alertsAudible } from "./settings-runtime";
import {
  EMPTY_CONDUCT,
  loadConduct,
  offersShowHow,
  partialPlan,
  reduceVoice,
  isStopEverything,
  saveConduct,
  stopEverythingFromVoice,
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
  voicePhaseFromState,
  type VoiceEvent,
  type VoicePhase,
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
  /** FRIDAY Tidy edited this shown line: the words as heard and each edit, for a raw-versus-cleaned view. */
  tidy?: { raw: string; changes: TidyChange[] };
};

export type PendingConfirm = {
  command: string;
  reason: string;
  at: number;
  /** What the ear knew when the command was heard: the approved command replays with these, never the "yes" turn's. */
  hints?: TurnHints;
  /**
   * What she read back (verb, object, where, how much) and its expiry. Only a short, fresh yes to this digest that is
   * not her own voice approves; a corrected digest has a new id and a new ask time. It holds words and times only.
   */
  digest?: ConfirmDigest;
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
  /** The one phase chip, derived from `voiceState` on every emit (never set by hand). */
  phase: VoicePhase;
  /** A spoken note or meeting note is being written down right now (the Dictating chip). */
  dictating: boolean;
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
/** How long the ear's needs-a-wake-word tag stays valid for its turn (ms). */
const HOLD_TURN_MS = 15_000;

/** After the live wake scorer hears the name, the next line is addressed to her for this long (ms). */
const LIVE_WAKE_MS = 8_000;
/** Live captions send audio only while speech was heard this recently (ms). */
const CAPTION_TAIL_MS = 1_500;
/** A quiet gap this long between provisional transcripts is a new utterance, so one more draft is allowed (ms). */
const DRAFT_TURN_GAP_MS = 4_000;

/** The echo window after her sound: the room's tail, the estimated speech per word, and the hard cap per clause. */
const ECHO_TAIL_MS = 1_500;
const ECHO_WORD_MS = 400;
/** The leads of a refused yes (refuseYes); stripped when the re-ask is stamped as the prompt's own words. */
const REFUSAL_LEAD =
  /^(?:Main abhi pooch rahi thi\. Sawaal ke baad haan boliye\.|I was still asking\. Say yes after the question\.|Sirf haan ya na boliye\.|Just yes or no, please\.)\s*/;
/** The recogniser's delay from the end of speech to the final, when the engine did not report it. */
const STT_DELAY_GUESS_MS = 1_000;
const ECHO_CAP_MS = 30_000;
const STORAGE_KEY = "friday.assistant.mode";
const CONDUCT_KEY = "friday.assistant.conduct.v1";
const HANDS_FREE_KEY = "friday.assistant.handsfree";
/** How long the same microphone fault message is treated as one report. */
const MIC_FAULT_REPEAT_MS = 10_000;
const MAX_CAPTIONS = 40;
/**
 * How long follow-ups are accepted without repeating the wake word. Owned by
 * the shared preference so the Settings page and a conversational change move
 * the same number.
 */
const AWAKE_MS = () => attentionWindowMs();
/** How long a read-back waits for the owner's yes or no. */
const HEARD_CONFIRM_MS = 25_000;
/** After one read-back she goes ahead (or asks the one action question) instead of reading back again. */
const READBACK_COOLDOWN_MS = 60_000;
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
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  restartTts?: () => Promise<{ ok: boolean; state: string; error?: string }>;
};
const desktop = (): VoiceDesktop | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: VoiceDesktop }).friday ?? null);

/**
 * The Brain as one voice task sees it: every turn it sends carries the task as its owner, so a stop of the
 * foreground reply (barge-in, the stop word, a change of mind) leaves the task's run alone.
 */
function ownedBrain(taskId: string): Parameters<typeof askBrain>[1]["brain"] {
  return {
    send: (prompt) => brain.send(prompt, { ...VOICE_SEND, owner: { kind: "task", taskId } }),
    subscribe: (listener) => brain.subscribe(listener),
    getSnapshot: () => brain.getSnapshot(),
  };
}

/** Join spoken pieces with one full stop between them: a piece that already ends a sentence adds no second one. */
function joinSpoken(parts: readonly string[]): string {
  let out = "";
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    out = out ? `${out}${/[.!?…।]["')\]]*$/u.test(out) ? " " : ". "}${part}` : part;
  }
  return out;
}

/**
 * The sentences of one reply piece, in order. A fragment that is only delivery tags joins the sentence before it
 * (or the one after it), so a tag never becomes a line of its own.
 */
function sentencesOfPiece(piece: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const sentence of splitSpokenSentences(piece)) {
    if (!stripDeliveryTags(sentence).trim()) {
      if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${sentence}`;
      else carry = carry ? `${carry} ${sentence}` : sentence;
      continue;
    }
    out.push(carry ? `${carry} ${sentence}` : sentence);
    carry = "";
  }
  if (carry && !out.length) out.push(carry);
  return out.length ? out : piece.trim() ? [piece.trim()] : [];
}

let cid = 0;
const captionId = () => `cap-${Date.now().toString(36)}-${(cid += 1).toString(36)}`;

/** Used JavaScript heap in MB where the engine reports it (Chromium does); null elsewhere. */
function heapMegabytes(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize / 1_048_576 : null;
}

type LocalFinalMeta = Parameters<ConstructorParameters<typeof DesktopDictation>[0]["onFinal"]>[1];

/** The least time between two "Still waiting for yes or no" lines. */
const STILL_WAITING_GAP_MS = 12_000;

/** The bound-answer id of the restart question ("Redo them?"): it is not a desk task. */
const RESTART_ASK = "restart-redo";

/** A closed table of the secrets a spoken question can ask FRIDAY to say aloud (Latin and Devanagari). */
const SECRET_ASK_WORDS = [
  "password",
  "passcode",
  "pass code",
  "pin",
  "otp",
  "cvv",
  "cvc",
  "card number",
  "account number",
  "aadhaar",
  "aadhar",
  "adhar",
  "pan number",
  "pan card",
  "wifi key",
  "wi-fi key",
  "token",
  "api key",
  "seed phrase",
  "recovery phrase",
  "पासवर्ड",
  "पिन",
  "ओटीपी",
  "कार्ड नंबर",
  "आधार",
  "खाता नंबर",
  "पैन नंबर",
  "चाबी",
];
/** The verbs and question words that make a line a request to say the secret. */
const SECRET_ASK_VERBS = [
  "what",
  "whats",
  "what's",
  "which",
  "tell",
  "read",
  "show",
  "say",
  "give",
  "repeat",
  "batao",
  "bata",
  "bolo",
  "bol",
  "dikhao",
  "padho",
  "kya",
  "kaun sa",
  "kaunsa",
  "kitna",
  "बताओ",
  "बताइए",
  "बता",
  "बोलो",
  "दिखाओ",
  "पढ़ो",
  "क्या",
  "कौन सा",
  "कितना",
];
/** Next to the secret word these make it a different thing (a manager, a reset, a definition), not a value to say. */
const SECRET_NOT_A_VALUE = [
  "how to",
  "how do",
  "how can",
  "kaise",
  "tarika",
  "tareeka",
  "reset",
  "change",
  "manager",
  "generator",
  "policy",
  "strength",
  "meaning",
  "define",
  "hota hai",
  "कैसे",
  "तरीका",
  "रीसेट",
  "बदल",
  "मैनेजर",
  "होता है",
];
/** A possessive next to the word means the speaker's own secret: it overrides the "not a value" cues. */
const SECRET_OWNED = [
  "my",
  "mine",
  "your",
  "mera",
  "meri",
  "mere",
  "tumhara",
  "tera",
  "मेरा",
  "मेरी",
  "मेरे",
  "तुम्हारा",
];

const NOT_LETTER = String.raw`(?<![\p{L}\p{M}])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{M}])`;
function wordRe(words: readonly string[], flags = "iu"): RegExp {
  const body = words.map((w) =>
    w
      .normalize("NFC")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, String.raw`\s+`),
  );
  return new RegExp(`${NOT_LETTER}(?:${body.join("|")})${NOT_LETTER_AFTER}`, flags);
}
const SECRET_WORD_RE = wordRe(SECRET_ASK_WORDS, "giu");
const SECRET_VERB_RE = wordRe(SECRET_ASK_VERBS);
const SECRET_NOT_VALUE_RE = wordRe(SECRET_NOT_A_VALUE);
const SECRET_OWNED_RE = wordRe(SECRET_OWNED);
const SECRET_ARTICLE_BEFORE_RE = /(?<![\p{L}])(?:a|an)\s+$/iu;
const SECRET_NEAR_CHARS = 40;

/**
 * True when the line asks FRIDAY to say a secret aloud ("what is my wifi password", "mera otp batao", "कार्ड नंबर
 * क्या है"): a secret word with an ask verb or question word near it, in either order. The reply to such a question
 * looks plain ("It's hunter2"), so the turn is marked sensitive from the question itself. A secret word that is only
 * mentioned (a password manager, a reset, "a PIN") does not count unless it is owned ("my").
 */
export function asksForSecret(text: string): boolean {
  const line = String(text ?? "").normalize("NFC");
  if (!line.trim()) return false;
  for (const hit of line.matchAll(SECRET_WORD_RE)) {
    const start = hit.index ?? 0;
    const end = start + hit[0].length;
    const before = line.slice(Math.max(0, start - SECRET_NEAR_CHARS), start);
    const after = line.slice(end, end + SECRET_NEAR_CHARS);
    const around = `${before} ${after}`;
    if (!SECRET_VERB_RE.test(around)) continue;
    if (SECRET_OWNED_RE.test(around)) return true;
    if (SECRET_ARTICLE_BEFORE_RE.test(before)) continue;
    if (SECRET_NOT_VALUE_RE.test(around)) continue;
    return true;
  }
  return false;
}

/**
 * The mic reports end of speech only once the endpoint hold has run out, so the speech end is the confirm time minus
 * that hold (never before the speech start). The confirm time is the moment the clip is handed to recognition.
 */
export function stampEndpoint(
  clock: StageClock,
  holdMs: number,
  now: number = performance.now(),
): void {
  const start = clock.at("micSpeechStart");
  const end = now - Math.max(0, holdMs);
  clock.mark("micSpeechEnd", start === null ? end : Math.max(start, end));
  clock.mark("endpointConfirmed", now);
}

/** Record the budget stages of the turn once its first sound is stamped. Returns whether anything was recorded. */
export function recordTurnBudget(clock: StageClock, monitor = voiceLatency): boolean {
  const turn = clock.budgetTurn();
  if (turn.firstSound === undefined) return false;
  monitor.recordBudget(turn);
  return true;
}

/** One honest line for the diagnostics row: speech end to first sound against the budget, and the biggest stage. */
export function voiceBudgetLine(monitor = voiceLatency): string {
  const v = monitor.budgetVerdict();
  if (v.verdict === "unmeasured" || !v.firstSound) return "no voice turn measured yet";
  const words = {
    within: "within budget",
    "slow-tail": "typical turn fits, slow end is over budget",
    over: "over budget",
  }[v.verdict];
  const biggest = v.biggestStage ? `, biggest stage ${v.biggestStage}` : "";
  return `${v.firstSound.p50} ms typical, ${v.firstSound.p95} ms slow end of ${v.budgetMs} ms (${v.turns} turns), ${words}${biggest}`;
}

/** Record only the named stage gaps (the budget was already recorded for this turn). */
function recordGapsOnly(clock: StageClock, monitor = voiceLatency): Record<string, number> {
  const out = clock.durations();
  for (const [name, ms] of Object.entries(out)) monitor.record(name, ms);
  return out;
}

// ---------- the turn engine in shadow ----------

/** Events the shadow keeps for its metrics: about three minutes of 80 ms voice frames and the turn events. */
const TURN_SHADOW_EVENTS = 2400;
/** Rows of the shadow's own log: what the engine asked for, and what the classifier said. */
const TURN_SHADOW_LOG = 40;
/** The longest text the shadow keeps of any line, after scrubbing. */
const TURN_SHADOW_TEXT = 80;
/** The speech worker's breaker stays open for five minutes, then lets one probe through (`electron/voice-worker.cjs`). */
const SPEAKER_BREAKER_COOL_MS = 300_000;
/** Capture kept from the start of one barge-in candidate for its acoustic features, and its rate. */
const TURN_SHADOW_AUDIO_MS = 1500;
const TURN_SHADOW_RATE = 16_000;
/** The engine's own base end-of-turn wait (6 x 80 ms), the start for a calibrated base. */
const TURN_SHADOW_BASE_FRAMES = 6;
/** The shadow ran nothing: a deferred verdict with nothing to do. */
const NO_SHADOW = (): void => undefined;

export type TurnShadowOptions = {
  /** Read at each new turn: hands-free on means no wake word is needed. */
  handsFree: () => boolean;
  /** `voice.turn.maxWaitMs`: the longest quiet wait any hold may add. */
  maxWaitMs: number;
  /** `voice.turn.calibrate`: the engine's base wait follows this PC's own measured waits per language. */
  calibrate: boolean;
  /** Time zero of the shadow's own clock (a wall-clock reading). */
  startAt: number;
  /** What the open question expects (a dictation, a yes or no), read when a turn opens. */
  expectNow?: () => TurnExpect | undefined;
  /** Where the last turn's numbers go. Default: the app's latency monitor. */
  monitor?: LatencyMonitor;
};
export type TurnShadowCounters = {
  /** The engine and the live path did the same thing. */
  agree: number;
  /** Where they differed, by kind (commit-missing, commit-extra, barge:<live>/<classifier>). */
  disagree: Record<string, number>;
  steps: number;
  verdicts: number;
};
export type TurnShadowRow = { t: number; k: string; detail: string };
export type TurnShadowLastTurn = Pick<
  TurnMetrics,
  "turnId" | "ttfaMs" | "eotWaitMs" | "bargeToSilenceMs" | "falseCut" | "prematureEnd"
>;
export type TurnShadowReport = {
  /** Always "shadow" in this build: `voice.turn.classifier: "live"` is accepted and still only shadows. */
  mode: "shadow";
  counters: TurnShadowCounters;
  log: TurnShadowRow[];
  lastTurn: TurnShadowLastTurn | null;
  /** Samples in the end-of-turn calibration book, per language. */
  calibration: Record<EotLang, number>;
};

/** What the voice turn context block is built from: the heard turn, the mode, the open digest, the running tasks. */
export type VoiceTurnContextInput = {
  record: TurnRecord | null;
  handsFree: boolean;
  digest: ConfirmDigest | null;
  tasks: readonly Pick<VoiceTask, "label" | "state">[];
  now: number;
};

const CONTEXT_NOISE = { speech: "crowd", music: "music", tv: "tv", noise: "noise" } as const;

/**
 * The voice turn context block (brain/voice-context.ts) for one heard turn: language, the ear's sureness band, the
 * room, the mode, the open digest and the running tasks, as data. Pure, for the dispatch that will carry it; nothing
 * sends it yet. The speaker is always "unknown" here, and the renderer drops any sensitive words.
 */
export function voiceTurnContext(input: VoiceTurnContextInput): string {
  const { record, digest } = input;
  const meta: VoiceContextMeta = {
    modality: record ? "spoken" : "typed",
    lang: record?.lang === "hi" ? "hi" : record?.lang === "hi-en" ? "hinglish" : "en",
    langConfidence: record?.confidence ?? 0,
    romanised: record?.romanised === true,
    asrBand: record?.asrBand === "mid" ? "medium" : (record?.asrBand ?? "low"),
    noise: record?.env ? CONTEXT_NOISE[record.env.kind] : "quiet",
    speaker: "unknown",
    handsFree: input.handsFree,
    bargeIn: typeof record?.interruptedPlayedMs === "number",
    approval: digest
      ? {
          verb: digest.verb,
          object: digest.object,
          expiresInS: Math.max(0, Math.round((digest.expiresAt - input.now) / 1000)),
        }
      : null,
    tasks: input.tasks
      .filter((t) => !TERMINAL.includes(t.state))
      .map((t) => ({
        title: t.label,
        state: t.state === "WAITING_FOR_APPROVAL" ? ("waiting" as const) : ("running" as const),
      })),
  };
  return renderVoiceContext(meta, { isSensitive: looksSensitive });
}

/** What the shadow keeps of a line: nothing of a private one, no digits, at most 80 characters. */
function shadowText(text: string): string {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "";
  if (looksSensitive(line)) return "[private]";
  return line.replace(/\d/g, "#").slice(0, TURN_SHADOW_TEXT);
}

/**
 * What the engine itself is shown of a line (its state holds it between steps): the scrubbed tail, at most 80
 * characters, which is what its end-of-turn rules read; a private line is a bare placeholder, never its words.
 */
function engineText(text: string): string {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "";
  if (looksSensitive(line)) return "[private]";
  return line.replace(/\d/g, "#").slice(-TURN_SHADOW_TEXT);
}

function eotLangOf(text: string): EotLang {
  const read = languageMix(text).lang;
  return read === "hi" ? "hi" : read === "hi-en" ? "hinglish" : "en";
}

/**
 * The pure turn engine (`voice-engine/turn-engine.ts`) run beside the live controller, in shadow. It is fed the
 * events the live path sees (the ear's turn events, the desktop partials, the voice gate's beat as its 80 ms frame,
 * the final transcript, the hand-over to the Brain, the voice starting and ending, mute, pause, stop and wake), and
 * it asks the interruption classifier next to the live barge-in gate. It never acts: the engine's commands are only
 * written to a short log and compared with what the live path did, as counts. It holds no audio past one barge-in
 * candidate and no transcript text past 80 scrubbed characters.
 */
export class TurnEngineAdapter {
  private engine: TurnEngineState;
  private readonly opts: TurnShadowOptions;
  private readonly monitor: LatencyMonitor;
  private readonly metrics = createTurnMetricsRecorder({ maxEvents: TURN_SHADOW_EVENTS });
  private readonly book = new CalibrationBook();
  private readonly counters: TurnShadowCounters = { agree: 0, disagree: {}, steps: 0, verdicts: 0 };
  private readonly log: TurnShadowRow[] = [];
  private lastT = 0;
  private lastVadFrame = -1;
  private turnId = "";
  private streamOpen = false;
  private partialTurn = "";
  private partialSeq = 0;
  /** Engine commits since the last live final transcript. */
  private commits = 0;
  private finalLang: EotLang = "en";
  private reportedTurn = "";
  private bargeAt: number | null = null;
  /** Capture is collected only while the candidate is open; its frames are dropped once its verdict was taken. */
  private bargeOpen = false;
  private resampler: StreamSincResampler | null = null;
  private audioFrames: Float32Array[] = [];
  private audioSamples = 0;
  /** A verdict is due for the candidate: `bargeEnd` keeps the frames until `barge` has read them. */
  private verdictHeld = false;
  private bargeCtx: Partial<InterruptionInput> = {};

  constructor(opts: TurnShadowOptions) {
    this.opts = opts;
    this.monitor = opts.monitor ?? voiceLatency;
    this.engine = createTurnEngine({
      handsFree: opts.handsFree(),
      lang: "auto",
      onsetFrames: 3,
      maxWaitFrames: Math.round(opts.maxWaitMs / TURN_FRAME_MS),
      barge: bargeFromController(() => this.bargeCtx),
    });
  }

  /** The shadow's clock: milliseconds since `startAt`, never backwards (a wall clock may step back). */
  private at(now: number): number {
    const t = Number.isFinite(now) ? Math.max(this.lastT, now - this.opts.startAt) : this.lastT;
    this.lastT = t;
    return t;
  }

  private feed(input: TurnInput): void {
    const out = step(this.engine, input);
    this.engine = out.state;
    this.counters.steps += 1;
    for (const cmd of out.commands) this.noteCommand(input.t, cmd);
  }

  private noteCommand(t: number, cmd: TurnCommand): void {
    switch (cmd.k) {
      case "commit":
        this.commits += 1;
        this.row(t, "commit", `wait ${cmd.record.eotWaitMs ?? "-"} ms`);
        return;
      case "draft-start":
      case "draft-cancel":
      case "draft-adopt":
        this.row(t, cmd.k, shadowText(cmd.text));
        return;
      case "duck":
        this.row(t, "duck", `${cmd.db} dB`);
        return;
      case "stop-speech":
        this.row(t, "stop-speech", cmd.reason);
        return;
      case "resume-speech":
        this.row(t, "resume-speech", "");
        return;
      case "ack":
        this.row(t, "ack", cmd.key);
        return;
      case "require-wake":
        this.row(t, "require-wake", cmd.why);
        return;
    }
  }

  private row(t: number, k: string, detail: string): void {
    this.log.push({ t, k, detail: detail.slice(0, TURN_SHADOW_TEXT) });
    if (this.log.length > TURN_SHADOW_LOG) this.log.shift();
  }

  private disagree(kind: string): void {
    this.counters.disagree[kind] = (this.counters.disagree[kind] ?? 0) + 1;
  }

  private record(event: TraceEvent): void {
    this.metrics.record(event);
  }

  /** A new turn: the old one is settled, and the engine learns the expectation and this PC's measured wait. */
  private openTurn(t: number): void {
    if (this.commits > 0) this.disagree("commit-extra");
    this.commits = 0;
    const handsFree = this.opts.handsFree() === true;
    let cfg = this.engine.cfg;
    if (cfg.handsFree !== handsFree) cfg = { ...cfg, handsFree };
    if (this.opts.calibrate) {
      const base = this.book.suggestedBaseFrames(this.finalLang, TURN_SHADOW_BASE_FRAMES);
      if (base !== cfg.eotBaseFrames) cfg = { ...cfg, eotBaseFrames: base };
    }
    if (cfg !== this.engine.cfg) {
      this.engine = { ...this.engine, cfg, needWake: handsFree ? false : this.engine.needWake };
    }
    const expect = this.opts.expectNow?.();
    if (expect) this.feed({ t, k: "control", ev: "asked", expect });
  }

  ear(turn: StreamTurn, now: number): void {
    const t = this.at(now);
    if (turn.event === "start" && turn.turnId !== this.turnId) this.openTurn(t);
    this.turnId = turn.turnId;
    this.streamOpen = true;
    this.record({
      t,
      k: "ear",
      event: turn.event,
      turnId: turn.turnId,
      text: shadowText(turn.text),
    });
    this.feed({ t, k: "ear", turn: { ...turn, text: engineText(turn.text) } });
  }

  /** A desktop partial: on the ear's open turn, or on a turn of its own when no ear turn is open. */
  partial(text: string, now: number): void {
    const t = this.at(now);
    let turnId = this.streamOpen ? this.turnId : this.partialTurn;
    if (!turnId) {
      this.partialSeq += 1;
      turnId = `p${this.partialSeq}`;
      this.partialTurn = turnId;
      this.openTurn(t);
      this.record({ t, k: "ear", event: "start", turnId, text: "" });
    }
    this.feed({
      t,
      k: "ear",
      turn: { turnId, event: "partial", text: engineText(text), vadP: null, speechMs: null },
    });
  }

  /** The voice gate's beat, at most once per 80 ms frame: the engine's voice frame and its clock. */
  vad(voiced: boolean, echoClean: boolean, now: number): void {
    const t = this.at(now);
    const frame = Math.floor(t / TURN_FRAME_MS);
    if (frame === this.lastVadFrame) return;
    this.lastVadFrame = frame;
    const p = voiced ? 0.9 : 0.05;
    this.record({ t: frame * TURN_FRAME_MS, k: "vad", p });
    this.feed({ t, k: "vad", p, echoClean });
  }

  control(ev: ControlEv, now: number, expect?: TurnExpect): void {
    const t = this.at(now);
    this.record({ t, k: "control", ev });
    this.feed({ t, k: "control", ev, ...(expect ? { expect } : {}) });
  }

  brain(ev: "lane" | "refused", runId: string, now: number): void {
    const t = this.at(now);
    this.record({ t, k: "brain", ev, runId });
    this.feed({ t, k: "brain", ev, runId });
  }

  dispatch(text: string, now: number): void {
    this.record({ t: this.at(now), k: "dispatch", text: shadowText(text) });
  }

  /** Her voice at the output: started, a clause ended, all played, or failed. */
  tts(
    ev: "first-audio" | "clause-end" | "drained" | "failed",
    utteranceId: string,
    playedMs: number,
    now: number,
  ): void {
    const t = this.at(now);
    const played = Number.isFinite(playedMs) && playedMs >= 0 ? playedMs : 0;
    this.record({ t, k: "tts", ev, utteranceId, playedMs: played });
    this.feed({ t, k: "tts", ev, utteranceId, playedMs: played });
    if (ev === "drained" || ev === "failed") this.settleTurn();
  }

  /** The live path stopped her voice. */
  stopped(now: number): void {
    this.record({ t: this.at(now), k: "stop" });
  }

  /** The live path's final transcript: the engine should have committed this turn by now. */
  liveFinal(text: string, now: number): void {
    const t = this.at(now);
    this.feed({ t, k: "tick" });
    const kept = shadowText(text);
    this.record({ t, k: "final", text: kept });
    this.row(t, "final", kept);
    this.finalLang = eotLangOf(text);
    if (this.commits > 0) this.counters.agree += 1;
    else this.disagree("commit-missing");
    this.commits = 0;
    this.streamOpen = false;
    this.partialTurn = "";
  }

  /** The turn's numbers, once, after her reply: to the latency monitor and the calibration book. */
  private settleTurn(): void {
    const last = this.metrics.summary().score.turns.at(-1);
    if (!last || last.turnId === this.reportedTurn) return;
    this.reportedTurn = last.turnId;
    if (last.ttfaMs !== null) this.monitor.record("turn.ttfaMs", last.ttfaMs);
    if (last.bargeToSilenceMs !== null)
      this.monitor.record("turn.bargeToSilenceMs", last.bargeToSilenceMs);
    if (last.eotWaitMs !== null) {
      this.monitor.record("turn.eotWaitMs", last.eotWaitMs);
      this.book.push(this.finalLang, { eotWaitMs: last.eotWaitMs, falseCut: last.falseCut });
    }
  }

  bargeBegin(now: number): void {
    this.bargeAt = this.at(now);
    this.bargeOpen = true;
    this.verdictHeld = false;
    this.dropAudio();
  }

  private dropAudio(): void {
    this.audioFrames = [];
    this.audioSamples = 0;
    this.resampler = null;
  }

  /** A verdict is about to be asked for this candidate (the live verdict was read): its frames outlive `bargeEnd`. */
  holdAudioForVerdict(): void {
    this.verdictHeld = true;
  }

  /**
   * The candidate is over: collection stops. The frames stay only for the verdict that was announced
   * (`holdAudioForVerdict`), which lets them go once it is taken; otherwise they go now.
   */
  bargeEnd(): void {
    this.bargeOpen = false;
    if (!this.verdictHeld) this.dropAudio();
  }

  /**
   * Capture frames of the open candidate, from its start, up to 1.5 s, at 16 kHz through the one band-limited
   * resampler (so the features cost the same on any device rate). Kept in memory only, for the features.
   */
  audio(samples: ArrayLike<number>, rate: number): void {
    if (!this.bargeOpen || !(rate > 0)) return;
    if (this.audioSamples >= (TURN_SHADOW_RATE * TURN_SHADOW_AUDIO_MS) / 1000) return;
    if (rate !== TURN_SHADOW_RATE && this.resampler === null)
      this.resampler = new StreamSincResampler(rate, TURN_SHADOW_RATE);
    const frame =
      rate === TURN_SHADOW_RATE ? Float32Array.from(samples) : this.resampler?.push(samples);
    if (!frame || frame.length === 0) return;
    this.audioFrames.push(frame);
    this.audioSamples += frame.length;
  }

  /** The classifier's verdict next to the live one (null: the live path has not decided yet). Only counted. */
  barge(live: BargeVerdict | null, input: InterruptionInput, now: number): InterruptionDecision {
    const t = this.at(now);
    const voiceMs =
      this.bargeAt === null ? input.voiceMs : Math.max(input.voiceMs, t - this.bargeAt);
    const acoustic = this.audioFrames.length
      ? acousticFeatures(this.audioFrames, TURN_SHADOW_RATE)
      : null;
    const full: InterruptionInput = { ...input, voiceMs, ...(acoustic ? { acoustic } : {}) };
    this.bargeCtx = {
      words: full.words,
      voiceMs,
      ttsPlaying: full.ttsPlaying,
      echoClean: full.echoClean,
      scene: full.scene,
      speaker: full.speaker,
      sinceTtsStartMs: full.sinceTtsStartMs,
    };
    const decision = classifyInterruption(full);
    this.verdictHeld = false;
    if (!this.bargeOpen) this.dropAudio();
    this.counters.verdicts += 1;
    if (live !== null) {
      const same =
        live === "takeover" ? decision.decision === "takeover" : decision.decision !== "takeover";
      if (same) this.counters.agree += 1;
      else this.disagree(`barge:${live}/${decision.decision}`);
    }
    this.row(t, "verdict", `${live ?? "-"}/${decision.decision} ${decision.reason}`);
    return decision;
  }

  /** The barge-in contract the running tasks would follow (confirm-digest onBargeIn): written to the log only. */
  bargePlan(risk: TaskRiskClass, plan: BargeInPlan, now: number): void {
    const detail = `${risk} cancel:${plan.cancelTask} checkpoint:${plan.runToCheckpoint} undo:${plan.undoJournal}`;
    this.row(this.at(now), "barge-plan", detail);
  }

  engineState(): TurnEngineState {
    return this.engine;
  }

  report(): TurnShadowReport {
    const last = this.metrics.summary().score.turns.at(-1);
    return {
      mode: "shadow",
      counters: { ...this.counters, disagree: { ...this.counters.disagree } },
      log: this.log.map((row) => ({ ...row })),
      lastTurn: last
        ? {
            turnId: last.turnId,
            ttfaMs: last.ttfaMs,
            eotWaitMs: last.eotWaitMs,
            bargeToSilenceMs: last.bargeToSilenceMs,
            falseCut: last.falseCut,
            prematureEnd: last.prematureEnd,
          }
        : null,
      calibration: {
        en: this.book.size("en"),
        hi: this.book.size("hi"),
        hinglish: this.book.size("hinglish"),
      },
    };
  }
}

/** What a draft must still match when the final transcript arrives: nothing material may change in between. */
/** How a spoken line takes its turn in the speech queue (see speech-arbiter). A line with no meta is a direct answer. */
type SpeakMeta = {
  priority?: SpeechPriority;
  taskId?: string;
  coalesceKey?: string;
  sensitive?: boolean;
  done?: boolean;
  whisper?: boolean;
  /** A reply the model wrote for this spoken turn: the only line whose delivery tags may reach the voice. */
  reply?: boolean;
  /** Keep every sentence of the line (a digest line); a reply and an approval prompt are always whole. */
  uncapped?: boolean;
  /** The first clause of that reply. */
  first?: boolean;
};

type EagerSnapshot = {
  privacyMode: boolean;
  paidAccess: boolean;
  approvalLevel: string;
  halted: boolean;
};

/** The ear's room and voice tags of one final, read only by the addressedness gate. */
/** Why a spoken yes was not taken (see yesRefusal). */
type YesRefusal = "mixed" | "room" | "older yes";

type AddressFacts = {
  scene?: { kind: "speech" | "music" | "tv" | "noise"; score: number };
  speaker?: "owner" | "other" | "unknown";
};

/** Retry triggers after which the local voice may have changed, so its reason is read again. */
const VOICE_STATUS_TRIGGERS = new Set(["install-finished", "model-ready", "settings", "fix-voice"]);

class AssistantModeStore {
  private listeners = new Set<() => void>();
  /** On-device transcription is Auto Mode's only recognition engine. */
  private dictation: DesktopDictation | null = null;
  private wantRunning = false;
  /** A start already in flight must not open a second capture. */
  private recognitionPending = false;
  /** True after Install Manager reports the offline voice package. */
  private offlineVoiceReady = false;
  /** Why the local voice is not ready (the speech worker's own words), empty while it is. */
  private offlineVoiceReason = "";
  /** The Install Manager's package row for FRIDAY Voice, and the speech worker's last status: the two inputs. */
  private offlineVoicePackage = false;
  private offlineVoiceStatus: Parameters<typeof localVoiceReadiness>[0] = null;

  /** The one reading prewarm and Doctor use: the own engine ready, or the package row, with the failure reason. */
  private recomputeOfflineVoice() {
    const reading = localVoiceReadiness(this.offlineVoiceStatus, this.offlineVoicePackage);
    this.offlineVoiceReady = reading.ready;
    this.offlineVoiceReason = reading.reason;
  }

  /** The status line while a turn runs and a new request was answered or queued: the approval wait is named. */
  private busyStatusLine(kind: "reply" | "queue", awaitingApproval: boolean): string {
    if (awaitingApproval) return "Waiting for your approval";
    return kind === "queue" ? "Working — next request queued" : "Working — still on it";
  }

  /**
   * Why the failed speech was not heard, for the failed-voice lines: the local voice's reason, and only when the
   * route that failed was a local engine (FRIDAY Voice or the system voice), never for a cloud route.
   */
  private localVoiceFailureReason(route: { engine: string; cloud: boolean }): string {
    if (route.cloud) return "";
    return route.engine === "" || /supertonic|sapi|friday|system/i.test(route.engine)
      ? this.offlineVoiceReason
      : "";
  }

  /** Ask the speech worker how FRIDAY Voice is, once; a bridge without it keeps the package row alone. */
  private async refreshOfflineVoice() {
    try {
      this.offlineVoiceStatus = await neuralVoiceStatus();
    } catch {
      this.offlineVoiceStatus = null;
    }
    this.recomputeOfflineVoice();
  }
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
  /** The part of the reply that was heard, taken at the moment the voice was cut for a possible interruption. */
  private heldPlayed: PlayedReply | null = null;
  /**
   * The backchannel gate: the owner's voice while she speaks only lowers her volume until words show it is a real
   * interruption (see `InterruptGate`). `gateText` is the newest words the recogniser gave, `gatePlayed` what was
   * heard at full volume when the voice began.
   */
  private interruptGate = new InterruptGate(() =>
    sanitizeInterruptGate(preferences.getSnapshot().voice.interruptGate),
  );
  private gateTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The barge-in ladder (opt-in, `voice.interruptGate.ladder`): duck at 150 ms of echo-cleaned speech, stop at 500 ms
   * or one real word, resume when no words come by 2 s. It runs beside `interruptGate` (which keeps the candidate
   * open) and only replaces who rules on it.
   */
  private bargeLadder = new BargeLadder();
  /** The current interrupt candidate is ruled by the ladder (it is on and an echo-clean source exists). */
  private gateLadder = false;
  /**
   * The turn protocol of the streaming ear: eager endpoints start (and resumes cancel) the Brain's text-only draft,
   * and the facts of the ended turn travel with its final text as a `TurnRecord`. Nothing here approves anything.
   */
  private turnTracker = new TurnTracker(
    () => preferences.getSnapshot().voice.ears.eagerTurn === true,
  );
  private turnRecord: TurnRecord | null = null;
  /** `turnRecord` belongs to the turn being routed now (cleared when the next voice begins). */
  private turnRecordLive = false;
  /** The id of the heard turn, kept apart from the record so only the intake reads the record to make it. */
  private heardTurnId = "";
  /** The stream turn the ear is framing and when its voice began (a time only; never a speaker or a room tag). */
  private streamTurnBegan: { turnId: string; at: number } | null = null;
  /** The digest she already read a second time, so a repeated doubtful yes is not answered every time. */
  private digestReasked = "";
  /** Set by the intake for the one turn it hands on: the ear's sureness band (null: not measured) and voice start. */
  private heardEar: { asrBand: ConfirmAsrBand | null; beganAt: number | null } | null = null;
  /**
   * The ear's room and voice tags of the final being handled, for the addressedness gate only (spent by it). A tag
   * can only ADD a wake requirement there; no approval, confirmation or authority check reads it.
   */
  private addressFacts: AddressFacts | null = null;
  /**
   * The final's speaker tag, kept for the send only so the turn's origin can be noted for learning: "owner" marks the
   * owner's own voice. It is never read by an approval, a confirmation or an authority check (a match never approves).
   */
  private heardSpeaker: "owner" | "other" | "unknown" | null = null;
  private streamTurnId = "";
  private holdTurnId = "";
  private holdSeenAt = 0;
  private turnStreamOff: (() => void) | null = null;
  /** The milliseconds of her last reply that were audible when the owner cut in, for the next turn record. */
  private lastInterruptedPlayedMs: number | null = null;
  private gateText = "";
  private gatePlayed: PlayedReply | null = null;
  /** The live-words follower was started for the candidate (and is stopped with it). */
  private gateLiveWords = false;
  /** `holdForInterruption(true)` keeps the candidate open: paused, but the words still decide. */
  private gateKeep = false;
  /** The warm-up pass of this Auto session has run to the end once. */
  private prewarmDone = false;
  /** Hands-free starts off, so the wake word is required until the stored choice says otherwise. */
  private wakeWordRequired = true;
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
  /** Who speaks next: approvals, then direct answers, then progress, then chatter. One queue for every voice line. */
  private arbiter = new SpeechArbiter({ now: () => Date.now() });
  /** One short wait for the owner to finish talking; never an always-on timer. */
  private speechPoll: ReturnType<typeof setTimeout> | null = null;
  /** What the narration policy remembers between task updates (this session only). */
  private narration = createNarrationMemory();
  /** Settles a cancelled task so a late result of it is never said (task-announcer.ts). */
  private taskSpeech = new TaskSpeechRouter();
  /** Her approval prompt, while it is the last thing she said and the owner has not answered it. */
  private approvalAsked: { askedAt: number; taskId?: string } | null = null;
  /** The last approval prompt that was voiced for the Brain's slot, so it is asked once. */
  private approvalVoicedAt = 0;
  /**
   * The last approval prompt that really sounded (the speech queue handed it out and the voice started), and when.
   * A spoken yes is bound to this, never to the moment an approval was created or queued: a prompt held back by a
   * call, quiet hours or Do not disturb, or one that has not played yet, can be answered on the screen only.
   */
  private approvalSpoken: { at: number; taskId?: string; ended?: boolean } | null = null;
  /**
   * When the read-back of the open digest finishes sounding: a yes to it counts only if it BEGAN after that. The
   * end is the player's end hook when it came, else the start (or the moment it was asked) plus about 400 ms a word.
   * `owed` counts the reads still to finish, so an older read ending does not close a re-read still queued.
   */
  private askSound: {
    digestId: string;
    estimateEnd: number;
    estimateMs: number;
    startedAt: number | null;
    endedAt: number | null;
    owed: number;
    /** It started sounding and was stopped before its end hook (a new speech generation). */
    cut: boolean;
  } | null = null;
  /** The words of this final as heard, before any rewrite (code-mix canonical, learned corrections, self-repair). */
  private heardRawLines: string[] = [];
  /** The recogniser's own words of the final being handled, copied at the intake and cleared after it. */
  private heardRaw = "";
  /** The line the speech queue is playing now, for the approval stamp. */
  private playingItem: { priority: SpeechPriority; taskId?: string; text?: string } | null = null;
  /** The words of the last task, restart or Brain prompt that sounded, so a refused yes re-asks that same question. */
  private approvalPrompt: { taskId: string; text: string } | null = null;
  /** "I was working on A and B when I closed. Redo them?": asked once per app session. */
  private restartAsked = false;
  private restartAsk: { ids: string[] } | null = null;
  /** The task a confirmed change of mind replaces: cancelled only when the new order is approved. */
  private supersedeOnConfirm: { id: string; command: string; at: number } | null = null;
  private approvalRemindedAt = 0;
  private lastOwnerAt = 0;
  private lastRollupAt = 0;
  private draining = false;
  /** How much of the live answer has already been handed to speech. */
  private voicedRunId = "";
  private holdTimers: ReturnType<typeof setTimeout>[] = [];
  private voicedChars = 0;
  /** The start of the answer that has been spoken, to tell a rewrite from more text. */
  private voicedPrefix = "";
  /** The first clause of the reply being voiced has not been handed to the voice yet. */
  private firstClauseDue = false;
  /** The spoken line that is the first clause of its reply (for the voice's quickest route), until it plays. */
  private firstLine = "";
  /** Spoken lines that still carry delivery tags: FRIDAY's own words in a spoken reply, until each is played. */
  private taggedLines = new Set<string>();
  /** A failed turn speaks its short line once. The partial answer is not restarted. */
  private voicedFaultFor = "";
  /** User lines already shown before the brain echoes them into captions. */
  private pendingUserEcho = 0;
  /** Last finalized transcript, so the same utterance is not run twice. */
  private lastFinalText = "";
  private lastFinalAt = 0;
  /** One utterance, one turn: the same final words from a retried call or the other recogniser run once. */
  private readonly finalDeduper = createFinalDeduper();
  /** When her latest reply began to sound: a repeat after that is said on purpose, not a second copy. */
  private replyStartedAt: number | null = null;
  private chartOfferedFor = "";
  /** Hangover so echo STT that arrives after tts-end is still rejected. */
  private echoUntil = 0;
  /** The latest moment the echo window may stay open for the clause now playing (a hard cap of 30 s from its start). */
  private echoCapAt = 0;
  private hydrated = false;
  private spokenUpTo = 0;
  private unBrain: (() => void) | null = null;
  /** Hears a quick-lane answer (a short question asked beside a running task) so it is spoken at once. */
  private unQuick: (() => void) | null = null;
  private awakeUntil = 0;
  private followUpUntil = 0;
  private readonly micRestarts: number[] = [];
  private micErrorLine = "";
  private shownMicFault = "";
  private shownMicFaultAt = 0;
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
  /** The Brain's handle for the live draft ("" when none). A draft is text only: it is never a run. */
  private draftId = "";
  /** Drafts started in this turn's partial stream: at most one (a changed line waits for the final transcript). */
  private draftsThisTurn = 0;
  /** When the last provisional transcript arrived: a long gap means a new utterance, so a new turn. */
  private partialSeenAt = 0;
  /** Privacy, paid access and autonomy when the draft started: a draft is adopted only when none of it changed. */
  private draftSnapshot: EagerSnapshot | null = null;
  private narratedTool = "";
  /** What she says while work runs: varied, sparse, never twice the same. */
  private narrator = createNarrator();
  /**
   * The instant acknowledgement (setting `voice.instantAck`, off by default): the turn it is armed for moves on with
   * every new turn, barge-in, pause, mute and Stop; one timer, one line in the speech queue, one per turn.
   */
  private ackGen = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private ackQueued: {
    id: string;
    decision: Extract<AckDecision, { ack: true }>;
    gen: number;
  } | null = null;
  private ackSaid = 0;
  private ackTurns = 0;
  private ackLastLineId = "";
  private ackSeed = Date.now() % 2_147_483_647;
  /** What the router called the line that is going to the Brain; read once by the acknowledgement. */
  private ackTurnKind: AckTurnKind = "control";
  /** The lane the turn on its way to the Brain is on, and whether its first-clause time was already learned. */
  private ackLane: LadderLane = "full";
  private ackLearned = false;
  /** This session's measured endpoint-to-first-clause times per lane: what the acknowledgement expects next. */
  private ackHistory: FirstClauseHistory = {};
  /** The line just sounded, for the echo filter only (it is never `spokenText`, so "continue" never repeats it). */
  private ackEcho = { text: "", until: 0 };
  /** Requests heard while a turn ran; each runs once the one before has finished and been spoken. */
  private queuedCommands: string[] = [];
  /** The language hints captured with a queued request, so it replays with its own and not the latest turn's. */
  private readonly queuedHints = new Map<string, TurnHints>();
  /** While a stored command is replayed, the hints captured WITH it; the replaying utterance's own never apply. */
  private replayTurn: { hints: TurnHints | undefined } | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private partialText = "";
  private partialAt = 0;
  /** What was heard and what was decided. Not spoken, and not a second log store. */
  private audit: VoiceAudit[] = [];
  /** Named stamps of this turn (speech start, speech requested, first sound) and of an interruption. */
  private turnStages = new StageClock();
  private budgetRecorded = false;
  private pcmNoteSaid = "";
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
    phase: "off",
    dictating: false,
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
    this.state.phase = voicePhaseFromState(this.state.mode, this.state.voiceState);
    this.state.dictating = Boolean(voiceNotes.active());
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    this.reportToTray();
  }

  /** The language pool for status and fault lines: the owner's reply language. */
  private lineLang(): "en" | "hi" | "hinglish" {
    return faultLanguage(preferences.getSnapshot().voice) as "en" | "hi" | "hinglish";
  }

  /** One status line in the owner's language, with the wake word they chose. */
  private line(key: StatusKey): string {
    return statusLine(key, this.lineLang(), wakeWord());
  }

  /**
   * The status while nothing is happening: it asks for the wake word only when the microphone really listens.
   * A muted, paused, stopped or failed state shows that state instead, never "Say FRIDAY".
   */
  private idleLine(): string {
    if (this.state.muted) return this.line("muted");
    if (this.stopped()) return this.line("stopped");
    if (this.state.paused) return this.line("paused");
    if (this.state.voiceState === "ERROR") return this.line("voice-error");
    return this.line("wake-needed");
  }

  /** A fault as one plain sentence in the owner's language (the raw text stays in the trace and the Doctor). */
  private plainFault(raw: string, micClass = false, healing = false): string {
    const state = this.state.mic.state;
    return plainFaultLine(raw, this.lineLang(), {
      ...(micClass && state !== "available" ? { micState: state } : {}),
      healing,
    });
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
  /** True while Stop everything is on. Read where it matters, not cached. */
  private stopped(): boolean {
    return autonomy.getSnapshot().halted === true;
  }

  /** Whether the microphone was closed by Stop everything (so Resume may reopen it) and not by the owner's pause. */
  private pausedByStop = false;
  private readonly unKillSwitch = autonomy.subscribe(() => this.followKillSwitch());

  /**
   * Stop everything is the kill switch for the approval queue and the Brain's tools; it is also the owner's
   * "stop" for Auto. Switching it on closes the microphone, cuts what is being said, and drops what was waiting
   * (queued requests and a confirmation); switching it off reopens the microphone only if this closed it. Mute is
   * a separate switch and is not touched, and Manual and Chat never owned the microphone, so nothing changes there.
   */
  private followKillSwitch() {
    if (this.stopped()) {
      cancelPrewarm();
      this.discardEager();
      clearEchoReference("stop");
      this.forgetOpenQuestions();
      // Stop everything ends every task on the desk first (so none reads as COMPLETED "Stopped."), then the
      // Brain's turn, whoever owns it. The foreground-only stops (barge-in, stop word) never come this way.
      cancelAllVoiceTasks();
      // The switch may have been thrown without the fan-out (a stored flag, a settings write): running graphs park
      // at their checkpoint either way. Parking is idempotent, so a second call after the fan-out finds nothing.
      taskGraph.haltAll();
      brain.stop();
      this.gateSleep("stopped");
      this.queuedCommands = [];
      this.queuedHints.clear();
      this.stopQueueTimer();
      this.state.pending = null;
      this.pendingHeard = null;
      // A settings change a reply staged is dropped too: a yes after Resume binds to nothing.
      clearPendingChange();
      if (this.state.mode === "auto" && !this.state.paused) {
        this.pausedByStop = true;
        this.setPaused(true);
        this.state.status = this.line("stopped");
      } else if (this.state.speaking || this.arbiter.size()) {
        this.cancelSpeech();
      }
      // The shadow hears of it after the live stop, then the session's numbers and audio are let go.
      this.shadowTurn((a) => a.control("stop-all", Date.now()));
      this.dropTurnShadow();
      this.emit();
      return;
    }
    if (this.pausedByStop) {
      this.pausedByStop = false;
      this.setPaused(false);
    }
    this.gateRelease();
  }

  setPaused(paused: boolean) {
    if (!paused && this.stopped()) {
      // The microphone does not reopen under the kill switch, whoever asks.
      this.state.status = this.line("stop-on");
      this.emit();
      return;
    }
    if (this.state.paused === paused) return;
    if (this.state.paused && !paused) this.pausedByStop = false;
    this.state.paused = paused;
    if (paused) {
      cancelPrewarm();
      this.stopRecognition();
      this.shadowTurn((a) => a.control("pause", Date.now()));
      this.gateSleep(this.pausedByStop || this.stopped() ? "stopped" : "paused");
      this.discardEager();
      this.cancelSpeech();
      clearEchoReference("paused");
      this.forgetOpenQuestions();
      // A confirmation that was waiting is dropped too: a yes after resume binds to nothing.
      this.state.pending = null;
      this.pendingHeard = null;
      clearPendingChange();
      // The tray pause is the kill switch: it ends every voice task and the Brain's turn too, whoever owns it
      // (only the stop word and a barge-in are foreground-only).
      cancelAllVoiceTasks();
      brain.stop();
      if (this.state.mode === "auto") {
        // The pause closes the capture track too (like Mute), so the OS shows no live microphone; Resume reopens it
        // through the deferred open.
        voiceGate.release("auto-mode");
        this.autoMicDeferred = true;
        this.state.micReady = false;
      }
      this.to("pause");
      this.state.status = this.line("paused");
    } else if (this.state.mode === "auto") {
      // An explicit resume is the owner asking again: retry immediately.
      this.gateRelease();
      this.resetVoiceRecovery();
      this.to("resume");
      if (this.autoMicDeferred) {
        this.autoMicDeferred = false;
        this.openAutoMic();
      } else if (this.state.micReady) {
        // A warm-up that a pause cut short starts again; one that finished is not repeated.
        this.startPrewarmPass();
      }
      this.startRecognition();
    } else {
      this.to("stopped");
    }
    this.emit();
  }

  togglePaused() {
    this.setPaused(!this.state.paused);
  }

  /** The line after a spoken Stop everything, played after the one before it ended. */
  private stopLineTail: Promise<void> = Promise.resolve();

  /**
   * Say what Stop everything really stopped: the line for what stopped at once, and the line once the kernel and the
   * terminal answered when it says more. The kill switch empties the speech queue, so these lines are played
   * directly; mute and the Speak replies setting still keep them off the speaker. Both are shown on screen.
   */
  private sayStopLine(stop: { now: string; settled: Promise<string> }) {
    const show = (line: string) => {
      this.caption("friday", line);
      this.state.status = line;
      this.emit();
    };
    const play = (line: string) => {
      if (!spokenReplyAllowed(this.state.mode, this.state.muted)) return;
      if (!preferences.getSnapshot().voice.speakReplies) return;
      this.stopLineTail = this.stopLineTail
        .then(() => this.playSpoken(line, this.speechGen))
        .catch(() => undefined);
    };
    show(stop.now);
    play(stop.now);
    void stop.settled
      .then((later) => {
        if (!later || later === stop.now) return;
        show(later);
        play(later);
      })
      .catch(() => undefined);
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
      // Only a stored `true` opens hands-free; nothing saved keeps the wake word required.
      if (savedHands === true) {
        this.state.handsFree = true;
        this.wakeWordRequired = false;
      }
    } catch {
      /* storage blocked — keep the auto default */
    }
    // The selected FRIDAY folder is authoritative for the remembered mode.
    restoreFromDisk<AssistantMode>(STORAGE_KEY, (mode) => {
      if ((mode === "auto" || mode === "manual") && mode !== this.state.mode) this.setMode(mode);
    });
    restoreFromDisk<unknown>(HANDS_FREE_KEY, (on) => this.setHandsFree(on === true));
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
      if (this.state.mode !== "auto" || this.state.paused || this.state.muted) return;
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
      if (this.state.mode !== "auto" || this.state.paused || this.state.muted) return;
      this.trace("segment", "sleep-resume — reopening the microphone");
      this.applyVoiceHeal("mic-no-device", false);
    });
    voiceGate.subscribe(() => {
      this.superviseTick();
      // The gate's own beat is the shadow's 80 ms frame: no timer of its own.
      if (!this.state.paused && !this.state.muted)
        this.shadowTurn((a) =>
          a.vad(voiceGate.getSnapshot().speech, this.echoCleanedSpeech(), Date.now()),
        );
      if (this.state.mode !== "auto" || this.quietHealSent) return;
      if (!voiceGate.quietNotice()) return;
      this.quietHealSent = true;
      this.applyVoiceHeal("vad-too-quiet", false);
    });
    this.turnStreamOff ??= subscribeStreamTurns((turn) => this.noteStreamTurn(turn));
    desktop()?.onSttProgress?.((payload) => {
      const next = describeDownload(payload);
      if (!next) return;
      if (this.downloadTimer) clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
      this.state.download = next.stage === "check" && !next.updateAvailable ? null : next;
      if (this.state.mode === "auto") {
        this.state.status = next.percent == null ? next.label : `${next.label} ${next.percent}%`;
      }
      // A finished row stays long enough to be read, then goes. A failed row stays until the owner acts or a new
      // progress event replaces it: a failure is never cleared by a timer.
      if (next.stage === "ready" || next.stage === "check") {
        this.downloadTimer = setTimeout(() => {
          this.state.download = null;
          this.downloadTimer = null;
          this.emit();
        }, 4000);
      }
      this.emit();
    });
    // "Pause listening" from the tray really stops the microphone here.
    desktop()?.onVoicePause?.((payload) => this.setPaused(Boolean(payload?.paused)));
    desktop()?.onVoicePartial?.((payload) => {
      const text = String(payload?.text || "").trim();
      if (!text || this.state.mode !== "auto" || this.state.paused || this.callHold) return;
      this.state.interim = text;
      if (this.interruptGate.active) {
        this.gateText = text;
        this.stepInterruptGate(false);
      }
      const now = Date.now();
      if (now - this.partialSeenAt > DRAFT_TURN_GAP_MS) this.draftsThisTurn = 0;
      this.partialSeenAt = now;
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
        this.discardEager();
      } else if (plan === "start" && !this.speculative) {
        const { wake, accepted, command, preview } = this.eagerCandidate(text, now);
        if (!command || !this.eagerAllowed(command)) {
          // The same gates as the final transcript: nothing starts, nothing is cut.
        } else if (preview.handled) {
          this.speculative = command;
          this.speculativeKind = "conduct";
        } else if (accepted && this.eagerAddressed(text, wake.matched)) {
          this.startDraftRun(command);
        }
      }
      this.shadowTurn((a) => a.partial(text, now));
      this.emit();
    });
    // A headset being plugged/unplugged kills the audio track: rebuild it.
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      if (this.hotplugTimer) window.clearTimeout(this.hotplugTimer);
      this.hotplugTimer = window.setTimeout(() => {
        this.hotplugTimer = null;
        void this.reopenInput("hotplug");
        void refreshOutputDevices();
      }, 400);
    });
    if (this.state.mode === "auto") this.enterAuto();
    this.emit();
    void import("./installer-engine").then(({ installer }) => {
      let lastWhisper = Boolean(installer.getSnapshot().installed["faster-whisper"]);
      installer.subscribe(() => {
        const now = Boolean(installer.getSnapshot().installed["faster-whisper"]);
        // Readiness follows the install both ways on every event (an uninstall or a failed repair turns it off).
        this.offlineVoicePackage = Boolean(installer.getSnapshot().installed["supertonic"]);
        this.recomputeOfflineVoice();
        if (now && (!lastWhisper || this.sttGaveUp)) {
          this.resetVoiceRecovery();
          this.noteVoiceTrigger("install-finished");
          this.noteVoiceTrigger("model-ready");
        }
        lastWhisper = now;
      });
      // FRIDAY Voice is the default speaking voice: its readiness is read once subscribed, not only on a later event.
      this.offlineVoicePackage = Boolean(installer.getSnapshot().installed["supertonic"]);
      this.recomputeOfflineVoice();
      void this.refreshOfflineVoice();
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
      this.enterAutoWhenStarted();
    } else this.leaveAuto();
    this.emit();
  }

  /** Cancels the wait for the boot screen to go (set while Auto is waiting for FRIDAY to finish starting). */
  private bootWait: (() => void) | null = null;

  /**
   * Auto comes back from the saved mode the moment the page mounts, which is behind the boot screen. The microphone,
   * the wake engine and the voice self-check must not start, and nothing may be said, until FRIDAY has finished
   * starting and the window is open: the owner heard FRIDAY talk while the screen still said "Restoring your state".
   */
  private enterAutoWhenStarted() {
    this.bootWait?.();
    this.bootWait = null;
    if (!isBootHolding()) {
      this.enterAuto();
      return;
    }
    this.state.status = this.line("booting");
    this.bootWait = whenBootDone(() => {
      this.bootWait = null;
      if (this.state.mode !== "auto") return;
      this.enterAuto();
      this.emit();
    });
  }

  toggle() {
    this.setMode(this.state.mode === "auto" ? "manual" : "auto");
  }

  /* ------------------------------------------------------------ captions */

  /**
   * The words shown for a spoken line. With the owner's tidy setting on, FRIDAY Tidy cleans only this shown text, on
   * this PC; the command that goes to the Brain is never replaced, and an empty result falls back to what was heard.
   */
  private tidyShown(heard: string): { text: string; tidy?: Caption["tidy"] } {
    const voice = preferences.getSnapshot().voice;
    if (voice.tidyDictation === false) return { text: heard };
    // FRIDAY Tidy first, then spoken numbers, dates and amounts written as digits (`voice.itn`, default on).
    return shapeHeardText(heard, {
      tidy: true,
      itn: voice.itn !== false,
      requested: voice.recognitionLang,
      dictionary: parseVocabulary(voice.vocabulary).map((term) => ({ heard: term, write: term })),
    });
  }

  /** How heard lines keep the script policy (Hindi in Devanagari, English in Latin): counts only, last 50 lines. */
  private readonly scriptTally = new ScriptPolicyTally();

  /**
   * The streaming ear for the next utterance, or null when `voice.streamEngine` is off (the default is auto: it runs where the PC can). Only Auto
   * mode's dictation asks, inside a turn it already listens to; it never opens the microphone itself.
   */
  private streamPlan(): StreamPlan | null {
    const voice = preferences.getSnapshot().voice;
    if (!streamWanted(voice.streamEngine) || this.state.mode !== "auto") return null;
    return {
      streamEngine: voice.streamEngine,
      locale: streamLocale(voice.recognitionLang),
      hotwords: streamHotwords({
        names: [voice.addressName, voice.wakeWord],
        // The command lane's names bias the decode (one per phonetic key), so "open Spotify" is heard as said.
        ...(voice.understanding.commandLane
          ? { apps: commandHints(this.commandRegistry().flatMap((entry) => entry.names)) }
          : {}),
        vocabulary: parseVocabulary(voice.vocabulary),
      }),
    };
  }

  /** Who a line is for: her (by name, or inside the open conversation), another assistant, or the room. */
  private addressingFor(text: string): AddressDecision {
    return decideAddressing({
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
  }

  /** What a provisional line would be as a turn: the wake match, whether she takes it, the command and its conduct preview. */
  private eagerCandidate(text: string, now: number) {
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
    return { wake, accepted, command, preview };
  }

  /**
   * The ear's eager endpoint may start the Brain's text-only draft, through the same gates as a stable partial. It
   * never starts the conduct preview, a tool or a run.
   */
  private planTurnDraft(text: string, now: number) {
    const { wake, accepted, command, preview } = this.eagerCandidate(text, now);
    if (!command || preview.handled || !this.eagerAllowed(command)) return;
    if (this.holdPending(wake.matched)) return;
    if (accepted && this.eagerAddressed(text, wake.matched)) this.startDraftRun(command, true);
  }

  /**
   * The ear's "needs a wake word" tag (an other voice or a TV, only with `voice.ears.otherVoice` = hold). It is
   * remembered for that turn id and read by `heldForWake` alone, which can only REFUSE a no-wake-word line.
   */
  private noteHold(turn: StreamTurn, now: number) {
    const hold = preferences.getSnapshot().voice.ears.otherVoice === "hold";
    if (hold && turn.needsWake === true) {
      this.holdTurnId = turn.turnId;
      this.holdSeenAt = now;
    } else if (this.holdTurnId === turn.turnId) this.holdTurnId = "";
  }

  /**
   * True when this final line is held to ambient: the ear tagged the turn, no wake word was heard, the conversation
   * is closed and the owner did not push to talk. It only ADDS a requirement; it never accepts, confirms or approves.
   */
  private heldForWake(wakeMatched: boolean): boolean {
    const held = this.holdPending(wakeMatched);
    this.holdTurnId = "";
    return held;
  }

  /** The same verdict without spending the tag, so an eager draft is not started for a turn that will be held. */
  private holdPending(wakeMatched: boolean): boolean {
    const tagged =
      this.holdTurnId !== "" &&
      this.holdTurnId === this.streamTurnId &&
      Date.now() - this.holdSeenAt < HOLD_TURN_MS;
    if (!tagged || wakeMatched || this.listenStyle() === "push-to-talk") return false;
    const open =
      Date.now() < this.followUpUntil ||
      Date.now() < this.awakeUntil ||
      Date.now() - this.liveWakeAt < LIVE_WAKE_MS;
    return !open;
  }

  /**
   * One event of the ear's turn protocol. An eager endpoint may start the draft (only with `voice.ears.eagerTurn`),
   * a resume or a changed text throws it away. Nothing else changes: the turn itself still ends through the final
   * transcript and every gate after it.
   */
  private noteStreamTurn(turn: StreamTurn) {
    if (this.state.mode !== "auto" || this.state.paused || this.state.muted || this.callHold)
      return;
    const now = Date.now();
    // The room tag can only RAISE the wake threshold (wake-guard.ts); it never lowers a gate or approves anything.
    if (turn.env) voiceGate.wake.observeScene(turn.env, performance.now());
    this.noteHold(turn, now);
    // A new turn id is a new turn: its first draft is allowed again.
    if (turn.turnId !== this.streamTurnId || now - this.partialSeenAt > DRAFT_TURN_GAP_MS)
      this.draftsThisTurn = 0;
    // When this turn's voice began: a yes is bound to the digest that was asked before it (answeredBefore).
    if (turn.turnId !== this.streamTurnBegan?.turnId)
      this.streamTurnBegan = { turnId: turn.turnId, at: now };
    this.streamTurnId = turn.turnId;
    for (const action of this.turnTracker.ingest(turn, now)) {
      if (action.kind === "cancel-draft") {
        if (this.speculativeKind === "brain") this.discardEager();
        this.draftsThisTurn = 0;
      } else if (!this.speculative) {
        this.planTurnDraft(action.text, now);
      }
    }
    // The Doctor's turn-taking and room rows read these counts; they are tags and numbers, never a gate.
    noteEarsTurn({
      lastEndMs: this.turnTracker.lastEndMs,
      eager: this.turnTracker.eagers,
      resumed: this.turnTracker.resumes,
      scene: this.turnTracker.lastEnv,
    });
    this.shadowTurn((a) => a.ear(turn, now));
  }

  /**
   * A provisional line may start a draft only when it is for her: her name was said, or it is a follow-up inside the
   * open conversation (the same addressing rule the final transcript uses). Speech from a TV, a call or a bystander
   * is ambient and never reaches a model, not even a free cloud one.
   */
  private eagerAddressed(text: string, wakeMatched: boolean): boolean {
    if (foreignAssistant(text) && !wakeMatched) return false;
    if (wakeMatched) return true;
    const decision = this.addressingFor(text);
    return decision.tag !== "self" && decision.answer && decision.tools;
  }

  /**
   * The one gate for a speculative start, read from the partial handler: every check the final transcript makes
   * before it acts, plus the ones a provisional line needs (nothing pending, nothing sensitive, nothing that asks
   * for approval or claims authority). The speaker is not known until the final transcript, so with "only my
   * voice" on there is no early start at all. A start never speaks over FRIDAY and never touches a running turn.
   */
  private eagerAllowed(command: string): boolean {
    if (this.state.mode !== "auto" || this.stopped()) return false;
    if (this.state.paused || this.state.muted || this.callHold) return false;
    if (this.bootWait || isBootHolding()) return false;
    if (this.recentlySpeaking()) return false;
    if (this.voiceSettings().ownerVoiceOnly) return false;
    if (this.state.pending || this.pendingHeard || brain.getSnapshot().approval) return false;
    // A staged settings change waits for its yes: no draft starts that a yes could reach unchecked.
    if (pendingChange()) return false;
    if (looksSensitive(command)) return false;
    return !commandNeedsApproval(command, this.state.mode) && !voiceClaimsAuthority(command);
  }

  /** What must still hold when the final transcript arrives for a draft to be adopted (see eagerAdoptable). */
  private eagerSnapshot(): EagerSnapshot {
    const level = autonomy.getSnapshot();
    return {
      privacyMode: preferences.getSnapshot().voice.privacyMode === true,
      paidAccess: billing.getSnapshot().billing.paidAccess === true,
      approvalLevel: level.approvalLevel,
      halted: level.halted === true,
    };
  }

  /** A line compared the way the owner reads it: tidied, then without case, punctuation or spacing. */
  private eagerKey(text: string): string {
    const tidy = tidyTranscript(text, {
      requested: preferences.getSnapshot().voice.recognitionLang,
    });
    return (tidy.text.trim() ? tidy.text : text)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
      .trim();
  }

  /** The draft this voice started is the final line, tidied, and privacy, paid access and approval are unchanged. */
  private eagerAdoptable(command: string): boolean {
    if (this.speculativeKind !== "brain" || !this.speculative || !this.draftSnapshot) return false;
    const then = this.draftSnapshot;
    const now = this.eagerSnapshot();
    return (
      now.privacyMode === then.privacyMode &&
      now.paidAccess === then.paidAccess &&
      now.approvalLevel === then.approvalLevel &&
      now.halted === then.halted &&
      this.eagerKey(command) === this.eagerKey(this.speculative)
    );
  }

  /**
   * The only call site that starts a draft: the Brain's text-only draft (no run, no tools, no approval, no history,
   * never shown or spoken). One draft per turn, and none while a turn runs. A refusal means nothing starts, and
   * the final transcript runs as an ordinary turn. A draft never counts as a spoken user line (no pendingUserEcho).
   */
  private startDraftRun(command: string, viaTurn = false) {
    // The owner's switch (Settings > Voice, off by default): without it no guess is ever made. An eager endpoint of
    // the streaming ear has its own, `voice.ears.eagerTurn`, also off by default.
    const earsEager = viaTurn && preferences.getSnapshot().voice.ears.eagerTurn === true;
    if (!earsEager && preferences.getSnapshot().voice.eagerTurn !== true) return;
    if (this.draftsThisTurn >= 1 || brain.getSnapshot().activeRunId) return;
    const started = brain.startDraft(command, {
      ...(viaTurn ? { onlyLocal: true } : {}),
      ...this.turnHintsOption(),
    });
    if (!started.started) return;
    this.draftsThisTurn += 1;
    this.speculative = command;
    this.speculativeKind = "brain";
    this.draftId = started.draft.draftId;
    this.draftSnapshot = this.eagerSnapshot();
  }

  /**
   * The only place a draft ends. `adopted` means the Brain took the draft over as the run, so there is nothing
   * left to throw away; otherwise the draft is discarded in the Brain (its chat is aborted and nothing of it
   * stays). A draft never ran, spoke or counted an echo, so no playback and no caption is touched here.
   */
  private discardEager(adopted = false) {
    const kind = this.speculativeKind;
    const draftId = this.draftId;
    this.speculative = "";
    this.speculativeKind = "";
    this.draftId = "";
    this.draftSnapshot = null;
    if (adopted || kind !== "brain" || !draftId) return;
    brain.discardDraft(draftId);
  }

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
    meta?: {
      tag?: Caption["tag"];
      confidence?: number;
      language?: string;
      tidy?: Caption["tidy"];
    },
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
      ...(meta?.tidy ? { tidy: meta.tidy } : {}),
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
   * Hands-free starts off; only a stored `true` opens it, and a fresh profile
   * writes nothing, so it is never saved as an explicit opt-in.
   */
  setHandsFree(on: boolean, persist = true) {
    this.wakeWordRequired = !on;
    voiceGate.wake.setHandsFree(on);
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

  /**
   * Mute silences FRIDAY and closes the microphone (the owner's decision: Mute stops the mic). Recognition stops and
   * the Auto microphone is released, the way the tray pause does it; unmute reopens it through the same deferred open
   * Resume uses, and never under the tray pause or Stop everything, which keep their own meaning.
   */
  setMuted(muted: boolean) {
    if (this.state.muted === muted) return;
    this.state.muted = muted;
    // The talk key, the toggle and the wake gates follow the microphone's permission at once.
    if (muted) this.gateSleep("muted");
    if (muted) cancelPrewarm();
    if (muted) this.discardEager();
    if (whisperMutePlan(muted).stop) this.cancelSpeech();
    if (muted) clearEchoReference("muted");
    if (muted) {
      // Like the tray pause: a waiting order, a waiting read-back and a voiced prompt are dropped, so a yes after
      // unmute binds to nothing (a task still waiting is answered on the screen).
      this.state.pending = null;
      this.pendingHeard = null;
      this.approvalAsked = null;
      this.approvalSpoken = null;
      this.approvalPrompt = null;
      this.askSound = null;
      clearPendingChange();
    }
    if (muted && this.state.mode === "auto") {
      this.stopRecognition();
      voiceGate.release("auto-mode");
      this.autoMicDeferred = true;
      this.state.micReady = false;
      this.state.status = this.line("muted");
    } else if (!muted && this.state.mode === "auto" && !this.state.paused && !this.stopped()) {
      this.gateRelease();
      this.resetVoiceRecovery();
      if (this.autoMicDeferred) {
        this.autoMicDeferred = false;
        this.openAutoMic();
      }
      this.startRecognition();
    }
    if (muted) {
      // After the live mute took effect; the shadow's numbers and audio go with the closed microphone.
      this.shadowTurn((a) => a.control("mute", Date.now()));
      this.dropTurnShadow();
    }
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
      this.clearMicError();
    } else if (status.state === "permission-required") {
      this.setMicError("microphone: permission required", status.state);
    } else if (status.reason) {
      this.setMicError(`microphone: ${status.reason}`, status.state);
    }
    this.emit();
    return status;
  }

  /** The microphone fault on screen is one plain sentence; the raw reason stays in the trace. */
  private setMicError(raw: string, state: MicStatus["state"]) {
    this.trace("error", raw);
    this.micErrorLine = plainFaultLine(raw, this.lineLang(), {
      ...(state !== "available" ? { micState: state } : {}),
    });
    this.state.error = this.micErrorLine;
  }

  private clearMicError() {
    if (this.micErrorLine && this.state.error === this.micErrorLine) this.state.error = null;
    this.micErrorLine = "";
  }

  /**
   * Settings > Voice changed the microphone or the noise-suppression choice: open the input again now, with the
   * saved device (a missing one falls back to the default and says so). Nothing happens outside Auto, while paused,
   * muted or stopped; the choice is then read the next time the microphone opens.
   */
  applyInputChoice(): Promise<void> {
    return this.reopenInput("hotplug");
  }

  /** Hot-plug, sleep, and resume. A missing saved device falls back and says so. */
  private async reopenInput(reason: "hotplug" | "resume") {
    if (this.state.mode !== "auto" || this.state.paused || this.state.muted) return;
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
  /** A read-back waiting for a yes; `ttlMs` (the approval window) when a snap or a repair asked, else 25 s. */
  private pendingHeard: {
    command: string;
    at: number;
    turn?: TurnHints | undefined;
    ttlMs?: number;
  } | null = null;
  /** When she last read words back: she does not do it twice in a row. */
  private lastReadBackAt = 0;

  /** The speech model's own scores for the last utterance, for the diagnostics panel. */
  heardQuality(): HeardQuality | null {
    return this.lastHeardQuality;
  }

  voiceTone(): VoiceTone | null {
    return this.lastTone;
  }

  /**
   * Mute, the tray pause, Stop everything and leaving Auto: the talk key, the toggle and its tail end now, and the
   * hands-free wake gate is asleep and locked until the microphone may be read again. Never opens or closes the
   * microphone itself.
   */
  private gateSleep(reason: "muted" | "paused" | "stopped") {
    pttSetAllowed(false);
    pttCloseNow();
    this.wakeAwaitingCommand = false;
    if (this.wakeFalseTimer) clearTimeout(this.wakeFalseTimer);
    this.wakeFalseTimer = null;
    voiceGate.wake.forceAsleep(reason, performance.now());
  }

  /** Unmute, resume, entering Auto: the talk key works again and the wake gate listens, only if the mic is allowed. */
  private gateRelease() {
    const allowed = this.micAllowed() && !this.stopped();
    pttSetAllowed(allowed);
    if (allowed) voiceGate.wake.release(performance.now());
  }

  private pttShown: PttPhase = "idle";
  private pttPhaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** A wake word with no command after it, waiting to be proved a real wake or reported false. */
  private wakeAwaitingCommand = false;
  private wakeFalseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Show "Listening" while the talk key is held and "Finishing" through the release tail. */
  private publishPttPhase() {
    if (this.state.mode !== "auto") return;
    const language = (preferences.getSnapshot().voice.recognitionLang || "hi-IN").toLowerCase();
    const phase = pttPhase(Date.now(), language);
    if (phase === "finishing" && !this.pttPhaseTimer) {
      this.pttPhaseTimer = setTimeout(
        () => {
          this.pttPhaseTimer = null;
          this.publishPttPhase();
        },
        pttTailMs(language) + 40,
      );
    }
    if (phase === this.pttShown) return;
    this.pttShown = phase;
    if (phase === "listening") this.state.status = this.line("listening");
    else if (phase === "finishing") this.state.status = this.line("finishing");
    else if (
      [STATUS_LINES.listening, STATUS_LINES.finishing].some((row) =>
        (Object.values(row) as string[]).includes(this.state.status),
      )
    )
      this.state.status = stateLabel(this.state.voiceState);
    this.emit();
  }

  /**
   * One decision on a wake word that was heard: the hands-free gates (locked, cooldown, her own voice, no speech
   * before it) rule on it. A push-to-talk turn and a stop word are never held up. A refused wake only loses the
   * wake privilege; what follows is judged by the ordinary addressing rules, so nothing is executed because of it.
   */
  private wakeGuardAllows(text: string): boolean {
    if (this.listenStyle() === "push-to-talk" || this.isStopHeard(text, true)) return true;
    // No open microphone means no frames for the gate to judge by: it cannot rule, so the transcript decides.
    if (!this.state.micReady) return true;
    const verdict = voiceGate.wake.consider({
      nowMs: performance.now(),
      score: 1,
      threshold: wakeThreshold(0.02, null),
      kind: "utterance",
      ...(performance.now() - this.bargeMicAt <= 1000 ? { ownerEnergy: this.bargeMicLevel } : {}),
      playbackEnergy: speechRms(),
      echoRefLive: this.echoReferenceLive(),
      selfEchoText: this.recentlySpeaking() && this.isSelfEcho(text),
    });
    if (!verdict.accept) {
      this.trace("wake", `wake word not taken (${verdict.reason})`);
      if (verdict.reason === "self-voice") this.reportFalseWake();
    }
    return verdict.accept;
  }

  /** The echo reference is cleaning the microphone frames right now (it is on, attached and has cleaned some). */
  private echoReferenceLive(): boolean {
    return echoReferenceRunning(echoDiagnostics());
  }

  /** The wake turned out wrong (her own voice, or nothing followed): she sleeps and stays quiet for a while. */
  private reportFalseWake() {
    this.wakeAwaitingCommand = false;
    if (this.wakeFalseTimer) clearTimeout(this.wakeFalseTimer);
    this.wakeFalseTimer = null;
    voiceGate.wake.reportFalseWake(performance.now());
  }

  /** A wake word with nothing after it: if no command comes inside the awake window, it was a false wake. */
  private expectCommandAfterWake() {
    this.wakeAwaitingCommand = true;
    if (this.wakeFalseTimer) clearTimeout(this.wakeFalseTimer);
    this.wakeFalseTimer = setTimeout(() => {
      this.wakeFalseTimer = null;
      if (!this.wakeAwaitingCommand) return;
      this.trace("wake", "no command followed the wake word — counted as a false wake");
      this.reportFalseWake();
    }, AWAKE_MS() + 500);
  }

  /** Hold Ctrl+Space in the window, or press the global toggle, to talk. */
  private armPushToTalk() {
    this.disarmPushToTalk();
    const api = desktop();
    let shortcutWanted: boolean | null = null;
    const syncShortcut = () => {
      // The owner's release tail and wake-gate numbers, each bounded where they are read.
      const voice = preferences.getSnapshot().voice;
      setPttTailMs(voice.pttTailMs);
      voiceGate.wake.configure(voice.wake);
      const want = this.state.mode === "auto" && this.listenStyle() === "push-to-talk";
      if (want === shortcutWanted) return;
      shortcutWanted = want;
      void api?.setPttShortcut?.(want).then((row) => {
        if (want && row && !row.ok) this.trace("error", `push-to-talk shortcut: ${row.reason}`);
      });
    };
    syncShortcut();
    this.pttCleanup.push(preferences.subscribe(syncShortcut));
    this.pttCleanup.push(subscribePtt(() => this.publishPttPhase()));
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
        pttFocusLost();
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
    // The next session starts with nothing shown: a stale phase would hide its first press.
    this.pttShown = "idle";
    if (this.pttPhaseTimer) clearTimeout(this.pttPhaseTimer);
    this.pttPhaseTimer = null;
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

  /** Whether Auto started with the microphone held back (Stop everything or the pause was on). Resume opens it. */
  private autoMicDeferred = false;

  /**
   * Acquire the shared microphone for Auto. Done on the Auto Mode click or on Resume, so the browser lets
   * the AudioContext start. Not done while Stop everything or the owner's pause is on.
   */
  private openAutoMic() {
    if (this.state.muted) {
      // Mute keeps the microphone closed; unmute opens it.
      this.autoMicDeferred = true;
      return;
    }
    const preferred = preferences.getSnapshot().voice.inputDeviceId || null;
    // A throwaway probeMicrophone capture afterwards would fight Windows exclusive-mode devices and leave the
    // analyser silent, so nothing awaits before the acquire.
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
            true,
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
            true,
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
      // Consent is given and the capture runs: only now are the engines warmed, and never in the way of the turn.
      this.startPrewarmPass();
      const worked = typeof settings.deviceId === "string" ? settings.deviceId : null;
      const previous = preferences.getSnapshot().voice.inputDeviceId || null;
      const next = rememberDevice(worked, previous);
      if (next && next !== previous) preferences.setVoice({ inputDeviceId: next });
      this.clearMicError();
      this.emit();
    });
  }

  private enterAuto() {
    this.armPushToTalk();
    this.ensureLiveWake();
    // A new Auto session decides the raw-sample player afresh, and reads the output list and the local voice.
    resetPcmPlayback();
    void refreshOutputDevices();
    void this.refreshOfflineVoice();
    // Her own look at her ears and voice a few seconds after Auto starts; silent unless something is wrong.
    if (this.autoCheckTimer) clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null;
      if (this.state.mode === "auto") void this.selfCheckVoice(false);
    }, 6000);
    this.startBargeShadow();
    this.soak.start(Date.now());
    // Same runtime, different shape: the brain now knows replies are spoken.
    brain.setAutoMode(true);
    voiceGate.wake.setHandsFree(this.state.handsFree);
    this.gateRelease();
    this.state.error = null;
    // Turning Auto Mode on is an explicit request — retry the engine now.
    this.resetVoiceRecovery();
    this.to("session-start");
    this.state.status = this.line("starting-mic");
    void this.refreshWakeEngine(true);
    this.spokenUpTo = brain.getSnapshot().messages.length;
    this.unBrain = brain.subscribe(() => this.speakNewReplies());
    this.unQuick = brain.onQuickAnswer((answer) => this.speakQuickAnswer(answer));
    if (this.stopped() || this.state.paused) {
      // Stop everything persists across a restart, and the owner may have paused: Auto starts with the
      // microphone closed and the first Resume opens it.
      this.autoMicDeferred = true;
      if (this.stopped()) this.followKillSwitch();
      this.to("pause");
      this.state.status = this.line(this.stopped() ? "stopped" : "paused");
    } else {
      this.openAutoMic();
    }
    void this.refreshMeeting();
    this.startRecognition();
  }

  /**
   * Warm the speech, voice, turn and kernel engines once per Auto session, right after the microphone opened. It
   * plays nothing, never blocks the session and never raises an error: a failed step is a note in the voice log and
   * a Warning row in Voice Doctor.
   */
  private startPrewarmPass() {
    if (this.prewarmDone || this.state.mode !== "auto") return;
    void startPrewarm(
      {
        mode: this.state.mode,
        micOpen: this.state.micReady,
        held: this.state.paused || this.state.muted || this.stopped(),
        localVoice: this.offlineVoiceReady,
      },
      (outcome) => this.stampPrewarm(outcome),
    )
      .then((report) => {
        if (this.state.mode !== "auto") return;
        if (
          report.outcomes.some((outcome) => outcome.state === "done" || outcome.state === "failed")
        ) {
          this.prewarmDone = !report.outcomes.some((outcome) => outcome.state === "cancelled");
          this.trace("segment", prewarmLine(report));
        }
      })
      .catch(() => undefined);
  }

  /** The timing of one warm-up step goes into the same latency record as the turn stages. */
  private stampPrewarm(outcome: PrewarmOutcome) {
    if (outcome.state === "done") voiceLatency.record(`prewarm.${outcome.step}`, outcome.ms);
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
      this.state.status = this.line("call-open");
    } else if (this.state.mode === "auto" && !this.state.paused) {
      this.startRecognition();
      this.afterQuiet(); // what the call held back, as text
    }
    this.emit();
  }

  private persistConduct() {
    writeState(CONDUCT_KEY, saveConduct(this.conduct));
  }

  private leaveAuto() {
    this.disarmPushToTalk();
    this.gateSleep("stopped");
    cancelPrewarm();
    this.prewarmDone = false;
    this.heldPlayed = null;
    beginPlayedReply("", true);
    this.bootWait?.();
    this.bootWait = null;
    this.autoMicDeferred = false;
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
    this.unQuick?.();
    this.unQuick = null;
    this.stopRecognition();
    this.dropPlayback();
    void this.streamSpeaker?.stop();
    this.streamSpeaker = null;
    void this.stopCloudCaptions();
    this.stopLiveWake();
    this.stopBargeShadow();
    this.soak.stop(Date.now());
    // Nothing from this Auto session may survive into the next one: queued requests, a paused reply, a spent wake.
    this.queuedCommands = [];
    this.queuedHints.clear();
    this.stopQueueTimer();
    this.liveWakeAt = 0;
    this.translateTo = null;
    this.deferredStream = null;
    this.unfinished = "";
    if (this.interruptHold?.timer) clearTimeout(this.interruptHold.timer);
    this.interruptHold = null;
    this.endInterruptCandidate(true);
    // The shadow's numbers and audio belong to this Auto session; a fault flag is cleared for the next one.
    this.dropTurnShadow();
    this.turnShadowBroken = false;
    // A note that was running stops with the microphone: the banner must never show a recording that is not heard.
    voiceNotes.stop();
    this.cancelVoiceRecoveryTimer();
    if (this.hotplugTimer) window.clearTimeout(this.hotplugTimer);
    this.hotplugTimer = null;
    this.callHold = false;
    this.discardEager();
    this.draftsThisTurn = 0;
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
    this.state.status = this.line("manual");
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* not available */
    }
  }

  /** The microphone may be read: Auto, not paused by the owner or the kill switch, and not muted. */
  private micAllowed(): boolean {
    return microphoneAllowed(this.state.mode, this.state.paused) && !this.state.muted;
  }

  /** Start FRIDAY's own on-device transcriber. Browser cloud speech is never used. */
  private startRecognition() {
    if (this.callHold) return;
    // A session that begins while Stop everything is on (it persists across a restart) must not open the microphone.
    if (this.stopped()) this.followKillSwitch();
    if (!this.micAllowed()) {
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
    this.state.status = this.line("preparing-model");
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
        if (!this.wantRunning || !this.micAllowed()) return;
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
    if (this.state.mode !== "auto" || this.state.paused || this.state.muted) return;
    // The local voice may have been installed or mended: read its reason again so a stale one is not quoted.
    if (VOICE_STATUS_TRIGGERS.has(trigger)) void this.refreshOfflineVoice();
    this.resetVoiceRecovery();
    this.startRecognition();
  }

  /**
   * The Fix voice button: she looks at her own microphone, speech engine, voice and wake engine, mends
   * exactly what is broken, and says what she found in the owner's language.
   */
  fixVoice() {
    speechTurnPlan("fix voice", preferences.getSnapshot().voice.recognitionLang || "hi-IN");
    void this.refreshOfflineVoice();
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
    this.offerRestartRedo();
  }

  /** Task names as one spoken list: "A", "A and B", "A, B and C". */
  private nameList(tasks: readonly VoiceTask[]): string {
    // A task that looks private is named neutrally: its words are never said aloud.
    const names = tasks.map((t) =>
      this.taskIsSensitive(t) ? "a private task" : t.spoken || speakableLabel(t.label) || "a task",
    );
    return names.length < 3
      ? names.join(" and ")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  /**
   * Once per app session, when Auto is ready: work that was live when FRIDAY closed comes back on the desk as
   * INTERRUPTED. She says it once and asks whether to redo it; the yes is the ordinary bound yes (it counts only once
   * the question has sounded, and the speaker check applies). She never redoes it on her own, except when the owner
   * chose "auto" in the task settings, autonomy is Full, and every task only reads (see `isReadOnlyRequest`).
   */
  private offerRestartRedo() {
    if (this.restartAsked) return;
    this.restartAsked = true;
    const tasks = restoreInterruptedVoiceTasks();
    if (!tasks.length) return;
    const ids = tasks.map((t) => t.id);
    const lang = this.narrationLang();
    const names = this.nameList(tasks);
    const readOnly = tasks.every((t) => isReadOnlyRequest(t.request ?? ""));
    if (
      this.taskPrefs().resumeAfterRestart === "auto" &&
      readOnly &&
      autonomy.getSnapshot().approvalLevel === "full" &&
      !this.stopped()
    ) {
      const redone = redoInterruptedVoiceTasks(ids);
      if (redone) {
        const said =
          lang === "hi"
            ? `${names} par dobara lag gayi.`
            : `Picking ${names} up again, since it only reads.`;
        this.announceTask(said, { priority: "direct" });
        return;
      }
    }
    this.restartAsk = { ids };
    const ask =
      lang === "hi"
        ? `Band hone par main ${names} par kaam kar rahi thi. Dobara karu?`
        : `I was working on ${names} when I closed. Redo them?`;
    this.announceTask(ask, { priority: "approval", taskId: RESTART_ASK });
  }

  /** The bound yes or no to the restart question. A yes redoes the tasks, a no drops them. False when it is not that. */
  private answerRestartAsk(text: string, route: Route, room: AddressFacts | null = null): boolean {
    const id = route.ref && "taskId" in route.ref ? route.ref.taskId : "";
    if (id !== RESTART_ASK) return false;
    const ask = this.restartAsk;
    if (!ask || !route.verdict) {
      this.approvalAsked = null;
      return false;
    }
    if (route.verdict === "yes") {
      const refusal = this.yesRefusal(this.promptEndsAt(RESTART_ASK), room);
      if (refusal) {
        this.refuseYes(text, refusal, RESTART_ASK);
        return true;
      }
    }
    if (route.verdict === "yes" && !this.approvalVoiceAllows(text)) return true;
    this.approvalAsked = null;
    this.restartAsk = null;
    this.caption("user", text);
    if (route.verdict === "yes") redoInterruptedVoiceTasks(ask.ids);
    else {
      dropInterruptedVoiceTasks(ask.ids);
      this.announceTask(
        this.narrationLang() === "hi" ? "Theek hai, chhod diye." : "Okay, I dropped them.",
        { priority: "direct" },
      );
    }
    this.state.status = this.line("listening");
    this.emit();
    return true;
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
   * The slow beat of the task desk, run from the supervisor's tick (no timer of its own): the one reminder of an
   * open approval, and a rolled-up line when three or more tasks run and the owner has been quiet.
   */
  private slowTaskTick(now: number) {
    if (this.state.mode !== "auto" || this.state.paused) return;
    const waiting = brain.getSnapshot().approval;
    if (
      waiting?.at &&
      this.approvalVoicedAt === waiting.at &&
      this.approvalRemindedAt !== waiting.at &&
      now - waiting.at >= APPROVAL_REPEAT_MS
    ) {
      this.approvalRemindedAt = waiting.at;
      this.voiceBrainApproval(true);
    }
    if (now - this.lastRollupAt < ROLLUP_GAP_MS || this.liveTasks() < ROLLUP_MIN_TASKS) return;
    this.lastRollupAt = now;
    this.narrateEvent({ kind: "rollup" }, this.narrationCtx(false));
  }

  /**
   * The supervisor's turn, run from the microphone analyser's own beat (no timer of its own): if the session
   * has sat in one state longer than that state can last, mend it through the one heal policy, quietly.
   */
  private superviseTick() {
    const now = Date.now();
    if (now - this.lastSupervisorTick < 5000) return;
    this.lastSupervisorTick = now;
    this.soak.sample(now, heapMegabytes());
    this.slowTaskTick(now);
    const verdict = superviseVoice({
      mode: this.state.mode,
      paused: this.state.paused,
      state: this.state.voiceState,
      ageMs: now - this.stateSince,
      brainActive: Boolean(brain.getSnapshot().activeRunId),
      speechQueued: this.arbiter.size() > 0 || this.arbiter.playing() !== null,
      speaking: voiceGate.isSpeakingGuarded(),
      downloading: Boolean(this.state.download && this.state.download.stage === "download"),
    });
    if (!verdict.act) return;
    if (now - (this.supervisedAt.get(verdict.state) ?? 0) < SUPERVISOR_COOLDOWN_MS) return;
    this.supervisedAt.set(verdict.state, now);
    this.interventions += 1;
    this.soak.intervention();
    this.lastIntervention = `${verdict.state}: ${verdict.reason}`;
    this.trace("heal", `supervisor: ${verdict.reason}`);
    if (verdict.remedy === "self-check") {
      void this.selfCheckVoice(false);
      return;
    }
    if (verdict.remedy === "reopen-mic" || verdict.remedy === "restart-speech") {
      this.applyVoiceHeal(verdict.fault, false);
    }
    if (verdict.remedy === "restart-tts") this.requestTtsRestart();
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

  private ttsFailStreak = 0;
  private ttsRestartAsked = false;
  /** Until when the local speaker's breaker counts as open (set from the restart answer, never from a guess). */
  private supertonicBreakerUntil = 0;

  private supertonicBreakerOpen(): boolean {
    return Date.now() < this.supertonicBreakerUntil;
  }

  /**
   * Speech output succeeded or failed. The second failure in a row asks the main process to drop the local speaker
   * (a hung one holds every later clause), once per failure streak: a success starts a new streak, and the restart
   * says nothing itself, because a still-failing voice already shows "voice output failed".
   */
  private noteTtsOutcome(ok: boolean) {
    if (ok) {
      this.ttsFailStreak = 0;
      this.ttsRestartAsked = false;
      return;
    }
    this.ttsFailStreak += 1;
    if (this.ttsFailStreak >= 2 && !this.ttsRestartAsked) {
      this.ttsRestartAsked = true;
      this.requestTtsRestart();
    }
  }

  /** Ask for the speaker restart. A bridge without it, a refusal and a throw are all quiet. */
  private requestTtsRestart() {
    const ask = desktop()?.restartTts;
    if (typeof ask !== "function") return;
    // The restarted worker may answer at another rate: the player's session decision is made again.
    resetPcmPlayback();
    this.trace("heal", "speaker restart requested");
    try {
      void ask()
        .then((answer) => {
          // The main process says the local speaker keeps crashing and is paused: FRIDAY Voice leaves the ladder for the
          // length of the worker's own cool-down (it opens one probe after that), so no line waits on a paused voice.
          if (answer?.state === "breaker-open")
            this.supertonicBreakerUntil = Date.now() + SPEAKER_BREAKER_COOL_MS;
          this.trace("heal", `speaker restart: ${answer?.state ?? "no answer"}`);
        })
        .catch(() => this.trace("heal", "speaker restart: failed"));
    } catch {
      this.trace("heal", "speaker restart: failed");
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
    this.arbiter.setOwnerSpeaking(false); // a stuck "owner is talking" must not hold her lines for good
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
      // Windows owns the privacy switch: open its page, and say where it is when the page cannot open.
      this.state.status = this.line("mic-privacy");
      void desktop()
        ?.openExternalUrl?.(MIC_PRIVACY_LINK)
        .then((result) => {
          if (!result?.ok) return;
          this.state.status = this.line("mic-privacy-opened");
          this.emit();
        })
        .catch(() => undefined);
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
      if (this.dictation || this.state.mode !== "auto" || this.state.paused || this.state.muted)
        return;
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

  /** How long the mic stays quiet before the turn gate confirms the end of the utterance. */
  private endpointHoldMs(): number {
    const open = Date.now() < this.awakeUntil || this.state.handsFree;
    const base = endpointSilenceMs(open, this.state.interim);
    return realtimeSilenceMs(
      base,
      this.realtimeActive(),
      open,
      utteranceIncomplete(this.state.interim),
    );
  }

  /** What answer she waits for: a yes or no while a read-back, a confirmation or an approval is open, else dictation. */
  private turnExpect(): TurnExpect | undefined {
    if (this.state.pending || this.pendingHeard || this.approvalAsked || this.restartAsk)
      return "yesno";
    if (brain.getSnapshot().approval) return "yesno";
    if (voiceNotes.active() || this.translateTo) return "dictation";
    return undefined;
  }

  /** The language of the conversation for the unfinished-sentence wait: the last turn's, else the chosen one. */
  private turnEotLang(): EotLang | undefined {
    const lang =
      this.turnHints()?.lang || streamLocale(preferences.getSnapshot().voice.recognitionLang);
    return lang === "hi" ? "hi" : lang === "en" ? "en" : lang === "hi-en" ? "hinglish" : undefined;
  }

  /** The speech worker is in a crash loop: the status says so in the owner's language, with the retry time. */
  private showListeningPaused(pause: ListeningPause) {
    const lang = this.turnHints()?.lang;
    const line =
      lang === "hi" ? pause.lines.hi : lang === "hi-en" ? pause.lines.hinglish : pause.lines.en;
    const seconds = Math.max(1, Math.ceil(pause.retryAfterMs / 1000));
    this.trace("error", `speech worker paused after repeated crashes, retry in ${seconds} s`);
    this.state.status = `${line} (${seconds} s)`;
    this.emit();
  }

  private startDesktopDictation() {
    void refreshVoiceProfile();
    this.stopWakeOnly();
    if (!this.micAllowed()) return;
    if (this.dictation?.active) return;
    reclaimUnowned(this.dictation);
    const dictation = new DesktopDictation({
      language: preferences.getSnapshot().voice.recognitionLang || "hi-IN",
      deviceId: preferences.getSnapshot().voice.inputDeviceId || null,
      localOnly: true,
      silenceMs: () => this.endpointHoldMs(),
      initialPrompt: () => {
        const voice = preferences.getSnapshot().voice;
        return sttInitialPrompt({
          preference: voice.recognitionLang,
          topic: conversationDigest(),
          vocab: [
            voice.addressName,
            voice.wakeWord,
            voice.voiceName,
            ...parseVocabulary(voice.vocabulary),
          ].filter(Boolean),
        });
      },
      hotwords: () => {
        const voice = preferences.getSnapshot().voice;
        return sttHotwords([
          voice.addressName,
          voice.wakeWord,
          ...parseVocabulary(voice.vocabulary),
        ]);
      },
      // How the utterance scores against the owner's saved voice. Null and instant when no voice is saved.
      voiceProbe: ({ audioBytes, mime }) => scoreUtterance({ audioBytes, mime }),
      // The streaming ear (`voice.streamEngine`, auto by default): its partials take the live-words path, its final
      // stands in for the decode, and any refusal leaves the ordinary decode to read the same audio.
      streamPlan: () => this.streamPlan(),
      onStreamPartial: (update) => {
        this.startLiveWords();
        this.liveWords?.show(update);
      },
      // The end-of-turn wait reads what she expects (a yes, dictation), the owner's language and the words so far.
      turnExpect: () => this.turnExpect(),
      turnLang: () => this.turnEotLang(),
      turnTail: () => this.state.interim,
      onListeningPaused: (pause) => this.showListeningPaused(pause),
      admit: () => pttAdmits(this.listenStyle()),
      onSpeechStart: () => {
        // A turn whose budget was already recorded at its first sound adds only its stage gaps here.
        const finished = this.budgetRecorded
          ? recordGapsOnly(this.turnStages)
          : this.turnStages.finish();
        this.budgetRecorded = false;
        if (Object.keys(finished).length)
          this.soak.turn(Date.now(), finished["firstAudible"] ?? null);
        this.turnStages.reset();
        this.turnStages.mark("micSpeechStart");
        this.turnClock = {
          heardAt: Date.now(),
          finalAt: null,
          tokenAt: null,
          audioAt: null,
        };
        // Barge-in: FRIDAY stops talking the moment the owner starts.
        // Speech from the owner while she speaks: with the gate on it only lowers her volume until words decide
        // (`beginInterruptCandidate`); with it off, voice activity pauses her at once as before.
        this.turnRecordLive = false;
        this.heardSpeaker = null;
        // A draft started in a pause of this sentence is stale the moment the voice resumes.
        if (this.speculativeKind === "brain") this.discardEager();
        if (this.state.speaking) {
          if (this.gateEnabled()) this.beginInterruptCandidate();
          else {
            this.trace("speech", "barge-in — pausing playback, listening to what is said");
            this.holdForInterruption();
          }
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
        if (trimmed) {
          const check = this.scriptTally.note(
            trimmed,
            meta?.quality?.language || preferences.getSnapshot().voice.recognitionLang,
          );
          if (!check.clean) {
            const total = this.scriptTally.summary();
            this.trace(
              "segment",
              `script: ${check.violations.length} word(s) off the script policy · ${total.violating}/${total.samples} recent lines`,
            );
          }
        }
        // Which recogniser may make the turn is decided in one place (stt-authority.ts). By default the local text goes
        // straight through; when the owner made Sarvam the authority it waits briefly for the cloud sentence.
        if (trimmed) this.rememberLocalMeta(trimmed, meta);
        const decision = this.sttArbiter().local(trimmed);
        if (decision.action === "hold")
          this.trace("segment", "local text held for the Sarvam sentence");
      },
      onStateChange: (listening) => {
        // "thinking" is the moment the endpoint hold ran out and the clip was sent: no new timer.
        if (listening === "thinking") stampEndpoint(this.turnStages, this.endpointHoldMs());
        if (listening === "listening") {
          this.soak.recovered();
          this.shownMicFault = "";
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
        this.state.error = this.plainFault(`voice: ${message}`);
        this.state.stt = { ...this.state.stt, lastError: message };
        this.to("error");
        this.state.status = this.line("voice-error");
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
    // Look first, repair only what is broken: a wake model that is on disk but cannot be used heals. With no model
    // for the word at all (the normal case today) there is nothing to repair: the transcript matcher answers, and
    // that is said as a plain status, never as a fault that needs the owner.
    const modelOnDisk = typeof status.model === "string" && status.model !== "";
    if (force && !status.ready && modelOnDisk) this.applyVoiceHeal("wake-model-missing", true);
    else if (!status.ready && this.state.mode === "auto" && !this.state.error)
      this.state.status = "Wake word: listening by transcript";
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
    // Only the VAD hearing the owner holds her lines back; once a transcript is in hand he is done talking.
    this.arbiter.setOwnerSpeaking(next === "SPEECH_DETECTED");
    if (next === "LISTENING" && from !== "LISTENING") {
      releaseTaskUpdates();
      this.afterQuiet();
    }
    if (next !== from && this.arbiter.size()) void this.drainSpeech();
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

  /**
   * A background task update, said in Auto mode (Chat and Manual stay silent) and shown in the captions. A call
   * hold, Do not disturb and quiet hours keep it off the speaker: it is shown, and kept for the digest afterwards.
   */
  announceTask(text: string, meta: SpeakMeta = { priority: "progress" }) {
    this.caption("friday", text);
    // The tray pause is the kill switch: a paused session announces nothing, it only shows. A line that matters is
    // kept for the digest afterwards, so a finished task is never lost to a pause.
    if (this.state.paused) {
      if (meta.priority !== "progress") this.narration.held.push(text);
      return;
    }
    if (this.callHold || !alertsAudible()) {
      if (meta.priority !== "progress") this.narration.held.push(text);
      return;
    }
    this.speak(text, meta);
  }

  /** The language a task line is said in: the owner's own, from the last full line he spoke. */
  private narrationLang(): NarrationLang {
    return replyLanguage(this.lastOwnerLine);
  }

  /** Said once the voice goes quiet: finish lines that aged out unsaid, and what a call or quiet hours held. */
  private afterQuiet() {
    if (this.callHold || !alertsAudible()) return;
    const lang = this.narrationLang();
    const digest = this.arbiter.takeDigest();
    const line = digest ? digestLine(digest, lang) : null;
    if (line) this.announceTask(line, { priority: "direct", uncapped: true });
    const held = holdDigest(this.narration, lang);
    if (held) this.caption("friday", held.text);
  }

  /** The desk's own settings (`voice.tasks`), safe whatever is stored. */
  private taskPrefs() {
    return taskPrefsFrom(
      (preferences.getSnapshot().voice as unknown as Record<string, unknown>)["tasks"],
    );
  }

  /**
   * One task update through the narration policy: it decides what is said, what only shows on screen and what
   * becomes a notification. Raw tool output never reaches the speaker; a SENSITIVE task gets a neutral line.
   */
  narrateTask(update: TaskUpdate, task: VoiceTask) {
    // A task the owner cancelled is settled: a late result, failure or step of it is dropped, never said.
    if (this.taskSpeech.isSettled(task.id)) {
      this.taskSpeech.dropped += 1;
      this.trace("dropped", "a late update of a cancelled task");
      return;
    }
    if (update.kind === "cancelled") {
      const event = toVoiceTaskEvent(update, {
        seq: 0,
        now: Date.now(),
        turnSeqAtStart: 0,
        risk: this.taskRiskClass(task),
        verified: false,
        foreground: false,
      });
      this.taskSpeech.route(event, 0, this.narrationLang());
    }
    // What is said about a task is judged by its label AND by what it answered or failed with: a harmless label can
    // end with a private answer.
    const base = this.narrationCtx(this.taskIsSensitive(task));
    const event = narrationEventFor(update, task);
    if (!event) {
      // A cancel the owner asked for: said plainly, never held back by the progress cap.
      this.announceTask(update.text, { priority: "direct", taskId: task.id });
      narrate({ kind: "settled", taskId: task.id }, base);
      return;
    }
    this.narrateEvent(event, base, task);
  }

  /** What the narration policy needs to know right now. */
  private narrationCtx(sensitive: boolean): Parameters<typeof narrate>[1] {
    const now = Date.now();
    return {
      now,
      lang: this.narrationLang(),
      speakReplies:
        preferences.getSnapshot().voice.speakReplies !== false && this.state.mode === "auto",
      muted: this.state.muted,
      callHold: this.callHold,
      alertsAudible: alertsAudible(),
      whisperMode: preferences.getSnapshot().voice.whisperMode === true,
      progressLinesPerMinute: progressLinesFor(this.taskPrefs()),
      runningTasks: this.liveTasks(),
      ownerIdleMs: this.lastOwnerAt ? now - this.lastOwnerAt : Number.POSITIVE_INFINITY,
      sensitive,
      memory: this.narration,
    };
  }

  /** The desk task with this id, if it is still on the desk. */
  private deskTask(id: string): VoiceTask | undefined {
    return listVoiceTasks().find((row) => row.id === id);
  }

  /**
   * A background run asked for approval of an app action (restart, shut down): say once what is waiting and that a
   * yes is needed, bound to the task. The existing short, fresh, speaker-checked yes answers it. Write and exec
   * tool approvals stay on the screen only. `again` asks the one reminder the policy allows.
   */
  private voiceBrainApproval(again = false) {
    const waiting = brain.getSnapshot().approval;
    if (!waiting || typeof waiting.at !== "number") return;
    if (!appControlNeedsApproval(waiting.tool)) {
      this.noteScreenOnlyApproval(waiting);
      return;
    }
    if (again ? this.approvalVoicedAt !== waiting.at : this.approvalVoicedAt === waiting.at) return;
    const run = brain.getSnapshot().runs.find((row) => row.id === waiting.runId);
    const taskId = run?.owner?.kind === "task" ? run.owner.taskId : "";
    const task = taskId ? this.deskTask(taskId) : undefined;
    if (!task) return;
    this.approvalVoicedAt = waiting.at;
    const what = speakableLabel((waiting.reason.split(" — ")[0] ?? "").trim());
    this.narrateEvent(
      { kind: "needs-approval", taskId: task.id, ...(what ? { label: what } : {}) },
      this.narrationCtx(this.taskIsSensitive(task)),
      task,
    );
  }

  /** The approval (by its time) whose "needs your tap on screen" line was already said. */
  private screenApprovalAt = 0;

  /**
   * An approval that can only be answered on the screen (a tool step of the owner's own turn, not a voiced prompt):
   * one short line says so, once, so the owner is not left waiting on a silent prompt. It never opens a yes: the
   * spoken yes is bound to a prompt that really sounded, and this one never does.
   */
  private noteScreenOnlyApproval(waiting: { at?: number; runId: string }) {
    if (typeof waiting.at !== "number" || this.screenApprovalAt === waiting.at) return;
    const run = brain.getSnapshot().runs.find((row) => row.id === waiting.runId);
    // A background task's approval is announced by the task desk; only the owner's own turn is said here.
    if (!run || run.owner?.kind === "task") return;
    this.screenApprovalAt = waiting.at;
    const line =
      this.narrationLang() === "hi"
        ? "Is ke liye aapka tap screen par chahiye."
        : "That needs your tap on screen.";
    this.caption("friday", line);
    this.speak(line);
  }

  /** The task's own words, its result or its error look private: it is announced without them. */
  private taskIsSensitive(task: VoiceTask): boolean {
    return [task.label, task.result, task.error].some((text) => looksSensitive(text ?? ""));
  }

  private narrateEvent(event: NarrateEvent, ctx: Parameters<typeof narrate>[1], task?: VoiceTask) {
    const out = narrate(event, ctx);
    const prefs = this.taskPrefs();
    if (out.screenOnly) this.caption("friday", out.screenOnly);
    if (out.notify)
      notifications.push({
        id: `voice-task:${task?.id ?? "x"}:approval`,
        level: "action",
        title: "A task needs your yes",
        detail: out.notify,
        source: "Voice tasks",
        route: "/tasks",
      });
    if (out.say) {
      let say = out.say;
      const done = event.kind === "done";
      if (done && !ctx.sensitive) {
        // The first words of a finish say which task it was: "Done: X. <its first sentence>".
        const name = speakableLabel(task?.label ?? "");
        if (name && !say.toLowerCase().includes(name.toLowerCase())) say = `Done: ${name}. ${say}`;
      } else if (event.kind === "ack" && !ctx.sensitive) {
        // The owner's own acknowledgement keeps its plain words and goes out as a direct line.
        const name = speakableLabel(task?.label ?? "");
        if (name) say = `Started: ${name}.`;
      }
      if (done && !prefs.speakDone) {
        this.caption("friday", say);
      } else {
        const priority: SpeechPriority =
          event.kind === "ack" ? "direct" : (out.priority ?? "progress");
        this.announceTask(say, {
          priority,
          ...(task ? { taskId: task.id } : {}),
          ...(priority === "progress" && task ? { coalesceKey: `progress:${task.id}` } : {}),
          ...(ctx.sensitive ? { sensitive: true } : {}),
          ...(out.done ? { done: true } : {}),
          ...(out.whisper ? { whisper: true } : {}),
        });
        if (task) setTaskFocus(task.id);
      }
    }
    if (event.kind === "done" || event.kind === "failed") {
      narrate({ kind: "settled", taskId: event.taskId }, ctx);
    }
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
    this.shadowTurn((a) => a.control("wake", Date.now()));
    this.awakeUntil = Date.now() + AWAKE_MS();
    this.state.awake = true;
    if (this.awakeTimer) window.clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => {
      if (Date.now() >= this.awakeUntil) {
        this.state.awake = false;
        this.state.status = this.state.pending
          ? this.line("waiting-confirm")
          : stateLabel(this.state.voiceState);
        this.emit();
      }
    }, AWAKE_MS() + 200);
  }

  private handleHeard(text: string, probe: WakeProbe | null = null) {
    // The final transcript ends this turn's provisional stream: the next utterance may draft once more.
    this.draftsThisTurn = 0;
    // A transcript that finished a moment after Stop everything was thrown is not a turn.
    if (this.stopped()) {
      this.trace("dropped", "Stop everything is on");
      this.state.interim = "";
      this.emit();
      return;
    }
    // The words as heard, before any rewrite: a yes is refused when they say no (yesRefusal).
    const raw = this.heardRaw;
    this.heardRawLines = raw && raw !== text ? [text, raw] : [text];
    // The room tags of this final are spent here, so a later line never reads another turn's scene.
    const room = this.addressFacts;
    this.addressFacts = null;
    const sinceLastTurnMs = this.lastOwnerAt > 0 ? Date.now() - this.lastOwnerAt : null;
    this.lastOwnerAt = Date.now();
    // Noise gate: the recogniser sometimes turns a cough, a keyboard or the TV
    // into a one or two word "command". Anything short that the signal-level
    // VAD never classified as speech is dropped instead of acted on.
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words >= 2) this.lastOwnerLine = text;
    this.trace("transcript", text.slice(0, 160));
    // The owner's saved voice (only when one is built): "only answer my voice" drops what clearly is not them,
    // and their own "Friday" recordings can wake her when the transcript wrote the word differently.
    const earlyWake = matchWakeWord(text, wakeWord()).matched;
    const voiceTurn = voiceTurnGate({
      voice: this.turnVoice,
      settings: this.voiceSettings(),
      transcriptWake: earlyWake,
      isStop: this.isStopHeard(text, earlyWake),
      words,
    });
    this.turnPersonalWake = voiceTurn.personalWake;
    if (voiceTurn.ignore) {
      this.trace("dropped", voiceTurn.reason);
      markTurnStage("routed", false, voiceTurn.reason);
      this.remember("other-voice", text, "ignored");
      this.state.interim = "";
      this.emit();
      return;
    }
    // "Stop everything" is the kill switch before it is an answer: the no-words hold stop, roko and band, so an open
    // read-back, approval or confirmation below would otherwise take it as a "no" and the switch would never be thrown.
    if (this.stopAllHeard(text)) return;
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
    if (/\bnot\b.+\bbut\b/i.test(text)) learnCorrection(text, corrected);
    noteArc({
      topic: corrected.slice(0, 120),
      feeling: heardLang,
      at: Date.now(),
      source: "voice",
    });
    text = corrected;
    this.state.heard = text.slice(0, 160);

    // She read the words back and is waiting: a yes goes ahead with them, a no drops them, anything else is a new request.
    const readBack = this.pendingHeard;
    this.pendingHeard = null;
    if (readBack && Date.now() - readBack.at <= (readBack.ttlMs ?? HEARD_CONFIRM_MS)) {
      if (
        isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes") &&
        this.yesRefusal(null, room) === null
      ) {
        this.caption("user", text);
        this.remember("heard-confirmed", readBack.command, "owner confirmed the read-back");
        // A yes confirms what was HEARD. A consequential command still has to be approved as an action. The command
        // replays with the hints it was heard with, minus the doubt the read-back already settled; the yes's own
        // language and score never speak for it.
        const heardWith = readBack.turn
          ? { ...readBack.turn, confidence: null, clipped: false }
          : undefined;
        const priorReplay = this.replayTurn;
        this.replayTurn = { hints: heardWith };
        try {
          this.routeCommand(readBack.command);
        } finally {
          this.replayTurn = priorReplay;
        }
        return;
      }
      if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "no")) {
        const again =
          languageId(readBack.command) === "en" ? "Okay, say it again." : "Theek hai, dobara bolo.";
        this.caption("user", text);
        this.caption("friday", again);
        this.state.status = this.line("listening");
        this.emit();
        this.speak(again);
        return;
      }
    }

    // An app-control approval (restart, shut down) is answered by a short bound yes or no that is still fresh.
    // The router reads the words; it never approves: the approval below still needs the speaker check. The yes is
    // bound to the prompt that really sounded (never to the moment the approval was made or queued), and to a run
    // that is still waiting: a prompt held back by a call or quiet hours, or one for a run that was stopped, can
    // only be answered on the screen.
    const waiting = brain.state.approval;
    if (waiting && appControlNeedsApproval(waiting.tool) && typeof waiting.at === "number") {
      const live = brain.getSnapshot();
      const run = live.runs.find((row) => row.id === waiting.runId);
      const taskId = run?.owner?.kind === "task" ? run.owner.taskId : undefined;
      const spoken = this.approvalSpoken;
      // Only this run's own prompt binds a yes: a foreground approval is never voiced, so it stays on the screen.
      const heardPrompt =
        spoken !== null &&
        taskId !== undefined &&
        spoken.at >= waiting.at &&
        spoken.taskId === taskId &&
        spoken.ended !== false;
      const answer = this.routeHeard(text, {
        askedAt: heardPrompt && spoken ? spoken.at : waiting.at,
        ...(taskId ? { taskId } : {}),
      });
      if (answer.kind === "chitchat" && answer.reason === "approval-expired") {
        const line = "That approval timed out. Ask me again if you still want it.";
        this.caption("user", text);
        this.caption("friday", line);
        this.emit();
        this.speak(line);
        return;
      }
      if (answer.kind === "approval-answer") {
        if (answer.verdict === "yes" && !this.approvalVoiceAllows(text)) return;
        const refusal =
          answer.verdict === "yes" && heardPrompt && spoken
            ? this.yesRefusal(spoken.at, room)
            : null;
        if (refusal) {
          this.refuseYes(text, refusal, taskId);
          return;
        }
        const stillWaiting =
          run !== undefined && live.activeRunId === run.id && run.state === "awaiting-approval";
        // A no is always safe to take; a yes needs the prompt to have sounded and the run to still wait.
        if (!stillWaiting || (answer.verdict === "yes" && !heardPrompt)) {
          const line = stillWaiting
            ? "Check the screen. That one needs your answer there."
            : "That one is no longer waiting.";
          this.caption("user", text);
          this.caption("friday", line);
          this.emit();
          this.speak(line);
          return;
        }
        brain.approve(answer.verdict === "yes");
        this.approvalAsked = null;
        this.caption("user", text);
        this.caption("friday", answer.verdict === "yes" ? "Approved." : "Cancelled.");
        this.emit();
        return;
      }
    }

    // 1. A consequential command is waiting for a yes/no.
    if (this.state.pending) {
      // The window counts from the end of the read-back, not from the moment the digest was built.
      const lapsed = this.state.pending;
      const lapsedAsk = this.soundedDigest(
        lapsed.digest ?? this.confirmDigestFor(lapsed.command, lapsed.at),
      );
      if (!approvalFresh(lapsedAsk.askedAt, Date.now(), this.approvalTtl())) {
        this.state.pending = null;
        this.supersedeOnConfirm = null;
        this.remember("approval-expired", text, "dropped");
        const expired = this.variedLine("expired", text);
        this.caption("friday", expired);
        this.state.status = this.line("confirm-expired");
        this.emit();
        this.speak(expired);
        // Said once. A bare yes or no then binds to nothing; any other line is heard as the new line it is.
        if (confirmationVerdict(text) !== "unclear") return;
      }
    }
    if (this.state.pending) {
      const open = this.state.pending;
      const asked = this.soundedDigest(open.digest ?? this.confirmDigestFor(open.command, open.at));
      // The answer is judged against the digest she read: her own played-back words, a claim of authority, a yes
      // that names another amount or person, or a doubtful yes to a full read-back never approve. Who said it is
      // not an input here; the saved voice can only refuse a yes afterwards (approvalVoiceAllows).
      const pending = open;
      const digest = pending.digest ?? asked;
      const band = this.heardEar?.asrBand ?? null;
      const ruling = explainDigestAnswer(this.soundedDigest(digest), text, Date.now(), {
        ownPlayback: this.ownPlaybackHeard(text),
        ...(band ? { asrBand: band } : {}),
      });
      if (ruling.reason === "self-echo") {
        this.trace("dropped", "her own read-back is not an answer");
        this.emit();
        return;
      }
      if (typeof ruling.answer === "object") {
        this.correctPending(pending, ruling.answer.digest, text);
        return;
      }
      if (
        ruling.answer === "unclear" &&
        (ruling.reason === "mismatch" || ruling.reason === "low-asr")
      ) {
        this.reaskDigest(digest, text, ruling.reason);
        return;
      }
      if (
        ruling.answer === "yes" &&
        isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")
      ) {
        if (this.answeredBefore(digest)) {
          this.reaskDigest(digest, text, "older yes");
          return;
        }
        // A no in the words as heard, or a TV, music or other voice in the room: never a yes to this digest.
        const refusal = this.yesRefusal(null, room);
        if (refusal) {
          this.reaskDigest(digest, text, refusal);
          return;
        }
        if (!this.approvalVoiceAllows(text)) return;
        const cmd = this.state.pending.command;
        const cmdHints = this.state.pending.hints;
        this.state.pending = null;
        this.to("confirm-resolved");
        this.remember("confirmed", text, cmd);
        this.caption("user", text);
        this.state.status = this.line("confirmed");
        this.emit();
        this.runApproved(cmd, cmdHints);
        return;
      }
      // A no is always safe to take, bound or not; a second correction is a no too.
      if (ruling.answer === "no" || confirmationVerdict(text) === "no") {
        this.state.pending = null;
        this.supersedeOnConfirm = null;
        this.caption("user", text);
        const dropped = this.variedLine("cancelled", text);
        this.caption("friday", dropped);
        this.state.status = this.line("cancelled");
        this.emit();
        this.speak(dropped);
        return;
      }
      // A command that carries the wake word is a new request: the open confirmation is cancelled and the line is
      // heard as usual (a yes still binds only to the read-back above). Anything else is not an answer: one short
      // nudge, not repeated line after line, and none under a TV, music or another voice.
      const wakeNow = matchWakeWord(text, wakeWord());
      if (wakeNow.matched && wakeNow.command.trim()) {
        this.state.pending = null;
        this.supersedeOnConfirm = null;
        this.remember("approval-cancelled", text, "a new command replaced the open confirmation");
        this.caption("friday", "Cancelled that.");
      } else {
        const roomNoise =
          room?.scene?.kind === "tv" || room?.scene?.kind === "music" || room?.speaker === "other";
        if (!roomNoise && Date.now() - this.lastStillWaitingAt > STILL_WAITING_GAP_MS) {
          this.lastStillWaitingAt = Date.now();
          const nudge = "Still waiting for yes or no.";
          this.caption("friday", nudge);
          this.speak(nudge);
        }
        this.emit();
        return;
      }
    }

    if (this.stagedSettingsGate(text, room)) return;

    // openWakeWord is the ACTIVE detector whenever it really ran on this clip;
    // the transcript matcher stays as the documented fallback (and still does
    // the work of splitting the wake word off the command).
    const transcriptWake = matchWakeWord(text, wakeWord());
    // Either detector waking FRIDAY is enough. openWakeWord scores raw audio
    // and can miss a clearly spoken name (weak or missing model); the
    // transcript matcher is a real, equal detection path, not a consolation
    // prize — so a name that is visible in the transcript always counts.
    const heardWake = Boolean(probe?.detected) || transcriptWake.matched || this.turnPersonalWake;
    // The hands-free gates rule on a wake word that was heard (cooldown, her own voice, speech before it).
    const guardAllows = heardWake ? this.wakeGuardAllows(text) : true;
    // In hands-free a refused wake still names her: the "Friday," prefix is stripped from the command text.
    const matched = heardWake && (guardAllows || this.state.handsFree);
    const wake = {
      matched,
      command: transcriptWake.command,
      detail: probe
        ? transcriptWake.matched && !probe.detected
          ? `${probe.detail} · transcript matched "${transcriptWake.token}"`
          : probe.detail
        : this.turnPersonalWake
          ? `your own "${wakeWord()}" recording matched (distance ${this.turnVoice?.wake?.distance ?? "?"})`
          : transcriptWake.detail,
    };
    this.state.lastWake = {
      engine: probe?.detected ? probe.engine : this.turnPersonalWake ? "personal" : "transcript",
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
    const decision = this.addressingFor(text);
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
      if (wake.matched) this.reportFalseWake();
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
      this.micAllowed() &&
      (voiceNotes.active() || this.translateTo)
    ) {
      const line = (wake.matched && wake.command ? wake.command : text).trim();
      if (this.handleNoteSpeech(line, wake.matched)) return;
    }
    const awake = Date.now() < this.awakeUntil;
    const stop = this.isStopHeard(text, wake.matched);
    const held =
      !stop &&
      decision.answer &&
      (this.heldForWake(wake.matched) ||
        this.addressednessAddsWake(text, wake.matched, room, sinceLastTurnMs));
    if (held) voiceGate.wake.noteHeldTurn(performance.now());
    const accepted = this.micAllowed() && (stop || (decision.answer && decision.tools && !held));
    this.trace(
      "wake",
      wake.matched
        ? wake.detail
        : accepted
          ? awake
            ? "already awake — no wake word needed"
            : "hands-free — treated as a request"
          : held
            ? "other voice or TV tagged, no wake word: held as ambient"
            : "no wake word, not awake, not a hands-free turn",
    );
    if (accepted) this.liveWakeAt = 0; // a live wake covers one line, then it is spent
    // While she speaks, a quietening verb (stop, mute, pause, quieter) needs no wake word; a held line, or one heard
    // over a TV or music scene, never acts.
    const roomPlays = room?.scene?.kind === "tv" || room?.scene?.kind === "music";
    if (!accepted && !held && !roomPlays && this.micAllowed() && this.commandLaneTakes(text, false))
      return;
    if (!accepted) {
      markTurnStage(
        "routed",
        false,
        this.micAllowed()
          ? `not meant for FRIDAY (${decision.tag}${decision.reason ? `: ${decision.reason}` : ""})`
          : "listening is paused or not in Auto mode",
      );
      this.to("wake-missed");
      this.state.status = this.idleLine();
      this.emit();
      return;
    }
    const heardCommand = (wake.matched ? wake.command : text).trim();
    let command = heardCommand;
    if (wake.matched && !command && wakeOnCooldown(Date.now(), this.lastWakeAt)) {
      this.trace("dropped", "wake word repeated inside the cooldown");
      markTurnStage("routed", false, "wake word repeated inside the cooldown");
      this.remember("wake-cooldown", text, "dropped");
      this.emit();
      return;
    }
    if (wake.matched) this.lastWakeAt = Date.now();
    // A yes after the wake word ("hey Friday yes") is a spoken yes all the same: the staged-settings gate rules on the
    // command left after the split, so a change that needs the screen never reaches the Brain by voice.
    if (wake.matched && command && this.stagedSettingsGate(command, room)) return;
    this.turnClock = { ...this.turnClock, finalAt: Date.now() };
    this.turnStages.mark("sttFinalReceived");
    this.turnStages.mark("brainRequestStarted");
    this.to("wake-matched");
    // A spoken self-repair ("do nahi nahi teen") acts on the repaired line; the raw words stay in the transcript and
    // the audit. A repair that changes a number, a name, a target or a consequential order is read back first.
    if (command) {
      const repair = this.selfRepairOf(command, text);
      if (repair === "asked") return;
      if (repair) command = repair;
    }
    // One router names what this line is for (see utterance-router). It reads, it never acts: a yes it finds is
    // only an answer, and the approval paths below decide. Task words act on tasks, a plain stop never does.
    const route = this.routeHeard(command || text, this.approvalAsked);
    if (route.kind === "chitchat" && route.reason === "approval-expired") {
      this.approvalAsked = null;
      const line = "That approval timed out. Ask me again if you still want it.";
      this.caption("friday", line);
      this.state.status = this.line("approval-expired");
      this.emit();
      this.speak(line);
      return;
    }
    if (route.kind === "approval-answer" && this.answerRestartAsk(text, route, room)) return;
    if (route.kind === "approval-answer" && this.answerTaskApprovalAloud(text, route, room)) return;
    if (route.kind === "task-control" || (route.kind === "status" && this.liveTasks() > 0)) {
      this.trace("wake", `task control — ${route.action ?? route.kind} (${route.reason})`);
      markTurnStage("routed", true, "", "task control");
      this.approvalAsked = null;
      const said = this.runTaskRoute(route);
      if (said) this.speak(said);
      this.state.status = this.line("listening");
      this.emit();
      return;
    }
    // "Do this in the background": the work becomes a voice task that runs the real Brain turn; the answer is
    // announced when it finishes. A consequential one is asked about first; a change of mind replaces the task.
    const background =
      route.kind === "new-task"
        ? parseBackgroundRequest(
            route.supersedes ? withoutChangeOfMind(command || text) : command || text,
          )
        : null;
    if (background && this.state.mode === "auto") {
      this.trace("wake", "background request — started as a voice task");
      markTurnStage("routed", true, "", "background task");
      this.approvalAsked = null;
      if (route.needsConfirm || this.needsConfirm(command || text)) {
        // The old task keeps running until the owner says yes: a change of mind that is never confirmed changes nothing.
        const ordered = route.supersedes ? withoutChangeOfMind(command || text) : command || text;
        this.askToConfirm(ordered);
        if (route.supersedes) {
          this.supersedeOnConfirm = { id: route.supersedes, command: ordered, at: Date.now() };
        }
        return;
      }
      if (route.supersedes) voiceTaskActions.cancel(route.supersedes);
      this.beginBackground(background);
      return;
    }
    // Voice notes, meeting notes and live translation: only on the owner's words, shown while they run.
    if (this.handleNoteSpeech(command || text)) return;
    // "FRIDAY, stop" is an interruption, never a task: cut the reply short and
    // go straight back to listening instead of sending "stop" to the brain.
    if (this.isStopHeard(text, wake.matched)) {
      this.trace("wake", "stop word — cancelling speech and the in-flight turn");
      this.queuedCommands = [];
      this.queuedHints.clear();
      this.stopQueueTimer();
      markTurnStage("routed", true, "", "stop word");
      this.cancelSpeech();
      if (route.stopListening) {
        // "Stop listening" also ends the attention window: the next line needs her name again.
        this.awakeUntil = 0;
        this.followUpUntil = 0;
        this.state.awake = false;
      }
      this.state.status = this.line("stopped-listening");
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
      this.expectCommandAfterWake();
      const ready = this.variedLine("wake", text);
      this.caption("friday", ready);
      this.state.status = this.line("awake");
      this.emit();
      this.speak(ready);
      return;
    }
    // A command arrived: the wake was real, the follow-up window (if open) is used, and the turn goes to the brain.
    const turnAt = performance.now();
    if (!wake.matched) voiceGate.wake.followUpSpeech(turnAt);
    voiceGate.wake.turnAccepted(turnAt);
    this.wakeAwaitingCommand = false;
    if (this.wakeFalseTimer) clearTimeout(this.wakeFalseTimer);
    this.wakeFalseTimer = null;
    const lastCaption = this.state.captions[this.state.captions.length - 1];
    // The transcript keeps what was said: a self-repair shows the raw line, the repaired one goes on.
    const shown = this.tidyShown(heardCommand);
    if (!(
      lastCaption?.who === "user" &&
      (lastCaption.text.includes(heardCommand) || lastCaption.text.includes(shown.text))
    )) {
      this.caption("user", shown.text, false, {
        tag: "addressed",
        ...(shown.tidy ? { tidy: shown.tidy } : {}),
      });
    }

    // A fluent sentence is not proof it was said, but she asks only when the speech model was clearly unsure AND a wrong
    // guess would cost something (see heardNeedsReadBack). A harmless line goes straight on, a dangerous one gets the one
    // action question below (which names what she heard), and she never reads back twice in a row. A stop is never held up.
    const isStop = this.isStopHeard(command, wake.matched);
    const sensitive =
      route.needsConfirm === true || voiceClaimsAuthority(command) || this.needsConfirm(command);
    const doubtful = heardNeedsReadBack(
      command,
      this.lastHeardQuality,
      isStop,
      this.confirmPreference(),
    );
    const askedLately = Date.now() - this.lastReadBackAt < READBACK_COOLDOWN_MS;
    if (this.lastHeardQuality) {
      const trust = heardConfidence(command, this.lastHeardQuality);
      const scores = `token ${this.lastHeardQuality.avgLogprob ?? "?"}, language ${this.lastHeardQuality.languageProbability ?? "?"}`;
      this.trace(
        "segment",
        `heard trust ${trust.toFixed(2)} (${scores}) — ${
          doubtful
            ? sensitive
              ? "doubtful, one action question"
              : askedLately
                ? "doubtful, asked a moment ago"
                : "doubtful, read back"
            : "trusted"
        }`,
      );
    }
    if (doubtful && !sensitive && !askedLately) {
      const ask = heardQuestion(command);
      this.pendingHeard = { command, at: Date.now() };
      // The hints this command was heard with go with it, so a later yes cannot speak for it (see replayWith).
      const heardTurn = this.turnHints();
      if (heardTurn) this.pendingHeard.turn = heardTurn;
      this.lastReadBackAt = Date.now();
      markTurnStage("routed", false, "read back — waiting for a yes");
      this.trace("segment", `unsure of "${command.slice(0, 80)}" — read back, waiting for a yes`);
      this.caption("friday", ask);
      this.state.status = this.line("waiting-yesno");
      this.emit();
      this.speak(ask);
      return;
    }

    // The closed-vocabulary command lane (stop, mute, open a known name) answers without the Brain; a miss falls
    // through. A doubtful line was read back above with the words as heard, before any snap.
    if (this.commandLaneTakes(command, true)) return;
    this.ackTurnKind = route.kind;
    this.routeCommand(command, route.kind === "new-task" && route.needsConfirm === true);
  }

  /** How many desk tasks have not finished. */
  private liveTasks(): number {
    return routerTasks().filter((t) => !TERMINAL.includes(t.state)).length;
  }

  /** What one line the owner just said is for, read from the desk, the Brain and the prompt she last spoke. */
  private routeHeard(
    text: string,
    asked: { askedAt: number; taskId?: string } | null = this.approvalAsked,
  ): Route {
    const tasks = routerTasks();
    return routeUtterance({
      text,
      now: Date.now(),
      tasks,
      pendingApproval: asked
        ? { askedAt: asked.askedAt, ...(asked.taskId ? { taskId: asked.taskId } : {}) }
        : null,
      focusTaskId: taskFocusId(),
      approvalLevel: this.confirmDial(),
      approvalTtlMs: this.approvalTtl(),
      busy:
        Boolean(brain.getSnapshot().activeRunId) || tasks.some((t) => !TERMINAL.includes(t.state)),
    });
  }

  /**
   * The addressedness gate on a final with no wake word: a TV or music scene, another voice, narration, a doubtful
   * decode, a long run of speech or a stale conversation may ADD a wake requirement (see addressedness.ts). It never
   * lowers one, never accepts and never approves: the base rule here is "no wake needed", so only an added one holds.
   */
  private addressednessAddsWake(
    text: string,
    wakeMatched: boolean,
    room: AddressFacts | null,
    sinceLastTurnMs: number | null,
  ): boolean {
    if (wakeMatched || this.listenStyle() === "push-to-talk") return false;
    const now = Date.now();
    const verdict = judgeAddressedness({
      text,
      lang: this.turnHints()?.lang ?? "",
      baseRequireWake: false,
      wakeHeard: false,
      // A follow-up is her own open question or a live wake; the hands-free attention window is not one.
      followUp: now < this.followUpUntil || now - this.liveWakeAt < LIVE_WAKE_MS,
      expectingAnswer: Boolean(this.state.pending || this.approvalAsked || this.restartAsk),
      handsFree: this.state.handsFree,
      ...(room?.scene ? { scene: room.scene } : {}),
      ...(room?.speaker ? { speaker: room.speaker } : {}),
      asrLogProb: this.lastHeardQuality?.avgLogprob ?? null,
      sinceLastTurnMs,
      speechMs: this.lastSpeechMs,
    });
    if (verdict.requireWake)
      this.trace(
        "wake",
        `addressedness ${verdict.addressed} (${verdict.reasons.join(", ")}): wake word required`,
      );
    return verdict.requireWake;
  }

  /**
   * A mid-sentence self-repair (`voice.understanding.selfRepair`, on by default): the repaired line, or "asked" when
   * the repair is consequential and was read back (a fresh yes then routes the repaired line through every check),
   * or null when there is none. The raw words go to the audit with one repair line.
   */
  private selfRepairOf(command: string, heard: string): string | "asked" | null {
    if (!preferences.getSnapshot().voice.understanding.selfRepair) return null;
    // A question she asked is open: "no, I mean yes" is an answer as heard, never repaired into a yes or a no.
    if (this.turnExpect() === "yesno") return null;
    const lang = this.turnHints()?.lang;
    // The wake split folds case; the same words as heard keep a name a name ("Rahul I mean Rohan").
    const words = heard.trim().split(/\s+/);
    const tail = words.slice(-command.split(/\s+/).length).join(" ");
    const cased = normalizeTranscript(tail) === command ? tail : command;
    const repair = detectSelfRepair(cased, lang ? { lang } : {});
    if (!repair || !repair.repaired.trim()) return null;
    // A repair that leaves a yes or a no is not a repair: the line is judged as said.
    if (confirmationVerdict(repair.repaired) !== "unclear") return null;
    const audit = repairAuditLine(repair);
    this.trace("segment", audit);
    this.remember("self-repair", repair.raw, audit);
    if (!repair.consequential || !repair.readBack) return repair.repaired;
    const heardTurn = this.turnHints();
    this.pendingHeard = {
      command: repair.repaired,
      at: Date.now(),
      ttlMs: this.approvalTtl(),
      ...(heardTurn ? { turn: heardTurn } : {}),
    };
    this.lastReadBackAt = Date.now();
    markTurnStage("routed", false, "self-repair read back — waiting for a yes");
    this.caption("user", repair.raw);
    this.caption("friday", repair.readBack);
    this.state.status = this.line("waiting-yesno");
    this.emit();
    this.speak(repair.readBack);
    return "asked";
  }

  /**
   * The names the command lane may open, and the ear's hint list. The owner's dictionary (Settings > Voice) is the
   * one list of names kept on this side; each entry is its own name.
   */
  private commandRegistry(): CommandRegistryEntry[] {
    return parseVocabulary(preferences.getSnapshot().voice.vocabulary).map((name) => ({
      id: `vocabulary:${name.toLocaleLowerCase()}`,
      names: [name],
    }));
  }

  /**
   * The closed-vocabulary command lane (`voice.understanding.commandLane`, on by default), before the Brain. True
   * when it answered the line. An `addressed` line (wake word, attention window, hands-free) may take any lane verb;
   * an unaddressed one only a quietening verb while she speaks. A miss, or a verb the conduct path owns (pause,
   * volume), falls through. An open is never run here: a snapped name goes through the same risk and approval path,
   * and a snap to a consequential name is read back and waits for a fresh yes inside the approval window.
   */
  private commandLaneTakes(line: string, addressed: boolean): boolean {
    if (!preferences.getSnapshot().voice.understanding.commandLane) return false;
    const started = performance.now();
    const lang = this.turnHints()?.lang;
    const lane = routeCommandLane({
      text: line,
      partial: false,
      ctx: {
        registry: this.commandRegistry(),
        ...(lang ? { lang: lang === "hi-en" ? ("hinglish" as const) : lang } : {}),
      },
      speakingNow: this.state.speaking,
      handsFree: addressed && this.state.handsFree,
      wakeHeard: addressed,
    });
    if (lane.route !== "command" || !lane.command) return false;
    const took = this.runLaneCommand(lane.command);
    if (took)
      this.trace(
        "wake",
        `command lane — ${lane.command.command} (${lane.reason}, ${Math.round(performance.now() - started)} ms)`,
      );
    return took;
  }

  private runLaneCommand(hit: CommandHit): boolean {
    const en = this.narrationLang() !== "hi";
    switch (hit.command) {
      case "stop-all":
        markTurnStage("routed", true, "", "command lane stop-all");
        this.sayStopLine(stopEverythingFromVoice());
        return true;
      case "stop":
        this.queuedCommands = [];
        this.queuedHints.clear();
        this.stopQueueTimer();
        markTurnStage("routed", true, "", "command lane stop");
        this.cancelSpeech();
        this.state.status = this.line("stopped-listening");
        this.emit();
        return true;
      case "mute":
      case "unmute":
        markTurnStage("routed", true, "", `command lane ${hit.command}`);
        this.setMuted(hit.command === "mute");
        return true;
      case "open": {
        const target = hit.args?.target?.trim();
        if (!target) return false;
        const command = `open ${target}`;
        if (hit.readBack) {
          const ask = en ? `Open ${target}? Yes or no.` : `${target} kholun? Haan ya na.`;
          const heardTurn = this.turnHints();
          this.pendingHeard = {
            command,
            at: Date.now(),
            ttlMs: this.approvalTtl(),
            ...(heardTurn ? { turn: heardTurn } : {}),
          };
          this.lastReadBackAt = Date.now();
          markTurnStage("routed", false, "command lane read back — waiting for a yes");
          this.caption("friday", ask);
          this.state.status = this.line("waiting-yesno");
          this.emit();
          this.speak(ask);
          return true;
        }
        this.ackTurnKind = "control";
        this.routeCommand(command);
        return true;
      }
      default:
        return false;
    }
  }

  /** How often she asks first: the autonomy dial, adjusted by the owner's own `voice.confirmLevel` (rare when absent). */
  private confirmDial(): ReturnType<typeof effectiveConfirmLevel> {
    return effectiveConfirmLevel(autonomy.getSnapshot().approvalLevel, this.confirmPreference());
  }

  private confirmPreference(): unknown {
    return (preferences.getSnapshot().voice as unknown as Record<string, unknown>)["confirmLevel"];
  }

  /** Must this order be confirmed before it runs? Manual always; Auto by what the order is (see voiceNeedsConfirmation). */
  private needsConfirm(command: string): boolean {
    return this.state.mode === "manual" || voiceNeedsConfirmation(command, this.confirmDial());
  }

  /** A task word or a status question: act on the desk and return the one line to say. */
  private runTaskRoute(route: Route): string | null {
    const lang = this.narrationLang();
    if (route.kind === "status") return taskStatusLine(lang);
    if (route.action === "repeat" && !route.ref && !route.ambiguous) {
      return (
        this.spokenText.trim() ||
        (lang === "hi" ? "Dohrane ko kuch nahi hai." : "I have nothing to repeat.")
      );
    }
    return applyTaskRoute(route, lang);
  }

  /** A bound yes or no to a desk task that asked for approval. The speaker check still applies to a yes. */
  private answerTaskApprovalAloud(
    text: string,
    route: Route,
    room: AddressFacts | null = null,
  ): boolean {
    const id = route.ref && "taskId" in route.ref ? route.ref.taskId : "";
    const waiting = id
      ? routerTasks().find((t) => t.id === id && t.state === "WAITING_FOR_APPROVAL")
      : undefined;
    if (!waiting || !route.verdict) {
      this.approvalAsked = null;
      return false;
    }
    if (route.verdict === "yes" && this.approvalAsked) {
      const refusal = this.yesRefusal(this.promptEndsAt(waiting.id), room);
      if (refusal) {
        this.refuseYes(text, refusal, waiting.id);
        return true;
      }
    }
    if (route.verdict === "yes" && !this.approvalVoiceAllows(text)) return true;
    this.approvalAsked = null;
    voiceTaskActions.approve(waiting.id, route.verdict === "yes");
    this.caption("user", text);
    this.state.status = this.line("listening");
    this.emit();
    return true;
  }

  /** Ask before a consequential order runs. Speech never approves itself: only a fresh bound yes does. */
  private askToConfirm(command: string) {
    this.ackTurnKind = "control";
    this.supersedeOnConfirm = null;
    this.discardEager();
    const hints = this.turnHints();
    const at = Date.now();
    const digest = this.confirmDigestFor(command, at);
    this.state.pending = {
      command,
      reason: approvalReason("exec", this.state.mode),
      at,
      ...(hints ? { hints } : {}),
      digest,
    };
    const ask = this.digestAsk(digest, command);
    this.noteAskSounding(digest, ask);
    this.caption("friday", ask);
    this.to("confirm-required");
    this.state.status = this.line("waiting-confirm");
    this.emit();
    this.speak(ask, { priority: "approval" });
    this.remember("needs-approval", command, "paused");
  }

  /** The digest of an order she asks about, with the owner's yes window (`voice.approvalTtlSec`, 10-60 s). */
  private confirmDigestFor(command: string, at: number): ConfirmDigest {
    return buildConfirmDigest({
      command,
      turnId: this.heardTurnId,
      now: at,
      ttlSec: preferences.getSnapshot().voice.approvalTtlSec,
      kind: voiceConfirmKind(command),
    });
  }

  /**
   * What she asks. A digest that names where or how much (an amount, a person, a place) is read in full; any other
   * order keeps the short question, which already says what will be done.
   */
  private digestAsk(digest: ConfirmDigest, command: string): string {
    const full = digest.mode === "explicit" && Boolean(digest.amount || digest.target);
    return full ? confirmDigestLine(digest) : confirmQuestion(command);
  }

  /**
   * A yes that began before this digest was asked answers an older question (one she has since corrected), never
   * this one. Known only for a turn the ear framed; a turn without that timing is judged on its words alone.
   */
  private answeredBefore(digest: ConfirmDigest): boolean {
    // Against a full read-back whose end is known, an unknown start is put early (the safe side).
    const began = this.yesBeganAt(this.askSound?.digestId === digest.id);
    const end = this.askEndsAt(digest);
    return end === Number.POSITIVE_INFINITY || (began !== null && began < end);
  }

  /**
   * Her own words coming back while her voice or its room tail can still be heard (the same window as the intake's
   * echo drop), or the acknowledgement that just sounded: never an answer. Words that repeat her prompt's own tail
   * ("say yes to confirm") are refused by the digest itself at any time.
   */
  private ownPlaybackHeard(heard: string): boolean {
    return (this.recentlySpeaking() && this.isSelfEcho(heard)) || this.ackEchoHeard(heard);
  }

  /** The command with the one field the owner corrected; null when that field is not in the words as said. */
  private correctedCommand(
    command: string,
    was: ConfirmDigest,
    next: ConfirmDigest,
  ): string | null {
    const swap = (pattern: RegExp, value: string): string | null => {
      let last: RegExpExecArray | null = null;
      for (const hit of command.matchAll(pattern)) last = hit;
      if (!last || last.index === undefined) return null;
      return `${command.slice(0, last.index)}${value}${command.slice(last.index + last[0].length)}`;
    };
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (next.target !== was.target && was.target && next.target) {
      const word = new RegExp(
        `(?<![\\p{L}\\p{M}\\p{N}])${escape(was.target)}(?![\\p{L}\\p{M}\\p{N}])`,
        "giu",
      );
      return swap(word, next.target);
    }
    if (next.amount !== was.amount && was.amount && next.amount) {
      const value = was.amount.split(" ")[0] ?? "";
      const nextValue = next.amount.split(" ")[0] ?? "";
      if (!value || !nextValue) return null;
      const number = /[\d०-९][\d०-९,]*(?:\.[\d०-९]+)?/gu;
      const same = (raw: string) =>
        raw.replace(/[०-९]/gu, (d) => String(d.charCodeAt(0) - 0x0966)).replace(/,/g, "") === value;
      let found: { index: number; length: number } | null = null;
      for (const hit of command.matchAll(number)) {
        if (hit.index !== undefined && same(hit[0]))
          found = { index: hit.index, length: hit[0].length };
      }
      if (!found) return null;
      return `${command.slice(0, found.index)}${nextValue}${command.slice(found.index + found.length)}`;
    }
    return null;
  }

  /** Read the digest again (a yes that named something else, a doubtful yes, an older yes); the window does not grow. */
  private reaskDigest(digest: ConfirmDigest, heard: string, why: string) {
    this.remember("confirm-unclear", heard, why);
    this.trace("dropped", `yes not taken (${why}): asking again`);
    this.caption("user", heard);
    if (this.digestReasked === digest.id) {
      this.emit();
      return;
    }
    this.digestReasked = digest.id;
    // The same words as the first ask; a corrected digest is always explicit, so it is read in full again.
    const ask = this.digestAsk(digest, this.state.pending?.command ?? digest.command);
    this.noteAskSounding(digest, ask);
    this.caption("friday", ask);
    this.emit();
    this.speak(ask, { priority: "approval" });
  }

  /**
   * One field of the order corrected ("no, to Rohan", "make it 500"): the command takes the new value, the new digest
   * is read in full with a fresh window, and nothing runs until a yes to it. A field that cannot be found in the
   * words as said drops the order instead of guessing.
   */
  private correctPending(pending: PendingConfirm, next: ConfirmDigest, heard: string) {
    const was = pending.digest ?? this.confirmDigestFor(pending.command, pending.at);
    const command = this.correctedCommand(pending.command, was, next);
    this.caption("user", heard);
    if (!command) {
      this.state.pending = null;
      this.supersedeOnConfirm = null;
      this.remember("confirm-corrected", heard, "dropped: the change did not fit the order");
      const dropped = {
        en: "I could not fit that change in. Say the whole order again.",
        hinglish: "Ye badlav fit nahi hua. Poora order phir se boliye.",
        hi: "यह बदलाव जुड़ नहीं पाया। पूरा आदेश फिर से बोलिए।",
      }[next.lang];
      this.caption("friday", dropped);
      this.state.status = this.line("cancelled");
      this.emit();
      this.speak(dropped);
      return;
    }
    this.state.pending = { ...pending, command, at: next.askedAt, digest: next };
    this.remember("confirm-corrected", heard, command);
    const ask = confirmDigestLine(next);
    this.noteAskSounding(next, ask);
    this.caption("friday", ask);
    this.state.status = this.line("waiting-confirm");
    this.emit();
    this.speak(ask, { priority: "approval" });
  }

  /** A confirmed command: a background one starts its task, anything else goes to the Brain. */
  private runApproved(command: string, hints?: TurnHints) {
    this.ackTurnKind = "confirm-turn";
    const sup = this.supersedeOnConfirm;
    this.supersedeOnConfirm = null;
    if (sup && sup.command === command && approvalFresh(sup.at, Date.now(), this.approvalTtl())) {
      voiceTaskActions.cancel(sup.id);
    }
    const background = this.state.mode === "auto" ? parseBackgroundRequest(command) : null;
    // The yes answered a read-back of this exact action: a single-use token carries it to the run, bound to the
    // tool and its exact arguments, so the same action is not asked a second time on screen. An order whose action
    // is not known up front (the Brain picks the tool) gets none and is asked as usual.
    const lifecycle = selfLifecycleAction(command);
    this.preApprovalToken =
      !background && lifecycle
        ? brain.preApprove(command, { tool: lifecycle.tool, args: {} })
        : null;
    // The command goes ahead with the hints it was heard with, minus the doubt the confirmation already settled: the
    // reply language follows the command, and a doubtful "haan" never makes the Brain ask "did you say ...".
    const heardWith = hints ? { ...hints, confidence: null, clipped: false } : undefined;
    try {
      this.replayWith(heardWith, () => {
        if (background) this.beginBackground(background);
        else this.dispatch(command);
      });
    } finally {
      this.preApprovalToken = null;
    }
  }

  /** The single-use token of the read-back yes being replayed (see runApproved); read by the next dispatch only. */
  private preApprovalToken: string | null = null;

  /** The work of a background task: the real Brain turn for one request. Also how a restored task runs again. */
  backgroundWork(request: string): TaskWork {
    return async (task, context) => {
      await context.checkpoint();
      const stopOnCancel = () => brain.stop({ taskId: task.id });
      context.signal.addEventListener("abort", stopOnCancel, { once: true });
      try {
        const done = await askBrain(request, {
          brain: ownedBrain(task.id),
          timeoutMs: 300_000,
        });
        await context.checkpoint();
        return completionLine(done.answer) || "Finished.";
      } finally {
        context.signal.removeEventListener("abort", stopOnCancel);
      }
    };
  }

  /** Start a voice task that runs the real Brain turn; the Brain takes one turn at a time. */
  private beginBackground(background: { label: string; request: string }) {
    const made = startVoiceTask(background.label, this.backgroundWork(background.request), "safe", {
      request: background.request,
    });
    if (!made.ok) this.speak(made.error);
    this.state.status = this.line("listening");
    this.emit();
  }

  /**
   * An addressed, understood command on its way to the Brain: continue a paused reply, held for a read-back, the
   * conduct words, a backchannel, the approval a consequential command needs, a clarifying question, or dispatch.
   * A read-back "yes" comes through here too, so confirming what was heard never approves the action itself.
   */
  private routeCommand(command: string, confirm = false) {
    if (wantsContinue(command) && this.unfinished) {
      this.discardEager();
      const rest = this.unfinished;
      this.unfinished = "";
      this.remember("continue", command, "resumed");
      this.speak(`Continuing. ${rest}`);
      return;
    }
    // A draft is taken over only after the logic below says this line goes to the brain, and only when it is the
    // same words (tidied) with privacy, paid access and approval unchanged; anything else cancels it first.
    const adopt = this.eagerAdoptable(command);
    if (!adopt) this.discardEager();
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
      this.discardEager();
      this.remember(conduct.decision, command, conduct.action);
      if (conduct.decision === "stop-everything") {
        // The same kill switch as the button; she says what it really stopped.
        this.sayStopLine(stopEverythingFromVoice());
        return;
      }
      this.caption("friday", conduct.spoken);
      this.state.status = conduct.spoken;
      this.emit();
      this.speak(conduct.spoken);
      return;
    }
    // "haan" or "hmm" while she is speaking is the owner following along: she does not talk over herself.
    if (isHoldSound(command) && this.state.speaking) {
      this.discardEager();
      this.remember("backchannel", command, "following along");
      return;
    }
    const cue = backchannel({
      hold: isHoldSound(command),
      usedThisTurn: this.backchannelUsed,
      mode: this.state.mode,
    });
    if (cue) {
      this.discardEager();
      this.backchannelUsed = true;
      this.remember("backchannel", command, "held");
      this.speak(cue);
      return;
    }

    // 2. Consequential actions, and speech that tries to rewrite the rules,
    // always get an explicit confirmation. Speech never approves itself.
    // A speaker score is an extra signal only. No saved voiceprint means
    // the line is still heard, and a match still does not run the action.
    const heardSensitive = confirm || voiceClaimsAuthority(command) || this.needsConfirm(command);
    const speaker = this.speakerVerdict(heardSensitive);
    if (!speaker.allow) {
      this.discardEager();
      const refused = this.speakerRefusal(speaker.reason);
      this.remember(
        speaker.reason === "speaker-unverified" ? "speaker-unverified" : "speaker-mismatch",
        command,
        "blocked",
      );
      this.caption("friday", refused);
      this.speak(refused);
      this.emit();
      return;
    }
    if (heardSensitive && !selfLifecycleAction(command)) {
      this.askToConfirm(command);
      return;
    }

    const clarify = clarifyPrompt(
      command,
      Date.now() < this.followUpUntil && Boolean(this.spokenText.trim()),
    );
    if (clarify) {
      this.discardEager();
      this.remember("clarify", command, "asked");
      this.caption("friday", clarify);
      this.speak(clarify);
      this.emit();
      return;
    }

    this.backchannelUsed = false;
    if (adopt) {
      // Eager adoption: the same words (tidied) as the draft, so the Brain is offered the draft's own words and
      // applies its own checks (idle, no approval, Stop everything off, privacy). The echo is counted first
      // because the adopted run's caption arrives while adoptDraft replays what the draft already heard.
      this.clearHoldLines();
      this.pendingUserEcho += 1;
      this.markTurnAccepted(command);
      if (brain.adoptDraft(this.draftId, this.speculative, this.turnHints())) {
        this.discardEager(true);
        this.remember("speculative", command, "already-started");
        this.openFollowUp();
        affect.noteVoice({ tone: this.lastTone, speechMs: this.lastSpeechMs });
        markTurnStage("routed", true, "", "draft adopted");
        this.armHoldLines(command);
        return;
      }
      // Refused (the brain moved on, privacy changed, the draft expired): an ordinary turn runs.
      this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
      this.discardEager();
    }
    this.remember("accepted", command, "dispatch");
    this.emit();
    this.dispatch(command);
  }

  /**
   * Say (and show) that a voice turn could not go through. Silence is itself a
   * bug in Auto Mode: the owner is not looking at the screen, so every failed
   * stage has to be audible as well as visible.
   */
  private reportFailure(message: string, status = "", micClass = false) {
    this.to("error");
    this.trace("error", message);
    this.state.error = `${this.plainFault(message, micClass)}\nFix voice`;
    this.state.status = status || this.line("voice-error");
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
    // After a sensitive turn or reply no follow-up window opens: what comes next needs her name again.
    if (this.turnSensitive || this.replySensitive) {
      this.followUpUntil = 0;
      return;
    }
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
    const now = Date.now();
    // The same message again is a new fault once the microphone recovered or the first report is old enough to be
    // history (a Bluetooth profile switch, another app taking the microphone); a burst of one message heals once.
    if (this.shownMicFault === message && now - this.shownMicFaultAt < MIC_FAULT_REPEAT_MS) return;
    this.soak.fault();
    this.shownMicFault = message;
    this.shownMicFaultAt = now;
    const healing = allowRestart(this.micRestarts, now);
    this.state.error = this.plainFault(message, true, healing);
    this.trace("error", message);
    if (!healing) {
      this.state.status = this.line("reset-mic");
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

  /** A turn is on its way to the Brain: the speech bookkeeping of the last reply restarts, and she is Thinking. */
  private markTurnAccepted(command = "") {
    this.turnSensitive = looksSensitive(command) || asksForSecret(command);
    this.voicedRunId = "";
    this.voicedChars = 0;
    this.voicedPrefix = "";
    this.firstClauseDue = false;
    this.to("command-accepted");
    this.state.status = this.line("thinking");
    this.emit();
  }

  /** The owner-voice origin of the heard turn when the ear tagged the owner; none for any other voice or a replay. */
  private voiceOriginOption() {
    return this.replayTurn ? {} : ownerVoiceOrigin(this.heardSpeaker);
  }

  /** The id of the heard turn, for the Brain's records; none while a stored command is replayed. */
  private turnIdOption() {
    const id = this.replayTurn ? "" : this.heardTurnId;
    return id ? { turnId: id } : {};
  }

  /**
   * The voice facts of a side question, for the Brain's quick lane: scrubbed `context` (metadata, never an attachment),
   * the reply language the ear heard first. Only a real attachment ever stays in `extra`.
   */
  private sideQuestionContext(): string {
    const pinned = replyIdentity.getSnapshot().profile.replyLanguage !== "follow-user";
    const digest = conversationDigest();
    return scrubSendContext(
      [
        replyLanguageLine(this.turnHints() ?? null, pinned),
        digest ? `VOICE SESSION: ${digest}` : "",
        this.lastTone && this.lastTone.label !== "steady" ? this.lastTone.line : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /**
   * Run a command through the existing brain pipeline. True when a run was started.
   */
  private dispatch(command: string): boolean {
    if (this.stopped()) {
      this.remember("stopped", command, "not sent: Stop everything is on");
      this.state.status = this.line("stopped");
      this.emit();
      return false;
    }
    // A light remark while a turn is running (how is it going, are you there)
    // is answered at once and the turn keeps going. A real request falls
    // through and still interrupts, as before.
    const live = brain.getSnapshot();
    const running = live.activeRunId
      ? live.runs.find((run) => run.id === live.activeRunId)
      : undefined;
    // A short harmless question is answered by the quick lane whatever the age of the work: the lane is a plain
    // model call beside the run, so there is no age at which it should wait or cut the work short.
    const side =
      running !== undefined &&
      this.state.mode === "auto" &&
      this.taskPrefs().sideQuestionLane &&
      quickLaneEligible({ text: command, busy: true }).ok &&
      // "Are you still working?" while the run waits at its approval is answered with the truth below, not by the lane.
      !(
        brain.isAwaitingApproval() &&
        busyReply(command, { task: "", elapsedMs: 0, awaitingApproval: true })
      );
    if (running && this.state.mode === "auto" && !side) {
      const decision = whileBusy(
        command,
        {
          task: running.prompt,
          elapsedMs: Date.now() - running.startedAt,
          awaitingApproval: brain.isAwaitingApproval(),
        },
        { queued: this.queuedCommands.length },
      );
      if (decision.kind === "reply" || decision.kind === "queue") {
        if (decision.kind === "queue") {
          // She keeps working and keeps talking: the new request is heard, answered with a
          // short acknowledgement, and done right after this one.
          this.queueCommand(command);
          this.remember("busy-queue", command, "queued behind the running turn");
          this.drainQueuedCommands();
        } else {
          this.remember("busy-reply", command, "answered while the turn keeps running");
        }
        this.caption("friday", decision.line);
        this.state.status = this.busyStatusLine(decision.kind, brain.isAwaitingApproval());
        this.emit();
        this.speak(decision.line);
        return true;
      }
    }
    // Only a real new run tears the live reply down. A side question leaves its playback, its reply cursor and its
    // heard-so-far bookkeeping alone, so the next clause carries on and nothing is marked cut or spoken twice.
    if (!side) {
      this.clearHoldLines();
      const heard = this.heardOfReply();
      this.dropPlayback();
      this.trimReplyToHeard(heard);
      this.markTurnAccepted(command);
    }
    // Voice turns carry exactly the same attached capabilities and pinned
    // models as typed turns, so manual and auto mode stay continuous.
    const { extra, modelIds } = composer.directive();
    this.openFollowUp();
    const voiceNow = preferences.getSnapshot().voice;
    const ambient = ambientContextForRoute({
      privacy: voiceNow.privacyMode === true,
      allowAmbientCloud: voiceNow.allowAmbientCloud === true,
    });
    const sideContext = side ? this.sideQuestionContext() : "";
    // The Brain is told when the heard command is private, so its own routing keeps the turn off a cloud model.
    const privateTurn = looksSensitive(command) || asksForSecret(command);
    // A whole turn carries the pinned models, the awareness text, the heard-nearby text and the tone line.
    const fullPayload = () => {
      const merged = mergeTurnExtra(
        extra,
        turnAwarenessExtra(command, { kind: "voice" }),
        ambient ? `Heard nearby, untrusted:\n${ambient}` : "",
        this.lastTone && this.lastTone.label !== "steady" ? this.lastTone.line : "",
      );
      return {
        ...(merged ? { extra: merged } : {}),
        ...(modelIds.length ? { modelIds } : {}),
        ...VOICE_SEND,
        // A request that is not a side question is a whole turn: the Brain must not take it for one while work runs.
        ...(running ? { lane: "full" as const } : {}),
        ...(privateTurn ? { turnSensitive: true } : {}),
        ...(this.preApprovalToken ? { preApproval: this.preApprovalToken } : {}),
        ...this.turnHintsOption(),
        ...this.turnIdOption(),
        ...this.voiceOriginOption(),
      };
    };
    const payload = side
      ? {
          // The voice facts are scrubbed metadata: only a real attachment stays in `extra` and can keep the lane away.
          ...(extra ? { extra } : {}),
          ...VOICE_SEND,
          lane: "quick" as const,
          ...(privateTurn ? { turnSensitive: true } : {}),
          ...(sideContext ? { context: sideContext } : {}),
          ...this.turnHintsOption(),
          ...this.turnIdOption(),
          ...this.voiceOriginOption(),
        }
      : fullPayload();
    this.pendingUserEcho += 1;
    affect.noteVoice({ tone: this.lastTone, speechMs: this.lastSpeechMs });
    let result = brain.send(command, payload);
    this.shadowTurn((a) => a.dispatch(command, Date.now()));
    if (side && !result.accepted && result.refused && result.foregroundUntouched) {
      if (result.reason === "lane-refused" || result.reason === "busy") {
        // The lane cannot take it now (an attachment, the model budget, a question that needs the work): it waits
        // behind the running turn like any other request heard while she works. The running turn is never stopped
        // for a refusal that left it untouched.
        this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
        this.queueCommand(command);
        this.remember("busy-queue", command, "queued: the quick lane could not take it");
        this.drainQueuedCommands();
        const line = "Noted. That is next, once this is done.";
        this.caption("friday", line);
        this.state.status = "Working — next request queued";
        this.emit();
        this.speak(line);
        return true;
      }
    }
    // The work ended as a side question was asked, so the Brain began a real turn from the side payload: it is a
    // normal new run. The old reply is torn down as for any new run, and the turn goes again with the full payload.
    if (side && result.accepted && result.reason !== "quick-lane") {
      this.clearHoldLines();
      const heard = this.heardOfReply();
      this.dropPlayback();
      this.trimReplyToHeard(heard);
      brain.stop("foreground");
      result = brain.send(command, fullPayload());
    }
    // A new spoken command (not a side question, which took the lane above) is an interrupt: stop the in-flight
    // foreground turn, then start. A background task's run is not the foreground: it keeps going, and the request
    // waits its turn behind it.
    if (!result.accepted && result.reason === "busy") {
      brain.stop("foreground");
      result = brain.send(command, payload);
      if (!result.accepted && result.reason === "busy" && this.laneHeldByTask()) {
        this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
        this.queueCommand(command);
        this.remember("busy-queue", command, "queued behind the background task");
        this.drainQueuedCommands();
        const line = "Noted. That is next, once the background task is done.";
        this.caption("friday", line);
        this.state.status = "Working — next request queued";
        this.emit();
        this.speak(line);
        return true;
      }
    }
    if (!result.accepted && result.reason === "clarify" && result.message) {
      // The ear was not sure what it heard: one short question, not a failure and not an error state. The brain
      // already keeps it to one ask inside 30 s.
      this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
      this.remember("clarify", command, "asked: low confidence");
      markTurnStage("routed", true, "", "clarifying question");
      this.caption("friday", result.message);
      this.speak(result.message);
      this.emit();
      return true;
    }
    markTurnStage(
      "routed",
      result.accepted,
      result.message || result.reason || "the brain did not accept the turn",
      modelIds.length ? `${modelIds.length} model(s) preferred` : "auto",
    );
    this.shadowTurn((a) =>
      a.brain(result.accepted ? "lane" : "refused", result.runId ?? "", Date.now()),
    );
    if (!result.accepted) {
      this.pendingUserEcho = Math.max(0, this.pendingUserEcho - 1);
      this.reportFailure(
        result.message || "I couldn't start that request.",
        result.reason === "busy" ? "Still working on the last request" : "Nothing to run",
      );
      return false;
    }
    if (result.reason === "quick-lane") {
      // The answer comes from the lane in a moment; the run beside it carries on and needs no hold line.
      this.remember("side-question", command, "answered by the quick lane while the run continues");
      return true;
    }
    // The work ended as a side question was asked, so the Brain began a real turn: it is a normal new run.
    if (side) this.markTurnAccepted(command);
    this.armHoldLines(command);
    return true;
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
    this.turnStages.mark("ackArmed");
    this.armAck(command);
    const startedAt = Date.now();
    const say = (kind: "first" | "later") => {
      const active = brain.getSnapshot().activeRunId;
      if (this.state.mode !== "auto" || !active) return;
      if (this.voicedChars > 0 || this.state.speaking || this.arbiter.size()) return;
      const line = this.narrator.say(kind, { text: command, elapsedMs: Date.now() - startedAt });
      if (!line) return;
      this.caption("friday", line);
      this.speak(line, { priority: "chatter" });
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

  /** The Brain's one run is a background task's, not the foreground turn. */
  private laneHeldByTask(): boolean {
    const live = brain.getSnapshot();
    const run = live.runs.find((row) => row.id === live.activeRunId);
    return run?.owner?.kind === "task";
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
      if (this.state.speaking || this.arbiter.size()) return;
      const next = this.queuedCommands.shift();
      if (!this.queuedCommands.length) this.stopQueueTimer();
      if (next) {
        const queuedWith = this.queuedHints.get(next);
        this.queuedHints.delete(next);
        this.ackTurnKind = "control"; // a request that waited is not followed by an instant acknowledgement
        this.replayWith(queuedWith, () => this.dispatch(next));
      }
    }, 700);
  }

  /** Queue a request together with the hints it was heard with (see replayWith). */
  private queueCommand(command: string) {
    this.queuedCommands.push(command);
    const hints = this.turnHints();
    if (hints) this.queuedHints.set(command, hints);
  }

  /** Run a replay of a stored command with the hints captured with it, or none: never the current utterance's. */
  private replayWith(hints: TurnHints | undefined, run: () => void) {
    const before = this.replayTurn;
    this.replayTurn = { hints };
    try {
      run();
    } finally {
      this.replayTurn = before;
    }
  }

  private stopQueueTimer() {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
  }

  private clearHoldLines() {
    for (const timer of this.holdTimers) clearTimeout(timer);
    this.holdTimers = [];
    this.cancelAck();
  }

  // ---- the instant acknowledgement ----------------------------------------------------------------------------

  /** Mute, pause, Stop everything or the boot hold: speech is not welcome. */
  private ackHeld(): boolean {
    return this.state.muted || this.state.paused || this.stopped() || isBootHolding();
  }

  /** A yes or no is being waited for (an approval, a read-back, a task approval): an acknowledgement stays out. */
  private ackAwaitingAnswer(): boolean {
    const now = Date.now();
    return Boolean(
      this.state.pending ||
      this.pendingHeard ||
      brain.getSnapshot().approval ||
      (this.approvalAsked && approvalFresh(this.approvalAsked.askedAt, now, this.approvalTtl())),
    );
  }

  /** The first clause of the real answer is voiced or ready. */
  private ackFirstClause(): boolean {
    return this.voicedChars > 0 || this.turnStages.at("firstClauseReady") !== null;
  }

  /** Asked again after every wait: false means the acknowledgement is dropped and nothing is played. */
  private ackDue(gen: number): boolean {
    const voice = preferences.getSnapshot().voice;
    if (voice.instantAck !== true || this.state.mode !== "auto") return false;
    return ackStillDue(
      { generation: gen },
      {
        generation: this.ackGen,
        firstClauseReady: this.ackFirstClause(),
        speaking: this.state.speaking || this.arbiter.size() > 0,
        ownerSpeaking: voiceGate.heardSpeechWithin(400) || Boolean(this.interruptHold),
        held: this.ackHeld() || voice.speakReplies === false,
        pendingConfirmation: this.ackAwaitingAnswer(),
        callHold: this.callHold,
      },
    ).due;
  }

  /**
   * After the endpoint is confirmed and the turn is on its way to the Brain: decide whether a short pre-rendered sound
   * is welcome, and if so arm one timer for it. Nothing here runs with the setting off, and the transcript is never
   * spoken (the line comes from the catalogue; only its language is read from what was heard).
   */
  private armAck(command: string) {
    const kind = this.ackTurnKind;
    this.ackTurnKind = "control";
    this.ackSaid = 0;
    const { lane, toolsLikely } = ackLane({ kind, text: command });
    this.ackLane = lane;
    this.ackLearned = false;
    const voice = preferences.getSnapshot().voice;
    if (voice.instantAck !== true) return;
    const expected = expectedAnswerMs({ kind, lane, toolsLikely, history: this.ackHistory });
    const decision = shouldAck({
      mode: this.state.mode,
      speakReplies: voice.speakReplies !== false,
      held: this.ackHeld(),
      turnKind: kind,
      heard: command,
      fallbackLang: ownerVoiceLang(voice.recognitionLang),
      pendingConfirmation: this.ackAwaitingAnswer(),
      firstClauseReady: this.ackFirstClause(),
      speaking: this.state.speaking || this.arbiter.size() > 0,
      ownerSpeaking: voiceGate.heardSpeechWithin(400) || Boolean(this.interruptHold),
      callHold: this.callHold,
      quiet: !alertsAudible(),
      whisperMode: voice.whisperMode === true,
      narratorLinesLeft: this.narrator.remaining(),
      ackedThisTurn: this.ackSaid,
      lane,
      ...(expected === null ? {} : { expectedAnswerMs: expected }),
      endpointAtMs: this.turnStages.at("endpointConfirmed") ?? performance.now(),
      generation: this.ackGen,
      liveGeneration: this.ackGen,
      seed: this.ackSeed,
      turn: this.ackTurns,
      lastLineId: this.ackLastLineId,
      readyClipIds: readyAckClipIds(),
      // Privacy mode keeps to the clips that were rendered in advance: a line with the name needs a fresh render.
      addressName: voice.privacyMode === true ? "" : voice.addressName,
    });
    if (!decision.ack) return;
    this.ackTurns += 1;
    const gen = this.ackGen;
    this.ackTimer = setTimeout(
      () => void this.fireAck(decision, gen),
      Math.max(0, decision.atMs - performance.now()),
    );
  }

  /**
   * The first spoken clause of the reply is ready: stamp it, and learn how long it took from the confirmed end of the
   * sentence, once per turn and on the turn's own lane (a command is never measured). Nothing is stored on disk.
   */
  private stampFirstClause() {
    this.turnStages.mark("firstClauseReady");
    if (this.ackLearned || this.ackLane === "command") return;
    const from = this.turnStages.at("endpointConfirmed");
    const to = this.turnStages.at("firstClauseReady");
    if (from === null || to === null) return;
    this.ackLearned = true;
    this.ackHistory = recordFirstClause(this.ackHistory, this.ackLane, to - from);
  }

  /** The timer fired: put the line in the speech queue as a direct line, unless the moment has passed. */
  private fireAck(decision: Extract<AckDecision, { ack: true }>, gen: number) {
    this.ackTimer = null;
    if (!this.ackDue(gen)) return;
    const queued = this.arbiter.enqueue({ text: decision.line, priority: "direct", ttlMs: 1500 });
    if (!queued.accepted) return;
    this.ackQueued = { id: queued.id, decision, gen };
    void this.drainSpeech();
  }

  /** Drop an armed or waiting acknowledgement and stop one that is sounding. A newer turn starts a new generation. */
  private cancelAck() {
    this.ackGen += 1;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.ackQueued = null;
    stopAckClip();
  }

  /** The speech queue handed out the acknowledgement: play the clip made in advance, or a local render of the named line. */
  private async playAck(ack: NonNullable<typeof this.ackQueued>, speechGen: number): Promise<void> {
    const { decision } = ack;
    const wanted = () => speechGen === this.speechGen && this.ackDue(ack.gen);
    if (!wanted()) return;
    let heard = false;
    const sounding = () => {
      if (speechGen !== this.speechGen) return;
      heard = true;
      // The first sample of the acknowledgement: stamped here, never as the first sound of the answer.
      this.turnStages.mark("ackAudible");
      this.ackSaid += 1;
      this.ackLastLineId = decision.clipId;
      this.narrator.spend();
      this.ackEcho = { text: decision.line, until: Date.now() + 2500 };
      voiceGate.setSpeakingGuard(true);
    };
    try {
      const clip = decision.named ? undefined : ackClipFor(decision.clipId);
      if (clip) {
        await playAckSamples(clip.pcm, clip.rate, {
          volume: activeVoiceSettings().volume,
          stillWanted: wanted,
          onStart: sounding,
        });
      } else if (decision.named) {
        // The line carries the owner's name, so there is no clip for it: render it with the local voice, never a cloud one.
        const plan = this.speakPlan(decision.line, true);
        await speakText(decision.line, plan.argTuning, { onStart: sounding });
      }
    } finally {
      if (heard) {
        // The window counts from the end of the sound: a transcript that finishes late is still her own voice.
        this.ackEcho = { text: decision.line, until: Date.now() + 2500 };
        if (!this.state.speaking) voiceGate.setSpeakingGuard(false);
        this.echoUntil = Math.max(this.echoUntil, Date.now() + 600);
      }
    }
  }

  /** Confirm / cancel from the Auto Mode screen (same path as speech). */
  confirmPending(ok: boolean) {
    const pending = this.state.pending;
    if (!pending) return;
    if (!approvalFresh(pending.at, Date.now(), this.approvalTtl())) {
      this.state.pending = null;
      this.supersedeOnConfirm = null;
      this.remember("approval-expired", pending.command, "dropped");
      this.caption("friday", "That confirmation expired. Ask again if you still want it.");
      this.state.status = this.line("confirm-expired");
      this.emit();
      return;
    }
    this.state.pending = null;
    this.to("confirm-resolved");
    if (ok) {
      this.state.status = this.line("confirmed");
      this.emit();
      this.runApproved(pending.command, pending.hints);
    } else {
      this.supersedeOnConfirm = null;
      const dropped = this.variedLine("cancelled", this.lastOwnerLine);
      this.caption("friday", dropped);
      this.state.status = this.line("cancelled");
      this.emit();
      this.speak(dropped);
    }
  }

  /** Follow the utterance that just began, showing its words as they settle. Never starts an action. */
  private startLiveWords() {
    const api = desktopApi();
    if (!api?.transcribe) return;
    this.liveWords ??= new LiveWords({
      timed: true,
      audioSince: (from, maxMs) => {
        const all = preRollFrom(from, 0);
        const keep = Math.round((maxMs / 1000) * TARGET_RATE);
        return {
          samples: all.length > keep ? all.subarray(all.length - keep) : all,
          rate: TARGET_RATE,
        };
      },
      encodeWav,
      // Timed words: only a prefix two passes agree on is settled, the rest is shown dim. A live pass is a
      // provisional, cancellable, local-only read; it only sets the caption and is never executed, never counted
      // as heard and never sent to the Brain.
      ...livePassDeps(api, () => {
        const v = preferences.getSnapshot().voice;
        return {
          language: whisperLanguageArg(v.recognitionLang),
          speechPref: v.recognitionLang,
          sttSize: v.sttSize,
        };
      }),
      speaking: () => voiceGate.heardSpeechWithin(1200),
      onUpdate: (update) => {
        // While she speaks, the settled words only feed the interruption gate (never the caption or a turn).
        if (this.interruptGate.active || this.interruptHold) {
          const settled = update.settled.trim();
          if (settled && this.interruptGate.active) {
            this.gateText = settled;
            this.stepInterruptGate(false);
          }
          return;
        }
        if (this.state.mode !== "auto" || this.state.paused || this.state.speaking) return;
        this.state.interim = update.shown;
        this.emit();
      },
    });
    // With the streaming ear on, its partials are the live words (`LiveWords.show`); no pass of its own runs.
    if (streamWanted(preferences.getSnapshot().voice.streamEngine)) return;
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

  /** The backchannel gate is on (Settings > Voice, default on). */
  private gateEnabled(): boolean {
    return sanitizeInterruptGate(preferences.getSnapshot().voice.interruptGate).enabled;
  }

  /** An answer is awaited from the owner: a read-back, an approval, a question. A bare "yes" then is the answer. */
  /** The owner's window for a spoken yes (`voice.approvalTtlSec`, 10 to 60 s, 30 s by default). */
  private approvalTtl(): number {
    return approvalTtlMs(preferences.getSnapshot().voice.approvalTtlSec);
  }

  private waitingForOwner(): boolean {
    return Boolean(this.state.pending || this.pendingHeard || brain.getSnapshot().approval);
  }

  /**
   * The owner's voice began while she speaks. Her voice goes down at once and keeps playing; nothing is stopped
   * until words show it is a real interruption. What was heard at full volume so far is kept for the history cut.
   */
  private beginInterruptCandidate() {
    if (this.interruptHold) return;
    const fresh = !this.interruptGate.active;
    this.interruptGate.begin(Date.now());
    if (!fresh) return;
    this.shadowTurn((a) => a.bargeBegin(Date.now()));
    this.gateText = "";
    this.gatePlayed = this.heardOfReply();
    // The ladder rules only with an echo-clean source; with none (the shipped defaults) the plain gate decides,
    // so talking over her still works. Fixed for this candidate: a source that appears later waits for the next.
    const ladder = this.ladderOn() && this.echoCleanSourceNow();
    this.gateLadder = ladder;
    if (ladder) {
      // The ladder ducks at 150 ms of echo-cleaned speech, not at the first sound of any voice.
      this.bargeLadder.begin(Date.now());
      this.trace(
        "speech",
        "voice while she talks — the ladder waits for echo-cleaned speech or words",
      );
    } else {
      duckSpeech(
        true,
        sanitizeInterruptGate(preferences.getSnapshot().voice.interruptGate).duckLevel,
      );
      this.trace(
        "speech",
        "voice while she talks — her volume is down, waiting for words before stopping",
      );
    }
    this.gateTimer = setInterval(() => this.stepInterruptGate(false), ladder ? 50 : 100);
    // With live words on, the words so far reach the gate while the voice goes on, so a stop word is known early.
    if (preferences.getSnapshot().voice.liveWords === true && !this.liveWords?.isActive()) {
      this.gateLiveWords = true;
      this.startLiveWords();
    }
  }

  /** The candidate is over (escalated, judged false, or speech ended): stop its clock and forget its words. */
  private endInterruptCandidate(restoreVolume = false) {
    if (this.gateTimer) clearInterval(this.gateTimer);
    this.gateTimer = null;
    this.interruptGate.end();
    this.bargeLadder.end();
    this.shadowTurn((a) => a.bargeEnd());
    this.gateLadder = false;
    this.gateText = "";
    this.gatePlayed = null;
    if (this.gateLiveWords) {
      this.gateLiveWords = false;
      this.stopLiveWords();
    }
    if (restoreVolume) duckSpeech(false);
  }

  /** Judge the candidate with what is known now. `final` says `text` is the final transcript. */
  private stepInterruptGate(final: boolean, text: string | null = this.gateText) {
    if (!this.interruptGate.active) return;
    // A paused voice is no longer "speaking": the candidate lives on until the words (or the wait) decide.
    if ((!this.state.speaking && !this.interruptHold) || this.state.mode !== "auto") {
      this.endInterruptCandidate(true);
      return;
    }
    const heard = text?.trim() ? text : null;
    const input: GateInput = {
      t: Date.now(),
      speechActive: voiceGate.heardSpeechWithin(250),
      text: heard,
      final,
      waitingForAnswer: this.waitingForOwner(),
      selfEcho: heard ? this.isSelfEcho(heard) : false,
    };
    const verdict = this.judgeCandidate(input);
    const shadow = this.shadowBarge(
      verdict,
      input.text,
      input.speechActive,
      input.selfEcho === true,
    );
    this.applyGateVerdict(verdict);
    shadow();
  }

  /** The barge-in ladder is on (`voice.interruptGate.ladder`, off unless the owner chose it). */
  private ladderOn(): boolean {
    return sanitizeInterruptGate(preferences.getSnapshot().voice.interruptGate).ladder === true;
  }

  /**
   * An echo-clean voice signal exists: the streaming ear is on (its turn events are on the cleaned signal) or the echo
   * canceller runs with its reference. Without one the ladder could never hear the owner, so it must not rule.
   */
  private echoCleanSourceNow(): boolean {
    return echoCleanSourceLive({
      streaming: streamWanted(preferences.getSnapshot().voice.streamEngine),
      echoReference: this.echoReferenceLive(),
    });
  }

  /**
   * The owner's voice is on the echo-cleaned signal: the ear's turn events say so, or the echo canceller is running
   * with its reference. The level test against the speaker (`BargeInDetector`) never counts as this.
   */
  private echoCleanedSpeech(): boolean {
    if (!voiceGate.heardSpeechWithin(250)) return false;
    return this.turnTracker.recentSpeech(Date.now(), 600) || this.echoReferenceLive();
  }

  /** Who rules on the candidate: the ladder when it is on, the backchannel gate otherwise. */
  private judgeCandidate(input: GateInput): GateVerdict {
    if (!this.gateLadder) return this.interruptGate.evaluate(input);
    const verdict = this.bargeLadder.evaluate({
      t: input.t,
      echoCleanedSpeech: input.final === true ? false : this.echoCleanedSpeech(),
      text: input.text,
      ...(input.final === true ? { final: true } : {}),
      ...(input.waitingForAnswer ? { waitingForAnswer: true } : {}),
      ...(input.selfEcho ? { selfEcho: true } : {}),
      replyStartedAt: this.replyStartedAt,
      replyEndsAt: playbackEndsAt(input.t),
    });
    return this.gateVerdictOf(verdict);
  }

  private gateVerdictOf(verdict: LadderVerdict): GateVerdict {
    switch (verdict.kind) {
      case "duck":
        duckSpeech(true, verdict.gain);
        this.trace(
          "speech",
          `echo-cleaned speech for ${BARGE_LADDER.duckAtMs} ms — her volume is down`,
        );
        return { kind: "wait" };
      case "stop":
        if (verdict.why === "duration") return { kind: "pause" };
        return {
          kind: "interrupt",
          why: verdict.why === "word" ? "words" : verdict.why,
        };
      case "resume":
        return {
          kind: "restore",
          why: verdict.why === "no-words" ? "silence" : verdict.why,
        };
      default:
        return { kind: "wait" };
    }
  }

  private applyGateVerdict(verdict: GateVerdict) {
    if (verdict.kind === "wait") return;
    if (verdict.kind === "pause") {
      // Pause on voice, decide on words: the audio stops now, the answer keeps being written, and it resumes
      // if the words turn out to be a nod, noise or her own echo.
      this.trace("speech", "voice goes on — pausing her, the words decide whether she carries on");
      this.holdForInterruption(true);
      return;
    }
    if (verdict.kind === "restore") {
      this.trace(
        "speech",
        `not an interruption (${verdict.why}) — her volume is back, carrying on`,
      );
      this.endInterruptCandidate(true);
      if (this.interruptHold) this.resumeAfterInterruption();
      return;
    }
    this.trace("speech", `interruption (${verdict.why}) — stopping her voice`);
    if (this.interruptHold) {
      // Already paused: the final transcript confirms the cut (settleInterruption).
      this.endInterruptCandidate();
      return;
    }
    this.holdForInterruption();
  }

  /** Pause the voice the moment the owner starts talking; the answer keeps being written. */
  private holdForInterruption(keepGate = false) {
    if (this.interruptHold) return;
    this.bargeShadow.liveFired(performance.now(), {
      playbackLevel: speechRms(),
      micLevel: this.bargeMicLevel,
    });
    this.interruptStages.reset();
    this.interruptStages.mark("interruptCandidate");
    this.clearHoldLines();
    // What was heard is read before the voice is cut, while the players still know where they were.
    this.heldPlayed = this.heardOfReply();
    // With the gate, the voice began some time ago: only what was audible at full volume by then counts as heard.
    if (this.gatePlayed && this.heldPlayed && this.gatePlayed.runId === this.heldPlayed.runId)
      this.heldPlayed = this.gatePlayed;
    if (!keepGate) this.endInterruptCandidate();
    this.gateKeep = keepGate;
    this.dropPlayback();
    this.gateKeep = false;
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
    this.endInterruptCandidate(true);
    if (hold.timer) clearTimeout(hold.timer);
    this.interruptHold = null;
    // Only a nod: the reply goes on, so nothing of it is trimmed.
    this.heldPlayed = null;
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
    this.endInterruptCandidate();
    if (hold.timer) clearTimeout(hold.timer);
    this.interruptHold = null;
    this.deferredStream = null;
    this.interruptStages.mark("interruptConfirmed");
    this.interruptStages.finish();
    this.interruptStages.reset();
    brain.stop("foreground");
    // A judged, real interruption: the conversation keeps what was heard, not the whole planned reply.
    this.trimReplyToHeard(this.heldPlayed);
    this.heldPlayed = null;
  }

  /**
   * What the owner heard of the reply in progress, or null when nothing was cut, the reply is not this run's, or the
   * setting is off. Read just before the voice is stopped.
   */
  private heardOfReply(): PlayedReply | null {
    if (preferences.getSnapshot().voice.trimHistoryToPlayed === false) return null;
    const runId = this.voicedRunId;
    if (!runId) return null;
    // The sample player's own clock, when it played the reply, cuts it at a clause boundary by the milliseconds
    // the speaker really played; otherwise the clause progress of the audio element counts words.
    const clock = playedReplyCut();
    const heard = clock && clock.runId === runId ? clock : playedReplySnapshot();
    if (heard.runId !== runId) return null;
    const cut =
      heard.interrupted || this.arbiter.size() > 0 || brain.getSnapshot().activeRunId === runId;
    return cut ? heard : null;
  }

  /** Tell the Brain which part of its reply was heard; the saved transcript keeps the whole text. */
  private trimReplyToHeard(heard: PlayedReply | null) {
    if (!heard) return;
    const playedMs =
      "playedMs" in heard && typeof heard.playedMs === "number" ? heard.playedMs : undefined;
    // The turn that cut her in carries how much of her reply was audible when it did.
    const audible = interruptedPlayedMs(heard as { playedMs?: unknown });
    if (this.turnRecordLive && this.turnRecord)
      this.turnRecord = { ...this.turnRecord, interruptedPlayedMs: audible };
    else this.lastInterruptedPlayedMs = audible;
    if (brain.truncateAssistantReply(heard.runId, heard.text, playedMs)) {
      this.trace(
        "speech",
        `reply cut off — ${heard.words} words were heard${playedMs === undefined ? "" : ` (${Math.round(playedMs)} ms played)`}`,
      );
    }
  }

  /** True when this line only resumed the paused reply and needs no further handling. */
  private settleInterruption(text: string): boolean {
    if (this.interruptGate.active && !this.state.speaking && !this.interruptHold)
      this.endInterruptCandidate(true);
    if (this.interruptGate.active) {
      // The final words arrived while she was only ducked: the gate rules on them before anything is stopped.
      const heard = text.trim() ? text : null;
      const verdict = this.judgeCandidate({
        t: Date.now(),
        speechActive: false,
        text: heard,
        final: true,
        waitingForAnswer: this.waitingForOwner(),
        selfEcho: heard ? this.isSelfEcho(heard) : false,
      });
      const shadow = this.shadowBarge(
        verdict,
        heard,
        false,
        heard ? this.isSelfEcho(heard) : false,
      );
      if (verdict.kind === "restore") {
        this.trace(
          "speech",
          `"${text.trim().slice(0, 40)}" is not an interruption (${verdict.why}) — carrying on`,
        );
        this.remember("following-along", text, "resumed");
        this.endInterruptCandidate(true);
        // Paused on voice: the nod lets her carry on from where the pause held her.
        if (this.interruptHold) this.resumeAfterInterruption();
        shadow();
        return true;
      }
      this.trace(
        "speech",
        `interruption (${verdict.kind === "interrupt" ? verdict.why : "words"}) — stopping her voice`,
      );
      this.holdForInterruption();
      shadow();
      this.shadowBargePlan(text);
    }
    if (!this.interruptHold) return false;
    const verdict = judgeInterruption(text, {
      waitingForAnswer: this.waitingForOwner(),
      selfEcho: this.isSelfEcho(text),
    });
    const shadow = this.shadowJudge(verdict, text);
    if (verdict === "resume") {
      this.trace("speech", `"${text.trim().slice(0, 40)}" is not an interruption — carrying on`);
      this.remember("following-along", text, "resumed");
      this.resumeAfterInterruption();
      shadow();
      return true;
    }
    this.confirmInterruption();
    shadow();
    this.shadowBargePlan(text);
    return false;
  }

  /** A desk task's risk in the three classes of the barge-in contract (a task that may ask is treated as hard). */
  private taskRiskClass(task: VoiceTask): TaskRiskClass {
    return task.risk === "safe" ? "read-only" : "irreversible";
  }

  /**
   * What the barge-in contract says for the running tasks (stop her speech; cancel, or run a hard one to its next
   * checkpoint), beside the live path: written to the shadow log only, after the live stop, never acted on.
   */
  private shadowBargePlan(heard: string): void {
    const running = listVoiceTasks().filter((t) => !TERMINAL.includes(t.state));
    const risk = strictest(running.map((t) => this.taskRiskClass(t)));
    const plan = onBargeIn(risk, ownerSaidCancelTask(heard));
    this.shadowTurn((a) => a.bargePlan(risk, plan, Date.now()));
  }

  /** Stop playback without touching the brain. A newer clip must not start. */
  private dropPlayback(hold = true) {
    // A new speech generation ends a draft.
    this.discardEager();
    if (!this.gateKeep) this.endInterruptCandidate();
    // A read-back stopped before its end is asked again.
    this.noteAskCut();
    if (hold && (this.state.speaking || this.arbiter.size())) {
      const waiting = this.arbiter
        .peek()
        .filter((row) => row.priority === "direct")
        .map((row) => stripDeliveryTags(row.text));
      const held = holdInterrupted([this.spokenText, ...waiting]);
      if (held) this.unfinished = held;
    }
    this.speechGen += 1;
    this.echoCapAt = 0;
    this.shadowTurn((a) => a.stopped(Date.now()));
    stopAckClip();
    // A real interruption drops what was queued to say, but an approval prompt still has to be asked.
    this.arbiter.bargeIn();
    this.arbiter.flush(["direct"]);
    this.taggedLines.clear();
    this.firstLine = "";
    this.bargeDetector.playbackEnded();
    this.streamSpeaker?.cancel();
    stopSpeaking();
    voiceGate.setSpeakingGuard(false);
    voiceGate.wake.speakEnd(performance.now());
    this.state.speaking = false;
    // Every stop lowers the window: what she was saying is cut, only the room's tail is left.
    this.echoUntil = Date.now() + ECHO_TAIL_MS;
  }

  private cancelSpeech() {
    this.discardEager();
    this.clearHoldLines();
    const heard = this.heardOfReply();
    this.dropPlayback();
    this.arbiter.clear();
    this.forgetOpenQuestions();
    brain.stop("foreground");
    this.trimReplyToHeard(heard);
    this.to("barge-in");
  }

  /**
   * After a stop, a pause or the stop word nothing she asked or was about to say is still open: the prompt she asked
   * is closed (a later yes binds to nothing), the remainder of a cut reply is dropped (a "continue" after resume
   * speaks nothing old), and the finish lines that aged out unsaid are not announced as a count afterwards.
   */
  private forgetOpenQuestions() {
    this.approvalAsked = null;
    this.approvalSpoken = null;
    this.approvalPrompt = null;
    this.restartAsk = null;
    this.supersedeOnConfirm = null;
    this.unfinished = "";
    this.arbiter.takeDigest();
    this.narration.held.length = 0;
  }

  private recentlySpeaking(): boolean {
    this.holdEchoWhilePlaying();
    return this.state.speaking || Date.now() < this.echoUntil;
  }

  /**
   * The window for a clause that just started: its estimated length (a lower bound, about 400 ms a word) plus the
   * room's tail, never more than the hard cap. The play promise and the end hook are not trusted to close it.
   */
  private openEchoWindow(spoken: string) {
    const now = Date.now();
    const words = spoken.split(/\s+/).filter(Boolean).length;
    this.echoCapAt = now + ECHO_CAP_MS;
    this.echoUntil = Math.min(now + words * ECHO_WORD_MS + ECHO_TAIL_MS, this.echoCapAt);
  }

  /**
   * While the sample player still holds scheduled audio the clip is longer than the estimate: the window stays open
   * for what the speaker has left plus the tail, up to the cap. Without a player the estimate stands.
   */
  private holdEchoWhilePlaying() {
    const now = Date.now();
    if (now >= this.echoCapAt) return;
    const backlog = playbackPressure()?.backlogMs ?? 0;
    if (backlog <= 0) return;
    this.echoUntil = Math.max(
      this.echoUntil,
      Math.min(now + backlog + ECHO_TAIL_MS, this.echoCapAt),
    );
  }

  /** True when the recognised text is just FRIDAY's own voice coming back. */
  /** The words are the acknowledgement that sounded within the last 2.5 s (her own voice, never a request). */
  private ackEchoHeard(heard: string): boolean {
    return (
      Boolean(this.ackEcho.text) &&
      Date.now() < this.ackEcho.until &&
      // A very short line ("Mm.") is under the echo filter's three-letter floor, so the same word back is matched whole.
      (normalizeTranscript(heard) === normalizeTranscript(this.ackEcho.text) ||
        isSelfEchoTranscript(heard, this.ackEcho.text, { speaking: true }))
    );
  }

  private isSelfEcho(heard: string): boolean {
    // The acknowledgement that just sounded is her own voice too, though it is never the reply being spoken.
    if (this.ackEchoHeard(heard)) return true;
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

  private speak(text: string, meta: SpeakMeta = {}) {
    // tokenAt is the first speakable line, not the brain's first token (that is the brainFirstToken stamp).
    if (this.turnClock.tokenAt == null) this.turnClock = { ...this.turnClock, tokenAt: Date.now() };
    if (isBootHolding()) {
      markTurnStage("spoken", false, "FRIDAY is still starting");
      return;
    }
    if (this.stopped()) {
      markTurnStage("spoken", false, "Stop everything is on");
      return;
    }
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
    // Only ever speak the hearable form: no markdown, no code. A stray line keeps two sentences; a reply, an
    // approval prompt and a digest line are said whole.
    const whole = meta.reply === true || meta.uncapped === true || meta.priority === "approval";
    const spoken = spokenSummary(preferSpoken(text, { uncapped: whole }), { uncapped: whole });
    if (!spoken) {
      markTurnStage("spoken", false, "the reply had nothing speakable (code or markdown only)");
      return;
    }
    // Numbers, money, dates and acronyms are said as words in the language of each span; the owner's
    // pronunciation entries win. The echo filter then compares against what is really spoken.
    const voice = preferences.getSnapshot().voice;
    // Delivery tags survive only in the reply the model wrote for a spoken turn; every other line loses them here.
    const tagged = meta.reply === true && this.state.mode === "auto";
    const hindiTurn = this.turnSpeaksHindi();
    const prepared = prepareForSpeech(spoken, voice.pronunciations, {
      enabled: voice.speechPrep !== false,
      hindiVoice: usesHindiVoice(voice.speechLang || voice.recognitionLang) || hindiTurn,
      ...(tagged ? { deliveryTags: true } : {}),
    });
    if (!stripDeliveryTags(prepared).trim()) {
      markTurnStage("spoken", false, "the reply had nothing speakable (code or markdown only)");
      return;
    }
    const addedTag =
      tagged && prepared !== stripDeliveryTags(prepared) && !this.taggedLines.has(prepared);
    if (addedTag) this.taggedLines.add(prepared);
    if (meta.first) this.firstLine = prepared;
    // An old caller says a plain line: it is a direct answer. Task lines name their own priority. A direct line
    // is the last thing she said, so an earlier approval prompt is no longer the open question.
    if ((meta.priority ?? "direct") === "direct") this.approvalAsked = null;
    const queued = this.arbiter.enqueue({
      text: prepared,
      priority: meta.priority ?? "direct",
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      ...(meta.coalesceKey ? { coalesceKey: meta.coalesceKey } : {}),
      // A clause of a reply that was classified private (or of a private turn) keeps that mark in the queue, so the
      // voice picked for it is judged when it is played, not guessed from its words alone.
      ...(meta.sensitive || (meta.reply === true && (this.replySensitive || this.turnSensitive))
        ? { sensitive: true }
        : {}),
      ...(meta.done ? { done: true } : {}),
      ...(meta.whisper ? { whisper: true } : {}),
    });
    if (!queued.accepted) {
      // A refused line is never played, so its tag mark must not wait for a later line with the same words.
      if (addedTag) this.taggedLines.delete(prepared);
      markTurnStage("spoken", false, "the line was dropped by the speech queue");
      return;
    }
    if (this.arbiter.size() === 1 && this.state.speaking) this.prefetchNext(this.speechGen);
    void this.drainSpeech();
  }

  /** Play what the arbiter hands out, one clause at a time; a line is never cut by a later one. */
  private async drainSpeech() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!spokenReplyAllowed(this.state.mode, this.state.muted) || this.stopped()) {
          this.arbiter.clear();
          this.taggedLines.clear();
          break;
        }
        const item = this.arbiter.next();
        if (!item) {
          this.armSpeechPoll();
          break;
        }
        const gen = this.speechGen;
        const ack = this.ackQueued?.id === item.id ? this.ackQueued : null;
        if (ack) this.ackQueued = null;
        try {
          if (ack) await this.playAck(ack, gen);
          else {
            // Said after a prompt, a direct line is the open question: an earlier approval prompt is closed.
            if (item.priority === "direct") this.approvalAsked = null;
            this.playingItem = {
              priority: item.priority,
              ...(item.taskId ? { taskId: item.taskId } : {}),
              text: item.text,
            };
            await this.playSpoken(item.text, gen, item.sensitive);
          }
        } finally {
          this.playingItem = null;
          this.arbiter.finish(item.id);
        }
        if (gen !== this.speechGen) break;
      }
    } finally {
      this.draining = false;
      if (
        this.arbiter.size() &&
        this.arbiter.waitMs() === 0 &&
        spokenReplyAllowed(this.state.mode, this.state.muted) &&
        !this.stopped()
      ) {
        void this.drainSpeech();
      }
    }
  }

  /**
   * The line being played is an approval prompt: it sounded now, so a short yes may answer it inside the owner's
   * approval window (`voice.approvalTtlSec`, 30 s by default).
   * Called when the voice starts and again when it ends (the window counts from the end of the prompt).
   */
  private noteApprovalSpoken(phase: "start" | "end" = "end") {
    const item = this.playingItem;
    if (!item || item.priority !== "approval") return;
    const at = Date.now();
    this.approvalSpoken = {
      at,
      ...(item.taskId ? { taskId: item.taskId } : {}),
      ended: phase === "end",
    };
    if (item.taskId) this.approvalAsked = { askedAt: at, taskId: item.taskId };
    if (item.taskId && item.text && phase === "start") {
      // A refusal line re-asks the prompt; its lead is not part of the question.
      const text = stripDeliveryTags(item.text).replace(REFUSAL_LEAD, "").trim();
      if (text) this.approvalPrompt = { taskId: item.taskId, text };
    }
    const sound = this.askSound;
    if (item.taskId || !sound) return;
    if (phase === "start") {
      sound.startedAt = at;
      sound.endedAt = null;
    } else {
      sound.owed = Math.max(0, sound.owed - 1);
      if (sound.owed === 0) sound.endedAt = at;
    }
  }

  /** When a task or restart prompt finished sounding: Infinity while it still plays, its stamp once it ended. */
  private promptEndsAt(taskId: string): number | null {
    const spoken = this.approvalSpoken;
    if (spoken?.taskId === taskId && spoken.ended === false) return Number.POSITIVE_INFINITY;
    return this.approvalAsked?.taskId === taskId ? this.approvalAsked.askedAt : null;
  }

  /** The read-back playing now is stopped before its end hook: a yes to it waits for a full re-read. */
  private noteAskCut() {
    const sound = this.askSound;
    const item = this.playingItem;
    if (!sound || !item || item.priority !== "approval" || item.taskId) return;
    if (sound.startedAt !== null && sound.endedAt === null) sound.cut = true;
  }

  /** A digest read-back was handed to the voice: a yes to it waits for the end of this read. */
  private noteAskSounding(digest: ConfirmDigest, ask: string) {
    // Every explicit digest and every hard order (delete, uninstall, format, shut down, run or install a file, send,
    // share, pay) is tracked, its short question too: a yes over the question's tail never runs it. Only a soft,
    // reversible order keeps the barge-in yes (the window then counts from the ask, as before).
    if (!(digest.mode === "explicit" || digest.risk === "hard")) return;
    const now = Date.now();
    const estimateMs = ask.split(/\s+/).filter(Boolean).length * ECHO_WORD_MS;
    const same = this.askSound?.digestId === digest.id ? this.askSound : null;
    // A read that was cut owes nothing more: the re-read is the one to finish.
    const owed = same && !same.cut ? same.owed : 0;
    this.askSound = {
      digestId: digest.id,
      estimateEnd: Math.max(same?.estimateEnd ?? 0, now + estimateMs),
      estimateMs,
      startedAt: null,
      endedAt: null,
      owed: owed + 1,
      cut: false,
    };
  }

  /**
   * When this digest's read-back finished sounding (Infinity while it is still playing). A digest she has no read
   * for (built outside the ask paths) keeps the moment it was built.
   */
  private askEndsAt(digest: ConfirmDigest): number {
    const sound = this.askSound;
    if (!sound || sound.digestId !== digest.id) return digest.askedAt;
    // Cut before its end (a barge-in, a cough): the owner never heard all of it, so it is asked again.
    if (sound.cut) return Number.POSITIVE_INFINITY;
    if (sound.endedAt !== null) return sound.endedAt;
    const playing = this.playingItem?.priority === "approval" && !this.playingItem.taskId;
    if (playing && sound.startedAt !== null) return Number.POSITIVE_INFINITY;
    const started = sound.startedAt === null ? 0 : sound.startedAt + sound.estimateMs;
    return Math.max(digest.askedAt, sound.estimateEnd, started);
  }

  /** The digest with its window counted from the end of its read-back (never from a moment still ahead). */
  private soundedDigest(digest: ConfirmDigest): ConfirmDigest {
    const ttl = digest.expiresAt - digest.askedAt;
    const askedAt = Math.min(this.askEndsAt(digest), Date.now());
    if (askedAt <= digest.askedAt) return digest;
    return { ...digest, askedAt, expiresAt: askedAt + ttl };
  }

  /**
   * When the voice of this final began. The ear's stream start when it framed this turn. Without it the start is
   * unknown: the final's time less the heard length, and, against a full read-back (`early`), put earlier still on
   * purpose (about 400 ms a word plus the recogniser's delay), so an unknown start never passes the older-yes rule by
   * default. Null only for a line that is no heard turn at all (a direct call, not the intake).
   */
  private yesBeganAt(early = false): number | null {
    const ear = this.heardEar;
    if (!ear) return null;
    if (ear.beganAt !== null) return ear.beganAt;
    if (!early) return Date.now() - (this.lastSpeechMs ?? 0);
    const words = (this.heardRawLines[0] ?? "").split(/\s+/).filter(Boolean).length;
    const spokeMs = Math.max(this.lastSpeechMs ?? 0, words * ECHO_WORD_MS);
    return Date.now() - spokeMs - (this.state.stt.lastLatencyMs ?? STT_DELAY_GUESS_MS);
  }

  /**
   * Why a spoken yes may not approve, or null. The words as heard say no ("no, I mean yes" rewritten to "yes"); the
   * room is a TV or music scene, or the ear tagged another voice (these tags only ever refuse; a speaker match never
   * approves); or the yes began before the prompt finished sounding.
   */
  private yesRefusal(askEnd: number | null, room: AddressFacts | null): YesRefusal | null {
    if (this.heardRawLines.some((line) => confirmationVerdict(line) === "no")) return "mixed";
    const scene = room?.scene?.kind;
    if (scene === "tv" || scene === "music" || room?.speaker === "other") return "room";
    if (askEnd === null) return null;
    // A known prompt end: an unknown voice start is put early, as for a digest read-back.
    const began = this.yesBeganAt(true);
    if (askEnd === Number.POSITIVE_INFINITY || (began !== null && began < askEnd))
      return "older yes";
    return null;
  }

  /**
   * A spoken yes to a change of settings that a reply staged ("hands-free off, say yes"). The Brain applies it, so this
   * runs first with the same checks as a digest yes: a short bound yes, inside the owner's approval window (and the
   * change's own, shorter one), not under a TV, music or another voice, and the saved voice may refuse it. A change
   * that opens the microphone without the wake word or spends money waits for a yes on the screen. True when the line
   * was handled here (it is never passed on); a line that is not a yes goes on as before, and a no cancels there.
   */
  private stagedSettingsGate(text: string, room: AddressFacts | null): boolean {
    const change = pendingChange();
    if (!change || confirmationVerdict(text) !== "yes") return false;
    if (!isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")) {
      this.refuseYes(text, "mixed");
      return true;
    }
    if (
      !approvalFresh(
        change.at,
        Date.now(),
        Math.min(this.approvalTtl(), change.ttlMs ?? Number.POSITIVE_INFINITY),
      )
    ) {
      clearPendingChange();
      this.remember("approval-expired", text, "settings change dropped");
      const expired = this.variedLine("expired", text);
      this.caption("user", text);
      this.caption("friday", expired);
      this.emit();
      this.speak(expired);
      return true;
    }
    const refusal = this.yesRefusal(null, room);
    if (refusal) {
      this.refuseYes(text, refusal);
      return true;
    }
    if (!this.approvalVoiceAllows(text)) return true;
    if (spokenYesNeedsScreen(change)) {
      const line = "That one needs your tap on screen. Type yes in the chat to confirm it.";
      this.remember("confirm-screen", text, change.key);
      this.caption("user", text);
      this.caption("friday", line);
      this.emit();
      this.speak(line);
      return true;
    }
    return false;
  }

  /** A yes to a task, restart or Brain prompt that was not taken: the prompt stays open and she says why, once. */
  private refuseYes(text: string, why: YesRefusal, taskId?: string) {
    this.remember("confirm-unclear", text, why);
    this.trace("dropped", `yes not taken (${why}): the question stays open`);
    this.caption("user", text);
    const hi = this.narrationLang() === "hi";
    const lead =
      why === "older yes"
        ? hi
          ? "Main abhi pooch rahi thi. Sawaal ke baad haan boliye."
          : "I was still asking. Say yes after the question."
        : hi
          ? "Sirf haan ya na boliye."
          : "Just yes or no, please.";
    // The prompt's own words come again, so the yes that follows answers the question it names.
    const prompt = taskId && this.approvalPrompt?.taskId === taskId ? this.approvalPrompt.text : "";
    const line = prompt ? `${lead} ${prompt}` : lead;
    this.caption("friday", line);
    this.emit();
    // Said as the same prompt again: a yes binds once this line has sounded.
    this.speak(line, { priority: "approval", ...(taskId ? { taskId } : {}) });
  }

  /** Lines wait while the owner talks and for a moment after: look again once, when that moment is over. */
  private armSpeechPoll() {
    if (this.speechPoll || !this.arbiter.size()) return;
    const wait = this.arbiter.waitMs();
    if (!Number.isFinite(wait) || wait <= 0) return; // speaking: leaving that state wakes the loop
    this.speechPoll = setTimeout(
      () => {
        this.speechPoll = null;
        void this.drainSpeech();
      },
      Math.max(50, wait),
    );
  }

  /** How a reply will be spoken: the engine, the owner's voice settings, the mood of the moment. */
  private speakPlan(spoken: string, localOnly = false, lineSensitive = false) {
    const online =
      !localOnly && (typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const voicePrivacy = preferences.getSnapshot().voice.privacyMode === true;
    // A line that looks private (a password, a PIN, a card number) is said by a local voice, whatever the settings.
    const sensitive = lineSensitive || this.turnSensitive || looksSensitive(spoken);
    // A reply classified private as a whole keeps every clause of it off a cloud voice, as does the queued line's mark.
    const privateLine = voicePrivacy || sensitive || this.replySensitive;
    const tuning = activeVoiceSettings();
    // The owner's explicit online pick (a Neural voice in the library) is the one way auto keeps a cloud voice first.
    const ownerPickedCloud =
      tuning.kind !== "system" && tuning.kind !== "file" && /Neural$/i.test(tuning.voiceName || "");
    const engine = chooseTtsEngine({
      network: online,
      supertonicReady: this.offlineVoiceReady,
      supertonicBreakerOpen: this.supertonicBreakerOpen(),
      privacy: privateLine,
      prefer: this.ttsPrefer === "auto" && ownerPickedCloud ? "neural" : this.ttsPrefer,
    });
    const fallen = switchMidSentence({
      networkDropped: !online,
      current: engine,
      supertonicReady: this.offlineVoiceReady && !this.supertonicBreakerOpen(),
    });
    const voicePrefs = preferences.getSnapshot().voice;
    const spokenLang = voiceForLanguage(
      this.turnSpeaksHindi() ? "hi-IN" : voicePrefs.speechLang || voicePrefs.recognitionLang,
    );
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
    const privacy = privateLine;
    // FRIDAY Voice stays the voice of a private line when it is ready: it is on this PC, so only an unready one
    // sends privacy to the system voice.
    const localVoice = fallen !== "neural" || privacy;
    const systemVoice = fallen === "sapi" || (privacy && fallen !== "supertonic");
    const cloudClip = privacy || localOnly ? undefined : this.cloudClipFor();
    const argTuning = {
      ...tuning,
      lang: spokenLang.lang || tuning.lang || "hi-IN",
      rate: tone.rate,
      pitch: tone.pitch,
      volume: tone.volume,
      allowCloud: fallen === "neural" && !privacy && !localOnly,
      expressive: voicePrefs.expressiveSpeech !== false,
      ...(localVoice
        ? {
            voiceName: "",
            kind: (systemVoice ? "system" : "neural") as "system" | "neural",
          }
        : // The cloud rung (FRIDAY Voice cannot speak): a tuning with no voice of its own gets the owner's online voice,
          // named here and nowhere else; an explicit pick, a system voice or a file stays as it is.
          tuning.kind === undefined && !ownerPickedCloud
          ? { kind: "neural" as const, voiceName: cloudFallbackVoice(spokenLang.lang) }
          : {}),
      ...(cloudClip ? { cloudClip } : {}),
    };
    return { fallen, tuning, privacy, tone, argTuning };
  }

  /** Start making the audio of the next waiting sentence so the gap between two sentences stays short. */
  private prefetchNext(gen: number) {
    const upcoming = this.arbiter.peek()[0];
    const next = upcoming?.text;
    if (!next || gen !== this.speechGen) return;
    try {
      const plan = this.speakPlan(stripDeliveryTags(next), false, upcoming.sensitive);
      const argTuning = this.taggedLines.has(next)
        ? { ...plan.argTuning, deliveryTags: true }
        : plan.argTuning;
      if (plan.argTuning.kind !== "system") prefetchSpeech(next, argTuning);
    } catch {
      /* the sentence is simply made when its turn comes */
    }
  }

  private cloudSpeechKeys: Record<string, boolean> = {};
  private cloudSpeechKeysAt = 0;
  private cloudSpeechBlockedUntil = 0;
  /** The reply being spoken (by run) was classified SENSITIVE as a whole: no clause of it may reach a cloud voice. */
  private replySensitiveRunId = "";
  private replySensitive = false;
  /** The heard command of the turn in flight was SENSITIVE: its whole reply stays on this PC, whatever the reply says. */
  private turnSensitive = false;
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

  /**
   * A heard "stop everything" (with or without the wake word, English, Roman Hindi or Devanagari) throws the same
   * kill switch as the button and says what stopped; the kill switch drops every open question with it. Only in a
   * live microphone session. True when it was taken.
   */
  private stopAllHeard(text: string): boolean {
    if (!this.micAllowed()) return false;
    const wake = matchWakeWord(text, wakeWord());
    const line = (wake.matched ? wake.command : text).trim();
    if (!line || !isStopEverything(line)) return false;
    this.trace("wake", "stop everything — the kill switch, before any open question");
    markTurnStage("routed", true, "", "stop everything");
    this.caption("user", text);
    this.conduct = { ...this.conduct, stopped: true };
    this.persistConduct();
    this.remember("stop-everything", line, "halted");
    this.cancelSpeech();
    this.state.pending = null;
    this.pendingHeard = null;
    clearPendingChange();
    this.state.interim = "";
    this.sayStopLine(stopEverythingFromVoice());
    return true;
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
      const made = startVoiceTask("Translation", async (task, context) => {
        await context.checkpoint();
        const done = await askBrain(translationPrompt(heard, to), {
          brain: ownedBrain(task.id),
          timeoutMs: 60_000,
        });
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
    startVoiceTask("Meeting minutes", async (task, context) => {
      await context.checkpoint();
      const done = await askBrain(minutesPrompt(note), {
        brain: ownedBrain(task.id),
        timeoutMs: 300_000,
      });
      await context.checkpoint();
      voiceNotes.setSummary(id, done.answer);
      return "The meeting minutes are saved with the note.";
    });
  }

  private readonly soak = new SoakRecorder();

  /**
   * The session record for the 30-minute hardware check, as JSON (see scripts/voice-hardware-validate.cjs soak), with
   * the turn engine shadow's agree and disagree counts beside it (numbers only: no audio, no transcript).
   */
  soakReport(): string {
    const shadow = this.turnShadow?.report() ?? null;
    return JSON.stringify(
      {
        ...this.soak.record(),
        turnShadow: shadow
          ? {
              counters: shadow.counters,
              lastTurn: shadow.lastTurn,
              calibration: shadow.calibration,
            }
          : null,
      },
      null,
      2,
    );
  }

  /** The turn engine in shadow (`voice.turn.classifier`). Null when off, before its first event, or after a fault. */
  private turnShadow: TurnEngineAdapter | null = null;
  /** The shadow threw once: it stays off for this session, and the live turn never saw the error. */
  private turnShadowBroken = false;

  /**
   * The shadow, made on first use. "off" makes none. "shadow" (the default) and "live" both run it as a shadow in
   * this build: nothing the engine or the classifier says is acted on, every action still comes from the live path.
   */
  private turnShadowAdapter(): TurnEngineAdapter | null {
    const turn = preferences.getSnapshot().voice.turn;
    if (this.turnShadowBroken || turn.classifier === "off") {
      this.turnShadow = null;
      return null;
    }
    // The adapter reads `voice.turn` once, when it is made: a later change to the longest wait or to calibration
    // makes a new one (its counters start again), so the change is never ignored.
    const key = `${turn.maxWaitMs}|${turn.calibrate}`;
    if (this.turnShadow && key !== this.turnShadowKey) this.turnShadow = null;
    if (!this.turnShadow) {
      this.turnShadowKey = key;
      this.turnShadow = new TurnEngineAdapter({
        handsFree: () => this.state.handsFree,
        maxWaitMs: turn.maxWaitMs,
        calibrate: turn.calibrate,
        startAt: Date.now(),
        expectNow: () => this.shadowExpect(),
      });
    }
    return this.turnShadow;
  }

  /** What the live adapter was built from (`voice.turn`), so a change to it is noticed. */
  private turnShadowKey = "";

  /** The session ends (Auto exit, Stop everything, mute): the shadow's numbers and audio go with it. */
  private dropTurnShadow(): void {
    this.turnShadow = null;
  }

  /** What the open turn is expected to be: a dictation while a voice note is open, a yes or no while one waits. */
  private shadowExpect(): TurnExpect | undefined {
    return voiceNotes.active() ? "dictation" : this.waitingForOwner() ? "yesno" : undefined;
  }

  /** Feed the shadow, in Auto mode only. A fault drops it for the session; the live turn goes on untouched. */
  private shadowTurn(feed: (a: TurnEngineAdapter) => void): void {
    if (this.state.mode !== "auto") return;
    try {
      const a = this.turnShadowAdapter();
      if (a) feed(a);
    } catch {
      this.turnShadowBroken = true;
      this.turnShadow = null;
    }
  }

  /**
   * The classifier's verdict beside the live gate's. The input is read now, at the live verdict; the classifier runs
   * in the returned call, which the caller makes after the live verdict was applied, so it never delays a stop.
   */
  private shadowBarge(
    verdict: GateVerdict,
    text: string | null,
    voiced: boolean,
    selfEcho: boolean,
  ): () => void {
    if (verdict.kind === "wait") return NO_SHADOW;
    return this.shadowLater(verdict.kind === "restore" ? "keep" : "takeover", () =>
      this.shadowBargeInput(text, voiced || Boolean(text), selfEcho),
    );
  }

  /** The classifier's verdict beside the final-transcript judge of a paused reply (run after it acted). */
  private shadowJudge(verdict: ReturnType<typeof judgeInterruption>, text: string): () => void {
    return this.shadowLater(verdict === "interrupt" ? "takeover" : "keep", () =>
      this.shadowBargeInput(text, true, this.isSelfEcho(text)),
    );
  }

  private shadowLater(live: BargeVerdict, read: () => InterruptionInput): () => void {
    let later = NO_SHADOW;
    this.shadowTurn((a) => {
      const input = read();
      const at = Date.now();
      a.holdAudioForVerdict();
      later = () => this.shadowTurn((b) => void (b === a && b.barge(live, input, at)));
    });
    return later;
  }

  /** What the classifier is told: read from the live state, never written back. The speaker is never a pass. */
  private shadowBargeInput(
    text: string | null,
    voiced: boolean,
    selfEcho: boolean,
  ): InterruptionInput {
    const now = Date.now();
    const since = this.replyStartedAt === null ? 0 : Math.max(0, now - this.replyStartedAt);
    const env = this.turnTracker.lastEnv?.kind;
    return {
      words: text ? text.trim().split(/\s+/).filter(Boolean) : [],
      voiceMs: 0,
      vadP: voiced ? 0.9 : 0.1,
      ttsPlaying: this.state.speaking || Boolean(this.interruptHold),
      playedMs: since,
      echoClean: !selfEcho && (this.gateLadder || this.echoCleanSourceNow()),
      scene: env ?? "quiet",
      speaker: "unknown",
      sinceTtsStartMs: since,
    };
  }

  private bargeDetector = new BargeInDetector();
  /** What the detector and the live pause did on this PC's devices, kept across restarts (shadow-evaluation.ts). */
  private bargeLedger = ShadowLedger.load(
    typeof localStorage === "undefined" ? null : localStorage,
  );
  private bargeShadow = new BargeShadow(700, (outcome) => this.bargeLedger.record(outcome));
  private bargeShadowOff: (() => void) | null = null;
  private bargeMicLevel = 0;
  /** When `bargeMicLevel` was measured: it is read only while fresh (frames flow only while she speaks). */
  private bargeMicAt = 0;
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
        const rawLevel = samples.length ? Math.sqrt(sum / samples.length) : 0;
        // With the echo reference running the capture is cleaned of her own voice: the level the detector compares
        // with the speaker is the cleaned one (a raw level would read her own sound as the owner's).
        const micLevel =
          (this.echoReferenceLive() ? cleanedLevel(performance.now()) : null) ?? rawLevel;
        const playbackLevel = speechRms();
        this.bargeMicLevel = micLevel;
        this.bargeMicAt = performance.now();
        // Time spent playing with the detector listening: the denominator of "false interruptions per hour".
        if (rate > 0) this.bargeLedger.addExposure((samples.length / rate) * 1000);
        const fired = this.bargeDetector.push({
          t: atMono,
          speech: voiceGate.heardSpeechWithin(250),
          micLevel,
          playbackLevel,
        });
        if (fired) this.bargeShadow.detectorFired(performance.now(), { playbackLevel, micLevel });
        if (this.interruptGate.active) this.shadowTurn((a) => a.audio(samples, rate));
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

  /** How the utterance being handled scored against the owner's saved voice (null: no saved voice, or not scored). */
  private turnVoice: VoiceMatchResult | null = null;
  /** The owner's own "Friday" template woke her for this turn although the transcript did not carry the word. */
  private turnPersonalWake = false;
  /** A voice is saved but this turn came from a recogniser that gives no audio to score (Sarvam's final text). */
  private turnUnverified = false;

  /** The saved-voice verdict for the turn being handled. It can only block, never approve. */
  private speakerVerdict(sensitive: boolean) {
    return speakerDecision({
      ...speakerInput(this.turnVoice, this.voiceSettings(), this.turnUnverified),
      sensitive,
    });
  }

  /** The line spoken when the saved voice stops a command or an approval. */
  private speakerRefusal(reason: string): string {
    return reason === "speaker-unverified"
      ? "I could not check your voice on this recogniser. Confirm it on the desktop."
      : "That did not match the saved voice. Confirm it on the desktop.";
  }

  /** When "Still waiting for yes or no" was last said, so a talkative room is not answered line after line. */
  private lastStillWaitingAt = 0;

  /** When a different voice's "yes" was last refused out loud, so a repeated yes is not answered every time. */
  private lastApprovalMismatchAt = 0;

  /**
   * A spoken "yes" that would finish an approval must not come from a clearly different voice. The same rule as
   * for the command itself: the saved voice can only block, never approve, and a voice that cannot be told apart
   * (too little speech, no saved voice, Recognise my voice off) passes exactly as before. A refused yes leaves the
   * approval waiting, so the owner can still say it inside the window or confirm on the desktop.
   */
  private approvalVoiceAllows(heard: string): boolean {
    const speaker = this.speakerVerdict(true);
    if (speaker.allow) return true;
    this.remember(
      speaker.reason === "speaker-unverified" ? "speaker-unverified" : "speaker-mismatch",
      heard,
      "approval not accepted: the saved voice could not confirm it",
    );
    const refused = this.speakerRefusal(speaker.reason);
    if (Date.now() - this.lastApprovalMismatchAt > 4000) {
      this.lastApprovalMismatchAt = Date.now();
      this.caption("friday", refused);
      this.speak(refused);
    }
    this.emit();
    return false;
  }

  /** The owner's choices about their saved voice, read when a turn is handled. */
  private voiceSettings(): VoiceSettingsView {
    const snapshot = preferences.getSnapshot();
    return {
      recogniseMyVoice: snapshot.voice.recogniseMyVoice !== false,
      ownerVoiceOnly: snapshot.voice.ownerVoiceOnly === true,
      personalWake: snapshot.voice.personalWake !== false,
      threshold: parseThreshold(snapshot.fields["speakerThreshold"]),
    };
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
        // The billing firewall, read now and failing closed: a lane with no free-allowance proof needs paid access.
        billingAllowsPaid: billingAllowsPaidNow(),
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
    // A short line while a yes or no is open is the answer: it is never held back as a copy (once per id).
    const approvalOpen = Boolean(
      this.state.pending ||
      this.pendingHeard ||
      this.approvalAsked ||
      this.restartAsk ||
      brain.getSnapshot().approval,
    );
    const copy = this.finalDeduper.check({
      text: trimmed,
      source: utterance.source,
      approvalOpen,
      alwaysPass: this.isStopHeard(trimmed, false),
      replyStartedAt: this.replyStartedAt,
      ...(utterance.turnId ? { utteranceId: utterance.turnId } : {}),
    });
    if (
      !copy.pass ||
      (!copy.exempt &&
        !(this.replyStartedAt !== null && this.replyStartedAt >= this.lastFinalAt) &&
        duplicateFinalUtterance(this.lastFinalText, trimmed, Date.now() - this.lastFinalAt))
    ) {
      this.trace(
        "dropped",
        copy.pass
          ? "duplicate finalized utterance"
          : `duplicate finalized utterance (${copy.reason}, ${Math.round(copy.ageMs)} ms after the first)`,
      );
      this.state.interim = "";
      this.to("transcript");
      this.emit();
      return;
    }
    this.lastFinalText = trimmed;
    this.lastFinalAt = Date.now();
    // The acknowledgement's own words come back late too: they are dropped on their own clock, whether or not a
    // reply is playing (the ack never sets the speaking state).
    if ((this.recentlySpeaking() && this.isSelfEcho(text)) || this.ackEchoHeard(text)) {
      this.trace("dropped", "ignored FRIDAY's own voice (echo)");
      this.to("transcript");
      return;
    }
    // Only his own voice teaches the baseline: FRIDAY's own speech coming back through the microphone, and a
    // repeated line, were being measured as him, which pushed his "usual" voice and made every real turn read tense.
    this.turnVoice = meta?.voice ?? null;
    this.turnUnverified = utterance.source !== "local" && voiceProfileBuilt();
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
    const record = buildTurnRecord({
      text: trimmed,
      textRaw: text,
      declaredLanguage: meta?.quality?.language || preferences.getSnapshot().voice.recognitionLang,
      confidence: heardConfidence(trimmed, meta?.quality),
      facts: this.turnTracker.take(Date.now()),
      interruptedPlayedMs: this.lastInterruptedPlayedMs,
    });
    // The turn's language: the ear's locked language wins over the script heuristic when it is sure (the tracker keeps
    // `streamLang` only at a lock of at least STREAM_LANG_MIN_CONF). The reply hint and the voice follow this one.
    this.turnRecord = {
      ...record,
      lang: preferStreamLang(record.lang, record.streamLang, STREAM_LANG_MIN_CONF),
    };
    // The room and the voice reach only the addressedness gate, which can only ADD a wake requirement.
    this.addressFacts = {
      ...(record.env ? { scene: record.env } : {}),
      ...(record.speaker ? { speaker: record.speaker.tag } : {}),
    };
    this.lastInterruptedPlayedMs = null;
    this.turnRecordLive = true;
    this.heardSpeaker =
      record.speaker && (!record.env || record.env.kind === "speech") ? record.speaker.tag : null;
    this.heardTurnId = this.turnRecord.turnId;
    // A yes is judged on the ear's sureness band and on when its voice began (both numbers; never the speaker or the
    // room), for this turn only.
    const began = this.streamTurnBegan;
    this.heardEar = {
      asrBand: this.turnRecord.confidence === null ? null : this.turnRecord.asrBand,
      beganAt: began && began.turnId === this.turnRecord.turnId ? began.at : null,
    };
    // The canonical code-mixed line (script policy) is what the turn acts on; the raw words stay in the record.
    const line = this.turnRecord.canonical || text;
    const stoppedAtFinal = this.stopped();
    this.heardRaw = text;
    try {
      this.handleHeard(this.turnRecord.canonical || text, meta?.wake ?? null);
    } finally {
      this.heardEar = null;
      this.heardRaw = "";
      // The shadow hears of the final after the live path has handled it (a final dropped for Stop everything is no turn).
      if (!stoppedAtFinal) this.shadowTurn((a) => a.liveFinal(line, this.lastOwnerAt));
    }
  }

  /**
   * The record of the turn being handled: its words, language mix, confidence and the ear's facts about it. Tags
   * only; the speaker and the room never feed an approval, a confirmation or an authority check.
   */
  lastTurn(): TurnRecord | null {
    return this.turnRecord;
  }

  /** The five language and confidence hints of the heard turn for the Brain. Never the speaker or the room. */
  private turnHints(): TurnHints | undefined {
    if (this.replayTurn) return this.replayTurn.hints;
    const t = this.turnRecord;
    if (!t) return undefined;
    return {
      lang: t.lang,
      mix: t.mix,
      confidence: t.confidence,
      eager: t.eager,
      clipped: t.clipped,
    };
  }

  private turnHintsOption() {
    const turn = this.turnHints();
    return turn ? { turn } : {};
  }

  /**
   * The reply is pinned to Hindi, or the heard turn is Hindi (the ear's lock or the script) and the reply follows the owner's language: the reply is
   * spoken through the Hindi voice and lexicon path even when the chosen voice language is English.
   */
  private turnSpeaksHindi(): boolean {
    const pin = replyIdentity.getSnapshot().profile.replyLanguage;
    // A reply language pinned to Hindi is always spoken through the Hindi path; any other pin is not Hindi.
    if (pin === "hindi") return true;
    if (pin !== "follow-user") return false;
    return this.turnHints()?.lang === "hi";
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
          billingAllowsPaid: billingAllowsPaidNow(),
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
      if (Date.now() < this.cloudSpeechBlockedUntil || this.turnSensitive || looksSensitive(text))
        return null;
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
          billingAllowsPaid: billingAllowsPaidNow(),
          // The whole reply, not just this clause: a harmless clause of a sensitive reply stays on this PC.
          ...(this.replySensitive || this.turnSensitive ? { sensitiveReply: true } : {}),
        },
        {
          ledger,
          persistLedger: () => saveLedger(store, ledger),
          ...(provider === "sarvam" && cloud.streaming
            ? {
                speak: (
                  p: string,
                  r: {
                    text: string;
                    language: string;
                    speaker?: string;
                    pace?: number;
                    sensitiveReply?: boolean;
                  },
                ) => this.streamingSpeak().speak(p, r),
              }
            : {}),
        },
      );
      if (!out.ok) {
        // A refusal for a sensitive reply is the rule working, not a failing provider: no cool-down for the next reply.
        if (!this.replySensitive && !this.turnSensitive)
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
  private playSpoken(spoken: string, gen: number, sensitive = false): Promise<void> {
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
    const plan = this.speakPlan(stripDeliveryTags(spoken), false, sensitive);
    const { fallen, tuning, privacy, tone } = plan;
    this.state.tts = { ...this.state.tts, engine: fallen };
    const out = outputReachable({
      deviceId: cachedOutputSinkId(preferences.getSnapshot().voice.outputDeviceId),
      volume: tone.volume,
    });
    if (!out.ok) this.state.status = out.reason;
    // What she says aloud and what the echo filter compares against has no delivery tags; the voice gets them.
    this.spokenText = stripDeliveryTags(spoken);
    const tagged = this.taggedLines.delete(spoken);
    const first = this.firstLine !== "" && this.firstLine === spoken;
    if (first) this.firstLine = "";
    const argTuning = tagged ? { ...plan.argTuning, deliveryTags: true } : plan.argTuning;
    this.openFollowUp();
    // The next sentence, if it is already waiting, is made while this one plays.
    this.prefetchNext(gen);
    return speakText(spoken, argTuning, {
      ...(first ? { first: true } : {}),
      onFirstAudio: () => {
        if (gen === this.speechGen) this.turnStages.mark("ttsFirstAudioReceived");
      },
      onStart: () => {
        if (gen !== this.speechGen) return;
        this.shadowTurn((a) => a.tts("first-audio", `g${gen}`, 0, Date.now()));
        this.turnStages.mark("playbackFirstSample");
        if (!this.budgetRecorded) this.budgetRecorded = recordTurnBudget(this.turnStages);
        this.replyStartedAt = Date.now();
        this.noteApprovalSpoken("start");
        this.bargeDetector.playbackStarted(performance.now());
        this.openEchoWindow(spoken);
        if (this.to("tts-start")) this.pauseForSpeech();
        this.emit();
      },
      onEnd: () => {
        if (gen !== this.speechGen) return;
        this.shadowTurn((a) =>
          a.tts(
            this.arbiter.size() ? "clause-end" : "drained",
            `g${gen}`,
            this.replyStartedAt === null ? 0 : Date.now() - this.replyStartedAt,
            Date.now(),
          ),
        );
        this.bargeDetector.playbackEnded();
        this.echoUntil = Date.now() + ECHO_TAIL_MS;
        this.noteApprovalSpoken("end");
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
        } else {
          // The state machine skipped the resume (an error, a pause, off): her reply is still over for the wake gate.
          voiceGate.wake.speakEnd(performance.now());
        }
        this.emit();
      },
    })
      .then((how) => {
        if (gen !== this.speechGen) return;
        const route = lastSpeechRoute();
        const failureReason = how === "none" ? this.localVoiceFailureReason(route) : "";
        const engine =
          how === "none"
            ? "none"
            : route.engine.includes("supertonic")
              ? "supertonic"
              : route.engine === "sapi"
                ? "sapi"
                : how;
        if (engine === "supertonic") this.supertonicBreakerUntil = 0;
        this.state.tts = {
          engine,
          voice: route.voiceId || tuning.voiceName || "",
          lastSpokenAt: how === "none" ? this.state.tts.lastSpokenAt : Date.now(),
          lastError:
            how === "none"
              ? `no speech engine could speak the reply${failureReason ? ` (${failureReason})` : ""}`
              : null,
        };
        if (how !== "none" && (route.note || (route.voiceId && !route.cloud))) {
          this.state.status = statusWithVoice(this.state.status);
        }
        this.trace("segment", `tts engine: ${how.toUpperCase()}`);
        // Raw-sample playback is opt-in: say when a clause used it, and why it was given up (never silent).
        const pcmNote = pcmPlaybackNote();
        if (pcmNote && pcmNote !== this.pcmNoteSaid) {
          this.pcmNoteSaid = pcmNote;
          this.trace("segment", pcmNote);
        }
        markTurnStage(
          "spoken",
          how !== "none",
          "no speech engine could speak the reply",
          `${engine}${route.voiceId ? ` · ${route.voiceId}` : ""}${lastClipUsedPcm() ? " · pcm" : ""}${pcmNote ? ` · ${pcmNote}` : ""}`,
        );
        this.trace("segment", `turn: ${turnTraceLine(voiceTurn())}`);
        if (how !== "none") {
          this.noteTtsOutcome(true);
          return;
        }
        this.noteTtsOutcome(false);
        this.to("tts-failed");
        this.state.speaking = false;
        voiceGate.setSpeakingGuard(false);
        voiceGate.wake.speakEnd(performance.now());
        this.echoUntil = Date.now() + 400;
        this.state.error = noVoiceFailure(spoken, failureReason);
        // The status line says why too, not only that the voice failed.
        if (failureReason) this.state.status = `Voice failed: ${failureReason}`;
        this.emit();
      })
      .catch((error: unknown) => {
        if (gen !== this.speechGen) return;
        const detail = String((error as Error)?.message || error);
        this.state.tts = { ...this.state.tts, engine: "none", lastError: detail };
        markTurnStage("spoken", false, detail);
        this.noteTtsOutcome(false);
        this.to("tts-failed");
        this.state.speaking = false;
        voiceGate.setSpeakingGuard(false);
        voiceGate.wake.speakEnd(performance.now());
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

  /** Classify the reply read so far once per reply: one sensitive part marks every clause of it. */
  private noteReplySensitivity(runId: string, text: string) {
    if (this.replySensitiveRunId !== runId) {
      this.replySensitiveRunId = runId;
      this.replySensitive = this.turnSensitive;
    }
    if (!this.replySensitive && looksSensitive(text)) this.replySensitive = true;
  }

  private speakStreamed(runId: string, text: string, final: boolean) {
    if (!text.trim()) return;
    if (isBootHolding()) return;
    this.noteReplySensitivity(runId, text);
    if (this.interruptHold) {
      // Paused for a possible interruption: keep the newest text and say it if the owner only nodded along.
      this.deferredStream = { runId, text, final };
      return;
    }
    if (this.voicedRunId !== runId) {
      this.voicedRunId = runId;
      this.voicedChars = 0;
      this.voicedPrefix = "";
      this.firstClauseDue = true;
      // The clauses heard of an earlier reply are not part of this one.
      beginPlayedReply(runId);
    }
    const rewind = nextSpokenCursor(this.voicedChars, text.length, {
      prefix: this.voicedPrefix,
      text,
    });
    if (rewind.rewritten) {
      this.unfinished = "";
      this.dropPlayback(false);
      // The whole reply is spoken again from its first word.
      beginPlayedReply(runId, true);
      this.voicedChars = 0;
      this.voicedPrefix = "";
      this.firstClauseDue = true;
    }
    if (text.length < this.voicedChars) return;
    // The tags the model wrote for this spoken reply, put back where they stood in the words being handed to the voice
    // (the screen text has none). Only a spoken turn in Auto mode has a script, and it must match the shown words.
    const anchors: TagAnchor[] =
      this.state.mode === "auto" ? alignedAnchors(brain.deliveryScript(runId), text) : [];
    const voiceReply = (parts: string[], before: string) => {
      for (const piece of reinsertParts(parts, before, anchors)) {
        // One queue item per sentence, so the first sentence sounds while the rest wait and none is capped away.
        for (const sentence of sentencesOfPiece(piece)) {
          const first = this.firstClauseDue;
          this.firstClauseDue = false;
          this.speak(sentence, { reply: true, ...(first ? { first: true } : {}) });
        }
      }
    };
    // Which rule cuts the next clause: the first-clause rule opens a reply fast (opt-in) and, whenever the speaker is
    // close to running dry with nothing queued, shortens the next clause; otherwise a clause is a whole sentence.
    const rule = pickClauseRule({
      firstOfReply: this.voicedChars === 0,
      fastFirst: preferences.getSnapshot().voice.fastFirstClause === true,
      underrunRisk: playbackPressure()?.underrunRisk === true,
      queued: this.arbiter.size(),
    });
    const fast = rule === "first";
    const cut =
      rule === "sentence" ? null : firstClauseCut(text.slice(this.voicedChars), { final });
    if (cut) {
      this.stampFirstClause();
      const before = text.slice(0, this.voicedChars);
      this.voicedChars += cut.consumed;
      this.voicedPrefix = text.slice(0, this.voicedChars);
      voiceReply(splitLongSpeech(cut.spoken), before);
    }
    const pending = text.slice(this.voicedChars);
    let chunk = takeSpeakable(pending, final);
    if (!chunk.spoken && this.voicedChars === 0 && !fast && this.realtimeActive())
      chunk = earlyClause(pending);
    if (!chunk.spoken && !cut) return;
    if (chunk.spoken) {
      this.stampFirstClause();
      const before = text.slice(0, this.voicedChars);
      this.voicedChars += chunk.consumed;
      this.voicedPrefix = text.slice(0, this.voicedChars);
      voiceReply(splitLongSpeech(chunk.spoken), before);
    }
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
    voiceGate.wake.speakStart(performance.now());
    voiceGate.setSpeakingGuard(true);
    voiceGate.duck(false);
  }

  private resumeAfterSpeech() {
    voiceGate.wake.speakEnd(performance.now());
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

  /**
   * A short question asked beside a running task is answered by the quick lane: show it and say it now. The
   * message is marked as read so the run's own answer, spoken when it ends, does not repeat it.
   */
  private speakQuickAnswer(answer: QuickAnswer) {
    if (!spokenReplyAllowed(this.state.mode, false) || this.stopped()) return;
    const { messages } = brain.getSnapshot();
    const at = messages.findIndex((message) => message.id === answer.messageId);
    if (at < 0 || at < this.spokenUpTo) return;
    this.spokenUpTo = at + 1;
    this.caption("friday", answer.text);
    this.emit();
    this.speak(answer.text);
  }

  /** Read back FRIDAY's answers while auto mode is on. */
  private speakNewReplies() {
    if (!spokenReplyAllowed(this.state.mode, false)) return;
    this.voiceBrainApproval();
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
      const owner = live?.owner;
      if (owner?.kind === "task") {
        // A background run is not the foreground turn: its words are never streamed as a reply. The task desk
        // announces it once, through the narration policy, and a named tool step may be said now and then.
        const task =
          detail && toolKey !== this.narratedTool ? this.deskTask(owner.taskId) : undefined;
        if (task && detail) {
          this.narratedTool = toolKey;
          this.narrateTask({ taskId: task.id, kind: "progress", text: detail }, task);
        }
        return;
      }
      if (detail && toolKey && toolKey !== this.narratedTool && !this.callHold) {
        this.narratedTool = toolKey;
        // Said only when the step has really taken a while, in different words each time.
        const line = this.narrator.say("tool", {
          text: live?.prompt || "",
          detail,
          elapsedMs: Date.now() - (live?.startedAt ?? Date.now()),
        });
        if (line && !this.state.speaking && !this.arbiter.size() && this.voicedChars === 0) {
          this.caption("friday", line);
          this.speak(line, { priority: "chatter" });
        }
      }
      if (live?.answer) {
        this.turnStages.mark("brainFirstToken");
        markTurnStage("model", true, "", live.answeredBy?.line || "answering");
        this.speakStreamed(live.id, live.answer, false);
      }
      return;
    }
    if (messages.length <= this.spokenUpTo) {
      this.spokenUpTo = messages.length;
      return;
    }
    const everything = messages.slice(this.spokenUpTo);
    this.spokenUpTo = messages.length;
    for (const message of everything) {
      if (message.role === "user") this.captionUserTurn(message.text);
    }
    // A background run's answer is announced by the task desk ("Done: X"), not read out as a foreground reply.
    const fresh = everything.filter(
      (m) => m.role === "user" || runs.find((row) => row.id === m.runId)?.owner?.kind !== "task",
    );
    if (fresh.length < everything.length && !fresh.some((m) => m.role !== "user")) {
      this.emit();
      return;
    }
    const say = joinSpoken(fresh.filter((m) => m.role !== "user").map((m) => m.text));
    if (!say) {
      markTurnStage("reply", false, "the model returned an empty reply");
      // A reply that came back empty is still answered: one short line, never silence.
      if (fresh.some((m) => m.role !== "user")) {
        const line =
          this.narrationLang() === "hi"
            ? "Iska koi jawab nahi mila."
            : "I have nothing to say to that.";
        this.caption("friday", line);
        this.emit();
        this.speak(line);
        return;
      }
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
    else this.turnStages.mark("brainFirstToken"); // an answer that never streamed is first seen whole
    this.speakStreamed(runId || "reply", spoken, true);
  }
}

export const assistantMode = new AssistantModeStore();

// A staged "hands-free" change shows the live value, never a guess.
setHandsFreeReader(() => assistantMode.getSnapshot().handsFree);
// The narration policy decides what a task update says; the plain announcer is only the fallback without it.
attachVoiceTaskSpeaker(
  (text) => assistantMode.announceTask(text, { priority: "direct" }),
  () => assistantMode.taskBusy(),
);
attachVoiceTaskNarrator((update, task) => assistantMode.narrateTask(update, task));
attachVoiceTaskWork((request) => assistantMode.backgroundWork(request));

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
