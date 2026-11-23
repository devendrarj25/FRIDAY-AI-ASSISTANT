import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs");
const rootDir = path.resolve(import.meta.dirname, "../..");
type Row = Record<string, unknown>;
type Probe = (
  cmd: string,
  args: string[],
  timeout: number,
) => Promise<{ ok: boolean; stdout?: string; error?: string }>;
const hw = require_("../../electron/hardware.cjs") as {
  parseNvidiaSmi: (text: string) => Row[];
  parseComputeCap: (value: unknown) => string | null;
  computeCapOf: (facts: unknown) => number | null;
  readNvidiaGpus: (exe: string, probe: Probe) => Promise<{ gpus: Row[]; error: string | null }>;
  hardwareFacts: (
    hw: unknown,
    deps?: Row,
  ) => { gpus: Array<Row & { computeCap: string | null }> } & Row;
};
const llama = require_("../../electron/llama-runtime.cjs") as {
  backendChain: (
    facts: unknown,
    options?: Row,
  ) => { chain: Array<{ backend: string }>; skipped: Array<{ backend: string; reason: string }> };
};
const fit = require_("../../electron/engine-fit.cjs") as {
  classify: (row: Row, facts: unknown) => { state: string; blockers?: unknown; reasons?: unknown };
};

// Realistic `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu,temperature.gpu,compute_cap
// --format=csv,noheader,nounits` lines.
const TURING = "NVIDIA GeForce RTX 2060, 6144, 812, 552.44, 3, 41, 7.5";
const AMPERE = "NVIDIA GeForce RTX 3060, 12288, 1024, 576.80, 5, 44, 8.6";
const PASCAL = "NVIDIA GeForce GTX 1060 6GB, 6144, 300, 472.12, 0, 38, 6.1";
const BLACKWELL = "NVIDIA GeForce RTX 5070, 12227, 900, 576.80, 2, 40, 12.0";
// An older driver (before 510) rejects the compute_cap field, so its output has the six original columns only.
const OLD_DRIVER = "NVIDIA GeForce GTX 1080, 8192, 200, 497.09, 0, 36";
const PASCAL_SMALL = "NVIDIA GeForce GTX 1050 Ti, 3072, 200, 576.80, 0, 36, 6.1";

describe("parseNvidiaSmi reads the compute capability column", () => {
  it("reads Turing 7.5, Ampere 8.6, Pascal 6.1 and a two-digit major as strings", () => {
    expect(hw.parseNvidiaSmi(TURING)[0]).toMatchObject({ vramTotalMb: 6144, computeCap: "7.5" });
    expect(hw.parseNvidiaSmi(AMPERE)[0]).toMatchObject({ computeCap: "8.6" });
    expect(hw.parseNvidiaSmi(PASCAL)[0]).toMatchObject({ computeCap: "6.1" });
    expect(hw.parseNvidiaSmi(BLACKWELL)[0]).toMatchObject({ computeCap: "12.0" });
  });

  it("keeps every card on a multi-GPU box with its own capability", () => {
    const rows = hw.parseNvidiaSmi(`${TURING}\r\n${PASCAL}\r\n`);
    expect(rows.map((r) => r["computeCap"])).toEqual(["7.5", "6.1"]);
  });

  it("an old driver (no compute_cap column) gives null and still reads everything else", () => {
    const row = hw.parseNvidiaSmi(OLD_DRIVER)[0]!;
    expect(row["computeCap"]).toBeNull();
    expect(row).toMatchObject({ vendor: "nvidia", vramTotalMb: 8192, driver: "497.09" });
  });

  it("garbage in the column is null, never an error and never a made-up number", () => {
    for (const bad of [
      "[N/A]",
      "[Not Supported]",
      "abc",
      "",
      "7.5.1",
      "-1",
      "0.0e1",
      "NaN",
      "7,5",
    ]) {
      const row = hw.parseNvidiaSmi(`NVIDIA Card, 8192, 100, 576.80, 1, 40, ${bad}`)[0];
      expect(row?.["computeCap"] ?? null, bad).toBeNull();
    }
    expect(() =>
      hw.parseNvidiaSmi("Failed to initialize NVML: Driver/library version mismatch"),
    ).not.toThrow();
    expect(hw.parseNvidiaSmi('Field "compute_cap" is not a valid field to query.')).toEqual([]);
  });

  it("parseComputeCap accepts a major.minor string or number and nothing else", () => {
    expect(hw.parseComputeCap("7.5")).toBe("7.5");
    expect(hw.parseComputeCap(8.6)).toBe("8.6");
    expect(hw.parseComputeCap(" 12.0 ")).toBe("12.0");
    for (const bad of [
      null,
      undefined,
      "",
      "8",
      8,
      "x.y",
      "7.",
      ".5",
      {},
      [],
      "7.5; rm -rf",
      "١٢.٣",
    ])
      expect(hw.parseComputeCap(bad), String(bad)).toBeNull();
  });
});

