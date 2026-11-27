import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUD_SETTINGS,
  PAID_BY_DEFAULT,
  PROVIDERS,
  UsageLedger,
  routeVoice,
  visibleLanes,
  type LaneDescriptor,
  type ProviderCaps,
  type RouteRequest,
  type VoiceCloudSettings,
} from "../../src/lib/friday/voice-engine/voice-provider-router";

/**
 * The lane descriptor only DESCRIBES a cloud lane (cost proof, data use, region, code-mix handling). It never turns a
 * lane on: routing still needs cloud switched on, the allow list, a key, a quota, and for an unproven or paid lane
 * the whole paid-access check. The clock is fixed and nothing here touches the network.
 */

const ledger = () => new UsageLedger(() => 0);

const lane = (over: Partial<LaneDescriptor> = {}): LaneDescriptor => ({
  costProof: "none",
  trainsOnData: "unknown",
  region: "unknown",
  codemixMode: "detect",
  ...over,
});

const row = (id: string, over: Partial<ProviderCaps> = {}): ProviderCaps => ({
  id,
  label: id,
  kind: "cloud",
  needs: ["stt"],
  hindi: true,
  hinglish: true,
  functionCalling: false,
  interruption: false,
  freeTier: "limited",
  verified: true,
  note: "test row",
  ...over,
});

const LOCAL: ProviderCaps = row("local-test", { kind: "local", freeTier: "none" });

const settings = (ids: string[], over: Partial<VoiceCloudSettings> = {}): VoiceCloudSettings => ({
  ...DEFAULT_CLOUD_SETTINGS,
  cloudEnabled: true,
  allowedProviders: ids,
  keyPresent: Object.fromEntries(ids.map((id) => [id, true])),
  dailyRequests: 5,
  monthlyRequests: 50,
  monthlyAudioMinutes: 30,
  ...over,
});

const PAID_ON = { paidAllowed: true, paidApproved: true, spendLimitUsd: 2 } as const;

const request = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  need: "stt",
  sensitive: false,
  privacyMode: false,
  billingAllowsPaid: false,
  online: true,
  ...over,
});

describe("the PROVIDERS table carries a lane descriptor on every cloud row", () => {
  const cloudRows = PROVIDERS.filter((p) => p.kind === "cloud");

  it("has the six cloud rows and each descriptor has exactly the four keys with known values", () => {
    expect(cloudRows.map((p) => p.id).sort()).toEqual(
      ["anthropic", "azure-speech", "gemini", "openai", "sarvam", "xai"].sort(),
    );
    for (const p of cloudRows) {
      expect(Object.keys(p.lane ?? {}).sort(), p.id).toEqual(
        ["codemixMode", "costProof", "region", "trainsOnData"].sort(),
      );
      expect(["official", "cached", "none", "trial"], p.id).toContain(p.lane?.costProof);
      expect(["no", "yes", "unknown"], p.id).toContain(p.lane?.trainsOnData);
      expect(["in", "us", "eu", "unknown"], p.id).toContain(p.lane?.region);
      expect(["native", "detect", "none"], p.id).toContain(p.lane?.codemixMode);
    }
  });

  it("local rows carry no descriptor", () => {
    for (const p of PROVIDERS.filter((x) => x.kind === "local"))
      expect(p.lane, p.id).toBeUndefined();
  });

  it("cost proof is official only where a free allowance exists, and every paid or free-less row has none", () => {
    for (const p of cloudRows) {
      if (p.lane?.costProof === "official") expect(p.freeTier, p.id).toBe("limited");
      // No proof, or only a one-time signup credit, is never recorded as a free allowance.
      if (p.lane?.costProof === "none" || p.lane?.costProof === "trial")
        expect(p.freeTier, p.id).not.toBe("limited");
    }
    const proof = Object.fromEntries(cloudRows.map((p) => [p.id, p.lane?.costProof]));
    expect(proof).toEqual({
      openai: "none",
      gemini: "official",
      anthropic: "none",
      xai: "none",
      sarvam: "trial",
      "azure-speech": "official",
    });
    for (const id of PAID_BY_DEFAULT) expect(proof[id], id).toBe("none");
  });

  it("Sarvam has only a one-time signup credit: freeTier unknown, trial proof, and the note says so", () => {
    const sarvam = PROVIDERS.find((p) => p.id === "sarvam");
    expect(sarvam?.freeTier).toBe("unknown");
    expect(sarvam?.lane?.costProof).toBe("trial");
    expect(sarvam?.note).toMatch(/one-time signup credit/);
    expect(PROVIDERS.find((p) => p.id === "gemini")).toMatchObject({
      freeTier: "limited",
      lane: { costProof: "official" },
    });
  });

  it("never claims a provider keeps data private without a source, and says so for the one page that was read", () => {
    for (const p of cloudRows) expect(p.lane?.trainsOnData, p.id).not.toBe("no");
    expect(PROVIDERS.find((p) => p.id === "gemini")?.lane?.trainsOnData).toBe("yes");
    expect(PROVIDERS.find((p) => p.id === "sarvam")?.lane?.trainsOnData).toBe("unknown");
  });

  it("takes region and code-mix handling from the row's own notes", () => {
    const sarvam = PROVIDERS.find((p) => p.id === "sarvam");
    expect(sarvam?.lane).toMatchObject({ region: "in", codemixMode: "native" });
    expect(sarvam?.note).toMatch(/codemix/);
    expect(PROVIDERS.find((p) => p.id === "azure-speech")?.lane?.codemixMode).toBe("none");
  });
});

