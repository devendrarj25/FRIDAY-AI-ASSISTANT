/**
 * FRIDAY · settings runtime
 *
 * One reader for the owner preferences the Settings page writes. Engines call
 * these helpers so a toggle actually changes behaviour instead of sitting as
 * display-only state. This is not a second store — it reads `preferences`.
 */

import { DEFAULT_PREFERENCES, preferences } from "./preferences";
import type { NotifyLevel } from "./notifications";
import type { MemoryTier } from "./self/memory-engine";

export function prefOn(key: string, whenUnset: boolean): boolean {
  try {
    const value = preferences.getSnapshot().toggles[key];
    if (typeof value === "boolean") return value;
    const fallback = DEFAULT_PREFERENCES.toggles[key];
    if (typeof fallback === "boolean") return fallback;
    return whenUnset;
  } catch {
    return whenUnset;
  }
}

export function prefField(key: string, fallback = ""): string {
  try {
    const value = preferences.getSnapshot().fields[key];
    if (typeof value === "string" && value.trim()) return value;
    const fromDefault = DEFAULT_PREFERENCES.fields[key];
    return typeof fromDefault === "string" && fromDefault ? fromDefault : fallback;
  } catch {
    return fallback;
  }
}

export function prefNumber(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(prefField(key, String(fallback)));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Conversation memory. Default on. The owner can pause it. */
export const shouldRememberChats = (): boolean => prefOn("rememberChats", true);

/** Permanent / semantic writes. Default on. */
export const shouldStoreLongTerm = (): boolean => prefOn("longTerm", true);

/** Drop expired working/temporary records. Default on. */
export const shouldAutoClearMemory = (): boolean => prefOn("autoClear", true);

/** Compact / de-duplicate on upkeep. Default on. */
export const shouldOptimizeMemory = (): boolean => prefOn("memOpt", true);

/** Snapshot memory before a self-update. Default off. */
export const shouldSnapshotMemory = (): boolean =>
  prefOn("memorySnapshot", false) || prefOn("autoSnapshot", false);

export const shouldWriteLessons = (): boolean => prefOn("lessons", true);

export const shouldMaskSecrets = (): boolean => prefOn("maskSecrets", false);

export const shouldRunBackground = (): boolean => prefOn("background", true);

export const shouldPauseOnBattery = (): boolean => prefOn("pauseOnBattery", false);

export const shouldUnloadIdleModels = (): boolean => prefOn("unloadIdleModels", true);

export const shouldKeepModelsWarm = (): boolean => prefOn("keepModelsWarm", true);

export const modelIdleMs = (): number => prefNumber("modelIdleMinutes", 10, 1, 60) * 60_000;

export const shouldShowCircuit = (): boolean => prefOn("circuit", true);

export const shouldGpuRender = (): boolean => prefOn("gpuRender", true);

export function coerceMemoryTier(tier: MemoryTier): MemoryTier {
  if (shouldStoreLongTerm()) return tier;
  if (tier === "permanent" || tier === "semantic") return "temporary";
  return tier;
}

export const LANGUAGES = [
  { value: "English", label: "English (India)" },
  { value: "Hindi", label: "Hindi" },
  { value: "Hinglish", label: "Hinglish" },
] as const;

export const TIMEZONES = [
  { value: "Asia/Kolkata", label: "(UTC+05:30) Asia/Kolkata" },
  { value: "UTC", label: "(UTC+00:00) UTC" },
  { value: "Asia/Dubai", label: "(UTC+04:00) Asia/Dubai" },
  { value: "Europe/London", label: "(UTC+00:00) Europe/London" },
  { value: "America/New_York", label: "(UTC-05:00) America/New_York" },
  { value: "Australia/Sydney", label: "(UTC+10:00) Australia/Sydney" },
] as const;

export const DATE_FORMATS = ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"] as const;
export const TIME_FORMATS = ["12 Hour", "24 Hour"] as const;

const IANA_IN = /([A-Za-z]+\/[A-Za-z_]+)/;

export function ownerTimeZone(): string {
  const raw = prefField("timezone", "Asia/Kolkata");
  const match = raw.match(IANA_IN);
  if (match?.[1] && isValidTimeZone(match[1])) return match[1];
  if (isValidTimeZone(raw)) return raw;
  return "Asia/Kolkata";
}

function isValidTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-IN", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function ownerLocale(): string {
  const language = prefField("language", "English");
  if (language === "Hindi") return "hi-IN";
  return "en-IN";
}

