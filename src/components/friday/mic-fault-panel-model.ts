/**
 * FRIDAY · Auto mode microphone fault panel: what to show (pure).
 *
 * `MicFaultPanel` (VoiceControlBar.tsx) only draws this answer. The fault comes from the capture gate
 * (`faultView`), Windows' privacy answer from `micAccessStatus` (`accessFault`), and the retry wait from
 * `reacquireDelay`. Nothing here reads a device, a store or the clock.
 */
import {
  accessFault,
  reacquireDelay,
  type MicAccess,
  type MicFaultView,
} from "@/lib/friday/mic-faults";

export type MicFaultKind =
  "denied" | "not-determined" | "busy" | "reacquiring" | "unavailable" | "error";

export type MicFaultPanelModel = {
  kind: MicFaultKind;
  /** One short plain sentence. */
  message: string;
  /** "Open microphone privacy settings" button. */
  showSettings: boolean;
  /** Retry button. */
  retry: boolean;
  /** "Trying again in 4 s", only while FRIDAY retries by herself. */
  backoff: string;
};

export type MicFaultPanelOptions = {
  /** How many reacquire tries have failed so far (drives the shown wait). */
  attempt?: number;
  /** True when FRIDAY retries by herself (device ended or unplugged). */
  autoRetry?: boolean;
};

export const OPEN_PRIVACY_LABEL = "Open microphone privacy settings";

const BUSY = /\b(is|are) using the microphone|another app/i;

/** "1 s", "4 s", never a fraction. */
export function backoffLine(attempt: number): string {
  return `Trying again in ${Math.round(reacquireDelay(attempt) / 1000)} s`;
}

function kindOf(fault: MicFaultView): MicFaultKind {
  switch (fault.state) {
    case "permission-denied":
      return "denied";
    case "permission-required":
      return "not-determined";
    case "no-microphone":
      return "unavailable";
    case "device-offline":
      return BUSY.test(fault.line) ? "busy" : "reacquiring";
    default:
      return "error";
  }
}

/**
 * Windows' own privacy answer beats the gate's guess: when the switch is off, the message is about the switch,
 * whatever error the device layer gave. A granted or unknown answer leaves the gate's fault as it is.
 */
export function micFaultPanelModel(
  fault: MicFaultView | null,
  access: MicAccess | string | null | undefined = null,
  options: MicFaultPanelOptions = {},
): MicFaultPanelModel | null {
  const fromAccess = accessFault(access);
  const view = fromAccess && (!fault || fault.state !== "permission-denied") ? fromAccess : fault;
  if (!view || view.state === "available") return null;
  const kind = kindOf(view);
  const waits = (kind === "reacquiring" || kind === "unavailable") && options.autoRetry === true;
  return {
    kind,
    message: view.line,
    showSettings: Boolean(view.settingsLink),
    retry: view.retry,
    backoff: waits ? backoffLine(options.attempt ?? 0) : "",
  };
}

/** Text for the polite live region: changes only when the fault kind or message does. */
export function micLiveText(model: MicFaultPanelModel | null): string {
  return model ? model.message : "";
}

export type MicPanelState =
  | { page: "loading" }
  | { page: "offline" }
  | { page: "error"; detail: string }
  | { page: "fault"; model: MicFaultPanelModel }
  | { page: "none" };

/** The page states for the panel: loading, offline, error with Retry, the fault, or nothing. */
export function micPanelState(input: {
  model: MicFaultPanelModel | null;
  checking: boolean;
  online: boolean;
  checkError: string;
}): MicPanelState {
  if (input.checking) return { page: "loading" };
  if (input.checkError) return { page: "error", detail: input.checkError };
  if (input.model) return { page: "fault", model: input.model };
  if (!input.online) return { page: "offline" };
  return { page: "none" };
}

/** Bluetooth notice shows once per headset until dismissed. */
export function showBluetoothNotice(notice: string, dismissedFor: string): boolean {
  return notice.length > 0 && notice !== dismissedFor;
}
