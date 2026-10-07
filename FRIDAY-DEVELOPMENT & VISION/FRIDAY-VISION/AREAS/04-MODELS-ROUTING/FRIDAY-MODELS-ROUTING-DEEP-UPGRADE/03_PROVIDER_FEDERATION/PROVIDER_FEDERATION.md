# Provider Federation

FRIDAY must support providers through five protocol classes:

1. **Native vendor API** — exact vendor request/response contract.
2. **Official OpenAI-compatible API** — only when documented by that provider.
3. **Official Anthropic-compatible API** — only when documented.
4. **Local runtime API** — Ollama, LM Studio, llama.cpp, vLLM, SGLang, LocalAI, Jan, MLX-LM etc.
5. **Gateway/aggregator** — OpenRouter, Hugging Face Inference Providers, LiteLLM-compatible gateways and future gateways.

## Adapter interface

Every adapter must implement or declare:

- `discover()`
- `authenticate()`
- `listModels()`
- `getModel(modelId)` when available
- `getCapabilities(modelId)` or metadata mapping
- `invoke(request)`
- `stream(request)`
- `cancel(request)` if supported
- `health()`
- `limits()` when discoverable
- `pricing()` when officially discoverable
- `lifecycle()` / deprecation source
- `install()` only for runtimes that support it
- `load()` / `unload()` for runtimes that support it
- `inspectRuntime()`
- `normalizeError()`

## Provider package boundary

```text
providers/<provider-id>/
  manifest.json
  adapter.ts
  discovery.ts
  transport.ts
  metadata.ts
  lifecycle.ts
  health.ts
  install.ts           # optional
  tests/
  sources.md
```

The router must never import provider-specific code directly. It asks the Provider Registry for an adapter.
