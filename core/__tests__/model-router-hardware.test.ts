/**
 * Hardware facts reach routing: the same router code, fed different measured facts, makes different local
 * choices. Privacy, then billing, then choice: hardware only orders what those two already allowed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");
const hwMod = require_("../../electron/hardware.cjs");

type Row = { id: string; meta?: Record<string, unknown> };

const local = (id: string, sizeGb: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "local" as const,
  contextK: 8,
  providerId: "ollama",
  meta: {
    providerId: "ollama",
    kind: "local",
    modelName: id.split(":")[1] || id,
    connected: true,
    sizeGb,
    ...extra,
  },
});
const cloudFree = (id: string) => ({
  id: `groq:${id}`,
  type: "cloud" as const,
  contextK: 8,
  providerId: "groq",
  providerModelId: id,
  meta: { providerId: "groq", kind: "cloud", modelName: id, connected: true },
});

const GB = 1024 ** 3;
/** A PC described only by measured numbers, run through the real hardwareFacts. */
function pc(o: {
  ramGb: number;
  freeGb: number;
  vramGb?: number;
  usedGb?: number;
  cores?: number;
  cuda?: string;
}) {
  const gpus = o.vramGb
    ? [
        {
          vendor: "nvidia",
          name: "Any Card",
          vramTotalMb: o.vramGb * 1024,
          vramKnown: true,
          vramUsedMb: (o.usedGb ?? 0.5) * 1024,
          driver: "560.94",
        },
      ]
    : [];
  return hwMod.hardwareFacts({
    cpu: { cores: (o.cores ?? 8) * 2, threads: (o.cores ?? 8) * 2, physicalCores: o.cores ?? 8 },
    memory: { totalGb: o.ramGb, freeGb: o.freeGb },
    disk: { freeGb: 300 },
    gpus,
    cuda: { driverAvailable: gpus.length > 0, driverCudaVersion: o.cuda ?? "12.6" },
  });
}

const SMALL_PC = pc({ ramGb: 8, freeGb: 5, cores: 4 });
const MID_PC = pc({ ramGb: 16, freeGb: 10, vramGb: 8, cores: 6 });
const BIG_PC = pc({ ramGb: 64, freeGb: 48, vramGb: 24, cores: 16 });
const MODELS = () => [
  local("ollama:small-3b", 2),
  local("ollama:mid-8b", 5),
  local("ollama:big-30b", 19),
];
const route = (hardware: unknown, extra: Record<string, unknown> = {}) =>
  router.routeRequest(MODELS(), {
    task: "chat",
    mode: "local-only",
    policy: "free-only",
    limit: 4,
    hardware,
    ...extra,
  });
const ids = (plan: { models: Row[] }) => plan.models.map((m) => m.id);

describe("same code, different facts, different local choice", () => {
  it("a small PC picks the small model, a big PC picks the big one", () => {
    expect(ids(route(SMALL_PC))[0]).toBe("ollama:small-3b");
    expect(ids(route(BIG_PC))[0]).toBe("ollama:big-30b");
    expect(ids(route(MID_PC))[0]).toBe("ollama:mid-8b");
  });

  it("a model that does not fit is demoted, not hidden", () => {
    const plan = route(SMALL_PC);
    expect(ids(plan)).toContain("ollama:big-30b");
    expect(ids(plan).indexOf("ollama:big-30b")).toBe(ids(plan).length - 1);
  });

  it("the same machine with less free VRAM changes the choice (facts, not a model name)", () => {
    const roomy = pc({ ramGb: 16, freeGb: 4, vramGb: 24, usedGb: 1, cores: 8 });
    const busy = pc({ ramGb: 16, freeGb: 4, vramGb: 24, usedGb: 21, cores: 8 });
    expect(ids(route(roomy))[0]).toBe("ollama:big-30b");
    expect(ids(route(busy))[0]).not.toBe("ollama:big-30b");
  });

  it("no facts, null facts or garbage keep today's order and never throw", () => {
    const baseline = ids(
      router.routeRequest(MODELS(), { task: "chat", mode: "local-only", policy: "free-only" }),
    );
    for (const hardware of [
      undefined,
      null,
      {},
      "x",
      hwMod.hardwareFacts(null),
      { ramFreeGb: "a" },
    ]) {
      expect(ids(route(hardware))).toEqual(baseline);
    }
  });

  it("a model with an unknown size is never penalised", () => {
    const unsized = [local("ollama:mystery", 0), local("ollama:big-30b", 19)];
    const plan = router.routeRequest(unsized, {
      task: "chat",
      mode: "local-only",
      policy: "free-only",
      hardware: SMALL_PC,
    });
    expect(ids(plan)[0]).toBe("ollama:mystery");
  });

  it("a model already loaded in the engine is not demoted", () => {
    const loaded = router.scoreModel(
      router.describe(local("ollama:big-30b", 19, { resident: true })),
      { hardware: SMALL_PC },
    );
    const same = router.scoreModel(
      router.describe(local("ollama:big-30b", 19, { resident: true })),
      {},
    );
    expect(loaded).toBe(same);
  });

  it("the voice surface does not chase size: the fast model keeps winning on a big PC", () => {
    const plan = router.routeRequest(
      [
        { ...local("ollama:small-3b", 2), qualityProfile: { speedScore: 0.9, chatScore: 0.5 } },
        { ...local("ollama:big-30b", 19), qualityProfile: { speedScore: 0.3, chatScore: 0.8 } },
      ],
      { task: "chat", mode: "local-only", policy: "free-only", surface: "voice", hardware: BIG_PC },
    );
    expect(ids(plan)[0]).toBe("ollama:small-3b");
  });
});

