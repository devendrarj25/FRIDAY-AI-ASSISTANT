/**
 * Offline proof for a whole Auto turn. Every way a turn could reach the network is replaced by a tripwire: `fetch`,
 * `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon` and each Electron cloud IPC channel (read from the preload
 * allowlist and checked against the IPC budget table). A tripwire records the channel and the caller it found on the
 * stack, then throws an Error that names that caller, so a product step that swallows the error still leaves a hit
 * on the list. The turn runs through the real Auto mode controller on the turn simulator: listen, end of turn, the
 * Brain's local answer, and the speech plan for FRIDAY Voice. Nothing here reads the clock, the real network or this
 * checkout's git history.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";
import { chooseTtsEngine } from "../../src/lib/friday/tts-ladder";
import {
  canStreamSpeechToText,
  speakWithCloud,
} from "../../src/lib/friday/voice-engine/voice-cloud-client";
import {
  DEFAULT_VOICE_CLOUD_PREFS,
  sanitizeCloudPrefs,
  toRouterSettings,
  type VoiceCloudPrefs,
} from "../../src/lib/friday/voice-engine/voice-cloud-settings";
import {
  DEFAULT_CLOUD_SETTINGS,
  UsageLedger,
  routeVoice,
  type Need,
} from "../../src/lib/friday/voice-engine/voice-provider-router";
import {
  TTS_INFO,
  TtsFallbackManager,
  cloudTtsInfos,
  rankTtsProviders,
  type TtsChunk,
  type TtsContext,
  type TtsProvider,
  type TtsProviderInfo,
} from "../../src/lib/friday/voice-engine/tts-provider";
import { SCENARIOS } from "./helpers/voice-turn-scenarios";
import {
  SIM_BASE_MS,
  brainEv,
  ear,
  fin,
  quiet,
  runScenario,
  script,
  truth,
  ttsEv,
  vad,
  type Scenario,
  type SimHarness,
  type SimResult,
} from "./helpers/voice-turn-sim";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

const ROOT = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const { createVoiceCloud, guardedStreamSend } = require_(resolve(ROOT, "electron/voice-cloud.cjs"));
const { CHANNEL_CLASS } = require_(resolve(ROOT, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
};

// ---------- the tripwires ----------

/** A function or a class: the frame above which the caller is looked for. */
type Skip = (abstract new (...args: never[]) => unknown) | ((...args: never[]) => unknown);
type Hit = { channel: string; caller: string };
let hits: Hit[] = [];

/** The first stack frame above `skip`: "function (path:line)" with the repository prefix removed. */
function callerOf(skip: Skip): string {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, skip);
  const frame = (holder.stack ?? "")
    .split("\n")
    .slice(1)
    .find((line) => line.trim().startsWith("at "));
  if (!frame) return "an unknown caller";
  const match = /^\s*at (?:(.*?) \()?(.*?):(\d+):\d+\)?\s*$/.exec(frame);
  if (!match) return frame.trim();
  // Windows frames use backslashes and may be file:///D:/ URLs: compare in one shape.
  const posix = (text: string) => text.replace(/\\/g, "/");
  const where = posix(match[2] ?? "")
    .replace(/^file:\/\/\/?(?=[A-Za-z]:)/, "")
    .replace(/^file:\/\//, "")
    .replace(`${posix(ROOT)}/`, "");
  return `${match[1] ?? "<anonymous>"} (${where}:${match[3]})`;
}

function trip(channel: string, skip: Skip): never {
  const caller = callerOf(skip);
  hits.push({ channel, caller });
  throw new Error(`blocked network call: ${channel} called by ${caller}`);
}

/** The one assertion every offline test ends on: the message names every channel and its caller. */
function expectNoNetwork(): void {
  if (hits.length === 0) return;
  throw new Error(
    `the turn reached the network ${hits.length} time(s): ${hits
      .map((h) => `${h.channel} by ${h.caller}`)
      .join("; ")}`,
  );
}

function stubFetch(..._args: unknown[]): never {
  return trip("fetch", stubFetch);
}
class StubXhr {
  constructor() {
    trip("XMLHttpRequest", StubXhr);
  }
}
class StubWebSocket {
  constructor() {
    trip("WebSocket", StubWebSocket);
  }
}
function stubBeacon(..._args: unknown[]): never {
  return trip("navigator.sendBeacon", stubBeacon);
}