describe("a lane with no cost proof is treated like a paid lane", () => {
  const table = [row("unproven", { lane: lane({ costProof: "none" }) }), LOCAL];
  const route = (over: Partial<VoiceCloudSettings> = {}, req: Partial<RouteRequest> = {}) =>
    routeVoice(request(req), settings(["unproven"], over), ledger(), table);

  it("is refused with the new reason while paid access is off", () => {
    const d = route();
    expect(d.active).toBe("local");
    expect(d.refused).toEqual([{ id: "unproven", why: "no cost proof: paid access must be on" }]);
  });

  it("is routed once paid access is allowed, approved, funded and the billing firewall agrees", () => {
    const d = route(PAID_ON, { billingAllowsPaid: true });
    expect(d.active).toBe("cloud");
    expect(d.provider?.id).toBe("unproven");
  });

  it("stays refused when any one part of paid access is missing", () => {
    const cases: [Partial<VoiceCloudSettings>, boolean][] = [
      [{ ...PAID_ON, paidAllowed: false }, true],
      [{ ...PAID_ON, paidApproved: false }, true],
      [{ ...PAID_ON, spendLimitUsd: 0 }, true],
      [PAID_ON, false],
    ];
    for (const [over, billing] of cases) {
      const d = route(over, { billingAllowsPaid: billing });
      expect(d.active).toBe("local");
      expect(d.refused[0]?.why).toBe("no cost proof: paid access must be on");
    }
  });

  it("still obeys the quota once paid access is on", () => {
    const d = route({ ...PAID_ON, dailyRequests: 0 }, { billingAllowsPaid: true });
    expect(d.active).toBe("local");
    expect(d.refused[0]?.why).toMatch(/daily quota/);
  });

  it("a row that is paid by default keeps the old paid wording", () => {
    const openai = PROVIDERS.find((p) => p.id === "openai") as ProviderCaps;
    const d = routeVoice(request({ need: "tts" }), settings(["openai"]), ledger());
    expect(d.refused.find((r) => r.id === "openai")?.why).toBe(
      "paid use is not allowed and approved",
    );
    expect(openai.lane?.costProof).toBe("none");
  });

  it("a text-only provider with no free allowance now needs paid access too", () => {
    const off = routeVoice(request({ need: "text" }), settings(["anthropic"]), ledger());
    expect(off.refused.find((r) => r.id === "anthropic")?.why).toBe(
      "no cost proof: paid access must be on",
    );
    const on = routeVoice(
      request({ need: "text", billingAllowsPaid: true }),
      settings(["anthropic"], PAID_ON),
      ledger(),
    );
    expect(on.provider?.id).toBe("anthropic");
  });
});

