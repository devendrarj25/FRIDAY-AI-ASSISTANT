/**
 * FRIDAY · one text-to-speech interface and one fallback manager.
 *
 * Every voice FRIDAY can speak with (Supertonic on this PC, the optional light Hindi voice, the online Edge voice,
 * a cloud voice the provider router allows, the Windows system voice, the rule-based formant voice) is a
 * `TtsProvider`. The manager only composes what already exists: the privacy rule, the sensitive-line rule, the
 * billing firewall and the provider router (`routeVoice`) decide what is allowed; nothing here widens them.
 *
 *   - ranking is pure (`rankTtsProviders`): the same order the older ladders used, now with a reason for every
 *     voice that was left out;
 *   - one clause (a "segment") is tried on at most two voices; a voice that fails before any sound is replaced by
 *     the next one; a voice that fails after sound began is not replaced inside that clause (the engine changes
 *     only at the next clause boundary);
 *   - chunks carry a generation: a chunk of another generation is dropped, a cancelled or replaced generation
 *     stops at once and its late chunks never reach the player;
 *   - the result names the engine that really spoke, why a better one did not, and one honest diagnostics line.
 * Time is injected; no timer, device, network or store is touched here.
 */
import {
  PAID_BY_DEFAULT,
  PROVIDERS,
  type ProviderCaps,
  type RouteDecision,
} from "./voice-provider-router";

/* ------------------------------------------------------------------ light Hindi voice rule */

/** The optional light Hindi voice: a local engine of the raw-sample voice op, never a cloud voice. */
export const HINDI_LIGHT_ENGINE = "hindi-light";
/** Its row in the Models page (and the id the models store reports as installed). */
export const HINDI_LIGHT_MODEL_ID = "hindi-light-tts";

/**
 * True when the whole clause is Devanagari the light voice can say: at least one Devanagari letter, no Latin or
 * other letter and no digit (the same rule as `tts_hindi_light.speakable` in the kernel, which decides again).
 */
export function hindiLightSpeakable(text: string): boolean {
  const value = String(text || "");
  if (!/[ऄ-हक़-ॡ]/.test(value)) return false;
  return !/[\p{Nd}]/u.test(value) && !/[^\P{L}ऀ-ॿ]/u.test(value);
}

export type HindiLightChoice = { use: boolean; note: string };

/**
 * Whether one clause asks for the light Hindi voice. It does when the setting is on, the clause is a local one
 * (no cloud voice picked for it), it is Hindi in Devanagari only, and the voice is not known to be missing.
 * `installed` is true or false when the Models page knows, null before its first look; null still asks, because
 * the kernel falls back to the standard local voice by itself and says so. Privacy mode does not matter here:
 * the engine runs on this PC and the cloud rules (`allowCloud`) are decided before this point and unchanged.
 */
export function chooseHindiLightVoice(input: {
  enabled: boolean;
  installed: boolean | null;
  local: boolean;
  lang: string;
  text: string;
}): HindiLightChoice {
  if (!input.enabled) return { use: false, note: "" };
  if (
    !input.local ||
    !String(input.lang || "")
      .toLowerCase()
      .startsWith("hi")
  ) {
    return { use: false, note: "" };
  }
  if (!hindiLightSpeakable(input.text)) return { use: false, note: "" };
  if (input.installed === false) {
    return {
      use: false,
      note: "The light Hindi voice is on but not downloaded (Models, Hindi light voice); the standard voice speaks.",
    };
  }
  return { use: true, note: "" };
}

/* ------------------------------------------------------------------ the interface */

export type TtsKind = "local" | "cloud";
/** What a voice costs: `free` always, `free-quota` inside the owner's quota, `paid` only with paid use allowed. */
export type TtsCostClass = "free" | "free-quota" | "paid";
/** Where the text goes: `on-device` never leaves this PC. */
export type TtsPrivacyClass = "on-device" | "cloud";
export type TtsHealthState = "ready" | "unknown" | "down";
export type TtsHealth = { state: TtsHealthState; reason?: string };

export type TtsSegment = { text: string; lang: string };

