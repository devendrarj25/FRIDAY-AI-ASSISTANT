/**
 * Setup downloads: more than one road to the same bytes, the plan (not a list) deciding the extras, and a copy that is
 * already on disk and verified is used before anything is fetched. No network: the downloader, the release lookup and
 * Python are stand-ins.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const prefetch = req(path.join(root, "scripts/prefetch-models.cjs"));
const weights = req(path.join(root, "electron/voice-weights.cjs"));
const pins = req(path.join(root, "electron/voice-pins.cjs"));
const safety = req(path.join(root, "electron/download-safety.cjs"));
const hosts = JSON.parse(readFileSync(path.join(root, "config/download-hosts.json"), "utf8")) as {
  optInHosts: string[];
};
const runners = JSON.parse(readFileSync(path.join(root, "config/local-runners.json"), "utf8")) as {
  runners: Array<{ id: string; release?: { url: string; sha256: string; bytes: number } }>;
};

type Source = { kind: string; url?: string; repo?: string; sha256?: string; bytes?: number };
type Job = {
  id: string;
  kind: string;
  ready: string;
  optional?: boolean;
  skipReason?: string;
  job: { sources: Source[] };
};

const quiet = {
  CI: "",
  GITHUB_ACTIONS: "",
  FRIDAY_SETUP_UPDATE: "0",
  FRIDAY_PREFETCH_MOONSHINE: "0",
  FRIDAY_PREFETCH_LLAMACPP: "0",
  FRIDAY_PREFETCH: "1",
};
const plan = (env: Record<string, string> = {}, have: Record<string, unknown> = {}) =>
  prefetch.prefetchPlan("C:/friday", { ...quiet, ...env }, "win32", have) as Job[];
const find = (jobs: Job[], id: string) => jobs.find((row) => row.id === id) as Job;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
  delete process.env["FRIDAY_HF_MIRROR"];
});
const facts = {
  vramGb: null,
  vramFreeGb: null,
  ramGb: 16,
  ramFreeGb: 10,
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
};

const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-sources-"));
  temps.push(dir);
  return dir;
};

describe("a pinned helper gets the opt-in mirror as a last source, only when the owner allows it", () => {
  it("adds nothing without FRIDAY_HF_MIRROR=1", () => {
    const jobs = plan();
    // Hugging Face first, then the ModelScope road with the same SHA-256.
    expect(find(jobs, "smart-turn").job.sources).toHaveLength(2);
    expect(find(jobs, "silero-vad").job.sources).toHaveLength(2);
  });

  it("with FRIDAY_HF_MIRROR=1 every Hugging Face url gets the same file on the mirror, same revision, same SHA-256", () => {
    const off = plan();
    const on = plan({ FRIDAY_HF_MIRROR: "1" });
    for (const id of ["smart-turn", "silero-vad"]) {
      const before = find(off, id).job.sources;
      const after = find(on, id).job.sources;
      // The official sources keep their order; the mirror comes after them.
      expect(after.slice(0, before.length)).toEqual(before);
      const mirrors = after.slice(before.length);
      expect(mirrors).toHaveLength(1);
      const first = before[0] as Source;
      const mirror = mirrors[0] as Source;
      expect(mirror.url).toBe((first.url as string).replace("huggingface.co", "hf-mirror.com"));
      expect(mirror.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(mirror.sha256).toBe(first.sha256);
      expect(mirror.bytes).toBe(first.bytes);
    }
    // A GitHub release url has no mirror host: silero keeps exactly one extra source.
    expect(find(on, "silero-vad").job.sources).toHaveLength(3);
    expect(find(on, "smart-turn").job.sources).toHaveLength(3);
  });

  it("the mirror host is the opt-in host of config/download-hosts.json, and every planned url passes the allowlist", () => {
    expect(hosts.optInHosts).toContain(weights.HF_MIRROR_HOST);
    process.env["FRIDAY_HF_MIRROR"] = "1";
    const urls = plan({ FRIDAY_HF_MIRROR: "1" }).flatMap((row) =>
      row.job.sources.map((source) => source.url).filter(Boolean),
    ) as string[];
    expect(urls.some((url) => url.includes("hf-mirror.com"))).toBe(true);
    for (const url of urls) expect(() => safety.assertAllowedUrl(url), url).not.toThrow();
    // Without the setting the downloader refuses that host, so it is never planned.
    delete process.env["FRIDAY_HF_MIRROR"];
    expect(() => safety.assertAllowedUrl("https://hf-mirror.com/a/b/resolve/c/d")).toThrow();
  });

  it("withOptInMirrors leaves a non-Hugging-Face url, a branch url and an off switch alone", () => {
    const source = { kind: "url", url: "https://example.org/a.onnx", sha256: "a".repeat(64) };
    const branch = {
      kind: "url",
      url: "https://huggingface.co/x/y/resolve/main/a.onnx",
      sha256: "a".repeat(64),
    };
    const on = { FRIDAY_HF_MIRROR: "1" };
    expect(weights.withOptInMirrors([source, branch], on)).toEqual([source, branch]);
    expect(weights.withOptInMirrors([source], {})).toEqual([source]);
    expect(weights.withOptInMirrors([source], { FRIDAY_HF_MIRROR: "0" })).toEqual([source]);
  });
});

describe("the neural voice has a second official repository with the same bytes", () => {
  const MAIN = "Supertone/supertonic-3";
  const ARCHIVE = "supertone-oss-archive/supertonic-3";
  const ARCHIVE_REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";

  it("plans both repositories, the publisher's own first", () => {
    const tts = find(plan(), "supertonic-3");
    expect(tts.job.sources.map((source) => source.repo)).toEqual([MAIN, ARCHIVE]);
    expect(tts.job.sources.every((source) => source.kind === "hf-repo")).toBe(true);
  });

  it("the archive repository carries the very same file table at its own immutable revision", () => {
    const main = pins.pinForRepo(MAIN);
    const archive = pins.pinForRepo(ARCHIVE);
    expect(archive.revision).toBe(ARCHIVE_REVISION);
    expect(archive.revision).not.toBe(main.revision);
    expect(archive.files).toEqual(main.files);
    expect(Object.keys(archive.files).length).toBeGreaterThanOrEqual(17);
    // It is a second source of one model, not a second model: no new pinned repository, no new registry row.
    expect(pins.pinnedRepos()).not.toContain(ARCHIVE);
    expect(pins.manifestFor(ARCHIVE)?.repo ?? MAIN).toBe(MAIN);
  });

  it("a folder fetched from the archive is certified as the one model, so the pinned revision never swaps it out", () => {
    const dir = temp();
    const archive = pins.pinForRepo(ARCHIVE);
    pins.writeMarker(dir, ARCHIVE, archive);
    const marker = pins.readMarker(dir);
    expect(marker.repo).toBe(MAIN);
    expect(marker.revision).toBe(pins.pinForRepo(MAIN).revision);
    // The next run reads the publisher's pin, or the archive pin again: neither moves the folder aside.
    for (const repo of [MAIN, ARCHIVE]) {
      const swap = pins.beginRevisionSwap(dir, repo, pins.pinForRepo(repo));
      expect(swap.swapped, repo).toBe(false);
    }
  });
});

describe("Ollama's installer: the moving site url is used only with a digest that belongs to it", () => {
  const pin = runners.runners.find((row) => row.id === "ollama")?.release as {
    url: string;
    sha256: string;
    bytes: number;
  };
  const live = {
    tag: "v99.0.0",
    url: "https://github.com/ollama/ollama/releases/download/v99.0.0/OllamaSetup.exe",
    sha256: "b".repeat(64),
    bytes: 123,
    source: "live",
  };

  it("plans the pinned release alone, because the site url is a moving file the pin cannot vouch for", () => {
    const setup = find(plan(), "ollama-setup");
    expect(setup.job.sources.map((source) => source.url)).toEqual([pin.url]);
    expect(setup.job.sources[0]?.sha256).toBe(pin.sha256);
  });

  it("a newer official release goes first with its own digest, the site second, and the pin stays as the last resort", async () => {
    const setup = find(plan(), "ollama-setup");
    await prefetch.useLatestInstaller(setup, async () => live);
    const list = setup.job.sources;
    expect(list.map((source) => source.url)).toEqual([
      live.url,
      "https://ollama.com/download/OllamaSetup.exe",
      pin.url,
    ]);
    expect(list.map((source) => source.sha256)).toEqual([live.sha256, live.sha256, pin.sha256]);
    expect(list.map((source) => source.bytes)).toEqual([live.bytes, live.bytes, pin.bytes]);
  });

  it("an offline lookup, an older release or one without a digest keeps the pin alone", async () => {
    for (const answer of [
      { ...live, source: "pinned", url: pin.url, sha256: pin.sha256 },
      { ...live, sha256: "" },
      null,
    ]) {
      const setup = find(plan(), "ollama-setup");
      await prefetch.useLatestInstaller(setup, async () => answer);
      expect(setup.job.sources.map((source) => source.url)).toEqual([pin.url]);
    }
  });

  it("a verified copy of the pinned installer is reused even when a newer release changed the first digest", async () => {
    const dir = temp();
    const file = path.join(dir, "OllamaSetup.exe");
    writeFileSync(file, "pinned installer bytes");
    const row = {
      ready: file,
      kind: "installer",
      job: {
        sources: [
          { kind: "url", url: "x", sha256: sha("the newer one") },
          { kind: "url", url: "y", sha256: sha("the newer one") },
          { kind: "url", url: "z", sha256: sha("pinned installer bytes") },
        ],
      },
    };
    expect(prefetch.alreadyThere(row)).toBe(true);
    writeFileSync(file, "a half written or tampered file");
    expect(prefetch.alreadyThere(row)).toBe(false);
  });
});

describe("the neural voice already on disk is not fetched again", () => {
  it("counts as here when every pinned file is there even without the completion marker", () => {
    const dir = temp();
    const row = prefetch
      .prefetchPlan(dir, { ...quiet, FRIDAY_PREFETCH_TTS: "1" }, "linux")
      .find((job: Job) => job.id === "supertonic-3") as Job;
    expect(prefetch.alreadyThere(row)).toBe(false);
    const files = Object.keys(pins.pinForRepo("Supertone/supertonic-3").files);
    for (const name of files) {
      const target = path.join(dir, "models", "supertonic-3", ...name.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "x");
    }
    expect(prefetch.alreadyThere(row)).toBe(true);
  });
});

const probe = (ramGb: number, freeGb: number, gpu = false) => ({
  totalRamGb: ramGb,
  freeRamGb: freeGb,
  cpuThreads: 8,
  gpu: gpu
    ? { name: "card", vramGb: 12, vramFreeGb: 11, cudaRuntimeReady: true, source: "test" }
    : { name: "", vramGb: 0, source: "test", cudaRuntimeReady: false },
});

describe("a pinned folder on disk is judged by its pin, not by a branch that may have moved", () => {
  it("asks the repository listing only about folders that have no pin", async () => {
    const dir = temp();
    for (const file of ["config.json", "model.bin"]) {
      const target = path.join(dir, "cache", "stt", "base", file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "x");
    }
    const asked: string[] = [];
    const lines: string[] = [];
    const fetched: string[] = [];
    await prefetch.prefetch(dir, {
      env: {
        ...quiet,
        FRIDAY_PREFETCH_MOONSHINE: "0",
        FRIDAY_PREFETCH_CHAT: "0",
        FRIDAY_PREFETCH_TTS: "0",
      },
      platform: "linux",
      log: (line: string) => lines.push(line),
      board: null,
      download: async (job: { modelId: string }) => {
        fetched.push(job.modelId);
        return { ok: true, bytes: 1 };
      },
      freshnessFetch: async (url: string) => {
        asked.push(url);
        return { ok: true, json: async () => [{ type: "file", path: "model.bin", size: 999 }] };
      },
    });
    expect(asked).toEqual([]);
    expect(fetched).not.toContain("base");
    expect(lines.join("\n")).toContain("stt-base verified on disk; not downloaded again");
  });
});

describe("the plan decides the extra speech sizes and English streaming speech", () => {
  const voicePlan = (p: ReturnType<typeof probe>, bavail = 500 * 1024 ** 2) =>
    weights.voiceInstallPlan("C:/friday", p, {
      exists: () => false,
      statfs: () => ({ bavail, bsize: 1024 }),
    });

  it("a mid PC keeps the lite size, and the sizes the plan did not choose are skipped with the plan's reason", () => {
    const voice = voicePlan(probe(16, 10));
    expect(voice.budget.sttSize).toBe("small");
    expect(voice.extras.map((extra: { id: string }) => extra.id)).toEqual([
      "stt-tiny",
      "moonshine-en",
    ]);
    const jobs = plan({}, { plan: voice });
    expect(find(jobs, "stt-small").skipReason).toBeUndefined();
    expect(find(jobs, "stt-tiny")).toMatchObject({ optional: true });
    expect(find(jobs, "stt-tiny").skipReason).toBeUndefined();
    expect(find(jobs, "stt-base").skipReason).toMatch(/not in this PC's voice plan/);
    expect(find(jobs, "stt-base").skipReason).toMatch(/small/);
  });

  it("a GPU PC keeps small as its CPU companion; base and medium are not fetched", () => {
    const voice = voicePlan(probe(32, 24, true));
    expect(voice.budget.sttSize).toBe("large-v3-turbo");
    expect(voice.extras.map((extra: { id: string }) => extra.id)).toEqual([
      "stt-tiny",
      "stt-small",
      "moonshine-en",
    ]);
    const jobs = plan({}, { plan: voice });
    expect(find(jobs, "stt-small").skipReason).toBeUndefined();
    expect(find(jobs, "stt-small")).toMatchObject({ optional: true });
    for (const id of ["stt-base", "stt-medium"]) {
      expect(find(jobs, id).skipReason, id).toMatch(/not in this PC's voice plan/);
    }
  });

  it("an owner who asks for a size by name still gets it (FRIDAY_PREFETCH_STT_BIG=1 is explicit)", () => {
    const voice = voicePlan(probe(16, 10));
    const jobs = plan({ FRIDAY_PREFETCH_STT_BIG: "1" }, { plan: voice });
    expect(find(jobs, "stt-large-v3-turbo").skipReason).toBeUndefined();
  });

  it("a disk too full for the extras skips them with the disk reason, and the essentials stay", () => {
    const voice = voicePlan(probe(16, 10), 1);
    expect(voice.extras.map((extra: { state: string }) => extra.state)).toEqual([
      "skipped",
      "skipped",
    ]);
    const jobs = plan({}, { plan: voice });
    expect(find(jobs, "stt-tiny").skipReason).toBeTruthy();
    expect(find(jobs, "stt-small").skipReason).toBeUndefined();
  });

  it("without a plan nothing is decided here: the lists stay as they were", () => {
    const jobs = plan();
    for (const id of ["stt-base", "stt-small", "stt-tiny"])
      expect(find(jobs, id).skipReason, id).toBeUndefined();
  });

  it("English streaming speech is fetched only when the plan keeps it, and a skip is a visible line", async () => {
    const lines: string[] = [];
    let ran = 0;
    const run = async (keep: boolean) => {
      lines.length = 0;
      ran = 0;
      const dir = temp();
      const made = await prefetch.thisPcPlan(dir, {
        env: quiet,
        facts,
        installedModels: [],
        probe: probe(16, 10),
        spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
      });
      const voice = keep ? made.voicePlan : { ...made.voicePlan, extras: [] };
      const rows = await prefetch.prefetch(dir, {
        env: { ...quiet, FRIDAY_PREFETCH_MOONSHINE: "1", FRIDAY_PREFETCH_CHAT: "0" },
        platform: "linux",
        log: (line: string) => lines.push(line),
        download: async () => ({ ok: true, bytes: 1 }),
        board: null,
        thisPc: { ...made, voicePlan: voice },
        moonshine: async () => {
          ran += 1;
          return { status: 1, stdout: "" };
        },
      });
      return rows as Array<{ id: string; ok: boolean; skipped?: boolean }>;
    };
    const skipped = await run(false);
    expect(ran).toBe(0);
    expect(skipped.find((row) => row.id === "moonshine-en")).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(lines.join("\n")).toMatch(/moonshine-en skipped: not in this PC's voice plan/);
    // The plan keeps it: the fetch is attempted as before (here the fake runner has no Python, so it says so).
    await run(true);
    expect(lines.join("\n")).not.toMatch(/moonshine-en skipped: not in this PC's voice plan/);
  });
});

describe("the plan row for ONNX Runtime says present or install from what the venv really holds", () => {
  const spawn =
    (out: string, status = 0) =>
    () => ({ status, stdout: out, stderr: "" });
  const env = { FRIDAY_PYTHON: process.execPath };

  it("reads the installed package name and version with one short Python call", () => {
    const calls: string[][] = [];
    const run = (exe: string, args: string[]) => {
      calls.push([exe, ...args]);
      return { status: 0, stdout: "onnxruntime 1.22.0\n", stderr: "" };
    };
    expect(prefetch.onnxruntimeInstalled(env, { spawnSync: run })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("-I");
    expect(
      prefetch.onnxruntimeInstalled(env, { spawnSync: spawn("onnxruntime-directml 1.1\n") }),
    ).toBe(true);
    expect(prefetch.onnxruntimeInstalled(env, { spawnSync: spawn("onnxruntime-gpu 1.1\n") })).toBe(
      true,
    );
  });

  it("is false for no package, a failed call, no Python and a look-alike name", () => {
    expect(prefetch.onnxruntimeInstalled(env, { spawnSync: spawn("", 1) })).toBe(false);
    expect(prefetch.onnxruntimeInstalled(env, { spawnSync: spawn("none\n") })).toBe(false);
    expect(
      prefetch.onnxruntimeInstalled(env, { spawnSync: spawn("onnxruntime-extensions 0.1\n") }),
    ).toBe(false);
    expect(
      prefetch.onnxruntimeInstalled(env, {
        spawnSync: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    ).toBe(false);
    expect(
      prefetch.onnxruntimeInstalled({ FRIDAY_PYTHON: "" }, { spawnSync: spawn("onnxruntime 1\n") }),
    ).toBe(false);
  });

  it("thisPcPlan hands it to the plan: present when installed, install when not", async () => {
    const ask = async (out: string) =>
      (
        await prefetch.thisPcPlan(temp(), {
          env,
          facts,
          installedModels: [],
          spawnSync: spawn(out),
          probe: {
            totalRamGb: 16,
            freeRamGb: 10,
            cpuThreads: 8,
            gpu: { name: "", vramGb: 0, source: "test", cudaRuntimeReady: false },
          },
        })
      ).plan.packages.ort.action;
    expect(await ask("onnxruntime 1.22.0\n")).toBe("present");
    expect(await ask("none\n")).toBe("install");
  });
});

describe("the speaker model has one name on both sides", () => {
  it("the kernel looks for the file the pin downloads", () => {
    const kernel = readFileSync(path.join(root, "kernel/voice_runtime.py"), "utf8");
    const pin = Object.keys(pins.pinForRepo("onnx-community/wespeaker-voxceleb-resnet34-LM").files);
    expect(pin).toContain("onnx/model_int8.onnx");
    expect(kernel).toMatch(/SPEAKER_PINNED = \("speaker-wespeaker", "onnx", "model_int8\.onnx"\)/);
    expect(kernel).toContain('SPEAKER_FILE = "wespeaker-ecapa.onnx"');
    expect(
      weights
        .modelRegistry()
        .find((row: { catalogId: string }) => row.catalogId === "speaker-wespeaker")?.dir,
    ).toEqual(["models", "speaker-wespeaker"]);
  });
});
