/**
 * Optional local rows added next to their neighbours: Qwen3-VL as a vision
 * alternative, Qwen3-Embedding and EmbeddingGemma as embedding challengers to
 * BGE-M3. The rows are additive: nothing existing changes and no default moves.
 * Tags and sizes were read from ollama.com/library and the licences from the
 * Hugging Face model cards.
 */
import { describe, expect, it } from "vitest";
import { modelById, modelCatalog, modelByTag, registryTag } from "@/lib/friday/model-catalog";

const NEW_ROWS = [
  { id: "qwen3-vl-4b", tag: "qwen3-vl:4b", category: "Vision", sizeGb: 3.3, license: "Apache-2.0" },
  { id: "qwen3-vl-2b", tag: "qwen3-vl:2b", category: "Vision", sizeGb: 1.9, license: "Apache-2.0" },
  {
    id: "qwen3-embedding-0.6b",
    tag: "qwen3-embedding:0.6b",
    category: "Embedding",
    sizeGb: 0.64,
    license: "Apache-2.0",
  },
  {
    id: "embeddinggemma-300m",
    tag: "embeddinggemma:300m",
    category: "Embedding",
    sizeGb: 0.62,
    license: "Gemma Terms",
  },
] as const;

describe("optional model rows", () => {
  it("catalog ids stay unique", () => {
    const ids = modelCatalog.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(NEW_ROWS)("$id is a real local Ollama row with a recorded licence and size", (row) => {
    const spec = modelById.get(row.id);
    expect(spec, row.id).toBeTruthy();
    expect(spec!.provider).toBe("ollama");
    expect(spec!.kind).toBe("local");
    expect(spec!.category).toBe(row.category);
    expect(spec!.license).toBe(row.license);
    expect(typeof spec!.sizeGb).toBe("number");
    expect(spec!.sizeGb).toBe(row.sizeGb);
    expect(Number.isFinite(spec!.ctxK) && spec!.ctxK > 0).toBe(true);
    expect(Number.isFinite(spec!.vramGb) && spec!.vramGb > 0).toBe(true);
    expect(registryTag(spec!)).toBe(row.tag);
    expect(modelByTag(row.tag)?.id).toBe(row.id);
    expect(spec!.installed).toBeNull();
  });

  it("vision rows carry the vision capability, embedding rows none", () => {
    expect(modelById.get("qwen3-vl-4b")!.caps).toContain("vision");
    expect(modelById.get("qwen3-vl-2b")!.caps).toContain("vision");
    expect(modelById.get("qwen3-embedding-0.6b")!.caps).toEqual([]);
    expect(modelById.get("embeddinggemma-300m")!.caps).toEqual([]);
  });

  it("leaves the existing neighbours exactly as they were and bge-m3 stays the installed embedding", () => {
    expect(modelById.get("bge-m3")).toMatchObject({
      provider: "llamacpp",
      category: "Embedding",
      sizeGb: 1.1,
      license: "MIT",
      installed: "1.0",
    });
    expect(modelById.get("qwen2-vl-7b")).toMatchObject({
      provider: "transformers",
      category: "Vision",
      sizeGb: 16,
      license: "Apache-2.0",
    });
    expect(modelById.get("llama3.2-vision")).toMatchObject({
      provider: "ollama",
      category: "Vision",
      sizeGb: 7.9,
      license: "Llama 3.2 Community",
    });
    for (const id of ["nomic-embed", "bge-large-en", "e5-large", "all-minilm", "minicpm-v"]) {
      expect(modelById.get(id), id).toBeTruthy();
    }
  });
});
