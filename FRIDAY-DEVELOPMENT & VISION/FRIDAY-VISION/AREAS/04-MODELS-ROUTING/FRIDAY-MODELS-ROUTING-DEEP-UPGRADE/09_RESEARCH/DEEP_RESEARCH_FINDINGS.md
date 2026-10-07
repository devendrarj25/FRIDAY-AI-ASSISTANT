# Deep research findings — what FRIDAY should learn from the ecosystem

## Finding A — two-level routing is essential

OpenRouter demonstrates provider endpoint selection under a model. Microsoft/AWS demonstrate model selection. FRIDAY needs both:

`Task → Model Family/Model → Endpoint/Deployment → Runtime → Wire`

## Finding B — capability metadata must be endpoint-aware

Gemini exposes multiple model classes and specialized endpoints. Cohere exposes Chat, Rerank, Embed, Parse and Transcribe. Replicate exposes per-version OpenAPI schemas. Bedrock model availability depends on endpoint/region/inference profile. Therefore a single `supportsTools=true` field is insufficient.

## Finding C — health is not one boolean

Separate:

`dns/reachability → auth → catalogue → entitlement → model availability → inference → stream → tool-call → schema validity`

## Finding D — routing needs empirical performance memory

Provider docs tell FRIDAY what a model **can** do. They do not tell FRIDAY how that endpoint is behaving **right now** for Dev's machine/account/network. Keep a short-lived operational performance profile.

## Finding E — multi-model should optimize information, not quantity

The goal is not “use more models.” The goal is “buy enough independent information to reduce error.” Use value-of-information and disagreement signals.

## Finding F — strong models are not always the right model

Fast models can handle classification, extraction, routing and small transformations. Strong reasoning models should be reserved for tasks where their incremental quality matters. The router should learn this from task classes.

## Finding G — local/cloud should be a policy boundary

Auto mode may choose local first for privacy, latency and cost, then cloud when the task requires a capability unavailable locally. The transition must be explicit in the decision trace and impossible in Local Only.

## Finding H — model lifecycle is a first-class problem

Providers expose preview/latest/experimental/deprecated/retired states. FRIDAY should route away from retired models automatically and warn about deprecation before breakage.

## Finding I — model identity is multi-dimensional

`GPT-X` or `Llama-Y` can exist in several providers and deployments. Internal identity should therefore be stable while native provider IDs remain attached as endpoint-specific fields.

## Finding J — provider adapters are the future-proofing layer

The router should not know that a provider uses `/v1/models`, `/models`, `/foundation-models`, GraphQL, SDK-only discovery, a local daemon or a proprietary API. The adapter knows; the router sees normalized contracts.