describe("readNvidiaGpus asks for compute_cap and retries without it on an old driver", () => {
  const ok = (stdout: string) => ({ ok: true, stdout });
  it("one query with compute_cap on a current driver", async () => {
    const calls: string[][] = [];
    const probe: Probe = async (_c, args) => {
      calls.push(args);
      return ok(TURING);
    };
    const out = await hw.readNvidiaGpus("nvidia-smi", probe);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(
      /--query-gpu=name,memory\.total,memory\.used,driver_version,utilization\.gpu,temperature\.gpu,compute_cap$/,
    );
    expect(out.gpus[0]).toMatchObject({ computeCap: "7.5", vramTotalMb: 6144 });
    expect(out.error).toBeNull();
  });

  it("a driver that rejects compute_cap fails the whole query: retry once without it, computeCap null", async () => {
    const calls: string[][] = [];
    const probe: Probe = async (_c, args) => {
      calls.push(args);
      return args[0]!.includes("compute_cap")
        ? { ok: false, error: 'Field "compute_cap" is not a valid field to query.' }
        : ok(OLD_DRIVER);
    };
    const out = await hw.readNvidiaGpus("nvidia-smi", probe);
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).not.toContain("compute_cap");
    expect(out.gpus).toHaveLength(1);
    expect(out.gpus[0]).toMatchObject({ computeCap: null, vramTotalMb: 8192 });
    expect(out.error).toBeNull();
  });

  it("both queries failing keeps the reason and no cards; a throwing probe is not an error either", async () => {
    const dead: Probe = async () => ({ ok: false, error: "NVML mismatch" });
    expect(await hw.readNvidiaGpus("nvidia-smi", dead)).toEqual({
      gpus: [],
      error: "NVML mismatch",
    });
    const throwing: Probe = async () => {
      throw new Error("spawn failed");
    };
    const out = await hw.readNvidiaGpus("nvidia-smi", throwing);
    expect(out.gpus).toEqual([]);
    expect(typeof out.error).toBe("string");
  });
});

describe("hardwareFacts carries gpus[].computeCap (additive)", () => {
  const machine = (smi: string) => ({
    memory: { totalGb: 32, freeGb: 20 },
    gpus: hw.parseNvidiaSmi(smi),
    cuda: { driverAvailable: true, driverCudaVersion: "12.9" },
  });

  it("every card has the key: a string like 7.5, or null", () => {
    const facts = hw.hardwareFacts(machine(`${TURING}\n${PASCAL}\n${OLD_DRIVER}`));
    expect(facts.gpus.map((g) => g.computeCap).sort()).toEqual(["6.1", "7.5", null].sort());
    for (const g of facts.gpus) expect(g).toHaveProperty("computeCap");
    // existing row keys are untouched
    for (const key of [
      "vendor",
      "name",
      "vramGb",
      "vramCapped",
      "driver",
      "driverDate",
      "integrated",
    ])
      expect(facts.gpus[0]).toHaveProperty(key);
  });

  it("a card with no capability, a hostile value or no gpus at all never throws", () => {
    for (const bad of [undefined, "7.5; drop", 99, {}, "[N/A]"]) {
      const facts = hw.hardwareFacts({
        gpus: [
          { vendor: "nvidia", name: "X", vramTotalMb: 8192, vramKnown: true, computeCap: bad },
        ],
      });
      expect(facts.gpus[0]!.computeCap, String(bad)).toBeNull();
    }
    expect(hw.hardwareFacts({}).gpus).toEqual([]);
    expect(hw.hardwareFacts(null).gpus).toEqual([]);
  });

  it("an Intel or AMD card never gets a CUDA capability", () => {
    const facts = hw.hardwareFacts({
      gpus: [
        { vendor: "intel", name: "UHD", vramTotalMb: 512, vramKnown: false, computeCap: "7.5" },
      ],
    });
    expect(facts.gpus[0]!.computeCap).toBeNull();
  });

  it("computeCapOf gives the best NVIDIA card's capability as a number", () => {
    const facts = hw.hardwareFacts(machine(`${PASCAL_SMALL}\n${TURING}`));
    expect(facts.gpus.map((g) => g.computeCap)).toEqual(["7.5", "6.1"]); // ranked: the larger card first
    expect(hw.computeCapOf(facts)).toBe(7.5);
    expect(hw.computeCapOf(hw.hardwareFacts(machine(OLD_DRIVER)))).toBeNull();
    expect(hw.computeCapOf(null)).toBeNull();
    expect(hw.computeCapOf({ gpus: "no" })).toBeNull();
  });
});

