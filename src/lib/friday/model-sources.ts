/**
 * FRIDAY · model download sources
 *
 * Every local model can be fetched from more than one real place. This module
 * turns a catalog entry into an ordered list of concrete, verifiable sources
 * (Ollama registry tag, Hugging Face GGUF repo, full Transformers repo, direct
 * URL). The desktop downloader walks the list top to bottom and keeps the first
 * source that actually delivers bytes, so a single dead mirror never breaks an
 * install.
 *
 * Nothing here is invented at runtime: the repos below are the vendors' own
 * distributions. Live discovery may append extra sources it verified online.
 */

import { modelById, registryTag, type ModelSpec } from "./model-catalog";

export type ModelSource =
  /** `ollama pull <ref>` against the official registry. */
  | { kind: "ollama"; ref: string; label: string }
  /** A single GGUF file inside a Hugging Face repo, picked by quant pattern. */
  | { kind: "hf-gguf"; repo: string; match: string[]; label: string }
  /** A full Hugging Face repo snapshot (safetensors / ONNX). */
  | { kind: "hf-repo"; repo: string; label: string }
  /** A direct file URL (vendor CDN, GitHub release). */
  | { kind: "url"; url: string; label: string; sha256?: string; bytes?: number };

/**
 * Direct files whose bytes were hashed in this checkout.
 * A mismatch fails the download instead of keeping a partial model.
 */
const CHECKED_URLS: Record<string, { sha256: string; bytes: number }> = {
  "silero-vad": {
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    bytes: 2327524,
  },
  "smart-turn": {
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    bytes: 8679182,
  },
};

/** Curated GGUF mirrors for the models people actually run locally. */
const GGUF: Record<string, { repo: string; match?: string[] }[]> = {
  "llama3.1-8b": [
    { repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF" },
    { repo: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF" },
  ],
  "llama3.2-3b": [
    { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF" },
    { repo: "lmstudio-community/Llama-3.2-3B-Instruct-GGUF" },
  ],
  "llama3.3-70b": [
    { repo: "bartowski/Llama-3.3-70B-Instruct-GGUF" },
    { repo: "lmstudio-community/Llama-3.3-70B-Instruct-GGUF" },
  ],
  "qwen3-8b": [{ repo: "Qwen/Qwen3-8B-GGUF" }, { repo: "bartowski/Qwen_Qwen3-8B-GGUF" }],
  "qwen3-14b": [{ repo: "Qwen/Qwen3-14B-GGUF" }, { repo: "bartowski/Qwen_Qwen3-14B-GGUF" }],
  "qwen3-32b": [{ repo: "Qwen/Qwen3-32B-GGUF" }, { repo: "bartowski/Qwen_Qwen3-32B-GGUF" }],
  "qwen2.5-coder-14b": [
    { repo: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF" },
    { repo: "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF" },
  ],
  "deepseek-r1-8b": [
    { repo: "bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF" },
    { repo: "lmstudio-community/DeepSeek-R1-Distill-Llama-8B-GGUF" },
  ],
  "deepseek-r1-14b": [
    { repo: "bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF" },
    { repo: "lmstudio-community/DeepSeek-R1-Distill-Qwen-14B-GGUF" },
  ],
  "gemma3-4b": [
    { repo: "ggml-org/gemma-3-4b-it-GGUF" },
    { repo: "bartowski/google_gemma-3-4b-it-GGUF" },
  ],
  "gemma3-12b": [
    { repo: "ggml-org/gemma-3-12b-it-GGUF" },
    { repo: "bartowski/google_gemma-3-12b-it-GGUF" },
  ],
  "phi4-14b": [{ repo: "bartowski/phi-4-GGUF" }, { repo: "lmstudio-community/phi-4-GGUF" }],
  "mistral-small3-24b": [
    { repo: "bartowski/Mistral-Small-24B-Instruct-2501-GGUF" },
    { repo: "lmstudio-community/Mistral-Small-24B-Instruct-2501-GGUF" },
  ],
  "gpt-oss-20b": [{ repo: "ggml-org/gpt-oss-20b-GGUF" }, { repo: "unsloth/gpt-oss-20b-GGUF" }],
  "gpt-oss-120b": [{ repo: "ggml-org/gpt-oss-120b-GGUF" }, { repo: "unsloth/gpt-oss-120b-GGUF" }],
  "qwen2.5-vl-7b": [
    { repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF" },
    { repo: "unsloth/Qwen2.5-VL-7B-Instruct-GGUF" },
  ],
  "nomic-embed-text-v15": [{ repo: "nomic-ai/nomic-embed-text-v1.5-GGUF", match: ["f16", "Q8_0"] }],
};

const DEFAULT_MATCH = ["Q4_K_M", "Q4_K_S", "q4_0", "Q5_K_M", "Q8_0"];

const hfRepoFromUrl = (url: string): string | null => {
  const hit = /huggingface\.co\/([^/?#]+\/[^/?#]+)/i.exec(url);
  return hit?.[1] ?? null;
};

/** Ordered, de-duplicated download sources for one catalog model. */
export function downloadSources(model: ModelSpec): ModelSource[] {
  const out: ModelSource[] = [];
  const seen = new Set<string>();
  const push = (source: ModelSource, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(source);
  };

  if (model.kind === "cloud") return out;

  // 1 · the official Ollama registry tag, then the plain slug as a fallback.
  const tag = registryTag(model);
  if (tag) {
    push({ kind: "ollama", ref: tag, label: `Ollama registry · ${tag}` }, `ollama:${tag}`);
    const slug = tag.split(":")[0];
    push(
      { kind: "ollama", ref: `${slug}:latest`, label: `Ollama registry · ${slug}:latest` },
      `ollama:${slug}:latest`,
    );
  }

  // 2 · curated GGUF mirrors — used when Ollama is unreachable or has no tag.
  for (const entry of GGUF[model.id] ?? []) {
    push(
      {
        kind: "hf-gguf",
        repo: entry.repo,
        match: entry.match ?? DEFAULT_MATCH,
        label: `Hugging Face · ${entry.repo}`,
      },
      `hf-gguf:${entry.repo}`,
    );
  }

  // 3 · whatever the catalog entry itself points at.
  // A /resolve/<rev>/<file> URL is one checksummed file, not a whole repo snapshot.
  const directFile = /\/resolve\/[^/]+\/[^/?#]+$/i.test(model.url);
  const repo = directFile ? null : hfRepoFromUrl(model.url);
  if (repo) {
    if (model.format === "GGUF")
      push(
        { kind: "hf-gguf", repo, match: DEFAULT_MATCH, label: `Hugging Face · ${repo}` },
        `hf-gguf:${repo}`,
      );
    else push({ kind: "hf-repo", repo, label: `Hugging Face · ${repo}` }, `hf-repo:${repo}`);
  } else if (/^https?:\/\//i.test(model.url) && !/ollama\.com/i.test(model.url)) {
    const checked = CHECKED_URLS[model.id];
    push(
      {
        kind: "url",
        url: model.url,
        label: model.source,
        ...(checked ? { sha256: checked.sha256, bytes: checked.bytes } : {}),
      },
      `url:${model.url}`,
    );
  }

  return out;
}

export const sourcesFor = (modelId: string): ModelSource[] => {
  const model = modelById.get(modelId);
  return model ? downloadSources(model) : [];
};

/** How many real, distinct places FRIDAY can pull this model from. */
export const sourceCount = (modelId: string): number => sourcesFor(modelId).length;
