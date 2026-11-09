/**
 * FRIDAY · the voice supervisor.
 *
 * The microphone watch (`micWatch`) catches a dead track or missing frames, and the heal policy mends a named
 * fault. Neither notices a pipeline that is simply stuck in a state: transcribing for a minute after the engine
 * died, "thinking" with no turn running, "speaking" with nothing playing. The owner then sees "Listening" frozen
 * and has to press a button. This reads how long the session has been in its state and says what to do about it.
 *
 * Pure: the caller passes the clock and the facts, and carries out the verdict through the one heal policy.
 */
import type { HealClass } from "./voice-heal";
import type { VoiceState } from "./voice-state";

export type SupervisorInput = {
  mode: string;
  paused: boolean;
  state: VoiceState;
  /** How long the session has been in `state`. */
  ageMs: number;
  /** The Brain has a turn running. */
  brainActive: boolean;
  /** Replies are waiting to be said. */
  speechQueued: boolean;
  /** Audio is coming out of the speaker right now. */
  speaking: boolean;
  /** A speech model is being fetched (a first load is slow on purpose, not stuck). */
  downloading: boolean;
};

export type SupervisorVerdict =
  | { act: false }
  | {
      act: true;
      state: VoiceState;
      /** What to do: let go of the state, restart the speech engine, reopen the microphone, or run a full check. */
      remedy: "release" | "restart-speech" | "reopen-mic" | "self-check";
      fault: HealClass | "none";
      reason: string;
    };

/** How long each state may last before it is called stuck. A long reply and a long task are not stuck. */
export const STUCK_AFTER_MS: Partial<Record<VoiceState, number>> = {
  STARTING: 45_000,
  SPEECH_DETECTED: 90_000,
  TRANSCRIBING: 75_000,
  WAKE_DETECTED: 120_000,
  COMMAND_LISTENING: 120_000,
  THINKING: 30_000,
  SPEAKING: 45_000,
  INTERRUPTED: 60_000,
  ERROR: 120_000,
};

export function superviseVoice(input: SupervisorInput): SupervisorVerdict {
  if (input.mode !== "auto" || input.paused) return { act: false };
  const limit = STUCK_AFTER_MS[input.state];
  if (limit === undefined || input.ageMs < limit) return { act: false };
  const seconds = Math.round(input.ageMs / 1000);
  switch (input.state) {
    case "STARTING":
      return {
        act: true,
        state: input.state,
        remedy: "reopen-mic",
        fault: "mic-no-device",
        reason: `the microphone had not opened after ${seconds} s`,
      };
    case "SPEECH_DETECTED":
      return {
        act: true,
        state: input.state,
        remedy: "reopen-mic",
        fault: "mic-no-frames",
        reason: `speech detection stayed on for ${seconds} s`,
      };
    case "TRANSCRIBING":
      // A model that is still being fetched or loaded for the first time is slow, not stuck.
      if (input.downloading) return { act: false };
      return {
        act: true,
        state: input.state,
        remedy: "restart-speech",
        fault: "stt-engine-crash",
        reason: `transcribing for ${seconds} s with no answer`,
      };
    case "THINKING":
      // A turn that is really running (a long task) is not stuck; "thinking" with nothing running is.
      if (input.brainActive || input.speechQueued) return { act: false };
      return {
        act: true,
        state: input.state,
        remedy: "release",
        fault: "none",
        reason: `thinking for ${seconds} s with no turn running`,
      };
    case "SPEAKING":
      if (input.speaking || input.speechQueued) return { act: false };
      return {
        act: true,
        state: input.state,
        remedy: "release",
        fault: "tts-engine-fail",
        reason: `speaking for ${seconds} s with nothing playing`,
      };
    case "ERROR":
      return {
        act: true,
        state: input.state,
        remedy: "self-check",
        fault: "none",
        reason: `in error for ${seconds} s`,
      };
    default:
      return {
        act: true,
        state: input.state,
        remedy: "release",
        fault: "none",
        reason: `waiting in ${input.state.toLowerCase().replace(/_/g, " ")} for ${seconds} s`,
      };
  }
}

/** A verdict is not repeated until this long after the last one for the same state. */
export const SUPERVISOR_COOLDOWN_MS = 60_000;