describe("a lane with only a one-time trial credit is treated like a paid lane", () => {
  const table = [row("trial", { lane: lane({ costProof: "trial" }) }), LOCAL];
  const route = (over: Partial<VoiceCloudSettings> = {}, req: Partial<RouteRequest> = {}) =>
    routeVoice(request(req), settings(["trial"], over), ledger(), table);

  it("is refused while paid access is off, and the reason names the trial credit", () => {
    const d = route();
    expect(d.active).toBe("local");
    expect(d.refused).toHaveLength(1);
    expect(d.refused[0]?.why).toMatch(/trial credit/);
    expect(d.refused[0]?.why).toMatch(/paid access must be on/);
  });

  it("is routed once paid access is allowed, approved, funded and the billing firewall agrees", () => {
    const d = route(PAID_ON, { billingAllowsPaid: true });
    expect(d.active).toBe("cloud");
    expect(d.provider?.id).toBe("trial");
  });

  it("stays refused when any one part of paid access is missing", () => {
    const cases: [Partial<VoiceCloudSettings>, boolean][] = [
      [{ ...PAID_ON, paidAllowed: false }, true],
      [{ ...PAID_ON, paidApproved: false }, true],
      [{ ...PAID_ON, spendLimitUsd: 0 }, true],
      [PAID_ON, false],
    ];
    for (const [over, billing] of cases) {
      const d = route(over, { billingAllowsPaid: billing });
      expect(d.active).toBe("local");
      expect(d.refused[0]?.why).toMatch(/trial credit/);
    }
  });

  it("the real Sarvam row is refused with paid access off and routed with it on, for every need it offers", () => {
    for (const need of ["tts", "stt", "text"] as const) {
      const off = routeVoice(request({ need }), settings(["sarvam"]), ledger());
      expect(off.active, need).not.toBe("cloud");
      expect(off.refused.find((r) => r.id === "sarvam")?.why, need).toMatch(/trial credit/);
      const on = routeVoice(
        request({ need, billingAllowsPaid: true }),
        settings(["sarvam"], PAID_ON),
        ledger(),
      );
      expect(on.provider?.id, need).toBe("sarvam");
    }
  });

  it("the privacy firewall still wins with paid access on: a sensitive line never reaches Sarvam", () => {
    for (const over of [{ sensitive: true }, { privacyMode: true }, { online: false }]) {
      const d = routeVoice(
        request({ need: "tts", billingAllowsPaid: true, ...over }),
        settings(["sarvam"], PAID_ON),
        ledger(),
      );
      expect(d.active, JSON.stringify(over)).not.toBe("cloud");
    }
  });
});

describe("a proven lane keeps routing inside its quota", () => {
  it.each(["official", "cached"] as const)("%s proof routes with paid access off", (costProof) => {
    const table = [row("proven", { lane: lane({ costProof }) }), LOCAL];
    const d = routeVoice(request(), settings(["proven"]), ledger(), table);
    expect(d.active).toBe("cloud");
    expect(d.provider?.id).toBe("proven");
  });

  it("a cached proof is not turned to unknown by the passing of time", () => {
    let now = 0;
    const clock = new UsageLedger(() => now);
    const table = [row("proven", { lane: lane({ costProof: "cached" }) }), LOCAL];
    now = Date.UTC(2031, 0, 1);
    expect(routeVoice(request(), settings(["proven"]), clock, table).active).toBe("cloud");
  });

  it("its quota still ends it", () => {
    const table = [row("proven", { lane: lane({ costProof: "official" }) }), LOCAL];
    const used = ledger();
    for (let i = 0; i < 5; i++) used.record("proven");
    const d = routeVoice(request(), settings(["proven"]), used, table);
    expect(d.active).toBe("local");
    expect(d.refused[0]?.why).toMatch(/daily quota/);
  });

  it("the real free rows route inside their quota with paid access off (Sarvam is not one of them)", () => {
    expect(routeVoice(request(), settings(["gemini"]), ledger()).provider?.id).toBe("gemini");
    const sarvamOff = routeVoice(request({ need: "tts" }), settings(["sarvam"]), ledger());
    expect(sarvamOff.active).toBe("local");
    expect(sarvamOff.refused.map((r) => r.id)).toContain("sarvam");
    expect(
      routeVoice(request({ need: "tts" }), settings(["azure-speech"]), ledger()).provider?.id,
    ).toBe("azure-speech");
  });
});

