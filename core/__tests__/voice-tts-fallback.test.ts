import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseTts, switchMidSentence as speechSwitch } from "../../src/lib/friday/speech-tts";
import { chooseTtsEngine, switchMidSentence } from "../../src/lib/friday/tts-ladder";
import {
  DEFAULT_CLOUD_SETTINGS,
  UsageLedger,
  routeVoice,
  type VoiceCloudSettings,
} from "../../src/lib/friday/voice-engine/voice-provider-router";
import {
  TTS_INFO,
  TtsFallbackManager,
  cloudTtsInfos,
  langBase,
  rankTtsProviders,
  type TtsChunk,
  type TtsContext,
  type TtsHealth,
  type TtsProvider,
  type TtsProviderInfo,
  type TtsSpeakOptions,
} from "../../src/lib/friday/voice-engine/tts-provider";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

type Script = {
  /** Chunks to yield before the end; a number makes that many. */
  chunks?: number;
  /** Throw before the first chunk. */
  failFirst?: string;
  /** Throw after this many chunks. */
  failAfter?: { chunks: number; message: string };
  /** Yield chunks tagged with another generation. */
  generationOffset?: number;
  health?: TtsHealth;
  /** Run between chunks (to cancel a reply mid clause). */
  between?: () => void;
};

function fake(info: TtsProviderInfo, script: Script = {}) {
  const calls: { text: string; options: TtsSpeakOptions }[] = [];
  const cancelled: number[] = [];
  const provider: TtsProvider = {
    ...info,
    health: () => script.health ?? { state: "ready" },
    cancel: (generation) => void cancelled.push(generation),
    async *speak(text, options) {
      calls.push({ text, options });
      if (script.failFirst) throw new Error(script.failFirst);
      const total = script.chunks ?? 2;
      for (let i = 0; i < total; i += 1) {
        if (script.failAfter && i === script.failAfter.chunks)
          throw new Error(script.failAfter.message);
        script.between?.();
        const chunk: TtsChunk = {
          generation: options.generation + (script.generationOffset ?? 0),
          seq: i,
          engine: info.id,
          audioBase64: `${info.id}-${i}`,
        };
        yield chunk;
      }
      if (script.failAfter && script.failAfter.chunks >= total)
        throw new Error(script.failAfter.message);
    },
  };
  return { provider, calls, cancelled };
}

const EN = { text: "Your meeting starts at five.", lang: "en-IN" };
const HI = { text: "आपकी मीटिंग पाँच बजे है", lang: "hi-IN" };

const base: TtsContext = {
  online: true,
  privacyMode: false,
  sensitive: false,
  allowCloud: true,
  billingAllowsPaid: false,
};

function build(scripts: Partial<Record<string, Script>> = {}, extra: TtsProviderInfo[] = []) {
  const rigs = {
    edge: fake(TTS_INFO.edge, scripts["edge"]),
    "hindi-light": fake(TTS_INFO["hindi-light"], scripts["hindi-light"]),
    supertonic: fake(TTS_INFO.supertonic, scripts["supertonic"]),
    sapi: fake(TTS_INFO.sapi, scripts["sapi"]),
  };
  const cloud = extra.map((info) => fake(info, scripts[info.id]));
  const manager = new TtsFallbackManager([
    ...cloud.map((c) => c.provider),
    ...Object.values(rigs).map((r) => r.provider),
  ]);
  return { manager, rigs, cloud };
}