/** Every cloud channel of the preload allowlist: method name and channel, read from the source. */
const CLOUD_IPC = ((): Array<{ method: string; channel: string }> => {
  const source = readFileSync(resolve(ROOT, "electron/preload.cjs"), "utf8");
  const found: Array<{ method: string; channel: string }> = [];
  for (const m of source.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*"([^"]+)"/g)) {
    const channel = m[2] ?? "";
    if (/^(voice-cloud:|voice-stream:|realtime:open-cloud$)/.test(channel))
      found.push({ method: m[1] ?? "", channel });
  }
  return found;
})();

/** The desktop bridge's cloud methods, each one a tripwire named by its channel. */
function ipcTripwires(): Record<string, (...args: unknown[]) => never> {
  const out: Record<string, (...args: unknown[]) => never> = {};
  for (const { method, channel } of CLOUD_IPC) {
    const wire = (..._args: unknown[]): never => trip(`ipc ${channel}`, wire);
    out[method] = wire;
  }
  return out;
}

const globals = globalThis as unknown as Record<string, unknown>;

function installTripwires(online: boolean): void {
  vi.stubGlobal("fetch", stubFetch);
  vi.stubGlobal("XMLHttpRequest", StubXhr);
  vi.stubGlobal("WebSocket", StubWebSocket);
  for (const [key, value] of [
    ["sendBeacon", stubBeacon],
    ["onLine", online],
  ] as const)
    Object.defineProperty(globalThis.navigator, key, { value, configurable: true });
  globals["window"] = globalThis;
  globals["friday"] = ipcTripwires();
}

beforeEach(() => {
  hits = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["sendBeacon", "onLine"]) Reflect.deleteProperty(globalThis.navigator, key);
  // `window` and `document` stay: the controller's own recovery timers outlive a turn and read them.
  Reflect.deleteProperty(globals, "friday");
});

// ---------- the turn ----------

/** The controller's own methods this proof reads (private in the product, the simulator drives the same object). */
type Controller = SimHarness["d"] & {
  offlineVoiceReady: boolean;
  speakPlan: (
    text: string,
    localOnly?: boolean,
  ) => {
    fallen: string;
    privacy: boolean;
    argTuning: { allowCloud: boolean; cloudClip?: unknown; kind?: string };
  };
  cloudClipFor: () => ((text: string, lang: string, tone: unknown) => Promise<unknown>) | undefined;
  cloudSttGate: () => { ok: boolean; reason?: string };
};
const controller = (h: SimHarness): Controller => h.d as unknown as Controller;

/** Her cloud lanes, all of them on, with a quota: what the owner would have to switch on by hand. */
const CLOUD_ON: VoiceCloudPrefs = {
  ...DEFAULT_VOICE_CLOUD_PREFS,
  cloudEnabled: true,
  allowedProviders: ["sarvam"],
  speakWith: "sarvam",
  streamCaptions: true,
  sttAuthority: "sarvam",
  dailyRequests: 50,
  monthlyRequests: 500,
  monthlyAudioMinutes: 60,
  // Sarvam has only a one-time signup credit, which is no free allowance: its lane needs paid access on as well.
  paidAllowed: true,
  paidApproved: true,
  spendLimitUsd: 5,
};

/** Play a scenario with FRIDAY Voice installed and the cloud bridge tripwired, after `extra` has set the prefs. */
function play(
  base: Scenario,
  extra: (h: SimHarness) => void = () => undefined,
): Promise<SimResult> {
  return runScenario({
    ...base,
    setup: (h) => {
      base.setup?.(h);
      // The simulator installs its own bridge object just before setup runs: put the cloud tripwires on it.
      Object.assign(globals["friday"] as object, ipcTripwires());
      controller(h).offlineVoiceReady = true;
      extra(h);
    },
  });
}

/** An owner line that is private and a reply that repeats it. */
const SENSITIVE_TURN: Scenario = {
  name: "sensitive line",
  script: script(
    ear(0, "start", "t1"),
    truth(0, "command"),
    vad(0, 1200),
    quiet(1200, 2400),
    ear(1760, "end", "t1", "Friday my password is 4821 remember it", { speechMs: 1200 }),
    fin(1840, "Friday my password is 4821 remember it"),
    brainEv(2000, "first-token", "r1", { lane: "quick" }),
    brainEv(2080, "done", "r1", { text: "Your password is 4821." }),
    ttsEv(2400, "first-audio", "u1"),
    ttsEv(4000, "drained", "u1", { playedMs: 1600 }),
  ),
};

