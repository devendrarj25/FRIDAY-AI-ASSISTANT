/**
 * Display copy for official model knowledge. Dates are locked to
 * electron/model-access.cjs by core/__tests__/knowledge-age.test.ts.
 */

export type KnowledgeView = {
  source: string;
  sourceName: string;
  checkedAt: string;
};

export const PROVIDER_KNOWLEDGE_VIEW: Record<string, KnowledgeView> = {
  groq: {
    source: "https://console.groq.com/docs/models",
    sourceName: "Groq supported models",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  gemini: {
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    sourceName: "Gemini API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  openai: {
    source: "https://platform.openai.com/docs/pricing",
    sourceName: "OpenAI API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  anthropic: {
    source: "https://www.anthropic.com/pricing",
    sourceName: "Anthropic API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  mistral: {
    source: "https://mistral.ai/pricing/api",
    sourceName: "Mistral API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  deepseek: {
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    sourceName: "DeepSeek API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
  perplexity: {
    source: "https://docs.perplexity.ai/guides/pricing",
    sourceName: "Perplexity API pricing",
    checkedAt: "2026-10-07T00:00:00.000Z",
  },
};

export function knowledgeAgeLabel(checkedAt: number | null | undefined, now: number): string {
  if (!checkedAt || !Number.isFinite(checkedAt) || !Number.isFinite(now)) return "age unknown";
  const days = Math.floor((now - checkedAt) / 86_400_000);
  if (days < 0) return "age unknown";
  if (days === 0) return "fetched today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

export function providerKnowledgeLine(view: KnowledgeView | undefined, now: number): string {
  if (!view?.source || !view.checkedAt) return "Source unknown · age unknown";
  const checked = Date.parse(view.checkedAt);
  if (!Number.isFinite(checked)) return "Source unknown · age unknown";
  const day = new Date(checked).toISOString().slice(0, 10);
  return `Source ${view.source} · fetched ${day} · ${knowledgeAgeLabel(checked, now)}`;
}

export function modelSourceLine(model: { provider?: string; url?: string }, now: number): string {
  const view = model.provider ? PROVIDER_KNOWLEDGE_VIEW[model.provider] : undefined;
  if (view) return providerKnowledgeLine(view, now);
  if (model.url) return `Source ${model.url} · age unknown`;
  return "Source unknown · age unknown";
}