describe("the ladders pick FRIDAY Voice first, and the cloud only when it is allowed", () => {
  // The oracle: the owner's explicit choice, then FRIDAY Voice when ready (online, offline, private), then the cloud
  // voice (only online, privacy off), then the system voice. An explicit `neural` pick is the owner's cloud choice.
  const refLadder = (i: {
    network: boolean;
    supertonicReady: boolean;
    privacy: boolean;
    prefer?: "auto" | "neural" | "supertonic" | "sapi";
  }) => {
    if (i.prefer === "sapi") return "sapi";
    if (i.prefer === "neural" && i.network && !i.privacy) return "neural";
    if (i.supertonicReady) return "supertonic";
    if (i.prefer === "supertonic") return "sapi";
    if (i.network && !i.privacy) return "neural";
    return "sapi";
  };
  const refChoose = (i: {
    network: boolean;
    privacy: boolean;
    supertonicReady: boolean;
    windows: boolean;
  }) => {
    const ladder = refLadder(i);
    return ladder === "sapi" && !i.windows ? "formant" : ladder;
  };
  const bools = [true, false];

  it("chooseTtsEngine over the whole input grid", () => {
    let cases = 0;
    for (const network of bools)
      for (const supertonicReady of bools)
        for (const privacy of bools)
          for (const prefer of [undefined, "auto", "neural", "supertonic", "sapi"] as const) {
            const input = { network, supertonicReady, privacy, ...(prefer ? { prefer } : {}) };
            expect(chooseTtsEngine(input), JSON.stringify(input)).toBe(refLadder(input));
            cases += 1;
          }
    expect(cases).toBe(40);
  });

  it("chooseTts over the whole input grid, with its quality label", () => {
    const quality = {
      sapi: "system",
      supertonic: "neural-local",
      neural: "neural-online",
      formant: "low-rule",
    };
    for (const network of bools)
      for (const privacy of bools)
        for (const supertonicReady of bools)
          for (const windows of bools) {
            const input = { network, privacy, supertonicReady, windows };
            const want = refChoose(input);
            const got = chooseTts(input);
            expect(got.engine, JSON.stringify(input)).toBe(want);
            expect(got.quality).toBe(quality[want as keyof typeof quality]);
            expect(got.voice).toBe("hi-IN");
          }
  });

  it("switchMidSentence changes only a dropped online voice, to the next local one", () => {
    expect(
      switchMidSentence({ networkDropped: true, current: "neural", supertonicReady: true }),
    ).toBe("supertonic");
    expect(
      switchMidSentence({ networkDropped: true, current: "neural", supertonicReady: false }),
    ).toBe("sapi");
    for (const current of ["supertonic", "sapi"] as const)
      expect(switchMidSentence({ networkDropped: true, current, supertonicReady: false })).toBe(
        current,
      );
    expect(
      switchMidSentence({ networkDropped: false, current: "neural", supertonicReady: true }),
    ).toBe("neural");
    expect(speechSwitch("neural", false, true, true)).toBe("supertonic");
    expect(speechSwitch("neural", false, false, true)).toBe("sapi");
    expect(speechSwitch("neural", false, false, false)).toBe("formant");
    expect(speechSwitch("neural", true, false, false)).toBe("neural");
    expect(speechSwitch("sapi", false, true, true)).toBe("sapi");
  });

  it("the two older files no longer carry a ladder of their own", () => {
    for (const file of ["src/lib/friday/tts-ladder.ts", "src/lib/friday/speech-tts.ts"]) {
      const source = read(file);
      expect(source).toContain(
        file.endsWith("tts-ladder.ts") ? "legacyEngineChoice" : 'from "./tts-ladder"',
      );
      if (file.endsWith("tts-ladder.ts")) expect(source).toContain("voice-engine/tts-provider");
      expect(source).not.toMatch(/input\.privacy \|\|/);
    }
  });
});