const TURNS: Array<[string, Scenario, string]> = [
  ["English command", SCENARIOS["clean"]!, "It is ten past three."],
  ["Hinglish command", SCENARIOS["hinglish"]!, "Theek hai, alarm laga diya."],
];

describe("the tripwires name their caller", () => {
  it("lists the cloud IPC channels from the preload allowlist, all in the IPC budget table", () => {
    expect(CLOUD_IPC.map((c) => c.method).sort()).toEqual(
      [
        "realtimeOpenCloud",
        "voiceCloudKeyStatus",
        "voiceCloudSaveKey",
        "voiceCloudSpeak",
        "voiceCloudTranscribe",
        "voiceStreamClose",
        "voiceStreamOpen",
        "voiceStreamSend",
      ].sort(),
    );
    for (const { channel } of CLOUD_IPC) expect(CHANNEL_CLASS).toHaveProperty([channel]);
  });

  it("each stub throws an Error that names the function that called it, and records the hit", async () => {
    installTripwires(true);
    const callers: Array<[string, () => unknown]> = [
      [
        "fetch",
        function leakByFetch() {
          return fetch("https://example.invalid/a");
        },
      ],
      [
        "XMLHttpRequest",
        function leakByXhr() {
          return new XMLHttpRequest();
        },
      ],
      [
        "WebSocket",
        function leakBySocket() {
          return new WebSocket("wss://example.invalid");
        },
      ],
      [
        "navigator.sendBeacon",
        function leakByBeacon() {
          return navigator.sendBeacon("/x");
        },
      ],
      [
        "ipc voice-cloud:speak",
        function leakByIpc() {
          return (globals["friday"] as Record<string, (...a: unknown[]) => unknown>)[
            "voiceCloudSpeak"
          ]!("sarvam", {});
        },
      ],
    ];
    for (const [channel, leak] of callers) {
      expect(leak, channel).toThrow(new RegExp(`${channel.replace(".", "\\.")}.*${leak.name}`));
    }
    expect(hits.map((h) => h.channel)).toEqual(callers.map(([channel]) => channel));
    for (const [i, [, leak]] of callers.entries())
      expect(hits[i]?.caller).toContain(`${leak.name} (core/__tests__/voice-offline-turn.test.ts:`);
    expect(expectNoNetwork).toThrow(/reached the network 5 time\(s\).*leakByFetch/);
  });

  it("RED proof: a fake step that leaks a fetch into a whole turn fails the offline assertion by name", async () => {
    installTripwires(true);
    const turn = await play(SCENARIOS["clean"]!, (h) => {
      const say = h.d.speak.bind(h.d);
      // A throwaway fake: the product swallows nothing here, the step itself catches, like a real client would.
      h.d.speak = function injectedTelemetryStep(text: string) {
        try {
          void fetch("https://telemetry.example.invalid/turn", { method: "POST", body: text });
        } catch {
          // A leaky step that hides the failure: the tripwire list still has it.
        }
        say(text);
      };
    });
    expect(turn.spoken).toContain("It is ten past three.");
    // At least once per line she said, every time by the leaky step and by nothing else in the product.
    expect(hits.length).toBeGreaterThanOrEqual(turn.spoken.length);
    for (const hit of hits) {
      expect(hit.channel).toBe("fetch");
      expect(hit.caller).toMatch(
        /injectedTelemetryStep.* \(core\/__tests__\/voice-offline-turn\.test\.ts:\d+\)$/,
      );
    }
    expect(() => expectNoNetwork()).toThrow(
      /fetch by .*injectedTelemetryStep.* \(core\/__tests__\/voice-offline-turn\.test\.ts:\d+\)/,
    );
  });
});

