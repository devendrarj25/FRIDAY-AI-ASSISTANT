/**
 * Setup assets (wave 2): the optional voice models are planned and fetched as optional, English streaming speech is a
 * pinned file set fetched by the shared downloader (also from the Models page), a url-set mirror source is accepted
 * and verified, and the GPU ONNX Runtime follows the CUDA libraries with a rollback. Nothing here touches the network:
 * the downloader and the disk are injected.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { modelById } from "../../src/lib/friday/model-catalog";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const weights = require_(path.join(root, "electron/voice-weights.cjs"));
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));
const plans = require_(path.join(root, "electron/setup-plan.cjs"));
const download = require_(path.join(root, "electron/model-download.cjs"));
const catalog = require_(path.join(root, "electron/installer-catalog.cjs"));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-w2-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const roomy = () => ({ bavail: 500 * 1024 ** 2, bsize: 1024 });
const probe = {
  totalRamGb: 16,
  freeRamGb: 12,
  cpuThreads: 8,
  gpu: { name: "", vramGb: 0, vramFreeGb: 0, source: "test" },
};

describe("the optional voice models are part of the setup, as optional rows", () => {
  const dir = "/friday-root";
  const plan = weights.voiceInstallPlan(dir, probe, { exists: () => false, statfs: roomy });

  it("the plan keeps them apart from the required bytes", () => {
    expect(plan.optionalItems.length).toBeGreaterThan(0);
    expect(plan.optionalBytes).toBeGreaterThan(0);
    const ids = plan.items.map((item: { id: string }) => item.id);
    for (const item of plan.optionalItems) expect(ids).not.toContain(item.id);
  });

  it("the prefetch jobs include each one with its fallback and a failure line", () => {
    const jobs = prefetch.prefetchPlan(dir, { FRIDAY_PREFETCH: "1" }, "win32", { plan });
    for (const item of plan.optionalItems.filter(
      (row: { state: string }) => row.state !== "skipped",
    )) {
      const job = jobs.find((row: { id: string }) => row.id === item.id);
      expect(job, item.id).toBeTruthy();
      expect(job.optional).toBe(true);
      expect(job.fallback).toBeTruthy();
      expect(job.failureLine({ error: "offline" })).toContain(item.id);
    }
  });

  it("a failed optional row becomes a notice whose Install Manager id is the item id", () => {
    const item = plan.optionalItems[0];
    const dirNotice = temp();
    const lines: string[] = [];
    const recorded = prefetch.recordRowNotices(
      [{ id: item.id, ok: false, error: "offline", optional: true }],
      { root: dirNotice, log: (line: string) => lines.push(line), print: true },
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0].installManagerId).toBe(`voice:${item.id}`);
  });

  it("the setup plan lists them as fetched voice rows and reports their bytes apart from downloadBytes", () => {
    const voice = plans.buildSetupPlan(
      {
        ramGb: 16,
        ramFreeGb: 12,
        diskFreeGb: 200,
        cpuClass: "mid",
        cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
        gpus: [],
        network: { online: true },
      },
      { root: dir, installedModels: [], statfs: roomy, exists: () => false },
    ).voice;
    if (!voice.planned) throw new Error("the voice plan was not made");
    for (const item of plan.optionalItems.filter(
      (row: { state: string }) => row.state === "download",
    ))
      expect(voice.install).toContain(item.id);
    expect(voice.optionalBytes).toBeGreaterThan(0);
    // downloadBytes is the required rows only (plan items plus the streaming ear)
    expect(voice.downloadBytes).toBe(plan.downloadBytes + (plan.streamEarBytes || 0));
  });
});

describe("English streaming speech is a pinned file set the shared downloader installs", () => {
  const set = weights.fileSets().find((row: { id: string }) => row.id === "moonshine-en");

  it("the Models page job (no pinned file in it) installs the whole set, every file hash-checked", async () => {
    const models = temp();
    const calls: Array<{ url: string; sha256: string; needBytes: number }> = [];
    const events: number[] = [];
    const result = await download.downloadModel(
      {
        modelId: "moonshine-en",
        dir: models,
        sources: [{ kind: "url", url: "https://github.com/moonshine-ai/moonshine", label: "x" }],
        persist: false,
      },
      (event: { progress?: number }) => {
        if (typeof event.progress === "number") events.push(event.progress);
      },
      undefined,
      {
        localBundles: [],
        downloadUrl: async (
          url: string,
          dest: string,
          options: { sha256: string; needBytes: number },
        ) => {
          calls.push({ url, sha256: options.sha256, needBytes: options.needBytes });
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, Buffer.alloc(options.needBytes));
          return options.needBytes;
        },
      },
    );
    expect(result).toMatchObject({ ok: true, via: "file-set" });
    expect(calls.map((call) => call.url)).toEqual(
      set.files.map((file: { url: string }) => file.url),
    );
    expect(calls.every((call) => /^[0-9a-f]{64}$/.test(call.sha256))).toBe(true);
    expect(weights.fileSetReady(path.dirname(models), "moonshine-en", {})).toBe(false);
    expect(weights.fileSetReady(models, "moonshine-en", {})).toBe(false); // folder is <models>/<id>, not <root>/models
    expect(
      weights.fileSetReady(models, "moonshine-en", {
        sizeOf: (file: string) => {
          const name = path.basename(file);
          return set.files.find((f: { file: string }) => f.file === name)?.bytes ?? -1;
        },
      }),
    ).toBe(true);
    expect(Math.max(...events)).toBe(100);
  });

  it("the Install Manager and the Models page both carry the row", () => {
    const rows = catalog.voiceRows(temp());
    const row = rows.find((item: { id: string }) => item.id === "voice:moonshine-en");
    expect(row).toMatchObject({
      kind: "voice-model",
      installed: false,
      optional: true,
      license: "MIT",
      firewallClass: "local",
    });
    expect(row.chain.sources[0].assets).toHaveLength(set.files.length);
    const spec = modelById.get("moonshine-en");
    expect(spec?.category).toBe("Speech to Text");
    expect(spec?.license).toBe("MIT");
    expect(read("src/lib/friday/model-catalog.ts")).toMatch(
      /"moonshine-en": \{[^}]*diskBytes: 78075147/,
    );
    expect(set.diskBytes).toBe(78075147);
  });

  it("setup fetches it with no Python and no Python script is left in the prefetch", () => {
    const source = read("scripts/prefetch-models.cjs");
    expect(source).not.toContain("get_model_for_language");
    expect(source).toContain("voiceWeights.fileSetJobs(root, MOONSHINE_ID)");
    expect(source).toContain("voiceWeights.fileSetReady(root, MOONSHINE_ID)");
  });
});

describe("a url-set mirror source is accepted, ordered by reach and verified", () => {
  const body = (text: string) => Buffer.from(text);
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  const a = body("config text");
  const b = body("model bytes");
  const pin = {
    revision: "r".repeat(40),
    license: "MIT",
    files: {
      "config.json": { sha256: sha(a), bytes: a.length },
      "model.bin": { sha256: sha(b), bytes: b.length },
    },
  };
  const source = {
    kind: "url-set",
    host: "modelscope.cn",
    label: "ModelScope (same SHA-256)",
    repo: "test/repo",
    files: Object.entries(pin.files).map(([file, row]) => ({
      kind: "url",
      url: `https://modelscope.cn/x/${file}`,
      sha256: row.sha256,
      bytes: row.bytes,
      relPath: file,
    })),
  };
  const bytes: Record<string, Buffer> = { "config.json": a, "model.bin": b };
  // The downloader rebuilds the set from its own pin: here the pin table is the test's, so the rebuilt set is too.
  const trusted = {
    ...source,
    files: source.files.map((file) => ({
      ...file,
      url: `https://modelscope.cn/pinned/${file.relPath}`,
    })),
  };

  it("downloadModel walks a url-set source and keeps the files only when the pin agrees", async () => {
    const models = temp();
    const urls: string[] = [];
    const result = await download.downloadModel(
      { modelId: "test-ear", dir: models, sources: [source], persist: false },
      () => {},
      undefined,
      {
        localBundles: [],
        pinForRepo: () => pin,
        mirrorSource: () => trusted,
        downloadUrl: async (url: string, dest: string, options: { needBytes: number }) => {
          urls.push(url);
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, bytes[path.basename(dest)] as Buffer);
          return options.needBytes;
        },
      },
    );
    expect(result).toMatchObject({ ok: true, via: "url-set" });
    expect(urls).toHaveLength(2);
    // the urls are the pinned ones, not the ones the caller's source carried
    expect(urls.every((url) => url.startsWith("https://modelscope.cn/pinned/"))).toBe(true);
    // each file lands under its relPath inside <models>/<modelId>, never under the last url segment of another file
    expect(result.path).toBe(path.join(models, "test-ear"));
  });

  it("a file that does not match the pin fails the source and is not kept", async () => {
    const models = temp();
    const result = await download.downloadModel(
      { modelId: "test-ear", dir: models, sources: [source], persist: false },
      () => {},
      undefined,
      {
        localBundles: [],
        pinForRepo: () => pin,
        mirrorSource: () => trusted,
        downloadUrl: async (_url: string, dest: string, options: { needBytes: number }) => {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, Buffer.alloc(options.needBytes, 7));
          return options.needBytes;
        },
      },
    );
    expect(result.ok).toBe(false);
  });

  it("the speech jobs list the ModelScope copy behind Hugging Face and a down host goes last", () => {
    const jobs = prefetch.prefetchPlan("/friday-root", { FRIDAY_PREFETCH: "1" }, "win32", {});
    const small = jobs.find(
      (job: { id: string }) => job.id === "stt-small" || job.id === "stt-base",
    );
    if (small) {
      const kinds = small.job.sources.map((entry: { kind: string }) => entry.kind);
      expect(kinds[0]).toBe("hf-repo");
      expect(kinds).toContain("url-set");
      const ordered = prefetch.orderByReach(small.job.sources, {
        "huggingface.co": { state: "down" },
      });
      expect(ordered[0].kind).toBe("url-set");
      expect(ordered).toHaveLength(small.job.sources.length);
    }
    expect(read("scripts/prefetch-models.cjs")).toContain("orderByReach(row.job.sources, reach)");
  });
});

describe("setup-python installs the GPU ONNX Runtime after the CUDA libraries, with a health check and a fallback", () => {
  const src = read("scripts/setup-python.cjs");
  const at = src.indexOf("function installGpuOnnxRuntime()");
  const body = src.slice(at, src.indexOf("installGpuOnnxRuntime();", at));

  it("runs after the CUDA libraries and only when the plan says gpu", () => {
    expect(src.indexOf("installGpuSpeechLibraries();")).toBeLessThan(
      src.indexOf("installGpuOnnxRuntime();"),
    );
    expect(body).toContain('row.variant !== "gpu"');
    expect(body).toContain("CUDA_LIBS_PROBE");
  });

  it("uses the pinned, hash-checked wheel, removes the CPU wheel only after the download verified, and restores it on failure", () => {
    expect(src).toMatch(/pinnedGpuOrtLines[\s\S]{0,400}PINNED_WHEELS/);
    expect(body).toContain('"--require-hashes"');
    expect(body.indexOf('pip("download"')).toBeLessThan(body.indexOf('"uninstall"'));
    expect(body).toContain("restoreCpu()");
    expect(body).toContain("CUDAExecutionProvider");
    expect(body).toContain('id: "package:onnxruntime-gpu"');
    expect(body).not.toContain("process.exit");
    expect(body).not.toContain("blockers.push");
  });

  it("a pinned GPU wheel exists for every Python the pins cover", () => {
    const pins = require_(path.join(root, "electron/engine-install.cjs")).PINNED_WHEELS;
    const gpu = pins["onnxruntime-gpu"];
    for (const tag of ["cp311", "cp312", "cp313", "cp314"])
      expect(gpu.assets.some((asset: { name: string }) => asset.name.includes(`-${tag}-`))).toBe(
        true,
      );
  });
});
