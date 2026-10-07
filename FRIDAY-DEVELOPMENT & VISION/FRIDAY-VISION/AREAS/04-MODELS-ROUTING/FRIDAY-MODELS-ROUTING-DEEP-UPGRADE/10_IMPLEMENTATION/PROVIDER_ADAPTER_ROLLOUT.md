# Provider rollout order

## Tier 1 — already strong in current FRIDAY

OpenAI, Anthropic, Gemini, Groq, Mistral, Cohere, DeepSeek, NVIDIA NIM, Fireworks, DeepInfra, Cerebras, SambaNova, Moonshot, Z.ai, Hugging Face, Together, xAI, Perplexity, Nebius, OpenRouter.

First convert these existing tables into manifest-backed adapters.

## Tier 2 — gateway/enterprise expansion

AWS Bedrock, Microsoft Foundry, Google Vertex AI.

These require deployment/region/account identity in addition to model identity.

## Tier 3 — local runtimes

Ollama, LM Studio, llama.cpp, vLLM, SGLang, LocalAI, Jan, MLX-LM.

Treat runtime and model artifact separately.

## Tier 4 — future providers

A generic adapter SDK must allow any provider that exposes:

- model discovery;
- an inference operation;
- a documented wire;
- auth;
- health.

Providers with no model-list endpoint can still be supported using a manifest-defined catalogue source or explicit model registration, but those models must be marked `catalogue_source=manual` rather than pretending to be dynamically discovered.
