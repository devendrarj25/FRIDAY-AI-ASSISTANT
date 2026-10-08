# FRIDAY — Providers, Models & Secrets

**Current shipping version: 1.0.1.2**

🔑 How FRIDAY reaches a model and where keys live. Connector list (113 services) is [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md), not this file. Threat model: [SECURITY.md](../SECURITY.md).

## 1. Local engines

No API key. Detected by `electron/models.cjs`. Auto-start uses `electron/startup.cjs` `ensureService` → `startEngine` (success only after the real probe answers). `config/services.json` `autoStart` wins when present, including an explicit empty list.

| Id | Name | Default | Install | Auto-start |
| --- | --- | --- | --- | --- |
| (separate) | Ollama | `http://127.0.0.1:11434` `GET /api/tags` | winget `Ollama.Ollama` | Yes — `ollama serve` |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234` | winget `ElementLabs.LMStudio` | Yes — `lms server start` when `lms` is on PATH |
| `llamacpp` | llama.cpp | `http://127.0.0.1:8080` | winget `ggml.llamacpp` | Starts the exact explicitly selected GGUF, or the only GGUF in `<FRIDAY_ROOT>/models` (`llama-server -m <file>`). Several files with no exact selection remain an honest ambiguity — FRIDAY will not guess. |
| `vllm` | vLLM | `http://127.0.0.1:8000` | pip `vllm` | Starts the exact explicitly selected safetensors folder, or the only folder in `<FRIDAY_ROOT>/models` (`vllm serve <dir>`). GGUF is not a vLLM start path; ambiguous folders are refused. |
| `localai` | LocalAI | `http://127.0.0.1:8081` | Native `local-ai` binary (Linux/macOS). Windows: vendor docs are Docker, no `local-ai.exe` — not a fake winget. | Yes when `local-ai` is on PATH — `local-ai run --address 127.0.0.1:8081` (8081 so llama.cpp keeps 8080) |
| `jan` | Jan | Desktop Local API `http://127.0.0.1:1337`; CLI fallback `http://127.0.0.1:6767` | winget `Jan.Jan` | No. Desktop Settings → Local API Server, or `jan serve <MODEL_ID>` (bare `jan serve` is interactive). A configured endpoint / `FRIDAY_JAN_ENDPOINT` wins; FRIDAY reports connected only after one candidate answers `/v1/models`. |
| `mlx` | MLX-LM | `http://127.0.0.1:8082` | pip `mlx-lm`, **darwin only** | macOS only, and only with exactly one safetensors folder (`mlx_lm.server --model`). Never listed or started on Windows. |

llama.cpp health is `GET /health`. OpenAI-compatible locals use `GET /v1/models`. Ollama uses native `/api/chat`, `/api/pull`, `/api/show`. Inventory, the Providers detector, Test Provider, and service health all resolve the same configured/environment/default endpoint candidates; none can claim Jan (or another compatible local engine) is offline while routing is using a different configured endpoint.

Hugging Face GGUF downloads write into `<FRIDAY_ROOT>/models` even when Ollama is down, so llama.cpp can auto-start from that file. Registering the same GGUF with Ollama is best-effort afterwards. An `ollama` source still needs the daemon running.

Default `autoStart` when `services.json` is missing: `ollama`, `lmstudio`, `localai`. Boot with no owner file still starts **every** engine whose `engineStatus().canStart` is true (including a one-GGUF llama.cpp).

## 2. Cloud (`CLOUD` in `electron/models.cjs`)

Twenty dispatch ids: `openai` OpenAI, `anthropic` Anthropic, `gemini` Google Gemini, `groq` Groq, `mistral` Mistral, `cohere` Cohere, `deepseek` DeepSeek, `nvidia` NVIDIA NIM, `fireworks` Fireworks AI, `deepinfra` DeepInfra, `cerebras` Cerebras, `sambanova` SambaNova Cloud, `moonshot` Moonshot (Kimi), `zhipu` Z.ai (GLM), `huggingface` Hugging Face Inference, `together` Together AI, `xai` xAI (Grok), `perplexity` Perplexity, `nebius` Nebius Token Factory, `openrouter` OpenRouter.

