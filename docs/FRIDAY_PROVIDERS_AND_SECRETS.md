# FRIDAY — Providers, Models & Secrets

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Current shipping version: 1.1.3.5**

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
| `koboldcpp` | KoboldCpp | `http://127.0.0.1:5001` (OpenAI-compatible `/v1`) | Official release `koboldcpp.exe` (pinned in `config/local-runners.json`) | No. It needs a model file: run `koboldcpp.exe` with a GGUF, or load one from its launcher. |
| `transformers` | Hugging Face runner | `http://127.0.0.1:8083` (`/v1/models`, `/v1/chat/completions`) | Install Manager tool “Hugging Face runner”: its own virtual environment in `<FRIDAY_ROOT>/runtime/Hugging_Face_runner` with PyTorch and `transformers[serving]`. Not in the kernel environment. | Started and stopped by the service layer (`transformers serve --host 127.0.0.1 --port 8083`), offline with `HF_HOME=<FRIDAY_ROOT>/models/huggingface`. A downloaded Hugging Face repo or an imported Safetensors/PyTorch folder is hard-linked into that cache under its repo id (`friday/<name>` for an import) and answers by that id. A turn routed to it starts it first. |
| `gpt4all` | GPT4All | `http://127.0.0.1:4891` (`/v1/models`, `/v1/chat/completions`) | Official installer from its release page | No. GPT4All → Settings → Application → Enable Local API Server. |
| `mlx` | MLX-LM | `http://127.0.0.1:8082` | pip `mlx-lm`, **darwin only** | macOS only, and only with exactly one safetensors folder (`mlx_lm.server --model`). Never listed or started on Windows. |

llama.cpp health is `GET /health`. OpenAI-compatible locals use `GET /v1/models`. Ollama uses native `/api/chat`, `/api/pull`, `/api/show`. Inventory, the Providers detector, Test Provider, and service health all resolve the same configured/environment/default endpoint candidates; none can claim Jan (or another compatible local engine) is offline while routing is using a different configured endpoint.

Hugging Face GGUF downloads write into `<FRIDAY_ROOT>/models` even when Ollama is down, so llama.cpp can auto-start from that file. Registering the same GGUF with Ollama is best-effort afterwards. An `ollama` source still needs the daemon running.

Default `autoStart` when `services.json` is missing: `ollama`, `lmstudio`, `localai`. Boot with no owner file still starts **every** engine whose `engineStatus().canStart` is true (including a one-GGUF llama.cpp).

## 2. Cloud (`CLOUD` in `electron/models.cjs`)

Twenty dispatch ids: `openai` OpenAI, `anthropic` Anthropic, `gemini` Google Gemini, `groq` Groq, `mistral` Mistral, `cohere` Cohere, `deepseek` DeepSeek, `nvidia` NVIDIA NIM, `fireworks` Fireworks AI, `deepinfra` DeepInfra, `cerebras` Cerebras, `sambanova` SambaNova Cloud, `moonshot` Moonshot (Kimi), `zhipu` Z.ai (GLM), `huggingface` Hugging Face Inference, `together` Together AI, `xai` xAI (Grok), `perplexity` Perplexity, `nebius` Nebius Token Factory, `openrouter` OpenRouter.

Chat wire is built in `kernel/router.py` (`PROVIDER_SURFACES`). UI labels: `src/lib/friday/model-catalog.ts`.

Signup links for the twenty cloud ids are on the Models page. OpenAI's free usage tier exists only in an allowed geography and is not a per-model price. Anthropic offers a small new-user credit with paid token prices. Fireworks serverless is prepaid credit. Nebius Token Factory grants a short trial credit and needs a card. DeepInfra needs a card or a prepaid balance. None of those five is treated as an always-free model list.

Not added (vendor verification failed): **GitHub Models** (retired 2026-07-30, `models.github.ai` returns HTTP 410) and **Cloudflare Workers AI** (the account id sits in the chat URL and there is no OpenAI `GET /v1/models` on that base, so it does not fit one chat base plus one key).

## 3. Keys

`electron/credentials.cjs` stores secrets under `<FRIDAY_ROOT>/security/credentials` via Electron `safeStorage`. The renderer never holds a decrypted key. A “connected” badge is written only after a live list/probe succeeds (`electron/models.cjs`). Connected means AUTHENTICATED + MODEL_CATALOGUE_AVAILABLE. It does not mean a free model is LIVE_CHAT_VERIFIED.

