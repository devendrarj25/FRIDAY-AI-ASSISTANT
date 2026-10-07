# AI-OS and agent-system patterns to borrow

This is not a copy of another product. These are patterns FRIDAY should combine.

## 1. AIOS — operating-system kernel thinking

AIOS separates LLM-specific services from agent applications and treats scheduling, context, memory, storage, access control and resource management as kernel services. FRIDAY should apply the same idea to model resources: the brain asks for intelligence; the model kernel decides which resource can execute it.

Source: https://arxiv.org/abs/2403.16971

## 2. Microsoft Foundry Model Router — learned model choice

Foundry uses a trained router to choose among models in real time. The key FRIDAY lesson is that model selection can be an explicit learned subsystem rather than a giant static `if/else` table.

Sources:
- https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router
- https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router

## 3. Amazon Bedrock Intelligent Prompt Routing — predicted quality vs cost

Bedrock routes requests among models in a family using predicted response quality, explicitly optimizing quality and cost. FRIDAY should preserve this concept but extend it across vendors, local runtimes and privacy constraints.

Source: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html

## 4. OpenRouter — provider endpoint routing

OpenRouter demonstrates a second routing layer below model selection: the same model can have multiple providers/endpoints, and endpoints can be sorted by price, throughput or latency. It also supports model fallbacks and an auto-router.

Sources:
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/guides/routing/model-fallbacks
- https://openrouter.ai/docs/guides/routing/routers/auto-router

FRIDAY should therefore score **model candidate** and **endpoint candidate** separately.

## 5. Hugging Face Inference Providers — provider selection abstraction

HF lets a caller explicitly choose a provider or let the system select automatically, and the client adapts the HTTP request to the chosen provider. Automatic provider selection can fail over to alternatives.

Sources:
- https://huggingface.co/docs/inference-providers/en/index
- https://huggingface.co/docs/inference-providers/en/guides/first-api-call

FRIDAY should adopt this as a provider-federation pattern, but retain direct-provider credentials and native adapters when the user has them.

## 6. LiteLLM / Portkey — gateway operations

These systems demonstrate production patterns: fallback models, load balancing, latency/throughput routing, conditional routing, nested strategies and operational control. FRIDAY should borrow the control patterns without making itself dependent on a third-party gateway.

Sources:
- https://docs.litellm.ai/
- https://docs.portkey.ai/docs/product/ai-gateway/load-balancing
- https://docs.portkey.ai/docs/guides/use-cases/combining-routing-strategies

## 7. Research warning — routing is not magic

Recent routing research shows that learned routers can underperform a strong fixed model and that task type can explain much of the routing opportunity. Therefore FRIDAY should not trust a single learned router. Use a **hybrid router**: hard constraints → task classifier → candidate scoring → optional learned value estimator → empirical performance profile → diversity/ensemble logic.

Sources:
- https://arxiv.org/abs/2608.23023
- https://arxiv.org/abs/2608.20316

## Resulting FRIDAY principle

**The router is a resource allocator, not a model-name chooser.**