describe("the catalogue and the engine chain rule CUDA out below 7.5 before any install", () => {
  const facts = (smi: string) => ({
    ...hw.hardwareFacts({
      memory: { totalGb: 32, freeGb: 20 },
      gpus: hw.parseNvidiaSmi(smi),
      cuda: { driverAvailable: true, driverCudaVersion: "12.9" },
    }),
    cuda: { driverCuda: "12.9" },
    vulkan: true,
  });

  it("backendChain reads gpus[].computeCap from the facts: Pascal 6.1 is skipped, Turing 7.5 and Ampere 8.6 stay", () => {
    const pascal = llama.backendChain(facts(PASCAL));
    expect(pascal.chain.map((c) => c.backend)).not.toContain("cuda");
    expect(pascal.skipped.find((s) => s.backend === "cuda")?.reason).toMatch(/6\.1/);
    expect(llama.backendChain(facts(TURING)).chain.map((c) => c.backend)).toContain("cuda");
    expect(llama.backendChain(facts(AMPERE)).chain.map((c) => c.backend)).toContain("cuda");
  });

  it("an old driver (capability unknown) does not rule CUDA out: the health check after install decides", () => {
    expect(llama.backendChain(facts(OLD_DRIVER)).chain.map((c) => c.backend)).toContain("cuda");
  });

  it("engine-fit blocks a CUDA row for a 6.1 card straight from the facts", () => {
    const row = {
      requirements: { gpu: "nvidia", cudaMin: "12", computeCapMin: 7.5, diskBytes: 1 },
    };
    const verdict = fit.classify(row, facts(PASCAL));
    expect(verdict.state).toBe("unsupported");
    expect(JSON.stringify(verdict)).toContain("compute-too-old");
    expect(fit.classify(row, facts(TURING)).state).not.toBe("unsupported");
  });
});

describe("the Install Manager catalogue is wired to the facts' compute capability", () => {
  it("main.cjs's installer catalogue callback reads computeCapOf(routingHardwareFacts()), not a constant null", () => {
    const main = readFileSync(path.join(rootDir, "electron/main.cjs"), "utf8");
    const block = /createInstallerCatalog\(\{[\s\S]*?\n {2}\}\);/.exec(main)?.[0] ?? "";
    expect(block).toMatch(/computeCap:\s*\(\)\s*=>[^\n]*computeCapOf\(routingHardwareFacts\(\)\)/);
    expect(block).not.toMatch(/computeCap:\s*\(\)\s*=>\s*null/);
  });

  it("a catalogue row's engine chain skips CUDA for a 6.1 card whether or not the callback answers", () => {
    const cat = require_("../../electron/installer-catalog.cjs");
    const cardFacts = (smi: string) => ({
      ...hw.hardwareFacts({
        memory: { totalGb: 32, freeGb: 20 },
        gpus: hw.parseNvidiaSmi(smi),
        cuda: { driverAvailable: true, driverCudaVersion: "12.9" },
      }),
      cuda: { driverCuda: "12.9" },
      vulkan: true,
    });
    const chainOf = (smi: string, mode: "absent" | "null" | "facts") => {
      const facts = cardFacts(smi);
      const computeCap =
        mode === "absent" ? null : mode === "null" ? () => null : () => hw.computeCapOf(facts);
      const catalog = cat.createInstallerCatalog({
        root: () => "",
        facts: () => facts,
        tools: () => toolchain.TOOLS.filter((t: { id: string }) => t.id === "llama.cpp"),
        detected: () => ({ tools: [] }),
        packs: () => [],
        voice: () => [],
        runners: () => [],
        online: () => true,
        privacy: () => true,
        ...(computeCap ? { computeCap } : {}),
      });
      const found = catalog.snapshot().rows.find((r: { id: string }) => r.id === "llama.cpp");
      return found?.engine as {
        chain: string[];
        skipped: Array<{ backend: string; reason: string }>;
      };
    };
    for (const callback of ["absent", "null", "facts"] as const) {
      const old = chainOf(PASCAL, callback);
      expect(old.chain).not.toContain("cuda");
      expect(old.skipped.find((s) => s.backend === "cuda")?.reason).toMatch(/6\.1/);
      expect(chainOf(TURING, callback).chain).toContain("cuda");
    }
  });
});
