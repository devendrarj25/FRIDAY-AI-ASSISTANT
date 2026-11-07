import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUD_SETTINGS,
  PROVIDERS,
  routeVoice,
  UsageLedger,
  type RouteRequest,
  type VoiceCloudSettings,
} from "../../src/lib/friday/voice-engine/voice-provider-router";
import { missingModels, selectProfile } from "../../src/lib/friday/voice-engine/hardware-profile";

const request = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  need: "text",
  sensitive: false,
  privacyMode: false,
  billingAllowsPaid: false,
  online: true,
  ...over,
});
const cloud = (over: Partial<VoiceCloudSettings> = {}): VoiceCloudSettings => ({
  ...DEFAULT_CLOUD_SETTINGS,
  cloudEnabled: true,
  allowedProviders: ["gemini", "openai", "azure-speech"],
  keyPresent: { gemini: true, openai: true, "azure-speech": true },
  dailyRequests: 2,
  monthlyRequests: 5,
  monthlyAudioMinutes: 10,
  ...over,
});

describe("voice provider router", () => {
  it("defaults to local and never reaches the cloud without explicit settings", () => {
    const d = routeVoice(request(), DEFAULT_CLOUD_SETTINGS, new UsageLedger());
    expect(d.active).toBe("local");
    expect(d.provider?.kind).toBe("local");
  });

  it("uses an allowed free cloud provider that has a key and quota", () => {
    const d = routeVoice(request({ need: "stt" }), cloud(), new UsageLedger());
    expect(d.active).toBe("cloud");
    expect(d.provider?.id).toBe("gemini");
  });

  it("falls back to local, not to a paid provider, when the quota is used up", () => {
    const ledger = new UsageLedger();
    ledger.record("gemini");
    ledger.record("gemini");
    const d = routeVoice(
      request({ need: "stt" }),
      cloud({ allowedProviders: ["gemini", "openai"] }),
      ledger,
    );
    expect(d.active).toBe("local");
    expect(d.refused.find((r) => r.id === "gemini")?.why).toMatch(/daily quota/);
    expect(d.refused.find((r) => r.id === "openai")?.why).toMatch(/paid/);
  });

  it("treats a quota of zero as not set", () => {
    const d = routeVoice(request({ need: "stt" }), cloud({ dailyRequests: 0 }), new UsageLedger());
    expect(d.active).toBe("local");
  });

  it("refuses a paid provider unless paid use is allowed, approved, limited above zero and not blocked by billing", () => {
    const paidOnly = { need: "realtime-audio" as const, needInterruption: true };
    const allowed = cloud({
      allowedProviders: ["openai"],
      paidAllowed: true,
      paidApproved: true,
      spendLimitUsd: 1,
    });
    expect(
      routeVoice(request({ ...paidOnly, billingAllowsPaid: true }), allowed, new UsageLedger())
        .provider?.id,
    ).toBe("openai");
    expect(
      routeVoice(request({ ...paidOnly, billingAllowsPaid: false }), allowed, new UsageLedger())
        .active,
    ).not.toBe("cloud");
    expect(
      routeVoice(request(paidOnly), { ...allowed, paidApproved: false }, new UsageLedger()).active,
    ).not.toBe("cloud");
    expect(
      routeVoice(request(paidOnly), { ...allowed, spendLimitUsd: 0 }, new UsageLedger()).active,
    ).not.toBe("cloud");
  });

  it("keeps privacy mode, sensitive content and a missing network on the PC", () => {
    for (const over of [{ privacyMode: true }, { sensitive: true }, { online: false }]) {
      expect(routeVoice(request({ need: "stt", ...over }), cloud(), new UsageLedger()).active).toBe(
        "local",
      );
    }
  });

  it("skips a provider that is not allowed or has no key", () => {
    const d = routeVoice(
      request({ need: "stt" }),
      cloud({ allowedProviders: ["azure-speech"], keyPresent: {} }),
      new UsageLedger(),
    );
    expect(d.active).toBe("local");
    expect(d.refused.map((r) => r.why)).toContain("no key saved");
  });

  it("enforces audio minutes", () => {
    const d = routeVoice(request({ need: "stt", audioMinutes: 11 }), cloud(), new UsageLedger());
    expect(d.active).toBe("local");
  });

  it("chooses by capability: Claude is never offered speech", () => {
    const only = cloud({ allowedProviders: ["anthropic"], keyPresent: { anthropic: true } });
    expect(routeVoice(request({ need: "tts" }), only, new UsageLedger()).provider?.kind).toBe(
      "local",
    );
    expect(PROVIDERS.find((p) => p.id === "anthropic")?.needs).not.toContain("tts");
  });

  it("reports nothing when local is off and cloud cannot serve", () => {
    const d = routeVoice(
      request(),
      { ...DEFAULT_CLOUD_SETTINGS, localEnabled: false },
      new UsageLedger(),
    );
    expect(d.active).toBe("none");
  });

  it("resets the day and month in the ledger from an injected clock", () => {
    let now = Date.parse("2026-01-31T10:00:00Z");
    const ledger = new UsageLedger(() => now);
    ledger.record("gemini", 2);
    now = Date.parse("2026-02-01T10:00:00Z");
    expect(ledger.usage("gemini")).toMatchObject({ day: 0, month: 0, audioMinutes: 0 });
  });

  it("never claims a provider's documentation was read", () => {
    expect(PROVIDERS.every((p) => p.verified === false)).toBe(true);
  });
});

describe("performance profile", () => {
  const target = {
    cpuThreads: 12,
    ramTotalGb: 16,
    ramAvailableGb: 10,
    cuda: true,
    vramGb: 4,
    gpuName: "any",
  };

  it("keeps a 4 GB GPU for the language model and speech on the CPU", () => {
    const p = selectProfile(target);
    expect(p.name).toBe("balanced");
    expect(p.stt).toMatchObject({ device: "cpu", computeType: "int8", model: "small", beam: 1 });
    expect(p.llm.device).toBe("gpu");
    expect(p.maxBackgroundWorkers).toBe(1);
    expect(p.stt.threads).toBeLessThanOrEqual(4);
  });

  it("runs everything on the CPU with no GPU", () => {
    const p = selectProfile({ ...target, cuda: false, vramGb: 0 });
    expect(p.stt.device).toBe("cpu");
    expect(p.llm.device).toBe("cpu");
  });

  it("falls to lite on a small machine and refuses a heavier request", () => {
    const small = { cpuThreads: 2, ramTotalGb: 4, ramAvailableGb: 2 };
    expect(selectProfile(small).name).toBe("lite");
    expect(selectProfile(small).stt.model).toBe("base");
    expect(selectProfile(small, "quality").name).toBe("lite");
    expect(selectProfile(target, "lite").name).toBe("lite");
  });

  it("reaches quality only on a strong machine", () => {
    const big = { cpuThreads: 16, ramTotalGb: 32, ramAvailableGb: 24, cuda: true, vramGb: 12 };
    expect(selectProfile(big).name).toBe("quality");
  });

  it("lists missing models and never downloads them", () => {
    const p = selectProfile(target);
    expect(p.downloadsNeedApproval).toBe(true);
    expect(missingModels(p, { stt: ["small"], llm: [] })).toEqual([`ollama ${p.llm.model}`]);
  });
});
