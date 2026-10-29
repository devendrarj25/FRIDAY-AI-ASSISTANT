import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { modelCatalog, modelById } from "@/lib/friday/model-catalog";
import { downloadSources, sourceCount } from "@/lib/friday/model-sources";

const require = createRequire(import.meta.url);
const download = require(path.resolve(__dirname, "..", "..", "electron", "model-download.cjs"));

describe("multi-source downloads", () => {
  it("gives every local catalog model at least one real source", () => {
    const orphans = modelCatalog
      .filter((m) => m.kind === "local")
      .filter((m) => sourceCount(m.id) === 0)
      .map((m) => m.id);
    expect(orphans).toEqual([]);
  });

  it("puts the Ollama registry first and keeps a Hugging Face fallback", () => {
    const sources = downloadSources(modelById.get("llama3.1-8b")!);
    expect(sources[0]).toMatchObject({ kind: "ollama", ref: "llama3.1:8b" });
    expect(sources.some((s) => s.kind === "hf-gguf")).toBe(true);
    expect(sources.length).toBeGreaterThan(2);
  });

  it("offers no download source for hosted cloud models", () => {
    const cloud = modelCatalog.find((m) => m.kind === "cloud")!;
    expect(downloadSources(cloud)).toEqual([]);
  });

  it("never lists the same source twice", () => {
    for (const model of modelCatalog) {
      const keys = downloadSources(model).map((s) => JSON.stringify(s));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("downloader behaviour", () => {
  it("prefers the requested quant and skips sharded builds", () => {
    const files = [
      "README.md",
      "model-00001-of-00002.gguf",
      "model-Q8_0.gguf",
      "model-Q4_K_M.gguf",
    ];
    expect(download.pickGguf(files, ["Q4_K_M", "Q8_0"])).toBe("model-Q4_K_M.gguf");
    expect(download.pickGguf(files, ["Q5_K_M"])).toBe("model-Q8_0.gguf");
    expect(download.pickGguf(["notes.txt"], ["Q4_K_M"])).toBeNull();
  });

  it("reports an honest failure when no source can deliver", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-dl-"));
    const result = await download.downloadModel(
      {
        modelId: "test-model",
        dir,
        sources: [
          { kind: "hf-gguf", repo: "friday/does-not-exist-xyz", match: ["Q4_K_M"], label: "hf" },
        ],
      },
      () => {},
      undefined,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0].error).toBeTruthy();
    expect(result.attempts[0].error).not.toMatch(/Ollama isn't running/i);
  }, 30_000);

  it("refuses to run without any source instead of pretending to install", async () => {
    const result = await download.downloadModel({ modelId: "x", sources: [] }, () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no download source/);
  });
});
