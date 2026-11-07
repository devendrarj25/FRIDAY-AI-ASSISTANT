/**
 * FRIDAY · voice provider router: capability, quota and the zero-spend rule.
 *
 * Picks the engine for one need (speech to text, text to speech, text, realtime audio) from what each provider
 * really offers, never from its name. The rules are fixed:
 *   · local is the default and the fallback; a cloud provider is considered only when cloud is switched on,
 *     the provider is on the allow list, a key is saved, privacy mode is off and the need is not SENSITIVE;
 *   · a paid provider is never chosen unless paid use is allowed AND approved AND the billing firewall allows it;
 *   · a free quota is a configured number, never assumed unlimited; when it is used up the answer is "local",
 *     with the reason, and never a paid provider;
 *   · the decision says which provider is active and why the others were refused.
 * `facts` fields are what the provider documentation said when the table was written; a provider that is
 * `verified: false` is listed but only chosen when the owner has allowed it by name.
 */

export type Need = "text" | "stream-text" | "stt" | "tts" | "realtime-audio";

export type ProviderCaps = {
  id: string;
  label: string;
  kind: "local" | "cloud";
  needs: Need[];
  hindi: boolean;
  hinglish: boolean;
  functionCalling: boolean;
  interruption: boolean;
  /** True when the provider has any usable free allowance; the size is the owner's setting, not stored here. */
  freeTier: "none" | "limited" | "unknown";
  /** The provider's documentation was read for this row. */
  verified: boolean;
  note: string;
};

/**
 * Starting table. Rows say what is believed from provider documentation; `verified: false` means the page was
 * not read from the build machine. Quotas are never stored here.
 */
export const PROVIDERS: ProviderCaps[] = [
  {
    id: "local-ollama",
    label: "Ollama (this PC)",
    kind: "local",
    needs: ["text", "stream-text"],
    hindi: true,
    hinglish: true,
    functionCalling: true,
    interruption: true,
    freeTier: "none",
    verified: false,
    note: "Runs on this PC. Hindi quality depends on the model chosen.",
  },
  {
    id: "local-faster-whisper",
    label: "faster-whisper (this PC)",
    kind: "local",
    needs: ["stt"],
    hindi: true,
    hinglish: true,
    functionCalling: false,
    interruption: false,
    freeTier: "none",
    verified: false,
    note: "Chunked (incremental) recognition, not a native streaming engine.",
  },
  {
    id: "local-supertonic",
    label: "Supertonic 3 (this PC)",
    kind: "local",
    needs: ["tts"],
    hindi: true,
    hinglish: true,
    functionCalling: false,
    interruption: true,
    freeTier: "none",
    verified: false,
    note: "Hindi and English voices; mixed text is read span by span.",
  },
  {
    id: "local-sapi",
    label: "Windows speech (this PC)",
    kind: "local",
    needs: ["tts", "stt"],
    hindi: true,
    hinglish: false,
    functionCalling: false,
    interruption: true,
    freeTier: "none",
    verified: false,
    note: "Emergency fallback; needs the Hindi language pack for Hindi.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "cloud",
    needs: ["text", "stream-text", "stt", "tts", "realtime-audio"],
    hindi: true,
    hinglish: true,
    functionCalling: true,
    interruption: true,
    freeTier: "unknown",
    verified: false,
    note: "Realtime is a paid API; it is chosen only with paid use allowed and approved.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "cloud",
    needs: ["text", "stream-text", "stt", "realtime-audio"],
    hindi: true,
    hinglish: true,
    functionCalling: true,
    interruption: true,
    freeTier: "limited",
    verified: false,
    note: "Live API documented as a stateful WebSocket: audio in is PCM16 16 kHz, audio out PCM16 24 kHz. Its address, key handling and setup message were not on the page read, and its events differ from the OpenAI style, so it is not connected. The free allowance is the owner's setting.",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "cloud",
    needs: ["text", "stream-text"],
    hindi: true,
    hinglish: true,
    functionCalling: true,
    interruption: true,
    freeTier: "none",
    verified: false,
    note: "Text only. The consumer voice mode is not an embeddable API.",
  },
  {
    id: "xai",
    label: "xAI Grok",
    kind: "cloud",
    needs: ["text", "stream-text"],
    hindi: true,
    hinglish: true,
    functionCalling: true,
    interruption: true,
    freeTier: "unknown",
    verified: false,
    note: "Text here. A realtime voice WebSocket (wss://api.x.ai/v1/realtime) is documented, but its audio format is not stated on the page read, so it is not connected.",
  },
  {
    id: "sarvam",
    label: "Sarvam AI",
    kind: "cloud",
    needs: ["stt", "tts", "text"],
    hindi: true,
    hinglish: true,
    functionCalling: false,
    interruption: false,
    freeTier: "unknown",
    verified: true,
    note: "Docs read 2026-11-07: text-to-speech and speech-to-text (hi-IN, en-IN; codemix mode for Hinglish), key in the api-subscription-key header, short audio only. No streaming is documented on the pages read, so none is claimed.",
  },
  {
    id: "azure-speech",
    label: "Azure Speech",
    kind: "cloud",
    needs: ["stt", "tts"],
    hindi: true,
    hinglish: false,
    functionCalling: false,
    interruption: false,
    freeTier: "limited",
    verified: true,
    note: "Docs read 2026-11-07: text-to-speech REST with SSML and a regional address. The speech-to-text page and a Hindi voice name were not read; the owner sets the voice. The free allowance is the owner's setting.",
  },
];