describe("rankTtsProviders", () => {
  const infos: TtsProviderInfo[] = [
    TTS_INFO.edge,
    TTS_INFO["hindi-light"],
    TTS_INFO.supertonic,
    TTS_INFO.sapi,
  ];
  const ids = (ctx: Partial<TtsContext>, segment = EN, health?: (id: string) => TtsHealth) =>
    rankTtsProviders(infos, segment, { ...base, ...ctx }, health).order.map((i) => i.id);

  it("online with everything allowed: online voice, local voice, system voice", () => {
    expect(ids({})).toEqual(["edge", "supertonic", "sapi"]);
  });

  it("offline, or no cloud for this line, drops the online voice with its reason", () => {
    expect(ids({ online: false })).toEqual(["supertonic", "sapi"]);
    expect(ids({ allowCloud: false })).toEqual(["supertonic", "sapi"]);
    const out = rankTtsProviders(infos, EN, { ...base, online: false });
    expect(out.refused.find((r) => r.id === "edge")?.why).toBe("no network");
  });

  it("privacy mode and a sensitive line go to the system voice only, never a cloud voice", () => {
    expect(ids({ privacyMode: true })).toEqual(["sapi"]);
    expect(ids({ sensitive: true })).toEqual(["sapi"]);
    expect(ids({ privacyMode: true, sensitive: true, prefer: "neural" })).toEqual(["sapi"]);
  });

  it("with privateVoice local, a private line may use a voice on this PC but never a cloud one", () => {
    expect(ids({ sensitive: true, privateVoice: "local" })).toEqual(["supertonic", "sapi"]);
    expect(ids({ privacyMode: true, privateVoice: "local" })).toEqual(["supertonic", "sapi"]);
  });

  it("the light Hindi voice only takes Devanagari-only Hindi, when on and installed", () => {
    const on = { hindiLight: { enabled: true, installed: true } };
    expect(ids({ ...on, online: false }, HI)).toEqual(["hindi-light", "supertonic", "sapi"]);
    expect(ids({ ...on, online: false }, { text: "नमस्ते friday", lang: "hi-IN" })).toEqual([
      "supertonic",
      "sapi",
    ]);
    expect(ids({ ...on, online: false }, EN)).toEqual(["supertonic", "sapi"]);
    expect(ids({ hindiLight: { enabled: false, installed: true }, online: false }, HI)).toEqual([
      "supertonic",
      "sapi",
    ]);
    const missing = rankTtsProviders(infos, HI, {
      ...base,
      online: false,
      hindiLight: { enabled: true, installed: false },
    });
    expect(missing.order.map((i) => i.id)).toEqual(["supertonic", "sapi"]);
    expect(missing.refused.find((r) => r.id === "hindi-light")?.why).toMatch(/not downloaded/);
  });

  it("a voice that is down is left out with its reason; the system voice still stands", () => {
    const out = rankTtsProviders(infos, EN, { ...base, online: false }, (id) =>
      id === "supertonic" ? { state: "down", reason: "weights missing" } : { state: "unknown" },
    );
    expect(out.order.map((i) => i.id)).toEqual(["sapi"]);
    expect(out.refused).toContainEqual({ id: "supertonic", why: "weights missing" });
  });

  it("language: a base code is read from hi-IN, Hinglish and en-IN", () => {
    expect(langBase("hi-IN")).toBe("hi");
    expect(langBase("Hinglish")).toBe("hi");
    expect(langBase("en-IN")).toBe("en");
    expect(langBase("")).toBe("");
  });

  it("an unknown language reaches only the voices that speak any language", () => {
    expect(ids({}, { text: "bonjour", lang: "fr-FR" })).toEqual(["sapi"]);
  });
});

describe("the provider router decides the cloud voices", () => {
  const settings = (patch: Partial<VoiceCloudSettings> = {}): VoiceCloudSettings => ({
    ...DEFAULT_CLOUD_SETTINGS,
    cloudEnabled: true,
    allowedProviders: ["sarvam"],
    keyPresent: { sarvam: true },
    dailyRequests: 10,
    monthlyRequests: 100,
    ...patch,
  });
  const route = (patch: Partial<VoiceCloudSettings> = {}, ctx: Partial<TtsContext> = {}) =>
    routeVoice(
      {
        need: "tts",
        sensitive: ctx.sensitive ?? false,
        privacyMode: ctx.privacyMode ?? false,
        billingAllowsPaid: false,
        online: ctx.online ?? true,
        needHindi: true,
      },
      settings(patch),
      new UsageLedger(() => 0),
    );
  const infos = [...cloudTtsInfos(), TTS_INFO.edge, TTS_INFO.supertonic, TTS_INFO.sapi];

  it("lists the cloud voices of the router's own table, with paid ones marked", () => {
    const table = cloudTtsInfos();
    expect(table.map((i) => i.id)).toEqual(
      expect.arrayContaining(["sarvam", "azure-speech", "openai"]),
    );
    expect(table.find((i) => i.id === "openai")?.cost).toBe("paid");
    expect(table.find((i) => i.id === "sarvam")?.cost).toBe("free-quota");
    expect(table.every((i) => i.kind === "cloud" && i.privacy === "cloud" && i.viaRouter)).toBe(
      true,
    );
  });

  it("a router-approved cloud voice leads; the router's refusal keeps it out", () => {
    const allowed = rankTtsProviders(infos, HI, { ...base, cloud: route() });
    expect(allowed.order[0]?.id).toBe("sarvam");
    const quotaGone = rankTtsProviders(infos, HI, {
      ...base,
      cloud: route({ dailyRequests: 0 }),
    });
    expect(quotaGone.order.map((i) => i.id)).not.toContain("sarvam");
    expect(quotaGone.refused.find((r) => r.id === "sarvam")?.why).toMatch(/quota/);
    const none = rankTtsProviders(infos, HI, { ...base });
    expect(none.order.map((i) => i.id)).not.toContain("sarvam");
  });

  it("a router decision never overrides privacy, a sensitive line or the billing firewall", () => {
    const decision = route();
    for (const ctx of [{ privacyMode: true }, { sensitive: true }, { online: false }]) {
      const ranked = rankTtsProviders(infos, HI, { ...base, ...ctx, cloud: decision });
      expect(ranked.order.map((i) => i.id)).not.toContain("sarvam");
      expect(ranked.order.map((i) => i.id)).not.toContain("edge");
    }
    const paid = rankTtsProviders(infos, EN, {
      ...base,
      cloud: { provider: { id: "openai" } as never, active: "cloud", reason: "", refused: [] },
    });
    expect(paid.order.map((i) => i.id)).not.toContain("openai");
    expect(paid.refused.find((r) => r.id === "openai")?.why).toMatch(/paid use/);
    const approved = rankTtsProviders(infos, EN, {
      ...base,
      billingAllowsPaid: true,
      cloud: { provider: { id: "openai" } as never, active: "cloud", reason: "", refused: [] },
    });
    expect(approved.order[0]?.id).toBe("openai");
  });
});

