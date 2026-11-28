/**
 * The right listening and speaking assets for Hindi, English and Hinglish on every PC: the optional planned set per
 * hardware profile, a second (ModelScope) road to the same pinned speech weights, the renamed denoiser repository, the
 * English streaming speech as a pinned file set, and the language rows of the voice smoke test. Fake hardware, fake
 * disk, fake network, no date: nothing here reads a clock, a socket or a microphone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { budgetFor as tsBudgetFor } from "../../src/lib/friday/voice-engine/hardware-profile";

const req = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const weights = req(path.join(root, "electron/voice-weights.cjs"));
const pins = req(path.join(root, "electron/voice-pins.cjs"));
const safety = req(path.join(root, "electron/download-safety.cjs"));
const smoke = req(path.join(root, "scripts/voice-smoke.cjs"));
const hosts = JSON.parse(
  fs.readFileSync(path.join(root, "config/download-hosts.json"), "utf8"),
) as {
  hosts: string[];
  families: { id: string; hosts?: string[] }[];
};

const dirs: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-lang-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const noGpu = { name: "", vramGb: 0, source: "none", cudaRuntimeReady: false };
const pc = (totalRamGb: number, freeRamGb: number) => ({
  totalRamGb,
  freeRamGb,
  cpuThreads: 8,
  gpu: noGpu,
});
const plenty = { statfs: () => ({ bavail: 10 ** 12, bsize: 1 }), exists: () => false };

describe("the optional planned set follows the PC", () => {
  const optional = (total: number, free: number) =>
    weights.budgetFor(total, free, 0, {}, { cpuThreads: 8 }).optionalInstall as string[];

  it("every profile, the lite one too, plans the Roman Hinglish ear", () => {
    expect(weights.budgetFor(4, 3, 0).profile).toBe("lite");
    expect(optional(4, 3)).toEqual(["hinglish-ear"]);
    expect(optional(3, 2)).toContain("hinglish-ear");
    expect(optional(16, 10)).toContain("hinglish-ear");
  });

  it("the Hindi Whisper backup needs the speech budget, the light Hindi voice needs 8 GB, the denoisers need a non-lite profile", () => {
    expect(optional(16, 10)).toEqual([
      "hinglish-ear",
      "hindi-fallback-ear",
      "hindi-light-tts",
      "denoise-gtcrn",
      "denoise-dpdfnet",
    ]);
    // 6 GB: base on the lite profile, a 1 GB speech budget carries the 0.8 GB backup, no light voice, no denoisers.
    expect(optional(6, 4)).toEqual(["hinglish-ear", "hindi-fallback-ear"]);
    // 8 GB with little free memory: the backup does not fit, the light voice (8 GB of RAM) is still planned.
    expect(weights.budgetFor(8, 1.5, 0).speechBudgetGb).toBeLessThan(0.8);
    expect(optional(8, 1.5)).not.toContain("hindi-fallback-ear");
    expect(optional(8, 1.5)).toContain("hindi-light-tts");
  });

  it("an unknown amount of memory is an 8 GB PC and still gets the Hinglish ear", () => {
    expect(optional(0, 0)).toContain("hinglish-ear");
    expect(optional(0, 0)).toContain("hindi-light-tts");
  });

  it("the Models page table (TypeScript) plans the same ids on every shape of PC", () => {
    for (const [total, free] of [
      [3, 2],
      [4, 3],
      [6, 4],
      [8, 1.5],
      [8, 5],
      [16, 10],
      [32, 24],
      [0, 0],
    ] as [number, number][]) {
      expect(tsBudgetFor(total, free, 0, {}, { cpuThreads: 8 }).optionalInstall).toEqual(
        optional(total, free),
      );
    }
  });

  it("keeps the required install list exactly as it was: the optional ids never enter it", () => {
    const b = weights.budgetFor(16, 10, 0);
    expect(b.install).toEqual([
      "silero-vad",
      "smart-turn",
      "faster-whisper-small",
      "supertonic-3",
      "hindi-ear",
      "hindi-punct",
    ]);
    for (const id of b.optionalInstall) expect(b.install).not.toContain(id);
  });
});

describe("the voice plan carries them as optional items with a fallback", () => {
  it("lists them apart from items, with their bytes apart from downloadBytes", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    expect(plan.optionalItems.map((item: { id: string }) => item.id)).toEqual(
      plan.budget.optionalInstall,
    );
    for (const item of plan.optionalItems) {
      expect(item.optional).toBe(true);
      expect(item.state).toBe("download");
      expect(item.fallback).not.toBe("");
      expect(plan.items.some((row: { id: string }) => row.id === item.id)).toBe(false);
    }
    const bytes = plan.optionalItems.reduce(
      (sum: number, item: { bytes: number }) => sum + item.bytes,
      0,
    );
    expect(plan.optionalBytes).toBe(bytes);
    expect(plan.downloadBytes).toBe(
      plan.items.reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0),
    );
    expect(plan.lines.join("\n")).toMatch(/hinglish-ear \(optional\) will be fetched/);
  });

  it("the lite PC keeps only the 78 MB Hinglish ear, the backup does not fit a full disk and says why", () => {
    const lite = weights.voiceInstallPlan(temp(), pc(4, 3), plenty);
    expect(lite.optionalItems.map((item: { id: string }) => item.id)).toEqual(["hinglish-ear"]);
    expect(lite.optionalItems[0].bytes).toBe(81398368);
    const tight = weights.voiceInstallPlan(temp(), pc(16, 10), {
      ...plenty,
      statfs: () => ({ bavail: 700 * 1024 ** 2, bsize: 1 }),
    });
    const backup = tight.optionalItems.find(
      (item: { id: string }) => item.id === "hindi-fallback-ear",
    );
    expect(backup.state).toBe("skipped");
    expect(backup.reason).not.toBe("");
    // A skipped optional model is no failure: the plan still has every essential item.
    expect(tight.items.length).toBeGreaterThan(0);
  });

  it("a copy already on disk (every pinned file present) is reused, not planned again", () => {
    const dir = temp();
    const folder = path.join(dir, "models", "hinglish-ear");
    fs.mkdirSync(folder, { recursive: true });
    for (const name of Object.keys(pins.pinForRepo(weights.HINGLISH_EAR_REPO).files)) {
      fs.writeFileSync(path.join(folder, name), "x");
    }
    const plan = weights.voiceInstallPlan(dir, pc(16, 10), { ...plenty, exists: fs.existsSync });
    const row = plan.optionalItems.find((item: { id: string }) => item.id === "hinglish-ear");
    expect(row.state).toBe("on-disk");
    expect(plan.optionalBytes).toBe(
      plan.optionalItems
        .filter((item: { state: string }) => item.state === "download")
        .reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0),
    );
  });

  it("a failed fetch of any of them is reported as optional and names what stays in use", () => {
    for (const id of weights.budgetFor(16, 10, 0).optionalInstall as string[]) {
      expect(weights.isPlanOptional(id)).toBe(true);
      const line = weights.pinnedFailureLine(id, {
        attempts: [{ source: "Hugging Face", error: "offline" }],
      });
      expect(line).toMatch(/optional/);
      expect(line).toContain(weights.planFallback(id));
    }
    expect(weights.isPlanOptional("faster-whisper-small")).toBe(false);
    expect(weights.isPlanOptional("stream-ear-nemotron")).toBe(true);
  });

  it("does not claim the denoisers are live", () => {
    for (const id of ["denoise-gtcrn", "denoise-dpdfnet"]) {
      expect(weights.planFallback(id)).toMatch(/not wired to the live stream/);
    }
  });
});

describe("a second road to the pinned speech weights (ModelScope)", () => {
  const SIZES = ["tiny", "base", "small", "medium", "large-v3"];

  it("holds exactly the pinned files, hashes and sizes of the five Systran repositories", () => {
    for (const size of SIZES) {
      const repo = weights.STT_REPOS[size];
      const source = weights.modelscopeSource(repo);
      const pin = pins.pinForRepo(repo);
      expect(source.kind).toBe("url-set");
      expect(source.host).toBe("modelscope.cn");
      expect(source.files.map((f: { relPath: string }) => f.relPath).sort()).toEqual(
        Object.keys(pin.files).sort(),
      );
      for (const file of source.files) {
        expect(file.kind).toBe("url");
        expect(file.sha256).toBe(pin.files[file.relPath].sha256);
        expect(file.bytes).toBe(pin.files[file.relPath].bytes);
        expect(file.url.startsWith(`https://modelscope.cn/api/v1/models/${repo}/repo?`)).toBe(true);
        expect(() => safety.assertAllowedUrl(file.url)).not.toThrow();
      }
    }
  });

  it("has no copy for a repository it was not compared on", () => {
    expect(weights.modelscopeSource(weights.STT_REPOS["large-v3-turbo"])).toBeNull();
    expect(weights.modelscopeSource("someone/else")).toBeNull();
  });

  it("the plan's own sources stay Hugging Face only; the hook adds the mirror behind it", () => {
    expect(
      weights.sttPlan("small", "/r").sources.every((s: { kind: string }) => s.kind === "hf-repo"),
    ).toBe(true);
    const ordered = weights.sttSourcesWithMirror("small");
    expect(ordered.map((s: { kind: string }) => s.kind)).toEqual(["hf-repo", "url-set"]);
  });

  it("moves the mirror first only when the reach probe says Hugging Face is down, and drops nothing", () => {
    const down = weights.sttSourcesWithMirror("base", { "huggingface.co": { state: "down" } });
    expect(down.map((s: { kind: string }) => s.kind)).toEqual(["url-set", "hf-repo"]);
    const mirrorDown = weights.sttSourcesWithMirror("base", { "modelscope.cn": { state: "down" } });
    expect(mirrorDown.map((s: { kind: string }) => s.kind)).toEqual(["hf-repo", "url-set"]);
    const unchecked = weights.sttSourcesWithMirror("base", {
      "huggingface.co": { state: "unchecked" },
    });
    expect(unchecked[0].kind).toBe("hf-repo");
    // A size with no verified copy has only its own sources, whatever the probe says.
    const turbo = weights.sttSourcesWithMirror("large-v3-turbo", {
      "huggingface.co": { state: "down" },
    });
    expect(turbo.every((s: { kind: string }) => s.kind === "hf-repo")).toBe(true);
  });

  it("the host is on the download allowlist and is refused one label deeper", () => {
    expect(hosts.hosts).toContain("modelscope.cn");
    expect(hosts.families.find((f) => f.id === "modelscope")?.hosts).toEqual(["modelscope.cn"]);
    expect(
      safety.assertAllowedUrl("https://modelscope.cn/api/v1/models/a/b/repo?x=1").fridayFamily,
    ).toBe("modelscope");
    expect(() => safety.assertAllowedUrl("https://evil.modelscope.cn/a")).toThrow();
    expect(() => safety.assertAllowedUrl("http://modelscope.cn/a")).toThrow();
  });

  describe("downloadMirrorSet", () => {
    const body = (text: string) => Buffer.from(text);
    const sha = (buf: Buffer) => req("node:crypto").createHash("sha256").update(buf).digest("hex");
    const makeSet = () => {
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
      return { pin, source, bytes: { "config.json": a, "model.bin": b } };
    };

    it("fetches each file, hashes the folder against the pin and writes the pin record", async () => {
      const { pin, source, bytes } = makeSet();
      const dir = temp();
      const calls: string[] = [];
      const result = await weights.downloadMirrorSet(source, dir, {
        pinForRepo: () => pin,
        downloadUrl: async (
          url: string,
          dest: string,
          options: { sha256: string; needBytes: number },
        ) => {
          calls.push(url);
          expect(options.sha256).toBeTruthy();
          expect(options.needBytes).toBeGreaterThan(0);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, bytes[path.basename(dest) as keyof typeof bytes]);
          return options.needBytes;
        },
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(pins.readMarker(dir)?.revision).toBe(pin.revision);
      // A second run finds both files at their size and fetches nothing.
      const again = await weights.downloadMirrorSet(source, dir, {
        pinForRepo: () => pin,
        downloadUrl: async () => {
          throw new Error("must not be called");
        },
      });
      expect(again.ok).toBe(true);
    });

    it("refuses wrong bytes: the bad file is removed and the failure is a value, not a throw", async () => {
      const { pin, source } = makeSet();
      const dir = temp();
      const result = await weights.downloadMirrorSet(source, dir, {
        pinForRepo: () => pin,
        downloadUrl: async (_url: string, dest: string, options: { needBytes: number }) => {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, Buffer.alloc(options.needBytes, 1));
          return options.needBytes;
        },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/checksum mismatch/);
      expect(fs.existsSync(path.join(dir, "model.bin"))).toBe(false);
      expect(pins.readMarker(dir)).toBeNull();
    });

    it("a source whose hash differs from the pin is never fetched", async () => {
      const { pin, source } = makeSet();
      source.files[0]!.sha256 = "0".repeat(64);
      const result = await weights.downloadMirrorSet(source, temp(), {
        pinForRepo: () => pin,
        downloadUrl: async () => {
          throw new Error("must not be called");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match the pin/);
    });

    it("a downloader that throws becomes a failure value", async () => {
      const { pin, source } = makeSet();
      const result = await weights.downloadMirrorSet(source, temp(), {
        pinForRepo: () => pin,
        downloadUrl: async () => {
          throw new Error("offline");
        },
      });
      expect(result).toMatchObject({ ok: false, error: "offline" });
    });
  });
});

describe("the speech weights fall back to the mirror only after every Hugging Face road failed", () => {
  const failing = async () => ({ ok: false, cause: "network", error: "connection reset" });

  it("a stand-in downloader that fails keeps today's failure and never reaches the mirror", async () => {
    let urls = 0;
    const result = await weights.ensureSttWeights("tiny", temp(), {
      exists: () => false,
      downloadModel: failing,
      downloadUrl: undefined,
      onEvent: () => {
        urls += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("connection reset");
    expect(urls).toBe(0);
  });

  it("an injected downloadUrl is the real-network switch: each ModelScope file is fetched with its pinned hash", async () => {
    const seen: { url: string; sha256: string; needBytes: number }[] = [];
    const events: string[] = [];
    const result = await weights.ensureSttWeights("tiny", temp(), {
      exists: () => false,
      downloadModel: failing,
      downloadUrl: async (
        url: string,
        _dest: string,
        options: { sha256: string; needBytes: number },
      ) => {
        seen.push({ url, sha256: options.sha256, needBytes: options.needBytes });
        throw new Error("modelscope is unreachable too");
      },
      onEvent: (event: { status?: string }) => events.push(String(event.status)),
    });
    expect(seen).toHaveLength(1);
    expect(
      seen[0]!.url.startsWith("https://modelscope.cn/api/v1/models/Systran/faster-whisper-tiny/"),
    ).toBe(true);
    expect(seen[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toContain("source: ModelScope (same SHA-256)");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(
      /connection reset; ModelScope \(same SHA-256\): modelscope is unreachable too/,
    );
  });

  it("no network at all (an offline failure) does not try a second host", async () => {
    let called = false;
    const result = await weights.ensureSttWeights("tiny", temp(), {
      exists: () => false,
      downloadModel: async () => ({ ok: false, error: "offline: no route" }),
      downloadUrl: async () => {
        called = true;
        return 0;
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("the plan reads English streaming speech from the file set", () => {
  it("plans it with its real bytes and the per-file jobs, and marks it on disk when every file is there", () => {
    const plan = weights.voiceInstallPlan(temp(), pc(16, 10), plenty);
    const row = plan.extras.find((item: { id: string }) => item.id === "moonshine-en");
    expect(row.bytes).toBe(78075147);
    expect(row.state).toBe("download");
    expect(row.optional).toBe(true);
    expect(row.jobs).toHaveLength(9);
    const here = weights.voiceInstallPlan(temp(), pc(16, 10), { ...plenty, exists: () => true });
    const done = here.extras.find((item: { id: string }) => item.id === "moonshine-en");
    expect(done.state).toBe("on-disk");
    expect(done.jobs).toBeUndefined();
  });
});

describe("the renamed denoiser repository", () => {
  it("answers on both names with the same pin", () => {
    const old = pins.pinForRepo("TigreGotico/audiosronnx-gtcrn");
    const renamed = pins.pinForRepo("AudioSRonnx/gtcrn");
    expect(renamed).toBe(old);
    expect(renamed.revision).toBe("eeba5e9636e7e0aad93b25fad17471a9646d2640");
    expect(renamed.files["gtcrn_simple.onnx"]).toEqual({
      sha256: "e77603ac0c23dac3227dd2d7135b3a585cbee2679048aecfa886657d3ae1b534",
      bytes: 535638,
    });
    expect(pins.manifestFor("AudioSRonnx/gtcrn")).toEqual(
      pins.manifestFor("TigreGotico/audiosronnx-gtcrn"),
    );
    // It is a name for the pin, not a second pin: the pinned repository list does not grow.
    expect(pins.pinnedRepos()).not.toContain("AudioSRonnx/gtcrn");
  });
});

describe("English streaming speech is a pinned file set", () => {
  const set = weights.fileSets().find((row: { id: string }) => row.id === "moonshine-en");

  it("pins nine files by url, SHA-256 and bytes on the publisher's own host", () => {
    expect(set.files).toHaveLength(9);
    expect(set.license).toBe("MIT");
    expect(set.diskBytes).toBe(78075147);
    for (const file of set.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.url).toBe(
        `https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/${file.file}`,
      );
      expect(() => safety.assertAllowedUrl(file.url)).not.toThrow();
    }
    expect(new Set(set.files.map((f: { file: string }) => f.file)).size).toBe(9);
  });

  it("holds the weights the kernel looks for: more than one graph of 100 KB or more in one folder", () => {
    const big = set.files.filter(
      (f: { file: string; bytes: number }) => f.file.endsWith(".ort") && f.bytes >= 100_000,
    );
    expect(big.length).toBeGreaterThanOrEqual(5);
    expect(set.dir).toEqual(["models", "moonshine-en"]);
  });

  it("makes one job per file that lands in <root>/models/moonshine-en, optional with a fallback", () => {
    const jobs = weights.fileSetJobs("/r", "moonshine-en");
    expect(jobs).toHaveLength(9);
    for (const job of jobs) {
      expect(job.optional).toBe(true);
      expect(job.fallback).toMatch(/faster-whisper/);
      expect(job.job.modelId).toBe("moonshine-en");
      expect(job.job.dir).toBe(path.join("/r", "models"));
      expect(job.job.sources).toHaveLength(1);
      expect(job.job.sources[0]).toMatchObject({ kind: "url" });
      expect(job.job.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(weights.fileSetJobs("/r", "nope")).toEqual([]);
    expect(weights.fileSetJobs("", "moonshine-en")).toEqual([]);
  });

  it("is ready only when every file is on disk at its pinned size", () => {
    const sizes = new Map(
      set.files.map((f: { file: string; bytes: number }) => [
        path.join("/r", "models", "moonshine-en", f.file),
        f.bytes,
      ]),
    );
    const sizeOf = (file: string) => (sizes.has(file) ? (sizes.get(file) as number) : -1);
    expect(weights.fileSetReady("/r", "moonshine-en", { sizeOf })).toBe(true);
    sizes.set(path.join("/r", "models", "moonshine-en", "encoder.ort"), 5);
    expect(weights.fileSetReady("/r", "moonshine-en", { sizeOf })).toBe(false);
    sizes.delete(path.join("/r", "models", "moonshine-en", "encoder.ort"));
    expect(weights.fileSetReady("/r", "moonshine-en", { sizeOf })).toBe(false);
    expect(weights.fileSetReady("/r", "unknown", { sizeOf })).toBe(false);
  });

  it("the publisher's host is on the allowlist, one family, no wildcard", () => {
    expect(hosts.families.find((f) => f.id === "moonshine")?.hosts).toEqual([
      "download.moonshine.ai",
    ]);
    expect(() => safety.assertAllowedUrl("https://moonshine.ai/model/x")).toThrow();
  });
});

describe("the voice smoke test speaks Hindi and Hinglish too, and only warns", () => {
  const check = "PASS boot\nPASS local-tts engine=supertonic-3 voice=F1\n";
  /** A run stand-in: writes a wav for each `--speak` unless the text is in `mute`, answers stt.py with `heard`. */
  const runner =
    (options: { mute?: string[]; heard?: string; calls?: string[][] } = {}) =>
    (_exe: string, args: string[]) => {
      options.calls?.push(args);
      if (args.includes("--check")) return { status: 0, stdout: check };
      if (args.some((arg) => arg.endsWith("stt.py"))) {
        return { status: 0, stdout: JSON.stringify({ ok: true, text: options.heard ?? "" }) };
      }
      const text = String(args[args.indexOf("--text") + 1]);
      const out = String(args[args.indexOf("--out") + 1]);
      const muted = (options.mute || []).some((m) => text.includes(m));
      if (!muted) fs.writeFileSync(out, Buffer.alloc(5000));
      return { status: 0, stdout: JSON.stringify({ ok: !muted, reason: muted ? "no voice" : "" }) };
    };
  const quiet = () => {};

  it("speaks the English line, then a Devanagari Hindi line and a Hinglish line, in that order", () => {
    const calls: string[][] = [];
    const result = smoke.voiceSmoke({
      python: "py",
      fridayRoot: temp(),
      run: runner({ calls }),
      log: quiet,
    });
    const spoken = calls
      .filter((a) => a.includes("--speak"))
      .map((a) => a[a.indexOf("--text") + 1]);
    expect(spoken).toHaveLength(3);
    expect(spoken[0]).toBe("FRIDAY voice check.");
    expect(spoken[1]).toMatch(/[ऀ-ॿ]/);
    expect(spoken[2]).toMatch(/^[\x20-\x7E]+$/);
    expect(spoken[2]).toMatch(/FRIDAY/);
    expect(result).toEqual({ ok: true, problems: [], notes: [] });
  });

  it("a Hindi or Hinglish row that does not speak is a warning, never a problem", () => {
    const seen: string[] = [];
    const result = smoke.voiceSmoke({
      python: "py",
      fridayRoot: temp(),
      run: runner({ mute: ["नमस्ते", "Namaste"] }),
      log: (line: string) => seen.push(line),
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/Hindi/);
    expect(result.warnings[1]).toMatch(/Hinglish/);
    expect(seen.filter((line) => line.startsWith("WARN "))).toHaveLength(2);
  });

  it("an English line that fails fails the run and does not wait for the other two", () => {
    const calls: string[][] = [];
    const result = smoke.voiceSmoke({
      python: "py",
      fridayRoot: temp(),
      run: runner({ mute: ["FRIDAY voice check."], calls }),
      log: quiet,
    });
    expect(result.ok).toBe(false);
    expect(calls.filter((a) => a.includes("--speak"))).toHaveLength(1);
  });

  it("FRIDAY_VOICE_SMOKE_LANGS=0 and langs:false turn the extra rows off", () => {
    expect(smoke.languageRowsOn({ FRIDAY_VOICE_SMOKE_LANGS: "0" })).toBe(false);
    expect(smoke.languageRowsOn({})).toBe(true);
    expect(smoke.languageRowsOn({ FRIDAY_VOICE_SMOKE_LANGS: "1" })).toBe(true);
    const calls: string[][] = [];
    smoke.voiceSmoke({
      python: "py",
      fridayRoot: temp(),
      run: runner({ calls }),
      log: quiet,
      langs: false,
    });
    expect(calls.filter((a) => a.includes("--speak"))).toHaveLength(1);
  });

  it("decodes the Hindi clip back through the Hindi ear when it is on disk, and warns when it returns no Devanagari", () => {
    const calls: string[][] = [];
    const present = (file: string) => file.includes("hindi-ear");
    const ok = smoke.voiceSmoke({
      python: "py",
      fridayRoot: "/r",
      run: runner({ calls, heard: "नमस्ते यह जाँच है" }),
      log: quiet,
      exists: present,
    });
    expect(ok.warnings).toBeUndefined();
    const decode = calls.find((a) => a.some((arg) => arg.endsWith("stt.py")))!;
    expect(decode).toEqual(expect.arrayContaining(["--audio", "--language", "hi"]));
    expect(String(decode[decode.indexOf("--audio") + 1])).toMatch(/hindi\.wav$/);
    const bad = smoke.voiceSmoke({
      python: "py",
      fridayRoot: "/r",
      run: runner({ heard: "namaste" }),
      log: quiet,
      exists: present,
    });
    expect(bad.ok).toBe(true);
    expect(bad.warnings).toEqual([
      "the Hindi ear did not return Devanagari text for the Hindi test clip",
    ]);
  });

  it("skips the decode with a log line, not a warning, when the Hindi ear is not installed", () => {
    const calls: string[][] = [];
    const seen: string[] = [];
    const result = smoke.voiceSmoke({
      python: "py",
      fridayRoot: "/r",
      run: runner({ calls }),
      log: (line: string) => seen.push(line),
      exists: () => false,
    });
    expect(calls.some((a) => a.some((arg) => arg.endsWith("stt.py")))).toBe(false);
    expect(result.warnings).toBeUndefined();
    expect(seen.join("\n")).toMatch(/Hindi ear decode check skipped/);
  });

  it("a stand-in that throws on a language row cannot break the run", () => {
    let n = 0;
    const result = smoke.voiceSmoke({
      python: "py",
      fridayRoot: temp(),
      run: (_exe: string, args: string[]) => {
        if (args.includes("--check")) return { status: 0, stdout: check };
        n += 1;
        if (n > 1) throw new Error("boom");
        fs.writeFileSync(String(args[args.indexOf("--out") + 1]), Buffer.alloc(5000));
        return { status: 0, stdout: JSON.stringify({ ok: true, reason: "" }) };
      },
      log: quiet,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});