describe.each([true, false])("a whole Auto turn, network reported up: %s", (online) => {
  describe.each(TURNS)("%s", (_label, scenario, reply) => {
    it("listens, ends the turn, answers locally and speaks with FRIDAY Voice: 0 network calls", async () => {
      installTripwires(online);
      const turn = await play(scenario);
      // The turn happened: the Brain got the line, her answer reached the speech step.
      expect(turn.sent).toHaveLength(1);
      expect(turn.spoken).toContain(reply);
      // Every spoken line is planned on FRIDAY Voice, with no cloud rung and no cloud clip.
      const c = controller(turn.h);
      for (const line of turn.spoken) {
        const plan = c.speakPlan(line);
        expect(plan.fallen, line).toBe("supertonic");
        expect(plan.argTuning.allowCloud, line).toBe(false);
        expect(plan.argTuning.cloudClip, line).toBeUndefined();
      }
      expectNoNetwork();
    });
  });

  it("the speech engine is never a cloud one, ready or not, once the network is reported down", async () => {
    installTripwires(online);
    const turn = await play(SCENARIOS["clean"]!, (h) => {
      controller(h).offlineVoiceReady = false;
    });
    const plan = controller(turn.h).speakPlan("It is ten past three.");
    if (online)
      expect(plan.fallen).toBe("neural"); // the owner-visible default when FRIDAY Voice is missing
    else expect(plan.fallen).not.toBe("neural");
    expect(chooseTtsEngine({ network: false, supertonicReady: false, privacy: false })).not.toBe(
      "neural",
    );
    expectNoNetwork();
  });
});

describe("cloud lanes are off by default", () => {
  it("the stored defaults switch every cloud speech and recognition lane off", async () => {
    installTripwires(true);
    const turn = await play(SCENARIOS["clean"]!);
    const stored = sanitizeCloudPrefs(turn.h.preferences.getSnapshot().voice.cloudVoice);
    expect(stored).toEqual(DEFAULT_VOICE_CLOUD_PREFS);
    expect(stored).toMatchObject({
      cloudEnabled: false,
      allowedProviders: [],
      speakWith: "",
      streaming: false,
      streamCaptions: false,
      streamPlayback: false,
      sttAuthority: "captions",
    });
    expect(turn.h.preferences.getSnapshot().voice.privacyMode).toBe(false);
    const c = controller(turn.h);
    // Cloud speech: no cloud clip is made; cloud recognition: the gate is shut.
    expect(c.cloudClipFor()).toBeUndefined();
    expect(c.cloudSttGate()).toMatchObject({ ok: false });
    // The router, asked for each speech need with the shipped settings, never picks a cloud provider.
    const ledger = new UsageLedger(() => SIM_BASE_MS);
    for (const need of ["tts", "stt", "stream-text", "realtime-audio"] as Need[]) {
      const decision = routeVoice(
        { need, sensitive: false, privacyMode: false, billingAllowsPaid: true, online: true },
        DEFAULT_CLOUD_SETTINGS,
        ledger,
      );
      expect(decision.active, need).not.toBe("cloud");
    }
    expect(
      canStreamSpeechToText(
        { prefs: stored, keys: { sarvam: true }, privacyMode: false, online: true },
        ledger,
      ),
    ).toMatchObject({ ok: false });
    expectNoNetwork();
  });

  it("an old stored shape (no cloud fields, junk values) reads as off, never as on", () => {
    for (const old of [undefined, null, {}, { cloudEnabled: "yes", allowedProviders: "sarvam" }]) {
      const prefs = sanitizeCloudPrefs(old as Partial<VoiceCloudPrefs> | null | undefined);
      expect(prefs.cloudEnabled).toBe(false);
      expect(prefs.allowedProviders).toEqual([]);
      expect(prefs.speakWith).toBe("");
      expect(prefs.sttAuthority).toBe("captions");
    }
  });
});

