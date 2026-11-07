/**
 * FRIDAY · cloud voice limits (what is stored) and the facts the voice router reads.
 *
 * Stored in the voice preferences. Everything starts off and at zero: cloud is off, no provider is allowed, no
 * quota is set, paid use is off and unapproved, the spend limit is zero. A quota of zero means "none allowed",
 * never "unlimited". Usage counts live in the browser store of this PC; a provider key is never stored here
 * (only whether one is saved is read, from the main process).
 */
import type { HardwareFacts } from "./hardware-profile";
import {
  DEFAULT_CLOUD_SETTINGS,
  UsageLedger,
  type Usage,
  type VoiceCloudSettings,
} from "./voice-provider-router";

export type VoiceCloudPrefs = {
  cloudEnabled: boolean;
  localEnabled: boolean;
  allowedProviders: string[];
  dailyRequests: number;
  monthlyRequests: number;
  monthlyAudioMinutes: number;
  spendLimitUsd: number;
  paidAllowed: boolean;
  paidApproved: boolean;
};

export const DEFAULT_VOICE_CLOUD_PREFS: VoiceCloudPrefs = {
  cloudEnabled: false,
  localEnabled: true,
  allowedProviders: [],
  dailyRequests: 0,
  monthlyRequests: 0,
  monthlyAudioMinutes: 0,
  spendLimitUsd: 0,
  paidAllowed: false,
  paidApproved: false,
};

const whole = (value: unknown, max: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.min(max, Math.max(0, n));
};

/** A stored or edited value is always made safe: unknown fields drop, numbers clamp, approval needs allowance. */
export function sanitizeCloudPrefs(
  input: Partial<VoiceCloudPrefs> | null | undefined,
): VoiceCloudPrefs {
  const src = input ?? {};
  const paidAllowed = src.paidAllowed === true;
  return {
    cloudEnabled: src.cloudEnabled === true,
    localEnabled: src.localEnabled !== false,
    allowedProviders: Array.isArray(src.allowedProviders)
      ? [
          ...new Set(
            src.allowedProviders.filter(
              (x): x is string => typeof x === "string" && /^[a-z0-9-]{1,32}$/.test(x),
            ),
          ),
        ]
      : [],
    dailyRequests: whole(src.dailyRequests, 1_000_000),
    monthlyRequests: whole(src.monthlyRequests, 10_000_000),
    monthlyAudioMinutes: whole(src.monthlyAudioMinutes, 1_000_000),
    spendLimitUsd: paidAllowed ? whole(src.spendLimitUsd, 100_000) : 0,
    paidAllowed,
    paidApproved: paidAllowed && src.paidApproved === true,
  };
}

export function toRouterSettings(
  prefs: VoiceCloudPrefs,
  keyPresent: Record<string, boolean>,
): VoiceCloudSettings {
  const clean = sanitizeCloudPrefs(prefs);
  return { ...DEFAULT_CLOUD_SETTINGS, ...clean, keyPresent };
}

const LEDGER_KEY = "friday.voice.cloudUsage.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Usage persists across restarts so a quota cannot be reset by closing the app. Storage can be missing. */
export function loadLedger(storage: StorageLike | null, now: () => number = Date.now): UsageLedger {
  const ledger = new UsageLedger(now);
  try {
    const raw = storage?.getItem(LEDGER_KEY);
    if (!raw) return ledger;
    const parsed = JSON.parse(raw) as Record<string, Usage>;
    const clean: Record<string, Usage> = {};
    for (const [id, row] of Object.entries(parsed)) {
      if (!/^[a-z0-9-]{1,32}$/.test(id) || !row || typeof row !== "object") continue;
      clean[id] = {
        dayKey: String(row.dayKey ?? ""),
        monthKey: String(row.monthKey ?? ""),
        day: whole(row.day, 1e9),
        month: whole(row.month, 1e9),
        audioMinutes: Math.max(0, Number(row.audioMinutes) || 0),
      };
    }
    ledger.restore(clean);
  } catch {
    /* unreadable usage starts clean; the quota then counts from now */
  }
  return ledger;
}

export function saveLedger(storage: StorageLike | null, ledger: UsageLedger): void {
  try {
    storage?.setItem(LEDGER_KEY, JSON.stringify(ledger.snapshot()));
  } catch {
    /* a full or blocked store loses the count, never the request that was already refused or allowed */
  }
}

/** Machine facts for the profile selector, from the live system sample. Unknown values stay unknown. */
export function factsFromSample(
  sample: {
    cpu: { cores: number; model: string };
    ram: { freeGb: number; totalGb: number };
    gpu: { available: boolean; name: string | null; vramTotalMb: number | null };
    disks?: { freeGb: number }[];
  } | null,
): HardwareFacts | null {
  if (!sample) return null;
  const nvidia = sample.gpu.available && /nvidia/i.test(sample.gpu.name ?? "");
  return {
    cpuModel: sample.cpu.model,
    cpuThreads: sample.cpu.cores,
    ramTotalGb: sample.ram.totalGb,
    ramAvailableGb: sample.ram.freeGb,
    ...(sample.gpu.name ? { gpuName: sample.gpu.name } : {}),
    ...(sample.gpu.vramTotalMb
      ? { vramGb: Math.round((sample.gpu.vramTotalMb / 1024) * 10) / 10 }
      : {}),
    cuda: nvidia,
    ...(sample.disks?.length ? { diskFreeGb: Math.max(...sample.disks.map((d) => d.freeGb)) } : {}),
  };
}