Chat wire is built in `kernel/router.py` (`PROVIDER_SURFACES`). UI labels: `src/lib/friday/model-catalog.ts`.

Not added (vendor verification failed):

- **GitHub Models** — retired 2026-07-30. `models.github.ai` returns HTTP 410.
- **Cloudflare Workers AI** — chat is OpenAI-compatible at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` with a Bearer token, but the account id is required in the URL and there is no OpenAI `GET /v1/models` on that chat base (listing is `GET /accounts/{account_id}/ai/models/search`). The existing CLOUD table is one chat base + one key; adding this would be a half-wired extra field.

## 3. Keys

`electron/credentials.cjs` stores secrets under `<FRIDAY_ROOT>/security/credentials` via Electron `safeStorage`. The renderer never holds a decrypted key. A “connected” badge is written only after a live list/probe succeeds (`electron/models.cjs`). Connected means AUTHENTICATED + MODEL_CATALOGUE_AVAILABLE. It does not mean a free model is LIVE_CHAT_VERIFIED.

## 4. Firewalls

- Billing: `electron/billing-firewall.cjs` is the final authority. A paid or unknown-cost model is never a silent default. Cost policy: `src/lib/friday/brain/cost-policy.ts`. Every local engine id (`ollama`, `llamacpp`, `lmstudio`, `vllm`, `localai`, `jan`, `mlx`) is billingClass `free`. A cloud model is free to dispatch when `electron/model-access.cjs` has official free evidence (`ZERO_COST`, `FREE_QUOTA`, or `FREE_CREDIT`, eligible, from a listed source) or a verified free probe. Listing a model is not that evidence. An API key alone is not paid authorisation.
- Privacy: `electron/privacy-firewall.cjs` plus `kernel/privacy.py` — SENSITIVE payloads hard-stop. Local engine ids are never treated as leaving the machine.

Network: `electron/net-fetch.cjs` (Windows proxy / TLS).

## 5. Free vs paid cloud models

Classification lives in `electron/model-access.cjs` (used by `electron/models.cjs`, `electron/model-router.cjs`, and the billing firewall). There is one catalogue and one router. A name containing “free”, a `:free` suffix, a provider free tier, a free signup, Studio/web/chat access, or a successful `/models` listing is a **signal**, not proof. The canonical access object retains provider/model/endpoint/wire, normalized pricing, entitlement/quota/rate-limit evidence, capability metadata, live chat/stream proof, TTL timestamps, health and failure reason.

Billing modes: `ZERO_COST` (official API price is $0), `FREE_QUOTA` (eligible free-plan/rate-limit quota), `FREE_CREDIT` (trial / promotional / grant credits covering this call), `PAID`, `UNKNOWN`. `creditSource` is `TRIAL` | `PROMOTIONAL` | `GRANT` | `USER_FUNDED` | `UNKNOWN`. Only TRIAL / PROMOTIONAL / GRANT may produce `FREE_CREDIT`. A user-funded or unknown balance is `PAID` or `UNKNOWN`, never free. Eligibility: `ELIGIBLE`, `RATE_LIMITED`, `EXHAUSTED`, `NOT_ELIGIBLE`, `UNKNOWN`. Verification: `VERIFIED` only after the existing chat probe succeeds. Official free evidence is coarse `free` while verification stays `UNVERIFIED` until that probe. `UNKNOWN` is never converted to free by a name or a successful call alone.

Free-only routing is fail-closed: `filterByTier(..., "free")` and `selectEligible` with `free-only` never fall back to paid or unknown models (`NO_FREE_MODEL_AVAILABLE`). HTTP 429 is `RATE_LIMITED` / `FREE_RATE_LIMITED`, never paid. HTTP 402 blocks the call but does not overwrite the model's underlying pricing evidence. Exhausted free credits stay `EXHAUSTED`; they are not silently billed. Live verification is **lazy**: classify from official evidence, filter capability + route mode + owner pool + cost policy, rank candidates, probe only a candidate the request can actually use, cache proof per key/model/tier (~30 minutes), then try the next eligible candidate only when required. A successful call on an unknown-cost model proves chat access, not a free entitlement. Stream and non-stream verification are retained separately. Renderer selection IPC, one-shot kernel writing, desktop chat, and phone fallback consume that routed pool; unpublished live routing, invalid explicit ids, and cooling-down ids fail closed instead of widening to the kernel's independent catalogue. Only `multi` fans out concurrently.

Provider adapters (same `CLOUD` ids):

| Provider | How free is decided |
| --- | --- |
| OpenRouter | Catalogue `pricing` in/out = 0 → `ZERO_COST` and coarse `free`. `openrouter/free` is the dynamic free router (`provider_router`), also coarse `free`, still `UNVERIFIED` until a probe. `:free` without a zero price is not proof. Auto does not sort this router first. |
| Groq | Re-read [rate limits](https://console.groq.com/docs/rate-limits) on 2026-10-07. The page embeds `freeRows`. Those exact ids are `FREE_QUOTA` unless the account is declared developer or paid. Developer prices stay on the record. `llama-3.3-70b-versatile` is not in `freeRows` and stays `UNKNOWN`. A name containing "free" is not proof. Audio, whisper, prompt-guard, and safeguard ids stay out of chat by capability. |
| Gemini | Official [API pricing](https://ai.google.dev/gemini-api/docs/pricing), re-read 2026-10-07. Families whose Standard input was "Free of charge" are `FREE_QUOTA` and eligible. A paid project, or an owner declaration of paid, overrides that. A missing project tier does not. A 3.x id outside that list stays unknown. 2.0 and 1.5 were not on that page. Image, Omni, Veo, and Lyria stay unknown. AI Studio/web free usage is not entitlement proof. `models/` is stripped before the match. |
| Hugging Face | A `$0` route is `ZERO_COST`. Monthly included credits are `GRANT` → `FREE_CREDIT` only when the account says so. The free-user `$0.10` monthly credit is not a per-model free price, so a model with no `$0` route stays `UNKNOWN` until the owner declares it. Custom provider keys are that provider's billing. |
| Cohere | Re-read [list models](https://docs.cohere.com/reference/list-models) and [rate limits](https://docs.cohere.com/docs/rate-limits) on 2026-10-07. `GET /v1/models` returns `models[].name`, `endpoints`, `is_deprecated`, and `context_length`. Deprecated chat models are dropped. `next_page_token` is not followed yet. Evaluation and trial keys are the limited free signal (1,000 calls a month on that page). Production keys are paid. Prod keys on newer Command variants are limited like trial keys, so that limit is not a $0 price. |
| xAI | Native `/v1/models` fields (`prompt_text_token_price`, `completion_text_token_price`, image token prices) are normalized into `pricing.input` / `pricing.output`. Price > 0 → `PAID`. |
| Cerebras, Fireworks, Together, Nebius, SambaNova, Moonshot, DeepInfra | Account credits only when `creditSource` is trial (`FREE_QUOTA`) or promotional/grant (`FREE_CREDIT`). User-funded balance is `PAID`. `$0` catalogue price → `ZERO_COST`. Cerebras has no permanent free tier: the public page is a $5 credit after a payment method, so models stay `UNKNOWN` without that account evidence. SambaNova's pricing URL returned 404 on 2026-10-07, so it stays on this credit rule. Together prefers current `api.together.ai` and retains `api.together.xyz` only as an alternate-host fallback. |
| Z.ai | [Pricing](https://docs.z.ai/guides/overview/pricing), re-read 2026-10-07. `glm-4.7-flash`, `glm-4.5-flash`, and `glm-4.6v-flash` are `FREE_QUOTA`. Other ids stay on the credit rule. A declared paid account overrides the three free ids. |
| Mistral | `/v1/models` plus isolated [API pricing](https://mistral.ai/pricing/api), re-read 2026-10-07. Priced rows stay metered `PAID`. "Mistral Moderation 2" is shown as Free and has no API id on that page, so no id was marked free. Voxtral TTS output is priced. Studio / Le Chat / web free is not API-free. |
| NVIDIA | [build.nvidia.com/llms.txt](https://build.nvidia.com/llms.txt), re-read 2026-10-07, says every catalog model has a free trial and no credit card. A row returned by that catalogue, with no positive price, is `FREE_QUOTA`. An id that was never listed stays `UNKNOWN`. A positive catalogue price, or a declared paid account, is `PAID`. Localhost stays local. |
| DeepSeek, OpenAI, Anthropic, Perplexity | Current public API pricing is metered. ChatGPT/Claude/consumer Perplexity free access is not API-free. |
| Local engines | `local_runtime` — not sent through the cloud billing firewall. |

Where a vendor has no machine-readable free/pricing API, FRIDAY keeps isolated official knowledge with `checkedAt` + TTL and **fails closed** when that knowledge is stale or missing. It does not scrape unofficial free-model websites and does not invent a pricing endpoint.

`KNOWLEDGE_CHECKED_AT` stays 2026-09-30. A source moves only after its own page is re-read. On 2026-10-07 that set is OpenAI, Anthropic, Gemini, Groq, DeepSeek, Perplexity, Mistral, NVIDIA, and Z.ai. Sync now lists sources inside a two-day lead. It does not download the pages. OpenAI, Anthropic, DeepSeek, and Perplexity published non-zero API prices on the pages named in `METERED_API_DEFAULT`. Perplexity's separate router rate card was not fetched. Consumer plan pages are not API-free. GitHub Models was retired on 2026-07-30 and is not a provider. Cloudflare Workers AI needs an account id in the URL and has no OpenAI `GET /v1/models` on that chat base, so it is not a provider.

Live probe: existing `probeModel()` sends a tiny chat turn (stream first, then non-stream), checks HTTP success plus usable assistant text, and classifies auth, billing, quota/rate-limit, timeout, provider outage, network, context-overflow and stream failures separately. Streaming text is read from `choices[].delta.content`, `delta.text`, `choices[].text`, content parts, and `[DONE]`. Successful verification is cached (~30 minutes), synchronized into the kernel before dispatch, and surfaced through `keyConfigured`, `authenticated`, `catalogueFetched`, `pricingKnown`, `freeEligibilityKnown`, `freeModelAvailable`, `chatVerified` and `streamVerified`. The billing firewall remains the last authority.

## 6. One routing contract

Chat, Voice, Auto, Manual, Multi, Companion, background tasks, agents and tool calls share one routing contract (`src/lib/friday/model-routing-contract.ts`, mirrored in `electron/model-router.cjs`):

- `routeMode`: `auto` | `local-only` | `cloud-only` | `hybrid` | `manual` | `multi`
- `costPolicy`: `free-only` | `free-first` | `balanced` | `quality-first` | `paid` | `paid-only`
- `qualityTarget`: `balanced` | `fastest` | `best-quality` | `cheapest` | `private` | `reliable` | `deep-reasoning` | `research-grade` | `local-preferred` | `cloud-preferred` | `diverse`
- `strategy`: `auto` | `single` | `fallback` | `parallel` | `race` | `cascade` | `pipeline` | `primary-critic` | `primary-verifier` | `candidate-judge`
- `task` / `requirements` (streaming, tools, vision, context, locality, privacy, strict evidence, allow inferred)
- `selectedModelIds` / `selectedProviderIds`

`balanced` is the default and adds nothing to the existing score. `fastest`, `best-quality`, `cheapest`, `reliable`, `deep-reasoning`, `research-grade`, `local-preferred`, and `cloud-preferred` only adjust that score. `diverse` adds nothing and then interleaves model families. `private`, and `requirements.privacy` of `private`, are a hard local filter: the prompt stays on this PC. Private together with cloud-only is an empty pool. The route mode is not rewritten to hide that. Local-preferred and cloud-preferred do not switch the route mode.

`strategy` defaults to `auto`. One chat stays a shortlist. A second-opinion run stays parallel until the owner picks another shape. Critic, verifier, judge, specialist, and synthesizer roles keep the owner's prompt and see earlier drafts. The judge is a different backend when one is in the shortlist. Fallback stops at the first answer and does not relax privacy, mode, tools, vision, context, or billing.

Hard filters run before the score, in this order: route mode, privacy, locality, provider, then the shared usable-model decision (not connected, retired, out of quota, cooldown, cost, not a chat model), then cloud opt-in, role, streaming, tools, vision, context, and evidence. A paid or unknown model with paid access off is rejected as cost. A cooldown is rejected as cooldown and stays visible in the selector, disabled. A retired or deprecated model is dropped. Vision and tools that exist only as a name guess are dropped unless the turn allows inferred evidence. `planRoute` returns the same candidate ids as `selectEligible`, a stable plan id, the steps, and a reason for each model the filters dropped.

HTTP 400 and HTTP 422 are `invalid_request`: not retryable, and the cooldown is 0 so the provider is not cooled down. A 429 uses Retry-After when the error carries one, capped at one hour; a bare rate limit still cools down for one minute. A daily cap stays an hour. A 5xx stays a retryable provider error. A rejected key and a missing model stay non-retryable.

The owner-selected route mode is never translated (`local-only` does not become `auto`; `cloud-only` does not become `manual`). Auto picks the best currently eligible model — it does not hardcode OpenRouter. Eligible means `usableModels()`: connected, and free or paid access on, and not retired. Paid and unknown-cost models enter only when paid access is on. A fallback stays inside that same set. Desktop chat and `kernel:rpc` both send the route mode so `kernel/router.py` can re-enforce local-only / cloud-only / manual, and a private turn, as the last safety boundary. The desktop logs one plan sentence. That log does not change who is selected.

The chat selector renders that same `usableModels()` result. A hidden row is not shown. A cooldown or an exhausted quota stays visible and disabled, with the reason. Each row reads `Provider · Model` plus `FREE`, `PAID`, `LOCAL`, or `cost unknown`. Owner-declared evidence adds the mark `owner declared`. After a turn, the message stores `answeredBy` from the router trace. The conversation strip shows that line once, with the step count and the chart button. The Flow Studio chat chart reads the same stored line. The message text stays the answer.

### Routing research (2026-10-05)

Recorded once from public write-ups read that day. This is not a second router.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Rules first, then cost and quality, with fallback kept separate | ADOPT | Hard filters stay first. Quality targets only change the score. A fallback stays inside the same constraints. Sources: MLflow, LLM Routing in Production (mlflow.org/articles/llm-routing/); TrueFoundry, cost and quality routing (truefoundry.com/blog/llm-routing). Accessed 2026-10-05. |
| Classify the error before any retry | ADOPT | A deterministic 400 or 422 does not retry and does not open a cooldown. Timeouts, 429 bursts, and 5xx still can. |
| Quality modifiers on the existing score | ADAPT | Optional `qualityTarget` on the one contract. `balanced` is today's order. `private` is the hard local filter, not a score tweak. `diverse` reorders families and does not change the score. |
| Multi-model roles on the same shortlist | ADAPT | `strategy` assigns answer, fallback, peer, critic, verifier, judge, and pipeline steps. Execution stays in the existing parallel chat path. Each call still passes the privacy and billing firewalls. |
| Name heuristics as last-resort evidence | ADOPT | Vision and tools whose only source is a name guess are rejected. A curated registry record or a declared capability still passes. |
| Retry-After on 429 | ADOPT | The cooldown uses the provider's Retry-After when the error carries one. A deterministic 400 still does not open a cooldown. |
| Learned two-model routing and semantic routers | REJECT | No learned weights and no second router. RouteLLM-style selectors and the vLLM Semantic Router (arxiv.org/abs/2603.04444) stay out. |
| A cascade that silently downgrades quality or privacy | REJECT | Fallback is a new decision inside the same policy. It does not relax privacy, mode, tools, or billing. |

### Routing added (2026-10-07)

Race and cascade are strategies on this same router. A cascade orders cheaper models first and continues when the cheap answer is short or uncertain. A race keeps the first successful answer and does not cancel the others. After three recorded trials, success rate, latency, and owner feedback adjust the existing score. They do not skip privacy or the billing firewall. A separate learned router stays out. The 2026-10-05 rejection of that second router still stands.

### Routing added (2026-10-08)

After one failed candidate, the same router orders what is left: the same model on another endpoint, then a sibling on that provider, then the same family on another provider, then any other model that already passed privacy and billing. A provider outage tries a different backend before another endpoint on the failed one. A deterministic 400 or 422, a content filter, a region block, a billing refusal, and a context overflow do not move to another model. A context overflow may move only after the caller says the prompt was compacted. Three provider errors quarantine that model; three deterministic 400s do not. A passed recovery probe clears the cooldown.

The routable catalogue swaps only when the next list is an array of unique ids. A broken refresh keeps the previous generation. Multi plans name their aggregation (`parallel`, `staged`, `critic`, `verifier`, `judge`, or `fallback`). A parallel or race plan is the only fan-out. The chat path logs one execution trace and does not send that trace to the owner. The sentence drops hidden reasoning and any secret assignment.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Advance a fallback only when another provider could succeed | ADOPT | A 400 is the request. Timeouts, 429, and 5xx may move. Sources: nRouter fallback chains (nrouter.ai/blog/engineering/provider-fallback-chains); LiteLLM deployment order (docs.litellm.ai/docs/routing). Accessed 2026-10-08. |
| Try another endpoint of the same model before a different model | ADAPT | LiteLLM weighted failover stays inside the group first. FRIDAY's order is endpoint, sibling, family, then any other allowed model, and a provider-wide outage prefers a different backend. |
| Circuit breaker with a recovery probe | ADAPT | Three retryable failures quarantine. A deterministic 400 never does. One probe success clears it. No second router. |
| Learned semantic router | REJECT | Still the 2026-10-05 decision. No second scoring stack. |

### Routing added (2026-10-08, escalation)

The model plan's learned value estimator and a second providers package tree were not added. Bedrock, Foundry, and Vertex stay off the cloud list until the owner connects those accounts. vLLM stays an optional local serve command. The vLLM package is not a dependency. Video demos are not an implementation source, and a video index was not added.

A model refusal, a failed tool call, a schema mismatch, and a low-confidence verification move to the next model that already passed privacy and billing. A content filter still stops. Those answer failures do not open a cooldown or a quarantine. A context overflow still moves only after the caller marks the prompt compacted. Catalogue refresh is by trigger: startup checks health and a stale catalogue, the Models page may read every layer, a background pass uses catalogue, health, and lifecycle with jitter, and a chat turn refreshes only when the catalogue is stale. A repair that would rotate a key, change privacy, upload weights, enable a paid provider, or replace a pinned model stays with the owner. `models:heal` calls that gate.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Separate fallback classes for context, policy, and other errors | ADAPT | LiteLLM keeps content-policy, context-window, and general fallbacks as different lists (https://docs.litellm.ai/docs/proxy/reliability, accessed 2026-10-08). FRIDAY moves a refusal, a tool failure, a schema miss, and low confidence. A content filter still stops. |
| Refresh by trigger, not on every turn | ADAPT | OpenRouter and provider catalogues change, and a full sweep on each chat turn is wasted work. FRIDAY refreshes a stale catalogue before routing and leaves a fresh one alone. |
| Owner-only repairs stay manual | ADOPT | Healing a stale endpoint cache is allowed. Rotating a key or turning paid access on is not. |

Catalogue TTL is 10 minutes, pricing 30 minutes, entitlement 10 minutes, successful probes 30 minutes. Background refresh reuses `refreshRoutable` after the catalogue TTL; API key / endpoint / route-mode changes invalidate immediately. Lifecycle kinds (`MODEL_DISCOVERED`, `MODEL_VERIFIED`, `MODEL_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_EXHAUSTED`, `MODEL_RETIRED`, `MODEL_REMOVED`, `PROVIDER_CONNECTED`, `API_KEY_CHANGED`, `ROUTE_CHANGED`) are stamped onto the existing `models:registry-changed` / `models:health-changed` / `models:route-mode` broadcasts — not a second event bus.
