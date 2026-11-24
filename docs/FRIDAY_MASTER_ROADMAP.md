# FRIDAY — Master Architecture, Capability Map and Roadmap

Date of research: 2026-11-23 (updated the same day with the owner's PC: 16 GB RAM, 1 TB SSD, RTX 2060). Owner: `devendrarj25`. Status: reference document for development. It is a plan and a research record, not a record of work done; each build phase re-checks the web first.

**Hardware rule (owner, 2026-11-23): the RTX 2060 / 16 GB PC is the default reference tier for development, never a lock. FRIDAY detects the PC it runs on and chooses, downloads and installs models by what that PC can run, and offers bigger models by itself when the owner gets a bigger PC (section 7A to 7C).**

How to read the labels: **VERIFIED** = read on a page in this research round (link given). **CLAIM** = a blog or vendor statement, not checked on the primary page. **UNVERIFIED** = from memory or not found; must be checked on the official model card or repository before anything is built on it. FRIDAY facts come from `FRIDAY_STATE.md`, `config/kernel.yaml` and the file tree as they stand.

---

## 0. How every future session must use this file

1. Read `AGENTS.md` first (rules win over this file).
2. Read `FRIDAY_STATE.md` (live facts, Deliberate design decisions).
3. Read this file (target architecture, capability map, roadmap). When this file and AGENTS.md disagree, AGENTS.md wins; when this file and the code disagree about *today*, the code and `FRIDAY_STATE.md` win.
4. Pick the roadmap phase (section 9), do a fresh web check for the items it names (this file is dated), build in the existing owner files, add tests and docs in the same change.
5. Never copy a model, runtime or tool in because it is popular. Every external piece enters through the Capability Contract (section 4) and the manifest rules (section 6), with licence, hardware and Hindi/Hinglish checked on the official page.

Repo placement (to be done when the owner starts the next work, not now): register as `docs/FRIDAY_MASTER_ROADMAP.md` through `scripts/docs-engine.cjs` (registry), run `npm run docs:sync` then `npm run docs:check`, and add one line to the AGENTS.md read-order table only if the owner asks for that change.

---

## 1. Vision in plain words

FRIDAY is the owner's own private assistant. The target is **one Brain that behaves like a multi-purpose model**: it listens, understands, thinks, researches, writes code, controls the PC and websites, sees images and video, makes images, video and audio, and speaks, in **Hindi, English and Hinglish**. It does this through **FRIDAY-owned orchestration and interfaces** plus **replaceable capability engines**. Over time FRIDAY's own tuned adapters and small models take over more of the work, so outside services are needed less and less. Outside open models and tools stay installed as **fallback and backup**.

Principles (each is already a rule in `AGENTS.md` or a design decision; they are restated because every later section depends on them):

- **Own the interfaces, rent the models.** No model or vendor is load-bearing. Swap one without touching callers.
- **Local first, cloud only when allowed.** The privacy firewall keeps SENSITIVE off any cloud model; the billing firewall hides paid and unknown-cost models until paid access is on.
- **One of each.** One Brain, one router (`kernel/router.py` after the firewalls), one model manager, one voice conductor. No parallel systems.
- **Measure, then claim.** Linux numbers are leads. Anything not run on the owner's Windows PC is "unverified".
- **Autonomy is a dial the owner holds** (Ask every time, Balanced, Full). Stop everything always works. Work is auditable and undoable.
- **Honest about hardware.** The reference PC is 16 GB RAM, CPU-first, GPU optional and never assumed. Some things (video generation, 30B coding models) do not fit there; the plan says so and gives a path (optional cloud lane, or a stronger PC later).

---

## 2. What FRIDAY already has (from `FRIDAY_STATE.md` and the tree)

| Area | Present today |
| --- | --- |
| Shell | Electron + React renderer, preload allowlist, Python FastAPI kernel on `127.0.0.1:8765`, per-launch token |
| Capability trees | 243 skills (+9 builtin), 178 tools, 122 agents, 107 plugins, 117 workflows, 76 modules, 113 connectors, 79 kernel tools (risk table) |
| Models | 20 cloud providers (`electron/models.cjs`), local engines Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan (MLX-LM on macOS); model catalogue store; routing in `electron/model-router.cjs` then `kernel/router.py`; Install Manager with pins and SHA-256 |
| Roles in `config/kernel.yaml` | brain, coder, researcher, fast, embed (`bge-m3`); memory backend Chroma or FAISS |
| Brain | Answer ledger (Wilson, ECE, Brier, hard gate), gate trace, learned-card correction, draft mode, run ownership, long-chat transcript kept locally |
| Safety | Execution never auto-approved by default, undo journal, kill switch, audit log, prompt-injection isolation, secrets in Electron `safeStorage`, privacy tiers, protected policy files |
| PC control | UIA tree (`kernel/uia_tree.py`, `uia_windows.py`), app control, devices (Android, Bluetooth, network), folder watch, sandbox runner, office/PDF/doc tools, media tools |
| Learning | `kernel/finetune_lora.py` exists (LoRA path), eval corpus and scorers, held-out voice eval tooling (2026-11-23) |
| Voice | Streaming-capable STT orchestration (faster-whisper, Hindi ear, optional whisper.cpp), TTS ladder (Supertonic, light Hindi, system voice), VAD, smart-turn, echo reference, barge-in, task desk, instant ack, language packs, safe model store, 16 GB profile, diagnostics, privacy controls |
| Protocols | MCP server and client (`electron/mcp-protocol.cjs`), off until the owner turns it on |
| Hindi/Hinglish | Script policy, Speech Prep (Devanagari for Hindi voice), Tidy, ASR bias, language segmenter |

**Honest gaps (not built):** image generation and image understanding as first-class capabilities (some image commands exist, check `src/lib/friday/image-command.ts`); video generation and understanding; music/sound generation; a Capability Registry that treats *every* modality the same way; a general self-improvement loop that trains and evaluates FRIDAY's own adapters on the owner's consented data; unified hardware-aware scheduler for several heavy models; Windows-verified numbers for almost everything.

---

## 3. Target architecture (one picture in words)

```
Owner (voice, text, screen, files, devices)
        │
   Renderer (Chat, Voice/Auto, Flow Studio, Settings, Models, Doctor)
        │  preload allowlist · IPC budget table
   Electron main  ── lifecycle · credentials (safeStorage) · updates · windows
        │  loopback + per-launch token
   Kernel (FastAPI)
        ├─ BRAIN: intent → plan → act → verify → report
        │     memory (retrieval-first) · answer ledger · skills · tools · agents · flows
        ├─ ROUTER (single): privacy firewall → billing firewall → capability + hardware fit → engine
        ├─ CAPABILITY REGISTRY (new, unified): one contract per capability, many engines each
        ├─ MODEL MANAGER (extend Install Manager): manifest · install · verify · lazy load · unload · repair
        ├─ RUNTIMES: llama.cpp · ONNX Runtime (CPU, DirectML/vendor EPs) · OpenVINO · Ollama/LM Studio (optional) · cloud adapters
        ├─ SELF-GROWTH: data (consented) → eval gate → LoRA/adapters → version → canary → rollback
        └─ GOVERNANCE: autonomy dial · risk table · approvals · undo journal · audit · kill switch
```

### 3.1 The Brain as a "multi-model in one"

The Brain does not become one giant network. It becomes **a conductor with a fixed set of skills that call capability engines**. To the owner it feels like one model that can see, hear, speak, draw, code and act.

Flow for any request:

1. **Understand**: language detection (Hindi, English, Hinglish, script ratio plus Roman-Hindi lexicon), intent, sensitivity, cost tier, needed capabilities (text, vision, audio, code, image, video, PC action, web).
2. **Plan**: split into steps; mark which steps can run in parallel and which need approval.
3. **Route each step** through the one router: privacy → billing → *capability + hardware fit* → engine. Local engine first when it can do the job; cloud only if both firewalls allow and local cannot.
4. **Act with tools** (kernel risk table; sandbox; UIA first, vision only as fallback for PC control; accessibility snapshots first for the web).
5. **Verify** (tests, screenshots compared, tool results re-read, answer ledger gate).
6. **Report** in the owner's language, short. Record outcome for learning (only what the owner allowed).

### 3.2 Cascade and speculation (speed)

- Small fast model answers first or drafts; the larger model verifies or takes over only when the ledger or the task says so. The ledger already measures calibrated confidence; extend its hard gate to the cascade.
- Prefix caching: keep system prompt and tool definitions byte-stable so the KV cache hits; this is the largest time-to-first-token lever in the sources found ([speculative decoding and prefix cache notes](https://dev.to/ianlpaterson/three-months-of-speed-up-experiments-on-a-3090-ti-autoregressive-dflash-mtp-for-qwen36-27b-59ef), CLAIM, single user's benchmarks).
- Speculative decoding only with a same-family draft; below about 50% acceptance it can slow things down ([guide](https://dev.to/rosgluk/speculative-decoding-20-50-faster-llm-inference-g11), CLAIM). Router/cascade patterns were not found in sources: this part is FRIDAY's own design, to be measured.

### 3.3 Capability Registry (the new unifying piece)

One schema for every capability. A capability has one **contract**; engines register against it.

Capabilities (each has its own contract file, tests and Doctor row):

`llm.chat`, `llm.reason`, `llm.code`, `llm.agent_tools`, `embed.text`, `rerank.text`, `vlm.image_understand`, `vlm.video_understand`, `audio.stt`, `audio.vad_turn`, `audio.enhance`, `audio.tts`, `audio.music_sfx`, `image.generate`, `image.edit`, `video.generate`, `ui.computer_use`, `web.browse`, `search.web`, `pc.hardware`, `pc.manage`, `site.manage`.

Each engine entry (extends the existing voice manifest fields) carries: `id`, `version`, `source` and official URL, files with SHA-256, **code licence and weight licence separately**, languages (Hindi / English / Hinglish quality as measured), min and recommended RAM, min VRAM, disk, CPU/GPU/NPU support, quantization, streaming, latency (measured on the owner's PC, else "estimated"), runtime, priority in the fallback chain, install state, verify state, privacy class (local / cloud), cost class (free / paid / unknown), forbidden-dependency check (torch/vLLM etc. rules for the *voice stack* stay as written).

The registry lives in the existing model catalogue and Install Manager; it does not create a second registry. The router asks it "which engine for capability X, language Y, privacy Z, budget B, hardware H" and gets an ordered list.

### 3.4 Resource governor

A single scheduler enforces: one heavy model resident at a time on 16 GB unless the profile allows two; bounded queues; cancellation tokens; backpressure; idle unload; memory-pressure level (ok, high, critical) from the OS; never loading a size the profile forbids; an optional model failing never takes the app down. The speech worker already does part of this (idle unload, pressure rules, cancel ops); generalise the same pattern to the other engines.

### 3.5 Self-growth loop (how FRIDAY depends less on outside things)

See section 8 for the full design. In short: consented data and corrections → held-out eval set that is never trained on → LoRA/QLoRA adapters on a small open base model → eval gate (must beat the incumbent on the owner's own held-out set) → versioned adapter with rollback → canary use → promote. Cloud answers are never used as training data unless the provider's terms allow it (UNVERIFIED per provider; default off).

---

## 4. Capability-by-capability map

For each: what the owner wants, FRIDAY today, primary engine, fallbacks, cloud lane, hardware and licence, honest verdict. "16 GB CPU" is the reference PC.

### 4.1 Language model: chat, reasoning, Hindi/Hinglish, agents

| Candidate | Facts | Licence | Fit |
| --- | --- | --- | --- |
| Gemma 4 (E2B, E4B, 26B MoE, 31B dense), released 2026-04-02 | Four sizes; images and video on all; native audio input on E2B and E4B; 140+ languages; E2B/E4B for edge, 26B/31B for workstations ([Google](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/), VERIFIED via search result) | Apache 2.0 ([report](https://thenextweb.com/news/google-gemma-4-open-models-apache-2-launch)) | **Primary small multimodal brain on 16 GB CPU: E4B** (Q4 about 3–4 GB, CLAIM). Check Hindi/Hinglish quality on FRIDAY's own eval |
| gpt-oss-20b | 21B total, 3.6B active, Apache 2.0, runs in 16 GB, reasoning with chain of thought ([OpenAI](https://openai.com/index/introducing-gpt-oss/), VERIFIED) | Apache 2.0 | Reasoning option; tight on 16 GB CPU with a full OS; measure. Robustness mixed per one tester |
| Sarvam-30B / 105B (Feb 2026) | Indic-focused, 22 languages, tokenizer efficient for Indic; 30B trained on 16T tokens, 105B MoE with 10.3B active ([Sarvam](https://www.sarvam.ai/blogs/sarvam-30b-105b), [HF 30B](https://huggingface.co/sarvamai/sarvam-30b)) | Apache 2.0 per reports ([OSFY](https://www.opensourceforu.com/2026/03/sarvam-releases-30b-and-105b-llms-under-apache-2-0/)); Sarvam's own page positions 105B inconsistently | Best-looking Hindi-first open LLM family; **too big for 16 GB CPU** at useful speed; GPU PC or cloud lane. Hinglish quality UNVERIFIED |
| Sarvam-M (24B, on Mistral Small) | Open weights, Apache 2.0 listing ([AIKosh](https://aikosh.indiaai.gov.in/home/models/details/sarvamm.html)) | Apache 2.0 | Hindi reasoning on a GPU PC; not CPU |
| Qwen3 family (4B and up) | 4B-class at Q4 fits 16 GB; typical CPU speeds 4–10 tok/s for 4B-class on laptops ([CPU tests](https://itsfoss.com/testing-local-llms-without-gpu), CLAIM) | Apache 2.0 for most Qwen3 sizes (UNVERIFIED per size) | Already the kernel default role (`brain-qwen`); keep as fallback and for tool use |
| Phi-4-mini | About 2.5 GB, about 6.9 tok/s on one Linux CPU test (CLAIM); MIT | MIT | Fast tiny fallback |

Plan:
- **Lite profile (8 GB or weak CPU):** 1–2B class (Gemma 4 E2B or Qwen3-1.7B) for chat; cloud lane for hard tasks if allowed.
- **Balanced (16 GB CPU):** Gemma 4 E4B (or Qwen3-4B) as default, one larger model loaded on demand only for reasoning, never both resident with the speech models.
- **Quality (GPU PC):** Sarvam-30B or gpt-oss-20b / Gemma 4 26B MoE; Qwen3-Coder for code.
- Router rule: Hindi/Hinglish prompts get the Hindi-strong engine first when installed; the ledger's per-engine, per-language calibration decides escalation.
- Always keep two engines per capability installed or installable (primary + fallback), verified by Doctor.

### 4.2 Image understanding (vision)

| Candidate | Facts | Fit |
| --- | --- | --- |
| Gemma 4 E2B/E4B | Native image and video input; Apache 2.0 | **Primary** on 16 GB CPU: the same model as chat, no extra RAM |
| Qwen3-VL 2B/4B/8B (dense) and 30B-A3B MoE | Sizes confirmed by the technical report ([arXiv 2511.21631](https://arxiv.org/abs/2511.21631)); long interleaved context up to 256K | Fallback / quality VLM; **licence not confirmed in sources: UNVERIFIED** |
| Phi-4 Multimodal | MIT, edge-suited ([roundup](https://www.labellerr.com/blog/top-open-source-vision-language-models/), CLAIM) | Tiny fallback |
| SmolVLM2 | Small local VLM ([Roboflow](https://blog.roboflow.com/local-vision-language-models/), CLAIM) | Very low RAM fallback |

FRIDAY today already has OCR (`document_ocr.py`), diagram OCR, camera awareness, screen awareness. Plan: put them all behind `vlm.image_understand` so screen, camera, screenshots and files use one engine chain, with the privacy firewall treating screen content as data, never instructions.

### 4.3 Video understanding

No single local model does this well on 16 GB CPU. Practical design (FRIDAY's own, measure it): sample keyframes at a rate set by the task, run `vlm.image_understand` per keyframe, run `audio.stt` on the track, align by timestamp, summarise with the Brain. Gemma 4 and Qwen3-VL accept video natively but memory needs on CPU are UNVERIFIED. Qwen3-Omni (30B-A3B, Apache 2.0, text/image/audio/video in, speech out, [repo](https://github.com/QwenLM/Qwen3-Omni)) is a GPU-PC or cloud-lane option, not a 16 GB CPU one. Qwen2.5-Omni-3B is **non-commercial** research licence: avoid unless the owner accepts that ([VentureBeat note](https://venturebeat.com/ai/qwen-swings-for-a-double-with-2-5-omni-3b-model-that-runs-on-consumer-pcs-laptops)).

### 4.4 Image generation and editing

| Candidate | Facts | Fit |
| --- | --- | --- |
| FLUX.1 [schnell] | Apache-2.0 per the model card as reported; FP8 about 12–14 GB VRAM ([guide](https://www.digitalapplied.com/blog/local-image-generation-flux-stable-diffusion-comfyui-2026), CLAIM; [licences](https://localaimaster.com/blog/local-image-model-licenses-commercial-use), CLAIM) | **GPU PC primary**. Not usable on 16 GB CPU |
| SDXL | Commercially usable; Open RAIL++-M (use restrictions); about 8–12 GB VRAM | GPU fallback with the widest tooling |
| SD 3.5 | Stability community licence, free under USD 1M revenue | Optional |
| FastSD CPU (OpenVINO) | CPU Windows path for SD/SDXL-Turbo class; **its OpenVINO-converted models are marked research-only** ([repo](https://github.com/rupeshs/fastsdcpu)) | CPU fallback only after the licence of each converted model is read |
| FLUX schnell ONNX/Olive DirectML | Community export for DirectML ([HF](https://huggingface.co/TensorStack/Flux_schnell-f32-onnx)) | GPU on Windows without CUDA; check licence and size |

Plan: `image.generate` capability with three engines (local GPU, local CPU small, cloud lane). On the owner's 16 GB CPU PC the honest default is a **small CPU model for drafts + cloud lane (user-enabled, billing firewall on) for quality**. Every generated image carries provenance metadata locally. Prompt rewriting (Hindi/Hinglish → English prompt) is the Brain's job, not the image model's.

### 4.5 Video generation

| Candidate | Facts | Fit |
| --- | --- | --- |
| Wan 2.2 | Apache 2.0 per most sources; about 24 GB VRAM minimum, 48 GB recommended ([comparison](https://www.aimagicx.com/blog/open-source-ai-video-models-comparison-2026), CLAIM) | GPU workstation or cloud |
| LTX-Video / LTX-2.x | Lowest VRAM floor (about 16 GB, CLAIM); **licence reports conflict** (Apache 2.0 vs revenue-capped community licence) ([sources conflict](https://magichour.ai/blog/ltx-2-3-vs-wan-2-2)) | Read the exact checkpoint licence before use |
| HunyuanVideo 1.5 | Custom Tencent licence, regional exclusions reported (CLAIM) | Avoid by default |

Verdict: **not feasible locally on the 16 GB CPU PC.** Plan: a `video.generate` contract with engines = cloud lane (optional, paid, privacy-checked) and a future GPU profile. The Brain still handles storyboard, script, shot list, voice-over (own TTS), subtitles and assembly locally; only the pixel generation is the outside piece.

### 4.6 Audio: understanding, enhancement, speech, music and effects

- **Speech understanding (STT):** FRIDAY's own chain (Hindi ear, faster-whisper, optional whisper.cpp); Gemma 4 E2B/E4B has native audio input (an optional fallback). Moonshine (MIT) is English streaming only, no Hindi STT ([repo](https://github.com/moonshine-ai/moonshine)). Parakeet v3: no Hindi, NeMo/PyTorch: REJECT ([card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)). IndicConformer-600M is gated, needs transformers/torchaudio: the existing int8 ONNX Hindi ear stays ([card](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual)).
- **Targets to beat or match (cloud references):** ElevenLabs states Scribe v2 Realtime about 150 ms median to a committed transcript and Flash v2.5 about 75–100 ms model/server latency ([latency docs](https://elevenlabs.io/docs/eleven-api/concepts/latency-methodology), [Scribe v2 Realtime](https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents)). Treat as targets for the cloud lane and as the bar for local first-audio and first-word times; FRIDAY's local numbers are still Linux leads.
- **Speech generation (TTS):** Supertonic (OpenRAIL-M, owner must read), light Hindi voice, system voice; Hindi candidates found: IndicF5 (330M flow-matching, 11 Indic languages, **weights restricted: attribution, commercial limits**, [card](https://huggingface.co/AbhishekDelMundu/IndicF5)), Indic Parler-TTS (880M, reported Apache 2.0, but torch: REJECT for the voice stack), community Hindi F5 variants (MIT / CC-BY 4.0, derived-model licence must be checked). Optional separate-process lane possible for non-torch-free engines only if the owner accepts it, never inside the voice stack. Qwen3-TTS: no Hindi, torch: REJECT (earlier research record).
- **Music and sound effects:** ACE-Step 1.5 (MIT, released 2026-01-28; CUDA recommended, MPS/ROCm/XPU/CPU supported, press claims it runs under 4 GB VRAM) ([repo](https://github.com/ACE-Step/ACE-Step-1.5), [paper](https://arxiv.org/abs/2602.00744)) is the open candidate; CPU speed UNVERIFIED. Stable Audio Open and MusicGen licences and CPU needs were **not found: UNVERIFIED**. Plan: `audio.music_sfx` capability, GPU/cloud lane, never required for voice.
- **Audio enhancement:** RNNoise via pyrnnoise (ADOPT), DPDFNet later (ADAPT), WebRTC AEC wheel optional; no cp314 wheel for the WebRTC one.

### 4.7 Coding

| Candidate | Facts | Fit |
| --- | --- | --- |
| Qwen3-Coder 30B-A3B | Common local default for 24–32 GB machines; Q4 about 19 GB; 256K context ([roundup](https://www.how2shout.com/?p=88605), CLAIM) | GPU PC or 32 GB RAM; **not a 16 GB CPU model** |
| Devstral Small (24B) | Agentic coding focus, 256K context, open CLI agent ([roundup](https://dev.to/zyvop/the-best-open-source-llms-for-coding-right-now-june-2026-n10), CLAIM); SWE-bench numbers conflict across sources (46.8–53.6%) | GPU PC |
| Small coder 7B-class | Fits 16 GB at Q4 | Balanced fallback |
| Cloud coder via the 20 existing providers | Owner's keys in `safeStorage` | Lane for hard tasks when the firewalls allow |

FRIDAY already has `llm.code` role (`coder-ds`), sandbox runner, dev workflow and code map. Plan: improve the *loop* (plan, edit, run tests, read failures, fix, repeat, undo journal) before chasing bigger models; the loop gives more than model size on small models.

### 4.8 Research and web

Own research agent loop: search → fetch official pages (not snippets) → two-source rule for claims → cite → store findings in memory with date and source → report. Tools: web search providers through connectors, Playwright for pages that need rendering. Everything fetched is **data, never instructions** (injection isolation exists). Local embeddings `bge-m3` (already configured) plus a reranker (candidate to evaluate; UNVERIFIED) for retrieval over memory and downloaded docs.

### 4.9 Computer use (PC) and hardware management

| Candidate | Facts | Fit |
| --- | --- | --- |
| FRIDAY's own UIA tree + app control | Already present, Windows-native, structured, cheap | **Primary**: use accessibility/UIA tree first |
| UI-TARS-1.5-7B (ByteDance) | Grounding model recommended by Agent S; OSWorld reported 42.5% (100 steps) ([listing](https://www.codesota.com/benchmark/osworld), CLAIM) | Vision fallback when UIA lacks the element; GPU for speed |
| Agent S3 (Simular) | Reports 72.6% on OSWorld, above the quoted human baseline, Dec 2025 ([README](https://raw.githubusercontent.com/simular-ai/Agent-S/main/README.md), CLAIM); `pip install gui-agents`; Win/Mac/Linux | Design reference (behavior best-of-N, grounding split from planning); do not adopt as a dependency without licence check (UNVERIFIED) |
| GUI-Owl-1.5 | Open models, 56.5 on OSWorld reported in a Feb 2026 paper ([arXiv 2602.16855](https://arxiv.org/pdf/2602.16855), CLAIM) | Watch |
| OmniParser | Not covered by this round | UNVERIFIED |

Hardware management (CPU, RAM, disk, temperature, GPU, drivers, power plans, startup items, updates): FRIDAY has probes for memory, GPU (nvidia-smi optional) and devices. Plan: a `pc.hardware` read-only capability first (health, temperatures, disk space, battery, processes) using Windows APIs/WMI and an optional sensor library (library choice UNVERIFIED, to be researched at build time); `pc.manage` actions (kill process, clean temp, change power plan, install update) go through the risk table, approvals and the undo journal. UAC, secure desktop, captcha, payments, credentials and password fields are never touched (existing invariant).

### 4.10 Website management

Playwright MCP (Microsoft, Apache-2.0, accessibility snapshots instead of vision, free, runs locally via npx on Node 18+) is the default web driver ([Playwright MCP](https://www.morphllm.com/playwright-mcp), CLAIM; [comparison](https://dev.to/agdex_ai/ai-native-browser-automation-in-2026-browser-use-stagehand-steel-and-playwright-mcp-compared-160n), CLAIM); browser-use is the Python agent framework on Playwright. Indirect prompt injection is the main risk, so: page text is data; actions on live sites (publish, delete, pay, DNS, deploy) need approval; credentials only from `safeStorage`; every action journaled; a dry-run/preview step for site changes. FRIDAY already has `browser-engine.ts`, `live-browser.ts`, `browser-awareness.ts`; extend, do not duplicate.

### 4.11 Memory and personalization

Today: Chroma or FAISS with `bge-m3`, long transcripts kept locally, learned cards, answer ledger. Memory frameworks compared in 2026: Mem0 (Apache-2.0 core, vector memory, self-hostable), Letta (agent-managed memory blocks), Zep/Graphiti (temporal knowledge graph; one source says Zep stopped maintaining its open core in 2026, CLAIM) ([comparison](https://dev.to/agdex_ai/ai-agent-memory-in-2026-mem0-vs-zep-vs-letta-vs-cognee-a-practical-guide-cfa)). Verdict: **keep FRIDAY's own store** (one memory, local-first, owner-deletable) and ADAPT ideas: temporal facts with valid-from/valid-to, agent-managed core blocks, consolidation during idle, per-fact provenance and confidence, forgetting on request. Local embeddings choice (`bge-m3` now; Qwen3-Embedding evaluated at build time, UNVERIFIED).

### 4.12 Protocols and the agent ecosystem

- **MCP:** spec 2026-07-28 made the protocol stateless (no session handshake; each request carries version and capabilities), moved Tasks to an extension, deprecated Roots, Sampling and Logging (kept at least 12 months), full JSON Schema 2020-12 for tool inputs ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md), [AAIF](https://aaif.io/blog/mcp-2026-changes-the-rules), VERIFIED via search). Plan: migrate `electron/mcp-protocol.cjs` carefully (server off by default, loopback and stdio only stay), keep a compatibility shim for the older version while it exists.
- **A2A (Agent2Agent):** not researched this round: UNVERIFIED. OpenJarvis (Stanford) supports MCP and A2A and exposes an OpenAI-compatible API ([OpenJarvis](https://openjarvis.stanford.edu/)).
- **Skills and AGENTS.md:** FRIDAY already has 243 skills and AGENTS.md; keep skills as data folders with manifests, verified and sandboxed.

### 4.13 Runtimes

| Runtime | Role | Notes |
| --- | --- | --- |
| llama.cpp (GGUF) | Primary local LLM/VLM runtime, CPU and Vulkan/CUDA builds | Windows ML added experimental llama.cpp support in Oct 2026 ([Microsoft](https://devblogs.microsoft.com/foundry-on-windows/build-on-winml-oct-7-26/), VERIFIED via search); built-in draft-MTP speculative decoding reported ([CLAIM](https://github.com/sudoingX/qwen38-mtp)) |
| ONNX Runtime (+ GenAI) | Voice models, embeddings, small LLMs, NPU paths | Native NPU support through execution providers ([Microsoft comparison](https://learn.microsoft.com/windows/ai/windows-ai-comparison)) |
| Windows ML / Foundry Local | Optional Windows-native path with EP management | CPU fallback when no accelerator ([architecture](https://learn.microsoft.com/en-ie/Azure/foundry-local/concepts/foundry-local-architecture)) |
| OpenVINO | Intel CPU/GPU/NPU | Optional per hardware probe |
| DirectML | Reported in sustained engineering; vendor EPs are the replacement ([Microsoft](https://learn.microsoft.com/windows/ai/windows-ai-comparison)); treat as optional, not strategic |
| Ollama, LM Studio, vLLM, LocalAI, Jan | Already integrated as optional engines | Keep as fallbacks; FRIDAY must work with none installed |

The runtime layer is chosen by the hardware probe plus the engine's manifest, never hard-coded.

### 4.14 What peers do and what to take from them

| Project | What it is | Take | Do not take |
| --- | --- | --- | --- |
| OpenJarvis (Stanford) | On-device personal-agent framework; MCP + A2A; OpenAI-compatible server; macOS/Linux/WSL2 first ([site](https://openjarvis.stanford.edu/)) | Local-first eval-driven design, protocol surface | Linux-first assumptions |
| Personal Jarvis (MIT) | Voice agent that controls mouse/keyboard, routes to harness adapters ([PyPI](https://pypi.org/project/personal-jarvis/)) | Adapter idea for external agents | Delegating the whole assistant to other agents |
| OpenClaw (MIT) | Self-hosted agent reachable from messaging apps; Gateway as single source of truth for sessions/routing; skills registry; readable memory; moved toward a foundation in 2026 ([architecture](https://dev.to/ialijr/lessons-from-openclaws-architecture-for-agent-builders-1j93)) | Gateway-style single control plane; human-readable memory | Open skill registry without verification (reported CVEs and supply-chain issues, CLAIM) |
| vierisid/jarvis | Always-on daemon, desktop awareness, goal pursuit; Unix/WSL ([repo](https://github.com/vierisid/jarvis)) | Idle-time proactive goals (with the autonomy dial) | Unix-only design |
| Agent S3, UI-TARS, GUI-Owl | Computer-use research stacks | Grounding vs planning split, best-of-N | Cloud-hosted grounding by default |

Providers as an optional cloud lane (already 20 in `electron/models.cjs`) and as **targets**: OpenAI Realtime (barge-in truncation by `audio_end_ms`, function-call round trips), Gemini Live (tunable server VAD, async tools with SILENT/WHEN_IDLE/INTERRUPTED scheduling, 15-minute audio session cap) from the earlier research record; ElevenLabs latency figures above. Providers not re-checked this round (Anthropic voice, Alexa+, Deepgram, Cartesia, Sarvam voice APIs): UNVERIFIED, fetch pages at build time.

---

## 5. Hindi, English and Hinglish: language architecture

- **One language layer for every capability**, not only voice: detection (script ratio, Roman-Hindi lexicon, model confidence), normalisation, transliteration, number/date/money reading, code-mixing segmentation, ASR bias list, pronunciation dictionary. Existing owners: `language_segmenter.py`, Speech Prep, `asr-bias.ts`, `text-normalizer.ts`. Extend to text chat, image prompts, search queries and file names.
- **Output language follows the owner's language and script**: Hindi in Devanagari for the Hindi voice, Roman for Hinglish text, English as spoken. A style card per language, owner-editable.
- **Evaluate per language** with the held-out sets (voice eval tooling exists; extend to text tasks, translation, code-mixed questions). A model is "Hindi capable" only with a measured score on FRIDAY's own set, with confidence intervals; groups under 30 items are not claimed.
- Hindi-strong engines are preferred where installed (Sarvam family on GPU PCs; Gemma 4 for its 140+ languages, measured per language), with English-strong engines as the fallback for code and reasoning, translating at the Brain level when needed.

---

## 6. Model and tool lifecycle (download, install, verify, fall back)

Extend the existing safe model store (done for voice in 2026-11-23) to every engine:

1. **Discover**: the registry lists candidates by capability with licence, size, languages, hardware fit; the hardware probe filters.
2. **Decide**: licence gate (code and weights separately; GPL/LGPL only as optional separate process; non-commercial licences flagged and off by default; unclear licence means no auto-install).
3. **Download**: official upstream only; `.part` file, SHA-256 before rename, free-space preflight at least 1.3 times, resume, cancel, quarantine unexpected files, `.prev` rollback, marker file.
4. **Install/Doctor**: Doctor row per engine (installed, verified, loads, answers a self-test, fits the profile), Repair and Restore buttons.
5. **Run**: lazy load, idle unload, pressure-aware; the process boundary keeps a crash from killing the app.
6. **Fall back**: ordered chain per capability and language; the router logs the reason; no silent switch to an unsuitable model.
7. **Update**: pin by revision; a new revision is a new pin; changelog and rollback; offline operation after install.
8. **Offline-first**: the app works with nothing optional installed.

Profiles: **Lite** (under 8 GB), **Balanced** (16 GB CPU, the owner's PC), **Quality** (verified GPU, 24 GB+ VRAM or large RAM). Profiles decide defaults; owner locks override and are never auto-changed.

---

## 7. Hardware tiers and what each can do (honest)

Note: this table was written for the 16 GB CPU-only case. The owner's current PC has an RTX 2060; use sections 7A to 7C for the real default. The table stays as the Lite/CPU fallback.

| Tier | Typical PC | LLM | Vision | STT/TTS | Image gen | Video gen | Music | Coding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lite | 8 GB, no GPU | 1–2B | tiny VLM | tiny/base STT, light TTS | cloud lane | cloud lane | cloud lane | cloud lane |
| Balanced (owner's) | 16 GB CPU | 4B class (Gemma 4 E4B or Qwen3-4B), a 20B only on demand | same model | small STT + Supertonic | small CPU draft + cloud lane | cloud lane only | cloud lane (ACE-Step CPU speed UNVERIFIED) | 7B coder + cloud lane |
| Quality | GPU 16–24 GB VRAM | 20–30B | Qwen3-VL 8B+ | large-v3 class optional | FLUX schnell / SDXL | LTX or Wan (24 GB+) | ACE-Step | Qwen3-Coder / Devstral |

All numbers are estimates from third-party posts until the owner's PC is measured. Phase R0 builds the benchmark harness that produces the real table.

---

## 7A. Owner's current PC as the reference tier (not a lock)

Stated by the owner on 2026-11-23: **16 GB RAM, 1 TB SSD, NVIDIA RTX 2060** at first; later the same day: CUDA and the drivers are installed and the GPU memory is **16 GB** (owner-reported, not verified by FRIDAY; the RTX 2060 is normally a 6 GB card with a 12 GB variant, so this number must be confirmed by the detection probe, section 7C and 15.1). The shortlists below are written for **both readings** (6 GB and 16 GB); FRIDAY's detected facts, not these notes, pick the models. The owner also said the exact configuration must **not** be locked: FRIDAY can be installed on small and big Windows PCs alike. This is the **default reference tier for development and tests**. It is **never hard-coded**: FRIDAY detects the PC it is installed on and picks what to download from that. When the owner buys a bigger PC, FRIDAY finds the new hardware itself and offers the bigger models. The earlier "Balanced = 16 GB CPU-only" row in section 7 is now **Balanced-GPU (6 GB class)** for this machine; CPU-only stays as the Lite fallback when no usable GPU is found.

What a 6 GB Turing card means (facts first, then design):

- **Turing (RTX 20 series, compute capability 7.5)**: faster-whisper/CTranslate2 works; for compute capability below 8.0 the int8 and int8_float16 modes use float16 weights, not bfloat16 ([faster-whisper README](https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md), VERIFIED via search). Latest CTranslate2 needs **CUDA 12 and cuDNN 9** (4.5.0+ needs cuDNN 9, which needs CUDA 12.3 or newer; the README's workaround for CUDA 12 with cuDNN 8 is `ctranslate2==4.4.0`) ([issue](https://github.com/OpenNMT/CTranslate2/issues/1806), CLAIM). Typical Turing limits, from general knowledge and not verified in this round: no bfloat16, no FP8, no FlashAttention-2 (UNVERIFIED).
- **Memory bandwidth 192 GB/s** gives a theoretical ceiling near 32 tokens/s for an 8B Q4 model ([guide](https://ailocalcheck.com/hardware/rtx-2060-6gb), CLAIM). Real tests found a 6 GB Max-Q 2060 at only 2.4 to 2.7 tok/s for a very large partially offloaded model ([hands-on](https://note.com/k_co1632/n/n7b94a53dca81?hl=en), CLAIM). **Partial offload to system RAM costs 5x to 10x speed** once CPU-resident layers are on the path of every token ([guide](https://www.sitepoint.com/optimizing-local-llms-low-end-hardware-8gb/), CLAIM). So the rule is: **choose models that fit fully in VRAM for interactive use**, and accept slow batch mode for the rest.
- **MoE trick**: llama.cpp `--n-cpu-moe N` keeps expert weights of N layers in RAM and the attention on the GPU. One report shows a 35B-A3B model at about 17 tok/s on a 6 GB GTX 1060 with 24 GB RAM, and `--n-cpu-moe` took that card from 3 to 10 tok/s ([guide](https://jeanfbrito.github.io/posts/running-qwen3.6-35b-moe-rtx3060-ncmoe/), [llama.cpp MoE offload guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide), CLAIM). **The owner has 16 GB RAM, not 24 GB**: a Q4 30B-A3B is about 20 GB, which does not fit; a smaller quant or gpt-oss-20b (about 21B total) may. No 6 GB benchmark for gpt-oss-20b was found: **UNVERIFIED, measure in R0.**
- **Disk (1 TB SSD)** is plentiful: keep two engines per capability plus one bigger optional model, and manage the cache with a cap and LRU (section 7C).

### 7B. Model shortlist for the RTX 2060 6 GB / 16 GB RAM PC (defaults, fallbacks, later)

Every row is a candidate; **FRIDAY's own held-out Hindi/Hinglish/English eval decides the default**, not the blogs. "Fits" means fits 6 GB VRAM fully unless stated.

| Capability | Default candidate (fits) | Fallback / backup | Optional heavy (slow or RAM-bound) | When a bigger PC arrives |
| --- | --- | --- | --- | --- |
| Chat LLM, Hindi/Hinglish/English | **Qwen3.5-4B or 9B Q4** (small dense family released 2026-03-02, 0.8B/2B/4B/9B, Apache 2.0, multimodal, "201 languages", Hindi not named: verify) ([Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B), [report](https://rits.shanghai.nyu.edu/ai/qwen-3-5-small-models-9b-parameters-that-beat-120b/)); **Gemma 4 E4B** Q4 (Q4_K_M file about 5.3 GB) ([Jetson guide](https://www.jetson-ai-lab.com/models/gemma4-e4b)) | Phi-4-mini, Gemma 4 E2B (about 3.4 GB at Q4, CLAIM) | gpt-oss-20b with expert offload (measure); Sarvam-30B only after a Q4 size check against 16 GB RAM | Sarvam-30B/105B, Gemma 4 26B MoE / 31B, Qwen3.5 larger |
| Tool-calling router (decides which tool/skill) | Small tool model or grammar-constrained decoding on the chat model; Qwen3-4B and Gemma 4 E4B score similarly on BFCL-style tests, but a hands-on test found Gemma 4 E4B weak at multi-step agent tasks ([comparison](https://www.ertas.ai/blog/on-device-tool-calling-2026-qwen3-gemma4-phi4), [hands-on](https://dev.to/vystartasv/google-said-it-had-native-function-calling-i-tested-it-54i7), CLAIM) | FunctionGemma 270M as a tiny router (needs the `developer` role, [Google](https://blog.google/innovation-and-ai/technology/developers-tools/functiongemma/)) | Cloud lane for long plans | Larger planner model |
| Vision / screen / camera | The same Gemma 4 E4B or Qwen3.5 multimodal (no extra resident model) | Qwen3-VL 4B (licence UNVERIFIED), SmolVLM2 | Qwen3-VL 8B with offload | Qwen3-VL 8B/32B |
| Video understanding | Keyframes through the vision model + STT on the audio track | none | Native video input on Gemma 4/Qwen (memory UNVERIFIED) | Qwen3-Omni (30B-A3B) |
| STT (Hindi, English, Hinglish) | **faster-whisper on GPU**: small/medium now; **large-v3-turbo int8_float16 should fit 6 GB (UNVERIFIED, measure)**; Hindi ear stays first for Hindi | whisper tiny/base on CPU, Windows speech | whisper.cpp | large-v3 |
| Hindi accuracy reference | Vistaar: IndicWhisper Hindi average 13.6% WER, ahead of other systems tested in 2023 ([paper](https://arxiv.org/pdf/2305.15386)); a community IndicConformer-600M card reports 12.09% with a 5-gram LM (CLAIM, self-reported); Whisper-large-v3 does poorly on noisy Hindi in the 2026 Vaani paper ([arXiv 2606.21408](https://arxiv.org/pdf/2606.21408)) | | | Hindi fine-tuned Whisper adapter (section 8) |
| TTS | Supertonic (GPU not required), light Hindi voice | system voice | **Chatterbox Multilingual** (MIT, 23 languages including Hindi, about 0.5B, torch-based: only as an optional separate-process lane, never inside the voice stack) ([card](https://huggingface.co/ResembleAI/chatterbox/blob/main/README.md), [Resemble](https://resemble.ai/introducing-chatterbox-multilingual-open-source-tts-for-23-languages)); Kyutai Pocket TTS (about 100M, CPU real-time, six languages, Hindi not confirmed) ([blog](https://kyutai.org/blog/2026-05-04-pocket-tts-multilingual/)); IndicF5 (restricted weights) | Larger expressive TTS |
| Image generation | **SDXL-Turbo class / SD 1.5 class** for fast drafts (seconds); SDXL with `--lowvram` about 3 to 5x slower ([guide](https://localaimaster.com/blog/run-flux-on-low-vram-gpu), CLAIM) | cloud lane | **FLUX.1 schnell GGUF Q3/Q4 with offload**: a 6 GB GTX 1060 took about 9 minutes for a 512 px, 10 step image (closest data point, CLAIM); FLUX.2 Klein 4B Q4_K_M about 2.6 GB, 4 steps (licence UNVERIFIED) ([guide](https://convly.ai/comfyui-gguf-setup/)) | FLUX schnell full, SDXL fast |
| Video generation | **Background batch job only**: Wan 2.2 TI2V-5B GGUF fits 6 to 8 GB with offload at 480p, minutes per short clip, "a learning tool, not a production setup" ([ComfyUI](https://docs.comfy.org/tutorials/video/wan/wan2_2.md), [GGUF](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF), [8 GB guide](https://dev.to/aitechtutorials/run-wan-22-in-comfyui-with-just-8gb-vram-full-image-to-video-ai-workflow-2gb6), CLAIM) | cloud lane | LTX-2.x GGUF needs 8 GB or more; its smallest distilled quant is 12.6 GB ([HF](https://huggingface.co/chfm/LTX-2.5-Distilled-GGUF), CLAIM) | Wan 14B, LTX full |
| Music / sound | **ACE-Step 1.5 DiT-only mode**: official guidance is at least 4 GB for DiT-only and at least 6 GB for LLM+DiT; on 6 GB or less use DiT-only, INT8 and full CPU offload ([install guide](https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/HEAD/docs/en/INSTALL.md), [GPU guide](https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/HEAD/docs/en/GPU_COMPATIBILITY.md), MIT); time at 6 GB not found: UNVERIFIED | cloud lane | Stable Audio Open / MusicGen (licences UNVERIFIED) | ACE-Step with the LM |
| Coding | Small coder 7B Q4 (fits tight) with FRIDAY's loop (plan, edit, test, repair, undo) | Chat model | Qwen3-Coder 30B-A3B or Devstral Small with offload: too big for 16 GB RAM at useful speed | Qwen3-Coder 30B-A3B, Devstral |
| Omni / speech-to-speech | none (FRIDAY stays cascaded) | | MiniCPM-o 4.5 (9B, Apache 2.0, full-duplex, but **English and Chinese only** and about 11 GB at INT4): REJECT for Hindi ([card](https://huggingface.co/openbmb/minicpm-o-4_5)) | Re-check when Hindi omni models appear |
| Embeddings / memory | `bge-m3` (already configured) | Qwen3-Embedding (evaluate, UNVERIFIED) | | |
| Music/sound, image, video | all of these must run as **cancellable background jobs** with progress, an ETA from the benchmark, and a clear "cloud lane available" button | | | |

Process rule for GPU engines: heavy GPU work (image, video, music, large STT, big LLM) takes the GPU through the **Resource governor**; a voice turn always preempts a background generation (pause, resume later). Only one heavy GPU model is resident at a time on 6 GB.


### 7B-2. What changes if the GPU really has 16 GB of VRAM (and 16 GB of system RAM)

| Capability | Fits fully in 16 GB VRAM (from the HF sizes in section 16) | Still not comfortable |
| --- | --- | --- |
| Chat/vision LLM | Qwen3.5-9B Q8 (9.5 GB) or Q4_K_M (5.7 GB) with a long context; Gemma 4 E4B Q8 (8.0 GB); **gpt-oss-20b MXFP4 (12.1 GB)**; Qwen3-VL 8B Q4_K_M (5.0 GB + mmproj 1.2 GB) | Qwen3.5-27B Q4_K_M (16.7 GB) and Gemma 4 26B-A4B Q4_0 (14.6 GB) are borderline once the KV cache and the speech models share the card; MoE expert offload is limited by only 16 GB of RAM |
| STT | faster-whisper large-v3-turbo (1.6 GB) or large-v3 (3.1 GB) on GPU beside the LLM | |
| TTS | Supertonic-3 (0.4 GB); Chatterbox-Multilingual ONNX (about 1.5 GB at fp16) as an optional Hindi voice with cloning | |
| Image | Z-Image-Turbo Q8 (7.2 GB) or FLUX.1-schnell GGUF Q4_0 (6.8 GB) plus encoders; FLUX.2-klein-4B | text encoders add several GB; free the LLM while generating |
| Video | Wan2.2 TI2V-5B Q8 (5.4 GB) plus the umt5 encoder offloaded | LTX-2.x (22B) too big |
| Music | ACE-Step 1.5 with the LM (0.6B to 1.7B) | |
| Coding | 9B to 14B coders at Q4 to Q8; Devstral/Qwen3-Coder 30B-A3B only with offload, limited by 16 GB RAM | |

Rule that does not change: **one heavy GPU model resident at a time** unless the measured sum plus headroom fits; the Resource governor swaps by priority (voice first).

### 7C. Hardware detection, auto-profile and auto-upgrade (the "no lock" design)

1. **Fingerprint at every launch** (cheap, no admin rights): OS and build; CPU model, cores, AVX2/AVX512 flags; total and free RAM; GPUs (vendor, name, dedicated VRAM, driver version) from several probes so one wrong probe cannot decide alone: Electron `app.getGPUInfo`, `nvidia-smi --query-gpu` when present, Windows display adapter data, and for Python a ctypes memory probe; NPU presence (informational); disk free space on the model drive; battery or plugged in. Existing code already does part of this (`probeHardware`, `budgetFor`).
2. **Capability facts, not names**: derive `vramGb`, `ramGb`, `cudaReady` (driver new enough and CUDA 12/cuDNN 9 runtime present or installable), `diskFreeGb`, `cpuClass`. Never test "is it an RTX 2060"; test the facts. A 12 GB 2060, a 3060 or a 4090 then fall out of the same table.
3. **Fit score per engine**: from the engine manifest (min/recommended RAM, min VRAM, disk, quantization) plus **measured** speed from a short benchmark run on first launch and after a hardware change (tokens/s, real-time factor, time to first token). Engines that do not fit with headroom are shown as "needs a bigger PC", not hidden.
4. **VRAM ladder** (defaults the router and installer follow; every row is overridable by the owner):

| VRAM | System RAM | LLM / VLM default | STT | Image | Video | Music | Coding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none / under 4 GB | 8 GB | 1 to 2B | tiny/base CPU | cloud lane | cloud lane | cloud lane | cloud lane |
| 4 to 6 GB (owner now) | 16 GB | 4B to 9B Q4, small multimodal | small to large-v3-turbo on GPU | SDXL-Turbo class; FLUX GGUF slow | Wan 5B GGUF batch | ACE-Step DiT-only | 7B coder |
| 8 GB | 16 to 32 GB | 8B to 9B Q5/Q6 | large-v3-turbo | SDXL, FLUX GGUF Q4 | Wan 5B / LTX GGUF | ACE-Step with LM | 7B to 14B coder |
| 12 GB | 32 GB | 14B class, gpt-oss-20b | large-v3 | FLUX schnell FP8 | LTX / Wan 5B comfortable | ACE-Step | 14B to 24B coder |
| 16 to 24 GB | 32 to 64 GB | Gemma 4 26B MoE, Sarvam-30B, Qwen3-Coder 30B-A3B | large-v3 + Hindi ear | FLUX schnell/dev (licence), SD 3.5 | Wan 14B / LTX | ACE-Step XL | 30B coder |
| 48 GB+ or multi-GPU | 64 GB+ | 70B+ and Sarvam-105B | any | any | any | any | any |

5. **Auto-download with consent**: first run installs only the default for the detected tier plus one fallback per capability (small), verified by SHA-256; larger optional models are **offered with size and time**, not forced. Disk guard: the model cache has an owner-set cap (default a fraction of free space, LRU eviction of unused optional models, never delete a pinned default).
6. **Re-detect and upgrade advisor**: if the fingerprint changes (new GPU, more RAM, new drive), FRIDAY reruns the benchmark and shows "Your PC can now run X for Y: download?" It never silently changes an owner lock; it never downgrades below the last working default without a repair flow.
7. **CUDA runtime policy (owner decision, section 13)**: GPU STT/LLM need the NVIDIA driver (installed by the owner or Windows Update) plus CUDA 12 and cuDNN 9 libraries. NVIDIA announced in September 2025 that CUDA can be redistributed through developer platforms and that `pip install` is an official avenue ([HPCwire](https://www.hpcwire.com/aiwire/2025/09/12/nvidia-enables-direct-cuda-distribution-via-popular-developer-platforms/)); the toolkit EULA says third-party components keep their own licence terms ([EULA](https://docs.nvidia.com/cuda/archive/12.9.0/pdf/EULA.pdf)). Whether the cuBLAS/cuDNN wheels may be **bundled inside the EXE** was not settled by this research: UNVERIFIED. Safest design: **download from the official PyPI wheels on demand into the data root, pinned by SHA-256**, like every other weight, with a Doctor row; never bundle. This reverses the earlier "FRIDAY never downloads CUDA files" line from the 16 GB CPU profile work, which was written when no GPU was assumed; the owner now has a GPU, so the decision should be revisited.
8. **Fail-safe**: any GPU failure (driver, out of memory, wrong CUDA) falls back to the CPU engine for that capability with a one-line reason and a repair button; an optional engine can never crash the app.

### 7D. Live voice: what ChatGPT, Gemini and the open stacks teach, mapped to FRIDAY

Facts found: Pipecat's default turn stop is a local Smart Turn v3 analyzer with Silero VAD and a 0.2 s silence stop; LiveKit ships a semantic turn detector as default and self-hostable add-on; a semantic turn detector reportedly cuts mid-thought interruptions by about 87% for about 20 ms (vendor-derived, CLAIM) ([comparison](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents), [Pipecat guide](https://aiworkflowlab.dev/article/build-production-voice-ai-agents-pipecat-python-latency-barge-in)). A tuned cascade is reported at 500 to 800 ms voice to voice, mostly decided by turn detection and TTS chunking, not model choice. **An independent measurement study found that a tool call adds 0.9 to 1.1 s in every architecture, more than the difference between frameworks, and that frameworks' self-reported latency understates what listeners experience**, so latency must be measured at the listener's end ([arXiv 2611.19118](https://pith.science/paper/2611.19118)). OpenAI Realtime and Gemini Live details (barge-in truncation by `audio_end_ms`, tunable server VAD, non-blocking tools with SILENT/WHEN_IDLE/INTERRUPTED scheduling, 15-minute audio session cap) are in the earlier research round.

Target live pipeline for FRIDAY on the owner's GPU PC (all stages already exist in some form; the gaps are marked):

```
mic → capture (one owner) → AEC (reference from playback) → denoise → VAD
    → semantic end-of-turn (smart-turn, text rule)               [done, Windows unverified]
    → STT streaming partials (GPU faster-whisper / Hindi ear)    [GAP: rolling-window partials]
    → language + intent + sensitivity (script ratio, router)     [done]
    → Brain first-token (small model, prefix-cached prompt)      [partly: prefix-cache layout is a GAP]
    → clause chunker → TTS (clause streaming, generation ids)    [done]
    → playback scheduler (one owner, gapless)                    [done]
    ↑ barge-in: cancel TTS by utterance id; history truncated to what was heard [cancel done; history GAP]
    ↑ tool calls: instant ack + progress narration while the tool runs (hides the 0.9-1.1 s) [done]
```

Gaps against a ChatGPT/Gemini-class feel, in priority order: (1) real Windows measurement at the listener's end (extend the stage clock with an output-side loopback or mic-loop measurement); (2) streaming partials so first words appear while speaking; (3) barge-in history truncation; (4) backchannel versus interruption; (5) result-timing policy for finished background tasks; (6) prosody and emotion matched to the owner's tone (existing tone scorer); (7) wake word plus speaker verification polish; (8) session continuity (rolling summary and memory consolidation; there is no vendor session cap locally); (9) a voice-quality evaluation with the owner as listener (MOS-style forms), because no automatic score captures "natural".
With a GPU, move STT and (where licensed) TTS decode to the GPU only after the benchmark shows a gain, keep the CPU path as the fallback, and keep the speech worker's idle unload and pressure rules so the LLM and the speech models never fight for 6 GB.

### 7E. Chat/assistant features to match other assistants (checklist)

Projects reviewed (OpenJarvis, Personal Jarvis, OpenClaw, vierisid/jarvis, Agent S3, UI-TARS) and products (ChatGPT, Gemini, ElevenLabs agents) point to the same feature set. Status for FRIDAY: **have** = exists today; **partial**; **gap**.

| Feature | Status | Note |
| --- | --- | --- |
| Persistent memory the owner can read and delete | partial | Add temporal facts, provenance, forget-on-request (R8) |
| Proactive help (briefs, reminders, goal pursuit) | partial | Scheduler exists; add idle-time goals under the autonomy dial |
| Tool use with approvals and undo | have | Risk table, journal, kill switch |
| MCP server and client; A2A | partial | Migrate to MCP 2026-07-28; A2A undecided (R10) |
| Computer use (PC): UIA first, vision fallback | partial | UIA exists; add grounding model lane on GPU |
| Browser and website control | partial | Playwright MCP style accessibility snapshots; injection tests |
| Multi-agent delegation | have | 122 agents; add budget and verification per delegate |
| Scheduled and background tasks with desk | have | Task desk, INTERRUPTED, retry |
| Multimodal in/out (image, audio, video) | gap | Capability Registry (R1, R3, R5) |
| Skill marketplace with verification | partial | Never run unverified third-party skills |
| Local OpenAI-compatible endpoint | gap | Optional, loopback, off by default (R10) |
| Voice cloning of the owner's own voice | gap | Only with explicit consent, never another real person |
| Personal fine-tuning from the owner's data | partial | `finetune_lora.py`; full loop in R9 |
| Evaluation and independence dashboard | partial | Voice eval tooling exists; extend to text and tools |


---

## 8. The self-growth loop (independence over time)

Goal: FRIDAY's own tuned components handle more and more; outside models become fallback.

**8.1 What FRIDAY may learn from (owner-consented, local)**
- The owner's corrections and accepted/rejected answers (answer ledger outcomes).
- The owner's consented voice samples for the speaker profile (enrolment consent exists).
- Task traces that ended in success (tool sequences, repair patterns).
- Documents and notes the owner marks as "learn from this".
- Never: secrets, other people's private data, raw audio by default, anything marked SENSITIVE, cloud-model outputs unless the provider's terms allow training use (UNVERIFIED per provider; default off).

**8.2 What FRIDAY trains**
- **Adapters (LoRA/QLoRA) on small open bases**: style and language card (Hindi/Hinglish tone), tool-calling reliability, routing/intent classifier, wake/command intent, domain skills. QLoRA on 7–8B models is reported feasible on a 12 GB consumer GPU; Unsloth is the most cited tool and claims 2–5x speed (CLAIM) ([guide](https://dev.to/pockit_tools/fine-tuning-open-source-llms-with-qlora-and-unsloth-the-complete-2026-guide-2ome), [overview](https://insiderllm.com/guides/fine-tuning-local-lora-qlora/)); adapters can be swapped at serve time without reloading the base. Tether's QVAC work adds LoRA fine-tuning inside llama.cpp for heterogeneous GPUs ([HF blog](https://huggingface.co/blog/qvac/fabric-llm-finetune), CLAIM), which would avoid a torch install in FRIDAY itself (to be evaluated).
- **Small specialist models** (classifiers, rerankers, language-ID, turn detection, speaker verification) where a few MB beat a large model.
- **Speech**: Whisper-small LoRA on consented owner recordings, offline, outside the app (PEFT needs torch, so the trainer is an optional separate tool, never inside the voice stack).

**8.3 Safe training pipeline**
1. Data snapshot with manifest (source, consent, licence, hashes, splits) in the existing eval/readiness format; held-out test set frozen and never trained on.
2. Train in a **separate, optional process** (outside the Electron app and outside the voice stack, so the torch ban for the voice stack holds), on the owner's PC or a cloud GPU only if the owner allows and the data class permits.
3. **Eval gate**: the candidate must beat the incumbent on the owner's own held-out set per language and per capability, with intervals; regressions on safety and tool tests fail the candidate; no weakened tests.
4. Version the adapter with the base revision, data manifest hash, metrics and rollback pointer.
5. **Canary**: used for a share of requests (or only when the owner opts in), ledger watches calibration; auto-rollback if the hard gate trips.
6. Promote; keep the previous adapter; log in the audit trail.

**8.4 Avoiding forgetting and drift**
- Many small domain adapters instead of one big merged model; replay a sample of old data; evaluate the old suite on every candidate; never overwrite the base.
- Prefer retrieval (memory) for facts and adapters for behaviour and style. Continual-learning-specific sources were not found this round: UNVERIFIED, research before building anything beyond adapters + replay.

**8.5 Independence metrics (to show progress honestly)**
Share of requests answered locally per capability and language; escalation rate to cloud; ledger calibration (ECE, Brier); first-audio and first-word latency; owner correction rate; cost per week. Published on a Doctor page, never faked.

---

## 9. Roadmap (phases, owners, done-definitions)

Each phase names the kinds of engineers it needs (voice, brain, app, kernel, models, audio, language, wiring, performance, quality, security). Work is split into disjoint file sets, a few writers at a time, with a claim on each file. Each phase ends with tests, the owning document, and `FRIDAY_STATE.md`.

**R0 — Detect and measure the PC (blocks everything else).** performance, audio, wiring and models engineers. (1) Hardware fingerprint from several probes (Electron GPU info, `nvidia-smi`, Windows adapter data, memory probe, disk free) into capability facts `vramGb`, `ramGb`, `cudaReady`, `diskFreeGb`, `cpuClass` (section 7C); never match on a GPU name. (2) `npm run bench:pc`: tokens/s per installed LLM at several context sizes, STT real-time factor on CPU and GPU, TTS first-audio, image/video/music seconds per unit, memory per engine, GPU temperature and fan under load, written to a local report. (3) Fit score and the VRAM ladder (7C table) as data, not code branches. (4) Upgrade advisor: re-run on hardware change and offer bigger models. Done when the owner has run it on his RTX 2060 PC and the tables in 7A to 7C hold real numbers (RTX 2060 VRAM 6 GB or 12 GB confirmed by the probe), and a simulated 24 GB / 64 GB fingerprint in tests selects bigger defaults. Windows items stay "unverified" until then.

**R1 — Capability Registry and one router contract.** architect, kernel, brain, models and wiring engineers. Contracts per capability (section 3.3), registry inside the existing catalogue, router asks by capability + language + hardware + privacy + budget. Done when every existing engine is registered, the router returns an ordered chain, Doctor shows rows, and tests pin firewall order (privacy before billing before choice). GPU lane: CUDA 12/cuDNN 9 runtime installed on demand from official wheels with SHA-256 (owner decision 7 in section 13), one heavy GPU model resident at a time on 6 GB, voice preempts background generation.

**R2 — Brain upgrade: understanding, plan, cascade.** brain, language and kernel engineers. Language layer for all text, intent + capability planner, small-first cascade with ledger gate, prefix-cache-friendly prompt layout, parallel step execution with bounded concurrency. Done when a Hindi/Hinglish/English test set (own held-out) shows measured gains and no safety regressions.

**R3 — Vision and screen (image/video understanding).** app, models and kernel engineers. `vlm.image_understand` with Gemma 4 E4B primary, Qwen3-VL optional (licence check first), keyframe+audio video path, screen/camera on one chain; UIA-first, vision-fallback computer use; injection isolation tests on screenshots. Done when screen Q&A, OCR-vs-VLM choice and video summary pass tests and fit 16 GB with the speech models unloaded on demand.

**R4 — Voice completion (the earlier gap list).** voice, audio, performance and language engineers. Rolling-window streaming partials for Hindi/Hinglish; Hinglish ear for mixed speech; barge-in history truncated to what was heard; backchannel versus interruption gating; result-timing policy for finished tasks (SILENT, WHEN_IDLE, INTERRUPTED idea); smart-turn Hindi check (revision, hash, eval); `voice.sttSize` honoured end to end; transliteration folding in the deduper; Windows run of every voice item. Done when the owner's PC numbers meet the voice targets or the gap is named.

**R5 — Creation: image, audio, video, music.** models, app and security engineers. `image.generate/edit`, `audio.music_sfx`, `video.generate` contracts; local small engines where they fit; cloud lane engines (billing and privacy firewalls on, owner must enable); provenance metadata; Hindi/Hinglish prompt rewriting; storyboard-to-assembly tooling locally (script, TTS voice-over, subtitles). Done when each contract has at least one local-capable engine (or a documented "cloud only on this tier") and tests for firewalls, licences and cancellation.

**R6 — PC, hardware and website management.** kernel, app, security and core-test engineers. `pc.hardware` read-only first, then `pc.manage` actions behind approvals and undo; Playwright MCP-based `web.browse` and `site.manage` with preview/dry-run; deployment helpers; credential handling only through `safeStorage`. Done when every action has a risk class, an approval path, an undo or a stated "irreversible", and injection tests.

**R7 — Research and coding loops.** brain, kernel, research and UI-test engineers. Citation-first research loop with dated findings in memory; coding loop (plan, edit, test, repair, undo) with small local coder + cloud lane; evaluate on the owner's own repos. Done when benchmarks on owner tasks beat the baseline with intervals.

**R8 — Memory v2.** brain, kernel and language engineers. Temporal facts, core blocks, idle consolidation, provenance, forget-on-request, memory evals. Done when recall/precision tests pass on a Hindi/Hinglish/English fixture set and deletion is verified.

**R9 — Self-growth loop.** architect, models, performance and security engineers. Consent UI, data manifests, optional separate training tool (QLoRA/QVAC route evaluated first), eval gate, adapter versioning, canary and rollback, independence metrics page. Done when one adapter (for example the Hindi/Hinglish style or the tool-call reliability adapter) passes the gate on the owner's held-out set and can be rolled back; no claim without that evidence.

**R10 — Protocols and ecosystem.** wiring and security engineers. MCP 2026-07-28 migration with shim; A2A research and decision; AGENTS.md/skills compatibility; OpenAI-compatible local endpoint decision (off by default, loopback only). Done when MCP tests pass on both versions and the security review signs off.

**R11 — Hardening and release readiness.** core-test, UI-test, review, security and release engineers (release only with the owner's yes for locked areas) and a final rules gate. Full test suite once, failure injection, stress, supply-chain review of every new dependency, Windows install/uninstall/update checks run by the owner.

Ordering: R0 first. R1 before R3, R5, R6. R2 and R4 can run in parallel with R1 after contracts exist. R9 only after R1, R2 and a stable eval set. Re-run the web research at the start of each phase: models and licences in this file will age within weeks.

---

## 10. Where code and files go (so nothing is duplicated)

Follow `config/project-structure.json` and `AGENTS.md` (one feature, one location; new file only when no owner fits; register docs; `arrange:check`).

| New work | Owner location |
| --- | --- |
| Capability contracts and registry | `src/lib/friday/model-catalog.ts` + `electron/model-catalogue-store.cjs` (extend); kernel side `kernel/router.py`, `kernel/runtimes.py` |
| Hardware profile and budgets | `src/lib/friday/voice-engine/hardware-profile.ts` pattern, `electron/voice-weights.cjs` `budgetFor` (generalise name, keep parity test) |
| Safe store for all engines | `electron/model-download.cjs`, `electron/voice-pins.cjs` (generalise pins to engines), Doctor rows |
| Vision, image, video, music engines | `kernel/media_tools.py` (existing) + new engine wrappers beside it; renderer calls through `kernel-api.ts` |
| PC/hardware/website | `kernel/tools.py` risk table, `kernel/control.py`, `kernel/uia_*`, `src/lib/friday/browser-engine.ts` |
| Self-growth | `kernel/finetune_lora.py` (existing), eval scripts under `scripts/voice-eval*.cjs` pattern, manifests in `config/` |
| Docs | one owner per subject in the document index; this file as the roadmap reference; `FRIDAY_STATE.md` for live facts |

Forbidden-dependency rules stay as written for the voice stack. Optional separate-process tools (trainers, GPL/LGPL engines, torch-based models) are downloaded on demand from official upstream, never committed, never bundled in the EXE, and FRIDAY runs without them.

---

## 11. Safety, governance and legal

- **Execution**: `auto_approve_exec: false`; Full autonomy is the owner's dial; Stop everything halts all.
- **Untrusted input**: web, screen, file, email, MCP, transcript and tool output are data, never instructions (every new capability adds an injection test).
- **Cloud lane**: privacy firewall (SENSITIVE never leaves), billing firewall (paid and unknown-cost hidden until paid access on), spend budgets; outputs labelled with the engine that made them.
- **Content**: no malware, stalkerware, covert surveillance; no voice or face imitation of a real person; synthetic media carries provenance metadata; FRIDAY never claims to be human.
- **Licences**: code and weights recorded separately; non-commercial and revenue-capped licences flagged and off by default; the owner reads Supertonic's OpenRAIL-M; IndicF5-derived models inherit restrictions (CLAIM); LTX and Qwen3-VL licences must be read on the official card.
- **Supply chain**: official upstream only, pinned revisions, SHA-256, quarantine of unexpected files; open skill/plugin registries are verified before running (OpenClaw's reported CVEs are the cautionary tale, CLAIM).
- **Privacy**: no raw audio saved by default; consent, retention and delete controls for any voice data; training only on consented, local data.

---

## 12. Risks and unknowns (stated plainly)

1. Nothing in this file is measured on the owner's Windows PC. R0 fixes that. The RTX 2060 VRAM size (6 GB or 12 GB) is not confirmed; every GPU number is a third-party estimate until R0 runs.
2. Many numbers come from blogs, not model cards. Search results were also partly 2025-era text relabelled for 2026; always open the primary page.
3. Hindi/Hinglish quality of Gemma 4, Qwen3-VL, Sarvam-30B and the TTS candidates is unmeasured on FRIDAY's own set.
4. On the owner's RTX 2060 (6 GB) PC, interactive work should fit fully in VRAM; 30B coders, large VLMs and fast video/image generation do not, and partial offload costs 5x to 10x speed. The plan uses small multimodal models, background jobs, an optional cloud lane, and automatic upgrades after a bigger PC.
5. Fine-tuning needs a GPU or a cloud GPU in practice; CPU-only training of useful models is unverified.
6. Licences move: LTX terms conflict across sources; Zep's open-core status conflicts; Sarvam's 105B positioning conflicts.
7. Prompt injection grows with every new capability (web, screen, files); each phase carries tests.
8. Complexity risk: the Capability Registry must reduce, not multiply, special cases. The first success test is deleting old per-feature model lists.

Also unresolved after the second pass: real RTX 2060 numbers for Gemma 4 E4B, Qwen3.5-9B, gpt-oss-20b with expert offload and large-v3-turbo VRAM; Hindi quality of Qwen3.5, Gemma 4 and Chatterbox on FRIDAY's own set; whether cuBLAS/cuDNN wheels may be bundled in an app; ACE-Step generation time at 6 GB; FLUX.2 Klein licence; Kyutai Pocket TTS Hindi; Whisper large-v3-turbo Hindi WER; Hinglish (code-mixed) ASR benchmarks.

Not researched this round (UNVERIFIED, research at build time): A2A adoption; Anthropic, Deepgram, Cartesia, Alexa+ voice products; OmniParser; local rerankers and Qwen3-Embedding; Windows hardware-sensor libraries; Stable Audio Open and MusicGen licences; continual-learning methods; Qwen3.5-Omni weights and licence; per-size Qwen3 licences; Sesame CSM and Ultravox.

---

## 13. Decisions the owner should make (short list)

0. (Answered 2026-11-23) Hardware: RTX 2060 / 16 GB RAM / 1 TB SSD is the default reference, never locked; FRIDAY detects and adapts and offers bigger models after a PC upgrade.

1. Allow an optional **cloud lane** for image, video and music generation on the 16 GB PC (billing firewall stays)? Or wait for a GPU PC?
2. Is a **GPU PC** planned? It unlocks Sarvam-30B, FLUX, Qwen3-VL 8B, ACE-Step and local fine-tuning.
3. May FRIDAY train adapters on **consented local data** (corrections, tasks, own voice)? Which categories?
4. Accept **non-commercial** weights for personal-only use (some are better), or stay commercial-clean only?
5. Read the Supertonic OpenRAIL-M licence.
6. Allow an **OpenAI-compatible local endpoint** (loopback, off by default) so other tools can use FRIDAY's models?
7. Priority order of R3 to R9 (the default above is vision, creation, PC/web, research/coding, memory, self-growth).
8. **GPU runtime policy**: allow FRIDAY to download the NVIDIA CUDA 12 and cuDNN 9 runtime libraries on demand from the official PyPI wheels (pinned, SHA-256, never bundled in the EXE)? The earlier CPU-profile rule said FRIDAY never downloads CUDA files.
9. **Separate-process engines**: Chatterbox-Multilingual now has ONNX and GGUF conversions (MIT), so Hindi TTS no longer needs torch; allow only truly torch-based tools (trainers, IndicF5, indic-parler) as downloaded separate replaceable processes outside the voice stack, with FRIDAY working without them?
10. **Background generation**: accept slow local image/video/music jobs on the RTX 2060 (minutes each, cancellable, voice always preempts) with a cloud-lane button for speed, or cloud only?

---

## 15. Research appendix A (2026-11-23, second pass): detection, serving, routing, realtime, repositories

Evidence labels as in the header. Every row has one source unless marked; the two-source rule is **not** met yet, so decisions that drive code must be re-checked at build time.

### 15.1 Windows hardware detection (what to read, and what not to trust)

| Item | Finding | Source | Verdict |
| --- | --- | --- | --- |
| DXGI `DXGI_ADAPTER_DESC` | `DedicatedVideoMemory` is VRAM not shared with the CPU; `SharedSystemMemory` is the most system RAM the adapter may use; integrated GPUs show a small dedicated and a large shared value ([MS Learn](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc), VERIFIED) | primary | ADOPT as the vendor-neutral adapter list (vendor ids 0x10DE, 0x1002, 0x8086); drop the software adapter (flag from memory, UNVERIFIED) |
| `nvidia-smi` / NVML | nvidia-smi is built on NVML; **its output format is not stable across drivers**, so long-lived code should use NVML or its Python bindings; documented query: `--query-gpu=name,memory.total,memory.free,driver_version,compute_cap --format=csv,noheader,nounits`; exit code 9 = driver not loaded, 12 = NVML library not found ([NVIDIA](https://docs.nvidia.com/deploy/nvidia-smi/index.html), VERIFIED, first 100k of 192k characters) | primary | ADAPT: query flags for NVIDIA, exit 9/12 mean "no usable NVIDIA GPU"; prefer NVML (`nvidia-ml-py`) when importable. NVML API page itself not fetched: UNVERIFIED |
| WMI `Win32_VideoController` | `AdapterRAM` is a 32-bit field and misreports above 4 GB (memory, UNVERIFIED; FRIDAY already notes the 4 GB cap in `electron/hardware.cjs`) | | Use only for name and driver version, never VRAM |
| Windows ML execution providers (updated 2026-11-20) | CPU and DirectML (legacy) ship with Windows ML; other EPs download on demand through `ExecutionProviderCatalog` on Windows 11 24H2 (build 26100) or later: NvTensorRtRtx (RTX 30xx and newer, driver 32.0.15.5585+, CUDA 12.5+), AMDGPU (Adrenalin 24.12.1+), OpenVINO, QNN (Snapdragon X NPU), VitisAI (AMD NPU), WebGPU (experimental), MIGraphX (deprecated) ([MS Learn](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/supported-execution-providers), VERIFIED) | primary | ADAPT for ONNX models (voice, embeddings) and NPU detection only. The SDK targets C#/C++; Node/Python path UNVERIFIED. Not for the LLM, which stays on llama.cpp. **Note: NvTensorRtRtx covers RTX 30xx and newer, so a Turing card (RTX 20xx) is not on that list; use CUDA execution or llama.cpp CUDA instead** |
| Hybrid laptops | Enumerate every adapter; pick the discrete one with the most dedicated VRAM that is not software (design, UNVERIFIED) | | ADAPT |
| npm `systeminformation`, Python `nvidia-ml-py` | Common cross-platform probes (GitHub research, memory) | | ADOPT behind try/import |

Facts FRIDAY should expose from detection (already specified in 7C): `vramGb`, `vramFreeGb`, `ramGb`, `ramFreeGb`, `diskFreeGb`, `gpuVendor`, `gpuName`, `gpus[]`, `cudaReady`, `driverVersion`, `npu`, `cpuClass`, `sources[]` (which probes agreed). Routing and the installer read **facts only**.

### 15.2 llama.cpp server as the local LLM engine ([README, master](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md), read 2026-11-23, VERIFIED)

| Feature | Flags / endpoints | Verdict |
| --- | --- | --- |
| Constrained decoding | `--grammar`, `--grammar-file`, `-j/--json-schema`, per-request `json_schema` or `grammar` | ADOPT for tool calls from small models (guarantees valid JSON arguments) |
| Prompt and KV reuse | `--cache-prompt` (on by default), `--cache-reuse N` | ADOPT; keep system prompt and tool definitions first and byte-stable |
| Slots | `-np`, continuous batching, `GET /slots`, `--slot-save-path` to save/restore a slot cache | ADAPT: one or two slots for a single owner; save the slot cache before unloading |
| Speculative decoding | `--spec-type` (draft-simple, draft-mtp, ngram variants), `-md`, `--spec-draft-n-max` (default 3) | ADAPT: benchmark per PC; MTP only appears as a "sidecar" kind next to dflash/eagle3/dspark in the router docs: leave UNVERIFIED until a supporting model is installed |
| **Router mode** | Starts with no model and routes by the request `model` field; `GET /models` (unloaded, loading, loaded, sleeping, downloading), `POST /models/load`, `/models/unload`, `GET /models/sse`, `POST /models` for downloads, `DELETE /models`; `--models-dir`, `--models-preset`, `--models-max`, `--models-memory-margin N` (unloads idle models LRU first, never a serving one), `--models-autoload`, preset `.ini` with `load-on-startup`, `stop-timeout` (default 10 s) | ADOPT for hot-swap and idle unload; check `kernel/router.py` before building a home-grown swapper |
| Idle unload | `--sleep-idle-seconds` (default off) | ADOPT |

Pin the llama.cpp release and its SHA-256 before relying on any flag; the master README changes between builds.

### 15.3 Routing, cascades and context

| Item | Finding | Verdict |
| --- | --- | --- |
| RouteLLM ([arXiv 2406.18665](https://arxiv.org/abs/2406.18665), abstract) | Router picks a strong or weak model per query; reports more than 2x cost reduction "in certain cases" (a lead, not a result) | ADAPT: start from a rule gate (privacy, tools needed, length, language) then add a learned score trained on FRIDAY's own ledger |
| FrugalGPT ([arXiv 2305.05176](https://arxiv.org/abs/2305.05176), abstract) | Three levers: prompt adaptation, LLM approximation, LLM cascade; claims up to 98% lower cost at equal quality (a lead) | ADAPT: small-first cascade with a verifier (schema valid, tool arguments valid, self-consistency); escalation to cloud only behind both firewalls |
| Semantic cache | Not fetched this round | UNVERIFIED; if built, cache only non-SENSITIVE, non-time-bound answers |
| Anthropic context engineering ([post, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), VERIFIED) | Compaction near the limit, structured note-taking to persistent memory, sub-agents with clean windows returning summaries, just-in-time retrieval through lightweight references, tool-result clearing as the lightest compaction | ADOPT tool-result clearing and notes first; the long-chat rule already limits what the model gets |

### 15.4 Realtime voice protocol facts

| Provider pattern | Finding | FRIDAY use |
| --- | --- | --- |
| OpenAI Realtime ([guide](https://developers.openai.com/api/docs/guides/realtime-conversations), VERIFIED) | With VAD on, the server cancels the response and sends `response.done` with status `cancelled`. Over WebRTC/SIP the server tracks what was played and truncates; **over WebSocket the client must stop playback on `input_audio_buffer.speech_started`, record the milliseconds actually heard, and send `conversation.item.truncate` with `audio_end_ms`** without waiting for `response.done`. The transcript is not truncated exactly. Push-to-talk uses `response.cancel` (and `output_audio_buffer.clear` on WebRTC) | ADOPT: keep a played-milliseconds counter in the playback scheduler and trim the conversation history to what was heard (this is gap 3 in 7D) |
| OpenAI VAD ([guide](https://developers.openai.com/api/docs/guides/realtime-vad), VERIFIED) | `server_vad`: `threshold`, `prefix_padding_ms`, `silence_duration_ms`; `semantic_vad`: `eagerness` (low, medium/auto, high); `interrupt_response`, `create_response` | ADAPT: an eagerness dial on the existing semantic end-of-turn (smart-turn + text rule) |
| Gemini Live ([capabilities](https://aistudio.google.com/docs/live-api/capabilities), VERIFIED) | On interruption generation is discarded, the server sends an `interrupted` flag, the client clears queued audio, pending tool calls are cancelled with their ids sent back. VAD knobs: start/end of speech sensitivity, `prefix_padding_ms`, `silence_duration_ms` (recommended 500 to 800 ms; 100 to 200 ms fragments speech; 2000 ms feels slow). Async tools: `NON_BLOCKING` with `SILENT`, `WHEN_IDLE` or `INTERRUPTED` scheduling. Audio sessions limited to 15 minutes, 128k context for native-audio models | ADAPT: tool calls cancel on barge-in; finished-task results scheduled by assistant state; FRIDAY has no 15-minute cap locally |

### 15.5 Repositories: what to take and what not (GitHub pass)

Live-read (V) pages: smart-turn, OpenJarvis, OpenClaw. All other rows are from memory (cut-off June 2026): **re-check licence, stars and last release before recording anything**. GitHub API access was denied in the research sandbox, and no repo returned release dates.

| Group | Repo | Licence | Verdict |
| --- | --- | --- | --- |
| Voice | pipecat-ai/smart-turn (V) | BSD-2, 1.7k stars | ADOPT the design: about 8M parameters, 8 MB int8 CPU, 32 MB fp32 GPU, 16 kHz mono PCM up to 8 s, 23 languages including Hindi; study `inference.py`; measure on Hinglish |
| Assistants | open-jarvis/OpenJarvis (V) | Apache-2.0, 18.1k stars, Python + Rust + Tauri | ADAPT ideas: local-first agents, skills, local traces feeding a learning loop, energy/latency/cost eval. Not the framework (FRIDAY has a Brain and a router) |
| Assistants | openclaw/openclaw (V) | MIT, about 395k stars | ADAPT: gateway and Windows packaging ideas; REJECT as a dependency (large attack surface, separate assistant) |
| Runtimes | ggml-org/llama.cpp | MIT | ADOPT as `llama-server`, pinned release and SHA-256; `llama-bench` for measurement |
| Runtimes | microsoft/onnxruntime-genai | MIT | ADOPT for CPU, DirectML and NPU paths without torch |
| Runtimes | ollama, LM Studio, LocalAI, Jan, vLLM | MIT / app / MIT / AGPL(recheck) / Apache | Ollama and LM Studio: detect-only optional providers; LocalAI and Jan: REJECT code; vLLM: forbidden by the project rules and no Windows support |
| Agents | Letta, mem0, Graphiti, LangGraph, smolagents, OpenHands, goose, cline | Apache/MIT | ADAPT patterns (tiered memory, extract/update/dedupe, temporal facts, checkpointed graphs, code-as-action sandbox, MCP-first extensions, plan/act with approval); REJECT the dependencies; Open Interpreter and Skyvern are AGPL: REJECT code |
| Computer use | Agent-S, UI-TARS-desktop, OmniParser, browser-use, playwright-mcp | Apache / Apache / MIT code (model licences differ) / MIT / Apache | ADAPT grounding/reflection and action spaces; UIA first, vision fallback; playwright-mcp ADOPT as an optional MCP server over accessibility snapshots |
| Voice stacks | pipecat, livekit agents, TEN, Unmute/Moshi, RealtimeSTT/TTS, WhisperLive, speaches | BSD/Apache/Apache/MIT+CC-BY/MIT/MIT/MIT | ADAPT frame-pipeline, turn and preemptive-generation, streaming window plus agreement policy and an OpenAI-compatible STT/TTS API shape; REJECT torch-based or GPU-only stacks as dependencies |
| Evals | lm-evaluation-harness, BFCL (gorilla), llama-bench, OSWorld, Open ASR leaderboard | MIT/Apache/MIT/Apache/n.a. | ADAPT as offline tools; BFCL cases gate tool-use models; llama-bench measures tokens/s per PC |
| Fine-tuning | Unsloth, LLaMA-Factory, axolotl, PEFT, QVAC fabric llama.cpp LoRA | Apache (Unsloth has paid parts) | ADAPT recipes as optional separate tools; QVAC's llama.cpp LoRA path would avoid a torch install (repo path and licence UNVERIFIED) |
| Hardware | systeminformation (npm), nvidia-ml-py, LibreHardwareMonitor | MIT / BSD / MPL-2.0 | ADOPT the first two behind try/import; LibreHardwareMonitor only as a separate optional process (driver and admin needed); GPUtil stale: REJECT |
| Image/video | stable-diffusion.cpp, ComfyUI (+ ComfyUI-GGUF), FastSD CPU, Forge | MIT / GPL-3.0 (+Apache) / MIT / AGPL-3.0 | **stable-diffusion.cpp ADOPT** (GGUF, CPU/Vulkan/CUDA, no torch, fits any PC); ComfyUI ADAPT only as an optional on-demand separate process driven through its HTTP/WebSocket API, never bundled (GPL); Forge REJECT (AGPL) |


## 16. Research appendix B (2026-11-23): model catalogue from the Hugging Face API

Source: live Hugging Face API (`api/models/<id>?blobs=true`) read 2026-11-23. Sizes are GB from the file lists. "Hindi" is **yes** only where the model card names `hi`. No sha256, no full revision hashes, no leaderboard numbers were collected: the installer must pin revision and SHA-256 per file at build time. Licence strings are the card metadata; licence texts were **not** read for Gemma 4, Supertonic OpenRAIL-M, LTX-2.x, qwen-research and flux-non-commercial (UNVERIFIED).

Rule for every row: torch-only repos are fine only as an optional separate process; the voice stack stays torch-free (GGUF through llama.cpp, ONNX through onnxruntime, CTranslate2).

### 16.1 Chat and reasoning LLMs (GGUF)

| id | licence | size / quant (GB) | Hindi | notes |
| --- | --- | --- | --- | --- |
| unsloth/Qwen3.5-0.8B-GGUF | Apache-2.0 | Q4_K_M 0.53, Q8 0.81, mmproj 0.20 | "201 languages", hi not itemised | multimodal |
| unsloth/Qwen3.5-2B-GGUF | Apache-2.0 | Q4_K_M 1.28, Q8 2.01, mmproj 0.67 | same | |
| unsloth/Qwen3.5-4B-GGUF | Apache-2.0 | Q4_K_M 2.74, Q8 4.48 | same | 1.68M downloads |
| unsloth/Qwen3.5-9B-GGUF | Apache-2.0 | Q4_K_M 5.68, Q8 9.53 | same | 2.07M downloads |
| unsloth/Qwen3.5-27B-GGUF | Apache-2.0 | Q4_K_M 16.74 | same | 16 GB class GPU or large RAM |
| unsloth/Qwen3.5-35B-A3B-GGUF | Apache-2.0 | Q4_K_M 22.0, MXFP4 21.6 | same | MoE; too big for 16 GB RAM |
| Qwen3.6-35B-A3B / Qwen3.6-27B | Apache-2.0 | unsloth GGUF MXFP4 21.7, UD-IQ2_M 11.5 | same | **Qwen3.6 exists** (updated 2026-11-07 and 2026-11-20); no official GGUF seen |
| ggml-org/gemma-4-E2B-it-GGUF | Apache-2.0 (card metadata; LICENSE file not read) | Q4_0 2.84, Q8 4.97, mmproj Q8 0.56 | not itemised | any-to-any; real size about 5.1B with per-layer embeddings |
| ggml-org/gemma-4-E4B-it-GGUF | same | Q4_0 4.59, Q8 8.03, mmproj 0.56 | not itemised | ships `mtp-*` draft files (about 0.06) |
| gemma-4-26B-A4B-it | same | ggml-org Q4_0 14.62; unsloth UD-Q4_K_M 16.95 | not itemised | MoE 25.2B |
| gemma-4-31B-it | same | Q4_0 17.99, Q8 32.64 | not itemised | |
| ggml-org/gpt-oss-20b-GGUF | Apache-2.0 | MXFP4 12.11 | English-centred | 20.9B MoE |
| sarvamai/sarvam-30b | Apache-2.0 | 32.2B safetensors; only community GGUF (Q4_K_M 19.58, Q8 34.21) | **yes, 23 languages incl. hi** | no official GGUF; llama.cpp support for its architecture unverified |
| sarvamai/sarvam-105b | Apache-2.0 | 106B | yes | too big locally; API only |
| sarvamai/sarvam-m (24B, Mistral Small base) | Apache-2.0 | community bartowski GGUF | yes (11 Indic languages) | 2025 model |
| sarvamai/sarvam-translate | **GPL-3.0** | 4.3B | yes | translation only; optional download only |
| microsoft/Phi-4-mini-instruct (+ unsloth GGUF) | MIT | Q4_K_M 2.49 | **hi not in its 24 languages** | poor Hindi fit |
| meta-llama/Llama-3.2-3B-Instruct | custom, gated | 3.2B | hi listed | gated: avoid as a default |
| openbmb/MiniCPM5-2B-GGUF | Apache-2.0 | Q4_K_M 1.56 | en and zh only | |

Do not use fine-tunes from unknown authors (several appear in searches).

### 16.2 Vision-language and omni

| id | licence | size / quant (GB) | Hindi | notes |
| --- | --- | --- | --- | --- |
| Qwen/Qwen3-VL-2B / 4B / 8B-Instruct-GGUF | Apache-2.0 | Q4_K_M 1.11 / 2.5 / 5.03; mmproj Q8 0.45 (8B mmproj F16 1.16) | unverified | official GGUF, 2.45M downloads for 8B |
| Gemma 4 E2B / E4B / 26B / 31B | Apache-2.0 | mmproj Q8 0.56 / 0.56 / 0.81 / 0.81 | unverified | E2B and E4B any-to-any (audio input) |
| Qwen3.5 (all sizes) | Apache-2.0 | mmproj 0.2 to 0.93 | "201 languages" | natively multimodal, replaces Qwen3-VL |
| ggml-org/SmolVLM2-2.2B / 500M-Video | Apache-2.0 | Q4_K_M 1.11 + mmproj 0.59 / Q8 0.44 + 0.11 | English-centred | 500M handles video, tiny |
| openbmb/MiniCPM-V-4.7-1B-gguf | Apache-2.0 | Q4_K_M 0.67 | unverified | |
| openbmb/MiniCPM-o-4_5-gguf | Apache-2.0 | Q4_K_M 5.03, Q8 8.71 | English and Chinese speech only | whether llama.cpp runs its audio path is unverified |
| ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF | licence not read | 30B MoE | unverified | too big for most PCs |

### 16.3 Speech recognition (CTranslate2 and ONNX)

| id | licence | size | formats | Hindi | notes |
| --- | --- | --- | --- | --- | --- |
| Systran/faster-whisper-large-v3 | MIT | 3.09 | CT2 | yes | |
| deepdml/faster-whisper-large-v3-turbo-ct2 | MIT | 1.62 | CT2 | yes | community conversion (2026-02); no first-party turbo CT2 repo was seen |
| Systran/faster-whisper-small / medium | MIT | 0.48 / 1.53 | CT2 | yes | |
| Systran/faster-distil-whisper-large-v3 | MIT | 1.51 | CT2 | **English only** | reject for Hindi |
| ai4bharat/indic-conformer-600m-multilingual | MIT | not listed | ONNX | yes (22 Indic) | **gated (auto)**; 212k downloads |
| OpenVoiceOS/ai4bharat-indicconformer-hi-onnx | MIT | int8 0.14 + data 0.48 | ONNX | Hindi only | community, 825 downloads; good size to test |
| Hindi/Hinglish Whisper fine-tunes (vasista22 small/large CT2, bjollans vaani, savi0ur, MSpider3) | mostly Apache-2.0; one has no licence | 0.48 to 3.09 | CT2 | hi / Hinglish | all tiny community repos; **no WER read**; evaluate on FRIDAY's own set before any use |
| moonshine (onnx-community/moonshine-base-ONNX, streaming tiny/small/medium) | MIT | 0.07 to 0.56 | ONNX / safetensors | **English only** | optional English streaming partials |

### 16.4 Speech generation (TTS)

| id | licence | size | formats | Hindi | notes |
| --- | --- | --- | --- | --- | --- |
| Supertone/supertonic-3 | weights **OpenRAIL-M**, sample code MIT | ONNX total 0.41 | ONNX | **yes, 31 languages incl. hi** | already FRIDAY's voice; owner reads the RAIL use restrictions |
| onnx-community/chatterbox-multilingual-ONNX | MIT | q4 language model 0.35, fp16 1.04; decoder 0.53; speech encoder 0.59 | **ONNX** | yes (23 languages incl. hi) | 3.9k downloads; voice cloning included; **a torch-free route to Chatterbox exists** |
| BricksDisplay/Chatterbox-Multilingual-TTS-GGUF | MIT | q4_k_m 0.30 + codec 0.19 | GGUF | yes | community conversion |
| ResembleAI/chatterbox | MIT | 2.14 + 1.06 | torch only | yes | official; use the ONNX/GGUF conversions instead |
| onnx-community/Kokoro-82M-v1.0-ONNX | Apache-2.0 | 0.09 to 0.33 | ONNX | **English only** per card | project rules forbid the kokoro-onnx pip package; the ONNX weights themselves are not that package |
| kenpath/svara-tts-v1 | Apache-2.0 | 13.2 (3.3B) | safetensors; community GGUF | yes (19 Indic languages) | Orpheus-style; needs an SNAC codec: unverified |
| ai4bharat/IndicF5, ai4bharat/indic-parler-tts | MIT / Apache-2.0 | 1.4 / 3.75 | torch | yes | both **gated** and torch-only: reject |
| kyutai/pocket-tts | CC-BY-4.0 | 0.22 | safetensors; GGUF/LiteRT community | **no Hindi** (en/fr/de/pt/it/es) | |

### 16.5 Embeddings and rerankers

| id | licence | size | formats | notes |
| --- | --- | --- | --- | --- |
| BAAI/bge-m3 | MIT | 2.27 fp32; GGUF Q8 0.63, Q4_K_M 0.44 | ONNX in repo, GGUF | already FRIDAY's embed model; multilingual |
| Qwen/Qwen3-Embedding-0.6B (+GGUF Q8 0.64) | Apache-2.0 | 0.60B | GGUF, safetensors | candidate; Hindi not read on the card |
| google/embeddinggemma-2 (+ GGUF Q8 0.31, ONNX) | Apache-2.0 | 0.74B | GGUF, ONNX | multilingual tag |
| Qwen/Qwen3-Reranker-0.6B (+ GGUF Q8 0.64) | Apache-2.0 | | GGUF | reranker candidate |
| BAAI/bge-reranker-v2-m3 + ONNX | tag missing (upstream Apache-2.0, unverified) | int8 0.57 | ONNX | |
| jina embeddings v3 / v5 | **CC-BY-NC-4.0** | | | non-commercial: reject |

### 16.6 Image generation

| id | licence | size / quant | formats | notes |
| --- | --- | --- | --- | --- |
| unsloth/FLUX.2-klein-4B-GGUF | Apache-2.0 (4B) | Q4_K_M 2.60, Q8 4.30 | GGUF | text encoder is extra (about 8 GB safetensors) |
| unsloth/FLUX.2-klein-9B-GGUF | **flux-non-commercial** | Q4_K_M 5.67 | GGUF | non-commercial |
| unsloth/Z-Image-Turbo-GGUF | Apache-2.0 | 6.15B; Q4_K_M 3.85, Q8 7.22 | GGUF | 1.09M downloads; best licence and size mix; Qwen text encoder separate |
| city96/FLUX.1-schnell-gguf | Apache-2.0 | Q4_0 6.77, Q8 12.69 | GGUF | official BFL repo is gated |
| unsloth/Qwen-Image-2.1-Turbo-GGUF | **qwen-research (custom)** | Q4_K_M 4.2 | GGUF | non-standard licence, en/zh only |
| stabilityai/sdxl-turbo | **sai-nc-community** | fp16 6.94 | safetensors, ONNX | non-commercial |
| stabilityai/stable-diffusion-3.5-medium | **stabilityai-ai-community, gated** | 5.11 | safetensors, GGUF | custom licence |

### 16.7 Video, music and tiny helpers

| id | licence | size / quant | formats | notes |
| --- | --- | --- | --- | --- |
| QuantStack/Wan2.2-TI2V-5B-GGUF | Apache-2.0 | Q4_K_M 3.43, Q8 5.40; VAE 1.41 | GGUF | umt5-xxl text encoder another 11 GB (bf16) |
| unsloth/LTX-2.3-GGUF, Lightricks/LTX-2.5 | **ltx-2 community licence** | 22B; distilled Q4_K_M 14.19 | GGUF / safetensors | revenue conditions; too big for most PCs |
| Serveurperso/ACE-Step-1.5-GGUF | MIT (repo tag) | base Q4_K_M 1.45; LM 0.6B Q8 0.71 | GGUF | lyrics languages: no Hindi |
| ACE-Step/Ace-Step1.5 | MIT | turbo 4.79 | torch | official |
| stabilityai/stable-audio-open-1.0 | **stable-audio-community, gated** | 4.85 | torch | custom licence |
| facebook/musicgen-small | **CC-BY-NC-4.0** | 2.36 | torch | non-commercial |
| ggml-org/functiongemma-270m-it-GGUF | **Gemma custom** | 0.29 | GGUF, ONNX | tiny tool router; needs the `developer` role |
| pipecat-ai/smart-turn-v3 | BSD-2-Clause | v3.2 CPU/GPU ONNX | ONNX | README language list not seen in the grep; Hindi unverified on the card |
| facebook/fasttext-language-identification | **CC-BY-NC-4.0** | 1.18 | fastText | non-commercial; owner decides for private use |
| istupakov/silero-vad-onnx | MIT | | ONNX | ONNX weights only, not the forbidden pip package |

Summary (HF pass): best torch-free fits found today are Qwen3.5-4B/9B and Gemma 4 E4B for chat and vision, Qwen3-VL GGUF for vision, Supertonic-3 ONNX and the Chatterbox-Multilingual ONNX/GGUF conversions for Hindi TTS, Systran or deepdml CT2 for Whisper, IndicConformer ONNX for Hindi ASR, bge-m3 and Qwen3-Embedding for retrieval, Z-Image-Turbo and FLUX.2-klein-4B for images, Wan2.2-TI2V-5B for video, ACE-Step GGUF for music. Rejected on licence: jina embeddings, FLUX.2-klein-9B, sdxl-turbo, MusicGen, fastText LID (all non-commercial) and sarvam-translate (GPL, optional download only). Rejected on runtime: IndicF5, indic-parler-tts (gated, torch-only).

## 17. Research appendix C (2026-11-23): cloud lane facts

All from official pages fetched 2026-11-23 unless marked. Privacy and billing firewalls apply: the free lanes of several providers train on data and are therefore **NON-SENSITIVE only**.

| Provider | Free / pricing facts | Hindi / Hinglish | Protocol | Data policy |
| --- | --- | --- | --- | --- |
| Google Gemini ([pricing](https://aistudio.google.com/docs/pricing)) | Text, Live, Transcribe and Flash TTS listed free of charge; image and video models no free tier; USD per 1M tokens for 3.8 Flash input 0.75 / output 3.75, 3.5 Flash-Lite 0.30 / 2.50; Transcribe 0.003 per minute; several prices change 2026-12-01 and 2027-01-01 | Live API: `hi` among 99 languages; Hinglish not named | `BidiGenerateContent` bidirectional session; 15 minute audio sessions, 2 minutes with video; context 32k, 128k native audio | **Unpaid: used to improve products, human reviewers may read it. Paid: not used to improve products**, logged for a limited time for abuse and legal checks; grounding results stored 30 days |
| Sarvam ([pricing](https://www.sarvam.ai/api-pricing)) | INR 100 free credit, no expiry; STT real-time INR 0.49 per minute; TTS Bulbul v3 INR 3.00 per 1,000 characters; LLM Sarvam 105B INR 10 in / 25 out per 1M | STT `saaras-v4`: Hindi plus a **codemix** output mode (23 languages); TTS `bulbul-v3` (11 languages incl. Hindi), `bulbul-v4-flash` lists English-Hindi; LLM `sarvam-105b` | WebSocket for STT and TTS (20 / 60 concurrent on pay-as-you-go) | not read: unverified |
| ElevenLabs ([pricing](https://elevenlabs.io/pricing/api)) | Scribe v2 about USD 0.20 per hour (page inconsistent); Flash/Turbo TTS USD 0.04 per 1,000 characters; no free credit stated | TTS: Hindi on every listed model (`eleven_v4`, `v4_turbo` about 100 ms, `v3_conversational` about 165 ms, `flash_v2_5` about 100 ms); STT `scribe_v3`, `scribe_v3_live`, `scribe_v2_realtime` about 150 ms: "90+ languages", Hindi not itemised | WebSocket for realtime STT and TTS | data page returned 403: unverified |
| Deepgram | USD 200 non-expiring credit, no card; Nova-3 streaming USD 0.0048 per minute; Aura-2 TTS USD 0.030 per 1,000 characters | Hindi `hi` in nova-3, nova-2, `flux-general-multi`; code-switching via the multi option | streaming WebSocket | training opt-out by `mip_opt_out=true` per request; default appears included; retention not stated |
| Groq | Developer-plan base limits only on the public page (whisper 20 RPM / 2K RPD; gpt-oss 30 RPM / 1K RPD / 8K TPM / 200K TPD); free-plan limits not public | LLM/STT language pages not fetched | | data page 404: unverified |
| OpenRouter | `:free` models 20 requests per minute; 50 per day under 10 credits, 1000 per day with at least 10 | | OpenAI-compatible (memory) | not read |
| Cerebras | USD 5 one-time credit, card needed, 30 days | | | |
| AssemblyAI | USD 50 free credit; free tier capped at 5 new streams per minute; streaming USD 0.30 per hour | streaming Hindi `hi` yes; code-switching on by default (`language_codes ["en","hi"]`) | WebSocket | not read |
| Azure Speech | F0 free: 5 hours per month real-time STT, 0.5M neural TTS characters per month | hi-IN real-time STT yes; Hindi TTS Swara and Madhur Neural plus 4 HD voices | Speech SDK / WebSocket | not read |
| Cartesia | Free 20K credits per month; Pro USD 5 | Sonic 3.6 TTS: Hindi yes, better Latin-script Hindi (Hinglish) and Indian names; Ink STT Hindi unverified | WebSocket not confirmed | not read |
| Google Cloud STT/TTS | pages did not render | Chirp 3 STT lists hi-IN (streaming unverified); Chirp 3 HD TTS hi-IN yes, streaming synthesis yes | gRPC/REST | not read |
| AWS Transcribe / Polly | Transcribe 60 minutes free for 12 months, streaming USD 0.01 per minute; Polly neural USD 16 per 1M characters (1M free per month for 12 months) | Transcribe hi-IN streaming yes; Polly hi-IN in language list | HTTP/2 and WebSocket / SDK | not read |
| Alibaba Model Studio | Singapore example qwen3.7-flash USD 0.03 in / 0.13 out per 1M; free quota mostly 1M tokens for 90 days, Singapore only | speech not verified | chat is OpenAI-compatible (workspace-bound endpoint); Qwen-Audio needs the DashScope protocol | not read |
| Together | no free tier; STT USD 0.0015 per minute; TTS Kokoro USD 4 per 1M characters | Hindi not stated | | not read |


Provider set A (official pages, fetched 2026-11-23; the fetch tool summarises pages with a small model, so re-check key figures on the page before they go into code):

| Provider | Prices (USD per 1M tokens unless noted) | Free tier | Hindi | Realtime | Trains on API data by default |
| --- | --- | --- | --- | --- | --- |
| OpenAI | gpt-6.2-sol 2 / 10; gpt-6-luna 0.10 / 0.50; gpt-5-nano 0.05 / 0.40; gpt-realtime-2 audio 32 in / 64 out; GPT-Live 0.05 per active minute; STT 0.0045 to 0.017 per minute; tts-1 15 per 1M characters; gpt-image-2 30 per image output | none on the API pages | not stated: unverified | Realtime API and GPT-Live; transport not read | No (since 2023-03-01); abuse logs up to 30 days; zero data retention on approval; **OpenAI-compatible: native** |
| Anthropic | Sonnet 5.5 2 / 10; Haiku 5.5 0.10 / 0.50 (up to 100k prompt); Opus 5.5 4 / 20 | free credits to test, amount not stated | unverified | no voice API found | No (commercial products excluded); feedback chats kept up to 5 years |
| xAI | Grok 4.7 2 / 6; speech-to-speech 0.08 per minute; STT 0.10 per hour REST, 0.20 per hour streaming; TTS 15 per 1M characters | not stated | **Hindi named**; STT 38+ languages | WebSocket events, ephemeral tokens, described as Realtime-compatible | unverified (zero data retention: audio never stored or used for training) |
| Mistral | Large 0.5 / 1.5; Voxtral prices not on the page | Free plan capped | Voxtral TTS 3: 35+ languages, Hindi not named | Voxtral Mini Transcribe Realtime 3 with turn detection; TTS streaming | unverified |
| DeepSeek | deepseek-flash 0.15 / 0.60 off-peak, 0.30 / 1.20 peak (peak 01:00-04:00 and 06:00-10:00 UTC weekdays); v4-pro 0.66 / 1.98 off-peak | none stated | unverified, text only | no voice found | unverified; **OpenAI-compatible: yes** (`api.deepseek.com`) |

Deprecations to design around (official pages): OpenAI Sora Videos API shut down 2026-09-24; gpt-image-1 ended 2026-10-23, gpt-image-1-mini and 1.5 end 2026-12-01; gpt-5, mini, nano, o3 end 2026-12-11; gpt-4o and 4.1 end 2027-01-14; tts-1 family ends 2027-01-06; old Realtime and audio models end 2027-01-20; whisper-1 and gpt-4o-transcribe end 2027-02-26 (replacements gpt-realtime-2.1, gpt-transcribe). Anthropic models from 4.7 on use a tokenizer with about 30% more tokens, so effective cost rises at the same price. **Lesson: keep model ids in a registry with a refresh date; cloud model ids retire within months.** No official page read states a free API model for OpenAI, Anthropic, Mistral or DeepSeek, so none of them is free-proven for the billing firewall.

Implications for FRIDAY's router and firewalls:
- **Free-proven by an official page:** Gemini text, Live, Transcribe and Flash TTS; Azure F0; Cartesia free; AssemblyAI and AWS trials are credit or time limited, not permanently free. Key the free proof on the **model id with a refresh date** (the daily refresh design already does this): prices and models change on 2026-12-01 and 2027-01-01.
- **Unknown-cost, hidden until paid access is on:** every image, video, music model and ElevenLabs; Groq and OpenRouter `:free` need a per-model free flag.
- **Privacy:** the Gemini free lane trains on data and human reviewers may read it, so it is for NON-SENSITIVE turns only; sensitive turns stay local or use a paid no-training tier (terms for most providers unread: UNVERIFIED).
- **Hindi/Hinglish:** only Sarvam (codemix STT, English-Hindi TTS) and Cartesia (Latin-script Hindi TTS) name code-mixed handling; AssemblyAI streams Hindi with code-switching. Nobody published a Hinglish benchmark: measure on FRIDAY's own set.
- Still unread: OpenAI, Anthropic, xAI, Mistral and DeepSeek terms (provider set A pending), Groq/ElevenLabs/Sarvam data terms, Gemini Live latency.


## 17A. Research appendix D (2026-11-23): never hang, detect everything, deliver drivers and libraries

Evidence labels as before. (M) = from memory, unverified. Official pages read: Electron docs (BrowserWindow, app, powerMonitor, utilityProcess), Microsoft Learn (TDR, NLM connection cost), NVIDIA CUDA release notes and EULA, the cuDNN support matrix, llama.cpp build.md, PyPI JSON for the NVIDIA, onnxruntime and ctranslate2 packages. GitHub release asset lists could not be read (blocked in the research sandbox): asset names below are patterns to be confirmed on the owner's PC.

### Responsiveness rules (Electron)

| Item | Finding | Decision |
| --- | --- | --- |
| `BrowserWindow` `unresponsive` / `responsive` | events exist | ADOPT: never let the native "Not responding" stand: after about 5 s offer reload, log the last IPC call |
| `render-process-gone`, `child-process-gone` (GPU, crashed or oom) | events exist; `app.disableHardwareAcceleration()` only before ready | ADOPT: reload with backoff and a crash-loop cap; after a GPU process crash write a flag and relaunch with acceleration off |
| `app.getGPUInfo('basic')` | rejects if the GPU is fully disabled | ADOPT with a timeout |
| `app.getAppMetrics()` | CPU averaged since the previous call | ADOPT one poller at 5 to 10 s |
| `utilityProcess.fork` | crash-isolated Node child through Chromium Services | ADOPT for heavy JS work; `worker_threads` REJECT for native or GPU work; `child_process` only for the Python kernel |
| main process | no sync fs or `sendSync`; `ipcMain.handle` with timeouts (M); `monitorEventLoopDelay` p99 above about 200 ms means degrade background work (M) | ADOPT |
| `powerMonitor` on Windows | suspend, resume, lock-screen, on-battery, speed-limit-change work; thermal state is macOS-only | ADOPT: pause mic and GPU work on suspend and lock, re-probe on resume, use speed-limit-change as the throttle hint |
| `backgroundThrottling` | default true | disable only for the Auto-mode audio window |

### GPU sharing and Windows TDR

Windows resets the GPU if a task cannot be pre-empted within about 2 seconds (default TDR timeout), purging VRAM and flashing "Display driver stopped responding"; five hangs within a minute bug-check (Microsoft Learn, updated 2025-11). Consequences for FRIDAY: keep each GPU submission short (token steps are fine; very large prompt batches, large `-ub`, big diffusion steps on weak GPUs are the risk); compute `-ngl` from **free** VRAM and keep about 1 to 1.5 GB for the desktop compositor, the browser and the KV cache; treat an iGPU or under 4 GB free as CPU; never rely on spill to shared memory (the NVIDIA "System Memory Fallback" setting replaces unified memory on Windows); `--device none` is llama.cpp's full GPU-off switch (`-ngl 0` can still touch the GPU); after two TDR or device-lost events mark the GPU unsafe and persist CPU-only until the owner re-enables it. Process priority, flash attention on Pascal/Turing and ONNX Runtime CUDA stream limits were not found on primary pages: UNVERIFIED.

### CUDA facts

Driver minimums: CUDA 12.0 needs 527.41 or newer, 12.4 needs 551.61, 12.6 needs 560.76, 12.8 needs 570.65, 12.9 U1 needs 576.57; 12.x minor-version compatibility works on drivers 525 up to below 580; CUDA 13 needs 580 or newer. cuDNN 9.28 supports compute capability 7.5 (Turing) and newer only. Pip wheel layout (M): `site-packages\nvidia\cublas\bin\cublas64_12.dll`, `nvidia\cudnn\bin\cudnn64_9.dll`, loaded through `os.add_dll_directory`.

### Delivery rules (licences and sizes)

- NVIDIA EULA attachment A lists cudart, cuBLAS and cuBLASLt as redistributable under conditions (substantial functionality added, only the app accesses the DLLs, NVIDIA GPUs only, no standalone distribution). cuDNN is **not** listed: UNVERIFIED, so fetch it on demand from the official pip wheel with a pinned SHA-256 and never put it in the EXE.
- PyPI (read live): newest Windows `nvidia-cublas-cu12` wheel 12.9.2.10 (553 MB; later releases are Linux-only), `nvidia-cudnn-cu12` 9.28.1.4 (696 MB), `nvidia-cuda-runtime-cu12` 12.9.79 (3.6 MB), all NVIDIA proprietary. `faster-whisper` 1.2.1 needs `ctranslate2>=4.0,<5`; latest `ctranslate2` 4.9.1 (MIT) has win_amd64 wheels for Python 3.9 to 3.15. `onnxruntime` 1.32.0 (MIT, 16.7 MB), `onnxruntime-directml` 1.24.4 (25 MB), `onnxruntime-gpu` 1.32.0 (158 MB; CUDA major version and cuDNN 9 on PATH UNVERIFIED) for Python 3.11 to 3.14; **never install the three onnxruntime variants together** (one shared module).
- Pick by facts: any GPU with DirectML gives `onnxruntime-directml` for ONNX voice models; NVIDIA with the CUDA/cuDNN pair gives `-gpu`; otherwise the CPU wheel. CTranslate2 has no DirectML or Vulkan path: CPU, or CUDA when the two DLLs are present.
- llama.cpp Windows asset patterns (M): `llama-b<N>-bin-win-cpu-x64.zip`, `-win-cpu-arm64.zip`, `-win-vulkan-x64.zip`, `-win-cuda-12.4-x64.zip` plus `cudart-llama-bin-win-cuda-12.4-x64.zip` (CUDA 12.4 implies driver 551.61 or newer; a CUDA 13 variant may exist), HIP and SYCL zips opt-in; older releases had separate avx2/avx512/avx/noavx zips (match them as optional). The GitHub API `digest` field (`sha256:...`) is expected on each asset: read it at install time from the official release API, verify the download against it, and pin the accepted digest in the catalogue. Selection: NVIDIA compute capability 7.5 or newer with a driver at or above the zip's minimum and at least 4 GB free VRAM gives CUDA 12; else any non-software Vulkan device gives Vulkan; else CPU. If the chosen build fails its 3 s health check, fall back one step (CUDA, then Vulkan, then CPU) and record why. Run the engine as a child process with a watchdog.
- stable-diffusion.cpp (MIT; latest tag seen `master-1117-0d71f96`, 22 Nov): optional on-demand; asset names (M) `sd-master-<hash>-bin-win-{avx2,avx,avx512,noavx,vulkan,cuda12}-x64.zip` plus a cudart zip; same selection logic.
- FFmpeg runs as a separate downloaded process, never linked or bundled: gyan.dev publishes `.sha256` files and its static builds are GPLv3 (the "tools" package LGPLv3); BtbN publishes lgpl and gpl zips (M): prefer the LGPL shared build.
- Detection keys (M, read-only): VC++ 2015 to 2022 x64 at `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` (`Installed=1`, `Version`); WebView2 `pv` under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` or the `HKCU` equivalent (missing or `0.0.0.0` means absent; Electron itself does not need it); metered connection through `INetworkListManager` and `INetworkConnectionCost::GetCost` (FIXED, VARIABLE and the limit or roaming flags count as metered); online confirmed by a tiny request, not `net.isOnline` alone; power plan `powercfg /getactivescheme`; Vulkan through `llama.cpp --list-devices` (simplest) or `vulkan-1.dll` and the Khronos registry key.
- `systeminformation` (npm, MIT, pure JS) reads CPU flags, memory, graphics, OS and disks by shelling out to PowerShell/CIM/nvidia-smi (about 0.5 to 3 s, can come back empty, VRAM often wrong because WMI `AdapterRAM` is 32-bit): ADOPT only for CPU flags and GPU vendor, never on the UI path. `nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,compute_cap` first; `nvidia-ml-py` (BSD) optional.
- Not yet verified: any llama.cpp or stable-diffusion.cpp release tag, size and digest; Turing support in the CUDA build; the cuDNN redistribution terms; registry keys on a current Windows 11 build.

## 18. Sources used in this round (access date 2026-11-23)

Models and tools: [Gemma 4 (Google)](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/), [Gemma 4 Apache 2.0](https://thenextweb.com/news/google-gemma-4-open-models-apache-2-launch), [gpt-oss](https://openai.com/index/introducing-gpt-oss/), [Sarvam 30B and 105B](https://www.sarvam.ai/blogs/sarvam-30b-105b), [Sarvam-30B card](https://huggingface.co/sarvamai/sarvam-30b), [Sarvam-M listing](https://aikosh.indiaai.gov.in/home/models/details/sarvamm.html), [Sarvam licence report](https://www.opensourceforu.com/2026/03/sarvam-releases-30b-and-105b-llms-under-apache-2-0/), [Qwen3-VL report](https://arxiv.org/abs/2511.21631), [Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni), [ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5), [ACE-Step 1.5 paper](https://arxiv.org/abs/2602.00744), [FastSD CPU](https://github.com/rupeshs/fastsdcpu), [FLUX schnell ONNX](https://huggingface.co/TensorStack/Flux_schnell-f32-onnx), [image licences](https://localaimaster.com/blog/local-image-model-licenses-commercial-use), [local image generation 2026](https://www.digitalapplied.com/blog/local-image-generation-flux-stable-diffusion-comfyui-2026), [video model comparison](https://www.aimagicx.com/blog/open-source-ai-video-models-comparison-2026), [LTX vs Wan](https://magichour.ai/blog/ltx-2-3-vs-wan-2-2), [local coding models](https://www.how2shout.com/?p=88605), [coding LLMs June 2026](https://dev.to/zyvop/the-best-open-source-llms-for-coding-right-now-june-2026-n10), [CPU LLM tests](https://itsfoss.com/testing-local-llms-without-gpu), [VLM roundup](https://www.labellerr.com/blog/top-open-source-vision-language-models/), [Roboflow local VLMs](https://blog.roboflow.com/local-vision-language-models/), [IndicF5 card](https://huggingface.co/AbhishekDelMundu/IndicF5), [Moonshine](https://github.com/moonshine-ai/moonshine), [Parakeet v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [IndicConformer-600M](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual).

Agents and protocols: [OpenJarvis](https://openjarvis.stanford.edu/), [Personal Jarvis](https://pypi.org/project/personal-jarvis/), [vierisid/jarvis](https://github.com/vierisid/jarvis), [OpenClaw architecture](https://dev.to/ialijr/lessons-from-openclaws-architecture-for-agent-builders-1j93), [Agent S README](https://raw.githubusercontent.com/simular-ai/Agent-S/main/README.md), [OSWorld listing](https://www.codesota.com/benchmark/osworld), [GUI-Owl-1.5 paper](https://arxiv.org/pdf/2602.16855), [Playwright MCP](https://www.morphllm.com/playwright-mcp), [browser agents compared](https://dev.to/agdex_ai/ai-native-browser-automation-in-2026-browser-use-stagehand-steel-and-playwright-mcp-compared-160n), [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md), [AAIF MCP 2026](https://aaif.io/blog/mcp-2026-changes-the-rules), [memory frameworks compared](https://dev.to/agdex_ai/ai-agent-memory-in-2026-mem0-vs-zep-vs-letta-vs-cognee-a-practical-guide-cfa).

Runtimes and speed: [Windows AI comparison](https://learn.microsoft.com/windows/ai/windows-ai-comparison), [Foundry Local architecture](https://learn.microsoft.com/en-ie/Azure/foundry-local/concepts/foundry-local-architecture), [Windows ML and llama.cpp](https://devblogs.microsoft.com/foundry-on-windows/build-on-winml-oct-7-26/), [speculative decoding and caching](https://dev.to/ianlpaterson/three-months-of-speed-up-experiments-on-a-3090-ti-autoregressive-dflash-mtp-for-qwen36-27b-59ef), [speculative decoding guide](https://dev.to/rosgluk/speculative-decoding-20-50-faster-llm-inference-g11), [QVAC LoRA in llama.cpp](https://huggingface.co/blog/qvac/fabric-llm-finetune), [QLoRA and Unsloth guide](https://dev.to/pockit_tools/fine-tuning-open-source-llms-with-qlora-and-unsloth-the-complete-2026-guide-2ome), [consumer fine-tuning guide](https://insiderllm.com/guides/fine-tuning-local-lora-qlora/).

2026-11-23 second pass (owner's RTX 2060 PC): [RTX 2060 local LLM guide](https://ailocalcheck.com/hardware/rtx-2060-6gb), [2060 Max-Q hands-on](https://note.com/k_co1632/n/n7b94a53dca81?hl=en), [8 GB GPU LLM guide](https://www.sitepoint.com/optimizing-local-llms-low-end-hardware-8gb/), [faster-whisper README](https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md), [CTranslate2 CUDA issue](https://github.com/OpenNMT/CTranslate2/issues/1806), [llama.cpp MoE offload guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide), [n-cpu-moe 6 GB report](https://jeanfbrito.github.io/posts/running-qwen3.6-35b-moe-rtx3060-ncmoe/), [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B), [Qwen3.5 small models](https://rits.shanghai.nyu.edu/ai/qwen-3-5-small-models-9b-parameters-that-beat-120b/), [Gemma 4 E4B Jetson page](https://www.jetson-ai-lab.com/models/gemma4-e4b), [Gemma 4 QAT](https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/), [FLUX low VRAM](https://localaimaster.com/blog/run-flux-on-low-vram-gpu), [ComfyUI GGUF](https://convly.ai/comfyui-gguf-setup/), [ComfyUI Wan 2.2](https://docs.comfy.org/tutorials/video/wan/wan2_2.md), [Wan 2.2 5B GGUF](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF), [LTX-2.5 distilled GGUF](https://huggingface.co/chfm/LTX-2.5-Distilled-GGUF), [ACE-Step install](https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/HEAD/docs/en/INSTALL.md), [ACE-Step GPU guide](https://raw.githubusercontent.com/ace-step/ACE-Step-1.5/HEAD/docs/en/GPU_COMPATIBILITY.md), [Chatterbox card](https://huggingface.co/ResembleAI/chatterbox/blob/main/README.md), [Chatterbox Multilingual](https://resemble.ai/introducing-chatterbox-multilingual-open-source-tts-for-23-languages), [Kyutai Pocket TTS](https://kyutai.org/blog/2026-05-04-pocket-tts-multilingual/), [MiniCPM-o 4.5](https://huggingface.co/openbmb/minicpm-o-4_5), [Vistaar](https://arxiv.org/pdf/2305.15386), [Vaani Hindi benchmark](https://arxiv.org/pdf/2606.21408), [voice agent framework comparison](https://www.forasoft.com/blog/article/pipecat-vs-livekit-agents), [Pipecat guide](https://aiworkflowlab.dev/article/build-production-voice-ai-agents-pipecat-python-latency-barge-in), [voice agent latency study](https://pith.science/paper/2611.19118), [tool-calling in small models](https://www.ertas.ai/blog/on-device-tool-calling-2026-qwen3-gemma4-phi4), [FunctionGemma](https://blog.google/innovation-and-ai/technology/developers-tools/functiongemma/), [NVIDIA CUDA distribution](https://www.hpcwire.com/aiwire/2025/09/12/nvidia-enables-direct-cuda-distribution-via-popular-developer-platforms/), [CUDA EULA](https://docs.nvidia.com/cuda/archive/12.9.0/pdf/EULA.pdf).

Providers: [ElevenLabs latency methodology](https://elevenlabs.io/docs/eleven-api/concepts/latency-methodology), [Scribe v2 Realtime](https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents), [voice agent latency](https://elevenlabs.io/blog/voice-agent-latency-optimization); OpenAI Realtime and Gemini Live pages from the earlier voice research round (2026-11-23) in `docs/FRIDAY_VOICE_ENGINE.md`.

Earlier voice decisions and measured leads are in `docs/FRIDAY_VOICE_ENGINE.md`; live state in `FRIDAY_STATE.md`.
