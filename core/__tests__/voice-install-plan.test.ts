/**
 * Setup chooses the voice profile from the probe and fetches only what fits: the plan (what is on disk, what is
 * fetched, what is skipped and why), its place in the setup download list, and `--dry-run`. Fake hardware and a
 * fake downloader only: no network, no weights.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);

type Probe = {
  totalRamGb: number;
  freeRamGb: number;
  cpuThreads: number;
  gpu: { name: string; vramGb: number; source: string; cudaRuntimeReady: boolean };
};
type Item = {
  id: string;
  state: "on-disk" | "download" | "skipped";
  bytes: number;
  reason: string;
};
type Plan = {
  budget: { sttSize: string; allowedSizes: string[]; install: string[] };
  items: Item[];
  optional: string[];
  downloadBytes: number;
  lines: string[];
};
const weights = require_("../../electron/voice-weights.cjs") as {
  voiceInstallPlan: (root: string, probe: Probe, deps?: Record<string, unknown>) => Plan;
};
const prefetch = require_("../../scripts/prefetch-models.cjs") as {
  prefetchPlan: (
    root: string,
    env: Record<string, string>,
    platform: string,
    have?: Record<string, unknown>,
  ) => {
    id: string;
    kind: string;
    skipReason?: string;
    job: { modelId: string; sources: unknown[] };
  }[];
  prefetch: (
    root: string,
    options: Record<string, unknown>,
  ) => Promise<{ id: string; ok: boolean; skipped?: boolean }[]>;
};

const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plan-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const noGpu = { name: "", vramGb: 0, source: "none", cudaRuntimeReady: false };
const pc = (totalRamGb: number, freeRamGb: number, gpu = noGpu): Probe => ({
  totalRamGb,
  freeRamGb,
  cpuThreads: 8,
  gpu,
});
const plenty = {
  statfs: () => ({ bavail: 10 ** 12, bsize: 1 }),
  exists: (f: string) => fs.existsSync(f),
};
const stateOf = (plan: Plan, id: string) => plan.items.find((item) => item.id === id);

describe("the voice install plan on a 16 GB CPU-only PC", () => {
  it("fetches the primary ear, the helpers, the voice and the Hindi ear and punctuation, and nothing bigger", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    expect(plan.budget.sttSize).toBe("small");
    expect(plan.items.map((item) => item.id)).toEqual([
      "silero-vad",
      "smart-turn",
      "faster-whisper-small",
      "supertonic-3",
      "hindi-ear",
      "hindi-punct",
    ]);
    expect(plan.items.every((item) => item.state === "download")).toBe(true);
    expect(stateOf(plan, "hindi-ear")?.bytes).toBe(137680132);
    expect(plan.downloadBytes).toBe(plan.items.reduce((sum, item) => sum + item.bytes, 0));
    expect(plan.optional).toEqual(["hindi-light-tts", "hindi-fallback-ear", "hinglish-ear"]);
  });

  it("reports on-disk models as on disk, so a second run fetches nothing (idempotent)", () => {
    const root = temp();
    const small = path.join(root, "cache", "stt", "small");
    fs.mkdirSync(small, { recursive: true });
    fs.writeFileSync(path.join(small, "config.json"), "{}");
    fs.writeFileSync(path.join(small, "model.bin"), "x");
    const plan = weights.voiceInstallPlan(root, pc(16, 10), plenty);
    expect(stateOf(plan, "faster-whisper-small")).toMatchObject({ state: "on-disk" });
    expect(plan.downloadBytes).toBe(
      plan.items
        .filter((item) => item.state === "download")
        .reduce((sum, item) => sum + item.bytes, 0),
    );
  });

  it("prints honest lines: the profile, each model, the skipped big sizes with the reason", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    const text = plan.lines.join("\n");
    expect(text).toMatch(/voice profile: balanced/);
    expect(text).toMatch(/16 GB/);
    expect(text).toMatch(/faster-whisper-small/);
    expect(text).toMatch(/medium skipped: .*GPU/);
    expect(text).toMatch(/large-v3 skipped/);
    expect(plan.lines.every((line) => line.startsWith("[friday] "))).toBe(true);
  });
});

describe("what does not fit is skipped with the reason, never failed", () => {
  it("a PC with little RAM leaves the Hindi punctuation out and says so", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(6, 4), plenty);
    expect(plan.budget.sttSize).toBe("base");
    expect(plan.items.map((item) => item.id)).not.toContain("hindi-punct");
    expect(plan.items.map((item) => item.id)).toContain("hindi-ear");
  });

  it("a PC with almost no RAM skips the Hindi ear with a RAM reason", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(3, 1.2), plenty);
    const ear = stateOf(plan, "hindi-ear");
    expect(ear).toMatchObject({ state: "skipped" });
    expect(ear?.reason).toMatch(/not enough RAM/);
    expect(plan.lines.join("\n")).toMatch(/hindi-ear skipped: not enough RAM/);
  });

  it("a disk that cannot hold the optional models plus 30 percent skips them, and keeps the essentials", () => {
    const need = (id: string) =>
      stateOf(weights.voiceInstallPlan(temp(), pc(16, 10), plenty), id)!.bytes;
    const essentials = ["silero-vad", "smart-turn", "faster-whisper-small", "supertonic-3"].reduce(
      (sum, id) => sum + need(id),
      0,
    );
    const free = Math.ceil(essentials * 1.3) + 1000;
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), {
      ...plenty,
      statfs: () => ({ bavail: free, bsize: 1 }),
    });
    expect(stateOf(plan, "faster-whisper-small")?.state).toBe("download");
    expect(stateOf(plan, "supertonic-3")?.state).toBe("download");
    expect(stateOf(plan, "hindi-ear")).toMatchObject({ state: "skipped" });
    expect(stateOf(plan, "hindi-ear")?.reason).toMatch(/not enough disk space/);
  });
});

describe("setup uses the plan (prefetch-models.cjs)", () => {
  const env = {
    FRIDAY_PREFETCH: "1",
    FRIDAY_PREFETCH_CHAT: "0",
    FRIDAY_PREFETCH_OLLAMA: "0",
    // llama.cpp follows the PC's plan by default now and has its own tests; the stand-in downloader writes no zip.
    FRIDAY_PREFETCH_LLAMACPP: "0",
  };

  it("without a budget the list is exactly what it was", () => {
    const ids = prefetch.prefetchPlan("C:/f", env, "win32").map((job) => job.id);
    expect(ids).not.toContain("hindi-ear");
    expect(ids).toContain("stt-small");
  });

  it("with the 16 GB budget it adds the Hindi ear and punctuation from their pinned repositories, and marks the big sizes skipped", () => {
    const budget = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    const jobs = prefetch.prefetchPlan("C:/f", env, "win32", { plan: budget });
    const ear = jobs.find((job) => job.id === "hindi-ear")!;
    expect(ear.job.modelId).toBe("hindi-ear");
    expect(ear.job.sources).toEqual([
      {
        kind: "hf-repo",
        repo: "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx",
        label: "Hugging Face (FRIDAY Ear Hindi)",
      },
    ]);
    expect(jobs.find((job) => job.id === "hindi-punct")).toBeTruthy();
    for (const id of ["stt-medium", "stt-large-v3"]) {
      expect(jobs.find((job) => job.id === id)?.skipReason, id).toMatch(/GPU/);
    }
    expect(jobs.find((job) => job.id === "stt-small")?.skipReason).toBeUndefined();
  });

  it("a run downloads the planned models, skips the blocked ones with a line, and never downloads a big size", async () => {
    const root = temp();
    const fetched: string[] = [];
    const lines: string[] = [];
    const rows = await prefetch.prefetch(root, {
      env: { ...env, FRIDAY_PREFETCH_MOONSHINE: "0", FRIDAY_MODEL_FRESHNESS: "0" },
      log: (line: string) => lines.push(line),
      platform: "win32",
      totalGb: 16,
      board: null,
      probe: pc(16, 10),
      download: async (job: { modelId: string }) => {
        fetched.push(job.modelId);
        return { ok: true, bytes: 1, source: "test" };
      },
    });
    expect(rows.every((row) => row.ok)).toBe(true);
    // The plan's ear, its lite fallback and the rest of the plan; base is not part of this PC's plan.
    expect(fetched).toEqual(
      expect.arrayContaining(["small", "tiny", "hindi-ear", "hindi-punct", "supertonic-3"]),
    );
    expect(fetched).not.toContain("base");
    expect(fetched).not.toContain("medium");
    expect(fetched).not.toContain("large-v3");
    const text = lines.join("\n");
    expect(text).toMatch(/voice profile: balanced/);
    expect(text).toMatch(/stt-base skipped: not in this PC's voice plan/);
    expect(text).toMatch(/stt-medium skipped: /);
    expect(text).toMatch(/stt-large-v3 skipped: /);
  });

  it("a PC that cannot hold the Hindi ear skips it with a line and still succeeds", async () => {
    const fetched: string[] = [];
    const lines: string[] = [];
    const rows = await prefetch.prefetch(temp(), {
      env: { ...env, FRIDAY_PREFETCH_MOONSHINE: "0", FRIDAY_MODEL_FRESHNESS: "0" },
      log: (line: string) => lines.push(line),
      platform: "win32",
      totalGb: 3,
      board: null,
      probe: pc(3, 1.2),
      download: async (job: { modelId: string }) => {
        fetched.push(job.modelId);
        return { ok: true, bytes: 1, source: "test" };
      },
    });
    expect(rows.every((row) => row.ok)).toBe(true);
    expect(fetched).not.toContain("hindi-ear");
    expect(lines.join("\n")).toMatch(/hindi-ear skipped: not enough RAM/);
  });
});

describe("npm run voice:install -- --dry-run", () => {
  it("prints the plan from the probe and downloads nothing", () => {
    const root = temp();
    const run = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../scripts/prefetch-models.cjs"), "--voice", "--dry-run"],
      {
        env: { ...process.env, FRIDAY_WORKSPACE_ROOT: root, FRIDAY_PREFETCH: "1" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/voice profile: /);
    expect(run.stdout).toMatch(/faster-whisper-small will be fetched/);
    expect(run.stdout).toMatch(/dry run: nothing was downloaded/);
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
    expect(fs.existsSync(path.join(root, "cache", "stt"))).toBe(false);
  });
});

describe("the Doctor shows the plan and the folder rows (wiring that needs Python to run)", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../electron/voice-verify.cjs"),
    "utf8",
  );

  it("adds the voice budget row from the plan, the folder rows after the load probe, and a restore repair", () => {
    expect(source).toMatch(/voiceInstallPlan\([\s\S]*id: "voice-budget"/);
    expect(source).toMatch(/weights\.folderChecks\([\s\S]*adopt: true[\s\S]*loadFailed:/);
    expect(source).toMatch(/function restoreVoiceModel\(catalogId\)[\s\S]*\.restoreModel\(/);
    expect(source).toMatch(/restoreVoiceModel,/);
  });
});