export type TtsSpeakOptions = {
  lang: string;
  rate: number;
  pitch: number;
  style: string;
  generation: number;
};

/** One piece of audio. `payload` carries the caller's own clip object so the player gets it back untouched. */
export type TtsChunk = {
  generation: number;
  seq: number;
  engine: string;
  voice?: string;
  mime?: string;
  audioBase64?: string;
  pcm?: { samples: Int16Array | Float32Array; rate: number };
  payload?: unknown;
};

/** What the ranking needs to know about a voice. */
export type TtsProviderInfo = {
  id: string;
  label: string;
  kind: TtsKind;
  /** Language base codes ("hi", "en") or "*" for any. */
  languages: readonly string[];
  cost: TtsCostClass;
  privacy: TtsPrivacyClass;
  /** The system or rule voice that is always there: never put on a cool-down. */
  lastResort?: boolean;
  /** A cloud voice that only the provider router may allow (Sarvam, Azure), never the plain online switch. */
  viaRouter?: boolean;
};

export interface TtsProvider extends TtsProviderInfo {
  health(): TtsHealth;
  speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk>;
  cancel(generation: number): void;
}

export const TTS_INFO = {
  edge: {
    id: "edge",
    label: "the online voice",
    kind: "cloud",
    languages: ["hi", "en"],
    cost: "free",
    privacy: "cloud",
  },
  "hindi-light": {
    id: HINDI_LIGHT_ENGINE,
    label: "the light Hindi voice",
    kind: "local",
    languages: ["hi"],
    cost: "free",
    privacy: "on-device",
  },
  supertonic: {
    id: "supertonic",
    label: "the standard local voice",
    kind: "local",
    languages: ["hi", "en"],
    cost: "free",
    privacy: "on-device",
  },
  sapi: {
    id: "sapi",
    label: "the system voice",
    kind: "local",
    languages: ["*"],
    cost: "free",
    privacy: "on-device",
    lastResort: true,
  },
  formant: {
    id: "formant",
    label: "the rule-based voice",
    kind: "local",
    languages: ["*"],
    cost: "free",
    privacy: "on-device",
    lastResort: true,
  },
} as const satisfies Record<string, TtsProviderInfo>;

/** The cloud voices the existing provider router knows (Sarvam, Azure, ...), as ranking rows. */
export function cloudTtsInfos(table: ProviderCaps[] = PROVIDERS): TtsProviderInfo[] {
  return table
    .filter((p) => p.kind === "cloud" && p.needs.includes("tts"))
    .map((p) => ({
      id: p.id,
      label: p.label,
      kind: "cloud" as const,
      languages: p.hindi ? ["hi", "en"] : ["en"],
      cost: PAID_BY_DEFAULT.has(p.id)
        ? ("paid" as const)
        : p.freeTier === "none"
          ? ("paid" as const)
          : ("free-quota" as const),
      privacy: "cloud" as const,
      viaRouter: true,
    }));
}

/* ------------------------------------------------------------------ ranking */

export type TtsContext = {
  online: boolean;
  privacyMode: boolean;
  /** The line looks private (a password, a PIN, a card number): never a cloud voice. */
  sensitive: boolean;
  /** The caller's own cloud permission for this line. */
  allowCloud: boolean;
  /** The billing firewall's answer for paid use. */
  billingAllowsPaid: boolean;
  prefer?: "auto" | "supertonic" | "sapi" | "neural";
  /**
   * What speaks a private line: `system` (today's rule: the Windows voice) or `local` (any voice on this PC).
   * Either way a private line never leaves the PC.
   */
  privateVoice?: "system" | "local";
  /** There is a Windows system voice to fall back to. Default true. */
  systemVoice?: boolean;
  hindiLight?: { enabled: boolean; installed: boolean | null };
  /** The provider router's decision for a cloud text-to-speech need (from `routeVoice`). */
  cloud?: RouteDecision | null;
};

export type TtsRefusal = { id: string; why: string };
export type TtsRanking = { order: TtsProviderInfo[]; refused: TtsRefusal[] };

