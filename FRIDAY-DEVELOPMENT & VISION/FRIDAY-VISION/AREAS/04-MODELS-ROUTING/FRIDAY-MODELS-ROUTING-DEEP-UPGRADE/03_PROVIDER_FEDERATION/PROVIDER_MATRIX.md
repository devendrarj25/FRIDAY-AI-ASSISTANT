# Provider matrix and adapter strategy

The table below is the **architecture matrix**, not a hardcoded promise that every provider will expose every operation.

| Provider family | Discovery | Native metadata | Inference wire | Local install | Special handling |
|---|---|---|---|---|---|
| OpenAI | Models API | model objects + docs | Responses / compatible client | No | reasoning/tools/multimodal settings are model-specific |
| Anthropic | Models API | model lifecycle | Messages | No | do not serialize as OpenAI by assumption |
| Gemini | Models API | rich model metadata | native Gemini + official compatibility | No | native and compatibility surfaces are distinct |
| Mistral | `/v1/models` | model cards | Mistral/OpenAI-style endpoints | No | OCR/transcription/embeddings are not chat models |
| Cohere | `/v1/models` | endpoints/features/context | Chat + specialized APIs + compatibility | No | Rerank/Embed/Parse/Transcribe are separate task classes |
| xAI | official API docs | model/API surfaces | xAI/OpenAI-style where documented | No | keep native features visible |
| Perplexity | API catalogue/docs | research/search oriented metadata | chat/search | No | research/search should be first-class capability |
| Groq | model catalogue | active/deprecated model metadata | OpenAI-compatible | No | latency/throughput are strong routing signals |
| Together/Fireworks/DeepInfra | model catalogue | hosted open-model metadata | OpenAI-compatible | No | model deployment identity differs from base model identity |
| NVIDIA NIM | NIM catalogue/health | model + health/metrics | OpenAI-compatible | Container/runtime install | health and deployment state are first-class |
| Replicate | Models API | version + OpenAPI schema | predictions | No local install by default | per-version input schema is authoritative |
| OpenRouter | models/provider endpoints | provider endpoint data | unified API | No | model score and endpoint score are separate |
| Hugging Face | Hub + provider metadata | model/provider/task metadata | provider-specific normalized client | Optional local download outside router | provider auto-selection/failover |
| Bedrock | ListFoundationModels / model APIs | modality/lifecycle/regions | Converse/Invoke/Responses/Mantle | No | region, access and inference profile are part of endpoint identity |
| Foundry | deployments API | deployment/model metadata | provider-specific deployment | No | router can choose among deployments |
| Vertex AI | Model Garden/deployments | model + region/deployment metadata | Vertex/Gemini APIs | No | region/project/location constraints |
| Ollama | `/api/tags`, `/api/show` | families/size/quantization/template | native API | Yes | pull/load/unload/show are runtime operations |
| LM Studio | local API | loaded/downloaded model state | native + compatible APIs | Yes | download/load/unload are separate lifecycle operations |
| llama.cpp | local server | runtime/model props | compatible server | Yes | quantization/GGUF/hardware fit matter |
| vLLM | server/model endpoint | model served by runtime | OpenAI-compatible | Yes | model is deployment-specific; scheduler/parallelism matter |
| SGLang | server/model endpoint | runtime state | compatible APIs | Yes | throughput and scheduling are runtime-level signals |
| LocalAI | local catalogue/runtime | backend/model config | compatible + native extensions | Yes | model backend can change capabilities |
| Jan | local server | local model inventory | compatible API | Yes | runtime endpoint may move with user configuration |
| MLX-LM | local runtime | model/runtime info | server/CLI | Yes | Apple Silicon hardware fit is mandatory |

## Adapter priority

When a provider exposes both native and compatible surfaces:

1. use native surface for discovery/metadata/lifecycle when richer;
2. use native inference for features unavailable through compatibility;
3. use official compatibility for generic text/tool calls when it is explicitly supported;
4. never infer compatibility from superficial request-shape similarity.
