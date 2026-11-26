/**
 * The model the Auto-mode warm-up loads is the one the router ranks first for the voice surface, so the first spoken
 * turn is not a cold start of a different model. Pure injected facts and installed lists: no Ollama, no hardware.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");
const hwMod = require_("../../electron/hardware.cjs");
const library = require_("../../electron/local-library.cjs");
const modelsApi = require_("../../electron/models.cjs");

function pc(o: { ramGb: number; freeGb: number; vramGb?: number }) {
  const gpus = o.vramGb
    ? [
        {
          vendor: "nvidia",
          name: "Any Card",
          vramTotalMb: o.vramGb * 1024,
          vramKnown: true,
          vramUsedMb: 512,
          driver: "560.94",
        },
      ]
    : [];
  return hwMod.hardwareFacts({
    cpu: { cores: 16, threads: 16, physicalCores: 8 },
    memory: { totalGb: o.ramGb, freeGb: o.freeGb },
    disk: { freeGb: 300 },
    gpus,
    cuda: { driverAvailable: gpus.length > 0, driverCudaVersion: "12.6" },
  });
}

const SIZE_GB: Record<string, number> = {
  "qwen3:4b": 2.6,
  "qwen3.5:2b": 2.7,
  "qwen3.5:4b": 3.4,
  "qwen3.5:9b": 6.6,
};

/** Every installed tag as the desktop describes it, scored by the real router for the voice surface. */
function routerTop(tags: string[], facts: unknown): string[] {
  const rows = tags.map((tag) =>
    router.describe({
      id: `ollama:${tag}`,
      type: "local",
      role: modelsApi.inferRole(tag),
      contextK: 32,
      providerId: "ollama",
      meta: {
        providerId: "ollama",
        kind: "local",
        modelName: tag,
        connected: true,
        sizeGb: SIZE_GB[tag],
      },
    }),
  );
  const scored = rows.map((row: { id: string }) => ({
    tag: row.id.replace(/^ollama:/, ""),
    score: router.scoreModel(row, { surface: "voice", hardware: facts, policy: "free-only" }),
  }));
  const best = Math.max(...scored.map((s: { score: number }) => s.score));
  return scored
    .filter((s: { score: number }) => s.score === best)
    .map((s: { tag: string }) => s.tag);
}

const warmed = (tags: string[], facts: unknown, options: Record<string, unknown> = {}) =>
  library.installedChatModel(
    tags.map((name) => ({ name })),
    { facts, ...options },
  )?.tag as string;

describe("the warmed model is the one the router ranks first for voice", () => {
  it("is the router's voice pick on a 16 GB PC with no GPU holding a 4b and a 9b", () => {
    const facts = pc({ ramGb: 16, freeGb: 12 });
    const tags = ["qwen3:4b", "qwen3.5:9b"];
    expect(routerTop(tags, facts)).toEqual(["qwen3:4b"]);
    expect(warmed(tags, facts)).toBe("qwen3:4b");
  });

  it("is the router's voice pick on an 8 GB card", () => {
    const facts = pc({ ramGb: 16, freeGb: 12, vramGb: 8 });
    const tags = ["qwen3.5:9b", "qwen3:4b"];
    expect(routerTop(tags, facts)).toContain(warmed(tags, facts));
  });

  it("stays inside the router's top set when two models tie on a big card", () => {
    const facts = pc({ ramGb: 64, freeGb: 40, vramGb: 24 });
    const tags = ["qwen3.5:4b", "qwen3.5:9b"];
    expect(routerTop(tags, facts)).toContain(warmed(tags, facts));
  });

  it("still never picks a model the memory of this PC cannot carry", () => {
    const facts = pc({ ramGb: 8, freeGb: 5 });
    expect(warmed(["qwen3.5:9b", "qwen3:4b"], facts)).toBe("qwen3:4b");
  });

  it("keeps quality-first ordering for a chat surface and when no facts are known", () => {
    const facts = pc({ ramGb: 16, freeGb: 12 });
    expect(warmed(["qwen3:4b", "qwen3.5:9b"], facts, { surface: "chat" })).toBe("qwen3.5:9b");
    expect(warmed(["qwen3:4b", "qwen3.5:9b"], null)).toBe("qwen3.5:9b");
  });

  it("keeps the tag in use when it is installed", () => {
    const facts = pc({ ramGb: 16, freeGb: 12 });
    expect(warmed(["qwen3:4b", "qwen3.5:9b"], facts, { prefer: "qwen3.5:9b" })).toBe("qwen3.5:9b");
  });
});