export type VoiceCloudSettings = {
  cloudEnabled: boolean;
  localEnabled: boolean;
  allowedProviders: string[];
  /** Saved keys by provider id (presence only; the key itself never reaches this module). */
  keyPresent: Record<string, boolean>;
  dailyRequests: number;
  monthlyRequests: number;
  /** Audio minutes per month; 0 means none allowed. */
  monthlyAudioMinutes: number;
  /** Money the owner allows to spend. Zero by default. */
  spendLimitUsd: number;
  paidAllowed: boolean;
  paidApproved: boolean;
};

export const DEFAULT_CLOUD_SETTINGS: VoiceCloudSettings = {
  cloudEnabled: false,
  localEnabled: true,
  allowedProviders: [],
  keyPresent: {},
  dailyRequests: 0,
  monthlyRequests: 0,
  monthlyAudioMinutes: 0,
  spendLimitUsd: 0,
  paidAllowed: false,
  paidApproved: false,
};

export type Usage = {
  dayKey: string;
  monthKey: string;
  day: number;
  month: number;
  audioMinutes: number;
};

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Counts cloud requests per provider per day and month. The clock is injected. */
export class UsageLedger {
  private readonly rows = new Map<string, Usage>();
  constructor(private readonly now: () => number = Date.now) {}

  private row(provider: string): Usage {
    const t = this.now();
    const dayKey = dayOf(t);
    const monthKey = dayKey.slice(0, 7);
    const old = this.rows.get(provider);
    const row: Usage = {
      dayKey,
      monthKey,
      day: old && old.dayKey === dayKey ? old.day : 0,
      month: old && old.monthKey === monthKey ? old.month : 0,
      audioMinutes: old && old.monthKey === monthKey ? old.audioMinutes : 0,
    };
    this.rows.set(provider, row);
    return row;
  }

  usage(provider: string): Usage {
    return { ...this.row(provider) };
  }

  record(provider: string, audioMinutes = 0): void {
    const row = this.row(provider);
    row.day += 1;
    row.month += 1;
    row.audioMinutes += Math.max(0, audioMinutes);
  }

  /** Add audio minutes to a provider without counting another request. */
  addAudio(provider: string, minutes: number): void {
    this.row(provider).audioMinutes += Math.max(0, minutes);
  }

