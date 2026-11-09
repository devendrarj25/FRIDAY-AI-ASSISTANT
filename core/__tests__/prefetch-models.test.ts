/**
 * Build-time prefetch: speech, turn-taking and a small chat model land in the
 * FRIDAY folder during setup through the app's own verified downloader.
 * No network here: the downloader is a stand-in.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { BOOTSTRAP_MODEL_ID } from "../../src/lib/friday/first-run";
import { modelByTag, modelById, registryTag } from "../../src/lib/friday/model-catalog";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));

const quiet = {
  CI: "",
  GITHUB_ACTIONS: "",
  FRIDAY_SETUP_UPDATE: "0",
  FRIDAY_PREFETCH_MOONSHINE: "0",
  // The older plan (Ollama alone serves chat) is what most of these tests describe; llama.cpp has its own tests below.
  FRIDAY_PREFETCH_LLAMACPP: "0",
};

describe("build-time model prefetch", () => {
  it("plans the pinned voice files first, then speech base and small, her voice, a small chat model, and the big size last", () => {
    const jobs = prefetch.prefetchPlan("/friday", quiet, "linux");
    expect(jobs.map((row: { id: string }) => row.id)).toEqual([
      "smart-turn",
      "silero-vad",
      "stt-base",
      "stt-small",
      "stt-tiny", // the lite fallback for a weak or busy PC
      "supertonic-3",
      "qwen2.5-1.5b-instruct",
      "stt-medium", // the optional larger size is the biggest piece, so it goes last
      "stt-large-v3", // the most accurate size, only with 24 GB, optional
      "stt-large-v3-turbo", // the big size, only for a PC with the memory, after everything else
    ]);
    const small = jobs[3];
    expect(jobs[7]).toMatchObject({ id: "stt-medium", minRamGb: 8 });
    expect(jobs[8]).toMatchObject({ id: "stt-large-v3", minRamGb: 15, optional: true });
    expect(jobs[9]).toMatchObject({ id: "stt-large-v3-turbo", minRamGb: 15 });
    expect(jobs[9].job.sources[0]).toMatchObject({
      kind: "hf-repo",
      repo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    });
    expect(small.job.dir).toBe(path.join("/friday", "cache", "stt"));
    expect(small.job.sources[0]).toMatchObject({
      kind: "hf-repo",
      repo: "Systran/faster-whisper-small",
    });
    const vad = jobs[1];
    expect(vad.job.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vad.ready).toBe(path.join("/friday", "models", "silero-vad", "silero_vad.onnx"));
    expect(jobs[5].job.sources[0]).toMatchObject({
      kind: "hf-repo",
      repo: "Supertone/supertonic-3",
    });
    expect(jobs[5].job.dir).toBe(path.join("/friday", "models"));
    expect(jobs[6].job.sources[0].repo).toBe("Qwen/Qwen2.5-1.5B-Instruct-GGUF");
  });

  it("honours the opt-outs and stays off on hosted CI unless asked", () => {
    expect(prefetch.prefetchPlan("/friday", { ...quiet, FRIDAY_PREFETCH: "0" })).toEqual([]);
    expect(
      prefetch
        .prefetchPlan("/friday", { ...quiet, FRIDAY_PREFETCH_CHAT: "0" }, "linux")
        .some((row: { kind: string }) => row.kind === "chat"),
    ).toBe(false);
    expect(prefetch.prefetchPlan("/friday", { GITHUB_ACTIONS: "true" })).toEqual([]);
    expect(
      prefetch.prefetchPlan("/friday", { CI: "1", FRIDAY_PREFETCH: "1" }, "linux").length,
    ).toBe(10);
    // the big size can be left out on its own, and by the switch that leaves out every larger size
    const ids = (env: Record<string, string>) =>
      prefetch
        .prefetchPlan("/friday", { ...quiet, ...env }, "linux")
        .map((row: { id: string }) => row.id);
    expect(ids({ FRIDAY_PREFETCH_STT_BIG: "0" })).not.toContain("stt-large-v3-turbo");
    expect(ids({ FRIDAY_PREFETCH_STT_BIG: "0" })).toContain("stt-medium");
    expect(ids({ FRIDAY_PREFETCH_STT_LARGE: "0" })).not.toContain("stt-large-v3-turbo");
    expect(
      prefetch
        .prefetchPlan("/friday", { ...quiet, FRIDAY_PREFETCH_TTS: "0" }, "linux")
        .some((row: { kind: string }) => row.kind === "tts"),
    ).toBe(false);
    expect(prefetch.prefetchPlan("", quiet)).toEqual([]);
  });

  it("skips what is on disk and never throws when a source fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
    try {
      const base = path.join(dir, "cache", "stt", "base");
      mkdirSync(base, { recursive: true });
      writeFileSync(path.join(base, "config.json"), "{}");
      writeFileSync(path.join(base, "model.bin"), "x");
      const asked: string[] = [];
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        platform: "linux",
        env: quiet,
        log: (line: string) => lines.push(line),
        download: async (job: { modelId: string }) => {
          asked.push(job.modelId);
          if (job.modelId === "small") throw new Error("offline");
          return { ok: job.modelId !== "smart-turn", error: "HTTP 503", source: "stand-in" };
        },
      });
      expect(asked).not.toContain("base");
      expect(rows.find((row: { id: string }) => row.id === "stt-base")).toMatchObject({
        ok: true,
        downloaded: false,
      });
      expect(rows.find((row: { id: string }) => row.id === "stt-small")?.ok).toBe(false);
      expect(rows.find((row: { id: string }) => row.id === "smart-turn")?.error).toBe("HTTP 503");
      expect(lines.join("\n")).toContain("stt-small was not downloaded (offline)");
      expect(lines.join("\n")).toContain("smart-turn was not downloaded (HTTP 503)");
      // The step then fails with a report that names each model and the way forward.
      const report = prefetch.failureReport(rows).join("\n");
      expect(report).toContain("ACTION REQUIRED");
      expect(report).toContain("stt-small: offline");
      expect(report).toContain("smart-turn: HTTP 503");
      expect(report).toContain("npm run setup:python");
      expect(prefetch.failureReport([{ id: "x", ok: true }])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is wired into setup and verifies weights against the publisher's digest", () => {
    const setup = readFileSync(path.join(root, "scripts/setup-python.cjs"), "utf8");
    expect(setup).toContain('path.join(__dirname, "prefetch-models.cjs")');
    // A model that does not arrive stops the setup instead of waiting for the first use.
    expect(setup).toContain("fetched.status !== 0");
    expect(setup).toContain("FRIDAY_STT_MODEL_PATH: sttDir");
    const downloader = readFileSync(path.join(root, "electron/model-download.cjs"), "utf8");
    expect(downloader).toContain("/api/models/${repo}?blobs=true");
    expect(downloader).toContain('sha256: digest.sha256 || ""');
    const deps = readFileSync(path.join(root, "scripts/verify-deps.cjs"), "utf8");
    expect(deps).toContain("resolveVenvPython()");
  });
});

describe("Ollama install and lite models on Windows", () => {
  it("plans the pinned installer only on Windows and honours the opt-out", () => {
    const win = prefetch.prefetchPlan("C:/friday", quiet, "win32");
    const setup = win.find((row: { id: string }) => row.id === "ollama-setup");
    expect(setup.job.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.job.sources[0].url).toContain("github.com/ollama/ollama/releases/download");
    expect(
      prefetch
        .prefetchPlan("/friday", quiet, "linux")
        .some((r: { id: string }) => r.id === "ollama-setup"),
    ).toBe(false);
    expect(
      prefetch
        .prefetchPlan("C:/friday", { ...quiet, FRIDAY_PREFETCH_OLLAMA: "0" }, "win32")
        .some((r: { id: string }) => r.id === "ollama-setup"),
    ).toBe(false);
  });

  const row = {
    id: "ollama-setup",
    kind: "installer",
    ready: "C:/friday/runtime/installers/ollama/OllamaSetup.exe",
  };

  it("installs once, starts the daemon, and pulls the one light chat model", async () => {
    let up = false;
    const installs: string[] = [];
    const pulled: string[] = [];
    const fetchStub = async () => ({
      ok: up,
      json: async () => ({ models: [] }),
    });
    const lines: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", row, {
      log: (line: string) => lines.push(line),
      deps: {
        fetch: fetchStub,
        exists: (file: string) => file.endsWith("OllamaSetup.exe"),
        signed: async () => ({ ok: true }),
        runInstaller: async (file: string) => {
          installs.push(file);
          return { ok: true };
        },
        startOllama: () => {
          up = true;
        },
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
        waitMs: 1,
        skipAnswerCheck: true,
        totalGb: 32,
        ollamaExe: "C:/nowhere/ollama.exe",
      },
    });
    expect(installs).toEqual([row.ready]);
    expect(pulled).toEqual(["qwen2.5:1.5b", "qwen3:4b"]);
    expect(rows.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("does not run an installer whose signature is not valid, and never throws", async () => {
    const installs: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", row, {
      log: () => {},
      deps: {
        fetch: async () => ({ ok: false }),
        exists: (file: string) => file.endsWith("OllamaSetup.exe"),
        ollamaExe: "C:/nowhere/ollama.exe",
        signed: async () => ({ ok: false, reason: "NotSigned" }),
        runInstaller: async (file: string) => {
          installs.push(file);
          return { ok: true };
        },
      },
    });
    expect(installs).toEqual([]);
    expect(rows[0]).toMatchObject({ id: "ollama", ok: false, error: "signature" });
  });

  it("skips a pull for a model already present", async () => {
    const pulled: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", row, {
      log: () => {},
      deps: {
        ramGb: 4,
        fetch: async () => ({
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }),
        }),
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
      },
    });
    expect(pulled).toEqual([]);
    expect(rows.find((r: { id: string }) => r.id === "qwen2.5:1.5b")).toMatchObject({
      downloaded: false,
    });
  });

  it("reports a failed pull without failing the build", async () => {
    const lines: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", row, {
      log: (line: string) => lines.push(line),
      deps: {
        fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
        pull: async () => ({ ok: false, error: "network" }),
      },
    });
    expect(rows.find((r: { id: string }) => r.id === "qwen2.5:1.5b")).toMatchObject({ ok: false });
    expect(lines.join("\n")).toContain("FRIDAY pulls it on first use");
  });

  it("parses the streamed pull and reports percent", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      '{"status":"pulling","total":100,"completed":40}\n{"status":"pulling","total":100,"completed":100}\n',
      '{"status":"success"}\n',
    ];
    const events: number[] = [];
    const result = await prefetch.ollamaPull("qwen2.5:1.5b", {
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
      }),
      onEvent: (event: { progress: number }) => events.push(event.progress),
    });
    expect(result).toEqual({ ok: true });
    expect(events).toEqual([40, 100]);
  });
});

describe("an Ollama that is already on this PC", () => {
  const win = "win32";

  it("plans no installer when Ollama is already installed", () => {
    const jobs = prefetch.prefetchPlan("C:/friday", quiet, win, { ollama: true });
    expect(jobs.some((r: { id: string }) => r.id === "ollama-setup")).toBe(false);
    expect(
      prefetch
        .prefetchPlan("C:/friday", quiet, win, { ollama: false })
        .some((r: { id: string }) => r.id === "ollama-setup"),
    ).toBe(true);
  });

  it("finds Ollama on PATH or in its standard folders and reads the client version", () => {
    const home = "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const found = prefetch.findOllama({
      env: { PATH: "", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      exists: (file: string) => file === home,
      version: () => "0.40.4",
    });
    expect(found).toEqual({ exe: home, version: "0.40.4" });
    expect(
      prefetch.findOllama({ env: { PATH: "" }, exists: () => false, version: () => "1" }),
    ).toBeNull();
  });

  it("downloads no installer, reuses the installed Ollama, and still pulls the missing models", async () => {
    const fetched: string[] = [];
    const pulled: string[] = [];
    const lines: string[] = [];
    const rows = await prefetch.prefetch("C:/friday", {
      env: {
        ...quiet,
        FRIDAY_AUTO_INSTALL: "1",
        FRIDAY_PREFETCH_CHAT: "0",
        FRIDAY_PREFETCH_TTS: "0",
        FRIDAY_PREFETCH_LLAMACPP: "0",
      },
      platform: win,
      log: (line: string) => lines.push(line),
      download: async (job: { modelId: string; dir: string }) => {
        fetched.push(job.modelId);
        return { ok: true };
      },
      latest: async () => ({ tag: "v9.9.9", url: "x", sha256: "", source: "pinned" }),
      ollama: {
        find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
        fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
        signed: async () => {
          throw new Error("an installed Ollama must not be re-verified or reinstalled");
        },
        runInstaller: async () => {
          throw new Error("must not reinstall");
        },
        ramGb: 32,
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
      },
    });
    expect(fetched).not.toContain("ollama");
    expect(pulled).toEqual(["qwen2.5:1.5b", "qwen3:4b"]);
    expect(rows.find((r: { id: string }) => r.id === "ollama")).toMatchObject({ ok: true });
    const log = lines.join("\n");
    expect(log).toContain("ollama 0.40.4 already installed");
    expect(log).toContain("nothing to download");
    expect(log).toContain("v9.9.9 is available");
  });

  it("downloads the newest official release, with its own digest, only when Ollama is missing", async () => {
    const jobs: { modelId: string; sources: { url: string; sha256: string }[] }[] = [];
    await prefetch.prefetch("C:/friday", {
      env: {
        ...quiet,
        FRIDAY_AUTO_INSTALL: "0",
        FRIDAY_PREFETCH_CHAT: "0",
        FRIDAY_PREFETCH_TTS: "0",
        FRIDAY_PREFETCH_LLAMACPP: "0",
      },
      platform: win,
      log: () => {},
      download: async (job: (typeof jobs)[number]) => {
        jobs.push(job);
        return { ok: true };
      },
      latest: async () => ({
        tag: "v9.9.9",
        url: "https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe",
        sha256: "a".repeat(64),
        bytes: 5,
        source: "live",
      }),
      ollama: {
        find: () => null,
        fetch: async () => ({ ok: false }),
      },
    });
    const setup = jobs.find((job) => job.modelId === "ollama");
    expect(setup?.sources[0]).toMatchObject({ sha256: "a".repeat(64) });
    expect(setup?.sources[0]?.url).toContain("/v9.9.9/");
    expect(setup?.sources[1]?.url).toBe("https://ollama.com/download/OllamaSetup.exe");
    expect(setup?.sources[1]?.sha256).toBe("a".repeat(64));
  });
});

describe("one local chat model, and nothing downloaded twice", () => {
  const library = require_(path.join(root, "electron/local-library.cjs"));
  const win = "win32";

  it("keeps one light model first and the bigger tiers optional, gated by memory", () => {
    const models = library.ollamaModels();
    const tags = models.map((m: { tag: string }) => m.tag);
    expect(tags).toEqual(["qwen2.5:1.5b", "qwen3:4b"]);
    expect(prefetch.OLLAMA_MODELS.map((m: { tag: string }) => m.tag)).toEqual(tags);
    expect(models[0]).toMatchObject({ minRamGb: 0, optional: false });
    for (const bigger of models.slice(1)) {
      expect(bigger.optional).toBe(true);
      expect(bigger.minRamGb).toBe(7);
    }
  });

  it("routes by size: a small model is a fast-role model, a large one is a brain", () => {
    const models_ = require_(path.join(root, "electron/models.cjs"));
    for (const name of ["qwen2.5:1.5b", "qwen2.5:0.5b", "llama3.2:1b", "phi3:3.8b", "gemma3:4b"]) {
      expect(models_.inferRole(name)).toBe("fast");
    }
    for (const name of ["llama3.1:8b", "qwen3:14b", "qwen2.5:72b", "gpt-5"]) {
      expect(models_.inferRole(name)).toBe("brain");
    }
    expect(models_.inferRole("qwen2.5-coder:1.5b")).toBe("coder");
  }, 30_000);

  it("does not pull a model Ollama already holds", async () => {
    const pulled: string[] = [];
    const lines: string[] = [];
    await prefetch.ensureOllama("C:/friday", null, {
      log: (l: string) => lines.push(l),
      deps: {
        totalGb: 64,
        fetch: async () => ({
          ok: true,
          json: async () => ({
            models: ["qwen2.5:1.5b", "qwen3:4b"].map((name) => ({
              name,
            })),
          }),
        }),
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
      },
    });
    expect(pulled).toEqual([]);
    expect(lines.join("\n")).toContain("verified, not pulled again");
  });

  it("plans the separate Qwen GGUF only where Ollama will not provide the same model", () => {
    const has = (env: Record<string, string>, platform: string) =>
      prefetch
        .prefetchPlan("C:/friday", { ...quiet, ...env }, platform)
        .some((r: { kind: string }) => r.kind === "chat");
    expect(has({}, win)).toBe(false);
    expect(has({ FRIDAY_AUTO_INSTALL: "0" }, win)).toBe(true);
    expect(has({ FRIDAY_PREFETCH_OLLAMA: "0" }, win)).toBe(true);
    expect(has({}, "linux")).toBe(true);
  });

  it("fetches the GGUF as a fallback only when Ollama could not provide the small model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
    try {
      const fetched: string[] = [];
      const baseOptions = {
        env: { ...quiet, FRIDAY_AUTO_INSTALL: "1", FRIDAY_PREFETCH: "1" },
        platform: win,
        log: () => {},
        download: async (job: { modelId: string }) => {
          fetched.push(job.modelId);
          return { ok: true };
        },
        latest: async () => null,
      };
      const ollama = (pullOk: boolean) => ({
        find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
        fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
        totalGb: 64,
        pull: async () => (pullOk ? { ok: true } : { ok: false, error: "network" }),
      });
      await prefetch.prefetch(dir, { ...baseOptions, ollama: ollama(true) });
      expect(fetched).not.toContain("qwen2.5-1.5b-instruct");
      await prefetch.prefetch(dir, { ...baseOptions, ollama: ollama(false) });
      expect(fetched).toContain("qwen2.5-1.5b-instruct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("the small chat model when Ollama's registry cannot be reached", () => {
    // The owner's PC: the pull timed out on Ollama's storage host, the GGUF copy still arrived in full,
    // and the old step reported the model as not finished (exit 1), which also stopped the Python packages.
    const gguf = (dir: string) => path.join(dir, "models", "qwen2.5-1.5b-instruct");
    const setup = (dir: string, opts: { pull: unknown; register: unknown; onDisk?: boolean }) => {
      const fetched: string[] = [];
      const registered: { name: string; file: string }[] = [];
      const lines: string[] = [];
      if (opts.onDisk) {
        mkdirSync(gguf(dir), { recursive: true });
        writeFileSync(path.join(gguf(dir), "qwen2.5-1.5b-instruct-q4_k_m.gguf"), "g");
      }
      const options = {
        env: {
          ...quiet,
          FRIDAY_AUTO_INSTALL: "1",
          FRIDAY_PREFETCH: "1",
          FRIDAY_MODEL_FRESHNESS: "0",
        },
        platform: win,
        log: (line: string) => lines.push(line),
        download: async (job: { modelId: string }) => {
          fetched.push(job.modelId);
          if (job.modelId === "qwen2.5-1.5b-instruct") {
            mkdirSync(gguf(dir), { recursive: true });
            writeFileSync(path.join(gguf(dir), "qwen2.5-1.5b-instruct-q4_k_m.gguf"), "g");
          }
          return { ok: true };
        },
        latest: async () => null,
        totalGb: 4,
        ollama: {
          find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
          fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
          pull: opts.pull,
          register: async (name: string, file: string) => {
            registered.push({ name, file });
            return (opts.register as (n: string) => unknown)(name);
          },
        },
      };
      return { options, fetched, registered, lines };
    };

    it("takes the GGUF copy, registers it under the tag, and reports no failure", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        const t = setup(dir, {
          pull: async () => ({ ok: false, error: "max retries exceeded: connectex" }),
          register: async () => ({ ok: true }),
        });
        const rows = await prefetch.prefetch(dir, t.options);
        expect(t.fetched).toContain("qwen2.5-1.5b-instruct");
        expect(t.registered.map((r) => r.name)).toEqual(["qwen2.5:1.5b"]);
        expect(rows.find((r: { id: string }) => r.id === "qwen2.5:1.5b")).toMatchObject({
          ok: true,
          via: "gguf",
        });
        expect(prefetch.failureReport(rows)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("registers a GGUF that is already on disk without asking the registry or downloading", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        const t = setup(dir, {
          pull: async () => {
            throw new Error("the registry must not be asked when the file is here");
          },
          register: async () => ({ ok: true }),
          onDisk: true,
        });
        const rows = await prefetch.prefetch(dir, t.options);
        expect(t.fetched).not.toContain("qwen2.5-1.5b-instruct");
        expect(t.registered).toHaveLength(1);
        expect(t.lines.join("\n")).toContain("registering the GGUF already on disk");
        expect(prefetch.failureReport(rows)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps going, not failing, when Ollama will not register the file it holds", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        const t = setup(dir, {
          pull: async () => ({ ok: false, error: "no route" }),
          register: async () => ({ ok: false, error: "HTTP 500" }),
          onDisk: true,
        });
        const rows = await prefetch.prefetch(dir, t.options);
        expect(rows.find((r: { id: string }) => r.id === "qwen2.5:1.5b")).toMatchObject({
          ok: true,
          via: "gguf-file",
        });
        expect(t.lines.join("\n")).toContain("Ollama did not register it (HTTP 500)");
        expect(prefetch.failureReport(rows)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still fails when the model is in neither place", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        const t = setup(dir, {
          pull: async () => ({ ok: false, error: "no route" }),
          register: async () => ({ ok: true }),
        });
        t.options.download = async (job: { modelId: string }) =>
          job.modelId === "qwen2.5-1.5b-instruct" ? { ok: false, error: "HTTP 503" } : { ok: true };
        const rows = await prefetch.prefetch(dir, t.options);
        const report = prefetch.failureReport(rows).join("\n");
        expect(report).toContain("qwen2.5-1.5b-instruct: HTTP 503");
        expect(report).toContain("qwen2.5:1.5b: no route");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("keeping Ollama on the newest official release", () => {
    const newest = {
      tag: "v9.9.9",
      url: "https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe",
      sha256: "a".repeat(64),
      bytes: 1_600_000_000,
      source: "live",
    };
    const run = async (
      overrides: Record<string, unknown> = {},
      env: Record<string, string> = {},
    ) => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      const policyRoot = mkdtempSync(path.join(tmpdir(), "friday-policy-"));
      const lines: string[] = [];
      const jobs: { sources: { url: string; sha256: string }[] }[] = [];
      const ran: string[][] = [];
      try {
        const rows = await prefetch.prefetch(dir, {
          env: {
            CI: "",
            GITHUB_ACTIONS: "",
            FRIDAY_AUTO_INSTALL: "1",
            FRIDAY_PREFETCH_CHAT: "0",
            FRIDAY_PREFETCH_TTS: "0",
            FRIDAY_PREFETCH_LLAMACPP: "0",
            FRIDAY_SETUP_UPDATE: "1",
            ...env,
          },
          platform: win,
          policyRoot,
          log: (line: string) => lines.push(line),
          download: async (job: (typeof jobs)[number]) => {
            jobs.push(job);
            return { ok: true };
          },
          latest: async () => newest,
          totalGb: 4,
          ollama: {
            find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
            fetch: async () => ({
              ok: true,
              json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }),
            }),
            signed: async () => ({ ok: true }),
            runInstaller: async (_file: string, args: string[]) => {
              ran.push(args);
              return { ok: true };
            },
            startOllama: () => {},
            waitMs: 1,
            skipAnswerCheck: true,
            ...overrides,
          },
        });
        return { rows, lines: lines.join("\n"), jobs, ran };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(policyRoot, { recursive: true, force: true });
      }
    };

    it("downloads the newest installer by its own digest and installs it over the old one", async () => {
      const r = await run();
      const installer = r.jobs.find((job) => job.sources[0]?.url === newest.url);
      expect(installer?.sources[0]?.sha256).toBe(newest.sha256);
      expect(r.ran).toEqual([["/CLOSEAPPLICATIONS"]]);
      expect(r.lines).toContain("updating Ollama 0.40.4 -> v9.9.9");
      expect(r.lines).toContain("ollama updated to v9.9.9");
    });

    it("keeps the installed Ollama when the installer will not run, and does not fail", async () => {
      const r = await run({ runInstaller: async () => ({ ok: false, error: "exit code 5" }) });
      expect(r.lines).toContain("ollama update did not finish (exit code 5)");
      expect(r.rows.filter((row: { ok: boolean }) => !row.ok)).toEqual([]);
    });

    it("refuses an installer whose signature is not valid", async () => {
      const r = await run({ signed: async () => ({ ok: false, reason: "not signed" }) });
      expect(r.ran).toEqual([]);
      expect(r.lines).toContain("ollama update skipped (signature: not signed)");
    });

    it("does not update with no published digest, and says why", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        const lines: string[] = [];
        await prefetch.prefetch(dir, {
          env: {
            CI: "",
            GITHUB_ACTIONS: "",
            FRIDAY_AUTO_INSTALL: "1",
            FRIDAY_PREFETCH_CHAT: "0",
            FRIDAY_PREFETCH_TTS: "0",
            FRIDAY_PREFETCH_LLAMACPP: "0",
            FRIDAY_SETUP_UPDATE: "1",
          },
          platform: win,
          policyRoot: dir,
          log: (line: string) => lines.push(line),
          download: async () => ({ ok: true }),
          latest: async () => ({ ...newest, sha256: "" }),
          totalGb: 4,
          ollama: {
            find: () => ({ exe: "C:/Ollama/ollama.exe", version: "0.40.4" }),
            fetch: async () => ({
              ok: true,
              json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }),
            }),
            runInstaller: async () => {
              throw new Error("must not run without a digest");
            },
          },
        });
        expect(lines.join("\n")).toContain("its official digest could not be read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("leaves Ollama alone when updates are switched off", async () => {
      const r = await run(
        {
          runInstaller: async () => {
            throw new Error("updates are off");
          },
        },
        { FRIDAY_SETUP_UPDATE: "0" },
      );
      expect(r.ran).toEqual([]);
      expect(r.lines).toContain("updates are switched off here");
    });
  });

  it("gives up an Ollama pull that makes no progress instead of retrying for minutes", async () => {
    const started = Date.now();
    const result = await prefetch.ollamaPull("qwen2.5:1.5b", {
      idleMs: 40,
      fetchImpl: (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no progress for/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a second run downloads nothing that is already on disk and verified", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
    try {
      for (const size of ["tiny", "base", "small"]) {
        const stt = path.join(dir, "cache", "stt", size);
        mkdirSync(stt, { recursive: true });
        writeFileSync(path.join(stt, "config.json"), "{}");
        writeFileSync(path.join(stt, "model.bin"), "x");
      }
      const voice = path.join(dir, "models", "supertonic-3");
      mkdirSync(voice, { recursive: true });
      writeFileSync(path.join(voice, ".friday-complete"), "done");
      const chat = path.join(dir, "models", "qwen2.5-1.5b-instruct");
      mkdirSync(chat, { recursive: true });
      writeFileSync(path.join(chat, "qwen2.5-1.5b-instruct-q4_k_m.gguf"), "x");
      const fetched: string[] = [];
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        env: quiet,
        platform: "linux",
        totalGb: 4,
        log: (l: string) => lines.push(l),
        download: async (job: { modelId: string }) => {
          fetched.push(job.modelId);
          return { ok: true };
        },
      });
      // Only the two pinned voice files (their digests do not match this stand-in) are fetched.
      expect(fetched.sort()).toEqual(["silero-vad", "smart-turn"]);
      // tiny, base, small, the voice, the chat model, and the three larger sizes skipped for lack of memory.
      expect(rows.filter((r: { downloaded?: boolean }) => r.downloaded === false)).toHaveLength(8);
      expect(lines.join("\n")).toContain("verified on disk; not downloaded again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the offline voice", () => {
  it("writes its completion marker only after the whole voice downloaded", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
    try {
      const marker = path.join(dir, "models", "supertonic-3", ".friday-complete");
      const run = (ok: boolean) =>
        prefetch.prefetch(dir, {
          env: { ...quiet, FRIDAY_PREFETCH_CHAT: "0" },
          platform: "linux",
          log: () => {},
          download: async (job: { modelId: string }) =>
            job.modelId === "supertonic-3" && !ok ? { ok: false, error: "network" } : { ok: true },
        });
      await run(false);
      expect(existsSync(marker)).toBe(false);
      await run(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("speech sizes", () => {
  it("keeps two light sizes for live talk and a larger one for long or hard speech, RAM permitting", async () => {
    const run = async (totalGb: number, env: Record<string, string> = {}) => {
      const fetched: string[] = [];
      const lines: string[] = [];
      const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
      try {
        await prefetch.prefetch(dir, {
          env: {
            ...quiet,
            FRIDAY_PREFETCH_CHAT: "0",
            FRIDAY_PREFETCH_TTS: "0",
            FRIDAY_PREFETCH_LLAMACPP: "0",
            ...env,
          },
          platform: "linux",
          totalGb,
          log: (l: string) => lines.push(l),
          download: async (job: { modelId: string }) => {
            fetched.push(job.modelId);
            return { ok: true };
          },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return { fetched, log: lines.join("\n") };
    };
    const roomy = await run(16);
    expect(roomy.fetched).toEqual(expect.arrayContaining(["base", "small", "medium"]));
    const tight = await run(4);
    expect(tight.fetched).toEqual(expect.arrayContaining(["base", "small"]));
    expect(tight.fetched).not.toContain("medium");
    expect(tight.log).toContain("stt-medium skipped: needs 8 GB RAM");
    const off = await run(16, { FRIDAY_PREFETCH_STT_LARGE: "0" });
    expect(off.fetched).not.toContain("medium");
  });
});

describe("the app and the build agree on the one local chat model", () => {
  it("first run asks for the same Ollama tag that setup pulls, so nothing is downloaded twice", () => {
    const spec = modelById.get(BOOTSTRAP_MODEL_ID);
    expect(spec).toBeTruthy();
    expect(registryTag(spec!)).toBe(prefetch.OLLAMA_MODELS[0].tag);
    expect(modelByTag(prefetch.OLLAMA_MODELS[0].tag)?.id).toBe(BOOTSTRAP_MODEL_ID);
  });
});

describe("prefetch resilience and the English streaming speech", () => {
  it("tells a network blip from a wrong file", () => {
    for (const text of [
      "offline",
      "getaddrinfo ENOTFOUND huggingface.co",
      "dial tcp: lookup registry.ollama.ai: no such host",
      "no byte for 60s",
      "HTTP 503",
    ]) {
      expect(prefetch.looksTransient(text), text).toBe(true);
    }
    for (const text of ["SHA-256 mismatch", "signature", "installer missing", ""]) {
      expect(prefetch.looksTransient(text), text).toBe(false);
    }
  });

  it("runs the step again after a short outage and stops when only wrong files are left", async () => {
    const waits: number[] = [];
    let call = 0;
    const dir = mkdtempSync(path.join(tmpdir(), "friday-retry-"));
    try {
      const download = async () => {
        call += 1;
        return call < 3 ? { ok: false, error: "offline" } : { ok: true, bytes: 1 };
      };
      const options = {
        platform: "linux",
        env: { ...quiet, FRIDAY_PREFETCH_MOONSHINE: "0", FRIDAY_MODEL_FRESHNESS: "0" },
        log: () => {},
        download,
      };
      // Every job fails on the first call, so round one is all failures and the line is retried.
      const rows = await prefetch.prefetchWithRetries(dir, options, {
        wait: async (ms: number) => void waits.push(ms),
        rounds: 3,
      });
      expect(waits.length).toBeGreaterThanOrEqual(1);
      expect(waits[0]).toBe(15_000);
      expect(rows.length).toBeGreaterThan(0);

      waits.length = 0;
      const wrong = await prefetch.prefetchWithRetries(
        dir,
        { ...options, download: async () => ({ ok: false, error: "SHA-256 mismatch" }) },
        { wait: async (ms: number) => void waits.push(ms), rounds: 3 },
      );
      expect(waits).toEqual([]);
      expect(wrong.some((row: { ok: boolean }) => !row.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits through exitCode so Windows never aborts on closing sockets", () => {
    const source = readFileSync(path.join(root, "scripts/prefetch-models.cjs"), "utf8");
    const tail = source.slice(source.indexOf("if (require.main === module)"));
    expect(tail).toContain("process.exitCode = code");
    expect(tail).toMatch(/setTimeout\(\(\) => process\.exit\(code\), 5000\)/);
    expect(tail).toContain("force.unref()");
    expect(tail).not.toMatch(/^\s*process\.exit\((?!code)/m);
  });

  it("fetches the English streaming weights once, with the venv Python, and is quiet when they are there", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-moon-"));
    try {
      const lines: string[] = [];
      const log = (line: string) => void lines.push(line);
      const target = path.join(dir, "models", "moonshine-en");
      // No Python yet: skipped, not failed.
      expect(await prefetch.fetchMoonshine(dir, { env: {}, log })).toMatchObject({
        ok: true,
        skipped: true,
      });
      expect(prefetch.moonshineReady(target)).toBe(false);

      const calls: string[][] = [];
      const run = (python: string, args: string[]) => {
        calls.push([python, ...args]);
        mkdirSync(path.join(target, "download.moonshine.ai", "model"), { recursive: true });
        writeFileSync(
          path.join(target, "download.moonshine.ai", "model", "encoder.ort"),
          Buffer.alloc(200_000),
        );
        return { status: 0, stdout: "MOONSHINE_OK x", stderr: "" };
      };
      const first = await prefetch.fetchMoonshine(dir, { env: { FRIDAY_PYTHON: "py" }, log, run });
      expect(first).toMatchObject({ id: "moonshine-en", ok: true, downloaded: true });
      expect(calls[0]![0]).toBe("py");
      expect(calls[0]![2]).toContain("TINY_STREAMING");
      expect(calls[0]![3]).toBe(target);
      expect(prefetch.moonshineReady(target)).toBe(true);

      const again = await prefetch.fetchMoonshine(dir, { env: { FRIDAY_PYTHON: "py" }, log, run });
      expect(again).toMatchObject({ ok: true, downloaded: false });
      expect(calls.length).toBe(1);

      rmSync(target, { recursive: true, force: true });
      const failed = await prefetch.fetchMoonshine(dir, {
        env: { FRIDAY_PYTHON: "py" },
        log,
        run: () => ({ status: 1, stdout: "", stderr: "ConnectionError: offline" }),
      });
      expect(failed).toMatchObject({ ok: false });
      expect(failed.error).toContain("offline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the kernel and the fetch agree on where the English weights live", () => {
    const stt = readFileSync(path.join(root, "kernel/stt.py"), "utf8");
    expect(stt).toContain('base / "models" / "moonshine-en"');
    expect(stt).toContain("ModelArch.TINY_STREAMING");
  });
});

describe("download speed", () => {
  it("the Hugging Face client gets more time to move its first byte on a big model", () => {
    const hub = require_(path.join(root, "electron/hf-hub-download.cjs"));
    expect(hub.startWindowMs(0)).toBe(25_000);
    expect(hub.startWindowMs(141 * 1024 ** 2)).toBe(27_000);
    expect(hub.startWindowMs(1457 * 1024 ** 2)).toBe(25_000 + 14 * 2000);
    expect(hub.startWindowMs(50 * 1024 ** 3)).toBe(120_000);
  });

  it("the 1.6 GB Ollama update waits until every speech, voice and chat file is in place", () => {
    const source = readFileSync(path.join(root, "scripts/prefetch-models.cjs"), "utf8");
    const run = source.slice(source.indexOf("async function prefetch("));
    expect(run.indexOf("const updateOllamaLast = async")).toBeGreaterThan(0);
    expect(run.indexOf("await updateOllamaLast();")).toBeGreaterThan(run.indexOf("mapPool(jobs"));
    expect(run.indexOf("await updateOllamaLast();")).toBeGreaterThan(
      run.indexOf("ensureOllama(root"),
    );
    // The update function is only defined before the downloads, never called there.
    expect(run.slice(0, run.indexOf("mapPool(jobs")).includes("await updateOllamaLast()")).toBe(
      false,
    );
  });

  it("English streaming speech downloads beside the big files, not after them", () => {
    const source = readFileSync(path.join(root, "scripts/prefetch-models.cjs"), "utf8");
    const run = source.slice(source.indexOf("async function prefetch("));
    expect(run.indexOf("const moonshineRun")).toBeLessThan(run.indexOf("mapPool(jobs"));
    expect(run).toContain("rows.push(await moonshineRun)");
  });
});

describe("the live download board", () => {
  const board = require_(path.join(root, "scripts/download-board.cjs"));
  const clockAt = (() => {
    let t = 0;
    const fn = () => t;
    fn.set = (v: number) => (t = v);
    return fn;
  })();

  it("draws a row with a bar, sizes, speed, time left and connections", () => {
    const line = board.renderRow({
      id: "stt-small",
      state: "running",
      percent: 50,
      bytesDone: 232 * 1024 ** 2,
      bytesTotal: 464 * 1024 ** 2,
      speed: 15.4,
      eta: 15,
      connections: 8,
    });
    expect(line).toContain("[############------------]");
    expect(line).toContain(" 50%");
    expect(line).toContain("232 MB/464 MB");
    expect(line).toContain("15.4 MB/s");
    expect(line).toContain("15s left");
    expect(line).toContain("8 conn");
    expect(board.renderRow({ id: "x", state: "queued" })).toContain("waiting");
    expect(board.renderRow({ id: "x", state: "done", note: "ready", seconds: 75 })).toContain(
      "in 1m15s",
    );
    expect(board.renderRow({ id: "x", state: "failed", note: "offline" })).toContain("FAILED");
  });

  it("adds up the whole step: done count, bytes, line speed and time left", () => {
    const lines: string[] = [];
    clockAt.set(0);
    const ui = new board.DownloadBoard({
      tty: false,
      now: clockAt,
      log: (l: string) => lines.push(l),
    });
    ui.start([
      { id: "a", approxBytes: 100 * 1024 ** 2 },
      { id: "b", approxBytes: 300 * 1024 ** 2 },
    ]);
    expect(lines[0]).toContain("download plan (2): a 100 MB, b 300 MB");
    clockAt.set(10_000);
    ui.update("a", {
      progress: 100,
      bytesDone: 100 * 1024 ** 2,
      bytesTotal: 100 * 1024 ** 2,
      speedMbps: 10,
    });
    ui.finish("a", { ok: true, bytes: 100 * 1024 ** 2, note: "10.0 MB/s average" });
    ui.update("b", {
      progress: 25,
      bytesDone: 75 * 1024 ** 2,
      bytesTotal: 300 * 1024 ** 2,
      speedMbps: 20,
    });
    const total = ui.total();
    expect(total).toMatchObject({ done: 1, count: 2, speed: 20 });
    expect(total.bytesDone).toBe(175 * 1024 ** 2);
    expect(total.bytesTotal).toBe(400 * 1024 ** 2);
    expect(board.renderOverall(total)).toContain("1/2 ready");
    expect(board.renderOverall(total)).toContain("11s left");
    // Non-terminal output: a line per ten percent of a file, never one per event.
    const before = lines.length;
    ui.update("b", { progress: 26, bytesDone: 78 * 1024 ** 2, bytesTotal: 300 * 1024 ** 2 });
    expect(lines.length).toBe(before);
    ui.update("b", { progress: 31, bytesDone: 93 * 1024 ** 2, bytesTotal: 300 * 1024 ** 2 });
    expect(lines.length).toBe(before + 1);
  });

  it("redraws in place in a terminal, keeps other messages above the board, and stops cleanly", () => {
    let out = "";
    const stream = { isTTY: true, write: (text: string) => void (out += text) };
    clockAt.set(0);
    const ui = new board.DownloadBoard({ stream, tty: true, now: clockAt, intervalMs: 1_000_000 });
    ui.start([{ id: "a", approxBytes: 10 * 1024 ** 2 }]);
    const first = out.split("\n").length;
    ui.say("[friday] update   a: 1 file(s) changed upstream, fetching them");
    expect(out).toContain("\x1b[2A\x1b[J"); // cursor up over the board (1 row + the overall line) and clear
    expect(out).toContain("[friday] update   a");
    ui.update("a", {
      progress: 40,
      bytesDone: 4 * 1024 ** 2,
      bytesTotal: 10 * 1024 ** 2,
      speedMbps: 5,
    });
    ui.finish("a", { ok: true, note: "ready" });
    ui.stop();
    const tail = out.slice(out.lastIndexOf("[friday] a"));
    expect(tail).toContain("100%");
    ui.say("after stop");
    expect(out.endsWith("after stop\n")).toBe(true);
    expect(first).toBeGreaterThan(1);
  });

  it("a real run builds the board, feeds it, and a test run with its own downloader stays plain", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-board-"));
    try {
      const lines: string[] = [];
      const ui = new board.DownloadBoard({ tty: false, log: (l: string) => lines.push(l) });
      const rows = await prefetch.prefetch(dir, {
        platform: "linux",
        env: { ...quiet, FRIDAY_PREFETCH_STT_LARGE: "0", FRIDAY_MODEL_FRESHNESS: "0" },
        log: (l: string) => lines.push(l),
        board: ui,
        download: async (_job: unknown, onEvent: (e: unknown) => void) => {
          onEvent({ progress: 50, bytesDone: 5, bytesTotal: 10, speedMbps: 1 });
          return { ok: true, bytes: 10, source: "stand-in" };
        },
      });
      expect(rows.every((row: { ok: boolean }) => row.ok)).toBe(true);
      expect(lines.some((l) => l.includes("download plan ("))).toBe(true);
      expect(lines.some((l) => l.includes("ALL") && l.includes("ready"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("voice model tiers in setup: lite, large and the bigger chat models", () => {
  const plan = (env: Record<string, string> = {}) =>
    prefetch
      .prefetchPlan("/friday", { FRIDAY_PREFETCH: "1", ...env }, "win32", {})
      .map((job: { id: string }) => job.id);

  it("plans the lite tiny size for every PC and the 3 GB large-v3 only with enough memory", () => {
    const jobs = prefetch.prefetchPlan("/friday", { FRIDAY_PREFETCH: "1" }, "win32", {});
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(
      expect.arrayContaining(["stt-tiny", "stt-large-v3-turbo", "stt-large-v3"]),
    );
    const tiny = jobs.find((j: { id: string }) => j.id === "stt-tiny");
    expect(tiny.minRamGb).toBeUndefined();
    const max = jobs.find((j: { id: string }) => j.id === "stt-large-v3");
    expect(max).toMatchObject({ minRamGb: 15, optional: true });
    expect(jobs.find((j: { id: string }) => j.id === "stt-large-v3-turbo").minRamGb).toBe(15);
  });

  it("lets the owner leave the lite and max sizes out", () => {
    expect(plan({ FRIDAY_PREFETCH_STT_LITE: "0" })).not.toContain("stt-tiny");
    expect(plan({ FRIDAY_PREFETCH_STT_MAX: "0" })).not.toContain("stt-large-v3");
    expect(plan({ FRIDAY_PREFETCH_STT_LARGE: "0" })).not.toContain("stt-large-v3");
  });

  it("skips the smart model below 7 GB and never fails on it, since it is optional", async () => {
    const run = async (ramGb: number, ok: boolean) => {
      const pulled: string[] = [];
      const rows = await prefetch.ensureOllama("/friday", null, {
        log: () => {},
        deps: {
          fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
          ramGb,
          pull: async (tag: string) => {
            pulled.push(tag);
            return tag === "qwen3:4b" && !ok ? { ok: false, error: "no route" } : { ok: true };
          },
        },
      });
      return { pulled, rows };
    };
    const small = await run(6, true);
    expect(small.pulled).toEqual(["qwen2.5:1.5b"]);
    expect(small.rows.find((r: { id: string }) => r.id === "qwen3:4b")).toMatchObject({
      ok: true,
      skipped: true,
    });
    const sixteen = await run(15.8, true);
    expect(sixteen.pulled).toEqual(["qwen2.5:1.5b", "qwen3:4b"]);
    const failing = await run(16, false);
    expect(failing.rows.find((r: { id: string }) => r.id === "qwen3:4b")).toMatchObject({
      ok: false,
      optional: true,
    });
    expect(prefetch.failureReport(failing.rows)).toEqual([]);
    expect(prefetch.failureReport([{ id: "qwen2.5:1.5b", ok: false, error: "x" }])).not.toEqual([]);
  });

  it("leaves the smart chat model out when FRIDAY_PREFETCH_CHAT_SMART is 0", async () => {
    const pulled: string[] = [];
    await prefetch.ensureOllama("/friday", null, {
      log: () => {},
      deps: {
        fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
        ramGb: 64,
        skipOptional: "0",
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
      },
    });
    expect(pulled).toEqual(["qwen2.5:1.5b"]);
  });

  it("only pulls tags the model catalog knows, so the router and Models page can use them", () => {
    for (const model of prefetch.OLLAMA_MODELS) {
      expect(modelByTag(model.tag), model.tag).toBeTruthy();
    }
  });
});

describe("the light model must also answer, not only be pulled", () => {
  const run = async (answers: unknown) => {
    const lines: string[] = [];
    const rows = await prefetch.ensureOllama("/friday", null, {
      log: (line: string) => lines.push(line),
      deps: {
        fetch: async () => ({
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }),
        }),
        ramGb: 4,
        answers,
      },
    });
    return { rows, lines: lines.join("\n") };
  };

  it("says it answered, and adds no row", async () => {
    const asked: string[] = [];
    const r = await run(async (tag: string) => {
      asked.push(tag);
      return { ok: true };
    });
    expect(asked).toEqual(["qwen2.5:1.5b"]);
    expect(r.lines).toContain("loaded and answered a test prompt");
    expect(r.rows.some((row: { id: string }) => row.id === "ollama-answers")).toBe(false);
  });

  it("reports a model that does not answer as a note that never fails setup", async () => {
    const r = await run(async () => ({ ok: false, error: "timed out" }));
    expect(r.lines).toContain("did not answer a test prompt (timed out)");
    const row = r.rows.find((x: { id: string }) => x.id === "ollama-answers");
    expect(row).toMatchObject({ ok: false, optional: true });
    expect(prefetch.failureReport(r.rows)).toEqual([]);
  });

  it("reads a real answer from the daemon and rejects a body without one", async () => {
    const good = await prefetch.ollamaAnswers("qwen2.5:1.5b", async () => ({
      ok: true,
      json: async () => ({ response: "ready" }),
    }));
    expect(good.ok).toBe(true);
    const none = await prefetch.ollamaAnswers("qwen2.5:1.5b", async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    }));
    expect(none.ok).toBe(false);
    const down = await prefetch.ollamaAnswers("qwen2.5:1.5b", async () => {
      throw new Error("connection refused");
    });
    expect(down).toMatchObject({ ok: false, error: "connection refused" });
  });
});
