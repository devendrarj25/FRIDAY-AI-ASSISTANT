/**
 * Local engine start contract.
 *
 * Zero-argument CLIs keep a static ENGINE_CONTROL.start. llama.cpp and vLLM
 * only receive a start argv when exactly one matching weight is already in
 * the FRIDAY models folder — never a guessed model, never a fake success.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs") as {
  ENGINE_CONTROL: Record<string, { start?: [string, string[]]; modelStart?: unknown }>;
  LOCAL_ENGINES: Record<string, { endpoint?: string }>;
  resolveEngineStart: (
    id: string,
    files?: Array<{ path: string; format: string }>,
    selection?: string | { modelPath?: string; modelId?: string },
  ) => { start: [string, string[]] | null; hint: string | null; timeoutMs: number };
};
const download = require_("../../electron/model-download.cjs") as {
  uniqueGgufPaths: (files: Array<{ path?: string; format?: string }>) => string[];
  uniqueSafetensorDirs: (files: Array<{ path?: string; format?: string }>) => string[];
};
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<{ id: string; cmd?: string; winget?: string; pip?: string; manual?: string }>;
};

describe("unique weight grouping", () => {
  it("counts GGUF shards as one model", () => {
    const files = [
      { path: "/m/qwen-00001-of-00002.gguf", format: "gguf" },
      { path: "/m/qwen-00002-of-00002.gguf", format: "gguf" },
    ];
    expect(download.uniqueGgufPaths(files)).toHaveLength(1);
  });

  it("keeps distinct GGUF files as distinct models", () => {
    const files = [
      { path: "/m/a.gguf", format: "gguf" },
      { path: "/m/b.gguf", format: "gguf" },
    ];
    expect(download.uniqueGgufPaths(files)).toEqual(["/m/a.gguf", "/m/b.gguf"]);
  });

  it("groups safetensors by parent directory", () => {
    const files = [
      { path: "/m/llama/model-00001-of-00002.safetensors", format: "safetensors" },
      { path: "/m/llama/model-00002-of-00002.safetensors", format: "safetensors" },
    ];
    expect(download.uniqueSafetensorDirs(files)).toEqual(["/m/llama"]);
  });
});

describe("ENGINE_CONTROL start table", () => {
  it("keeps a documented zero-argument start for Ollama, LM Studio, and LocalAI", () => {
    expect(models.ENGINE_CONTROL["ollama"]?.start).toEqual(["ollama", ["serve"]]);
    expect(models.ENGINE_CONTROL["lmstudio"]?.start).toEqual(["lms", ["server", "start"]]);
    expect(models.ENGINE_CONTROL["localai"]?.start).toEqual([
      "local-ai",
      ["run", "--address", "127.0.0.1:8081"],
    ]);
  });

  it("does not invent a Jan start command", () => {
    expect(models.ENGINE_CONTROL["jan"]?.start).toBeUndefined();
    const resolved = models.resolveEngineStart("jan", []);
    expect(resolved.start).toBeNull();
    expect(resolved.hint).toMatch(/no zero-argument/i);
  });

  it("does not list MLX as a live engine on non-darwin hosts", () => {
    if (process.platform === "darwin") return;
    expect(models.LOCAL_ENGINES["mlx"]).toBeUndefined();
    expect(models.ENGINE_CONTROL["mlx"]).toBeUndefined();
  });
});

describe("llama.cpp / vLLM conditional start", () => {
  it("refuses llama.cpp start when no GGUF is present", () => {
    const resolved = models.resolveEngineStart("llamacpp", []);
    expect(resolved.start).toBeNull();
    expect(resolved.hint).toMatch(/GGUF/);
  });

  it("builds llama-server -m when exactly one GGUF exists", () => {
    const file = "/friday/models/qwen.gguf";
    const resolved = models.resolveEngineStart("llamacpp", [{ path: file, format: "gguf" }]);
    expect(resolved.start).toEqual([
      "llama-server",
      ["-m", file, "--host", "127.0.0.1", "--port", "8080"],
    ]);
  });

  it("refuses llama.cpp start when several GGUFs make the pick ambiguous", () => {
    const resolved = models.resolveEngineStart("llamacpp", [
      { path: "/m/a.gguf", format: "gguf" },
      { path: "/m/b.gguf", format: "gguf" },
    ]);
    expect(resolved.start).toBeNull();
    expect(resolved.hint).toMatch(/will not guess/i);
  });

  it("starts the exact selected GGUF when several are present", () => {
    const files = [
      { path: "/m/a.gguf", format: "gguf" },
      { path: "/m/b.gguf", format: "gguf" },
    ];
    const resolved = models.resolveEngineStart("llamacpp", files, "file:/m/b.gguf");
    expect(resolved.start).toEqual([
      "llama-server",
      ["-m", "/m/b.gguf", "--host", "127.0.0.1", "--port", "8080"],
    ]);
  });

  it("refuses vLLM start for GGUF-only inventories", () => {
    const resolved = models.resolveEngineStart("vllm", [{ path: "/m/a.gguf", format: "gguf" }]);
    expect(resolved.start).toBeNull();
    expect(resolved.hint).toMatch(/safetensors/i);
  });

  it("builds vllm serve when exactly one safetensors folder exists", () => {
    const resolved = models.resolveEngineStart("vllm", [
      { path: "/m/llama/model.safetensors", format: "safetensors" },
    ]);
    expect(resolved.start).toEqual([
      "vllm",
      ["serve", "/m/llama", "--host", "127.0.0.1", "--port", "8000"],
    ]);
  });

  it("starts the exact selected vLLM folder when several are present", () => {
    const files = [
      { path: "/m/llama/model.safetensors", format: "safetensors" },
      { path: "/m/qwen/model.safetensors", format: "safetensors" },
    ];
    const resolved = models.resolveEngineStart("vllm", files, "qwen");
    expect(resolved.start).toEqual([
      "vllm",
      ["serve", "/m/qwen", "--host", "127.0.0.1", "--port", "8000"],
    ]);
  });
});

describe("toolchain install entries", () => {
  const byId = new Map(toolchain.TOOLS.map((t) => [t.id, t]));

  it("detects LocalAI as local-ai and does not invent a Windows winget id", () => {
    const tool = byId.get("LocalAI");
    expect(tool?.cmd).toBe("local-ai");
    expect(tool?.winget).toBeUndefined();
  });

  it("installs Jan through the documented winget id", () => {
    const tool = byId.get("Jan");
    expect(tool?.cmd).toBe("jan");
    expect(tool?.winget).toBe("Jan.Jan");
  });

  it("never offers MLX-LM install on Windows or Linux", () => {
    if (process.platform === "darwin") return;
    expect(byId.has("MLX-LM")).toBe(false);
  });
});
