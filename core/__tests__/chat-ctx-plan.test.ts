/**
 * The chat window follows the setup plan (electron/setup-plan.cjs chat.numCtx) for the CURRENT hardware facts, never
 * above the model's native context, the owner's override first, the RAM ladder only when no plan can be built; the fast
 * voice twin gets its own small window; the kernel reads the same record (kernel/router.py, kernel/tests/fixtures).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const models = require_(path.join(root, "electron/models.cjs")) as {
  ollamaNumCtx: (o?: Record<string, unknown>) => number | null;
  ollamaWarmBody: (
    model: string,
    keepAlive?: string | number,
    o?: Record<string, unknown>,
  ) => { options?: { num_ctx?: number } };
  refreshChatPlan: (o?: Record<string, unknown>) => Promise<{
    tag: string;
    numCtx: number;
    voice: { tag: string; ctx: number } | null;
  } | null>;
  resetChatPlan: () => void;
};
const plan = require_(path.join(root, "electron/setup-plan.cjs"));
const fixture = JSON.parse(
  readFileSync(path.join(root, "kernel/tests/fixtures/chat_ctx_parity.json"), "utf8"),
);

type Facts = Record<string, unknown>;
const base = (extra: Facts = {}): Facts => ({
  vramGb: null,
  vramFreeGb: null,
  ramGb: 16,
  ramFreeGb: 12,
  diskFreeGb: 200,
  gpuVendor: null,
  gpuName: null,
  gpus: [],
  cudaReady: false,
  driverVersion: null,
  cpuClass: "mid",
  cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
  vulkan: false,
  cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
  network: { online: true, metered: false },
  power: { batteryPresent: false, onAc: true },
  health: { level: "ok", reasons: [] },
  ...extra,
});
const nvidia = (vramGb: number): Facts =>
  base({
    vramGb,
    vramFreeGb: vramGb - 1,
    gpuVendor: "nvidia",
    gpuName: "Test NVIDIA card",
    gpus: [
      {
        vendor: "nvidia",
        name: "Test NVIDIA card",
        vramGb,
        vramCapped: false,
        driver: "560.94",
        integrated: false,
        computeCap: 7.5,
      },
    ],
    cudaReady: true,
    driverVersion: "560.94",
    vulkan: true,
    cuda: { driverCuda: "12.6", cublas12: false, cudnn9: false, runtimeFilesFound: false },
  });

let dir = "";
beforeEach(() => {
  models.resetChatPlan();
  dir = mkdtempSync(path.join(tmpdir(), "friday-ctx-"));
});
afterEach(() => {
  models.resetChatPlan();
  rmSync(dir, { recursive: true, force: true });
});

describe("one table with the kernel: same record, same model, same window", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const got = models.ollamaNumCtx({
        ramGb: fixture.ramGb,
        env: c.env ? { FRIDAY_OLLAMA_NUM_CTX: c.env } : {},
        tiers: fixture.tiers,
        chat: c.record,
        model: c.model,
      });
      expect(got).toBe(c.expected);
    });
  }
});

describe("the window comes from the plan of the current hardware facts", () => {
  it("equals buildSetupPlan's chat.numCtx for the same facts, on a CPU PC and on a GPU PC", async () => {
    for (const facts of [base(), nvidia(12), nvidia(24)]) {
      models.resetChatPlan();
      const expected = plan.buildSetupPlan({ ...facts, diskFreeGb: null }, {}).chat;
      const chat = await models.refreshChatPlan({ facts, root: dir });
      expect(chat?.tag).toBe(expected.tag);
      expect(chat?.numCtx).toBe(expected.numCtx);
      expect(models.ollamaNumCtx({ env: {}, model: expected.tag, chat })).toBe(expected.numCtx);
      expect(expected.numCtx).toBeGreaterThan(8192 - 1);
    }
  });

  it("the main model never gets the twin's window and the twin never the main one", async () => {
    const facts = base();
    const expected = plan.buildSetupPlan(facts, {}).chat;
    expect(expected.voice?.tag).toBeTruthy();
    const chat = await models.refreshChatPlan({ facts, root: dir });
    const env = {};
    const main = models.ollamaNumCtx({ env, model: expected.tag, chat });
    const twin = models.ollamaNumCtx({ env, model: expected.voice.tag, chat });
    expect(twin).toBe(expected.voice.ctx);
    expect(twin).toBeGreaterThanOrEqual(2048);
    expect(twin).toBeLessThanOrEqual(4096);
    expect(main).toBe(expected.numCtx);
    expect(main).not.toBe(twin);
    expect(models.ollamaWarmBody(expected.voice.tag, "5m", { env, chat }).options?.num_ctx).toBe(
      twin,
    );
    expect(models.ollamaWarmBody(expected.tag, "5m", { env, chat }).options?.num_ctx).toBe(main);
  });

  it("is never above the model's native context", () => {
    const tiers = { tiers: [{ tag: "tiny:1b", contextK: 4 }] };
    const chat = { tag: "tiny:1b", numCtx: 65536, voice: null };
    expect(models.ollamaNumCtx({ env: {}, tiers, chat, model: "tiny:1b" })).toBe(4096);
  });

  it("the owner's override wins, and off turns it off", () => {
    const chat = { tag: "m:1b", numCtx: 32768, voice: null };
    const at = (v: string) =>
      models.ollamaNumCtx({ env: { FRIDAY_OLLAMA_NUM_CTX: v }, chat, model: "m:1b" });
    expect(at("4096")).toBe(4096);
    expect(at("off")).toBeNull();
  });

  it("is cached per process, then re-read when the time is up, and a changed PC changes it", async () => {
    let clock = 1_000;
    let calls = 0;
    let facts: Facts = base();
    const options = {
      root: dir,
      now: () => clock,
      detect: async () => {
        calls += 1;
        return facts;
      },
    };
    const first = await models.refreshChatPlan(options);
    await models.refreshChatPlan(options);
    expect(calls).toBe(1);
    facts = nvidia(12);
    clock += 60_000;
    expect(await models.refreshChatPlan(options)).toEqual(first);
    expect(calls).toBe(1);
    clock += 16 * 60_000;
    const next = await models.refreshChatPlan(options);
    expect(calls).toBe(2);
    expect(next?.numCtx).toBe(plan.buildSetupPlan({ ...facts, diskFreeGb: null }, {}).chat.numCtx);
    expect(next?.numCtx).not.toBe(first?.numCtx);
    const record = JSON.parse(readFileSync(path.join(dir, "runtime", "chat-ctx.json"), "utf8"));
    expect(record).toMatchObject({ schema: 1, tag: next?.tag, numCtx: next?.numCtx });
    expect(record.fingerprint).toBe(
      plan.planFingerprint(plan.buildSetupPlan({ ...facts, diskFreeGb: null }, {})),
    );
  });

  it("free disk does not change the window (it only decides what to download)", async () => {
    const roomy = await models.refreshChatPlan({ facts: base({ diskFreeGb: 500 }), root: dir });
    models.resetChatPlan();
    const tight = await models.refreshChatPlan({ facts: base({ diskFreeGb: 6 }), root: dir });
    expect(tight).toEqual(roomy);
  });

  it("a PC that cannot be planned falls back to the RAM ladder and never throws", async () => {
    const chat = await models.refreshChatPlan({
      root: dir,
      detect: async () => {
        throw new Error("probe failed");
      },
    });
    expect(chat).toBeNull();
    const tiers = { ollamaSettings: { options: { num_ctx: 8192 } } };
    expect(models.ollamaNumCtx({ ramGb: 8, env: {}, tiers, model: "m:1b" })).toBe(4096);
    expect(models.ollamaNumCtx({ ramGb: 16, env: {}, tiers, model: "m:1b" })).toBe(8192);
  });
});

describe("the warm-up asks for the plan's window before it sends", () => {
  it("ollamaWarm refreshes the plan and sends ollamaWarmBody", () => {
    const source = readFileSync(path.join(root, "electron/models.cjs"), "utf8");
    const warm = source.slice(source.indexOf("async function ollamaWarm("));
    expect(warm.slice(0, 700)).toContain("await refreshChatPlan();");
    expect(warm.slice(0, 700)).toContain("JSON.stringify(ollamaWarmBody(model, keepAlive))");
    expect(source).toContain("ollamaNumCtx({ ...options, model })");
  });

  it("the kernel's request path asks for the window of the model it calls", () => {
    const source = readFileSync(path.join(root, "kernel/router.py"), "utf8");
    expect(source).toContain("window = ollama_num_ctx(total_ram_gb(), model.wire_model)");
  });
});