describe("a row without a descriptor behaves exactly as before", () => {
  it("routes free, and is still paid only through PAID_BY_DEFAULT or costsMoney", () => {
    const plain = [row("plain", { freeTier: "unknown", verified: false }), LOCAL];
    expect(routeVoice(request(), settings(["plain"]), ledger(), plain).active).toBe("cloud");
    const paid = routeVoice(
      request({ costsMoney: () => true }),
      settings(["plain"]),
      ledger(),
      plain,
    );
    expect(paid.refused[0]?.why).toBe("paid use is not allowed and approved");
  });
});

describe("the privacy firewall does not read the descriptor", () => {
  const descriptors: LaneDescriptor[] = [];
  for (const costProof of ["official", "cached", "none", "trial"] as const)
    for (const trainsOnData of ["no", "yes", "unknown"] as const)
      descriptors.push(lane({ costProof, trainsOnData, region: "in", codemixMode: "native" }));

  it("a sensitive or private-mode request never reaches a cloud lane, with paid access fully on", () => {
    let cases = 0;
    for (const d of descriptors) {
      const table = [row("c", { lane: d }), LOCAL];
      for (const over of [{ sensitive: true }, { privacyMode: true }, { online: false }]) {
        const decision = routeVoice(
          request({ billingAllowsPaid: true, ...over }),
          settings(["c"], PAID_ON),
          ledger(),
          table,
        );
        expect(decision.active, JSON.stringify([d, over])).toBe("local");
        expect(decision.refused).toEqual([]);
        cases += 1;
      }
    }
    expect(cases).toBe(36);
  });

  it("no real row routes a sensitive request to the cloud either", () => {
    for (const p of PROVIDERS.filter((x) => x.kind === "cloud")) {
      for (const need of p.needs) {
        const d = routeVoice(
          request({ need, sensitive: true, billingAllowsPaid: true }),
          settings([p.id], PAID_ON),
          ledger(),
        );
        expect(d.active, `${p.id}/${need}`).not.toBe("cloud");
      }
    }
  });

  it("cloud stays off by default whatever the descriptor says", () => {
    const table = [row("c", { lane: lane({ costProof: "official" }) }), LOCAL];
    const d = routeVoice(request(), DEFAULT_CLOUD_SETTINGS, ledger(), table);
    expect(d.active).toBe("local");
    expect(DEFAULT_CLOUD_SETTINGS.cloudEnabled).toBe(false);
  });
});

describe("visibleLanes lists what a settings page may show", () => {
  const table: ProviderCaps[] = [
    LOCAL,
    row("proven", { lane: lane({ costProof: "official" }) }),
    row("cached", { lane: lane({ costProof: "cached" }) }),
    row("unproven", { lane: lane({ costProof: "none" }) }),
    row("trial", { lane: lane({ costProof: "trial" }) }),
    row("plain"),
  ];
  const ids = (s: Partial<VoiceCloudSettings>) =>
    visibleLanes(table, { ...DEFAULT_CLOUD_SETTINGS, ...s }).map((p) => p.id);

  it("hides unproven lanes until paid access is on", () => {
    expect(ids({})).toEqual(["proven", "cached", "plain"]);
    expect(ids({ paidAllowed: true })).toEqual(["proven", "cached", "unproven", "trial", "plain"]);
  });

  it("never lists a local row and never changes the settings it was given", () => {
    const given = { ...DEFAULT_CLOUD_SETTINGS };
    visibleLanes(table, given);
    expect(given).toEqual(DEFAULT_CLOUD_SETTINGS);
    expect(ids({ paidAllowed: true })).not.toContain("local-test");
  });

  it("on the real table, hides the unproven lanes by default and shows every cloud row with paid access", () => {
    const shown = visibleLanes(PROVIDERS, DEFAULT_CLOUD_SETTINGS).map((p) => p.id);
    expect(shown.sort()).toEqual(["azure-speech", "gemini"]);
    const all = visibleLanes(PROVIDERS, { ...DEFAULT_CLOUD_SETTINGS, paidAllowed: true });
    expect(all).toHaveLength(6);
  });
});