/** The first two letters that matter: `hi-IN` and Hinglish read as Hindi, `en-IN` as English. */
export function langBase(lang: string): string {
  const value = String(lang || "").toLowerCase();
  return value === "hinglish" ? "hi" : value.slice(0, 2);
}

const speaksLanguage = (info: TtsProviderInfo, lang: string): boolean => {
  const base = langBase(lang);
  return !base || info.languages.includes("*") || info.languages.includes(base);
};

/** Why a cloud voice may not take this line; empty when the plain online switch allows it. */
export function cloudBlockReason(ctx: TtsContext): string {
  if (ctx.privacyMode) return "privacy mode keeps this voice on the PC";
  if (ctx.sensitive) return "this line looks private, so it stays on the PC";
  if (!ctx.online) return "no network";
  if (!ctx.allowCloud) return "an online voice is not allowed for this line";
  return "";
}

const LADDER_ORDER = ["edge", HINDI_LIGHT_ENGINE, "supertonic", "sapi", "formant"] as const;

/**
 * Rank the voices for one clause. The order is the ladder FRIDAY always had: a cloud voice the router allows,
 * then the online voice, the light Hindi voice for Devanagari-only Hindi, the standard local voice, the system
 * voice, the rule-based voice. A private line (privacy mode or a sensitive line) goes to the system voice only
 * (`privateVoice: "system"`, the default) or to any voice on this PC (`"local"`), never to a cloud one.
 */
export function rankTtsProviders(
  infos: readonly TtsProviderInfo[],
  segment: TtsSegment,
  ctx: TtsContext,
  health: (id: string) => TtsHealth = () => ({ state: "unknown" }),
): TtsRanking {
  const refused: TtsRefusal[] = [];
  const order: TtsProviderInfo[] = [];
  const priv = ctx.privacyMode || ctx.sensitive;
  const privateOnly = priv && (ctx.privateVoice ?? "system") === "system";
  const prefer = ctx.prefer ?? "auto";
  const cloudWhy = cloudBlockReason(ctx);
  const routed = [...infos.filter((info) => info.viaRouter)];
  const ladder = LADDER_ORDER.map((id) => infos.find((info) => info.id === id)).filter(
    (info): info is TtsProviderInfo => Boolean(info),
  );
  const sequence = [...routed, ...ladder];

  for (const info of sequence) {
    const why = refusalFor(info);
    if (why) refused.push({ id: info.id, why });
    else order.push(info);
  }
  return { order, refused };

  function refusalFor(info: TtsProviderInfo): string {
    // A private line under the default rule is the system voice's alone (today's behaviour), even without one.
    if (privateOnly) return info.id === "sapi" ? "" : "private line: the system voice speaks";
    if (prefer === "sapi") return info.id === "sapi" ? "" : "the owner picked the system voice";
    if (!speaksLanguage(info, segment.lang))
      return `it does not speak ${langBase(segment.lang) || "this language"}`;
    const state = health(info.id);
    if (state.state === "down") return state.reason || "it is not available";
    if (info.kind === "cloud") {
      if (prefer === "supertonic") return "the owner picked the local voice";
      if (cloudWhy) return cloudWhy;
      if (info.cost === "paid" && !ctx.billingAllowsPaid)
        return "paid use is not allowed and approved";
      if (info.viaRouter) {
        const decision = ctx.cloud;
        if (!decision || decision.active !== "cloud" || decision.provider?.id !== info.id) {
          const asked = decision?.refused.find((row) => row.id === info.id);
          return asked ? asked.why : "the provider router did not pick it";
        }
      }
      return "";
    }
    if (info.id === HINDI_LIGHT_ENGINE) {
      const light = chooseHindiLightVoice({
        enabled: ctx.hindiLight?.enabled === true,
        installed: ctx.hindiLight?.installed ?? null,
        local: true,
        lang: segment.lang,
        text: segment.text,
      });
      if (light.use) return "";
      return light.note || "the light Hindi voice is off or this line is not Devanagari-only Hindi";
    }
    if (info.id === "sapi" && ctx.systemVoice === false) return "there is no system voice";
    return "";
  }
}

