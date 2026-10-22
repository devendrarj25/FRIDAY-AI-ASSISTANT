/**
 * Contract: each provider's list response classifies through that provider's
 * own handler of the access engine, an old cache keeps proven-free models free
 * (flagged cached), no proof stays unknown, and the daily refresh updates it.
 * Fixtures are in the shape each provider documents (see the fixture note).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const access = require_("../../electron/model-access.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");
const policy = require_("../../electron/billing-policy.cjs");
const fixture = JSON.parse(readFileSync("core/fixtures/provider-model-lists.json", "utf8"));

const DAY = 24 * 60 * 60 * 1000;
const billing = () => policy.normaliseBilling({ ...policy.DEFAULT_BILLING });
const row = (id: string) =>
  access.knowledgeCatalogue(Date.now()).find((r: { id: string }) => r.id === id);

function gate(record: unknown, id: string) {
  return firewall.guardProviderRequest({
    model: { id, type: "cloud", accessRecord: record },
    billing: billing(),
    policy: "free-only",
  });
}

describe("OpenRouter: price in the list decides, the name only hints", () => {
  const byId = Object.fromEntries(fixture.openrouter.data.map((m: { id: string }) => [m.id, m]));
  const classify = (id: string) =>
    access.classifyModel({ providerId: "openrouter", modelId: id, catalogue: byId[id] });

  it("zero prompt and completion price is free and allowed with paid access off", () => {
    const record = classify("meta-llama/llama-3.3-70b-instruct:free");
    expect(record.billingMode).toBe("ZERO_COST");
    expect(gate(record, "or:free").allowed).toBe(true);
  });

  it("a priced model is paid and blocked, even with a friendly name", () => {
    expect(classify("openai/gpt-4o-mini").billingMode).toBe("PAID");
    const mislabelled = classify("vendor/mislabelled:free");
    expect(mislabelled.billingMode).toBe("PAID");
    expect(gate(mislabelled, "or:m").allowed).toBe(false);
  });

  it("a :free name with no price is unknown, never free", () => {
    const record = classify("vendor/no-price-listed:free");
    expect(record.billingMode).toBe("UNKNOWN");
    expect(gate(record, "or:n").allowed).toBe(false);
  });
});

describe("Hugging Face: a live zero-priced route is free, otherwise priced", () => {
  const byId = Object.fromEntries(fixture.huggingface.data.map((m: { id: string }) => [m.id, m]));
  it("classifies from the providers[] pricing in the list", () => {
    const free = access.classifyModel({
      providerId: "huggingface",
      modelId: "Qwen/Qwen3-8B",
      catalogue: byId["Qwen/Qwen3-8B"],
    });
    expect(free.billingMode).toBe("ZERO_COST");
    const paid = access.classifyModel({
      providerId: "huggingface",
      modelId: "vendor/paid-only-model",
      catalogue: byId["vendor/paid-only-model"],
    });
    expect(paid.billingMode).toBe("PAID");
  });
});

describe("Gemini: the documented free tier, kept as the last good copy when old", () => {
  const free = fixture.gemini.models[0].name.replace("models/", "");
  const image = fixture.gemini.models[1].name.replace("models/", "");
  const checkedAt = row("gemini").checkedAt as number;

  it("is free while fresh, and an image model never is", () => {
    const now = checkedAt + DAY / 2;
    const record = access.classifyModel({ providerId: "gemini", modelId: free }, now);
    expect(record.billingMode).toBe("FREE_QUOTA");
    expect(record.evidence.cached).toBeUndefined();
    expect(
      access.classifyModel({ providerId: "gemini", modelId: image }, now).billingMode,
    ).not.toBe("FREE_QUOTA");
  });

  it("stays free 60 days later, flagged cached with its age, and the firewall allows it", () => {
    const now = checkedAt + 60 * DAY;
    const record = access.classifyModel({ providerId: "gemini", modelId: free }, now);
    expect(record.billingMode).toBe("FREE_QUOTA");
    expect(record.failureReason).toBeNull();
    expect(record.evidence.stale).toBe(false);
    expect(record.evidence.cached).toBe(true);
    expect(record.evidence.cachedAgeMs).toBe(60 * DAY);
    expect(access.coarseAccess(record)).toBe("free");
    expect(gate(record, "gemini:flash").allowed).toBe(true);
  });

  it("fails closed with no proof: a model the table never listed, and a table never read", () => {
    const now = checkedAt + 60 * DAY;
    const unlisted = access.classifyModel(
      { providerId: "gemini", modelId: "gemini-unlisted-9" },
      now,
    );
    expect(unlisted.billingMode).toBe("UNKNOWN");
    expect(unlisted.failureReason).toBe("pricing_stale");
    expect(gate(unlisted, "gemini:x").allowed).toBe(false);
    expect(access.knowledgeProof({ checkedAt: 0 })).toBe(false);
    expect(access.knowledgeProof({ checkedAt })).toBe(true);
  });
});

describe("Groq: the list carries no price, so nothing is invented", () => {
  it("keeps list models paid or unknown, and never free by name", () => {
    for (const model of fixture.groq.data) {
      const record = access.classifyModel({
        providerId: "groq",
        modelId: model.id,
        catalogue: model,
      });
      expect(access.coarseAccess(record)).not.toBe("free");
      expect(gate(record, `groq:${model.id}`).allowed).toBe(false);
    }
  });

  it("an owner declaration still makes it free after the table is old", () => {
    const base = access.classifyModel(
      { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
      (row("groq").checkedAt as number) + 90 * DAY,
    );
    const declared = access.applyOwnerDeclaration(base, { model: "free" }, Date.now());
    expect(access.coarseAccess(declared)).toBe("free");
  });
});

describe("daily refresh", () => {
  const checkedAt = row("gemini").checkedAt as number;

  it("lists a source as due once it is a day old, not only near its 14-day edge", () => {
    expect(
      access
        .planKnowledgeRefresh(checkedAt + DAY / 2)
        .some((r: { id: string }) => r.id === "gemini"),
    ).toBe(false);
    expect(
      access
        .planKnowledgeRefresh(checkedAt + DAY + 1)
        .some((r: { id: string }) => r.id === "gemini"),
    ).toBe(true);
    expect(access.REFRESH_EVERY_MS).toBe(DAY);
  });

  it("a failed fetch keeps the last good table, flagged cached, models still free", async () => {
    const now = checkedAt + 3 * DAY;
    const outcome = await access.refreshDueKnowledge({
      now,
      online: true,
      privacy: false,
      fetchPage: async () => {
        throw new Error("network down");
      },
    });
    expect(outcome.applied).not.toContain("gemini");
    expect(outcome.kept.some((k: { id: string; reason: string }) => k.id === "gemini")).toBe(true);
    const status = access.knowledgeStatus(now).find((r: { id: string }) => r.id === "gemini");
    expect(status.state).toBe("cached");
    const record = access.classifyModel({ providerId: "gemini", modelId: "gemini-2.5-flash" }, now);
    expect(access.coarseAccess(record)).toBe("free");
  });

  it("a recognised page moves the date, and the model is no longer cached", async () => {
    const now = checkedAt + 3 * DAY;
    try {
      const outcome = await access.refreshDueKnowledge({
        now,
        online: true,
        privacy: false,
        fetchPage: async () =>
          "Gemini API pricing. Free tier and paid tier prices for every model listed here.",
      });
      expect(outcome.applied).toContain("gemini");
      const status = access.knowledgeStatus(now).find((r: { id: string }) => r.id === "gemini");
      expect(status.state).toBe("fresh");
      expect(status.checkedAt).toBe(now);
      const record = access.classifyModel(
        { providerId: "gemini", modelId: "gemini-2.5-flash" },
        now,
      );
      expect(record.billingMode).toBe("FREE_QUOTA");
      expect(record.evidence.cached).toBeUndefined();
    } finally {
      access.clearKnowledgeOverlay();
    }
  });

  it("privacy mode and offline never fetch, and the proven-free copy keeps serving", async () => {
    let fetched = 0;
    const fetchPage = async () => {
      fetched += 1;
      return "";
    };
    const now = checkedAt + 5 * DAY;
    expect(
      (await access.refreshDueKnowledge({ now, privacy: true, online: true, fetchPage })).skipped,
    ).toBe("privacy");
    expect(
      (await access.refreshDueKnowledge({ now, privacy: false, online: false, fetchPage })).skipped,
    ).toBe("offline");
    expect(fetched).toBe(0);
  });

  it("is run at start, on the daily tick, after sleep, and by Refresh now", () => {
    const main = readFileSync("electron/main.cjs", "utf8");
    const body = main.slice(main.indexOf("async function runCatalogueRefresh"));
    for (const trigger of ["startup", "manual", "foreground", "interval", "sleep-resume"]) {
      expect(body.slice(0, 900)).toContain(`"${trigger}"`);
    }
    expect(main).toContain('ipcMain.handle("models:knowledge-status"');
  });
});
