/**
 * Setup, Doctor and the build are hardware-first: the measured facts of this PC become one plan
 * (electron/setup-plan.cjs), setup prints it before it downloads, the model step follows it (the chat model tier, the
 * speech sizes, llama.cpp, the CUDA libraries) and the Doctor reads the same required set. Injected facts, a fake
 * Ollama and a fake downloader only: no hardware, no network, nothing on a real Windows PC.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));
const plans = require_(path.join(root, "electron/setup-plan.cjs"));
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

type Facts = Record<string, any>;
const facts = (ramGb: number, ramFreeGb: number, extra: Facts = {}): Facts => ({
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
  vulkan: false,
  cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
  network: { online: true, metered: false },
  power: { batteryPresent: false, onAc: true },
  health: { level: "ok", reasons: [] },
  ...extra,
});
const probe = (ramGb: number, freeGb: number) => ({
  totalRamGb: ramGb,
  freeRamGb: freeGb,
  cpuThreads: 8,
  gpu: { name: "", vramGb: 0, source: "test", cudaRuntimeReady: false },
});

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-hw-first-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quiet = {
  FRIDAY_PREFETCH: "1",
  FRIDAY_PREFETCH_MOONSHINE: "0",
  FRIDAY_PREFETCH_CHAT: "0",
  FRIDAY_PREFETCH_LLAMACPP: "0",
  FRIDAY_AUTO_INSTALL: "1",
  FRIDAY_MODEL_FRESHNESS: "0",
  FRIDAY_SETUP_UPDATE: "0",
  CI: "",
  GITHUB_ACTIONS: "",
};

/** One prefetch run on Windows with a fake Ollama that already holds `held`; returns what was pulled and said. */
async function run(
  f: Facts,
  held: string[] = [],
  env: Record<string, string> = {},
  pull: (tag: string) => { ok: boolean; error?: string } = () => ({ ok: true }),
) {
  const dir = temp();
  const pulled: string[] = [];
  const lines: string[] = [];
  const fetched: string[] = [];
  const rows = await prefetch.prefetch(dir, {
    env: { ...quiet, ...env },
    platform: "win32",
    log: (line: string) => lines.push(line),
    facts: f,
    probe: probe(Number(f["ramGb"]), Number(f["ramFreeGb"])),
    totalGb: Number(f["ramGb"]),
    board: null,
    latest: async () => null,
    download: async (job: { modelId: string }) => {
      fetched.push(job.modelId);
      return { ok: true, bytes: 1, source: "test" };
    },
    ollama: {
      find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
      fetch: async () => ({
        ok: true,
        json: async () => ({ models: held.map((name) => ({ name })) }),
      }),
      pull: async (tag: string) => {
        pulled.push(tag);
        return pull(tag);
      },
      answers: async () => ({ ok: true }),
    },
  });
  return { rows, pulled, lines, fetched, text: lines.join("\n") };
}

describe("setup prints this PC's plan before it downloads", () => {
  it("the block comes first, then the first download", async () => {
    const r = await run(facts(8, 5));
    const first = r.lines.findIndex((l) => l.includes("this PC:"));
    const download = r.lines.findIndex((l) => /fetching |ok +smart-turn|ok +silero/.test(l));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(first);
    expect(r.text).toMatch(/chat model: pull qwen3\.5:2b/);
    expect(r.text).toMatch(/CUDA libraries: skip/);
    expect(r.text).not.toMatch(/Step \d of 9/);
  });

  it("is not printed again when setup already printed it (FRIDAY_PLAN_PRINTED) or on a retry round", async () => {
    const once = await run(facts(8, 5), [], { FRIDAY_PLAN_PRINTED: "1" });
    expect(once.text).not.toContain("this PC:");
    expect(once.text).toContain("voice profile"); // the voice detail lines still come
  });

  it("--plan prints the block and --plan --json prints the marker line the Doctor reads", () => {
    const text = spawnSync(
      process.execPath,
      [path.join(root, "scripts/prefetch-models.cjs"), "--plan"],
      {
        encoding: "utf8",
        timeout: 120000,
      },
    );
    expect(text.stdout).toContain("this PC:");
    expect(text.stdout).not.toContain("FRIDAY_SETUP_PLAN_JSON");
    const json = spawnSync(
      process.execPath,
      [path.join(root, "scripts/prefetch-models.cjs"), "--plan", "--json"],
      { encoding: "utf8", timeout: 120000 },
    );
    const line = json.stdout.split("\n").find((l: string) => l.startsWith(prefetch.PLAN_JSON));
    const data = JSON.parse(String(line).slice(prefetch.PLAN_JSON.length));
    expect(Array.isArray(data.required)).toBe(true);
    expect(data.pc).toBeTruthy();
  }, 130_000);

  it("readPlanSync returns the data, and null for a failed, garbled or unmarked answer", () => {
    const good = `noise\n${prefetch.PLAN_JSON}${JSON.stringify({ required: [{ id: "x" }], skipped: [] })}\n`;
    const spawn =
      (out: string, status = 0) =>
      () => ({ status, stdout: out });
    expect(prefetch.readPlanSync({}, { spawnSync: spawn(good) }).required[0].id).toBe("x");
    expect(prefetch.readPlanSync({}, { spawnSync: spawn(good, 1) })).toBeNull();
    expect(prefetch.readPlanSync({}, { spawnSync: spawn("no marker") })).toBeNull();
    expect(
      prefetch.readPlanSync({}, { spawnSync: spawn(`${prefetch.PLAN_JSON}{oops`) }),
    ).toBeNull();
    expect(prefetch.readPlanSync({}, { spawnSync: () => ({ error: new Error("x") }) })).toBeNull();
  });
});