/* ------------------------------------------------------------------ the manager */

export type TtsAttempt = { id: string; ok: boolean; reason?: string };

export type TtsSegmentResult = {
  ok: boolean;
  /** The voice that really spoke; null when none did. */
  engine: string | null;
  kind: TtsKind | null;
  chunks: TtsChunk[];
  attempts: TtsAttempt[];
  /** Why the best voice did not speak; empty when it did. */
  fallbackReason: string;
  /** One honest diagnostics line; empty when nothing needs saying. */
  note: string;
  generation: number;
  /** The generation was cancelled or replaced: nothing was kept for the player. */
  stale: boolean;
  /** Chunks of another generation that were dropped. */
  droppedChunks: number;
  /** A voice failed part way: what it said was kept and the voice did not change inside the clause. */
  partial: boolean;
  refused: TtsRefusal[];
};

export type TtsManagerOptions = {
  /** Most voices tried for one clause. Default 2. */
  maxAttempts?: number;
  /** A voice that failed is skipped for this long (ms); the last-resort voices never are. Default 0 (off). */
  coolDownMs?: number;
  now?: () => number;
  /** Extra check on the text itself (the privacy firewall's `looksSensitive`). */
  isSensitive?: (text: string) => boolean;
};

/** What a caller asks of one clause besides its text. */
export type TtsSpeakRequest = {
  generation: number;
  rate?: number;
  pitch?: number;
  style?: string;
  onChunk?: (chunk: TtsChunk) => void;
};

const MAX_CANCELLED = 64;

export class TtsFallbackManager {
  private readonly byId = new Map<string, TtsProvider>();
  private readonly maxAttempts: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly isSensitive: ((text: string) => boolean) | undefined;
  private readonly cooling = new Map<string, number>();
  private readonly cancelled = new Set<number>();
  private current: number | null = null;
  private lastEngine: string | null = null;
  private last: TtsSegmentResult | null = null;