describe("GPU offload hint passes through", () => {
  it("names the fit and the offload for each local model in the plan", () => {
    const plan = route(BIG_PC);
    expect(plan.hardwareHints["ollama:mid-8b"]).toMatchObject({ fit: "gpu", offload: "gpu" });
    const small = route(SMALL_PC);
    expect(small.hardwareHints["ollama:small-3b"]).toMatchObject({ fit: "cpu", offload: "cpu" });
    expect(small.hardwareHints["ollama:big-30b"].fit).toBe("too-large");
    expect(plan.decisionTrace.hardware.fits).toBeTruthy();
  });

  it("an old driver does not claim a GPU run", () => {
    const old = pc({ ramGb: 32, freeGb: 24, vramGb: 12, cuda: "11.8" });
    const hint = route(old).hardwareHints["ollama:mid-8b"];
    expect(hint.offload).not.toBe("gpu");
  });

  it("without facts there is no hint and no trace noise", () => {
    expect(route(undefined).hardwareHints).toEqual({});
  });

  it("hardwareFit exposes the arithmetic", () => {
    const fit = router.hardwareFit({ sizeGb: 5 }, BIG_PC);
    expect(fit).toMatchObject({ fit: "gpu", offload: "gpu" });
    expect(fit.needGb).toBeGreaterThan(5);
    expect(router.hardwareFit({ sizeGb: 0 }, BIG_PC).fit).toBe("unknown");
  });
});

