/**
 * The app serves the chat model this PC really has in Ollama. Setup picks it by hardware tier
 * (config/chat-tiers.json through electron/setup-plan.cjs), so the warm-up must not key on one tag. Pure injected
 * facts and installed lists: no Ollama, no hardware, no network.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const library = require_(path.join(root, "electron/local-library.cjs"));
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const GIB = 1024 ** 3;
const facts = (ramGb: number, ramFreeGb: number) => ({
  vramGb: null,
  vramFreeGb: null,
  ramGb,
  ramFreeGb,
  diskFreeGb: 200,
  gpuVendor: null,
  gpuName: null,
  gpus: [],
  cudaReady: false,
  cpuClass: "mid",
  cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
  cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
  network: { online: true, metered: false },
  power: { batteryPresent: false, onAc: true },
  health: { level: "ok", reasons: [] },
});
const pick = (installed: unknown, options: Record<string, unknown> = {}) =>
  library.installedChatModel(installed, options) as { tag: string; source: string } | null;

describe("the chat model the app serves is the one this PC has", () => {
  it("keeps today's behaviour when only qwen3:4b is installed, or nothing is known", () => {
    const old = library.ollamaModels()[0].tag;
    expect(old).toBe("qwen3:4b");
    expect(pick(["qwen3:4b"], { facts: facts(16, 12) })).toEqual({
      tag: "qwen3:4b",
      source: "installed",
    });
    expect(pick(["qwen3:4b"])).toEqual({ tag: "qwen3:4b", source: "installed" });
    for (const nothing of [[], null, undefined, "x", [""], [{}], [{ name: "" }]]) {
      expect(pick(nothing, { facts: facts(16, 12) })).toEqual({ tag: old, source: "default" });
    }
  });

  it("serves the plan's tier model when setup pulled it", () => {
    expect(pick(["qwen3.5:4b"], { facts: facts(16, 12) })).toEqual({
      tag: "qwen3.5:4b",
      source: "installed",
    });
    expect(pick(["qwen3.5:2b"], { facts: facts(8, 6) })).toEqual({
      tag: "qwen3.5:2b",
      source: "installed",
    });
    // The better of two installed models wins; neither is deleted or assumed.
    expect(pick(["qwen3:4b", "qwen3.5:4b"], { facts: facts(16, 12) })?.tag).toBe("qwen3.5:4b");
    expect(pick(["qwen3.5:4b", "qwen3:4b"], { facts: facts(16, 12) })?.tag).toBe("qwen3.5:4b");
  });

  it("keeps a better installed qwen3:4b over a smaller tier (the plan keeps it too)", () => {
    expect(pick(["qwen3:4b", "qwen3.5:2b"], { facts: facts(8, 6) })?.tag).toBe("qwen3:4b");
  });

  it("never picks a model the memory of this PC cannot carry", () => {
    const small = facts(8, 5);
    // 9b weighs 6.6 GB: too much for an 8 GB PC, so the 4b that is installed serves.
    expect(pick(["qwen3.5:9b", "qwen3:4b"], { facts: small })?.tag).toBe("qwen3:4b");
    // A real size from Ollama counts over the table's listed one.
    const rows = [
      { name: "qwen3.5:4b", size: 40 * GIB },
      { name: "qwen3:4b", size: 2.5 * GIB },
    ];
    expect(pick(rows, { facts: facts(16, 12) })?.tag).toBe("qwen3:4b");
    // Without facts nothing is filtered out.
    expect(pick(["qwen3.5:9b", "qwen3:4b"])?.tag).toBe("qwen3.5:9b");
    // Nothing installed fits: the old default is still returned, as before.
    expect(pick(["qwen3.5:9b"], { facts: small })).toEqual({ tag: "qwen3:4b", source: "default" });
  });

  it("prefers the tag in use when it is installed, with or without :latest", () => {
    expect(pick(["qwen3.5:4b", "qwen3:4b"], { facts: facts(16, 12), prefer: "qwen3:4b" })).toEqual({
      tag: "qwen3:4b",
      source: "prefer",
    });
    expect(pick(["qwen3:4b:latest"], { prefer: "QWEN3:4b:latest" })?.source).toBe("prefer");
    expect(pick(["gemma3:latest"], { prefer: "gemma3" })).toEqual({
      tag: "gemma3:latest",
      source: "prefer",
    });
    // A preferred tag that is not installed is ignored.
    expect(pick(["qwen3.5:4b"], { facts: facts(16, 12), prefer: "qwen3.5:9b" })?.tag).toBe(
      "qwen3.5:4b",
    );
  });

  it("skips models that are not chat models and survives a broken table", () => {
    expect(pick(["nomic-embed-text:latest", "bge-m3"], { facts: facts(16, 12) })).toEqual({
      tag: "qwen3:4b",
      source: "default",
    });
    expect(pick(["nomic-embed-text", "qwen3:4b"])?.tag).toBe("qwen3:4b");
    expect(pick(["qwen3.5:4b"], { tiers: { tiers: "broken" } as never })).toEqual({
      tag: "qwen3:4b",
      source: "default",
    });
    expect(pick(["हिंदी:4b", "qwen3:4b"])?.tag).toBe("qwen3:4b");
  });

  it("falls back to the configured runner's first row, never a hard-coded tag", () => {
    const runner = { models: [{ tag: "llama3.2:3b", role: "x" }] };
    expect(pick([], { runner })).toEqual({ tag: "llama3.2:3b", source: "default" });
    expect(pick([], { runner: { models: [] } })).toBeNull();
  });
});

describe("Auto mode warm-up is wired to the discovery", () => {
  const main = read("electron/main.cjs");

  it("warms what Ollama holds ranked for this PC, not ollamaModels()[0]", () => {
    expect(main).toContain("function warmFastChatModel()");
    expect(main).toContain("async function localChatTag()");
    expect(main).toContain("library.installedChatModel(held, { facts })");
    expect(main).toContain("void localChatTag()");
    expect(main).not.toContain('require("./local-library.cjs").ollamaModels()[0]');
  });

  it("goes through the prefetch-priority load slot and the governor", () => {
    const warm = main.slice(main.indexOf("function warmFastChatModel()"));
    const body = warm.slice(0, warm.indexOf("async function localChatTag()"));
    expect(body).toContain("governor.allowsPrefetch()");
    expect(body).toContain('loadLeases.runLoad("prefetch", () => modelsApi.ollamaWarm(tag))');
  });
});