  constructor(providers: readonly TtsProvider[], options: TtsManagerOptions = {}) {
    for (const provider of providers) this.byId.set(provider.id, provider);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
    this.coolDownMs = Math.max(0, options.coolDownMs ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.isSensitive = options.isSensitive;
  }

  /** The reply (generation) that may make sound. A different number replaces the earlier reply at once. */
  begin(generation: number): void {
    if (this.current !== null && this.current !== generation) this.cancel(this.current);
    this.current = generation;
    this.cancelled.delete(generation);
  }

  /** Stop a generation: its voices are told, its late chunks are dropped. */
  cancel(generation: number): void {
    this.cancelled.add(generation);
    if (this.cancelled.size > MAX_CANCELLED) {
      const oldest = this.cancelled.values().next().value;
      if (oldest !== undefined) this.cancelled.delete(oldest);
    }
    for (const provider of this.byId.values()) {
      try {
        provider.cancel(generation);
      } catch {
        // A voice that cannot be told to stop is dropped by the generation check instead.
      }
    }
  }

  private isStale(generation: number): boolean {
    return this.cancelled.has(generation) || (this.current !== null && this.current !== generation);
  }

  private health = (id: string): TtsHealth => {
    const provider = this.byId.get(id);
    if (!provider) return { state: "down", reason: "it is not installed in this FRIDAY" };
    const until = this.cooling.get(id) ?? 0;
    if (until > this.now() && !provider.lastResort) {
      return {
        state: "down",
        reason: `it failed a moment ago (skipped for ${Math.ceil((until - this.now()) / 1000)} s)`,
      };
    }
    return provider.health();
  };

  /** What the next clause would use, without speaking it. */
  rank(segment: TtsSegment, ctx: TtsContext): TtsRanking {
    return rankTtsProviders(
      [...this.byId.values()],
      segment,
      this.withText(segment, ctx),
      this.health,
    );
  }

  private withText(segment: TtsSegment, ctx: TtsContext): TtsContext {
    if (ctx.sensitive || !this.isSensitive) return ctx;
    return this.isSensitive(segment.text) ? { ...ctx, sensitive: true } : ctx;
  }

  /**
   * Speak one clause. Tries the best allowed voice, then at most one more; a voice that fails before sound is
   * replaced, a voice that fails after sound began is not.
   */
  speakSegment(
    segment: TtsSegment,
    ctx: TtsContext,
    options: TtsSpeakRequest,
  ): Promise<TtsSegmentResult> {
    const effective = this.withText(segment, ctx);
    const ranking = this.rank(segment, effective);
    const ideal = rankTtsProviders([...this.byId.values()], segment, effective, () => ({
      state: "unknown",
    })).order[0];
    return this.run(segment, ranking, ideal, options);
  }

  /**
   * Speak one clause on voices the caller already chose, in that order (the real speech path decides them from
   * the settings it always had). The firewalls still apply: a cloud voice is refused on a private or sensitive
   * line, with no network, or when the caller says no online voice for this line.
   */
  speakOrdered(
    segment: TtsSegment,
    ctx: TtsContext,
    order: readonly string[],
    options: TtsSpeakRequest,
  ): Promise<TtsSegmentResult> {
    const effective = this.withText(segment, ctx);
    const cloudWhy = cloudBlockReason(effective);
    const refused: TtsRefusal[] = [];
    const kept: TtsProviderInfo[] = [];
    for (const id of order) {
      const provider = this.byId.get(id);
      if (!provider) {
        refused.push({ id, why: "it is not installed in this FRIDAY" });
      } else if (provider.kind === "cloud" && cloudWhy) {
        refused.push({ id, why: cloudWhy });
      } else if (
        provider.kind === "cloud" &&
        provider.cost === "paid" &&
        !effective.billingAllowsPaid
      ) {
        refused.push({ id, why: "paid use is not allowed and approved" });
      } else {
        const state = this.health(id);
        if (state.state === "down")
          refused.push({ id, why: state.reason || "it is not available" });
        else kept.push(provider);
      }
    }
    const first = order[0] ? this.byId.get(order[0]) : undefined;
    return this.run(segment, { order: kept, refused }, first, options);
  }

  private async run(
    segment: TtsSegment,
    ranking: TtsRanking,
    ideal: TtsProviderInfo | undefined,
    options: TtsSpeakRequest,
  ): Promise<TtsSegmentResult> {
    const generation = options.generation;
    const result: TtsSegmentResult = {
      ok: false,
      engine: null,
      kind: null,
      chunks: [],
      attempts: [],
      fallbackReason: "",
      note: "",
      generation,
      stale: false,
      droppedChunks: 0,
      partial: false,
      refused: ranking.refused,
    };
    if (this.isStale(generation)) {
      result.stale = true;
      return this.finish(result);
    }
    const tryList = ranking.order.slice(0, this.maxAttempts);
    for (const info of tryList) {
      const provider = this.byId.get(info.id);
      if (!provider) continue;
      const before = result.chunks.length;
      let seq = 0;
      try {
        const stream = provider.speak(segment.text, {
          lang: segment.lang,
          rate: options.rate ?? 1,
          pitch: options.pitch ?? 0,
          style: options.style ?? "",
          generation,
        });
        for await (const chunk of stream) {
          if (this.isStale(generation)) {
            result.stale = true;
            result.chunks = [];
            result.ok = false;
            result.engine = null;
            try {
              provider.cancel(generation);
            } catch {
              // see cancel()
            }
            return this.finish(result);
          }
          if (chunk.generation !== generation) {
            result.droppedChunks += 1;
            continue;
          }
          const kept = { ...chunk, seq };
          seq += 1;
          result.chunks.push(kept);
          options.onChunk?.(kept);
        }
        if (result.chunks.length === before) throw new Error("it made no audio");
        result.attempts.push({ id: info.id, ok: true });
        result.ok = true;
        result.engine = provider.id;
        result.kind = provider.kind;
        this.cooling.delete(provider.id);
        break;
      } catch (error) {
        const reason = String((error as Error)?.message || error).slice(0, 120);
        result.attempts.push({ id: info.id, ok: false, reason });
        if (this.coolDownMs > 0 && !provider.lastResort) {
          this.cooling.set(provider.id, this.now() + this.coolDownMs);
        }
        if (result.chunks.length > before) {
          // Sound already began: keep it, and do not change voice inside the clause.
          result.ok = true;
          result.partial = true;
          result.engine = provider.id;
          result.kind = provider.kind;
          result.note = `${provider.label} stopped part way through a clause (${reason}); what it said was kept.`;
          return this.finish(result);
        }
      }
    }
    if (!result.ok) {
      const why = result.attempts.map((a) => `${a.id}: ${a.reason ?? "failed"}`).join("; ");
      result.fallbackReason = why || ranking.refused.map((r) => `${r.id}: ${r.why}`).join("; ");
      result.note = `No voice could speak this clause (${result.fallbackReason || "none was allowed"}).`;
      return this.finish(result);
    }
    if (ideal && result.engine !== ideal.id) {
      const failed = result.attempts.find((a) => a.id === ideal.id && !a.ok);
      const left = ranking.refused.find((r) => r.id === ideal.id);
      result.fallbackReason = failed?.reason ?? left?.why ?? "it was not ready";
      const used = this.byId.get(result.engine ?? "")?.label ?? result.engine;
      result.note = `${capital(ideal.label)} did not speak this clause (${result.fallbackReason}); ${used} did.`;
    }
    if (this.lastEngine && result.engine && this.lastEngine !== result.engine && !result.note) {
      result.note = `The voice changed from ${this.lastEngine} to ${result.engine} at a clause boundary.`;
    }
    return this.finish(result);
  }

  private finish(result: TtsSegmentResult): TtsSegmentResult {
    if (result.engine) this.lastEngine = result.engine;
    this.last = result;
    return result;
  }

  /** The latest clause's outcome, for the diagnostics page. */
  status(): { last: TtsSegmentResult | null; cooling: string[] } {
    const at = this.now();
    return {
      last: this.last,
      cooling: [...this.cooling.entries()].filter(([, until]) => until > at).map(([id]) => id),
    };
  }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/* ------------------------------------------------------------------ the older ladders, as one decision */

/** The engine names the two older ladders spoke: "neural" is the online voice. */
const LEGACY_NAME: Record<string, "neural" | "supertonic" | "sapi" | "formant"> = {
  edge: "neural",
  supertonic: "supertonic",
  sapi: "sapi",
  formant: "formant",
};

const healthFor =
  (supertonicReady: boolean) =>
  (id: string): TtsHealth =>
    id === "supertonic" && !supertonicReady
      ? { state: "down", reason: "the local voice is not ready" }
      : { state: "unknown" };

/**
 * The engine the older ladders picked, from the same ranking: the online voice when the network and the rules
 * allow it, the standard local voice when it is ready, then the system voice (and the rule-based voice only when
 * there is no system voice). A private line is the system voice.
 */
export function legacyEngineChoice(input: {
  network: boolean;
  supertonicReady: boolean;
  privacy: boolean;
  prefer?: "auto" | "supertonic" | "sapi" | "neural";
  systemVoice?: boolean;
  formantLast?: boolean;
}): "neural" | "supertonic" | "sapi" | "formant" {
  const infos: TtsProviderInfo[] = [
    TTS_INFO.edge,
    TTS_INFO.supertonic,
    TTS_INFO.sapi,
    ...(input.formantLast ? [TTS_INFO.formant] : []),
  ];
  const ranking = rankTtsProviders(
    infos,
    { text: "", lang: "" },
    {
      online: input.network,
      privacyMode: input.privacy,
      sensitive: false,
      allowCloud: true,
      billingAllowsPaid: false,
      ...(input.prefer ? { prefer: input.prefer } : {}),
      systemVoice: input.systemVoice !== false,
    },
    healthFor(input.supertonicReady),
  );
  const first = ranking.order[0]?.id;
  // The system voice always exists in the older ladders, so a private or empty ranking is still "sapi".
  return (first && LEGACY_NAME[first]) || (input.formantLast ? "formant" : "sapi");
}