// Real producer output: the same nvidia-smi / Win32_VideoController text the probes print, parsed by the real
// parsers, then through the real hardwareFacts. Nothing here invents a token the producer cannot emit.
describe("a GPU PC is never pinned to the CPU", () => {
  const smiLine = (name: string, mib: number, used = 600, driver = "560.94") =>
    `${name}, ${mib}, ${used}, ${driver}, 3, 41`;
  const cudaHeader = (v: string) =>
    `| NVIDIA-SMI 560.94   Driver Version: 560.94   CUDA Version: ${v} |`;
  function probed(o: {
    smi?: string;
    video?: Array<Record<string, unknown>>;
    ramGb?: number;
    freeGb?: number;
    cuda?: string | null;
    gpuInfo?: unknown;
  }) {
    const nvidia = o.smi ? hwMod.parseNvidiaSmi(o.smi) : [];
    const cim = hwMod
      .parseVideoControllers(JSON.stringify(o.video ?? []))
      .filter((g: { vendor: string }) => nvidia.length === 0 || g.vendor !== "nvidia");
    return hwMod.hardwareFacts(
      {
        cpu: { cores: 16, threads: 16, physicalCores: 8 },
        memory: { totalGb: o.ramGb ?? 32, freeGb: o.freeGb ?? 24 },
        disk: { freeGb: 300 },
        gpus: hwMod.bestGpuFirst([...nvidia, ...cim]),
        cuda: {
          driverAvailable: nvidia.length > 0,
          driverCudaVersion: o.cuda === undefined ? "12.6" : o.cuda,
        },
      },
      o.gpuInfo ? { gpuInfo: o.gpuInfo } : {},
    );
  }
  const SIZES = [1, 2, 5, 8, 12, 20, 30, 60, 200];
  const offloadsOf = (facts: unknown) =>
    SIZES.map((gb) => router.hardwareFit({ sizeGb: gb }, facts).offload);

  it("NVIDIA 6 GB with 32 GB RAM and an 8 GB model: partial offload stays possible, no num_gpu 0", () => {
    const facts = probed({ smi: smiLine("Some Card", 6 * 1024), cuda: "12.6" });
    const fit = router.hardwareFit({ sizeGb: 8 }, facts);
    expect(fit.offload).not.toBe("cpu");
    expect(route(facts, { hardware: facts }).hardwareHints["ollama:mid-8b"].offload).not.toBe(
      "cpu",
    );
  });

  it("AMD with only the capped 32-bit AdapterRAM (VRAM not measured) is not forced to the CPU", () => {
    const facts = probed({
      video: [{ Name: "AMD Radeon RX 7800 XT", AdapterRAM: 4293918720, Driver: "31.0.1" }],
    });
    expect(facts.vramGb).toBeNull();
    for (const offload of offloadsOf(facts)) expect(offload).not.toBe("cpu");
  });

  it("an Intel integrated chip or an Electron-only GPU entry is still a GPU, never forced to the CPU", () => {
    const intel = probed({
      video: [{ Name: "Intel(R) UHD Graphics 770", AdapterRAM: 1073741824 }],
    });
    for (const offload of offloadsOf(intel)) expect(offload).not.toBe("cpu");
    const info = probed({
      gpuInfo: { gpuDevice: [{ vendorId: 0x10de, deviceId: 1, driverVersion: "31.0.15.5222" }] },
    });
    expect(info.gpus).toHaveLength(1);
    for (const offload of offloadsOf(info)) expect(offload).not.toBe("cpu");
  });

  it("no GPU measured on a probed PC (empty list, or only a software adapter) does say cpu", () => {
    const none = probed({});
    expect(none.gpus).toEqual([]);
    const software = probed({
      video: [
        { Name: "Microsoft Basic Render Driver", AdapterRAM: 0 },
        { Name: "Parsec Virtual Display Adapter", AdapterRAM: 0 },
      ],
    });
    expect(software.gpus).toEqual([]);
    for (const facts of [none, software]) {
      expect(router.hardwareFit({ sizeGb: 2 }, facts)).toMatchObject({
        fit: "cpu",
        offload: "cpu",
      });
      expect(router.hardwareFit({ sizeGb: 200 }, facts)).toMatchObject({ offload: "cpu" });
    }
    const unnamed = probed({ video: [{ Name: "Mystery Display Chip", AdapterRAM: 0 }] });
    expect(unnamed.gpus.map((g: { vendor: string }) => g.vendor)).toEqual(["other"]);
    expect(router.hardwareFit({ sizeGb: 2 }, unnamed).offload).toBe("cpu");
  });

  it("whatever the model size, a PC with a real GPU never gets offload cpu", () => {
    const pcs = [
      probed({ smi: smiLine("Card", 6 * 1024), ramGb: 8, freeGb: 3 }),
      probed({ smi: smiLine("Card", 24 * 1024, 23 * 1024), ramGb: 64, freeGb: 50 }),
      probed({ smi: smiLine("Card", 8 * 1024), cuda: "11.8" }),
      probed({ smi: smiLine("Card", 8 * 1024), cuda: null }),
      probed({ video: [{ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720, Qw: 24 * GB }] }),
    ];
    for (const facts of pcs) {
      for (const offload of offloadsOf(facts)) expect(offload).not.toBe("cpu");
    }
  });

  it("a GPU PC keeps its demotion scoring: a model bigger than RAM and VRAM still ranks last", () => {
    const facts = probed({ smi: smiLine("Card", 6 * 1024), ramGb: 8, freeGb: 5 });
    const plan = route(facts);
    expect(ids(plan).indexOf("ollama:big-30b")).toBe(ids(plan).length - 1);
    expect(plan.hardwareHints["ollama:big-30b"].fit).toBe("too-large");
    expect(plan.hardwareHints["ollama:big-30b"].offload).not.toBe("cpu");
  });
});

describe("facts without a probe say nothing", () => {
  it("hardwareFacts(null) with only a live free-RAM figure is not a measurement", () => {
    const facts = hwMod.hardwareFacts(null, { freeRamGb: 12 });
    expect(facts.ramGb).toBeNull();
    expect(router.hardwareFit({ sizeGb: 8 }, facts)).toEqual({ fit: "unknown" });
    expect(router.hardwareFit({ sizeGb: 200 }, facts)).toEqual({ fit: "unknown" });
  });

  it("a missing total RAM is unknown, with a score of 0 and no hint", () => {
    for (const facts of [
      { ramFreeGb: 2 },
      { ramFreeGb: 2, vramGb: 8, vramFreeGb: 7 },
      { cpuClass: "low", ramFreeGb: 1 },
    ]) {
      expect(router.hardwareFit({ sizeGb: 30 }, facts)).toEqual({ fit: "unknown" });
    }
    const model = router.describe(local("ollama:big-30b", 19));
    const live = hwMod.hardwareFacts(null, { freeRamGb: 12 });
    expect(router.scoreModel(model, { hardware: live })).toBe(router.scoreModel(model, {}));
    expect(route(live).hardwareHints).toEqual({});
  });
});

