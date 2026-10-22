import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const status = require_("../../electron/local-model-status.cjs");

const inventory = (providers: unknown[]) => ({ providers });

describe("local model status says which fact is missing", () => {
  it("separates serving, not loaded, stopped, not installed, and failed", () => {
    const report = status.describeLocal({
      inventory: inventory([
        { id: "ollama", name: "Ollama", online: true, models: [{ id: "llama3.2" }] },
        {
          id: "lmstudio",
          name: "LM Studio",
          online: true,
          models: [{ id: "qwen", loaded: false, notice: "model not loaded in LM Studio" }],
        },
        { id: "jan", name: "Jan", online: false, error: "HTTP 500 database is locked", models: [] },
        {
          id: "local",
          name: "Local files",
          online: true,
          models: [{ id: "tiny.gguf", name: "tiny.gguf" }],
        },
      ]),
      engines: [
        { id: "ollama", name: "Ollama", running: true, canStart: false },
        { id: "lmstudio", name: "LM Studio", running: true, canStart: false },
        { id: "llamacpp", name: "llama.cpp", running: false, canStart: true },
        {
          id: "vllm",
          name: "vLLM",
          running: false,
          canStart: false,
          hint: "vllm is not installed or is not available on PATH",
        },
        { id: "jan", name: "Jan", running: false, canStart: false, hint: "Open Jan" },
      ],
    });
    const state = Object.fromEntries(
      report.runners.map((row: { id: string; state: string }) => [row.id, row.state]),
    );
    expect(state).toEqual({
      ollama: "serving",
      lmstudio: "not-loaded",
      llamacpp: "runner-stopped",
      vllm: "runner-not-installed",
      jan: "failed",
    });
    const line = (id: string) => report.models.find((row: { id: string }) => row.id === id)?.line;
    expect(line("ollama/llama3.2")).toBe("llama3.2: serving in Ollama");
    expect(line("lmstudio/qwen")).toContain("downloaded, not loaded in LM Studio");
    expect(line("file/tiny.gguf")).toContain("downloaded, llama.cpp is stopped. Start it");
    expect(report.runners.find((row: { id: string }) => row.id === "llamacpp").canStart).toBe(true);
  });

  it("says a downloaded file has no runner at all, instead of listing it as ready", () => {
    const report = status.describeLocal({
      inventory: inventory([
        { id: "local", name: "Local files", online: true, models: [{ id: "a.gguf" }] },
      ]),
      engines: [
        {
          id: "ollama",
          name: "Ollama",
          running: false,
          canStart: false,
          hint: "ollama is not installed or is not available on PATH",
        },
      ],
    });
    expect(report.models[0].state).toBe("runner-not-installed");
    expect(report.models[0].line).toContain("no runner is installed or running");
  });

  it("is wired: status IPC, consented start, and an auto-refresh after the runner is up", () => {
    const main = readFileSync("electron/main.cjs", "utf8");
    expect(main).toContain('ipcMain.handle("models:local-status"');
    const start = main.slice(main.indexOf('ipcMain.handle("models:engine-start"'));
    expect(start.slice(0, 1400)).toContain('refreshRoutable(true, "runner-started")');
    const page = readFileSync("src/routes/models.tsx", "utf8");
    expect(page).toContain("Click Start again to allow it");
    expect(page).toContain("startModelEngine(runner.id)");
    expect(readFileSync("electron/preload.cjs", "utf8")).toContain("models:local-status");
  });
});