describe("the chat model follows the plan, not a fixed model", () => {
  it("pulls the tier tag for this PC and never the fixed qwen3:4b", async () => {
    const r = await run(facts(8, 5));
    expect(r.pulled).toEqual(["qwen3.5:2b"]);
    expect(r.fetched).not.toContain("qwen3-4b");
    expect(prefetch.failureReport(r.rows)).toEqual([]);
    expect(r.text).toMatch(/Ollama settings for qwen3\.5:2b: context 8192/);
  });

  it("a bigger PC pulls a bigger tier", async () => {
    const small = await run(facts(8, 5));
    const big = await run(facts(32, 24));
    expect(big.pulled).toHaveLength(1);
    expect(big.pulled[0]).not.toBe(small.pulled[0]);
  });

  it("keeps an installed model that is at least as good: nothing is pulled and nothing is deleted", async () => {
    const r = await run(facts(8, 5), ["qwen3.5:2b"]);
    expect(r.pulled).toEqual([]);
    expect(r.text).toMatch(/qwen3\.5:2b is already installed and stays the chat model/);
    expect(r.text).toMatch(/nothing is pulled or deleted/);
    expect(prefetch.failureReport(r.rows)).toEqual([]);
  });

  it("offers a better model without pulling it, and keeps the installed one in use", async () => {
    const r = await run(facts(8, 5), ["qwen3:1.7b"]);
    expect(r.pulled).toEqual([]);
    expect(r.text).toMatch(/qwen3:1\.7b is already installed and stays the chat model/);
    expect(r.text).toMatch(/is a better fit for this PC; pull it from the Models page/);
    expect(prefetch.failureReport(r.rows)).toEqual([]);
  });

  it("defers the pull offline or on a metered line with a note, never a failure", async () => {
    for (const net of [
      { online: false, metered: false },
      { online: true, metered: true },
    ]) {
      const r = await run(facts(8, 5, { network: net }));
      expect(r.pulled).toEqual([]);
      expect(r.text).toMatch(/chat model qwen3\.5:2b is not pulled now: /);
      expect(prefetch.failureReport(r.rows)).toEqual([]);
    }
  });

  it("a PC with no room for any model says so and fails nothing", async () => {
    const r = await run(facts(3, 2));
    expect(r.pulled).toEqual([]);
    expect(r.text).toMatch(/no chat model is planned for this PC/);
    expect(prefetch.failureReport(r.rows)).toEqual([]);
  });

  it("a 4 GB PC is planned the floor model, whatever is free right now", async () => {
    for (const free of [1.5, 3]) {
      const r = await run(facts(4, free));
      expect(r.pulled).toEqual(["qwen3.5:0.8b"]);
      expect(prefetch.failureReport(r.rows)).toEqual([]);
    }
  });

  it("a pull that fails is a real failure for the plan's tag, and the light GGUF fallback only runs where it fits", async () => {
    const roomy = await run(facts(32, 24), [], { FRIDAY_PREFETCH_CHAT: "1" }, () => ({
      ok: false,
      error: "no route",
    }));
    expect(roomy.fetched).toContain("qwen3-4b");
    const tight = await run(facts(4, 3), [], { FRIDAY_PREFETCH_CHAT: "1" }, () => ({
      ok: false,
      error: "no route",
    }));
    expect(tight.fetched).not.toContain("qwen3-4b");
    expect(prefetch.failureReport(tight.rows).join("\n")).toContain("qwen3.5:0.8b: no route");
  });

  it("the light GGUF fallback gate reads the plan's total-based usable memory, not what is free right now", async () => {
    const fail = () => ({ ok: false, error: "no route" });
    const env = { FRIDAY_PREFETCH_CHAT: "1" };
    const busy = await run(facts(16, 1), [], env, fail);
    const idle = await run(facts(16, 12), [], env, fail);
    // The same PC with a busy or an idle memory gets the same answer: the plan is total-based.
    expect(busy.fetched.includes("qwen3-4b")).toBe(idle.fetched.includes("qwen3-4b"));
    expect(idle.fetched).toContain("qwen3-4b");
    const src = read("scripts/prefetch-models.cjs");
    expect(src).toMatch(
      /planned\.action === "pull" && Number\(planned\.memory\?\.usableGb\) >= ggufNeedGb/,
    );
  });

  it("re-reads what Ollama holds once it answers, so a model it already has is never pulled over", async () => {
    // The plan was made while Ollama was not running (no models known); Ollama then reports one at least as good.
    const dir = temp();
    const pulled: string[] = [];
    const lines: string[] = [];
    const f = facts(8, 5);
    const first = plans.buildSetupPlan(f, { root: dir, installedModels: [] });
    expect(first.chat.action).toBe("pull");
    const again = (list: unknown) =>
      plans.buildSetupPlan(f, { root: dir, installedModels: list }).chat;
    await prefetch.ensureOllama(dir, null, {
      log: (l: string) => lines.push(l),
      deps: {
        chat: first.chat,
        rechat: again,
        fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen3.5:2b" }] }) }),
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
        skipAnswerCheck: true,
      },
    });
    expect(pulled).toEqual([]);
    expect(lines.join("\n")).toMatch(/chat model: keep qwen3\.5:2b/);
  });
});