describe("the privacy firewall refuses a SENSITIVE line with the cloud lane enabled", () => {
  const SENSITIVE_LINES = [
    "my password is x",
    "मेरा पासवर्ड है 4821",
    "mera password hai abc",
    "card number 4111 1111 1111 1111",
  ];
  const cloudPrefsForMain = {
    privacyMode: false,
    cloudVoice: { cloudEnabled: true, allowedProviders: ["sarvam"] },
  };

  it("the main process refuses before any request, whatever the renderer sent (the stub is not hit)", async () => {
    installTripwires(true);
    // No fetchImpl: the module's own default, the stubbed global, is what a request would use.
    const api = createVoiceCloud({
      getSecret: () => "sk-test-key",
      prefs: () => cloudPrefsForMain,
      paidUnlocked: () => true,
    });
    for (const text of SENSITIVE_LINES) {
      const out = await api.speak("sarvam", { text, language: "en-IN", sensitiveReply: false });
      expect(out, text).toMatchObject({ ok: false, sensitive: true });
    }
    expect(
      await api.speak("sarvam", {
        text: "Opening the report.",
        language: "en-IN",
        sensitiveReply: true,
      }),
    ).toMatchObject({ ok: false, sensitive: true });
    expectNoNetwork();

    // The stream socket is screened too: the frame never reaches the open stream.
    const sent: unknown[] = [];
    const send = guardedStreamSend(api, {
      send: function streamSend(id: string, message: unknown) {
        sent.push([id, message]);
        return trip("ipc voice-stream:send", streamSend);
      },
    });
    for (const text of SENSITIVE_LINES)
      expect(send("s1", { type: "text", text }), text).toMatchObject({
        ok: false,
        sensitive: true,
      });
    expect(sent).toEqual([]);
    expectNoNetwork();
  });

  it("positive control: a harmless line with the same settings does reach the request, and the tripwire names it", async () => {
    installTripwires(true);
    const api = createVoiceCloud({
      getSecret: () => "sk-test-key",
      prefs: () => cloudPrefsForMain,
      paidUnlocked: () => true,
    });
    const out = await api.speak("sarvam", { text: "Opening the report.", language: "en-IN" });
    expect(out).toMatchObject({ ok: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ channel: "fetch" });
    expect(hits[0]?.caller).toContain("electron/voice-cloud.cjs");
    expect(expectNoNetwork).toThrow(/fetch by .*electron\/voice-cloud\.cjs/);
  });

  it("the renderer refuses a sensitive reply before it asks the bridge, with the lane on and a key saved", async () => {
    installTripwires(true);
    const ledger = new UsageLedger(() => SIM_BASE_MS);
    const out = await speakWithCloud(
      "sarvam",
      {
        text: "Opening the report.",
        language: "en-IN",
        prefs: CLOUD_ON,
        keys: { sarvam: true },
        privacyMode: false,
        online: true,
        sensitiveReply: true,
      },
      { ledger },
    );
    expect(out.ok).toBe(false);
    expect(ledger.usage("sarvam").day).toBe(0);
    expectNoNetwork();
  });

  it("a whole sensitive turn with every cloud lane on: her speech plan and cloud clip stay on this PC", async () => {
    installTripwires(true);
    const turn = await play(SENSITIVE_TURN, (h) =>
      h.preferences.setVoice({ cloudVoice: CLOUD_ON }),
    );
    expect(turn.spoken).toContain("Your password is 4821.");
    const c = controller(turn.h);
    const clip = c.cloudClipFor();
    expect(clip, "the lane is really on").toBeTypeOf("function");
    for (const line of [...turn.spoken, ...SENSITIVE_LINES]) {
      const plan = c.speakPlan(line);
      expect(plan.privacy, line).toBe(true);
      expect(plan.fallen, line).toBe("supertonic");
      expect(plan.argTuning.allowCloud, line).toBe(false);
      expect(plan.argTuning.cloudClip, line).toBeUndefined();
      // Even called by hand the clip refuses the line before it asks for a key or opens a request.
      expect(await clip!(line, "en-IN", { rate: 1, pitch: 1, volume: 1 }), line).toBeNull();
    }
    expectNoNetwork();
  });

  it("positive control: with the lane on, a harmless line makes the controller ask the bridge, and the tripwire names it", async () => {
    installTripwires(true);
    const turn = await play(SCENARIOS["clean"]!, (h) =>
      h.preferences.setVoice({ cloudVoice: CLOUD_ON }),
    );
    const clip = controller(turn.h).cloudClipFor();
    await expect(clip!("It is ten past three.", "en-IN", { rate: 1 })).rejects.toThrow(
      /ipc voice-cloud:key-status called by .*src\/lib\/friday\/assistant-mode\.ts:\d+/,
    );
    expect(hits.map((h) => h.channel)).toEqual(["ipc voice-cloud:key-status"]);
  });

  it("the speech ladder keeps a sensitive line off the online voice even when it is allowed and preferred", async () => {
    installTripwires(true);
    const reached: string[] = [];
    // The real text rule, as the speech path wires it: the line itself decides, not a flag the caller set.
    const manager = ladder(reached, looksSensitive);
    const result = await manager.speakSegment(
      { text: "my password is x", lang: "en-IN" },
      { ...OPEN_CTX, prefer: "neural" },
      { generation: 1 },
    );
    expect(result.engine).not.toBe("edge");
    expect(result.refused.some((r) => r.id === "edge")).toBe(true);
    expect(reached).not.toContain("edge");
    expectNoNetwork();
  });
});

