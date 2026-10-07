# Acceptance matrix

## Provider

- [ ] Every Tier-1 provider has a manifest.
- [ ] Adapter can discover real models.
- [ ] Authentication state is separated from reachability.
- [ ] Model entitlement is tested independently.
- [ ] Native vs compatibility wire is explicit.
- [ ] Error normalization is tested.

## Model intelligence

- [ ] Every discovered model gets a normalized card.
- [ ] Every capability has evidence.
- [ ] Lifecycle/deprecation is represented.
- [ ] Context/max-output are not guessed when official metadata exists.
- [ ] Pricing has source and timestamp when available.

## Local

- [ ] Ollama pull/show/list works.
- [ ] LM Studio inventory and lifecycle work.
- [ ] llama.cpp server inventory works.
- [ ] vLLM inventory works.
- [ ] SGLang inventory works.
- [ ] LocalAI inventory works.
- [ ] Jan inventory works.
- [ ] MLX-LM works where platform supports it.
- [ ] Downloads resume and verify.
- [ ] Corrupt artifacts are quarantined.

## Modes

- [ ] Auto chooses local/cloud under policy.
- [ ] Local Only never sends user content to cloud.
- [ ] Cloud Only never silently invokes local inference.
- [ ] Manual pins exact model endpoints.
- [ ] Multi runs configured number and strategy.

## Routing

- [ ] Capability hard filters precede scoring.
- [ ] Provider endpoint selection is separate from model selection.
- [ ] Fallback respects privacy and capability.
- [ ] Retry respects error class and Retry-After.
- [ ] Circuit breaker works.
- [ ] Diversity-aware Multi mode works.
- [ ] Route decision is explainable.

## Regression

- [ ] Existing model/provider tests pass.
- [ ] Existing brain/chat/voice/mobile tests remain green.
- [ ] No duplicate provider registry remains authoritative.
