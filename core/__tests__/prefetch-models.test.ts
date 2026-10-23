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
    const jobs = prefetch.prefetchPlan("/friday", quiet);
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
        .prefetchPlan("/friday", { ...quiet, FRIDAY_PREFETCH_CHAT: "0" })
        .some((row: { kind: string }) => row.kind === "chat"),
    ).toBe(false);
    expect(prefetch.prefetchPlan("/friday", { GITHUB_ACTIONS: "true" })).toEqual([]);
    expect(prefetch.prefetchPlan("/friday", { CI: "1", FRIDAY_PREFETCH: "1" }).length).toBe(5);
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

  it("installs once, starts the daemon, and pulls both lite models", async () => {
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
        ollamaExe: "C:/nowhere/ollama.exe",
      },
    });
    expect(installs).toEqual([row.ready]);
    expect(pulled).toEqual(["qwen2.5:1.5b", "qwen2.5:3b"]);
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
