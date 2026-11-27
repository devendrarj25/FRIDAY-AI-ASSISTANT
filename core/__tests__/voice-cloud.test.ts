import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { speakWithCloud } from "../../src/lib/friday/voice-engine/voice-cloud-client";
import {
  DEFAULT_VOICE_CLOUD_PREFS,
  sanitizeCloudPrefs,
} from "../../src/lib/friday/voice-engine/voice-cloud-settings";
import {
  PAID_BY_DEFAULT,
  PROVIDERS,
  UsageLedger,
} from "../../src/lib/friday/voice-engine/voice-provider-router";

const require_ = createRequire(import.meta.url);
const cloudModule = require_(path.resolve(import.meta.dirname, "../../electron/voice-cloud.cjs"));
const {
  createVoiceCloud,
  buildSarvamTts,
  sarvamModelFor,
  SARVAM_V2_FEMALE,
  buildAzureTts,
  parseSarvamTts,
  parseSarvamStt,
  escapeXml,
} = cloudModule;

const voicePrefs = (over: Record<string, unknown> = {}) => ({
  privacyMode: false,
  cloudVoice: {
    cloudEnabled: true,
    allowedProviders: ["sarvam", "azure-speech"],
    azureRegion: "centralindia",
    azureVoice: "hi-IN-SwaraNeural",
    ...over,
  },
});

