import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billing } from "../../src/lib/friday/billing";
import { preferences } from "../../src/lib/friday/preferences";
import {
  billingAllowsPaidNow,
  cloudClipGate,
  resetPrefetchedSpeech,
  speakText,
} from "../../src/lib/friday/voice-library";
import { speakWithCloud } from "../../src/lib/friday/voice-engine/voice-cloud-client";
import {
  DEFAULT_VOICE_CLOUD_PREFS,
  type VoiceCloudPrefs,
  sanitizeCloudPrefs,
} from "../../src/lib/friday/voice-engine/voice-cloud-settings";
import { UsageLedger } from "../../src/lib/friday/voice-engine/voice-provider-router";

type Win = { friday?: unknown };
const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };

const bridgeWith = (paidAccess: boolean) => ({
  billingPolicy: async () => ({
    billing: {
      paidAccess,
      autoPaidUsage: false,
      killSwitch: false,
      grantScope: "off",
      grantUntil: 0,
      grantedAt: 0,
    },
    policy: "free-preferred",
    summary: "test",
  }),
});

const SARVAM_ON: VoiceCloudPrefs = {
  ...DEFAULT_VOICE_CLOUD_PREFS,
  cloudEnabled: true,
  allowedProviders: ["sarvam"],
  speakWith: "sarvam" as const,
  paidAllowed: true,
  paidApproved: true,
  spendLimitUsd: 5,
  dailyRequests: 5,
  monthlyRequests: 50,
  monthlyAudioMinutes: 5,
};

async function setPaidAccess(on: boolean) {
  g.window = { friday: bridgeWith(on) };
  await billing.refresh();
}

describe("billing state reaches the cloud voice callers", () => {
  const saved = { window: g.window, Audio: g.Audio };
  const before = preferences.getSnapshot().voice.cloudVoice;

  beforeEach(() => {
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        setTimeout(() => this.onended?.(), 1);
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
    preferences.setVoice({ cloudVoice: SARVAM_ON, privacyMode: false });
    resetPrefetchedSpeech();
  });

  afterEach(async () => {
    g.window = saved.window;
    g.Audio = saved.Audio;
    preferences.setVoice({ cloudVoice: before });
    resetPrefetchedSpeech();
    await billing.refresh();
  });

  it("fails closed: no bridge or an unreadable billing state means no paid use", async () => {
    await setPaidAccess(true);
    expect(billingAllowsPaidNow()).toBe(true);
    g.window = undefined;
    await billing.refresh();
    expect(billingAllowsPaidNow()).toBe(false);
    await setPaidAccess(true);
    g.window = { friday: { billingPolicy: async () => Promise.reject(new Error("down")) } };
    await billing.refresh();
    expect(billingAllowsPaidNow()).toBe(false);
    expect(cloudClipGate().billingAllowsPaid).toBe(false);
  });

  it("reads the same switch the settings page shows", async () => {
    await setPaidAccess(true);
    expect(billingAllowsPaidNow()).toBe(true);
    await setPaidAccess(false);
    expect(billingAllowsPaidNow()).toBe(false);
  });

  it("the clip gate ranks Sarvam as paid and carries the billing answer", async () => {
    await setPaidAccess(false);
    expect(cloudClipGate()).toMatchObject({ info: { cost: "paid" }, billingAllowsPaid: false });
    await setPaidAccess(true);
    expect(cloudClipGate()).toMatchObject({ info: { cost: "paid" }, billingAllowsPaid: true });
  });

  it("the speaking path does not even ask Sarvam while paid access is off, and asks it when on", async () => {
    const tuning = {
      voiceName: "",
      lang: "hi-IN",
      rate: 1,
      pitch: 1,
      volume: 1,
      kind: "neural" as const,
    };
    const run = async (paid: boolean) => {
      await setPaidAccess(paid);
      resetPrefetchedSpeech();
      const asked: string[] = [];
      g.window = {
        friday: {
          ...bridgeWith(paid),
          speakNeural: async () => ({
            ok: true,
            audioBase64: "TE9DQUw=",
            mime: "audio/mpeg",
            engine: "local",
          }),
        },
      };
      await speakText("Namaste.", {
        ...tuning,
        cloudClip: async (text) => {
          asked.push(text);
          return { audioBase64: "Q0xPVUQ=", mime: "audio/wav", engine: "sarvam" };
        },
      });
      return asked;
    };
    expect(await run(false)).toEqual([]);
    expect((await run(true)).length).toBe(1);
  });

  it("speakWithCloud, given the billing answer the app reads, refuses Sarvam off, allows it on, refuses when the state is missing", async () => {
    const prefs = sanitizeCloudPrefs(SARVAM_ON);
    const input = {
      text: "नमस्ते दुनिया",
      language: "hi-IN",
      prefs,
      keys: { sarvam: true },
      privacyMode: false,
      online: true,
    };
    const spoke = async () => ({ ok: true as const, audioBase64: "eA==", mime: "audio/mpeg" });
    const call = (billingAllowsPaid?: boolean) =>
      speakWithCloud(
        "sarvam",
        { ...input, ...(billingAllowsPaid === undefined ? {} : { billingAllowsPaid }) },
        { ledger: new UsageLedger(), speak: spoke },
      );
    await setPaidAccess(false);
    expect(await call(billingAllowsPaidNow())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/paid access must be on/),
    });
    await setPaidAccess(true);
    expect(await call(billingAllowsPaidNow())).toMatchObject({ ok: true });
    g.window = undefined;
    await billing.refresh();
    expect(await call(billingAllowsPaidNow())).toMatchObject({ ok: false });
    expect(await call()).toMatchObject({ ok: false });
  });
});
