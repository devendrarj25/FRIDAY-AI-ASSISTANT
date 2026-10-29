/**
 * FRIDAY · voice state machine.
 *
 * Auto Mode used to describe itself with three loose booleans (`listening`,
 * `speaking`, `awake`). That could not express "transcribing", "interrupted"
 * or "waiting for confirmation", and the UI ended up *inferring* state instead
 * of being told it. This module is the single, explicit definition of what
 * FRIDAY's voice session can be, and which real pipeline event moves it.
 *
 * Rules:
 *   · every transition is driven by a REAL event (mic opened, VAD triggered,
 *     transcript returned, wake matched, brain replied, TTS started/stopped);
 *   · an event that is not legal in the current state is ignored, never
 *     silently applied — the caller can log the rejection;
 *   · the legacy booleans are DERIVED from the state so every existing reader
 *     (tray tooltip, HUD, tests) keeps working unchanged.
 */

export type VoiceState =
  | "OFF"
  | "STARTING"
  | "LISTENING"
  | "SPEECH_DETECTED"
  | "TRANSCRIBING"
  | "WAKE_DETECTED"
  | "COMMAND_LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "WAITING_CONFIRMATION"
  | "PAUSED"
  | "ERROR"
  | "STOPPING";

export type VoiceEvent =
  /** Auto Mode switched on — the session is being built. */
  | "session-start"
  /** The shared microphone stream is really open. */
  | "mic-opened"
  /** The microphone (or the local recogniser) could not be opened. */
  | "mic-failed"
  /** The signal VAD classified the input as speech. */
  | "vad-speech"
  /** The VAD went quiet again with no utterance captured. */
  | "vad-silence"
  /** An utterance was handed to faster-whisper. */
  | "transcribe-start"
  /** A transcript came back (empty or not). */
  | "transcript"
  /** The wake engine (openWakeWord or the transcript fallback) matched. */
  | "wake-matched"
  /** Heard speech that was not addressed to FRIDAY. */
  | "wake-missed"
  /** A command was accepted and sent to the brain. */
  | "command-accepted"
  /** The brain produced its final answer. */
  | "brain-replied"
  /** A consequential action needs an explicit yes/no. */
  | "confirm-required"
  /** The confirmation was answered (either way). */
  | "confirm-resolved"
  /** Text-to-speech actually started producing audio. */
  | "tts-start"
  /** Text-to-speech finished normally. */
  | "tts-end"
  /** No engine could speak the reply. */
  | "tts-failed"
  /** The owner spoke over FRIDAY. */
  | "barge-in"
  /** "Pause listening" from the tray. */
  | "pause"
  | "resume"
  /** Any reported pipeline failure. */
  | "error"
  /** Auto Mode switched off. */
  | "session-stop"
  /** Teardown finished. */
  | "stopped";

/** States in which the microphone is genuinely open and capturing. */
const MIC_OPEN: VoiceState[] = [
  "LISTENING",
  "SPEECH_DETECTED",
  "TRANSCRIBING",
  "WAKE_DETECTED",
  "COMMAND_LISTENING",
  "THINKING",
  "SPEAKING",
  "INTERRUPTED",
  "WAITING_CONFIRMATION",
];

/** Events that are legal from ANY state — they describe the session itself. */
const GLOBAL: Partial<Record<VoiceEvent, VoiceState>> = {
  pause: "PAUSED",
  "session-stop": "STOPPING",
  stopped: "OFF",
  "mic-failed": "ERROR",
  error: "ERROR",
};