function rig(
  options: {
    prefs?: unknown;
    secrets?: Record<string, string>;
    respond?: () => Response | Promise<Response>;
    /** The billing firewall's answer. Sarvam has no free-allowance proof, so most rows turn paid access on. */
    paid?: boolean;
  } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return (
      options.respond?.() ??
      new Response(JSON.stringify({ audios: ["QUJD"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };
  const api = createVoiceCloud({
    fetchImpl,
    getSecret: (id: string) =>
      (options.secrets ?? {
        "voice-sarvam": "sk-sarvam-SECRET",
        "voice-azure-speech": "az-SECRET",
      })[id] ?? "",
    prefs: () => options.prefs ?? voicePrefs(),
    paidUnlocked: () => options.paid !== false,
  });
  return { api, calls };
}

describe("cloud speech request shapes (from the providers' pages)", () => {
  it("builds the Sarvam text-to-speech request", () => {
    const spec = buildSarvamTts({ text: "नमस्ते", language: "hi-IN", speaker: "shubh" });
    expect(spec.url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(spec.keyHeader).toBe("api-subscription-key");
    expect(JSON.parse(spec.body)).toEqual({
      text: "नमस्ते",
      language_code: "hi-IN",
      model: "bulbul:v3",
      speech_sample_rate: 24000,
      speaker: "shubh",
    });
    // With no voice named, a speaker the provider states is female (bulbul:v2) is used.
    expect(JSON.parse(buildSarvamTts({ text: "a", language: "en-IN" }).body)).toMatchObject({
      speaker: "anushka",
      model: "bulbul:v2",
      speech_sample_rate: 22050,
    });
    expect(sarvamModelFor("manisha")).toBe("bulbul:v2");
    expect(sarvamModelFor("priya")).toBe("bulbul:v3");
    expect(sarvamModelFor("shubh_hi_devotional")).toBe("bulbul:v4-flash");
    // A mixed Hindi and English persona has a longer language part (enhi).
    expect(sarvamModelFor("simran_enhi_customer")).toBe("bulbul:v4-flash");
    expect(sarvamModelFor("aparna_hi_customer")).toBe("bulbul:v4-flash");
    expect(SARVAM_V2_FEMALE).toEqual(["anushka", "manisha", "vidya", "arya"]);
    const paced = JSON.parse(
      buildSarvamTts({ text: "a", language: "hi-IN", speaker: "priya", pace: 1.2 }).body,
    );
    expect(paced.pace).toBe(1.2);
    expect(
      JSON.parse(buildSarvamTts({ text: "a", language: "hi-IN", pace: 1 }).body).pace,
    ).toBeUndefined();
    expect(JSON.parse(buildSarvamTts({ text: "a", language: "hi-IN", pace: 9 }).body).pace).toBe(2);
    expect(parseSarvamTts({ audios: ["QUJD"] })).toEqual({
      audioBase64: "QUJD",
      mime: "audio/wav",
    });
    expect(parseSarvamTts({ audios: [] })).toBeNull();
  });

  it("builds the Azure request with an escaped SSML body", () => {
    const spec = buildAzureTts({
      region: "centralindia",
      voice: "hi-IN-SwaraNeural",
      language: "hi-IN",
      text: 'a < b & "c"',
    });
    expect(spec.url).toBe("https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(spec.keyHeader).toBe("Ocp-Apim-Subscription-Key");
    expect(spec.headers["X-Microsoft-OutputFormat"]).toBe("riff-24khz-16bit-mono-pcm");
    expect(spec.headers["Content-Type"]).toBe("application/ssml+xml");
    expect(spec.body).toContain("a &lt; b &amp; &quot;c&quot;");
    expect(escapeXml("<script>")).toBe("&lt;script&gt;");
  });

  it("reads a Sarvam transcript", () => {
    expect(
      parseSarvamStt({ transcript: "hello", language_code: "hi-IN", language_probability: 0.9 }),
    ).toEqual({
      text: "hello",
      language: "hi-IN",
      confidence: 0.9,
    });
    expect(parseSarvamStt({})).toBeNull();
  });
});

describe("cloud speech gates in the main process", () => {
  it("calls only the fixed host with the key in the header, never in the URL or body", async () => {
    const { api, calls } = rig();
    const out = await api.speak("sarvam", { text: "नमस्ते", language: "hi-IN" });
    expect(out).toMatchObject({
      ok: true,
      provider: "sarvam",
      audioBase64: "QUJD",
      mime: "audio/wav",
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.sarvam.ai");
    expect((calls[0]!.init.headers as Record<string, string>)["api-subscription-key"]).toBe(
      "sk-sarvam-SECRET",
    );
    expect(calls[0]!.url).not.toContain("SECRET");
    expect(String(calls[0]!.init.body)).not.toContain("SECRET");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("refuses when cloud is off, the provider is not allowed, privacy is on, or no key is saved", async () => {
    const cases: [unknown, Record<string, string> | undefined, RegExp][] = [
      [voicePrefs({ cloudEnabled: false }), undefined, /switched off/],
      [voicePrefs({ allowedProviders: [] }), undefined, /allowed list/],
      [{ ...voicePrefs(), privacyMode: true }, undefined, /on this PC/],
      [voicePrefs(), {}, /no key/],
      [{}, undefined, /switched off/],
    ];
    for (const [prefs, secrets, why] of cases) {
      const { api, calls } = rig({ prefs, ...(secrets ? { secrets } : {}) });
      const out = await api.speak("sarvam", { text: "hi", language: "en-IN" });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(why);
      expect(calls).toEqual([]);
    }
  });

  it("refuses sensitive text in the main process before any network call, whatever the renderer sent", async () => {
    for (const provider of ["sarvam", "azure-speech"]) {
      for (const text of [
        "my password is x",
        "card 4111 1111 1111 1111 expires soon",
        "my pin is 4821",
      ]) {
        const { api, calls } = rig();
        const out = await api.speak(provider, { text, language: "en-IN" });
        expect(out).toMatchObject({ ok: false, sensitive: true });
        expect(out.error).toMatch(/sensitive/i);
        expect(calls).toEqual([]);
      }
    }
  });

  it("refuses a clause that looks harmless when the renderer says the whole reply is sensitive", async () => {
    const { api, calls } = rig();
    const out = await api.speak("sarvam", {
      text: "The number is on the next line.",
      language: "en-IN",
      sensitiveReply: true,
    });
    expect(out).toMatchObject({ ok: false, sensitive: true });
    expect(calls).toEqual([]);
  });

  it("lets a harmless clause through, and a false or missing flag never lifts a refusal", async () => {
    const ok = rig();
    expect(
      await ok.api.speak("sarvam", {
        text: "The weather is fine today.",
        language: "en-IN",
        sensitiveReply: false,
      }),
    ).toMatchObject({ ok: true });
    expect(ok.calls).toHaveLength(1);
    const blocked = rig();
    const out = await blocked.api.speak("azure-speech", {
      text: "my password is x",
      language: "en-IN",
      sensitiveReply: false,
    });
    expect(out.ok).toBe(false);
    expect(blocked.calls).toEqual([]);
  });

  it("refuses an unknown provider, empty or oversized text and a bad language", async () => {
    const { api, calls } = rig();
    expect((await api.speak("evil", { text: "x", language: "en-IN" })).ok).toBe(false);
    expect((await api.speak("sarvam", { text: "  ", language: "en-IN" })).ok).toBe(false);
    expect(
      (await api.speak("sarvam", { text: "x".repeat(2501), language: "en-IN" })).error,
    ).toMatch(/at most/);
    expect((await api.speak("sarvam", { text: "x", language: "../etc" })).error).toMatch(/hi-IN/);
    expect(
      (await api.speak("sarvam", { text: "x", language: "hi-IN", speaker: "A B" })).error,
    ).toMatch(/voice name/);
    expect(calls).toEqual([]);
  });

  it("needs an Azure region and voice, and builds the regional address", async () => {
    const none = rig({ prefs: voicePrefs({ azureRegion: "", azureVoice: "" }) });
    expect((await none.api.speak("azure-speech", { text: "hi", language: "hi-IN" })).error).toMatch(
      /region/,
    );
    const ok = rig({
      respond: () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 }),
    });
    const out = await ok.api.speak("azure-speech", { text: "hi", language: "hi-IN" });
    expect(out).toMatchObject({ ok: true, mime: "audio/wav", audioBase64: "UklGRg==" });
    expect(ok.calls[0]!.url).toBe(
      "https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1",
    );
    expect(rig({ prefs: voicePrefs({ azureRegion: "evil.com/x" }) }).api).toBeTruthy();
    const bad = rig({ prefs: voicePrefs({ azureRegion: "evil.com/x" }) });
    expect((await bad.api.speak("azure-speech", { text: "hi", language: "hi-IN" })).ok).toBe(false);
    expect(bad.calls).toEqual([]);
  });

  it("explains a refused key or a rate limit without showing the key", async () => {
    for (const [status, why] of [
      [401, /key was refused/],
      [429, /rate or quota/],
      [500, /answered 500/],
    ] as const) {
      const { api } = rig({
        respond: () => new Response("sk-sarvam-SECRET went wrong", { status }),
      });
      const out = await api.speak("sarvam", { text: "hi", language: "en-IN" });
      expect(out.error).toMatch(why);
      expect(JSON.stringify(out)).not.toContain("SECRET");
    }
  });

  it("scrubs the key from a network error and reports a timeout plainly", async () => {
    const boom = createVoiceCloud({
      fetchImpl: async () => {
        throw new Error("connect failed for sk-sarvam-SECRET");
      },
      getSecret: () => "sk-sarvam-SECRET",
      prefs: () => voicePrefs(),
    });
    const out = await boom.speak("sarvam", { text: "hi", language: "en-IN" });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("transcribes with the codemix mode for Hinglish, only through Sarvam", async () => {
    const { api, calls } = rig({
      respond: () =>
        new Response(JSON.stringify({ transcript: "report bhej do", language_code: "hi-IN" }), {
          status: 200,
        }),
    });
    const wav = Buffer.from("RIFFxxxx").toString("base64");
    const out = await api.transcribe("sarvam", { audioBase64: wav, language: "unknown" });
    expect(out).toMatchObject({ ok: true, text: "report bhej do", language: "hi-IN" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("mode")).toBe("codemix");
    expect(form.get("language_code")).toBe("unknown");
    expect((await api.transcribe("azure-speech", { audioBase64: wav })).ok).toBe(false);
    expect((await api.transcribe("sarvam", { audioBase64: "" })).ok).toBe(false);
    expect((await api.transcribe("sarvam", { audioBase64: wav, language: "bad" })).ok).toBe(false);
  });
});

describe("cloud speech from the renderer", () => {
  const prefs = sanitizeCloudPrefs({
    ...DEFAULT_VOICE_CLOUD_PREFS,
    cloudEnabled: true,
    allowedProviders: ["sarvam"],
    dailyRequests: 2,
    monthlyRequests: 10,
    monthlyAudioMinutes: 5,
    sarvamSpeaker: "shubh",
    paidAllowed: true,
    paidApproved: true,
    spendLimitUsd: 5,
  });
  const base = {
    billingAllowsPaid: true,
    text: "नमस्ते दुनिया",
    language: "hi-IN",
    prefs,
    keys: { sarvam: true },
    privacyMode: false,
    online: true,
  };

  it("refuses Sarvam while the billing firewall says no, whatever the saved paid settings, and counts nothing", async () => {
    const calls: unknown[] = [];
    const speak = async () => (calls.push(1), { ok: true, audioBase64: "x" });
    for (const input of [
      { ...base, billingAllowsPaid: false },
      { ...base, billingAllowsPaid: undefined },
      { ...base, prefs: { ...prefs, paidAllowed: false, spendLimitUsd: 0 } },
      { ...base, prefs: { ...prefs, paidApproved: false } },
    ]) {
      const { billingAllowsPaid, ...rest } = input;
      const ledger = new UsageLedger();
      const out = await speakWithCloud("sarvam", billingAllowsPaid === undefined ? rest : input, {
        ledger,
        speak,
      });
      expect(out).toMatchObject({
        ok: false,
        error: expect.stringMatching(/paid access must be on/),
      });
      expect(ledger.usage("sarvam").day).toBe(0);
    }
    expect(calls).toEqual([]);
  });

  it("counts the use, then asks the main process, with the speaker and no key", async () => {
    const ledger = new UsageLedger(() => Date.parse("2026-02-02T10:00:00Z"));
    const seen: unknown[] = [];
    const out = await speakWithCloud("sarvam", base, {
      ledger,
      speak: async (provider, request) => (
        seen.push([provider, request]),
        { ok: true, audioBase64: "QUJD", mime: "audio/wav" }
      ),
    });
    expect(out).toMatchObject({ ok: true, provider: "sarvam" });
    expect(seen).toEqual([["sarvam", { text: base.text, language: "hi-IN", speaker: "shubh" }]]);
    expect(ledger.usage("sarvam").day).toBe(1);
  });

  it("carries the whole-reply flag to the main process and lets the router refuse a sensitive reply", async () => {
    const ledger = new UsageLedger(() => Date.parse("2026-02-02T10:00:00Z"));
    const seen: unknown[] = [];
    const speak = async (provider: string, request: unknown) => (
      seen.push([provider, request]),
      { ok: true, audioBase64: "QUJD", mime: "audio/wav" }
    );
    const refused = await speakWithCloud(
      "sarvam",
      { ...base, sensitiveReply: true },
      { ledger, speak },
    );
    expect(refused.ok).toBe(false);
    expect(seen).toEqual([]);
    expect(ledger.usage("sarvam").day).toBe(0);
    // Plain text is never flagged by the client, so the request keeps its old shape.
    await speakWithCloud("sarvam", base, { ledger, speak });
    expect(seen).toEqual([["sarvam", { text: base.text, language: "hi-IN", speaker: "shubh" }]]);
  });

  it("refuses without calling or counting when the router says no", async () => {
    const calls: unknown[] = [];
    const speak = async () => (calls.push(1), { ok: true, audioBase64: "x" });
    for (const input of [
      { ...base, keys: {} },
      { ...base, privacyMode: true },
      { ...base, online: false },
      { ...base, prefs: { ...prefs, cloudEnabled: false } },
      { ...base, prefs: { ...prefs, monthlyAudioMinutes: 0 } },
    ]) {
      const ledger = new UsageLedger();
      const out = await speakWithCloud("sarvam", input, { ledger, speak });
      expect(out.ok).toBe(false);
      expect(ledger.usage("sarvam").day).toBe(0);
    }
    expect(calls).toEqual([]);
  });

  it("stops at the daily quota and falls back to local rather than a paid provider", async () => {
    const ledger = new UsageLedger(() => Date.parse("2026-02-02T10:00:00Z"));
    const speak = async () => ({ ok: true, audioBase64: "QUJD" });
    expect((await speakWithCloud("sarvam", base, { ledger, speak })).ok).toBe(true);
    expect((await speakWithCloud("sarvam", base, { ledger, speak })).ok).toBe(true);
    const third = await speakWithCloud("sarvam", base, { ledger, speak });
    expect(third).toMatchObject({ ok: false, error: expect.stringMatching(/daily quota/) });
  });

  it("passes the provider's refusal through", async () => {
    const out = await speakWithCloud("sarvam", base, {
      ledger: new UsageLedger(),
      speak: async () => ({ ok: false, error: "the key was refused" }),
    });
    expect(out).toEqual({ ok: false, error: "the key was refused" });
  });
});

describe("the gate refuses a paid provider while paid access is off", () => {
  const prefsFor = (paid: Record<string, unknown> = {}) =>
    voicePrefs({ allowedProviders: ["sarvam", "azure-speech"], ...paid });
  const make = (extra: Record<string, unknown>) =>
    createVoiceCloud({
      fetchImpl: async () => new Response("{}"),
      getSecret: () => "key",
      prefs: () => prefsFor(),
      ...extra,
    });

  it("keeps a provider with a free allowance working with no paid dependency wired", () => {
    expect(make({}).gate("azure-speech").ok).toBe(true);
  });

  it("refuses Sarvam by default (a signup credit is not a free allowance) and allows it once paid access is on", () => {
    const off = make({}).gate("sarvam");
    expect(off.ok).toBe(false);
    expect(off.error).toMatch(/paid/i);
    expect(make({ paidUnlocked: () => false }).gate("sarvam").ok).toBe(false);
    expect(make({ paidUnlocked: () => true }).gate("sarvam").ok).toBe(true);
  });

  it("refuses a provider that costs money when the billing firewall says paid is off", () => {
    const gate = make({ costsMoney: () => true, paidUnlocked: () => false }).gate("sarvam");
    expect(gate.ok).toBe(false);
    expect(gate.error).toMatch(/paid/i);
  });

  it("allows it once paid access is on, and refuses when the firewall cannot answer", () => {
    expect(make({ costsMoney: () => true, paidUnlocked: () => true }).gate("sarvam").ok).toBe(true);
    expect(
      make({
        costsMoney: () => true,
        paidUnlocked: () => {
          throw new Error("no billing");
        },
      }).gate("sarvam").ok,
    ).toBe(false);
    expect(make({ costsMoney: () => true }).gate("sarvam").ok).toBe(false);
  });

  it("never reaches the network or reads the key when the paid check refuses", async () => {
    let fetched = 0;
    let keyReads = 0;
    const api = createVoiceCloud({
      fetchImpl: async () => {
        fetched += 1;
        return new Response("{}");
      },
      getSecret: () => {
        keyReads += 1;
        return "key";
      },
      prefs: () => prefsFor(),
      costsMoney: () => true,
      paidUnlocked: () => false,
    });
    const out = await api.speak("sarvam", { text: "hello", language: "en-IN" });
    expect(out.ok).toBe(false);
    expect(fetched).toBe(0);
    expect(keyReads).toBe(0);
  });

  it("the main-process paid set cannot drift from the router: every paid-by-default lane and every keyed lane with no free-allowance proof is in it", async () => {
    const fs = await import("node:fs");
    for (const id of PAID_BY_DEFAULT) expect(cloudModule.PAID_PROVIDERS.has(id), id).toBe(true);
    const unproven = PROVIDERS.filter(
      (p) =>
        p.id in cloudModule.SECRET_IDS &&
        (p.lane?.costProof === "none" || p.lane?.costProof === "trial"),
    ).map((p) => p.id);
    expect(unproven).toContain("sarvam");
    for (const id of unproven) expect(cloudModule.PAID_PROVIDERS.has(id), id).toBe(true);
    // The other way round: nothing with proof of a free allowance is held back as paid.
    for (const id of cloudModule.PAID_PROVIDERS) {
      const row = PROVIDERS.find((p) => p.id === id);
      expect(row?.lane?.costProof === "official" || row?.lane?.costProof === "cached", id).toBe(
        false,
      );
    }
    const main = fs.readFileSync("electron/main.cjs", "utf8");
    expect(main).toMatch(
      /createVoiceCloud\(\{\s*paidUnlocked: \(\) => billingPolicy\.paidUnlocked\(billingState\(\)\)\.allowed === true,/,
    );
  });
});
