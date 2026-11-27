/**
 * FRIDAY · microphone and speaker choices (pure).
 *
 * Settings > Voice lets the owner pick one input and one output device. Both are stored by device id; "" is the
 * system default. A saved device that is no longer plugged in is never kept silently: the plan says so and the
 * default is used, so a missing headset never leaves FRIDAY deaf or mute. Nothing here opens a device; the capture
 * (`voice-audio.ts`) and playback (`voice-library.ts`) ask for the plan and act on it.
 */

export type DeviceKind = "microphone" | "speaker";
export type DeviceRow = { id: string; label: string };

export type DevicePlan = {
  /** The id to open; "" is the system default. */
  deviceId: string;
  /** False when a saved device was asked for and is not in the list. */
  found: boolean;
  /** One plain sentence for a fallback; empty when nothing needs saying. */
  note: string;
};

/** Windows lists the default and the communications device as extra rows; the "System default" row stands for them. */
const ALIASES = new Set(["default", "communications"]);

const noun = (kind: DeviceKind) => (kind === "microphone" ? "microphone" : "speaker");

/** How far the list can be trusted: a failed or not-yet-permitted read makes an empty list "unknown". */
export type ListTrust = { enumerated?: boolean; permitted?: boolean };

/**
 * The device to use for a saved choice and the list that is plugged in now. A missing device opens the default for
 * this open only; the saved id is never dropped here (the caller keeps it and selects it again when it returns).
 */
export function planSavedDevice(
  kind: DeviceKind,
  saved: string | null | undefined,
  list: readonly DeviceRow[],
  trust: ListTrust = {},
): DevicePlan {
  const id = String(saved ?? "").trim();
  if (!id || ALIASES.has(id)) return { deviceId: "", found: true, note: "" };
  if (list.some((row) => row.id === id)) return { deviceId: id, found: true, note: "" };
  if (trust.enumerated === false || (kind === "microphone" && trust.permitted === false)) {
    return {
      deviceId: "",
      found: false,
      note: `The ${noun(kind)} list is not available yet. Using the system default; your saved choice is kept.`,
    };
  }
  return {
    deviceId: "",
    found: false,
    note: `The saved ${noun(kind)} is not connected. Using the system default.`,
  };
}

export type DeviceOption = { value: string; label: string; missing: boolean };

/**
 * The rows of one picker: the system default first, then what is plugged in, then (only when it is not plugged in)
 * the saved device marked as not found, so the select shows the truth and not a blank.
 */
export function deviceOptions(
  kind: DeviceKind,
  saved: string | null | undefined,
  list: readonly DeviceRow[],
): DeviceOption[] {
  const rows: DeviceOption[] = [{ value: "", label: "System default", missing: false }];
  const seen = new Set<string>();
  for (const row of list) {
    if (!row.id || ALIASES.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({
      value: row.id,
      label: row.label || `${noun(kind)} ${row.id.slice(0, 8)}`,
      missing: false,
    });
  }
  const id = String(saved ?? "").trim();
  if (id && !ALIASES.has(id) && !seen.has(id)) {
    rows.push({
      value: id,
      label: `Saved ${noun(kind)} (not found, using the system default)`,
      missing: true,
    });
  }
  return rows;
}

/**
 * The line under the microphone picker when the list itself is the problem: the microphone was never allowed
 * ("Permission needed", with a Retry) or no microphone is plugged in. Empty when the list is fine.
 */
export function micListIssue(
  inputs: readonly DeviceRow[],
  trust: ListTrust,
): { kind: "permission" | "none" | null; text: string } {
  if (trust.permitted === false) {
    return {
      kind: "permission",
      text: "Permission needed: allow the microphone in Windows Settings, Privacy, Microphone, then press Retry.",
    };
  }
  if (!inputs.length) {
    return {
      kind: "none",
      text: "No microphone was found. Plug one in; the list refreshes by itself.",
    };
  }
  return { kind: null, text: "" };
}

export type SinkTarget = { setSinkId?: (id: string) => Promise<void> };

export type SinkResult = {
  /** True when the element or context now plays on the device that was asked for (or the default, by plan). */
  ok: boolean;
  /** The device now in use; "" is the system default. */
  deviceId: string;
  fellBack: boolean;
  note: string;
};

/**
 * Point an audio element or an audio context at the saved speaker. A speaker that is gone, or one the browser
 * refuses, sends the sound to the system default and says so; a build that cannot choose a speaker leaves the
 * default and says that. It never throws and never blocks speech.
 */
export async function routeToSpeaker(
  target: SinkTarget,
  saved: string | null | undefined,
  list: readonly DeviceRow[],
): Promise<SinkResult> {
  const plan = planSavedDevice("speaker", saved, list);
  if (typeof target.setSinkId !== "function") {
    const wanted = String(saved ?? "").trim();
    return {
      ok: !wanted,
      deviceId: "",
      fellBack: Boolean(wanted),
      note: wanted ? "This build cannot choose a speaker. Using the system default." : "",
    };
  }
  try {
    await target.setSinkId(plan.deviceId);
    return { ok: true, deviceId: plan.deviceId, fellBack: !plan.found, note: plan.note };
  } catch {
    try {
      await target.setSinkId("");
    } catch {
      /* the default is what plays anyway */
    }
    return {
      ok: false,
      deviceId: "",
      fellBack: true,
      note: "The saved speaker could not be used. Using the system default.",
    };
  }
}