describe("privacy mode never selects a cloud voice", () => {
  /** A cloud decision that WOULD pick Sarvam if privacy mode were off. */
  const sarvamDecision = (privacyMode: boolean) =>
    routeVoice(
      { need: "tts", sensitive: false, privacyMode, billingAllowsPaid: true, online: true },
      toRouterSettings(CLOUD_ON, { sarvam: true }),
      new UsageLedger(() => SIM_BASE_MS),
    );

  it("the control: with privacy mode off the same settings do pick the cloud voice", () => {
    expect(sarvamDecision(false)).toMatchObject({ active: "cloud", provider: { id: "sarvam" } });
  });

  it("the control for the control: with paid access off the same settings refuse Sarvam in the renderer and in main", async () => {
    installTripwires(true);
    const decide = (billingAllowsPaid: boolean, prefs: VoiceCloudPrefs) =>
      routeVoice(
        { need: "tts", sensitive: false, privacyMode: false, billingAllowsPaid, online: true },
        toRouterSettings(prefs, { sarvam: true }),
        new UsageLedger(() => SIM_BASE_MS),
      );
    const unpaid = decide(true, { ...CLOUD_ON, paidAllowed: false, paidApproved: false });
    expect(unpaid.active).not.toBe("cloud");
    expect(unpaid.refused.find((r) => r.id === "sarvam")?.why).toMatch(
      /trial credit.*paid access must be on/,
    );
    // The billing firewall's own answer is what counts, whatever the saved switches say.
    expect(decide(false, CLOUD_ON).active).not.toBe("cloud");
    const api = createVoiceCloud({
      getSecret: () => "sk-test-key",
      prefs: () => ({ privacyMode: false, cloudVoice: CLOUD_ON }),
      paidUnlocked: () => false,
    });
    expect(api.gate("sarvam")).toMatchObject({ ok: false });
    expect(
      await api.speak("sarvam", { text: "Opening the report.", language: "en-IN" }),
    ).toMatchObject({ ok: false });
    expectNoNetwork();
  });

  it("no ranking of the speech ladder holds a cloud voice, for every setting around it", () => {
    const infos: TtsProviderInfo[] = [...Object.values(TTS_INFO), ...cloudTtsInfos()];
    const decision = sarvamDecision(false);
    let rankings = 0;
    for (const online of [true, false])
      for (const allowCloud of [true, false])
        for (const billingAllowsPaid of [true, false])
          for (const prefer of ["auto", "supertonic", "sapi", "neural"] as const)
            for (const privateVoice of ["system", "local"] as const)
              for (const lang of ["en-IN", "hi-IN", "hinglish"])
                for (const text of ["Opening the report.", "रिपोर्ट खोल रही हूँ"]) {
                  const ranking = rankTtsProviders(
                    infos,
                    { text, lang },
                    {
                      online,
                      privacyMode: true,
                      sensitive: false,
                      allowCloud,
                      billingAllowsPaid,
                      prefer,
                      privateVoice,
                      cloud: decision,
                    },
                  );
                  rankings += 1;
                  expect(ranking.order.filter((v) => v.kind === "cloud")).toEqual([]);
                  expect(ranking.order.length).toBeGreaterThan(0);
                }
    expect(rankings).toBe(2 * 2 * 2 * 4 * 2 * 3 * 2);
  });

  it("the router and the main process refuse every cloud need under privacy mode with all lanes on", async () => {
    installTripwires(true);
    for (const need of ["tts", "stt", "stream-text", "realtime-audio"] as Need[])
      expect(sarvamDecisionFor(need).active, need).not.toBe("cloud");
    const api = createVoiceCloud({
      getSecret: () => "sk-test-key",
      prefs: () => ({ privacyMode: true, cloudVoice: CLOUD_ON }),
      paidUnlocked: () => true,
    });
    expect(
      await api.speak("sarvam", { text: "Opening the report.", language: "en-IN" }),
    ).toMatchObject({ ok: false });
    expect(
      await api.transcribe("sarvam", { audioBase64: "QUJD", language: "unknown" }),
    ).toMatchObject({ ok: false });
    expect(api.screenStreamMessage("sarvam", { type: "text", text: "hello" })).toMatchObject({
      ok: false,
    });
    expectNoNetwork();
  });

  it("a whole turn with privacy mode on and every cloud lane on makes no cloud route and no call", async () => {
    installTripwires(true);
    const turn = await play(SCENARIOS["clean"]!, (h) =>
      h.preferences.setVoice({ privacyMode: true, cloudVoice: CLOUD_ON }),
    );
    expect(turn.sent).toHaveLength(1);
    const c = controller(turn.h);
    expect(c.cloudSttGate()).toMatchObject({ ok: false, reason: "privacy mode is on" });
    for (const line of turn.spoken) {
      const plan = c.speakPlan(line);
      expect(plan.privacy, line).toBe(true);
      expect(plan.fallen, line).toBe("supertonic");
      expect(plan.argTuning.allowCloud, line).toBe(false);
      expect(plan.argTuning.cloudClip, line).toBeUndefined();
    }
    expectNoNetwork();
  });

  it("the speech ladder speaks on this PC under privacy mode even when the online voice is preferred", async () => {
    installTripwires(true);
    const reached: string[] = [];
    const result = await ladder(reached).speakSegment(
      { text: "Opening the report.", lang: "en-IN" },
      { ...OPEN_CTX, privacyMode: true, prefer: "neural", privateVoice: "local" },
      { generation: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("supertonic");
    expect(reached).toEqual(["supertonic"]);
    expectNoNetwork();
  });

  it("the speech ladder control: the online voice does speak, and calls the network, when everything allows it", async () => {
    installTripwires(true);
    const reached: string[] = [];
    const result = await ladder(reached).speakSegment(
      { text: "Opening the report.", lang: "en-IN" },
      OPEN_CTX,
      { generation: 1 },
    );
    expect(reached[0]).toBe("edge");
    expect(result.engine).not.toBe("edge"); // its request was blocked, so the local voice took the clause
    expect(hits).toHaveLength(1);
    expect(hits[0]?.caller).toContain("core/__tests__/voice-offline-turn.test.ts");
  });
});

/** The provider router asked for one need with privacy mode on and every lane, key and quota present. */
function sarvamDecisionFor(need: Need) {
  return routeVoice(
    { need, sensitive: false, privacyMode: true, billingAllowsPaid: true, online: true },
    toRouterSettings(CLOUD_ON, { sarvam: true }),
    new UsageLedger(() => SIM_BASE_MS),
  );
}

/** Everything allows an online voice: only the privacy rules can keep a line on this PC. */
const OPEN_CTX: TtsContext = {
  online: true,
  privacyMode: false,
  sensitive: false,
  allowCloud: true,
  billingAllowsPaid: false,
};

/**
 * The real fallback manager over three fake voices: the online voice asks the network (so a tripwire sees it),
 * FRIDAY Voice and the system voice are local. `reached` lists the voices that were asked to speak.
 */
function ladder(reached: string[], isSensitive?: (text: string) => boolean): TtsFallbackManager {
  const voice = (info: TtsProviderInfo, network: boolean): TtsProvider => ({
    ...info,
    health: () => ({ state: "ready" }),
    cancel: () => undefined,
    async *speak(_text, options): AsyncIterable<TtsChunk> {
      reached.push(info.id);
      if (network) await fetch("https://edge.example.invalid/speak");
      yield { generation: options.generation, seq: 0, engine: info.id, audioBase64: info.id };
    },
  });
  return new TtsFallbackManager(
    [voice(TTS_INFO.edge, true), voice(TTS_INFO.supertonic, false), voice(TTS_INFO.sapi, false)],
    { now: () => SIM_BASE_MS, ...(isSensitive ? { isSensitive } : {}) },
  );
}