const TABLE: Record<VoiceState, Partial<Record<VoiceEvent, VoiceState>>> = {
  OFF: { "session-start": "STARTING", resume: "STARTING" },
  STARTING: { "mic-opened": "LISTENING" },
  LISTENING: {
    "vad-speech": "SPEECH_DETECTED",
    "transcribe-start": "TRANSCRIBING",
    "wake-matched": "WAKE_DETECTED",
    "tts-start": "SPEAKING",
    "confirm-required": "WAITING_CONFIRMATION",
  },
  SPEECH_DETECTED: {
    "transcribe-start": "TRANSCRIBING",
    "vad-silence": "LISTENING",
    transcript: "LISTENING",
    "wake-matched": "WAKE_DETECTED",
    "barge-in": "INTERRUPTED",
  },
  TRANSCRIBING: {
    transcript: "LISTENING",
    "wake-matched": "WAKE_DETECTED",
    "wake-missed": "LISTENING",
    "command-accepted": "THINKING",
    "vad-speech": "SPEECH_DETECTED",
  },
  WAKE_DETECTED: {
    "command-accepted": "THINKING",
    "confirm-required": "WAITING_CONFIRMATION",
    "vad-speech": "SPEECH_DETECTED",
    transcript: "COMMAND_LISTENING",
    "tts-start": "SPEAKING",
  },
  COMMAND_LISTENING: {
    "vad-speech": "SPEECH_DETECTED",
    "transcribe-start": "TRANSCRIBING",
    "command-accepted": "THINKING",
    "wake-missed": "LISTENING",
    "tts-start": "SPEAKING",
  },
  THINKING: {
    "brain-replied": "LISTENING",
    "tts-start": "SPEAKING",
    "confirm-required": "WAITING_CONFIRMATION",
    "vad-speech": "SPEECH_DETECTED",
    "transcribe-start": "TRANSCRIBING",
  },
  SPEAKING: {
    "tts-end": "LISTENING",
    "tts-failed": "LISTENING",
    "barge-in": "INTERRUPTED",
    "vad-speech": "SPEECH_DETECTED",
  },
  INTERRUPTED: {
    "transcribe-start": "TRANSCRIBING",
    "vad-speech": "SPEECH_DETECTED",
    "vad-silence": "LISTENING",
    transcript: "LISTENING",
    "wake-matched": "WAKE_DETECTED",
  },
  WAITING_CONFIRMATION: {
    "confirm-resolved": "THINKING",
    "vad-speech": "SPEECH_DETECTED",
    "transcribe-start": "TRANSCRIBING",
    transcript: "WAITING_CONFIRMATION",
    "tts-start": "SPEAKING",
    "tts-end": "WAITING_CONFIRMATION",
  },
  PAUSED: { resume: "STARTING", "session-stop": "STOPPING" },
  ERROR: {
    "mic-opened": "LISTENING",
    resume: "STARTING",
    "session-start": "STARTING",
  },
  STOPPING: { stopped: "OFF", "session-start": "STARTING" },
};

/**
 * The next state for a real pipeline event, or `null` when the event is not
 * legal here (the caller keeps the current state and records the rejection).
 */
export function nextVoiceState(current: VoiceState, event: VoiceEvent): VoiceState | null {
  const specific = TABLE[current]?.[event];
  if (specific) return specific === current ? null : specific;
  // A PAUSED session must not be dragged back into LISTENING by a stray
  // pipeline event, so globals are only applied where they make sense.
  if (current === "PAUSED" && (event === "pause" || event === "stopped")) return null;
  const global = GLOBAL[event];
  if (global) return global === current ? null : global;
  return null;
}

/** Compact Auto Mode graphic phase — derived only from the formal voice state. */
export type VoicePhase = "off" | "listening" | "hearing" | "thinking" | "speaking" | "unavailable";

/**
 * Map the 14-state machine onto the Auto Mode graphic phases.
 * STARTING / STOPPING / OFF never report "listening". PAUSED and ERROR are
 * unavailable, not idle-listening.
 */
export function voicePhaseFromState(
  mode: "auto" | "manual" | string,
  state: VoiceState,
): VoicePhase {
  if (mode !== "auto") return "off";
  switch (state) {
    case "ERROR":
    case "PAUSED":
      return "unavailable";
    case "SPEAKING":
      return "speaking";
    case "THINKING":
    case "WAITING_CONFIRMATION":
      return "thinking";
    case "SPEECH_DETECTED":
    case "TRANSCRIBING":
    case "WAKE_DETECTED":
      return "hearing";
    case "LISTENING":
    case "COMMAND_LISTENING":
    case "INTERRUPTED":
      return "listening";
    default:
      return "off";
  }
}

/** True when the microphone is genuinely capturing in this state. */
export function stateIsListening(state: VoiceState): boolean {
  return MIC_OPEN.includes(state);
}

/** True only while FRIDAY is actually producing speech. */
export function stateIsSpeaking(state: VoiceState): boolean {
  return state === "SPEAKING";
}

/** The short human line the HUD shows for a state. */
export function stateLabel(state: VoiceState): string {
  switch (state) {
    case "OFF":
      return "Manual mode";
    case "STARTING":
      return "Starting microphone…";
    case "LISTENING":
      return "Listening…";
    case "SPEECH_DETECTED":
      return "Hearing you…";
    case "TRANSCRIBING":
      return "Transcribing…";
    case "WAKE_DETECTED":
      return "Awake — go ahead";
    case "COMMAND_LISTENING":
      return "Listening for the command…";
    case "THINKING":
      return "Thinking…";
    case "SPEAKING":
      return "Speaking…";
    case "INTERRUPTED":
      return "Stopped — listening";
    case "WAITING_CONFIRMATION":
      return "Waiting for confirmation";
    case "PAUSED":
      return "Microphone paused";
    case "ERROR":
      return "Voice error";
    case "STOPPING":
      return "Stopping…";
  }
}