describe("speech sizes and packages come from the same plan the Doctor reads", () => {
  it("no memory threshold is hard-coded in the prefetch step any more", () => {
    const src = read("scripts/prefetch-models.cjs");
    expect(src).not.toMatch(/minRamGb:\s*(8|15)\b/);
    expect(src).not.toMatch(/STT_(LARGE|BIG|MAX)\.minRamGb/);
    expect(src).not.toMatch(/needs \$\{row\.minRamGb\} GB RAM/);
  });

  it("a size the plan carries is one job, not two, and a size it blocks is named with the plan's reason", () => {
    const dir = "C:/friday";
    const voice = require_(path.join(root, "electron/voice-weights.cjs"));
    const gpu = voice.voiceInstallPlan(
      dir,
      {
        totalRamGb: 32,
        freeRamGb: 24,
        cpuThreads: 8,
        gpu: { name: "card", vramGb: 12, vramFreeGb: 11, cudaRuntimeReady: true, source: "test" },
      },
      { exists: () => false, statfs: () => ({ bavail: 500 * 1024 ** 2, bsize: 1024 }) },
    );
    const jobs = prefetch.prefetchPlan(dir, { ...quiet }, "win32", { plan: gpu });
    const ids = jobs.map((j: { id: string }) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // no size is planned twice
    expect(ids).toContain("stt-large-v3-turbo");
    expect(
      jobs.find((j: { id: string }) => j.id === "stt-large-v3-turbo").optional,
    ).toBeUndefined();
    // medium is below the planned size and is not one of the plan's extras: named with the plan's reason, not fetched
    const mediumGpu = jobs.find((j: { id: string }) => j.id === "stt-medium");
    expect(mediumGpu.optional).toBe(true);
    expect(mediumGpu.skipReason).toMatch(/^not in this PC's voice plan/);
    // small stays beside the GPU-sized ear as the CPU companion, a kept extra whose failure is a note
    const smallGpu = jobs.find((j: { id: string }) => j.id === "stt-small");
    expect(smallGpu.optional).toBe(true);
    expect(smallGpu.skipReason).toBeUndefined();
    const cpu = voice.voiceInstallPlan(dir, probe(16, 10), {
      exists: () => false,
      statfs: () => ({ bavail: 500 * 1024 ** 2, bsize: 1024 }),
    });
    const cpuJobs = prefetch.prefetchPlan(dir, { ...quiet }, "win32", { plan: cpu });
    const medium = cpuJobs.find((j: { id: string }) => j.id === "stt-medium");
    expect(medium.skipReason).toBe(
      cpu.blocked.find((b: { size: string }) => b.size === "medium").reason,
    );
    // a speech size the plan does not list is a cheap extra: fetched, but its failure is a note
    const small = cpuJobs.find((j: { id: string }) => j.id === "stt-small");
    expect(small.optional).toBeUndefined();
    expect(cpuJobs.find((j: { id: string }) => j.id === "stt-tiny").optional).toBe(true);
  });

  it("llama.cpp follows the plan: the pinned CPU zip by default, never with FRIDAY_PREFETCH_LLAMACPP=0, and a GPU build only from the Install Manager", async () => {
    const job = (env: Record<string, string>, llama?: Record<string, unknown>) =>
      prefetch
        .prefetchPlan("C:/f", { ...quiet, ...env }, "win32", llama ? { llama } : {})
        .some((j: { id: string }) => j.id === "llamacpp-runtime");
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "" }, { action: "install" })).toBe(true);
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "" }, { action: "present" })).toBe(false);
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "" }, { action: "defer" })).toBe(false);
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "0" }, { action: "install" })).toBe(false);
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "" })).toBe(false); // no plan: still opt-in as before
    expect(job({ FRIDAY_PREFETCH_LLAMACPP: "1" })).toBe(true);
    const gpuPc = facts(32, 24, {
      vramGb: 12,
      vramFreeGb: 11,
      gpuVendor: "nvidia",
      gpus: [
        {
          vendor: "nvidia",
          name: "card",
          vramGb: 12,
          driver: "560.94",
          integrated: false,
          computeCap: 8.6,
        },
      ],
      cudaReady: true,
      vulkan: true,
      cuda: { driverCuda: "12.6", runtimeFilesFound: false },
    });
    const r = await run(gpuPc, ["qwen3.5:9b"], { FRIDAY_PREFETCH_LLAMACPP: "" });
    expect(r.text).toMatch(
      /pinned CPU build; the cuda build this PC qualifies for is installed from the Install Manager/,
    );
    expect(r.fetched).toContain("llamacpp");
  });

  it("the plan installs the CUDA libraries only for an NVIDIA card with CUDA 12; no card means none", () => {
    const withCard = plans.buildSetupPlan(
      facts(32, 24, {
        vramGb: 12,
        vramFreeGb: 11,
        gpus: [
          {
            vendor: "nvidia",
            name: "card",
            vramGb: 12,
            driver: "560.94",
            integrated: false,
            computeCap: 8.6,
          },
        ],
        cudaReady: true,
        cuda: { driverCuda: "12.6", runtimeFilesFound: false },
      }),
      { root: "C:/f", installedModels: [] },
    );
    expect(plans.toJSON(withCard).required.some((r: { id: string }) => r.id === "cuda-libs")).toBe(
      true,
    );
    const none = plans.buildSetupPlan(facts(32, 24), { root: "C:/f", installedModels: [] });
    expect(plans.toJSON(none).required.some((r: { id: string }) => r.id === "cuda-libs")).toBe(
      false,
    );
  });

  it("setup-python installs the CUDA libraries only when the plan says install (and keeps the old rule without a plan)", () => {
    const src = read("scripts/setup-python.cjs");
    const at = src.indexOf("function installGpuSpeechLibraries()");
    const body = src.slice(at, src.indexOf("installGpuSpeechLibraries();", at));
    // The plan is read once (thisPcPlan memoises readPlanSync) and shared with the GPU ONNX Runtime step.
    expect(src).toMatch(/function thisPcPlan\(\)[\s\S]{0,200}readPlanSync\(process\.env\)/);
    expect(body).toMatch(/thisPcPlan\(\)/);
    expect(body).toMatch(/libs\?\.action !== "install" && libs\?\.action !== "defer"/);
    expect(body.indexOf("thisPcPlan()")).toBeGreaterThan(body.indexOf("nvidia-smi"));
    expect(body.indexOf("thisPcPlan()")).toBeLessThan(body.indexOf("installWithMethods"));
  });
});

