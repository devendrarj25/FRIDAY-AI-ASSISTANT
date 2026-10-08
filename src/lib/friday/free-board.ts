/** Free-model board copy for the existing Models and Doctor pages. No network. */

export type SignupRow = {
  id: string;
  label: string;
  href: string;
  dataUse: string;
};

const SIGNUP: SignupRow[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    href: "https://openrouter.ai/docs/guides/routing/model-variants/free",
    dataUse:
      "Free variants are rate limited. Read that provider's data terms before sending a prompt.",
  },
  {
    id: "groq",
    label: "Groq",
    href: "https://console.groq.com/docs/models",
    dataUse: "The free plan is a documented quota. A developer or paid account is not that plan.",
  },
  {
    id: "gemini",
    label: "Google Gemini API",
    href: "https://ai.google.dev/gemini-api/docs/pricing",
    dataUse: "Free Tier models have their own quota. A paid project is not the free tier.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    href: "https://inference-docs.cerebras.ai/support/rate-limits",
    dataUse:
      "New accounts can receive a short promotional credit. There is no always-free model list.",
  },
  {
    id: "sambanova",
    label: "SambaNova",
    href: "https://cloud.sambanova.ai/",
    dataUse: "No free model list was verified. Unknown cost stays hidden.",
  },
  {
    id: "github",
    label: "GitHub Models",
    href: "https://github.blog/changelog/2026-07-30-github-models-is-now-retired/",
    dataUse: "Retired. Do not send prompts.",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    href: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    dataUse: "Free allocation is 10,000 Neurons a day. Some models require a paid Workers plan.",
  },
  {
    id: "mistral",
    label: "Mistral",
    href: "https://docs.mistral.ai/getting-started/models/",
    dataUse: "An API price of zero is the evidence. A name is not.",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    href: "https://build.nvidia.com/",
    dataUse: "A catalogue row with no positive price can be a trial. A priced row is paid.",
  },
  {
    id: "huggingface",
    label: "Hugging Face Inference Providers",
    href: "https://huggingface.co/docs/inference-providers",
    dataUse: "A monthly credit is not a per-model free price.",
  },
  {
    id: "cohere",
    label: "Cohere",
    href: "https://docs.cohere.com/docs/models",
    dataUse: "Trial or zero price is the evidence. Unknown cost stays hidden.",
  },
  {
    id: "together",
    label: "Together",
    href: "https://www.together.ai/pricing",
    dataUse: "No always-free model list was verified. A zero price is the evidence.",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    href: "https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation",
    dataUse: "Free models are billed at zero after identity verification. Prompts may be logged.",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    href: "https://docs.hyperbolic.xyz/",
    dataUse: "No free inference tier was verified. Unknown cost stays hidden.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    href: "https://api-docs.deepseek.com/quick_start/pricing",
    dataUse: "Metered unless the price page shows zero.",
  },
  {
    id: "zhipu",
    label: "Zhipu",
    href: "https://docs.z.ai/",
    dataUse: "A documented free id is the evidence.",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    href: "https://platform.moonshot.ai/",
    dataUse: "No always-free model list was verified.",
  },
  {
    id: "xai",
    label: "xAI",
    href: "https://docs.x.ai/docs/models",
    dataUse: "Published token prices are paid.",
  },
];

export function signupGuide(): SignupRow[] {
  return SIGNUP.map((row) => ({ ...row }));
}

export function explainChoice(surface: "voice" | "chat"): string {
  if (surface === "voice") {
    return "Auto uses the same free pool and prefers the faster model. Paid and unknown-cost models stay hidden.";
  }
  return "Chat uses the same free pool and prefers the stronger model. Paid and unknown-cost models stay hidden.";
}

export function probePlan(text: string): { ok: boolean; reason: string } {
  const value = String(text || "");
  if (/sensitive|password|api[_-]?key|secret|token\s*[:=]/i.test(value)) {
    return { ok: false, reason: "refused" };
  }
  if (value.trim().length === 0 || value.length > 80) return { ok: false, reason: "refused" };
  return { ok: true, reason: "zero-cost probe" };
}

export function refreshOwnerMessage(): string {
  return "Refresh keeps the last good free list when a page does not parse. Startup does not download provider pages.";
}

export function probeOwnerMessage(): string {
  const plan = probePlan("ping");
  return plan.ok
    ? "Test my free models sends a tiny zero-cost probe with your saved key. It never sends a secret."
    : "Probe refused.";
}

export function verifyPackPlan(): string[] {
  return [
    "Hash each staged pack against the manifest.",
    "Run the pinned entry.",
    "Mark the Doctor row Ready only after that proof.",
  ];
}

export function ownerWave7Steps(): string[] {
  return [
    "Clean-install the voice test from Doctor.",
    "Say the wake word, then one sentence.",
    "Hold a 3-turn conversation.",
    "Start talking while FRIDAY is speaking.",
    "Disconnect the network mid-reply.",
    "Choose Refresh free list on Models.",
    "Choose Test my free models. It must not spend and must not send a secret.",
    "Send one Chat turn and one Auto turn. Both use the same free pool.",
    "If a step fails, copy the Doctor rows and the on-screen status.",
  ];
}
