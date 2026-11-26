/**
 * Setup and Doctor for the streaming ear (FRIDAY Ears): the voice plan carries it only on a PC that can (not the lite
 * profile, not a low-end processor, its RAM inside the speech budget, the disk with headroom, never on a metered line,
 * on battery or under heavy load), reuses a verified copy already on disk, and fetches it from the pinned repository at
 * the pinned revision. It stays optional: a failed fetch is a NOTE naming the fallback (never FAIL or ACTION
 * REQUIRED, so setup still ends SETUP PASS with exit 0), the Doctor shows a planned-but-absent ear as missing but not
 * required, with the fallback named, and a plan-skipped one as skipped, never missing. Offline: injected facts, a fake disk, a temp folder; nothing is downloaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const repoRoot = path.join(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

type Item = {
  id: string;
  state: string;
  reason: string;
  bytes: number;
  optional?: boolean;
  fallback?: string;
};
type Plan = {
  items: Item[];
  streamEar: Item | null;
  streamEarBytes: number;
  downloadBytes: number;
  lines: string[];
  budget: { profile: string };
};
const weights = req("../../electron/voice-weights.cjs") as {
  STREAM_EAR_ID: string;
  STREAM_EAR_REPO: string;
  voiceInstallPlan: (root: string, probe: Record<string, unknown>, deps?: object) => Plan;
  manifestOf: (id: string) => { diskBytes: number; recommendedRamGb: number } | null;
};
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => { revision: string; files: Record<string, unknown> } | null;
  pinnedBytes: (pin: unknown) => number;
};
const prefetch = req("../../scripts/prefetch-models.cjs") as {
  prefetchPlan: (
    root: string,
    env: Record<string, string>,
    platform: string,
    have?: Record<string, unknown>,
  ) => {
    id: string;
    kind: string;
    optional?: boolean;
    fallback?: string;
    failureLine?: (result: object) => string;
    skipReason?: string;
    approxBytes?: number;
    job: { sources: { kind: string; repo?: string }[] };
  }[];
};
const plans = req("../../electron/setup-plan.cjs") as {
  buildSetupPlan: (
    facts: object,
    deps: object,
  ) => {
    voice: { planned: boolean; install: string[]; onDisk: string[]; downloadBytes: number };
    skipped: { id: string; reason: string }[];
  };
  toJSON: (plan: object) => {
    required: { id: string; kind: string; action?: string }[];
    skipped: { id: string; reason: string }[];
  };
};

const ID = "stream-ear-nemotron";
const REPO = "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8";
const made: string[] = [];
afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-streamear-setup-"));
  made.push(dir);
  return dir;
};
const noGpu = { name: "", vramGb: 0, source: "none", cudaRuntimeReady: false };
const pc = (totalRamGb: number, freeRamGb: number, extra: Record<string, unknown> = {}) => ({
  totalRamGb,
  freeRamGb,
  cpuThreads: 8,
  gpu: noGpu,
  ...extra,
});
const plenty = { statfs: () => ({ bavail: 10 ** 12, bsize: 1 }), exists: () => false };
const pinBytes = () => pins.pinnedBytes(pins.pinForRepo(REPO));

describe("the voice plan carries the streaming ear only on a PC that can", () => {
  it("plans it on a capable 16 GB PC, with the pinned bytes, outside the base download total", () => {
    expect(weights.STREAM_EAR_ID).toBe(ID);
    expect(weights.STREAM_EAR_REPO).toBe(REPO);
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    expect(plan.budget.profile).not.toBe("lite");
    expect(plan.streamEar).toMatchObject({ id: ID, state: "download", reason: "", optional: true });
    expect(plan.streamEar!.fallback).toMatch(/turn-by-turn ears/);
    expect(plan.streamEar!.bytes).toBe(pinBytes());
    expect(plan.streamEar!.bytes).toBeGreaterThan(700 * 1024 ** 2);
    expect(plan.streamEarBytes).toBe(pinBytes());
    expect(plan.downloadBytes).toBe(plan.items.reduce((sum, item) => sum + item.bytes, 0));
    expect(plan.items.map((item) => item.id)).not.toContain(ID);
    expect(plan.lines.join("\n")).toMatch(new RegExp(`${ID} will be fetched \\(\\d+ MB\\)`));
  });

  it("never plans it on the lite profile, a low-end processor or a small RAM budget, and says why", () => {
    const lite = weights.voiceInstallPlan(temp(), pc(6, 4), plenty);
    expect(lite.budget.profile).toBe("lite");
    expect(lite.streamEar).toMatchObject({ id: ID, state: "skipped" });
    expect(lite.streamEar!.reason).toMatch(/lite voice profile/);
    expect(lite.streamEarBytes).toBe(0);
    expect(lite.lines.join("\n")).toMatch(new RegExp(`${ID} skipped: the lite voice profile`));

    const weak = weights.voiceInstallPlan(temp(), pc(16, 10, { cpuClass: "low" }), plenty);
    expect(weak.streamEar).toMatchObject({ state: "skipped" });
    expect(weak.streamEar!.reason).toMatch(/lite voice profile|low-end processor/);

    const tiny = weights.voiceInstallPlan(temp(), pc(3, 1.2), plenty);
    expect(tiny.streamEar!.state).toBe("skipped");
    expect(tiny.streamEarBytes).toBe(0);
  });

  it("never plans it when the disk cannot hold it with headroom", () => {
    const facts = weights.manifestOf(ID)!;
    // Room for the base voice plan but not for the ear on top of it: the ear is decided last.
    const base = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    const free = Math.ceil((base.downloadBytes + 200 * 1024 ** 2) * 1.3);
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), {
      exists: () => false,
      statfs: () => ({ bavail: free, bsize: 1 }),
    });
    expect(facts.diskBytes).toBeGreaterThan(200 * 1024 ** 2);
    expect(plan.streamEar).toMatchObject({ state: "skipped" });
    expect(plan.streamEar!.reason).toMatch(/not enough disk space/);
    expect(plan.streamEarBytes).toBe(0);
  });

  it("never plans it while a big download must wait (metered, battery, heavy load)", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), {
      ...plenty,
      waitReason: "the connection is metered",
    });
    expect(plan.streamEar).toMatchObject({ state: "skipped" });
    expect(plan.streamEar!.reason).toMatch(/download waits: the connection is metered/);
  });

  it("reuses a verified copy on disk and never fetches it again, even on a PC that would not plan it", () => {
    const root = temp();
    const dir = path.join(root, "models", ID);
    const exists = (file: string) => file.startsWith(dir + path.sep);
    for (const probe of [pc(16, 10), pc(6, 4)]) {
      const plan = weights.voiceInstallPlan(root, probe, { ...plenty, exists });
      expect(plan.streamEar).toMatchObject({ state: "on-disk" });
      expect(plan.streamEarBytes).toBe(0);
      expect(plan.lines.join("\n")).toMatch(new RegExp(`${ID} already on disk .*reused`));
    }
    // One pinned file missing is not a verified copy.
    const partial = (file: string) => exists(file) && !file.endsWith("encoder.onnx");
    const plan = weights.voiceInstallPlan(root, pc(16, 10), { ...plenty, exists: partial });
    expect(plan.streamEar!.state).toBe("download");
  });
});

describe("prefetch fetches it from the pinned repository only when the plan says so", () => {
  it("adds one pinned hf-repo job for a planned ear and none for a skipped or absent one", () => {
    const root = temp();
    const planned = weights.voiceInstallPlan(root, pc(16, 10), plenty);
    const jobs = prefetch.prefetchPlan(root, {}, "win32", { plan: planned });
    const job = jobs.find((row) => row.id === ID)!;
    expect(job).toBeDefined();
    expect(job.kind).toBe("voice-model");
    // Optional like the two helpers: a failed fetch is a note naming the fallback.
    expect(job.optional).toBe(true);
    expect(job.fallback).toMatch(/turn-by-turn ears/);
    expect(typeof job.failureLine).toBe("function");
    expect(job.skipReason).toBeUndefined();
    expect(job.approxBytes).toBe(pinBytes());
    expect(job.job.sources).toEqual([expect.objectContaining({ kind: "hf-repo", repo: REPO })]);
    // The downloader checks each file of this repository against the pinned revision and SHA-256.
    const pin = pins.pinForRepo(REPO)!;
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.files)).toHaveLength(8);

    const lite = weights.voiceInstallPlan(root, pc(6, 4), plenty);
    expect(prefetch.prefetchPlan(root, {}, "win32", { plan: lite }).map((r) => r.id)).not.toContain(
      ID,
    );
    expect(prefetch.prefetchPlan(root, {}, "win32").map((r) => r.id)).not.toContain(ID);
  });
});

describe("the setup plan and the Doctor read the same decision", () => {
  const facts = (ramGb: number, ramFreeGb: number, extra: Record<string, unknown> = {}) => ({
    ramGb,
    ramFreeGb,
    diskFreeGb: 200,
    gpus: [],
    cudaReady: false,
    cpuClass: "mid",
    cpu: { avx2: true, logicalCores: 8, physicalCores: 4 },
    network: { online: true, metered: false },
    power: { batteryPresent: false, onAc: true },
    health: { level: "ok", reasons: [] },
    ...extra,
  });
  const deps = (root: string) => ({ root, installedModels: [], ...plenty });

  it("a capable PC plans it (the Doctor lists it, missing but optional, when absent) and counts its bytes", () => {
    const root = temp();
    const plan = plans.buildSetupPlan(facts(16, 10), deps(root));
    expect(plan.voice.install).toContain(ID);
    expect(plan.voice.downloadBytes).toBeGreaterThanOrEqual(pinBytes());
    const json = plans.toJSON(plan);
    expect(json.required).toContainEqual(
      expect.objectContaining({ id: ID, kind: "voice-model", action: "install" }),
    );
    expect(json.skipped.map((row) => row.id)).not.toContain(ID);
  });

  it("a metered line, a battery or a lite PC skips it with the reason, never as required", () => {
    const root = temp();
    for (const [extra, why] of [
      [{ network: { online: true, metered: true } }, /metered/],
      [{ power: { batteryPresent: true, onAc: false } }, /battery/],
      [{ health: { level: "critical", reasons: [] } }, /heavy load/],
    ] as const) {
      const json = plans.toJSON(plans.buildSetupPlan(facts(16, 10, extra), deps(root)));
      expect(json.required.map((row) => row.id)).not.toContain(ID);
      expect(json.skipped.find((row) => row.id === ID)?.reason).toMatch(why);
    }
    const lite = plans.toJSON(plans.buildSetupPlan(facts(6, 4), deps(root)));
    expect(lite.required.map((row) => row.id)).not.toContain(ID);
    expect(lite.skipped.find((row) => row.id === ID)?.reason).toMatch(/lite voice profile/);
  });

  it("the Doctor has a row for it: planned and absent is missing-optional with the fallback, plan-skipped is skipped", () => {
    const src = read("scripts/check-environment.cjs");
    expect(src).toMatch(/"stream-ear-nemotron": "Voice model: streaming ear/);
    // An optional planned row is never required (no MISSING verdict, no DOCTOR FAIL) but says missing and the fallback;
    // skipped rows are ok:true with "skipped on this PC".
    expect(src).toMatch(/required: planned && toolsRequired && !job\.optional/);
    expect(src).toMatch(
      /planned && job\.optional && job\.fallback\s*\?\s*`missing \(optional; \$\{job\.fallback\} stay in use until it is fetched\)`/,
    );
    expect(src).toMatch(/found: `skipped on this PC: \$\{reason\}`/);
    expect(src).toMatch(/c\.ok \? "PASS" : c\.required \? "MISSING" : "SKIPPED"/);
  });

  it("the synthetic plan the Doctor rebuilds from the required set yields the same job", () => {
    const root = temp();
    const json = plans.toJSON(plans.buildSetupPlan(facts(16, 10), deps(root)));
    const items = json.required
      .filter((row) => row.kind === "voice-model")
      .map((row) => ({ id: row.id, state: row.action === "present" ? "on-disk" : "download" }));
    const jobs = prefetch.prefetchPlan(root, { FRIDAY_PREFETCH: "1" }, "win32", {
      ollama: true,
      plan: { items, blocked: [] },
    });
    const job = jobs.find((row) => row.id === ID);
    expect(job?.optional).toBe(true);
    expect(job?.fallback).toMatch(/turn-by-turn ears/);
    expect(job?.skipReason).toBeUndefined();
  });
});

describe("a failed streaming-ear download never fails setup", () => {
  it("is a NOTE naming the fallback, leaves no ACTION REQUIRED report (exit 0, SETUP PASS shape), and the rest still fetches", async () => {
    const root = temp();
    const plan = weights.voiceInstallPlan(root, pc(16, 10), plenty);
    expect(plan.streamEar!.state).toBe("download");
    const lines: string[] = [];
    const asked: string[] = [];
    const rows = (await (
      prefetch as unknown as {
        prefetch: (
          root: string,
          options: object,
        ) => Promise<{ id: string; ok: boolean; optional?: boolean; error?: string }[]>;
      }
    ).prefetch(root, {
      platform: "linux",
      env: {
        FRIDAY_PREFETCH: "1",
        FRIDAY_PREFETCH_CHAT: "0",
        FRIDAY_PREFETCH_OLLAMA: "0",
        FRIDAY_PREFETCH_MOONSHINE: "0",
        FRIDAY_PREFETCH_STT_LARGE: "0",
        FRIDAY_PREFETCH_LLAMACPP: "0",
      },
      log: (line: string) => lines.push(line),
      thisPc: { plan: { llama: null }, voicePlan: plan },
      download: async (job: { modelId: string }) => {
        asked.push(job.modelId);
        return job.modelId === ID
          ? {
              ok: false,
              error: "HTTP 503",
              attempts: [{ source: "Hugging Face (pinned revision)", error: "HTTP 503" }],
            }
          : { ok: true };
      },
    })) as { id: string; ok: boolean; optional?: boolean; error?: string }[];
    expect(asked).toContain(ID);
    expect(rows.find((row) => row.id === ID)).toMatchObject({
      ok: false,
      optional: true,
      error: "HTTP 503",
    });
    const text = lines.join("\n");
    const note = lines.find((line) => line.includes(`${ID} did not download`)) || "";
    expect(note).toMatch(/NOTE/);
    expect(note).toContain("Hugging Face (pinned revision): HTTP 503");
    expect(note).toMatch(/optional, setup goes on and the turn-by-turn ears/);
    expect(text).not.toMatch(new RegExp(`FAIL\\s+${ID}`));
    // The step's exit code is 1 only when this report is non-empty (and strict): empty means exit 0 and SETUP PASS.
    const report = (
      prefetch as unknown as { failureReport: (rows: object[]) => string[] }
    ).failureReport(rows);
    expect(report.join("\n")).not.toContain(ID);
    expect(rows.filter((row) => !row.ok && !row.optional)).toEqual([]);
    expect(report).toEqual([]);
  });
});
