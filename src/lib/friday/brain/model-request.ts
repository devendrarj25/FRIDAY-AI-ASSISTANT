/**
 * "Use this model" / "ask that provider" in the owner's own words.
 *
 * A turn that names a model or a provider next to a request word ("use",
 * "with", "via", "ask", "se", "use karke", "ke saath") is routed to exactly
 * that model, or to that provider's models only. A bare mention ("what is
 * OpenAI?") is not a request. Both firewalls still run in the main router, so
 * a named paid or cloud model is refused there with its reason, never forced.
 */

export type NamedModel = {
  id: string;
  providerId: string;
  names: string[];
};

export type NamedProvider = {
  id: string;
  names: string[];
};

export type ModelRequest =
  | { kind: "model"; modelId: string; providerId: string; matched: string }
  | { kind: "provider"; providerId: string; matched: string };

/** Everyday names that mean a provider. */
const PROVIDER_ALIASES: Record<string, string[]> = {
  openai: ["openai", "chatgpt", "gpt"],
  anthropic: ["anthropic", "claude"],
  gemini: ["gemini", "google gemini", "google ai"],
  ollama: ["ollama", "local model", "local models", "offline model"],
  lmstudio: ["lm studio", "lmstudio"],
  llamacpp: ["llama.cpp", "llamacpp", "llama cpp"],
  xai: ["xai", "grok"],
  mistral: ["mistral"],
  deepseek: ["deepseek"],
  groq: ["groq"],
  openrouter: ["openrouter", "open router"],
  perplexity: ["perplexity"],
  cohere: ["cohere"],
};

/** Words before a name that make it a request (one word, such as the provider, may sit between). */
const BEFORE =
  /(?:^|\s)(?:use|using|with|via|through|ask|try|switch to|run on|run it on)(?:\s+(?:the|a|an|my))?(?:\s+(?:model|provider))?(?:\s+[\p{L}\p{N}.:]+)?\s*$/u;
/** Words after a name that make it a request. */
const AFTER =
  /^\s*(?:model\s+|models\s+|wale\s+|waale\s+|ke\s+)?(?:se|use\s+kar|use\s+karke|use\s+karo|ka\s+use|ke\s+saath|ke\s+sath|par\s+chala|pe\s+chala|से|का\s+उपयोग)(?:\s|$)/;

const norm = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.:]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

function nameForms(name: string): string[] {
  const base = norm(name).trim();
  if (!base) return [];
  const forms = new Set([base, base.replace(/[-_]/g, " ")]);
  // "qwen2.5 1.5b" and "qwen2.5-1.5b" are the same thing said two ways.
  forms.add(base.replace(/(\D)(\d)/g, "$1 $2").replace(/\s+/g, " "));
  return [...forms].filter((form) => form.length >= 3);
}

function requested(text: string, form: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(` ${form} `, from);
    if (at < 0) return false;
    const before = text.slice(0, at + 1).trimEnd();
    const after = text.slice(at + form.length + 1);
    if (BEFORE.test(before) || AFTER.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The model or provider this prompt asks for, or null. A model beats a
 * provider, and the longest matching name wins ("gpt-4o mini" over "gpt").
 */
export function parseModelRequest(
  prompt: string,
  models: readonly NamedModel[],
  providers: readonly NamedProvider[],
): ModelRequest | null {
  const text = norm(prompt);
  if (text.trim().length < 5) return null;
  let best: ModelRequest | null = null;
  let bestLength = 0;
  for (const model of models) {
    for (const name of model.names) {
      for (const form of nameForms(name)) {
        if (form.length <= bestLength || !requested(text, form)) continue;
        best = { kind: "model", modelId: model.id, providerId: model.providerId, matched: form };
        bestLength = form.length;
      }
    }
  }
  if (best) return best;
  for (const provider of providers) {
    const names = [...provider.names, ...(PROVIDER_ALIASES[provider.id] ?? [])];
    for (const name of names) {
      for (const form of nameForms(name)) {
        if (form.length <= bestLength || !requested(text, form)) continue;
        best = { kind: "provider", providerId: provider.id, matched: form };
        bestLength = form.length;
      }
    }
  }
  return best;
}