describe("TtsFallbackManager: the fallback matrix", () => {
  const speak = (
    rig: ReturnType<typeof build>,
    ctx: Partial<TtsContext> = {},
    segment = EN,
    gen = 1,
  ) => rig.manager.speakSegment(segment, { ...base, ...ctx }, { generation: gen });

  it("local ok: the first allowed voice speaks and is reported as the engine used", async () => {
    const rig = build();
    const out = await speak(rig, { online: false });
    expect(out.ok).toBe(true);
    expect(out.engine).toBe("supertonic");
    expect(out.kind).toBe("local");
    expect(out.fallbackReason).toBe("");
    expect(out.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(rig.rigs.edge.calls).toHaveLength(0);
  });

  it("online: the online voice speaks first", async () => {
    const rig = build();
    const out = await speak(rig);
    expect(out.engine).toBe("edge");
    expect(out.kind).toBe("cloud");
  });

  it("local fails before sound: the next voice speaks, once, and the note says why", async () => {
    const rig = build({ supertonic: { failFirst: "worker is not running" } });
    const out = await speak(rig, { online: false });
    expect(out.ok).toBe(true);
    expect(out.engine).toBe("sapi");
    expect(out.attempts).toEqual([
      { id: "supertonic", ok: false, reason: "worker is not running" },
      { id: "sapi", ok: true },
    ]);
    expect(out.fallbackReason).toBe("worker is not running");
    expect(out.note).toBe(
      "FRIDAY's own voice did not speak this clause (worker is not running); the system voice did.",
    );
  });

  it("never retries forever: two voices at most, then it stops with an honest line", async () => {
    const rig = build({
      edge: { failFirst: "offline" },
      supertonic: { failFirst: "crashed" },
    });
    const out = await speak(rig);
    expect(out.ok).toBe(false);
    expect(out.engine).toBeNull();
    expect(out.attempts.map((a) => a.id)).toEqual(["edge", "supertonic"]);
    expect(rig.rigs.sapi.calls).toHaveLength(0);
    expect(rig.rigs.edge.calls).toHaveLength(1);
    expect(out.note).toMatch(/No voice could speak this clause/);
  });

  it("a voice that makes no audio counts as a failure", async () => {
    const rig = build({ supertonic: { chunks: 0 } });
    const out = await speak(rig, { online: false });
    expect(out.engine).toBe("sapi");
    expect(out.attempts[0]).toMatchObject({
      id: "supertonic",
      ok: false,
      reason: "it made no audio",
    });
  });

  it("a voice that fails after sound began is kept and the voice does not change inside the clause", async () => {
    const rig = build({ edge: { chunks: 3, failAfter: { chunks: 1, message: "stream cut" } } });
    const seen: string[] = [];
    const out = await rig.manager.speakSegment(EN, base, {
      generation: 1,
      onChunk: (chunk) => seen.push(chunk.engine),
    });
    expect(out.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.engine).toBe("edge");
    expect(out.chunks).toHaveLength(1);
    expect(seen).toEqual(["edge"]);
    expect(rig.rigs.supertonic.calls).toHaveLength(0);
    expect(out.note).toMatch(/part way/);
  });

  it("the next clause may use another voice (a change at a clause boundary), and says so", async () => {
    const rig = build({ edge: { failFirst: "network dropped" } });
    const first = await speak(rig, { online: true }, EN, 1);
    expect(first.engine).toBe("supertonic");
    const second = await speak(rig, { online: false }, EN, 1);
    expect(second.engine).toBe("supertonic");
    const third = await speak(rig, { online: true, privacyMode: true }, EN, 1);
    expect(third.engine).toBe("sapi");
    expect(third.note).toMatch(/changed from supertonic to sapi at a clause boundary/);
  });

  it("privacy mode and a sensitive line never reach a cloud voice, even if the local ones fail", async () => {
    for (const ctx of [{ privacyMode: true }, { sensitive: true }]) {
      const rig = build({ sapi: { failFirst: "no system voice" } });
      const out = await speak(rig, ctx);
      expect(out.ok).toBe(false);
      expect(rig.rigs.edge.calls).toHaveLength(0);
      expect(rig.rigs.supertonic.calls).toHaveLength(0);
    }
  });

  it("looks at the text itself with the privacy firewall's check, whatever the caller said", async () => {
    const rig = build();
    const manager = new TtsFallbackManager(
      Object.values(rig.rigs).map((r) => r.provider),
      {
        isSensitive: (text) => /password/i.test(text),
      },
    );
    const out = await manager.speakSegment({ text: "your password is 1234", lang: "en-IN" }, base, {
      generation: 1,
    });
    expect(out.engine).toBe("sapi");
    expect(rig.rigs.edge.calls).toHaveLength(0);
  });

  it("billing: a paid cloud voice is refused until paid use is allowed, and is never tried", async () => {
    const openai = TTS_INFO.edge;
    const paidInfo: TtsProviderInfo = {
      ...cloudTtsInfos().find((i) => i.id === "openai")!,
    };
    expect(openai.cost).toBe("free");
    const rig = build({}, [paidInfo]);
    const decision = {
      provider: { id: "openai" } as never,
      active: "cloud" as const,
      reason: "",
      refused: [],
    };
    const out = await speak(rig, { billingAllowsPaid: false, cloud: decision, online: true });
    expect(out.engine).toBe("edge");
    expect(rig.cloud[0]?.calls).toHaveLength(0);
    expect(out.refused.find((r) => r.id === "openai")?.why).toMatch(/paid use/);
  });

  it("offline: the online voice is not tried and the reason is on the note", async () => {
    const rig = build();
    const out = await speak(rig, { online: false });
    expect(rig.rigs.edge.calls).toHaveLength(0);
    expect(out.refused.find((r) => r.id === "edge")?.why).toBe("no network");
    expect(out.note).toBe("");
  });

  it("a provider that reports itself down is skipped, and the note names it", async () => {
    const rig = build({ edge: { health: { state: "down", reason: "no key saved" } } });
    const out = await speak(rig);
    expect(out.engine).toBe("supertonic");
    expect(out.fallbackReason).toBe("no key saved");
    expect(out.note).toBe(
      "The online voice did not speak this clause (no key saved); FRIDAY's own voice did.",
    );
  });

  it("Hindi, light voice on and installed: the light voice speaks Devanagari-only Hindi offline", async () => {
    const rig = build();
    const out = await speak(
      rig,
      { online: false, hindiLight: { enabled: true, installed: true } },
      HI,
    );
    expect(out.engine).toBe("hindi-light");
    expect(rig.rigs["hindi-light"].calls[0]?.options.lang).toBe("hi-IN");
  });

  it("carries the clause's rate, pitch, style and generation to the voice", async () => {
    const rig = build();
    await rig.manager.speakSegment(
      EN,
      { ...base, online: false },
      {
        generation: 7,
        rate: 1.2,
        pitch: -1,
        style: "F2",
      },
    );
    expect(rig.rigs.supertonic.calls[0]?.options).toEqual({
      lang: "en-IN",
      rate: 1.2,
      pitch: -1,
      style: "F2",
      generation: 7,
    });
  });

  it("a failed voice can sit out a cool-down, but the system voice never does", async () => {
    let t = 0;
    const rig = build({ supertonic: { failFirst: "boom" }, sapi: { failFirst: "boom" } });
    const manager = new TtsFallbackManager(
      Object.values(rig.rigs).map((r) => r.provider),
      {
        coolDownMs: 10_000,
        now: () => t,
      },
    );
    const ctx = { ...base, online: false };
    await manager.speakSegment(EN, ctx, { generation: 1 });
    expect(manager.status().cooling).toEqual(["supertonic"]);
    await manager.speakSegment(EN, ctx, { generation: 1 });
    expect(rig.rigs.supertonic.calls).toHaveLength(1);
    expect(rig.rigs.sapi.calls).toHaveLength(2);
    t = 10_001;
    await manager.speakSegment(EN, ctx, { generation: 1 });
    expect(rig.rigs.supertonic.calls).toHaveLength(2);
  });
});

describe("TtsFallbackManager: generations", () => {
  it("drops chunks of another generation and never mixes them into the clause", async () => {
    const rig = build({ supertonic: { generationOffset: -1, chunks: 3 } });
    const out = await rig.manager.speakSegment(EN, { ...base, online: false }, { generation: 5 });
    expect(out.droppedChunks).toBe(3);
    // Nothing from the wrong generation counts as sound, so the next voice speaks it.
    expect(out.engine).toBe("sapi");
    expect(out.chunks).toHaveLength(2);
    expect(out.attempts[0]).toMatchObject({ id: "supertonic", ok: false });
    expect(out.chunks.every((c) => c.generation === 5)).toBe(true);
  });

  it("a new generation settles the old one: its voices are told and its late chunks are dropped", async () => {
    const rig = build({
      supertonic: { chunks: 4, between: () => rig.manager.begin(2) },
    });
    rig.manager.begin(1);
    const out = await rig.manager.speakSegment(EN, { ...base, online: false }, { generation: 1 });
    expect(out.stale).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.chunks).toEqual([]);
    expect(rig.rigs.supertonic.cancelled).toContain(1);
    expect(rig.rigs.sapi.calls).toHaveLength(0);
  });

  it("a cancelled generation speaks nothing, and a later one does", async () => {
    const rig = build();
    rig.manager.begin(3);
    rig.manager.cancel(3);
    const stale = await rig.manager.speakSegment(EN, base, { generation: 3 });
    expect(stale.stale).toBe(true);
    expect(rig.rigs.edge.calls).toHaveLength(0);
    expect(Object.values(rig.rigs).every((r) => r.cancelled.includes(3))).toBe(true);
    rig.manager.begin(4);
    const live = await rig.manager.speakSegment(EN, base, { generation: 4 });
    expect(live.ok).toBe(true);
    expect(live.generation).toBe(4);
  });

  it("a clause for an older reply is stale once a newer one began", async () => {
    const rig = build();
    rig.manager.begin(1);
    rig.manager.begin(2);
    const old = await rig.manager.speakSegment(EN, base, { generation: 1 });
    expect(old.stale).toBe(true);
    expect(rig.rigs.edge.calls).toHaveLength(0);
  });

  it("reports the last clause for diagnostics", async () => {
    const rig = build();
    await rig.manager.speakSegment(EN, { ...base, online: false }, { generation: 1 });
    expect(rig.manager.status().last?.engine).toBe("supertonic");
  });
});

describe("wiring", () => {
  it("the real speech path uses the manager, with the system voice left to the page after it", () => {
    const library = read("src/lib/friday/voice-library.ts");
    expect(library).toContain("TtsFallbackManager");
    expect(library).toContain("voice-engine/tts-provider");
  });

  it("no cloud voice can be reached without the privacy, sensitive and billing checks in the ranking", () => {
    const provider = read("src/lib/friday/voice-engine/tts-provider.ts");
    expect(provider).toContain("cloudBlockReason(ctx)");
    expect(provider).toContain("billingAllowsPaid");
    expect(provider).toContain("ctx.cloud");
  });
});
