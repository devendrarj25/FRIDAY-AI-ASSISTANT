/**
 * FRIDAY · Windows microphone states (pure).
 *
 * What the owner should see when the microphone is a Bluetooth headset in call mode, when another app holds it, when
 * the Windows privacy switch is off, or when the device vanished and is being reacquired. Nothing here opens a
 * device or reads the system: the capture gate (`voice-audio.ts`) passes in the track label and rate, the error it
 * got, or the status the main process read, and shows the answer. The device pickers live in
 * `voice-engine/audio-devices.ts`.
 */
import type { MicState } from "./voice-audio";

/** Windows Settings page that holds the microphone privacy switch. */
export const MIC_PRIVACY_LINK = "ms-settings:privacy-microphone";

export type MicAccess = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export type MicFaultView = {
  state: MicState;
  /** One short plain sentence. */
  line: string;
  /** A Retry control belongs with every fault the owner can fix. */
  retry: boolean;
  /** Where the owner fixes it, when Windows has a page for it. */
  settingsLink?: string;
};

const BLUETOOTH = /bluetooth|hands-?free|\bhfp\b|\bbt\b|airpods|buds\b/i;
const WIRED = /usb|built-?in|internal|array|realtek|line in/i;

/**
 * True for a Bluetooth input in its call profile. Opening the microphone on a Bluetooth headset drops Windows to
 * the 8 or 16 kHz call profile, so the music or voice playing through it turns thin. A label that names Bluetooth
 * or Hands-Free says so; a headset that is not wired and reports 16 kHz or less says so too.
 */
export function bluetoothHandsFree(label: string, rate: number | null = null): boolean {
  const text = String(label || "");
  if (BLUETOOTH.test(text)) return true;
  if (WIRED.test(text)) return false;
  return /headset|headphone/i.test(text) && typeof rate === "number" && rate > 0 && rate <= 16000;
}

/** The one-time warning for a Bluetooth microphone, or "" when there is nothing to say. */
export function bluetoothNotice(label: string, rate: number | null = null): string {
  return bluetoothHandsFree(label, rate)
    ? "This Bluetooth headset switches to call quality while the microphone is open, so sound gets thinner. A wired or built-in microphone keeps it clear."
    : "";
}

/** Windows' own privacy answer for the microphone (read in the main process), as a fault the owner can act on. */
export function accessFault(status: MicAccess | string | null | undefined): MicFaultView | null {
  if (status === "denied" || status === "restricted") {
    return {
      state: "permission-denied",
      line: "The microphone is switched off in Windows privacy settings. Turn it on, then press Retry.",
      retry: true,
      settingsLink: MIC_PRIVACY_LINK,
    };
  }
  if (status === "not-determined") {
    return {
      state: "permission-required",
      line: "Windows has not allowed the microphone yet. Allow it, then press Retry.",
      retry: true,
      settingsLink: MIC_PRIVACY_LINK,
    };
  }
  return null;
}

/** A fault from the gate (`lastCaptureFailure`) as a view with its Retry and, for permission, the Settings link. */
export function faultView(
  failure: { state: MicState; reason: string } | null,
): MicFaultView | null {
  if (!failure || failure.state === "available") return null;
  const denied = failure.state === "permission-denied" || failure.state === "permission-required";
  return {
    state: failure.state,
    line: failure.reason,
    retry: true,
    ...(denied ? { settingsLink: MIC_PRIVACY_LINK } : {}),
  };
}

/** Another app (or exclusive mode) holds the microphone. Retry waits for it; picking another input also works. */
export function busyFault(holder = ""): MicFaultView {
  const who = holder.trim();
  return {
    state: "device-offline",
    line: who
      ? `${who} is using the microphone. Close it or pick another input, then press Retry.`
      : "Another app is using the microphone. Close it or pick another input, then press Retry.",
    retry: true,
  };
}

/** Wait before the next reacquire after a track ended or a device changed: 1 s, 2 s, 4 s, then 8 s at most. */
export function reacquireDelay(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(1000 * 2 ** n, 8000);
}