## 4. Firewalls

- Billing: `electron/billing-firewall.cjs` is the desktop authority and `kernel/billing.py` applies the same class before a kernel request leaves the machine. A paid or unknown-cost model is never a silent default. Cost policy: `src/lib/friday/brain/cost-policy.ts`. Every local engine id (`ollama`, `llamacpp`, `lmstudio`, `vllm`, `localai`, `jan`, `mlx`) is billingClass `free`. A cloud model is free to dispatch when `electron/model-access.cjs` has official free evidence (`ZERO_COST`, `FREE_QUOTA`, or `FREE_CREDIT`, eligible or rate-limited, from `provider_pricing`, `provider_free_plan`, `provider_model_catalog`, `provider_trial`, `provider_router`, `owner_declared`, `live_probe`, or `local_runtime`) or a verified free probe. Verification may still be `UNVERIFIED`. A stale price (`pricing_stale` or `evidence.stale`) stays unknown. Listing a model is not that evidence. An API key alone is not paid authorisation. The shared cases are `core/fixtures/billing-access-records.json`.
- Privacy: `electron/privacy-firewall.cjs` plus `kernel/privacy.py` — SENSITIVE payloads hard-stop. A financial block is a real card (Luhn), an Aadhaar-shaped group, a PAN, or a passport, SSN, Aadhaar, or PAN word followed by an identifier. The blocked line names that signal and says to remove it or run a local model. Local engine ids are never treated as leaving the machine.

Network: `electron/net-fetch.cjs` (Windows proxy / TLS).

## 5. Free vs paid cloud models

Classification lives in `electron/model-access.cjs` (used by `electron/models.cjs`, `electron/model-router.cjs`, and the billing firewall). There is one catalogue and one router. A name containing “free”, a `:free` suffix, a provider free tier, a free signup, Studio/web/chat access, or a successful `/models` listing is a **signal**, not proof. The canonical access object retains provider/model/endpoint/wire, normalized pricing, entitlement/quota/rate-limit evidence, capability metadata, live chat/stream proof, TTL timestamps, health and failure reason.

Billing modes: `ZERO_COST` (official API price is $0), `FREE_QUOTA` (eligible free-plan/rate-limit quota), `FREE_CREDIT` (trial / promotional / grant credits covering this call), `PAID`, `UNKNOWN`. `creditSource` is `TRIAL` | `PROMOTIONAL` | `GRANT` | `USER_FUNDED` | `UNKNOWN`. Only TRIAL / PROMOTIONAL / GRANT may produce `FREE_CREDIT`. A user-funded or unknown balance is `PAID` or `UNKNOWN`, never free. Eligibility: `ELIGIBLE`, `RATE_LIMITED`, `EXHAUSTED`, `NOT_ELIGIBLE`, `UNKNOWN`. Verification: `VERIFIED` only after the existing chat probe succeeds. Official free evidence is coarse `free` while verification stays `UNVERIFIED` until that probe. `UNKNOWN` is never converted to free by a name or a successful call alone.

Free-only routing is fail-closed: `filterByTier(..., "free")` and `selectEligible` with `free-only` never fall back to paid or unknown models (`NO_FREE_MODEL_AVAILABLE`). HTTP 429 is `RATE_LIMITED` / `FREE_RATE_LIMITED`, never paid. HTTP 402 blocks the call but does not overwrite the model's underlying pricing evidence. Exhausted free credits stay `EXHAUSTED`; they are not silently billed. Live verification is **lazy**: classify from official evidence, filter capability + route mode + owner pool + cost policy, rank candidates, probe only a candidate the request can actually use, cache proof per key/model/tier (~30 minutes), then try the next eligible candidate only when required. A successful call on an unknown-cost model proves chat access, not a free entitlement. Stream and non-stream verification are retained separately. Renderer selection IPC, one-shot kernel writing, desktop chat, and phone fallback consume that routed pool; unpublished live routing, invalid explicit ids, and cooling-down ids fail closed instead of widening to the kernel's independent catalogue. Only `multi` fans out concurrently.

Provider adapters (same `CLOUD` ids):