describe("the Doctor reads the same required set", () => {
  it("shows what this PC's plan skipped as skipped, never missing, and names the plan's facts", () => {
    const out = spawnSync(process.execPath, [path.join(root, "scripts/check-environment.cjs")], {
      encoding: "utf8",
      timeout: 170000,
      // A temp home: a Doctor run must never record this checkout as the FRIDAY home in the real registry.
      env: {
        ...process.env,
        FRIDAY_WORKSPACE_ROOT: mkdtempSync(path.join(tmpdir(), "friday-home-")),
        FRIDAY_PREFETCH: "1",
        CI: "",
        GITHUB_ACTIONS: "",
      },
    });
    const text = `${out.stdout}`;
    expect(text).toMatch(/PASS\s+Speech model: medium \(accurate\)\s+skipped on this PC: /);
    expect(text).toMatch(/PASS\s+Speech model: large-v3 \(most accurate\)\s+skipped on this PC: /);
    expect(text).not.toMatch(/MISSING\s+Speech model: medium/);
    expect(text).not.toMatch(/MISSING\s+Speech model: large-v3/);
  }, 180_000);

  it("is wired to the plan, the facts row and the required chat row in the source", () => {
    const src = read("scripts/check-environment.cjs");
    expect(src).toMatch(/readPlanSync\(process\.env\)/);
    expect(src).toMatch(/skipped on this PC: /);
    expect(src).toMatch(/compute \$\{known\(card\.computeCap\)\}, driver/);
    expect(src).toMatch(/Chat model in Ollama: \$\{chat\.id\}/);
    expect(src).toMatch(/row\.id === "cuda-libs"/);
    expect(src).not.toMatch(
      /prefetchModels\.OLLAMA_MODELS\)\s*\{\s*if \(model\.minRamGb && ramGb < model\.minRamGb\) continue;[\s\S]{0,40}planData/,
    );
  });

  it("chat-tiers.json is watched like the other config the Doctor opens", () => {
    const paths = require_(path.join(root, "electron/resource-paths.cjs"));
    expect(paths.WATCHED).toContain("chat-tiers.json");
    const row = paths.configHealth().find((r: { name: string }) => r.name === "chat-tiers.json");
    expect(row.degraded).toBe(false);
  });
});

