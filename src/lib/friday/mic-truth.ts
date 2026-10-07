/** Why a microphone open failed, and the next capture to try. */

export type MicCause =
  "own-capture" | "other-app" | "exclusive" | "no-device" | "permission" | "unknown";

const CALL_APPS = [/teams/i, /zoom/i, /discord/i, /voiceaccess/i, /phoneexperience/i, /phonelink/i];

export function classifyMicHold(input: {
  name: string;
  ownTracks: number;
  holders?: string[];
  exclusiveHint?: boolean;
}): { cause: MicCause; reason: string; next: string } {
  const name = input.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      cause: "permission",
      reason: "Windows has not granted microphone permission to this app.",
      next: "Open Windows privacy, microphone, and allow desktop apps. Then choose Fix voice.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      cause: "no-device",
      reason: "No audio input is present.",
      next: "Plug in a microphone or pick another input, then choose Fix voice.",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    if (input.ownTracks > 0) {
      return {
        cause: "own-capture",
        reason: "FRIDAY already holds a microphone track, or a previous track was not stopped.",
        next: "The live track is released, then capture starts once.",
      };
    }
    const holder = (input.holders ?? []).find((app) => CALL_APPS.some((rule) => rule.test(app)));
    if (holder) {
      return {
        cause: "other-app",
        reason: `${holder} is holding the microphone.`,
        next: `Leave ${holder}, then choose Fix voice.`,
      };
    }
    if (input.exclusiveHint) {
      return {
        cause: "exclusive",
        reason: "Windows exclusive mode or the driver refused a shared open.",
        next: "Sound settings, the input device, Advanced, turn off exclusive mode, then Fix voice.",
      };
    }
    return {
      cause: "exclusive",
      reason:
        "The input did not open. This is the exclusive-mode or driver case, not a named call app.",
      next: "Sound settings, the input device, Advanced, turn off exclusive mode. Then Fix voice.",
    };
  }
  return {
    cause: "unknown",
    reason: "The microphone did not open.",
    next: "Choose Fix voice to try the system default input.",
  };
}

export type RelaxedStep = {
  deviceId?: string;
  audio: true | MediaTrackConstraints;
};

/** Strict, then drop the chosen device, then drop processing, then bare audio. */
export function relaxedCapture(step: number, deviceId?: string): RelaxedStep | null {
  if (step <= 0) {
    return {
      ...(deviceId && deviceId !== "default" ? { deviceId } : {}),
      audio: {
        ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    };
  }
  if (step === 1)
    return { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  if (step === 2) return { audio: true };
  return null;
}

export function rememberDevice(worked: string | null, previous: string | null): string | null {
  return worked || previous;
}
