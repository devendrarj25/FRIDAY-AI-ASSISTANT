# FRIDAY — Providers, Models & Secrets

**Current shipping version: 1.1.2.4**

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

Signup links for those twenty cloud ids are on the Models page. Checked 2026-10-10: OpenAI's rate-limit page names a Free usage tier only in an allowed geography, and that is not a per-model price (developers.openai.com/api/docs/guides/rate-limits). Anthropic's pricing page says new API users can receive a small credit and lists paid token prices (docs.anthropic.com/en/about-claude/pricing). Fireworks serverless pricing is prepaid credit (docs.fireworks.ai/serverless/pricing). Nebius Token Factory grants a short trial credit and requires a card (docs.tokenfactory.nebius.com/other-capabilities/billing-new). DeepInfra's pricing page requires a card or a prepaid balance (deepinfra.com/pricing). None of those five is treated as an always-free model list.

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
| Groq | Re-read [rate limits](https://console.groq.com/docs/rate-limits) on 2026-10-13. The only table on that page is the Developer plan base limits, and [models](https://console.groq.com/docs/models) publishes a price for those ids. A priced id is `PAID` until the owner declares that account free. An id that is not in the price table, including `llama-3.3-70b-versatile`, stays `UNKNOWN`. A name containing "free" is not proof. Audio, whisper, prompt-guard, and safeguard ids stay out of chat by capability. |
| Gemini | Official [API pricing](https://ai.google.dev/gemini-api/docs/pricing), re-read 2026-10-13. Families whose Standard input was "Free of charge" are `FREE_QUOTA` and eligible. A paid project, or an owner declaration of paid, overrides that. A missing project tier does not. Prefixes that were not on that page, including `gemini-3.7-flash` and bare `gemini-3.5-flash`, stay unknown. 2.0 and 1.5 were not on that page. Image, Omni, Veo, and Lyria stay unknown. AI Studio/web free usage is not entitlement proof. `models/` is stripped before the match. |
| Hugging Face | A `$0` route is `ZERO_COST`. Monthly included credits are `GRANT` → `FREE_CREDIT` only when the account says so. The free-user `$0.10` monthly credit is not a per-model free price, so a model with no `$0` route stays `UNKNOWN` until the owner declares it. Custom provider keys are that provider's billing. |
| Cohere | Re-read [list models](https://docs.cohere.com/reference/list-models) and [rate limits](https://docs.cohere.com/docs/rate-limits) on 2026-10-07. `GET /v1/models` returns `models[].name`, `endpoints`, `is_deprecated`, and `context_length`. Deprecated chat models are dropped. `next_page_token` is not followed yet. Evaluation and trial keys are the limited free signal (1,000 calls a month on that page). Production keys are paid. Prod keys on newer Command variants are limited like trial keys, so that limit is not a $0 price. |
| xAI | Native `/v1/models` fields (`prompt_text_token_price`, `completion_text_token_price`, image token prices) are normalized into `pricing.input` / `pricing.output`. Price > 0 → `PAID`. |
| Cerebras, Fireworks, Together, Nebius, SambaNova, Moonshot, DeepInfra | Account credits only when `creditSource` is trial (`FREE_QUOTA`) or promotional/grant (`FREE_CREDIT`). User-funded balance is `PAID`. `$0` catalogue price → `ZERO_COST`. Cerebras has no permanent free tier: the public page is a $5 credit after a payment method, so models stay `UNKNOWN` without that account evidence. SambaNova's pricing URL returned 404 on 2026-10-07, so it stays on this credit rule. Together prefers current `api.together.ai` and retains `api.together.xyz` only as an alternate-host fallback. |
| Z.ai | [Pricing](https://docs.z.ai/guides/overview/pricing), re-read 2026-10-13. `glm-4.7-flash` and `glm-4.5-flash` are `FREE_QUOTA`. `glm-4.6v-flash` is no longer a Free row and stays `UNKNOWN`. Other ids stay on the credit rule. A declared paid account overrides the two free ids. |
| Mistral | `/v1/models` plus isolated [API pricing](https://mistral.ai/pricing/api), re-read 2026-10-07. Priced rows stay metered `PAID`. "Mistral Moderation 2" is shown as Free and has no API id on that page, so no id was marked free. Voxtral TTS output is priced. Studio / Le Chat / web free is not API-free. |
| NVIDIA | [build.nvidia.com/llms.txt](https://build.nvidia.com/llms.txt), re-read 2026-10-07, says every catalog model has a free trial and no credit card. A row returned by that catalogue, with no positive price, is `FREE_QUOTA`. An id that was never listed stays `UNKNOWN`. A positive catalogue price, or a declared paid account, is `PAID`. Localhost stays local. |
| DeepSeek, OpenAI, Anthropic, Perplexity | Current public API pricing is metered. ChatGPT/Claude/consumer Perplexity free access is not API-free. |
| Local engines | `local_runtime` — not sent through the cloud billing firewall. |

Where a vendor has no machine-readable free/pricing API, FRIDAY keeps isolated official knowledge with `checkedAt` + TTL and **fails closed** when that knowledge is stale or missing. It does not scrape unofficial free-model websites and does not invent a pricing endpoint.

`KNOWLEDGE_CHECKED_AT` stays 2026-09-30. A source moves only after its own page is re-read. On 2026-10-13 Groq, Gemini, and Z.ai were re-read. OpenAI, Anthropic, DeepSeek, Perplexity, Mistral, and NVIDIA stay on the 2026-10-07 reading. Sync now lists sources inside a two-day lead. It does not download the pages. OpenAI, Anthropic, DeepSeek, and Perplexity published non-zero API prices on the pages named in `METERED_API_DEFAULT`. Perplexity's separate router rate card was not fetched. Consumer plan pages are not API-free. GitHub Models was retired on 2026-07-30 and is not a provider. Cloudflare Workers AI needs an account id in the URL and has no OpenAI `GET /v1/models` on that chat base, so it is not a provider.

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

After one failed candidate, the same router orders what is left: the same model on another endpoint, then a sibling on that provider, then the same family on another provider, then any other model that already passed privacy and billing. A provider outage tries a different backend before another endpoint on the failed one. A deterministic 400 or 422, a content filter, a region block, and a context overflow do not move to another model. A paid-access or model-access refusal cools that model only, and the cascade may try another model the firewall already allows. A bad key, an offline engine, and a provider outage skip that backend. A context overflow may move only after the caller says the prompt was compacted. Three provider errors quarantine that model; three deterministic 400s do not. A passed recovery probe clears the cooldown.

The routable catalogue swaps only when the next list is an array of unique ids. A broken refresh keeps the previous generation. Multi plans name their aggregation (`parallel`, `staged`, `critic`, `verifier`, `judge`, or `fallback`). A parallel or race plan is the only fan-out. The chat path logs one execution trace and does not send that trace to the owner. The sentence drops hidden reasoning and any secret assignment.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Advance a fallback only when another provider could succeed | ADOPT | A 400 is the request. Timeouts, 429, and 5xx may move. Sources: nRouter fallback chains (nrouter.ai/blog/engineering/provider-fallback-chains); LiteLLM deployment order (docs.litellm.ai/docs/routing). Accessed 2026-10-08. |
| Try another endpoint of the same model before a different model | ADAPT | LiteLLM weighted failover stays inside the group first. FRIDAY's order is endpoint, sibling, family, then any other allowed model, and a provider-wide outage prefers a different backend. |
| Circuit breaker with a recovery probe | ADAPT | Three retryable failures quarantine. A deterministic 400 never does. One probe success clears it. No second router. |
| Learned semantic router | REJECT | Still the 2026-10-05 decision. No second scoring stack. |

### Routing added (2026-10-13)

Free proof, error class, and local loaded-state stay in `electron/model-access.cjs`, `electron/model-router.cjs`, and `kernel/router.py`. No second router was added. A probe that could spend money is not sent. An unknown-cost model stays unknown until the owner declares it. Live keyed calls were not run.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Groq Developer-plan table is not a free plan | ADOPT | [Rate limits](https://console.groq.com/docs/rate-limits) on 2026-10-13 labels that table as Developer plan base limits, and [models](https://console.groq.com/docs/models) prices those ids. [Plans](https://console.groq.com/settings/billing/plans) still names a Free plan, but it does not list free ids. Priced ids stay `PAID` until the owner declares the account free. |
| Treating that table as `freeRows` | REJECT | It would send a priced model as free, then the provider asks for paid access. |
| Gemini Standard "Free of charge" families | ADOPT | [Pricing](https://ai.google.dev/gemini-api/docs/pricing), re-read 2026-10-13. Prefixes absent from that page stay unknown. A paid project still overrides ([billing](https://ai.google.dev/gemini-api/docs/billing)). |
| Z.ai Free rows | ADOPT | [Pricing](https://docs.z.ai/guides/overview/pricing), re-read 2026-10-13. `glm-4.7-flash` and `glm-4.5-flash` only. `glm-4.6v-flash` is not a Free row. |
| OpenRouter Retry-After and `:free` | ADOPT | [Limits](https://openrouter.ai/docs/api_reference/limits) and [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free). Honour Retry-After. `:free` without a zero catalogue price is still not proof. |
| OpenRouter data-policy 404 | ADOPT | [Privacy](https://openrouter.ai/docs/guides/privacy/logging), read 2026-10-18. `No endpoints found matching your data policy` is an account setting, not a missing model and not an offline engine. The fix is [Privacy settings](https://openrouter.ai/settings/privacy). Classification is `electron/model-router.cjs`. A cloud failure never uses the local-engine sentence. |
| Unknown-cost auto use | REJECT without a cap | An unknown model stays out of automatic routing. The owner can set `spendCapUsd` on that model; it is then treated as paid under the billing firewall. Strict privacy (`requirements.strictPrivacy`) drops OpenRouter `:free` models because those endpoints may train on prompts. The default is off. |
| Status-first error class | ADOPT | HTTP status, then the handler code, then a few exact phrases. A cloud failure never says the local engine is not running. Each failed attempt keeps provider, model, path, status, code, a short redacted body, elapsed time, and Retry-After. |
| Per-provider `gate()` | ADOPT | Each handler exposes list URL, chat URL, a zero-spend probe label, and `mayTrain`. OpenRouter is the only cloud handler with `mayTrain` set. A live re-read of every vendor page was not done on 2026-10-18. Earlier rows stay where the page was not opened. |
| Groq `x-ratelimit-remaining-requests` as the daily counter | ADOPT | The same rate-limits page. Zero remaining requests is a daily cap, not a one-minute burst. |
| LM Studio `loaded_instances` | ADOPT | [Native list](https://lmstudio.ai/docs/developer/rest/list) and [v0 state](https://lmstudio.ai/docs/developer/rest/endpoints). [OpenAI list](https://lmstudio.ai/docs/developer/openai-compat/models) can include downloads that are not loaded. Only a loaded row is routed. Auto-load is not called. |
| Ollama down versus a missing tag | ADOPT | A connection failure is "Ollama not running". A 404 model id is removed from the next route. Installed tags stay routable because Ollama can load them. |
| An LLM that chooses the provider | REJECT | The supplied architecture note asked for a master prompt that picks providers. That adds latency, cost, an injection surface, and a non-deterministic route. The router stays ordinary code. |
| Mistral Experiment, Cohere trial keys, Hugging Face `:cheapest`, NVIDIA, Cerebras, Fireworks, Together, SambaNova, Moonshot, DeepInfra, Nebius | unverified | Those pages were not re-read on 2026-10-20. Their previous rules stay. |

### Re-read (2026-10-20)

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Groq supported models | ADOPT | [Models](https://console.groq.com/docs/models), re-read 2026-10-20. The limits column is still the Developer plan. `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` are Contact Sales. The priced ids already stored still match. The page does not list a free id. Models can mark one Groq model free for this account. |
| Background health probe | ADAPT | `planHealthProbe` still refreshes the catalogue with jitter and spends nothing. `planModelProbes` adds a cached GET per model (`/api/tags` or the models list). Privacy mode skips network probes. A failed probe cools that model before a turn. No prompt is sent. |
| A second router or a new vendor client | REJECT | Official list URLs stay inside the current handlers. No new dependency. |

### Completeness matrix (2026-10-14)

Rows are the handlers in `electron/handlers/`. Columns are discover, classify, connect, select, route, stream, tools, vision, embeddings, audio, errors, quota, health, and the Models screen. D is an automated test on this tree. P is implemented, with the missing proof named. N is not a route for that provider.

| Id | discover | classify | connect | select | route | stream | tools | vision | embed | audio | errors | quota | health | ui |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai, anthropic, groq, mistral, deepseek, nvidia, fireworks, deepinfra, cerebras, sambanova, moonshot, zhipu, huggingface, together, xai, perplexity, nebius, openrouter | D | D | P live key | D | D | P no live stream | P unverified flag | P unverified flag | N | N | D | P header | D breaker | D |
| gemini | D | D | P live key | D | D | D fake 429 and one SSE | P unverified flag | P unverified flag | N | N | D | D Retry-After | D breaker | D |
| cohere | D | D | P live key | D | D | P no live stream | P unverified flag | N | N chat list drops embed | N | D | P header | D breaker | D |
| ollama, lmstudio, llamacpp, vllm, localai, jan, mlx, local | D | N local | P daemon | D | D | D fixture stream | D live else unverified | D live else unverified | N | N | D | N | D fixture down | D |

P live key: `npm run models:check --live` writes `debug/reports/models-check-live.json` with keys removed. The key is that provider's `env` name in `electron/models.cjs` (OpenRouter is `OPENROUTER_API_KEY`), read from the environment and never printed. Each row records key validity, models found, free proof, HTTP status class, error category, and latency. It was not run here. Gemini's fake server returned HTTP 429 and one SSE clause through `testProviderChat`. A successful live stream was not run. P unverified flag: the tool or vision bit stays, and the proof label is unverified, because that provider's model list does not name the field. OpenAI's list returns id, created, object, and owned_by. A tool call can still ride the existing request body. D live else unverified: Ollama's show payload `capabilities` array and `*.context_length`, and LM Studio's `capabilities.vision`, `capabilities.trained_for_tool_use`, and `max_context_length`, are read when the list includes them. A missing field keeps the flag and is labeled unverified. Context uses that token count when it is present. N embed and N audio: embeddings and speech are not a chat route. Memory uses a local hash, not a provider embedding model. Speech stays on the voice ladder. A discovered row whose type is embedding is not selected for chat. P daemon: a local engine is routed only when its probe says it is up. D fixture stream and D fixture down: a local fake server covered Ollama and LM Studio up with a loaded model, up with none, down, a stale id, a stream body, and an error body, then `routeRequest`. A Windows daemon was not started here. The catalog and the online search show 40 rows, then Show more.

2026-10-15 re-audit. Chat and Voice still enter `routeRequest`. No second router was added. Privacy mode still drops ambient text before a cloud send. Heard-log retention is already the Voice settings for minutes and rows, including Off, and Clear on this PC. Wake and turn audio stay bytes on the UI thread. The P cells above stay open: a live key, a live stream, unverified tool and vision flags, and a Windows daemon were not run.

### Routing lanes (2026-10-14)

Chat and Voice call `routeRequest` in `electron/model-router.cjs`. The lane is ordinary code. A provider is one handler file under `electron/handlers/`. No second router, registry, or billing check was added. Launcher offers and the host allowlist are recorded below. The Models screen groups the same tabs under LOCAL AI, CLOUD AI, and ROUTING.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Separate `:free` catalogue entry | ADOPT | [Free variant](https://openrouter.ai/docs/guides/routing/model-variants/free) and [suffixes](https://openrouter.ai/docs/guides/routing/model-variants/overview), read 2026-10-14. Stripping `:free` resolves the paid id. FRIDAY keeps free and paid in different lanes. |
| Ordered model fallback | ADAPT | [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) and [failover](https://openrouter.ai/blog/insights/reliability-failover/), read 2026-10-14. FRIDAY already lists the next model in code. The list is the lane hand-off, and a paid id is not added unless the owner, the firewall, and the budget allow it. |
| Provider load-balance across hosts | REJECT | [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), read 2026-10-14. That is a second router. FRIDAY keeps one handler per provider and one funnel. |
| An LLM that chooses the lane | REJECT | Same reason as 2026-10-13. Latency, cost, injection, and a route that changes between two identical turns. |
| Gemini OpenAI base and Groq list URL | ADOPT | Re-read 2026-10-14. [Gemini OpenAI](https://ai.google.dev/gemini-api/docs/openai) still uses `generativelanguage.googleapis.com/v1beta/openai` and Bearer. Its example id is `gemini-3.8-flash`, which stays unknown until a pricing row proves it free. [Groq models](https://console.groq.com/docs/models) still lists `api.groq.com/openai/v1/models`. [Groq limits](https://console.groq.com/docs/rate-limits) still titles that table as Developer plan. A third-party page that calls the same table a free plan is not proof. |

### Local launcher offers (2026-10-14)

`config/download-hosts.json` is the only remote download host list. `config/local-runners.json` holds the Windows assets read on 2026-10-14. `electron/local-library.cjs` builds the card and the install offer. `electron/download-safety.cjs` is the transfer state machine, and `electron/model-download.cjs` is the only public entry. This process does not start an installer. `canRun` stays false until a published sha256 matches, Windows Authenticode names a publisher, and the owner clicks. A missing digest never offers Run. Check for update reads the official release API, compares the tag with the pin, and can show update available. It does not install. It does not replace a pinned sha256 unless that release publishes one, and this step does not write the pin file either way. The Local AI card shows the pin age in days from `checked`. A live call to the release API was not run here; the tests use fixtures. Quit pauses a job and leaves the `.part` file. The next start marks a `downloading` row `paused`. Real downloads and Authenticode were not run here.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Ollama Windows setup v0.40.4 | ADOPT as a pin | `OllamaSetup.exe`, 1581967176 bytes, sha256 `45fcd47d70dd047ab95736802e71a7497ef1a473a50470471fc2fb0eb90badde`. User scope, no Administrator. [Windows](https://docs.ollama.com/windows) and [v0.40.4](https://github.com/ollama/ollama/releases/tag/v0.40.4). The [library](https://ollama.com/library) has no machine-readable full list. Pull stays the local `POST /api/pull`. Curated tags are llama3.2 and qwen2.5. |
| Third-party silent installer flags | REJECT | The Windows page names `/DIR=` only. A silent switch from another site is not used. |
| LM Studio direct exe | REJECT as a pin | [Download](https://lmstudio.ai/download), [CLI](https://lmstudio.ai/docs/cli), and [install.ps1](https://lmstudio.ai/install.ps1) were read. Those pages did not publish a sha256. The card links the official page. `lms get` stays the documented pull. The API is `http://127.0.0.1:1234`. |
| Jan v0.8.6 | ADOPT as a pin | `Jan_0.8.6_x64-setup.exe`, 556441144 bytes, sha256 `f47f2d205eb92743bdd60ffe7d3b7b434b45a97a8dce092c1185c97d1f5a5268`. [v0.8.6](https://github.com/janhq/jan/releases/tag/v0.8.6) and [jan.ai](https://jan.ai). No catalog API. Models come from Hugging Face or a manual import. |
| GPT4All v3.10.0 | ADAPT | The GitHub asset has no digest, so Run stays off. [Official page](https://www.nomic.ai/gpt4all). Import a GGUF or open that page. |
| KoboldCpp v1.123 | ADOPT as a pin | Portable `koboldcpp.exe`, 642223685 bytes, sha256 `ec20acbad449aaef75e44eac8b585b11cffb681eea7b98b74230f980f30fab38`. [v1.123](https://github.com/LostRuins/koboldcpp/releases/tag/v1.123). No catalog. The API is `http://127.0.0.1:5001`. |
| llama.cpp b11609 CPU zip | ADOPT as the Models card pin | `llama-b11609-bin-win-cpu-x64.zip`, 19518618 bytes, sha256 `8708a7b81842333927f6377ac3f17ff8bba4dbe1ee0cf28dfd5e7a32e3a46b38`. Tag v0.6.0 only published `nightly-tag.txt`. [b11609](https://github.com/ggml-org/llama.cpp/releases/tag/b11609). The older Install Manager pin is unchanged. |
| Hugging Face file metadata | ADOPT | The models API returns `siblings[].lfs.sha256` and `gated`. [Hub API](https://huggingface.co/docs/hub/api). A gated repo stops before any byte. |
| GitHub release digest | ADOPT | `assets[].digest` with a `sha256:` prefix is the checksum when the API sends one. |
| Download source families | ADOPT | [Downloading models](https://huggingface.co/docs/hub/en/models-downloading), read 2026-10-18. File bytes redirect to `us.aws.cdn.hf.co` and other `hf.co` names. A suffix of `huggingface.co` or `hf.co` stays in the Hugging Face family. A hop to another family aborts. The check is `electron/download-safety.cjs`. |
| hf-mirror.com | REJECT as a default | It is a third-party mirror, not a Hugging Face host. It is used only when `FRIDAY_HF_MIRROR=1`. The list is `config/download-hosts.json`. |
| Ollama blob CDN | REJECT as a wildcard | [Ollama download](https://github.com/ollama/ollama/blob/main/server/download.go) redirects blobs off `registry.ollama.ai` onto a Cloudflare host that is not a stable Ollama name. FRIDAY pulls through the local daemon. A direct redirect that leaves the Ollama family aborts. |
| An LLM judge that picks a provider | REJECT | Show-all, first-good, and majority stay in `combineLocalAnswers`. A judged merge runs only after the owner names a model, and that model does not choose a provider. |
| Ollama capabilities and context | ADOPT | [Show model](https://docs.ollama.com/api-reference/show-model-details), read 2026-10-14. `capabilities` and a `*.context_length` key are live metadata. A missing field keeps the old flag and is labeled unverified. |
| LM Studio list capabilities | ADOPT | [List models](https://lmstudio.ai/docs/developer/rest/list), read 2026-10-14. `capabilities.vision`, `capabilities.trained_for_tool_use`, and `max_context_length` are live. Only a loaded row is routed. |
| OpenAI model list as tools, vision, or context | REJECT | [List models](https://developers.openai.com/api/reference/resources/models/methods/list/), read 2026-10-14. The payload is id, created, object, and owned_by. Those three stay unverified flags. |
| Embeddings or speech on this chat funnel | REJECT | `kernel/memory.py` hashes text on this PC. It does not call a provider embedding model. Speech stays on the voice ladder. `baseRouting()` still leaves rerank empty. |
| Check for a newer launcher release | ADOPT | GitHub `releases/latest` is compared with the pin. The card can say update available. Nothing is installed. A sha256 is offered only when `assets[].digest` is present. The pin file is not rewritten. |

### Cloud spend and newest free (2026-10-14)

`preferNewestFree` in `electron/model-router.cjs` orders the free lane. Only a record that `isVerifiedFree` already accepts can move to the front. A failed newest id falls back to the previous verified version, and that failed id stays later in the same list. An unverified pricing-page row does not jump the queue. `recordSpend` adds one charge when the caller passes the time. It rolls the day and the month from that time, and it refuses a model id that looks like a key. The billing firewall is still the spend authority. A new reading of every provider's error page was not done for this step.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Newest verified-free id, then the previous version | ADOPT | The free lane already has proof in `isVerifiedFree`. Version order is a sort on that list, not a second router. |
| An unverified name as the newest free model | REJECT | A newer id without `verification: VERIFIED` stays behind a proven older id. |
| Spend log beside the budget caps | ADOPT | One function updates `spentDayUsd` and `spentMonthUsd` and appends amount, time, and model id. The desktop handler is `models:record-spend`. |
| A second billing check for paid models | REJECT | `budgetDecision` remains the cap. The firewall still has to allow paid before the lane opens. |

### Routing added (2026-10-08, escalation)

The model plan's learned value estimator and a second providers package tree were not added. Bedrock, Foundry, and Vertex stay off the cloud list until the owner connects those accounts. vLLM stays an optional local serve command. The vLLM package is not a dependency. Video demos are not an implementation source, and a video index was not added.

A model refusal, a failed tool call, a schema mismatch, and a low-confidence verification move to the next model that already passed privacy and billing. A content filter still stops. Those answer failures do not open a cooldown or a quarantine. A context overflow still moves only after the caller marks the prompt compacted. `planRefresh` still names startup, the Models page, a background layer list, and a chat turn. The timer that used to call that background plan every ten minutes no longer fetches. A repair that would rotate a key, change privacy, upload weights, enable a paid provider, or replace a pinned model stays with the owner. `models:heal` calls that gate.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Separate fallback classes for context, policy, and other errors | ADAPT | LiteLLM keeps content-policy, context-window, and general fallbacks as different lists (https://docs.litellm.ai/docs/proxy/reliability, accessed 2026-10-08). FRIDAY moves a refusal, a tool failure, a schema miss, and low confidence. A content filter still stops. |
| Refresh by trigger, not on every turn | ADAPT | OpenRouter and provider catalogues change. The persisted catalogue refreshes when it is missing or older than 24 hours, on Refresh now, after a model 404, and after sleep once that age has passed. A light cooldown tick does not call a models endpoint. |
| Owner-only repairs stay manual | ADOPT | Healing a stale endpoint cache is allowed. Rotating a key or turning paid access on is not. |

Evidence TTLs stay 10 minutes for a catalogue record, 30 minutes for pricing, 10 minutes for entitlement, and 30 minutes for a successful probe. The background models-list loop is gone. A light cooldown tick never calls a models endpoint. The persisted catalogue refreshes on startup only when it is missing or older than 24 hours, then on that same interval, on Refresh now, after a model 404, and after sleep when 24 hours have passed. Privacy mode and a local-only route keep the disk copy and mark it stale. API key, endpoint, and route-mode changes still invalidate immediately. Lifecycle kinds (`MODEL_DISCOVERED`, `MODEL_VERIFIED`, `MODEL_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_EXHAUSTED`, `MODEL_RETIRED`, `MODEL_REMOVED`, `PROVIDER_CONNECTED`, `API_KEY_CHANGED`, `ROUTE_CHANGED`) stay on the existing `models:registry-changed` / `models:health-changed` / `models:route-mode` broadcasts.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| One catalogue file per provider, 24 hour refresh | ADOPT | Official list pages change slowly. A 10 minute loop hit every connected provider all day. Disk load comes first. An empty or corrupt response keeps the previous file. |
| Shared protocol adapters | ADOPT | OpenAI-compatible chat, Anthropic Messages, Gemini page tokens, Cohere rerank and embed, Ollama native chat, and LM Studio native routes are written once. Provider modules name the adapter. |
| Gemini native generateContent as the chat path | REJECT | The product chat URL stays `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`. Native pagination is normalised only when that payload shape appears. Re-read 2026-10-21: https://ai.google.dev/api/models |
| OpenRouter provider object inside the firewall | ADAPT | List and routing docs re-read 2026-10-21 (https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties and https://openrouter.ai/docs/guides/routing/provider-selection). A privacy turn can send `data_collection: deny` and `allow_fallbacks: false`. That does not open the paid lane. |
| Groq list fields as a free-tier table | REJECT | The list shape was re-read 2026-10-21 (https://console.groq.com/docs/api-reference). `context_window` is copied when present. The page did not prove a free id. The existing price table stays. |
| Hugging Face router suffixes on demand | ADAPT | Router docs re-read 2026-10-21 (https://huggingface.co/docs/inference-providers/main/en/index). `:cheapest`, `:fastest`, and a provider pin are applied when the caller asks. A bare id stays bare. |
| OpenAI Responses API as the product chat path | REJECT | The models list was re-read 2026-10-21 (https://developers.openai.com/api/reference/resources/models/methods/list/). Chat stays on `/v1/chat/completions`. An id with no access class is not automatic. |
| NVIDIA cloud catalogue from llms.txt | ADOPT | https://build.nvidia.com/llms.txt re-read 2026-10-21. Base `https://integrate.api.nvidia.com/v1`, Bearer, OpenAI-compatible chat, free trial with no credit card. Capabilities stay empty unless the payload has them. A self-hosted NIM container is not this catalogue. |
| Ollama cloud as a silent route | REJECT | https://docs.ollama.com/api/chat re-read 2026-10-21. Local chat stays `POST /api/chat`. The hosted API takes a key and was not added. |
| LM Studio native chat as a second path | REJECT | OpenAI-compatible and native REST docs re-read 2026-10-21 (https://lmstudio.ai/docs/developer/openai-compat and https://lmstudio.ai/docs/developer/rest). Product chat stays `/v1/chat/completions`. Native load routes are recorded only. |
| Cloudflare Workers AI and GitHub Models | REJECT | Not reversed on 2026-10-21. GitHub Models retired 2026-07-30. Cloudflare's chat base has no OpenAI `GET /v1/models` and puts the account id in the URL. |
| DashScope, SiliconFlow, Hyperbolic, Novita, AI21, Reka, Inception, Azure OpenAI, Bedrock, Vertex, Replicate | REJECT this run | Those pages were not re-read on 2026-10-21. No endpoint, price, or free tier was added from memory. |

<!-- docs-engine: generated provider status. Edit scripts/docs-engine.cjs, not this. -->

| Provider | Adapter | Discovery | Metadata normalised | Pricing verified | Entitlement verified | Request/response tested | Live verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | implemented | documented | yes | no | no | mocked | no |
| `anthropic` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `gemini` | implemented | documented | yes | no | no | mocked | no |
| `groq` | implemented | documented | yes | no | no | mocked | no |
| `mistral` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `cohere` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `deepseek` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `nvidia` | implemented | documented | yes | no | no | mocked | no |
| `fireworks` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `deepinfra` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `cerebras` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `sambanova` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `moonshot` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `zhipu` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `huggingface` | implemented | documented | yes | no | no | mocked | no |
| `together` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `xai` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `perplexity` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `nebius` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `openrouter` | implemented | documented | yes | no | no | mocked | no |
| `ollama` | implemented | documented | yes | no | no | mocked | no |
| `lmstudio` | implemented | documented | yes | no | no | mocked | no |
| `llamacpp` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `vllm` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `localai` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `jan` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `mlx` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `local` | implemented | existing-catalogue | yes | no | no | mocked | no |
| `huggingface-local` | download-manager | documented | yes | no | no | mocked | no |
| `cloudflare-workers-ai` | not-added | not-read | no | no | no | not-tested | no |
| `github-models` | not-added | not-read | no | no | no | not-tested | no |
| `dashscope` | not-added | not-read | no | no | no | not-tested | no |
| `siliconflow` | not-added | not-read | no | no | no | not-tested | no |
| `hyperbolic` | not-added | not-read | no | no | no | not-tested | no |
| `novita` | not-added | not-read | no | no | no | not-tested | no |
| `ai21` | not-added | not-read | no | no | no | not-tested | no |
| `reka` | not-added | not-read | no | no | no | not-tested | no |
| `inception` | not-added | not-read | no | no | no | not-tested | no |
| `azure-openai` | not-added | not-read | no | no | no | not-tested | no |
| `amazon-bedrock` | not-added | not-read | no | no | no | not-tested | no |
| `google-vertex` | not-added | not-read | no | no | no | not-tested | no |
| `replicate` | not-added | not-read | no | no | no | not-tested | no |
| `ollama-cloud` | not-added | not-read | no | no | no | not-tested | no |

<!-- docs-engine: end generated provider status -->