describe("setup-windows.ps1 keeps its shape and prints the plan first", () => {
  const ps1 = readFileSync(path.join(root, "scripts/setup-windows.ps1"));
  const text = ps1.toString("latin1");
  it("stays 7-bit ASCII with CRLF line ends", () => {
    expect([...ps1].every((b) => b < 128)).toBe(true);
    const lf = (text.match(/\n/g) || []).length;
    const crlf = (text.match(/\r\n/g) || []).length;
    expect(crlf).toBe(lf);
  });
  it("still has nine numbered steps and the plan is printed ahead of the Python step, not as a new step", () => {
    expect(text).toContain("$script:StageTotal = 9");
    expect([...text.matchAll(/Write-Stage (\d) '/g)].map((m) => m[1])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    const plan = text.indexOf("scripts\\prefetch-models.cjs --plan");
    expect(plan).toBeGreaterThan(text.indexOf("Write-Stage 4 "));
    expect(plan).toBeLessThan(text.indexOf("scripts\\setup-python.cjs"));
    expect(text).toMatch(
      /--plan\r\n {2}if \(\$LASTEXITCODE -eq 0\) \{ \$env:FRIDAY_PLAN_PRINTED = '1' \}/,
    );
  });
});

describe("the build reuses the same steps", () => {
  it("runs setup-python and the environment check, so it downloads nothing the setup plan did not choose", () => {
    const src = read("scripts/build-pipeline.cjs");
    expect(src).toContain('runNode("scripts/setup-python.cjs", [], root)');
    expect(src).toContain('runNode("scripts/check-environment.cjs", ["--fix", "--summary"], root)');
    expect(src).not.toMatch(/nvidia-cublas|cudnn|FRIDAY_PREFETCH_LLAMACPP/);
  });
});
