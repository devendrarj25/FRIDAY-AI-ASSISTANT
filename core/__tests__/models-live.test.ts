/**
 * The Models page tells the truth: an installed tag marks exactly its own
 * catalog row, usage is counted per model, and the live state word comes from
 * the router's own health. No network, no engine, no clock of the day.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  modelCatalog,
  modelByTag,
  modelsByTag,
  registryTag,
  tagMatches,
} from "../../src/lib/friday/model-catalog";
import { formatRetry, formatTokens, modelLiveState } from "../../src/lib/friday/model-live";
import {
  answerModelsQuestion,
  modelNamed,
  type ModelsView,
} from "../../src/lib/friday/models-command";
import type { ModelLiveRow } from "../../src/lib/friday/desktop";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const usage = require_(path.join(root, "electron/model-usage.cjs"));

describe("installed tags mark exactly their own row", () => {
  it("never lets one tag stand for every size of its family", () => {
    expect(tagMatches("qwen2.5:1.5b", "qwen2.5:1.5b")).toBe(true);
    expect(tagMatches("qwen2.5:latest", "qwen2.5:1.5b")).toBe(false);
    expect(tagMatches("qwen2.5:7b", "qwen2.5:1.5b")).toBe(false);
    expect(tagMatches("qwen2.5:latest", "qwen2.5")).toBe(true);
    expect(tagMatches("QWEN2.5:1.5B", "qwen2.5:1.5b")).toBe(true);
    expect(tagMatches("", "qwen2.5")).toBe(false);
  });

  it("maps each real catalog tag back to itself and a bare family tag to nothing", () => {
    const tagged = modelCatalog.filter((m) => registryTag(m));
    expect(tagged.length).toBeGreaterThan(5);
    for (const m of tagged) {
      expect(
        modelsByTag(registryTag(m)!).map((x) => x.id),
        m.id,
      ).toContain(m.id);
    }
    const families = new Set(tagged.map((m) => registryTag(m)!.split(":")[0]));
    const multi = [...families].find(
      (slug) => tagged.filter((m) => registryTag(m)!.split(":")[0] === slug).length > 1,
    );
    if (multi) expect(modelByTag(`${multi}:latest`)).toBeNull();
    // A family with exactly one catalog size: its `:latest` is that size.
    expect(modelByTag("llama3.1:latest")?.id).toBe("llama3.1-8b");
  });

  it("the page reads the shared matcher and a failed delete keeps the row installed", () => {
    const engine = readFileSync(path.join(root, "src/lib/friday/models-engine.ts"), "utf8");
    expect(engine).toContain("modelsByTag(t).some((hit) => hit.id === spec.id)");
    expect(engine).toContain("was not deleted");
    // The inventory is re-read on the shared poller while the page is open.
    expect(engine).toContain('"models.inventory"');
    expect(engine).toContain("this.offInventory?.()");
    expect(engine).toContain('"Connected"');
  });
});

describe("usage ledger", () => {
  it("counts per model, rolls the day over and never keeps prompt text", () => {
    let t = Date.parse("2026-10-24T10:00:00");
    const ledger = usage.createUsageLedger({ now: () => t });
    ledger.record({ modelId: "m", prompt: "x".repeat(40), text: "y".repeat(80), ok: true });
    ledger.record({ modelId: "m", prompt: "abcd", ok: false });
    ledger.record({ modelId: "m", blocked: true });
    ledger.record({ modelId: "m", cancelled: true, prompt: "zzzz" });
    let row = ledger.snapshot().models[0];
    expect(row).toMatchObject({ requests: 2, answered: 1, failed: 1, blocked: 1 });
    expect(row.promptTokens).toBe(11);
    expect(row.completionTokens).toBe(20);
    expect(row.estimated).toBe(true);
    expect(JSON.stringify(row)).not.toContain("xxxx");
    t += 86_400_000;
    row = ledger.snapshot().models[0];
    expect(row.todayTokens).toBe(0);
    expect(row.promptTokens + row.completionTokens).toBe(31);
  });

  it("a figure the provider reported replaces the estimate for that request", () => {
    const ledger = usage.createUsageLedger();
    ledger.record({
      modelId: "m",
      prompt: "hello",
      text: "world",
      ok: true,
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    const row = ledger.snapshot().models[0];
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(50);
    expect(row.estimated).toBe(false);
  });

  it("restores saved counts and can be reset", () => {
    const first = usage.createUsageLedger();
    first.record({ modelId: "a", prompt: "abcd", text: "abcdefgh", ok: true });
    const second = usage.createUsageLedger({ initial: first.snapshot() });
    expect(second.snapshot().models[0].answered).toBe(1);
    second.reset("a");
    expect(second.snapshot().models).toEqual([]);
  });

  it("every provider request goes through the one recording wrapper", () => {
    const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
    expect(main).toContain("async function streamOnce(args)");
    expect(main).toContain("usageLedger.record({");
    expect(main).toContain('ipcMain.handle("models:live-status"');
  });
});

const row = (over: Partial<ModelLiveRow> = {}): ModelLiveRow => ({
  modelId: "m",
  providerId: "groq",
  requests: 4,
  answered: 3,
  failed: 1,
  blocked: 0,
  promptTokens: 400,
  completionTokens: 900,
  todayTokens: 1300,
  estimated: true,
  lastAt: 1_000_000,
  lastOutcome: "answered",
  status: "available",
  category: null,
  coolingDown: false,
  cooldownUntil: 0,
  quarantined: false,
  breaker: "CLOSED",
  failures: 0,
  lastError: null,
  nextStep: "",
  latencyMs: 300,
  lastOkAt: 1_000_000,
  ...over,
});

describe("live model state", () => {
  const now = 1_010_000;
  it("names each situation in the router's own terms", () => {
    expect(modelLiveState(undefined, now).state).toBe("Ready");
    expect(modelLiveState(row(), now).state).toBe("Active");
    expect(modelLiveState(row({ lastAt: now - 600_000 }), now).state).toBe("Ready");
    const rate = modelLiveState(
      row({
        category: "rate_limited",
        cooldownUntil: now + 45_000,
        failures: 1,
        lastOutcome: "failed",
      }),
      now,
    );
    expect(rate).toMatchObject({ state: "Rate limited", tone: "warning", retryInMs: 45_000 });
    expect(rate.detail).toContain("45s");
    expect(
      modelLiveState(
        row({ category: "timeout", cooldownUntil: now + 5000, lastOutcome: "failed" }),
        now,
      ).state,
    ).toBe("Cooling down");
    const quarantined = modelLiveState(
      row({
        quarantined: true,
        cooldownUntil: now + 120_000,
        failures: 3,
        lastOutcome: "failed",
        nextStep: "Check this provider's API key in Models.",
      }),
      now,
    );
    expect(quarantined.state).toBe("Quarantined");
    expect(quarantined.detail).toContain("API key");
    expect(modelLiveState(row({ lastOutcome: "failed", failures: 2 }), now).state).toBe(
      "Recovering",
    );
    expect(modelLiveState(row({ lastOutcome: "blocked" }), now).state).toBe("Blocked");
  });

  it("a cooldown that has ended is no longer shown as one", () => {
    expect(
      modelLiveState(
        row({ cooldownUntil: now - 1, quarantined: true, lastOutcome: "failed", failures: 3 }),
        now,
      ).state,
    ).toBe("Recovering");
  });

  it("formats the countdown and the token counts", () => {
    expect(formatRetry(500)).toBe("1s");
    expect(formatRetry(45_000)).toBe("45s");
    expect(formatRetry(5 * 60_000)).toBe("5 min");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });
});

const view = (over: Partial<ModelsView> = {}): ModelsView =>
  ({
    models: {
      installed: { "qwen2.5-1.5b": "1.0" },
      imported: [],
      jobs: [],
      lastScanAt: 1,
      providerState: {
        groq: {
          id: "groq",
          detected: true,
          online: true,
          endpoint: "",
          apiKey: "stored",
          models: 12,
          latencyMs: 90,
          error: null,
          checkedAt: 1,
        },
        ollama: {
          id: "ollama",
          detected: true,
          online: true,
          endpoint: "",
          apiKey: null,
          models: 2,
          latencyMs: 5,
          error: null,
          checkedAt: 1,
        },
      },
    },
    registry: {
      routeMode: "auto",
      policy: "free-preferred",
      qualityTarget: "balanced",
      strategy: "auto",
      selected: [],
      hint: "",
      models: [{ id: "m", label: "Llama 3.3 70B", type: "cloud", access: "free" }],
    },
    live: {
      loaded: true,
      at: 1,
      now: 1,
      byId: {
        m: row({
          cooldownUntil: 2_000_000,
          category: "rate_limited",
          failures: 1,
          lastOutcome: "failed",
        }),
      },
      totals: { requests: 4, tokens: 1300, todayTokens: 1300 },
      decisions: [{ at: 1, modelId: "m", why: "", latencyMs: 200, outcome: "ok" }],
    },
    now: 1_010_000,
    ...over,
  }) as unknown as ModelsView;

describe("FRIDAY answers about her own models", () => {
  it("lists installed models, connected providers, cooldowns, tokens and the router", () => {
    expect(answerModelsQuestion("which models are installed?", view())).toMatch(/Qwen2\.5 1\.5B/i);
    expect(answerModelsQuestion("kaun se providers connected hain", view())).toMatch(
      /Cloud connected: .*groq|Groq/i,
    );
    expect(answerModelsQuestion("any model cooling down?", view())).toMatch(
      /Llama 3\.3 70B: rate limited/,
    );
    expect(answerModelsQuestion("how many tokens have I used today?", view())).toMatch(/1\.3k/);
    expect(answerModelsQuestion("what is the router status", view())).toMatch(/Router mode auto/);
    expect(answerModelsQuestion("which models are free", view())).toMatch(/1 free/);
  });

  it("is honest when it has not scanned or nothing is wrong", () => {
    const unscanned = view({
      models: { ...view().models, installed: {}, lastScanAt: null } as never,
    });
    expect(answerModelsQuestion("which models are installed?", unscanned)).toMatch(/not scanned/);
    const calm = view({ live: { ...view().live, byId: {} } });
    expect(answerModelsQuestion("any model quarantined?", calm)).toMatch(
      /No model is cooling down/,
    );
  });

  it("leaves everything else to the normal brain", () => {
    expect(answerModelsQuestion("how many tokens are in this paragraph", view())).toBeNull();
    expect(answerModelsQuestion("write a poem about the sea", view())).toBeNull();
    expect(answerModelsQuestion("is this model good at maths", view())).toBeNull();
  });

  it("only downloads a model it can name exactly", () => {
    expect(modelNamed("qwen2.5 1.5b")?.id).toBe("qwen2.5-1.5b");
    expect(modelNamed("the quarterly report")).toBeNull();
  });
});

describe("speech and voice routing are the voice stack's real choices", () => {
  const weights = require_(path.join(root, "electron/voice-weights.cjs"));

  it("lists exactly the sizes the speech worker can open", async () => {
    const { STT_SIZE_MODEL, sttSizeOf, routingTasks, NEURAL_VOICE_MODEL } =
      await import("../../src/lib/friday/model-catalog");
    expect(STT_SIZE_MODEL).toEqual(weights.STT_CATALOG);
    expect(sttSizeOf("faster-whisper")).toBe("large-v3");
    expect(sttSizeOf("silero-vad")).toBeNull();
    const speech = routingTasks.find((t) => t.key === "speech")!;
    const voice = routingTasks.find((t) => t.key === "voice")!;
    expect(speech.only).toEqual(Object.values(STT_SIZE_MODEL));
    expect(voice.only).toEqual([NEURAL_VOICE_MODEL]);
    expect(read_("src/routes/models.tsx")).toContain("(!task.only || task.only.includes(m.id))");
  });

  it("assigning a speech model sets the Settings size, and the Settings size sets the assignment", async () => {
    const { models } = await import("../../src/lib/friday/models-engine");
    const { preferences } = await import("../../src/lib/friday/preferences");
    models.assign("speech", "faster-whisper-base");
    expect(preferences.getSnapshot().voice.sttSize).toBe("base");
    models.assign("speech", null);
    expect(preferences.getSnapshot().voice.sttSize).toBe("auto");
    models.assign("speech", "faster-whisper");
    expect(preferences.getSnapshot().voice.sttSize).toBe("large-v3");
    const engine = read_("src/lib/friday/models-engine.ts");
    expect(engine).toContain("preferences.subscribe(this.syncSpeechFromPrefs)");
    expect(engine).toContain("this.state.routing.speech = this.speechFromPrefs();");
  });
});

function read_(file: string) {
  return readFileSync(path.join(root, file), "utf8");
}

describe("voice stack on the Models page", () => {
  it("shows the running session next to the files it uses", async () => {
    const { voiceStackLines } = await import("../../src/lib/friday/voice-stack");
    const idle = voiceStackLines({
      health: null,
      speechAssigned: null,
      installed: { A: true, B: false },
    });
    expect(idle[0]).toMatchObject({ label: "Auto mode", status: "Idle" });
    expect(idle.at(-1)).toMatchObject({
      label: "Voice files on this PC",
      status: "1 of 2",
      tone: "warning",
    });
    expect(idle.find((l) => l.label.startsWith("Task routing"))?.status).toBe("Auto");

    const live = voiceStackLines({
      health: {
        mode: "auto",
        listening: true,
        paused: false,
        micReady: true,
        micDetail: "Realtek array",
        sttReady: false,
        sttModel: "small",
        sttError: "model-missing",
        heard: 4,
        dropped: {},
        droppedTotal: 1,
        ttsEngine: "supertonic-3",
        ttsError: "",
        turnLine: "",
        stoppedAt: null,
      },
      speechAssigned: "faster-whisper-small",
      installed: { A: true },
    });
    expect(live.find((l) => l.label === "Speech to text")).toMatchObject({
      status: "Not ready",
      tone: "destructive",
      value: "model-missing",
    });
    expect(live.find((l) => l.label === "Speaks with")?.value).toBe("supertonic-3");
    expect(live.find((l) => l.label.startsWith("Task routing"))?.status).toBe("Pinned");
    expect(read_("src/components/friday/ModelsLivePanel.tsx")).toContain("voiceStackLines(");
  });
});

describe("a speech size downloaded from the Models page is the folder the worker opens", () => {
  it("fetches the whole faster-whisper repo, which holds the files the worker checks", async () => {
    const { sourcesFor } = await import("../../src/lib/friday/model-sources");
    const weights = require_(path.join(root, "electron/voice-weights.cjs"));
    for (const [size, id] of Object.entries(weights.STT_CATALOG as Record<string, string>)) {
      const source = sourcesFor(id)[0] as { kind: string; repo?: string } | undefined;
      expect(source?.kind, id).toBe("hf-repo");
      expect(source?.repo, id).toBe(weights.STT_REPOS[size]);
    }
  });
});