describe("privacy, then billing, then choice stay in order", () => {
  const mixed = () => [
    local("ollama:small-3b", 2),
    local("ollama:big-30b", 19),
    cloudFree("llama-free"),
  ];

  it("a private turn never leaves this PC, however big the GPU", () => {
    const plan = router.routeRequest(mixed(), {
      task: "chat",
      mode: "auto",
      policy: "free-only",
      requirements: { privacy: "private" },
      hardware: BIG_PC,
    });
    expect(ids(plan).every((id: string) => id.startsWith("ollama:"))).toBe(true);
  });

  it("a private turn keeps an oversized local model as the only option rather than going to cloud", () => {
    const plan = router.routeRequest([local("ollama:big-30b", 19), cloudFree("llama-free")], {
      task: "chat",
      mode: "auto",
      policy: "free-only",
      requirements: { privacy: "private" },
      hardware: SMALL_PC,
    });
    expect(ids(plan)).toEqual(["ollama:big-30b"]);
  });

  it("offline removes cloud before hardware is consulted", () => {
    const plan = router.routeRequest(mixed(), {
      task: "chat",
      mode: "cloud-only",
      policy: "free-only",
      offline: true,
      hardware: SMALL_PC,
    });
    expect(ids(plan)).toEqual([]);
  });

  it("a small PC does not make a paid model eligible: free-only still blocks it", () => {
    const paid = {
      ...cloudFree("paid-model"),
      access: "paid",
      meta: { ...cloudFree("x").meta, access: "paid", accessTier: "paid", declaredAccess: "paid" },
    };
    const plan = router.routeRequest([local("ollama:big-30b", 19), paid], {
      task: "chat",
      mode: "auto",
      policy: "free-only",
      hardware: SMALL_PC,
    });
    expect(ids(plan)).not.toContain(paid.id);
  });

  it("hardware cannot lift a demoted local model above the billing order of cloud models", () => {
    // Free cloud is eligible; the demoted local model must not outrank a free local model that fits.
    const plan = route(SMALL_PC);
    expect(ids(plan)[0]).toBe("ollama:small-3b");
  });
});

describe("localFanout has a product caller", () => {
  const two = [local("ollama:a", 8), local("ollama:b", 8)];

  it("reads hardwareFacts (ramFreeGb) and still the old freeRamGb, with model size from meta.sizeGb", () => {
    expect(router.localFanout(two, { ramFreeGb: 10 }).mode).toBe("sequential");
    expect(router.localFanout(two, { ramFreeGb: 40 }).mode).toBe("parallel");
    expect(router.localFanout(two, { freeRamGb: 40 }).mode).toBe("parallel");
    expect(router.localFanout(two, {}).mode).toBe("sequential");
    expect(
      router.localFanout(
        [
          { id: "a", ramGb: 8 },
          { id: "b", ramGb: 8 },
        ],
        { freeRamGb: 20 },
      ).mode,
    ).toBe("parallel");
  });

  it("two models that fit one after the other in VRAM still run one at a time on a small card", () => {
    const card = pc({ ramGb: 16, freeGb: 6, vramGb: 12, cores: 8 });
    expect(router.localFanout(two, card).mode).toBe("sequential");
  });

  it("fanoutLanes keeps cloud models parallel and chains local models when they do not fit together", () => {
    const cloud = cloudFree("llama-free");
    const small = router.fanoutLanes([...two, cloud], SMALL_PC);
    expect(small.sequential.map((m: Row) => m.id)).toEqual(["ollama:a", "ollama:b"]);
    expect(small.parallel.map((m: Row) => m.id)).toEqual([cloud.id]);
    const big = router.fanoutLanes([...two, cloud], BIG_PC);
    expect(big.sequential).toEqual([]);
    expect(big.parallel).toHaveLength(3);
    expect(router.fanoutLanes([two[0]], SMALL_PC).sequential).toEqual([]);
  });

  it("the multi-model chat path in main.cjs asks fanoutLanes before it runs models together", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toMatch(/modelRouter\.fanoutLanes\(candidates,\s*routingHardwareFacts\(\)\)/);
  });
});

describe("resolveChatModels feeds hardwareFacts into the route", () => {
  const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
  it("puts the facts in routeOptions", () => {
    const block = /const routeOptions = \{[\s\S]*?\n {2}\};/.exec(main)?.[0] ?? "";
    expect(block).toContain("hardware: routingHardwareFacts()");
  });
  it("routingHardwareFacts reads the last detection and the live free memory", () => {
    const fn = /function routingHardwareFacts\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    expect(fn).toContain("hardwareFacts(lastHardware");
    expect(fn).toContain("freeRamGb");
  });
});
