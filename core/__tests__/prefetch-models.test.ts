/**
 * Build-time prefetch: speech, turn-taking and a small chat model land in the
 * FRIDAY folder during setup through the app's own verified downloader.
 * No network here: the downloader is a stand-in.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));

const quiet = { CI: "", GITHUB_ACTIONS: "" };

describe("build-time model prefetch", () => {
  it("plans speech base and small, the pinned voice models, and a small chat model", () => {
    const jobs = prefetch.prefetchPlan("/friday", quiet, "linux");
    expect(jobs.map((row: { id: string }) => row.id)).toEqual([
      "stt-base",
      "stt-small",
      "smart-turn",
      "silero-vad",
      "qwen2.5-1.5b-instruct",
    ]);
    const small = jobs[1];
    expect(small.job.dir).toBe(path.join("/friday", "cache", "stt"));
    expect(small.job.sources[0]).toMatchObject({
      kind: "hf-repo",
      repo: "Systran/faster-whisper-small",
    });
    const vad = jobs[3];
    expect(vad.job.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vad.ready).toBe(path.join("/friday", "models", "silero-vad", "silero_vad.onnx"));
    expect(jobs[4].job.sources[0].repo).toBe("Qwen/Qwen2.5-1.5B-Instruct-GGUF");
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
    ).toBe(5);
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
      expect(lines.join("\n")).toContain("FRIDAY fetches it on first use");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is wired into setup and verifies weights against the publisher's digest", () => {
    const setup = readFileSync(path.join(root, "scripts/setup-python.cjs"), "utf8");
    expect(setup).toContain('path.join(__dirname, "prefetch-models.cjs")');
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

  it("installs once, starts the daemon, and pulls the two light models and the smart one", async () => {
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
        totalGb: 32,
        ollamaExe: "C:/nowhere/ollama.exe",
      },
    });
    expect(installs).toEqual([row.ready]);
    expect(pulled).toEqual(["qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b"]);
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

  it("skips pulls for models already present and reports a failed pull without failing", async () => {
    const lines: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", row, {
      log: (line: string) => lines.push(line),
      deps: {
        fetch: async () => ({
          ok: true,
          json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }),
        }),
        pull: async () => ({ ok: false, error: "network" }),
      },
    });
    expect(rows.find((r: { id: string }) => r.id === "qwen2.5:1.5b")).toMatchObject({
      downloaded: false,
    });
    expect(rows.find((r: { id: string }) => r.id === "qwen2.5:3b")).toMatchObject({ ok: false });
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
      env: { ...quiet, FRIDAY_AUTO_INSTALL: "1", FRIDAY_PREFETCH_CHAT: "0" },
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
        totalGb: 32,
        pull: async (tag: string) => {
          pulled.push(tag);
          return { ok: true };
        },
      },
    });
    expect(fetched).not.toContain("ollama");
    expect(pulled).toEqual(["qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b"]);
    expect(rows.find((r: { id: string }) => r.id === "ollama")).toMatchObject({ ok: true });
    const log = lines.join("\n");
    expect(log).toContain("ollama 0.40.4 already installed");
    expect(log).toContain("nothing to download");
    expect(log).toContain("v9.9.9 is available");
  });

  it("downloads the newest official release, with its own digest, only when Ollama is missing", async () => {
    const jobs: { modelId: string; sources: { url: string; sha256: string }[] }[] = [];
    await prefetch.prefetch("C:/friday", {
      env: { ...quiet, FRIDAY_AUTO_INSTALL: "0", FRIDAY_PREFETCH_CHAT: "0" },
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

describe("local models by tier, and nothing downloaded twice", () => {
  const library = require_(path.join(root, "electron/local-library.cjs"));
  const win = "win32";

  it("keeps two light, fast models and one larger, smarter one in the runner config", () => {
    const models = library.ollamaModels();
    expect(models.filter((m: { tier: string }) => m.tier === "fast")).toHaveLength(2);
    expect(models.filter((m: { tier: string }) => m.tier === "smart")).toHaveLength(1);
    const smart = models.find((m: { tier: string }) => m.tier === "smart");
    expect(smart.minRamGb).toBeGreaterThanOrEqual(8);
    expect(prefetch.OLLAMA_MODELS.map((m: { tag: string }) => m.tag)).toEqual(
      models.map((m: { tag: string }) => m.tag),
    );
  });

  it("routes by size: the light models are fast-role and the large one is a brain", () => {
    const models_ = require_(path.join(root, "electron/models.cjs"));
    for (const m of library.ollamaModels()) {
      expect(models_.inferRole(m.tag)).toBe(m.tier === "smart" ? "brain" : "fast");
    }
    for (const name of ["qwen2.5:0.5b", "llama3.2:1b", "phi3:3.8b", "gemma3:4b"]) {
      expect(models_.inferRole(name)).toBe("fast");
    }
    for (const name of ["llama3.1:8b", "qwen3:14b", "qwen2.5:72b", "gpt-5"]) {
      expect(models_.inferRole(name)).toBe("brain");
    }
    expect(models_.inferRole("qwen2.5-coder:1.5b")).toBe("coder");
  });

  it("skips the smart model on a small PC or when opted out, and says why", async () => {
    const pulled: string[] = [];
    const lines: string[] = [];
    const deps = (extra: Record<string, unknown>) => ({
      fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen2.5:1.5b" }] }) }),
      pull: async (tag: string) => {
        pulled.push(tag);
        return { ok: true };
      },
      ...extra,
    });
    const run = (extra: Record<string, unknown>) =>
      prefetch.ensureOllama("C:/friday", null, {
        log: (l: string) => lines.push(l),
        deps: deps(extra),
      });
    const small = await run({ totalGb: 8 });
    expect(pulled).toEqual(["qwen2.5:3b"]);
    expect(small.find((r: { id: string }) => r.id === "qwen2.5:7b")).toMatchObject({ ok: true });
    expect(lines.join("\n")).toContain("needs 12 GB RAM");
    pulled.length = 0;
    await run({ totalGb: 64, env: { FRIDAY_PREFETCH_OLLAMA_SMART: "0" } });
    expect(pulled).toEqual(["qwen2.5:3b"]);
    expect(lines.join("\n")).toContain("FRIDAY_PREFETCH_OLLAMA_SMART=0");
  });

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
            models: [{ name: "qwen2.5:1.5b" }, { name: "qwen2.5:3b" }, { name: "qwen2.5:7b" }],
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

  it("a second run downloads nothing that is already on disk and verified", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-prefetch-"));
    try {
      for (const size of ["base", "small"]) {
        const stt = path.join(dir, "cache", "stt", size);
        mkdirSync(stt, { recursive: true });
        writeFileSync(path.join(stt, "config.json"), "{}");
        writeFileSync(path.join(stt, "model.bin"), "x");
      }
      const chat = path.join(dir, "models", "qwen2.5-1.5b-instruct");
      mkdirSync(chat, { recursive: true });
      writeFileSync(path.join(chat, "qwen2.5-1.5b-instruct-q4_k_m.gguf"), "x");
      const fetched: string[] = [];
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        env: quiet,
        platform: "linux",
        log: (l: string) => lines.push(l),
        download: async (job: { modelId: string }) => {
          fetched.push(job.modelId);
          return { ok: true };
        },
      });
      // Only the two pinned voice files (their digests do not match this stand-in) are fetched.
      expect(fetched.sort()).toEqual(["silero-vad", "smart-turn"]);
      expect(rows.filter((r: { downloaded?: boolean }) => r.downloaded === false)).toHaveLength(3);
      expect(lines.join("\n")).toContain("verified on disk; not downloaded again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
