# Coding-agent master implementation prompt — FRIDAY MODELS / PROVIDERS / ROUTING

You are upgrading the existing FRIDAY repository. This package is the design authority for the **Models + AI Providers + Model Lifecycle + Routing** section only.

## 1. Read before editing

Read:

- this entire package;
- `FRIDAY-main/AGENTS.md`;
- `FRIDAY-main/ARCHITECTURE.md`;
- `FRIDAY-main/FRIDAY_STATE.md`;
- all current model/provider/router files listed in `01_CURRENT_SOURCE_TRUTH`;
- current model/provider tests.

Do not start coding after reading only the README.

## 2. Preserve existing architecture

Do not rebuild Brain, System, Chat, Voice or Mobile. They already exist. The new model fabric must expose stable contracts to them.

## 3. Build the Model Intelligence Fabric

Implement these resource types:

- ProviderManifest
- ProviderAccount
- ProviderEndpoint
- ModelResource
- ModelDeployment
- ModelArtifact
- CapabilityEvidence
- HealthSnapshot
- PerformanceProfile
- RoutePlan
- ExecutionTrace

## 4. Provider adapters

Create manifest-backed adapters for all providers currently present in the repository before adding new ones. Then add Bedrock, Foundry and Vertex AI. Then local runtimes.

Do not assume every provider is OpenAI-compatible.

## 5. Discovery

Discovery must use the provider's official documented method whenever possible. Store raw source evidence separately from normalized metadata. Never fabricate missing metadata.

## 6. Model identity

Separate:

`logical model → version → deployment → endpoint → runtime`

A model appearing through OpenRouter, Bedrock, Foundry or direct vendor API must not be treated as four unrelated model families.

## 7. Modes

Implement exactly:

- AUTO
- LOCAL ONLY
- CLOUD ONLY
- MULTI
- MANUAL

Manual mode allows one or more explicit model endpoints.

Auto mode chooses intelligently.

Multi mode supports parallel, primary/critic, primary/verifier, specialist panel, candidate/judge and pipeline.

## 8. Router

Implement staged routing:

1. compile task contract;
2. hard policy filter;
3. candidate expansion;
4. capability evidence gate;
5. deterministic utility score;
6. optional learned/value estimate;
7. value-of-information decision;
8. route plan;
9. execute with budgets;
10. validate;
11. fallback/escalate;
12. record operational learning.

The router must select both **model** and **endpoint/deployment**.

## 9. Auto fix / refresh / fallback

Implement:

- atomic catalogue refresh;
- stale detection;
- retry classification;
- Retry-After handling;
- cooldown/circuit breaker;
- recovery probes;
- interrupted-download resume;
- checksum verification;
- local model registration repair;
- deprecation migration suggestions.

Never silently alter privacy mode or paid-account policy.

## 10. Local model system

Support runtime-specific operations for:

- Ollama
- LM Studio
- llama.cpp
- vLLM
- SGLang
- LocalAI
- Jan
- MLX-LM

Separate artifact state from runtime load state.

## 11. UI

Upgrade the Models page according to `13_UI_MODEL_SECTION/MODELS_PAGE_BLUEPRINT.md`.

The user must be able to:

- connect providers;
- discover models;
- inspect model details;
- install local models;
- select one or multiple models;
- select modes;
- inspect routing decisions;
- see health and performance;
- force refresh;
- diagnose provider/model failures.

## 12. Testing

Before declaring completion:

- run all existing tests;
- add provider contract tests;
- add schema tests;
- add mode boundary tests;
- add local-only egress tests;
- add failure injection tests;
- add multi-model tests;
- add route explanation tests;
- test at least one real local runtime if available;
- test every configured cloud provider's catalogue endpoint when credentials are present.

## 13. Definition of done

The work is complete only when:

- no duplicate registry is authoritative;
- all providers are adapter-backed;
- all discovered models have normalized cards;
- capabilities carry evidence;
- lifecycle is represented;
- Auto/Local/Cloud/Multi/Manual work;
- fallback is policy-safe;
- local installation is recoverable;
- routing is explainable;
- current FRIDAY functionality remains green.

Do not mark “done” because files were created. Mark done only after runtime verification.