  snapshot(): Record<string, Usage> {
    return Object.fromEntries([...this.rows.keys()].map((id) => [id, this.usage(id)]));
  }

  restore(saved: Record<string, Usage>): void {
    for (const [id, row] of Object.entries(saved)) this.rows.set(id, { ...row });
  }
}

export type RouteRequest = {
  need: Need;
  /** The text or audio holds SENSITIVE material: a cloud provider is out. */
  sensitive: boolean;
  privacyMode: boolean;
  /** The billing firewall's answer for paid use. */
  billingAllowsPaid: boolean;
  /** The provider is expected to cost money for this call (for example a realtime API). */
  costsMoney?: (provider: ProviderCaps) => boolean;
  /** Minutes of audio this call would use. */
  audioMinutes?: number;
  needHindi?: boolean;
  needInterruption?: boolean;
  online: boolean;
};

export type RouteDecision = {
  provider: ProviderCaps | null;
  active: "local" | "cloud" | "none";
  reason: string;
  refused: { id: string; why: string }[];
};

const PAID_BY_DEFAULT = new Set(["openai"]);

export function routeVoice(
  request: RouteRequest,
  settings: VoiceCloudSettings,
  ledger: UsageLedger,
  table: ProviderCaps[] = PROVIDERS,
): RouteDecision {
  const refused: { id: string; why: string }[] = [];
  const fits = (p: ProviderCaps): boolean =>
    p.needs.includes(request.need) &&
    (!request.needHindi || p.hindi) &&
    (!request.needInterruption || p.interruption);

  const cloudAllowed =
    settings.cloudEnabled && !request.privacyMode && !request.sensitive && request.online;
  const cloudWhy = !settings.cloudEnabled
    ? "cloud AI is switched off"
    : request.privacyMode
      ? "privacy mode keeps this on the PC"
      : request.sensitive
        ? "sensitive content stays on the PC"
        : !request.online
          ? "no network"
          : "";

  if (cloudAllowed) {
    for (const p of table.filter((x) => x.kind === "cloud" && fits(x))) {
      if (!settings.allowedProviders.includes(p.id)) {
        refused.push({ id: p.id, why: "not on the allowed list" });
        continue;
      }
      if (!settings.keyPresent[p.id]) {
        refused.push({ id: p.id, why: "no key saved" });
        continue;
      }
      const paid = request.costsMoney ? request.costsMoney(p) : PAID_BY_DEFAULT.has(p.id);
      if (
        paid &&
        !(
          settings.paidAllowed &&
          settings.paidApproved &&
          settings.spendLimitUsd > 0 &&
          request.billingAllowsPaid
        )
      ) {
        refused.push({ id: p.id, why: "paid use is not allowed and approved" });
        continue;
      }
      const usage = ledger.usage(p.id);
      if (settings.dailyRequests <= 0 || usage.day >= settings.dailyRequests) {
        refused.push({ id: p.id, why: "daily quota used up or not set" });
        continue;
      }
      if (settings.monthlyRequests <= 0 || usage.month >= settings.monthlyRequests) {
        refused.push({ id: p.id, why: "monthly quota used up or not set" });
        continue;
      }
      const minutes = request.audioMinutes ?? 0;
      if (minutes > 0 && usage.audioMinutes + minutes > settings.monthlyAudioMinutes) {
        refused.push({ id: p.id, why: "audio minutes used up or not set" });
        continue;
      }
      return {
        provider: p,
        active: "cloud",
        reason: `${p.label} is allowed and inside its quota`,
        refused,
      };
    }
  }

  if (settings.localEnabled) {
    const local = table.find((p) => p.kind === "local" && fits(p));
    if (local) {
      const why =
        cloudWhy || (refused.length ? "every cloud provider was refused" : "local is the default");
      return { provider: local, active: "local", reason: `${local.label}: ${why}`, refused };
    }
  }
  return {
    provider: null,
    active: "none",
    reason: settings.localEnabled ? "no local engine offers this" : "local AI is switched off",
    refused,
  };
}