| Provider | How free is decided |
| --- | --- |
| OpenRouter | Catalogue `pricing` is zero-cost only when prompt, completion, and any request or image price are all zero (`"0"` and `0` both count). A positive request or image price is `PAID`. `openrouter/free` is the dynamic free router (`provider_router`), coarse `free`, still `UNVERIFIED` until a probe. `:free` without a zero price is not proof. A live catalogue uses that fetch time, not another provider's doc date. The selector shows `openrouter/free` and a priced `:free` id in a Free group. Auto tries a ready local model first, then that lane, then other free cloud models. |
| Groq | Source: [models](https://console.groq.com/docs/models). The page still publishes Developer-plan prices. A priced id is `PAID` until the owner declares that account free. An id that is not in the price table, including `llama-3.3-70b-versatile`, stays `UNKNOWN`. A name containing "free" is not proof. Audio, whisper, prompt-guard, and safeguard ids stay out of chat by capability. |
| Gemini | Official [API pricing](https://ai.google.dev/gemini-api/docs/pricing). Families whose Standard input was "Free of charge" are `FREE_QUOTA` and eligible. A paid project, or an owner declaration of paid, overrides that. A missing project tier does not. Prefixes that were not on that page, including `gemini-3.7-flash` and bare `gemini-3.5-flash`, stay unknown. 2.0 and 1.5 were not on that page. Image, Omni, Veo, and Lyria stay unknown. AI Studio/web free usage is not entitlement proof. `models/` is stripped before the match. |
| Hugging Face | A `$0` route is `ZERO_COST`. Monthly included credits are `GRANT` → `FREE_CREDIT` only when the account says so. The free-user `$0.10` monthly credit is not a per-model free price, so a model with no `$0` route stays `UNKNOWN` until the owner declares it. Custom provider keys are that provider's billing. |
| Cohere | [List models](https://docs.cohere.com/reference/list-models) and [rate limits](https://docs.cohere.com/docs/rate-limits). `GET /v1/models` returns `models[].name`, `endpoints`, `is_deprecated`, and `context_length`. Deprecated chat models are dropped. `next_page_token` is not followed yet. Evaluation and trial keys are the limited free signal (1,000 calls a month on that page). Production keys are paid. Prod keys on newer Command variants are limited like trial keys, so that limit is not a $0 price. |
| xAI | Native `/v1/models` fields (`prompt_text_token_price`, `completion_text_token_price`, image token prices) are normalized into `pricing.input` / `pricing.output`. Price > 0 → `PAID`. |
| Cerebras, Fireworks, Together, Nebius, SambaNova, Moonshot, DeepInfra | Account credits only when `creditSource` is trial (`FREE_QUOTA`) or promotional/grant (`FREE_CREDIT`). User-funded balance is `PAID`. `$0` catalogue price → `ZERO_COST`. Cerebras has no permanent free tier: the public page is a $5 credit after a payment method, so models stay `UNKNOWN` without that account evidence. SambaNova's pricing URL returned 404, so it stays on this credit rule. Together prefers current `api.together.ai` and retains `api.together.xyz` only as an alternate-host fallback. |
| Z.ai | [Pricing](https://docs.z.ai/guides/overview/pricing). `glm-4.7-flash`, `glm-4.5-flash`, and `glm-4.6v-flash` are `FREE_QUOTA` (Free on every token column). `glm-4.6v-flashx` stays priced. Other ids stay on the credit rule. A declared paid account overrides the free ids. |
| Mistral | `/v1/models` plus isolated [API pricing](https://mistral.ai/pricing/api). Priced rows stay metered `PAID`. "Mistral Moderation 2" is shown as Free with no API id, so no id is marked free. Voxtral TTS output is priced. Studio / Le Chat / web free is not API-free. |
| NVIDIA | [build.nvidia.com/llms.txt](https://build.nvidia.com/llms.txt) says every catalog model has a free trial and no credit card. A row returned by that catalogue, with no positive price, is `FREE_QUOTA`. An id that was never listed stays `UNKNOWN`. A positive catalogue price, or a declared paid account, is `PAID`. Localhost stays local. |
| DeepSeek, OpenAI, Anthropic, Perplexity | Current public API pricing is metered. Consumer plan free access is not API-free. |
| Local engines | `local_runtime` — not sent through the cloud billing firewall. |

Where a vendor has no machine-readable free/pricing API, FRIDAY keeps isolated official knowledge with `checkedAt`. A source is re-read at start, on the daily tick, after sleep, and on Refresh now. An old copy keeps a model that it proved free as free and flags it `cached <age>`; a model that no source proved free stays unknown (**fails closed on no proof**, not on age). A failed fetch keeps the last good table. The Models page lists each source with its basis, age, and fresh or cached state. Groq publishes no free-model list, so a Groq id stays unknown until the owner marks it free; that mark survives a stale snapshot. It does not scrape unofficial free-model websites and does not invent a pricing endpoint.

`KNOWLEDGE_CHECKED_AT` in `electron/model-access.cjs` is the knowledge date. A source's own date moves only after its page is re-read and matches its marker; a page without a price table (DeepSeek's pricing URL today) keeps its older date and the model stays unknown. A stale snapshot is never sent as a paid bill: the owner sees "pricing info is stale, refresh now" and can mark that model free. Startup and Refresh now re-read due pages when the PC is online and privacy mode is off; a page that does not match its marker leaves the last table. Consumer plan pages (ChatGPT, Claude, consumer Perplexity, Studio, Le Chat) are not API-free.

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

The owner-selected route mode is never translated (`local-only` does not become `auto`; `cloud-only` does not become `manual`). Auto picks the best currently eligible model — it does not hardcode OpenRouter. Eligible means `usableModels()`: connected, and free or paid access on, and not retired. Paid and unknown-cost models enter only when paid access is on. A fallback stays inside that same set. Desktop chat and `kernel:rpc` both send the route mode so `kernel/router.py` can re-enforce local-only / cloud-only / manual, and a private turn, as the last safety boundary. The desktop logs one plan sentence; that log never changes who is selected.

The chat selector renders that same `usableModels()` result. A hidden row is not shown. A cooldown or an exhausted quota stays visible and disabled, with the reason. Each row reads `Provider · Model` plus `FREE`, `PAID`, `LOCAL`, or `cost unknown`. Owner-declared evidence adds the mark `owner declared`. After a turn, the message stores `answeredBy` from the router trace. The conversation strip shows that line once, with the step count and the chart button. The Flow Studio chat chart reads the same stored line. The message text stays the answer.

Failure handling on the same router. After one failed candidate the router orders what is left: the same model on another endpoint, a sibling on that provider, the same family on another provider, then any other model that already passed privacy and billing. A provider outage prefers a different backend. A deterministic 400 or 422, a content filter, a region block, and a context overflow do not move to another model (a context overflow moves only after the caller says the prompt was compacted). A refusal, a failed tool call, a schema mismatch, and low-confidence verification do move on, and they open no cooldown. A paid-access refusal cools that model only. A bad key, an offline engine, and a provider outage skip that backend. Three provider errors quarantine a model, three deterministic 400s do not, and a passed recovery probe clears it. The routable catalogue swaps only when the next list is an array of unique ids; a broken refresh keeps the previous generation. Multi plans name their aggregation (`parallel`, `staged`, `critic`, `verifier`, `judge`, `fallback`); only parallel and race fan out. Race and cascade are strategies on this router: a cascade orders cheaper models first, a race keeps the first success, and after three recorded trials success rate, latency, and owner feedback adjust the score without skipping a firewall. The chat path logs one execution trace and never sends it to the owner; the sentence drops hidden reasoning and secrets.

Error class is status first (HTTP status, then handler code, then a few exact phrases). A cloud failure never says the local engine is not running. Each failed attempt keeps provider, model, path, status, code, a short redacted body, elapsed time, and Retry-After. OpenRouter's `No endpoints found matching your data policy` is an account privacy setting, not a missing model. Ollama down ("Ollama not running") differs from a 404 tag (that id leaves the next route). Groq's zero `x-ratelimit-remaining-requests` is a daily cap, not a burst. Each handler exposes list URL, chat URL, a zero-spend probe label, and `mayTrain` (only OpenRouter `:free` sets it; strict privacy drops those models).

Catalogue and evidence refresh. One catalogue file per provider refreshes on startup only when missing or older than 24 hours, then on that interval, on Refresh now, after a model 404, and after sleep once 24 hours have passed. `planHealthProbe` refreshes the catalogue with jitter and spends nothing; `planModelProbes` adds a cached GET per model, skipped in privacy mode, and a failed probe cools that model before a turn. A light cooldown tick never calls a models endpoint. Privacy mode and a local-only route keep the disk copy and mark it stale. API key, endpoint, and route-mode changes invalidate immediately. TTLs: 10 minutes for a catalogue record, 30 minutes for pricing, 10 minutes for entitlement, 30 minutes for a successful probe. Lifecycle kinds (`MODEL_DISCOVERED`, `MODEL_VERIFIED`, `MODEL_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_EXHAUSTED`, `MODEL_RETIRED`, `MODEL_REMOVED`, `PROVIDER_CONNECTED`, `API_KEY_CHANGED`, `ROUTE_CHANGED`) ride the existing `models:registry-changed`, `models:health-changed`, and `models:route-mode` broadcasts. Repairs that would rotate a key, change privacy, upload weights, enable a paid provider, or replace a pinned model stay with the owner (`models:heal` calls that gate).

Free lane and spend. `preferNewestFree` in `electron/model-router.cjs` orders the free lane: only a record `isVerifiedFree` accepts can move to the front, and a failed newest id falls back to the previous verified version. An unknown-cost model stays out of automatic routing; the owner can set `spendCapUsd` on it, and it is then treated as paid under the billing firewall. `recordSpend` adds one charge with the caller's time, rolls the day and month, and refuses a model id that looks like a key (`models:record-spend`). `budgetDecision` remains the cap. The kernel accepts official free evidence from the same source list as the desktop; stale, paid, exhausted, and unknown stay blocked. LM Studio rows that are not loaded stay on the Models page as `model not loaded in LM Studio` and are not routed; ids the OpenAI-compatible list serves (including JIT downloads) are routed, and a later "Please load a model" reply marks the id.

Models page card structure: the catalog and the online search show 40 rows, then Show more. Models groups LOCAL AI, CLOUD AI, and ROUTING.

## 7. Local launcher offers

`config/download-hosts.json` is the only remote download host list. `config/local-runners.json` holds the Windows asset pins. `electron/local-library.cjs` builds the card and the install offer. `electron/download-safety.cjs` is the transfer state machine and `electron/model-download.cjs` is the only public entry. FRIDAY does not start an installer by itself: `canRun` stays false until a published sha256 matches, Windows Authenticode names a publisher, and the owner clicks. A missing digest never offers Run. Check for update reads the official release API (`assets[].digest` with a `sha256:` prefix is the checksum when sent), compares the tag with the pin, can show update available, installs nothing, and does not rewrite the pin file. The card shows the pin age in days. Quit pauses a job and leaves the `.part` file; the next start marks a `downloading` row `paused`. A gated Hugging Face repo stops before any byte (`siblings[].lfs.sha256`, `gated`). File bytes may redirect only inside the same host family (`huggingface.co` / `hf.co`, Ollama); a hop to another family aborts. `hf-mirror.com` is used only with `FRIDAY_HF_MIRROR=1`.

| Launcher | Pin | Notes |
| --- | --- | --- |
| Ollama v0.40.4 | `OllamaSetup.exe`, 1581967176 bytes, sha256 `45fcd47d70dd047ab95736802e71a7497ef1a473a50470471fc2fb0eb90badde` | User scope, no Administrator. Pull stays the local `POST /api/pull`. Curated tags: llama3.2, qwen2.5. |
| Jan v0.8.6 | `Jan_0.8.6_x64-setup.exe`, 556441144 bytes, sha256 `f47f2d205eb92743bdd60ffe7d3b7b434b45a97a8dce092c1185c97d1f5a5268` | No catalog API; models come from Hugging Face or manual import. |
| KoboldCpp v1.123 | `koboldcpp.exe`, 642223685 bytes, sha256 `ec20acbad449aaef75e44eac8b585b11cffb681eea7b98b74230f980f30fab38` | API `http://127.0.0.1:5001`. |
| llama.cpp b11609 | `llama-b11609-bin-win-cpu-x64.zip`, 19518618 bytes, sha256 `8708a7b81842333927f6377ac3f17ff8bba4dbe1ee0cf28dfd5e7a32e3a46b38` | The Models card pin; the Install Manager pin is separate. |
| LM Studio | no pin | The vendor pages publish no sha256. The card links the official page; `lms get` is the pull; API `http://127.0.0.1:1234`. |
| GPT4All v3.10.0 | no pin | The GitHub asset has no digest, so Run stays off. Import a GGUF or open the official page. |

## 8. Completeness matrix

Rows are the handlers in `electron/handlers/`. D is an automated test on this tree. P is implemented, with the missing proof named. N is not a route for that provider.

| Id | discover | classify | connect | select | route | stream | tools | vision | embed | audio | errors | quota | health | ui |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai, anthropic, groq, mistral, deepseek, nvidia, fireworks, deepinfra, cerebras, sambanova, moonshot, zhipu, huggingface, together, xai, perplexity, nebius, openrouter | D | D | P live key | D | D | P no live stream | P unverified flag | P unverified flag | N | N | D | P header | D breaker | D |
| gemini | D | D | P live key | D | D | D fake 429 and one SSE | P unverified flag | P unverified flag | N | N | D | D Retry-After | D breaker | D |
| cohere | D | D | P live key | D | D | P no live stream | P unverified flag | N | N chat list drops embed | N | D | P header | D breaker | D |
| ollama, lmstudio, llamacpp, vllm, localai, jan, mlx, local | D | N local | P daemon | D | D | D fixture stream | D live else unverified | D live else unverified | N | N | D | N | D fixture down | D |

- **P live key:** `npm run models:check --live` writes `debug/reports/models-check-live.json` with keys removed. The key is that provider's `env` name in `electron/models.cjs`, read from the environment and never printed. Each row records key validity, models found, free proof, HTTP status class, error category, and latency. Not run without a key.
- **P no live stream:** Gemini's fake server returns HTTP 429 and one SSE clause through `testProviderChat`; a successful live stream is unverified.
- **P unverified flag:** the tool or vision bit stays and the proof label is unverified, because that provider's model list does not name the field (OpenAI's list returns id, created, object, owned_by). Ollama's show `capabilities` and `*.context_length`, and LM Studio's `capabilities.vision`, `capabilities.trained_for_tool_use`, and `max_context_length`, are read when present.
- **N embed, N audio:** embeddings and speech are not a chat route. Memory uses a local hash (`kernel/memory.py`), and speech stays on the voice ladder.
- **P daemon, D fixture stream, D fixture down:** a local engine is routed only when its probe says it is up. Fixtures cover Ollama and LM Studio up with a loaded model, up with none, down, a stale id, a stream body, and an error body. A Windows daemon is unverified here.

## 9. Research decisions

One deduplicated record. ADOPT means built as described, ADAPT means built in a reduced form on the existing path, REJECT means deliberately not built. Pages named here are the official sources read when each rule was set; rules that depend on a pricing page carry that page's own date in `electron/model-access.cjs`.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Rules first, then cost and quality; fallback kept inside the same constraints | ADOPT | Hard filters run first, quality targets only change the score. Sources: [MLflow routing](https://mlflow.org/articles/llm-routing/), [TrueFoundry routing](https://truefoundry.com/blog/llm-routing). |
| Classify the error before any retry; advance only when another provider could succeed | ADOPT | 400/422 never retry or cool down; timeouts, 429, and 5xx may. Sources: [nRouter fallback chains](https://nrouter.ai/blog/engineering/provider-fallback-chains), [LiteLLM routing](https://docs.litellm.ai/docs/routing). |
| Separate fallback classes for context, policy, and other errors | ADAPT | [LiteLLM reliability](https://docs.litellm.ai/docs/proxy/reliability). Refusals and tool or schema failures move on; a content filter stops. |
| Same model on another endpoint before a different model; circuit breaker with recovery probe | ADAPT | Endpoint, sibling, family, then any allowed model; three retryable failures quarantine, one probe clears. No second router. |
| Retry-After on 429 | ADOPT | Cooldown uses the provider's value (capped at one hour). [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits). |
| Quality modifiers on the existing score; multi-model roles on one shortlist | ADAPT | Optional `qualityTarget` and `strategy` on the one contract; execution stays in the existing parallel chat path. |
| Name heuristics as evidence | ADOPT as last resort | Vision and tools known only from a name guess are rejected unless a registry record or declared capability exists. |
| Learned or semantic routers; an LLM that picks the provider or lane; a silent quality or privacy downgrade | REJECT | Latency, cost, injection surface, and a route that changes between identical turns. Routing stays ordinary code behind both firewalls ([vLLM Semantic Router](https://arxiv.org/abs/2603.04444) stays out). |
| Groq Developer-plan table as free ids | REJECT | [Models](https://console.groq.com/docs/models) and [rate limits](https://console.groq.com/docs/rate-limits) price those ids. Priced ids stay `PAID`; the owner can declare the account free. |
| Gemini Standard "Free of charge" families; Z.ai Free rows | ADOPT | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [Z.ai pricing](https://docs.z.ai/guides/overview/pricing) name them. Prefixes absent from the page stay unknown; a paid project overrides ([billing](https://ai.google.dev/gemini-api/docs/billing)). |
| OpenRouter zero-price rule, `openrouter/free`, `:free` rows | ADOPT | [List models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [Free Models Router](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground), [free variant](https://openrouter.ai/docs/guides/routing/model-variants/free). Every present price field must be zero; the suffix alone is not proof; FRIDAY adds no paid fallbacks. |
| OpenRouter provider object in the firewall | ADAPT | [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection). A privacy turn may send `data_collection: deny` and `allow_fallbacks: false`; host load-balancing is not built. [Privacy](https://openrouter.ai/docs/guides/privacy/logging) explains the data-policy 404. |
| Ordered model fallback lists | ADAPT | [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks). The next model comes from the existing code; a paid id joins only when owner, firewall, and budget allow. |
| NVIDIA catalogue from llms.txt | ADOPT | [build.nvidia.com/llms.txt](https://build.nvidia.com/llms.txt): free trial, no card; base `https://integrate.api.nvidia.com/v1`. Unlisted ids stay unknown. |
| Cohere trial keys and list shape | ADOPT | [List models](https://docs.cohere.com/reference/list-models), [rate limits](https://docs.cohere.com/docs/rate-limits). Deprecated models dropped; `next_page_token` not followed. |
| LM Studio loaded state and capabilities | ADOPT | [List](https://lmstudio.ai/docs/developer/rest/list), [OpenAI list](https://lmstudio.ai/docs/developer/openai-compat/models). Only loaded rows route; native chat stays unused (product chat is `/v1/chat/completions`). |
| Ollama show metadata | ADOPT | [Show model](https://docs.ollama.com/api-reference/show-model-details). Live capabilities and context; missing fields stay unverified. Ollama cloud is not a silent route. |
| OpenAI list as proof of tools, vision, or context; Responses API as chat path | REJECT | [List models](https://developers.openai.com/api/reference/resources/models/methods/list/) carries no such fields; chat stays on `/v1/chat/completions`. |
| Gemini native generateContent as chat path | REJECT | Chat stays on the `v1beta/openai` base; native pagination is normalised only when that shape appears ([models API](https://ai.google.dev/api/models)). |
| Hugging Face router suffixes | ADAPT | [Inference Providers](https://huggingface.co/docs/inference-providers/main/en/index). `:cheapest`, `:fastest`, or a provider pin only when asked; a bare id stays bare. |
| Embeddings or speech on the chat funnel | REJECT | Memory hashes locally and speech stays on the voice ladder; `baseRouting()` leaves rerank empty. |
| Unknown-cost model in automatic routing | REJECT without a cap | Stays out until the owner sets `spendCapUsd` or declares it. |
| Stale snapshot as a paid error; hand-editing a date without a page | REJECT | Fail closed stays; a marker miss leaves the last table. |
| Third-party silent installer flags; LM Studio direct exe pin; Ollama blob CDN wildcard | REJECT | Only documented flags, published digests, and same-family hosts are used. [Ollama Windows](https://docs.ollama.com/windows), [LM Studio download](https://lmstudio.ai/download). |
| Launcher pins and download sources | ADOPT | [Ollama v0.40.4](https://github.com/ollama/ollama/releases/tag/v0.40.4), [Jan v0.8.6](https://github.com/janhq/jan/releases/tag/v0.8.6), [KoboldCpp v1.123](https://github.com/LostRuins/koboldcpp/releases/tag/v1.123), [llama.cpp b11609](https://github.com/ggml-org/llama.cpp/releases/tag/b11609), [Hub downloads](https://huggingface.co/docs/hub/en/models-downloading), [Hub API](https://huggingface.co/docs/hub/api). |
| KoboldCpp and GPT4All as local chat engines (2026-10-24) | ADOPT | [KoboldCpp wiki](https://github.com/LostRuins/koboldcpp/wiki) documents port 5001 and the OpenAI-compatible chat API; the GPT4All API server docs (mirrored with the [GPT4All repository](https://github.com/nomic-ai/gpt4all)) document port 4891 with `/v1/models` and `/v1/chat/completions`. Both are free and private like every local engine. |
| A model or provider named in the prompt (2026-10-24) | ADOPT | "use gpt-4o-mini", "gemini se pucho" or "ask claude" pins that turn through `promptRouting()` in `src/lib/friday/brain-engine.ts` (parser `src/lib/friday/brain/model-request.ts`). A bare mention is not a request. Both firewalls still decide in the main router. |
| Live model status and usage ledger (2026-10-24) | ADOPT | `models:live-status` joins the router's own health (cooldown, quarantine, failures, last error, next step) with a per-model count of requests and tokens kept in `electron/model-usage.cjs`. Provider usage fields do not reach the kernel bridge, so tokens are an estimate (text length / 4) and every figure says so; no prompt text is stored. |
| Naming a provider opens its unproven-cost models (2026-10-24) | ADAPT | "use Groq" is the owner's own choice of that provider, so with paid access on its unknown-cost chat models join the paid lane; with paid access off the answer says why. Automatic routing still never picks an unknown-cost model without a spend cap, and the billing firewall decides every request. |
| Non-chat models named before cost (2026-10-24) | ADOPT | An embedding or speech model reads "embedding-only" or "speech-only" instead of "cost unknown", and is not counted in "turn on paid access to see N more". |
| Gemini, Groq, OpenRouter, NVIDIA live check (2026-10-24) | UNVERIFIED | This sandbox has no keys, resolves none of the vendors' documentation hosts and reaches only the Gemini host (a bad key answers `HTTP 400 Please pass a valid API key` on `/v1beta/openai/models`, as the contract expects). Contracts are tested on a fake network in `core/__tests__/four-providers-e2e.test.ts`; a live key and a live stream stay unverified. |
| Providers listed without a connector (2026-10-24) | ADAPT | The catalog still names Azure OpenAI, Bedrock, Vertex, "OpenAI-compatible" and "Custom"; none has a dispatcher in `electron/models.cjs`, so the Models page marks them "no connector yet" and refuses Connect and Test (`UNSUPPORTED_CLOUD`; a test fails if a provider is neither dispatchable nor in that set). A generic endpoint provider is the next step, not built. |
| Newest verified-free id first; spend log beside budget caps | ADOPT | Version order is a sort on the verified list. An unverified newer id stays behind a proven older one; `budgetDecision` stays the cap. |
| `transformers serve` as the Hugging Face local runner | ADOPT | See the research record under section 8. Offline, loopback only, own virtual environment, models linked into the hub-cache layout. |
| Hugging Face account token on downloads | ADOPT | The stored `huggingface` key is sent to huggingface.co and hf.co only, for one download, so gated and private repositories open. It is never logged. |
| Cloud image generation (OpenAI, Together AI, xAI, Gemini, DeepInfra, Hugging Face `hf-inference`) | ADAPT | `electron/image-generation.cjs`. Every request passes the privacy gate and the billing gate first; only models whose capabilities say they draw are asked, free before paid; the answer must really be an image before it is kept in `<FRIDAY_ROOT>/assets/images`. Other providers' image routes are not built. |
| Model kinds from provider modalities | ADOPT | `architecture.input_modalities` and `output_modalities` (OpenRouter and the Hugging Face router), Hugging Face `pipeline_tag`, then curated names. A model that only outputs images, speech or video is never sent a chat turn. |
| DashScope, SiliconFlow, Hyperbolic, Novita, AI21, Reka, Inception, Azure OpenAI, Bedrock, Vertex, Replicate, Cloudflare Workers AI, GitHub Models | REJECT | No endpoint, price, or free tier was added without a read official page. Bedrock, Foundry, and Vertex stay off until the owner connects those accounts. |

Research record, 2026-10-24: `transformers serve` ([serving guide](https://github.com/huggingface/transformers/blob/main/docs/source/en/serve-cli/serving.md), options read from [`serve.py`](https://github.com/huggingface/transformers/blob/main/src/transformers/cli/serve.py): `--host`, `--port` default 8000, `--model-timeout` default 300, `--device`, `--dtype`, `--quantization`) is ADOPTED as the Safetensors/PyTorch runner. vLLM keeps port 8000, so the runner uses 8083. The Hugging Face router (`https://router.huggingface.co/v1`, [Inference Providers](https://github.com/huggingface/hub-docs/blob/main/docs/inference-providers/index.md)) serves chat on the OpenAI-compatible endpoint; other tasks use the provider-specific routes, of which only text-to-image on `hf-inference` is built. The CUDA wheel index in `electron/hf-runner.cjs` is pinned and was not fetched from here (huggingface.co and pytorch.org are not reachable from the build sandbox), so a PyTorch install on the owner's PC is unverified.

## 10. Provider status

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
| `koboldcpp` | implemented | documented | yes | no | no | mocked | no |
| `transformers` | implemented | documented | yes | no | no | mocked | no |
| `gpt4all` | implemented | documented | yes | no | no | mocked | no |
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