/** Format a timestamp the way General → date/time/timezone say. */
export function formatOwnerDate(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(at) || Number.isNaN(date.getTime())) return "—";
  const zone = ownerTimeZone();
  const locale = ownerLocale();
  const dateStyle = prefField("dateFormat", "DD-MM-YYYY");
  const hour12 = prefField("timeFormat", "12 Hour") !== "24 Hour";
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    }).formatToParts(date);
    const grab = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const day = grab("day");
    const month = grab("month");
    const year = grab("year");
    const hour = grab("hour");
    const minute = grab("minute");
    const dayPeriod = grab("dayPeriod");
    const dateBit =
      dateStyle === "MM-DD-YYYY"
        ? `${month}-${day}-${year}`
        : dateStyle === "YYYY-MM-DD"
          ? `${year}-${month}-${day}`
          : `${day}-${month}-${year}`;
    const timeBit = hour12 && dayPeriod ? `${hour}:${minute} ${dayPeriod}` : `${hour}:${minute}`;
    return `${dateBit} ${timeBit}`;
  } catch {
    return date.toLocaleString();
  }
}

export function displaySecret(value: string): string {
  const text = String(value || "");
  if (!text) return "";
  if (!shouldMaskSecrets()) return text;
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

/**
 * Category filters for the notification hub. Unset keys stay allowed so a
 * fresh install matches previous behaviour (every subsystem still records).
 */
export function notificationAllowed(source: string, level: NotifyLevel): boolean {
  const src = String(source || "").toLowerCase();
  if (
    src.includes("task") ||
    src.includes("ledger") ||
    src.includes("graph") ||
    src.includes("self-management")
  ) {
    if (level === "error" || level === "action") return prefOn("notifyTaskFail", true);
    return prefOn("notifyTaskDone", true);
  }
  if (
    src.includes("update") ||
    src.includes("github") ||
    src.includes("install") ||
    src.includes("download")
  ) {
    return prefOn("notifyUpdates", true);
  }
  if (
    src.includes("doctor") ||
    src.includes("health") ||
    src.includes("friday") ||
    src.includes("autonomous")
  ) {
    return prefOn("notifyHealth", true);
  }
  return true;
}

/** Short beep used when Settings → Notifications → Sound on alerts is on. */
export function playAlertSound(): void {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => void ctx.close();
  } catch {
    /* no audio device */
  }
}

export function requestDesktopNotificationPermission(): Promise<string> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return Promise.resolve("unsupported");
  }
  if (Notification.permission === "granted") return Promise.resolve("granted");
  if (Notification.permission === "denied") return Promise.resolve("denied");
  return Notification.requestPermission();
}

export function showDesktopToast(title: string, body: string): void {
  if (!prefOn("notifications", true)) return;
  if (!alertsAudible()) return;
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body: body.slice(0, 180) });
  } catch {
    /* Notifications API blocked */
  }
}

function parseMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function minutesInOwnerZone(at = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: ownerTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  } catch {
    const date = new Date(at);
    return date.getHours() * 60 + date.getMinutes();
  }
}

/** Quiet-hours window from Settings → Notifications, in the owner's timezone. */
export function inQuietHours(at = Date.now()): boolean {
  if (!prefOn("quietHours", false)) return false;
  const start = parseMinutes(prefField("quietStart", "22:00"), 22 * 60);
  const end = parseMinutes(prefField("quietEnd", "07:00"), 7 * 60);
  if (start === end) return false;
  const now = minutesInOwnerZone(at);
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/** Sounds, speech, and desktop toasts. Recording still happens. */
export function alertsAudible(): boolean {
  if (prefOn("doNotDisturb", false)) return false;
  if (inQuietHours()) return false;
  return true;
}

export const SETTINGS_BACKUP_KIND = "friday-settings-backup";
