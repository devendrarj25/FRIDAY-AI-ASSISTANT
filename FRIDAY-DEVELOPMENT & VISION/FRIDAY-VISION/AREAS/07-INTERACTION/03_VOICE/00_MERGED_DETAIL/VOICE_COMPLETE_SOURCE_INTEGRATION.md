# Voice — Complete Detailed Architecture Integration

This is an integrated preservation of the detailed source architecture from the supplied package. The content is merged into the unified FRIDAY interaction architecture; it is not a separate runtime or competing source of truth.

## Integration rule

- Preserve every requirement and behavioral rule below.
- Resolve ownership through the current FRIDAY Brain/System/Capability/Task/Governance owners.
- If a source document names a component that conflicts with current ownership, treat the named component as a responsibility, not permission to create a duplicate subsystem.

## Integrated source documents


---

# SOURCE: `00_START/00_READ_FIRST.md`


# FRIDAY Voice Mode — Complete Deep Upgrade V3

## Purpose
This package is the implementation contract for upgrading FRIDAY's existing Windows voice mode into a real-time, interruption-safe, locally capable, provider-flexible voice system without replacing working FRIDAY architecture.

This is **not** a toy roadmap and not a generic voice-assistant essay. An implementation AI should be able to inspect the repository, map each contract to the existing owners, implement the minimum required changes, integrate with existing registries/governance/task/event systems, install runtime dependencies through the existing installer manager, and prove the resulting voice path works.

## Non-negotiable FRIDAY rules
- Preserve UI/design unless explicitly requested.
- Preserve all working features.
- Reuse existing capability registry, governance gate, task runtime, event/notification system, device layer, screen/camera systems and installer manager.
- Do not create a second capability registry, scheduler, governance system, notification bus, or parallel voice architecture.
- Windows-first remains the current target.
- Do not modify build/release/installer/CI workflow files unless implementation proves a required change is unavoidable.
- Do not bundle a model/runtime merely because it is popular. License, redistribution rights, architecture fit, Windows support and verified runtime health are mandatory.
- Never report a provider as healthy/installed/connected without a real probe.
- No raw microphone recording is retained by default.
- Camera/screen observation is explicit, visible and governed.
- Destructive/system actions continue through FRIDAY's existing approval/governance gate.
- No new UI redesign is part of this package.

## Source reality this package was designed against
The audited repository already contains the following owners: `src/lib/friday/voice-library.ts`, `voice-stt.ts`, `voice-audio.ts`, `voice-state.ts`, `wake-engine.ts`, `wake-word.ts`, `electron/neural-voice.cjs`, `electron/stt.cjs`, `electron/wake-engine.cjs`, `kernel/stt.py`, `kernel/wake_word.py`, `src/lib/friday/installer-engine.ts`, `src/lib/friday/catalog.ts`, `VoiceSettings.tsx`, and `ChatDock.tsx`. The implementation must extend these owners rather than create duplicate replacements.

## What this package adds over a shallow plan
1. Full media-plane design: capture, resampling, AEC/NS/AGC, VAD, wake, streaming ASR, partial/final transcript, response streaming, incremental TTS, playback, barge-in and cancellation.
2. Provider matrix covering local and cloud fallback candidates.
3. Exact runtime/install-manager contract: artifact manifest, dependency graph, download/verify/extract/install/health/rollback/repair lifecycle.
4. Model manifest rules, license gates and no-binary-in-repository policy.
5. Shared chat/voice modality parity contract.
6. Home/device/camera/screen/event integration contract.
7. Multidisplay and rich presentation contract.
8. Exact file-by-file implementation map tied to current FRIDAY owners.
9. Machine-readable JSON contracts for sessions, audio chunks, providers, installer artifacts, events, capabilities and diagnostics.
10. Acceptance, performance, fault-injection and regression scenarios.
11. SVG diagrams plus ASCII flow charts in Markdown. No text-based diagram formats dependency.
12. An implementation master prompt that tells an AI exactly how to execute the work without deleting or duplicating FRIDAY.

## Important implementation principle
Voice is a **modality over FRIDAY's existing brain**, not a second brain. Voice input must enter the same canonical request path as chat. Voice output must render the same canonical result/artifact/task/event model as chat, with speech added as a delivery channel.

```text
Audio device -> Capture -> Frame clock -> AEC/NS/AGC -> VAD
                                      |
Wake detector <-----------------------+----> Streaming STT -> partial/final transcript
                                                        |
                                                        v
                                            Canonical FRIDAY request
                                                        |
                                         existing router/brain/governance
                                                        |
                                  canonical result/task/event/artifact stream
                                      |                       |
                                      v                       v
                              Speech planner             UI/display/artifacts
                                      |
                              Streaming TTS
                                      |
                                Audio playback
                                      ^
                                      |
                              barge-in / cancel
```


---

# SOURCE: `00_START/01_SCOPE_AND_DEFINITION_OF_DONE.md`


# Scope and Definition of Done

## In scope
- Real-time voice session lifecycle.
- Continuous microphone stream with bounded buffers.
- Full-duplex playback/capture coordination.
- Barge-in and generation cancellation.
- VAD, wake word and push-to-talk coexistence.
- Streaming ASR with partial results.
- Incremental response speech.
- Local-first STT/TTS/VAD/wake pipeline with verified fallback providers.
- Hinglish and Hindi/English language policy.
- Shared capability/task/event/device routing.
- Screen/camera awareness and notification delivery.
- Rich visual result presentation without changing existing visual design.
- Installer-manager integration for runtimes/models/providers.
- Health checks, repair, rollback and diagnostic evidence.
- Security/privacy/license controls.

## Out of scope
- OS migration.
- New UI design.
- Replacing the existing build/release pipeline.
- Autonomous hidden recording or hidden camera/screen monitoring.
- Shipping restricted/non-commercial model weights without a verified license gate.

## Done means
A clean install can discover the voice runtime, install only required artifacts, verify hashes, run provider self-tests, activate a working provider graph, open a voice session, stream speech with partial transcript, interrupt FRIDAY naturally, cancel stale output, execute a normal FRIDAY capability through the same governance path as chat, speak the result, render rich artifacts, recover from provider failure, and truthfully report health. Regression checks show chat, manual mode, auto mode, companion/device routing and existing installer behavior remain intact.

```text
Install -> Verify -> Health probe -> Activate -> Ready
Ready -> Voice session -> Listen -> Understand -> Execute -> Speak -> Idle
Any state -> User interruption -> Cancel generation -> Flush playback -> Listen
Provider fault -> Mark unhealthy -> Select compatible fallback -> Continue or explain failure
Unsafe action -> Existing governance gate -> Approve/deny -> Execute only if approved
```


---

# SOURCE: `00_START/02_PACKAGE_NAVIGATION.md`


# Package Navigation for an Implementation AI

Start here:
1. `00_START/00_READ_FIRST.md`
2. `01_AUDIT/01_CURRENT_REPOSITORY_AUDIT.md`
3. `02_ARCHITECTURE/01_VOICE_SYSTEM_ARCHITECTURE.md`
4. `03_MEDIA/01_REALTIME_AUDIO_PIPELINE.md`
5. `04_RUNTIME/01_VOICE_SESSION_STATE_MACHINE.md`
6. `05_PROVIDERS/01_PROVIDER_MATRIX.md`
7. `06_INSTALL_MANAGER/01_INSTALL_MANAGER_INTEGRATION.md`
8. `08_SHARED_BRAIN_PARITY/01_CHAT_VOICE_PARITY.md`
9. `12_IMPLEMENTATION/01_FILE_BY_FILE_MAP.md`
10. `12_IMPLEMENTATION/03_IMPLEMENTATION_MASTER_PROMPT.md`
11. `13_ACCEPTANCE/01_ACCEPTANCE_MATRIX.md`
12. `14_REFERENCE/contracts/` and `diagrams/`

Then inspect the actual repository before editing. This package is an implementation contract, not permission to blindly add every listed provider.

```text
Read -> inspect repository -> map -> implement -> verify -> update docs
```


---

# SOURCE: `00_START/03_FINAL_AI_HANDOFF.md`


# Final AI Handoff

When another AI receives this package, the intended instruction is:

> Implement FRIDAY's voice mode from this contract against the current repository. Do not redesign FRIDAY. Do not create duplicate systems. Inspect every relevant owner first. Use the existing shared registries and governance. Integrate runtime/model installation into the existing installer manager. Select only license-safe, verified artifacts. Implement real-time streaming, full duplex, barge-in, local-first providers, fallback, parity, devices/events and rich presentation. Prove every claimed capability with real runtime evidence. Update the authoritative FRIDAY documentation to the actual resulting state.

The package intentionally avoids embedding large model binaries. The installer manager should download exact approved artifacts after license/hash validation.

```text
Package -> repository inspection -> implementation -> installer/runtime verification -> acceptance -> authoritative docs
```


---

# SOURCE: `01_AUDIT/01_CURRENT_REPOSITORY_AUDIT.md`


# Current Repository Voice Audit

## Existing voice owners
| Area | Current owner | Required V3 extension |
|---|---|---|
| Voice profiles | `src/lib/friday/voice-library.ts` | Add provider-aware profile references, delivery policy and verified runtime state without breaking persisted preferences |
| STT orchestration | `src/lib/friday/voice-stt.ts` | Streaming session API, partial/final events, provider selection, cancellation |
| Audio | `src/lib/friday/voice-audio.ts` | Continuous frame transport, clocking, playback flush, capture/playback coordination |
| State | `src/lib/friday/voice-state.ts` | Explicit session/generation/cancellation states |
| Wake | `src/lib/friday/wake-engine.ts`, `wake-word.ts` | Shared audio stream, wake/VAD arbitration and license-safe model selection |
| Electron STT | `electron/stt.cjs` | Persistent low-latency worker protocol and provider abstraction |
| Electron TTS | `electron/neural-voice.cjs` | Local TTS provider plus existing network provider fallback |
| Python STT | `kernel/stt.py` | Streaming backend option; current faster-whisper remains a compatible fallback |
| Python wake | `kernel/wake_word.py` | Rights-cleared model manifest + streaming frame contract |
| Installer | `src/lib/friday/installer-engine.ts` | Voice artifact graph, verification, health, repair and rollback integration |
| Catalog | `src/lib/friday/catalog.ts` | Authoritative provider/runtime/model entries; no parallel voice list |
| Settings | `VoiceSettings.tsx` | Preserve UI; expose existing controls through new runtime status only where already supported |
| Chat/voice parity | existing brain/capability routing | Voice must use the same canonical request/result path |

## Known architectural mismatch
The current `neural-voice.cjs` uses `edge-tts`, so the current "neural" path is network-backed rather than a fully local neural runtime. The V3 design treats that as a provider, not as the definition of the voice architecture.

The current STT path uses faster-whisper through a persistent Python worker. This is useful and should remain available while a streaming local provider is introduced.

The current file-voice import mechanism is not itself a TTS model runtime. A copied audio file must never be misrepresented as an executable voice model.

## Required rule
Do not delete the existing providers during migration. Introduce the new provider graph behind the existing owner boundaries, then make selection policy choose the best verified compatible runtime.

```text
Existing capture -> existing voice audio owner
Existing STT -> keep as fallback while streaming provider is introduced
Existing TTS -> keep network provider as fallback
New local providers -> adapter interfaces -> same voice library/state
All paths -> same FRIDAY brain/capability/governance/event/result infrastructure
```


---

# SOURCE: `01_AUDIT/02_GAP_REGISTER.md`


# Voice Gap Register

## P0 — required for the target experience
1. One bounded streaming audio clock shared by VAD/wake/STT/AEC.
2. Explicit full-duplex session controller.
3. Generation IDs and cancellation propagation from user interruption to brain/tool/task/TTS/playback.
4. Incremental STT partial transcript path.
5. Incremental TTS delivery with sentence/phrase chunking.
6. Playback flush on interruption.
7. Provider registry and health model.
8. Installer artifact graph for runtime + model + native dependency + license metadata.
9. Exact health probe; no fake connected status.
10. Chat/voice canonical request/result parity.

## P1
- WebRTC APM or equivalent AEC/NS/AGC path.
- Silero VAD local provider.
- Rights-cleared custom wake model path.
- Local TTS candidate (Kokoro first candidate; Piper as license-policy alternative where acceptable).
- Local streaming ASR candidate (sherpa-onnx and/or whisper.cpp).
- Screen/camera/device event speech delivery.
- Multi-display result routing.

## P2
- Speaker identification/verification.
- Voice style presets.
- Local voice cloning only when separately license/consent cleared.
- Advanced diagnostics and performance tuning.

## Do not solve by adding parallel systems
- Do not add a second scheduler.
- Do not add a second notification bus.
- Do not add a second device registry.
- Do not add a second governance gate.
- Do not add a second installer framework.

```text
Gap discovered -> map to existing owner -> smallest extension -> contract test -> integration test -> regression
```


---

# SOURCE: `02_ARCHITECTURE/01_VOICE_SYSTEM_ARCHITECTURE.md`


# Voice System Architecture

## Layer A — Media plane
Real-time capture/playback only. It must not execute tools or reason about user intent.

## Layer B — Voice session controller
Owns lifecycle, generation IDs, turn ownership, interruption, provider readiness and session policy.

## Layer C — Conversation/event normalization
Converts partial/final speech, wake events, task events, device events and notifications into FRIDAY's canonical event/request/result contracts.

## Layer D — Existing FRIDAY brain
Use the existing orchestrator/router/brain/capability registry. Voice never bypasses it.

## Layer E — Governance
Use existing approval/risk/authority gates. Voice confirmation is a modality-specific presentation of the same decision, not a second permission system.

## Layer F — Task/event runtime
Use existing durable tasks, reminders, notifications and background jobs. Voice can subscribe to events and speak them.

## Layer G — Presentation
Return canonical artifacts: text, image, video, audio, table, chart, diagram, workflow, code, document, URL, live status, task progress and device state. Speech is one output channel.

## Layer H — Adapter fabric
Provider adapters, device adapters, screen/display adapters and external service adapters.

## Layer I — Installer/health
Artifact manifests, license gates, downloads, hashes, extraction, native runtime discovery, self-tests, activation, repair and rollback.

```text
Media plane -> Session controller -> Canonical request
Canonical request -> Existing router/brain -> Governance when required -> Capability/tool
Capability/tool -> Canonical result/task/event -> Presentation fan-out
Presentation -> Speech + existing UI + display/device channels
Provider health <-> Installer manager <-> Runtime registry <-> Session controller
```


---

# SOURCE: `02_ARCHITECTURE/02_COMPONENT_BOUNDARIES.md`


# Component Boundaries

| Component | Owns | Must not own |
|---|---|---|
| Audio transport | PCM frames, timestamps, device lifecycle | intent, tools |
| AEC/NS/AGC | audio conditioning | session semantics |
| VAD | speech probability/state | wake policy |
| Wake | wake confidence | tool execution |
| STT | audio -> transcript | capability execution |
| Session controller | turns/generations/cancel | model internals |
| Brain | reasoning/routing | microphone lifecycle |
| Governance | risk/approval | audio playback |
| TTS | text -> audio chunks | task scheduling |
| Playback | audio queue/flush | reasoning |
| Installer | artifacts/runtimes/models | voice UI state |
| Health | probes/metrics | installing arbitrary unverified code |
| Presentation | artifact routing | inventing tool results |

## Inter-process rule
Use Electron main/utility process boundaries for long-running native/ML work instead of blocking the renderer. Node `utilityProcess` is appropriate for persistent helper processes and message-port transport; use worker threads only for CPU-bound JavaScript that does not require native isolation.

```text
Renderer <-> preload/IPC <-> main process <-> utility/native provider
                                   |
                                   +-> installer/health
                                   +-> existing FRIDAY services
```


---

# SOURCE: `03_MEDIA/01_REALTIME_AUDIO_PIPELINE.md`


# Real-Time Audio Pipeline

## Canonical audio format
Use a single internal mono PCM stream for voice processing. The implementation must normalize device formats at the boundary and keep one authoritative internal clock.

Recommended baseline: 16 kHz mono PCM16 for VAD/STT/wake unless a provider explicitly requires another rate. Do not resample repeatedly between providers.

## Frame policy
- Small frames, typically 20–40 ms for transport and VAD decisions.
- Wake models may consume 80 ms multiples where required.
- Avoid multi-second input buffers.
- Every frame carries monotonic timestamp, sample count, session ID and generation ID.
- Bounded queues only; when overloaded, drop stale partial audio rather than growing unbounded latency.

## Capture
Capture must be continuous while a voice session is active. It must support microphone device change, suspend/resume, permission failure, device removal and recovery.

## Conditioning
Preferred order:
1. device format normalization;
2. echo reference acquisition;
3. AEC;
4. noise suppression;
5. automatic gain/level control;
6. VAD;
7. wake/STT consumers.

AEC must use the actual playback reference where possible. WASAPI loopback can provide system-rendered audio for echo-cancellation workflows.

## Playback
Playback uses a small queue of PCM/audio chunks. Each spoken generation owns a playback handle. On cancellation, all queued audio belonging to the canceled generation is flushed immediately.

## Never do
- Store microphone audio indefinitely.
- Let STT provider create its own independent microphone capture.
- Let each provider resample independently.
- Allow a slow provider to block the audio callback.

```text
Mic -> format normalize -> echo reference/AEC -> NS -> AGC -> VAD
                                         |                  |
                                         +-> wake           +-> STT
                                                          |
                                                    partial/final
                                                          |
                                                      FRIDAY turn
                                                          |
                                                      TTS chunks
                                                          |
                                                      playback
                                                          |
                                                    echo reference -> AEC
```


---

# SOURCE: `03_MEDIA/02_AEC_NS_AGC_VAD.md`


# AEC / Noise Suppression / AGC / VAD

## Preferred strategy
Use a verified WebRTC Audio Processing Module path for AEC/NS/AGC when its native integration is practical. WebRTC APM is designed for real-time communications and exposes echo cancellation, gain control and noise suppression components. Keep a Silero VAD provider as the neural VAD candidate.

RNNoise is a useful BSD-licensed fallback enhancement option, but it is not a substitute for correct AEC. AEC is the priority for natural full-duplex conversation.

## VAD state
Maintain:
- probability;
- speech start timestamp;
- last speech timestamp;
- hangover window;
- minimum speech duration;
- maximum utterance duration;
- interruption threshold while TTS is playing.

VAD must have separate thresholds for normal listening and barge-in. Barge-in should be more sensitive but protected against speaker leakage by AEC and playback reference.

## Failure behavior
If enhancement fails, degrade to a simpler verified path and mark the quality capability degraded. Never silently claim echo cancellation is active when it is not.

```text
Playback reference + Mic -> AEC -> NS -> AGC -> VAD
VAD false -> keep listening
VAD speech -> STT
VAD during playback -> barge-in detector -> if confidence high: cancel generation + flush playback
Enhancer fault -> fallback DSP path -> health=degraded
```


---

# SOURCE: `03_MEDIA/03_FULL_DUPLEX_BARGE_IN.md`


# Full-Duplex and Barge-In

## Generation model
Every user turn and assistant response has a monotonically increasing `generationId`. Any asynchronous stage must carry that ID. A response chunk is valid only if its generation is still current.

## Interruption sequence
1. Detect speech while FRIDAY is speaking.
2. Confirm interruption using VAD + energy + ASR partial or configured threshold.
3. Mark current generation cancelled.
4. Abort/cancel active LLM/tool/TTS work where supported.
5. Flush playback immediately.
6. Clear stale output queues.
7. Preserve the new user audio already captured.
8. Continue with the new turn.

## Important
The user should not have to wait for the old response to finish. Cancellation is a first-class operation, not an afterthought.

## No stale output rule
A canceled generation must never write text, audio, notification, task result or UI state as if it were the current generation.

```text
FRIDAY speaking -> microphone still active
User speaks -> VAD -> interruption candidate -> confirm
             | yes
             v
Cancel generation -> abort provider work -> flush audio -> promote new turn
             |
             +-> stale callbacks rejected by generationId
```


---

# SOURCE: `03_MEDIA/04_STREAMING_ASR.md`


# Streaming ASR Contract

## Required events
- `asr.started`
- `asr.partial`
- `asr.final`
- `asr.cancelled`
- `asr.error`
- `asr.health`

## Partial transcript rules
Partials are ephemeral. They may be displayed or used for interruption/turn timing, but they must not be committed as final conversation content until the provider emits final or the session policy explicitly commits them.

## Provider targets
### Primary local candidates
- sherpa-onnx: broad local streaming ASR/TTS/VAD ecosystem, Windows and NodeJS support.
- whisper.cpp: mature local Whisper implementation with Windows support, VAD and multiple acceleration backends.

### Existing compatible fallback
- faster-whisper persistent Python worker already present in FRIDAY.

Provider selection must be based on measured health and language/task compatibility, not popularity.

```text
Audio frames -> provider stream -> partial transcript -> session
                                      |
                                      +-> interruption/turn timing
provider endpoint -> final transcript -> canonical request -> existing brain
```


---

# SOURCE: `03_MEDIA/05_STREAMING_TTS.md`


# Streaming TTS Contract

## TTS must not wait for the entire answer
The speech planner should split assistant output at safe semantic boundaries: sentence, clause, explicit pause marker or provider-safe token boundary.

## Requirements
- provider warm state;
- incremental synthesis;
- bounded audio queue;
- first-audio latency target;
- cancellation handle;
- sample-rate normalization;
- playback completion event;
- generation tagging.

## Candidate local engines
Kokoro-82M is a strong local candidate because the official model is Apache-2.0 and current voice metadata includes Hindi voices. Its actual voice quality must be acceptance-tested in FRIDAY; license of the complete inference stack/dependencies still needs to be tracked.

Piper is fast and local but the current OHF-Voice `piper1-gpl` project is GPL-3.0. Therefore it must not be silently treated as equivalent to an MIT/Apache dependency. Use it only if FRIDAY's distribution/license policy accepts the GPL implications, or use a separately verified compatible artifact.

Network TTS such as the current edge-tts path remains a fallback provider, not the definition of local voice.

```text
Canonical text -> speech planner -> chunk 1 -> TTS -> playback
                              |-> chunk 2 -> TTS -> queue
                              |-> chunk N -> TTS -> queue
Interruption -> cancel all pending chunks -> flush playback
```


---

# SOURCE: `03_MEDIA/06_AUDIO_DEVICE_AND_CLOCK.md`


# Audio Device and Clock Contract

## Single clock
The audio subsystem owns the authoritative monotonic timeline. Provider timestamps are converted to this clock at the adapter boundary.

## Device lifecycle
Handle:
- default device change;
- selected device removal;
- sample-rate mismatch;
- channel mismatch;
- exclusive/shared mode differences;
- sleep/resume;
- permission denial;
- audio endpoint restart.

## Windows
WASAPI is the preferred Windows-native boundary. A lightweight native capture/playback implementation may use miniaudio (MIT-0/public-domain option) if that reduces integration risk. The implementation must not create multiple independent capture stacks.

```text
OS audio endpoint -> one capture owner -> internal clock -> all voice consumers
All playback -> one playback owner -> loopback/reference -> AEC
Device change -> rebind endpoint -> health probe -> resume session
```


---

# SOURCE: `04_RUNTIME/01_VOICE_SESSION_STATE_MACHINE.md`


# Voice Session State Machine

## States
`disabled`, `starting`, `ready`, `listening`, `thinking`, `speaking`, `barge_in`, `stopping`, `error`, `degraded`.

## Events
`enable`, `audio_ready`, `wake_detected`, `speech_start`, `partial_transcript`, `final_transcript`, `response_started`, `audio_chunk`, `interrupt`, `cancel_complete`, `task_event`, `stop`, `provider_fault`, `recovered`.

## Invariants
- Only one active voice session per local voice endpoint unless an explicit multi-session policy exists.
- Exactly one current generation.
- No output from a non-current generation.
- A failed provider cannot remain in `healthy` state.
- `speaking` never means microphone capture is disabled.

```text
disabled -> starting -> ready -> listening
listening -> thinking -> speaking -> listening
speaking -> barge_in -> listening
any active -> provider_fault -> degraded/error -> recovery -> ready/listening
any active -> stop -> stopping -> disabled
```


---

# SOURCE: `04_RUNTIME/02_TURN_AND_GENERATION_CONTRACT.md`


# Turn and Generation Contract

Every voice interaction carries:
- `sessionId`
- `turnId`
- `generationId`
- `conversationId`
- `source=voice`
- language metadata
- timing metadata
- cancellation token
- provider trace IDs

The generation ID is the guard against stale asynchronous work. It must be checked before committing transcript, tool result, TTS audio, notification, display artifact or task status.

```text
New turn -> new turnId + generationId
Every async callback -> compare generationId
Equal -> commit
Different -> discard as stale
```


---

# SOURCE: `04_RUNTIME/03_CONTEXT_MEMORY_SESSION.md`


# Voice Context, Memory and Session

Separate three scopes:
1. Live audio session: transient frames, partial transcript, playback state.
2. Conversation context: final user/assistant turns and relevant artifacts.
3. Long-term memory: only data that FRIDAY's existing memory policy explicitly stores.

Raw microphone audio is not a memory mechanism. Do not write raw frames into conversation history.

Session resumption must restore semantic conversation state, not old microphone buffers.

```text
Raw audio -> transient buffer -> discard after use
Final transcript -> conversation state
Explicit memory-worthy fact -> existing memory policy
New session -> restore conversation semantics only
```


---

# SOURCE: `05_PROVIDERS/01_PROVIDER_MATRIX.md`


# Voice Provider Matrix

| Function | Preferred candidate | Alternatives | Local | Key license/fit note |
|---|---|---|---|---|
| Audio I/O | WASAPI/miniaudio boundary | PortAudio | yes | Keep one capture/playback owner |
| AEC/NS/AGC | WebRTC APM | RNNoise + platform DSP | yes | AEC correctness more important than model count |
| VAD | Silero VAD | sherpa-onnx VAD | yes | Silero code is MIT |
| STT streaming | sherpa-onnx | whisper.cpp, existing faster-whisper | yes | Validate exact model/license separately |
| STT fallback | faster-whisper | cloud STT | local/cloud | Existing runtime stays useful |
| TTS local | Kokoro-82M | Piper, sherpa-onnx TTS | yes | Kokoro model Apache-2.0; dependency/voice licenses still tracked |
| TTS network | current edge-tts | other configured cloud provider | no | Treat network dependency honestly |
| Wake | FRIDAY-owned rights-cleared model | openWakeWord runtime with own model | yes | Included openWakeWord pretrained models are CC BY-NC-SA 4.0 |
| Audio enhancement | WebRTC/RNNoise | sherpa enhancement | yes | Never use enhancement as substitute for AEC |

## Selection policy
The registry ranks providers by: verified installation, license policy, platform support, language coverage, measured latency, memory budget, acceleration availability, feature support and recent health. It never selects a provider solely from a hardcoded preferred string.

```text
Provider catalog -> license gate -> install/verify -> health probe -> benchmark -> rank -> activate
```


---

# SOURCE: `05_PROVIDERS/02_PROVIDER_INTERFACE_CONTRACT.md`


# Provider Interface Contract

Every voice provider adapter exposes:
- `id`
- `kind`
- `version`
- `capabilities`
- `supportedLanguages`
- `inputFormat`
- `outputFormat`
- `locality`
- `licenseRefs`
- `artifactRefs`
- `health()`
- `warm()`
- `start()`
- `stop()`
- `cancel(generationId)`
- `metrics()`

Specialized interfaces add:
- VAD: `pushFrame`, `probability`, `speechState`.
- Wake: `pushFrame`, `score`, `detected`.
- STT: `pushFrame`, `partial`, `final`.
- TTS: `synthesizeChunk`, `audioChunk`, `complete`.
- AEC: `pushCapture`, `pushRenderReference`.

Providers must be replaceable without changing the brain or session controller.

```text
Provider adapter <- runtime-specific implementation
Adapter -> stable FRIDAY provider contract
Session controller -> contract only
Health -> registry -> selection -> adapter
```


---

# SOURCE: `05_PROVIDERS/03_LOCAL_FIRST_POLICY.md`


# Local-First Voice Policy

## Baseline
Voice should continue working without network when the selected local provider graph is installed and healthy.

## Network fallback
Network providers may be enabled as explicit fallback according to FRIDAY's network/cost/privacy policy. The system must expose whether the current response used local or network processing.

## Fallback order
1. Same-provider local recovery.
2. Compatible local provider.
3. Configured network provider if policy allows.
4. Honest degraded mode (text-only / request clarification).

Do not automatically send microphone audio to the cloud merely because a local provider is temporarily slow. Network escalation must follow the existing FRIDAY network policy.

```text
Local healthy -> use local
Local fault -> repair/retry -> alternate local
No local -> policy check -> cloud allowed? -> cloud
Cloud denied/unavailable -> degraded response
```


---

# SOURCE: `05_PROVIDERS/04_LANGUAGE_HINGLISH_POLICY.md`


# Hindi / English / Hinglish Policy

## Goals
- Understand Hindi.
- Understand English.
- Understand mixed Hinglish naturally.
- Preserve code, product names, URLs, file paths and technical identifiers.
- Speak in the user's selected language/style without translating technical identifiers unnecessarily.

## Detection
Language detection must be confidence-based and session-aware. Do not flip language on every short English token inside Hindi.

## TTS
Use the same language segmentation used by the canonical response. Hindi segments should use a verified Hindi-capable voice. English segments should use the selected English voice. Mixed segments may be grouped only when the selected TTS provider handles the mixture correctly.

## Acceptance
Real user phrases must be tested: Hindi-only, English-only, Hinglish, numbers, names, code terms, URLs, abbreviations and noisy speech.

```text
Audio -> STT -> language segmentation -> canonical text
canonical text -> response language policy -> segment
segment -> compatible voice -> TTS -> ordered playback
```


---

# SOURCE: `06_INSTALL_MANAGER/01_INSTALL_MANAGER_INTEGRATION.md`


# Voice Integration with Existing Install Manager

## Do not create another installer
Extend `src/lib/friday/installer-engine.ts` and the existing catalog/manifest mechanisms. Voice runtime installation must appear in the same installation, health and repair surfaces already used by FRIDAY.

## Artifact classes
- native runtime;
- executable;
- shared library/DLL;
- Python runtime/wheel environment;
- model weights;
- tokenizer/phonemizer data;
- voice pack;
- wake model;
- license/notice file;
- provider manifest;
- benchmark profile.

## Lifecycle
`discover -> policy/license check -> select artifact -> download -> verify hash/signature when available -> quarantine -> extract -> install -> dependency check -> self-test -> benchmark smoke test -> activate -> persist health`

## Atomic activation
Never switch the active provider pointer before health passes. Failed installs remain inactive and can be removed by repair/rollback.

## Model storage
Models are stored outside the source tree under FRIDAY's existing runtime/data path policy. The package must not embed multi-hundred-MB model binaries in the application source repository.

```text
Catalog -> dependency closure -> license gate -> download
                 |
                 v
              hash/signature -> quarantine -> extract/install
                                             |
                                             v
                                       self-test/benchmark
                                             | pass
                                             v
                                          activate
                                             | fail
                                             v
                                       rollback/repair
```


---

# SOURCE: `06_INSTALL_MANAGER/02_ARTIFACT_MANIFEST_SPEC.md`


# Artifact Manifest Specification

Each installable voice artifact must declare:
- stable `artifactId`;
- `kind`;
- exact `version` or immutable revision;
- target OS/arch;
- source URL(s);
- expected SHA-256;
- archive format;
- install location class;
- runtime entry point;
- dependency IDs;
- license IDs;
- redistribution status;
- model provenance;
- health probe;
- minimum resource budget;
- rollback/removal method;
- compatibility constraints;
- security notes.

No artifact may be activated from an unverified download.

```text
Artifact manifest -> schema validation -> license validation -> hash validation -> install -> probe -> active
```


---

# SOURCE: `06_INSTALL_MANAGER/03_RUNTIME_DEPENDENCY_GRAPH.md`


# Runtime Dependency Graph

## Baseline local voice graph
`audio-io -> audio-processing -> VAD -> wake/STT -> FRIDAY brain -> TTS -> playback`

## Example local STT branch
`audio-io -> audio-processing -> sherpa-onnx/whisper.cpp runtime -> model -> STT adapter`

## Existing fallback branch
`audio-io -> audio-processing -> existing faster-whisper worker -> model -> STT adapter`

## Local TTS branch
`canonical response -> Kokoro runtime -> voice pack -> audio normalization -> playback`

## Network fallback branch
`canonical response -> existing edge-tts adapter -> network -> audio normalization -> playback`

The dependency graph must be represented in the existing installer catalog, not hardcoded in a new module.

```text
Voice feature requested -> resolve provider -> recursively resolve runtime/model dependencies -> install missing nodes -> health-check graph -> activate
```


---

# SOURCE: `06_INSTALL_MANAGER/04_HEALTH_REPAIR_ROLLBACK.md`


# Voice Health, Repair and Rollback

## Health levels
- `healthy`: probe + smoke test passed recently.
- `degraded`: works but one optional acceleration/quality feature is unavailable.
- `unhealthy`: required probe failed.
- `not_installed`: artifact absent.
- `blocked`: license/policy/compatibility gate rejected activation.

## Repair
Repair may reinstall a damaged artifact, rebuild native cache, restore model metadata, or re-run provider initialization.

## Rollback
Keep the last known-good provider activation. A new provider becomes active only after a real probe succeeds.

## Evidence
Persist compact diagnostic evidence: provider ID/version, probe result, latency, error class, artifact hash and timestamp. Do not persist raw audio by default.

```text
Health failure -> classify -> retry once if transient -> repair if integrity/runtime fault
                                   |
                                   +-> restore last known good provider -> re-probe -> active
```


---

# SOURCE: `06_INSTALL_MANAGER/05_VOICE_RUNTIME_CATALOG_ENTRIES.md`


# Required Catalog Entries

The existing catalog should gain authoritative entries for the following logical IDs (exact package versions resolved at implementation time):

- `voice.audio.wasm-or-native` only if the selected transport needs it;
- `voice.audio.miniaudio` candidate;
- `voice.audio.webrtc-apm` candidate;
- `voice.audio.rnnoise` fallback;
- `voice.vad.silero`;
- `voice.stt.sherpa-onnx`;
- `voice.stt.whisper-cpp`;
- `voice.stt.faster-whisper` existing;
- `voice.tts.kokoro`;
- `voice.tts.piper` optional and license-gated;
- `voice.tts.sherpa-onnx` optional;
- `voice.wake.friday-owned` required default path;
- `voice.wake.openwakeword-runtime` optional runtime, model rights gated;
- `voice.tools.ffmpeg` only if an existing media workflow requires it, with LGPL/GPL build variant explicitly recorded;
- `voice.runtime.python` only when the selected provider actually needs Python;
- `voice.runtime.onnx` only when the selected provider requires a separately managed ONNX runtime.

Do not install every candidate by default. The installer resolves only the active feature graph and optional packages explicitly enabled by policy.

```text
Capability -> preferred provider -> exact artifact set -> install only closure -> probe -> activate
```


---

# SOURCE: `07_GOVERNANCE/01_VOICE_GOVERNANCE.md`


# Voice Governance

Voice does not weaken FRIDAY's existing governance.

## Examples
- “Open this app” may be low-risk according to existing policy.
- “Delete these files” must use the same destructive-action approval gate as chat.
- “Send this message” must use the same external-communication risk gate.
- “Unlock/turn off security device” must use the same physical-device authority rules.
- “Watch my camera continuously” requires explicit enablement and a visible active state.

Spoken confirmation is only another interaction channel for the existing governance decision.

```text
Voice request -> capability resolution -> existing risk classification
low risk -> execute
high risk -> existing approval UI/voice flow -> approved? -> execute : deny/cancel
```


---

# SOURCE: `07_GOVERNANCE/02_CAMERA_SCREEN_PRIVACY.md`


# Camera and Screen Privacy

## Camera
- explicit permission before activation;
- clear active state;
- no hidden background camera capture;
- retention disabled by default;
- snapshots/frames retained only when a task explicitly needs an artifact and policy permits it.

## Screen
- explicit enablement for continuous observation;
- use existing Electron desktop capture path;
- do not infer consent from a previous unrelated action;
- retain only task-required evidence;
- continuous observation is a capability with a lifecycle, not an ad-hoc screenshot loop.

## Voice notification
If a camera/screen monitor creates an event, route it through the existing notification/event system and then through the voice output policy. Do not create a voice-only alert bus.

```text
User enablement -> existing camera/screen owner -> observation task -> event
event -> existing notification bus -> presentation policy -> voice/UI/device
```


---

# SOURCE: `08_SHARED_BRAIN_PARITY/01_CHAT_VOICE_PARITY.md`


# Chat and Voice Modality Parity

## Canonical request
Voice must produce the same internal request contract as chat, with only `source=voice` and speech metadata added.

## Canonical result
The brain returns one canonical result containing text plus optional artifacts/tasks/events/device actions. Chat renders it visually. Voice renders it as speech plus any supported visual artifact surface.

## Capability parity
A capability must be discoverable through the same authoritative registry. Do not maintain a “voice capabilities” list.

## Tool execution parity
Voice and chat use the same tool adapters, argument validation, governance, audit trail and result handling.

```text
Chat text -----> canonical request ----+
                                      |
Voice transcript -> canonical request --+-> router/brain/governance -> capability/tool
                                                                |
                                                                v
                                                         canonical result
                                                          /           \
                                                         v             v
                                                       chat           voice
```


---

# SOURCE: `08_SHARED_BRAIN_PARITY/02_ARTIFACT_PRESENTATION_CONTRACT.md`


# Artifact Presentation Contract

Voice can accompany or trigger the same artifact types used by FRIDAY:
- text;
- image/photo;
- video;
- audio;
- table;
- chart;
- diagram;
- workflow/block diagram;
- code;
- document;
- URL/research source;
- live status;
- task progress;
- device state.

The voice response should summarize what is being shown and optionally ask whether the user wants a deeper spoken explanation. It must not fabricate a visual artifact that was not actually produced.

```text
Capability result -> artifact registry/type -> display resolver -> main/extra screen
                                  |
                                  +-> speech summary -> playback
```


---

# SOURCE: `09_DEVICES_VISION/01_CAMERA_HOME_DEVICE_VOICE.md`


# Camera and Home Device Voice Integration

## Device control
Use the existing device fabric/registry. Voice resolves device names, validates capability/action, checks governance, executes through the existing adapter and speaks the real result.

## Cameras
Camera monitoring produces structured events, not raw video in the brain by default. Example event: `person_detected`, `door_open`, `motion`, `package_detected` — only if a configured provider actually supports the classification.

## Smart speakers
A smart speaker may be an external audio endpoint or companion device. Treat it as a device adapter, not as a second FRIDAY identity. Discovery, credentials and action authority belong to the existing device fabric.

```text
Voice command -> device resolver -> existing device registry -> governance -> adapter -> verified result -> speech
Camera monitor -> event detector -> existing event bus -> notification -> speech/UI
```


---

# SOURCE: `09_DEVICES_VISION/02_MULTIDISPLAY_PRESENTATION.md`


# Multi-Display Presentation

## Policy
The existing main UI remains unchanged. When a result has a rich visual artifact and an extra display is available, the display resolver may place the artifact there according to the user's existing display policy.

## Resolver inputs
- artifact type;
- user preference;
- current active display;
- connected display health;
- privacy/risk level;
- task context.

## Voice behavior
Voice should say a concise description while the visual artifact is shown. If no visual surface is available, provide a spoken fallback.

```text
Artifact -> display resolver -> main screen / extra screen / no screen
                          |
                          +-> voice summary -> playback
```


---

# SOURCE: `10_DIAGNOSTICS/01_OBSERVABILITY.md`


# Voice Observability

## Correlation IDs
Every session/turn/generation/provider invocation has a correlation identifier.

## Metrics
- capture underruns/overruns;
- frame queue depth;
- VAD latency;
- wake detection latency;
- STT first partial latency;
- STT final latency;
- brain time to first response token;
- TTS first audio latency;
- playback queue depth;
- barge-in detection latency;
- cancellation completion time;
- provider health;
- CPU/RAM/GPU usage where measurable;
- dropped/stale generation callbacks.

## Logs
Use structured logs with severity and correlation IDs. Never log raw microphone frames or secrets.

```text
Capture -> metrics -> session diagnostics
Provider -> latency/errors -> health
Brain/tool -> trace IDs -> result diagnostics
Playback -> underruns/cancel -> audio diagnostics
```


---

# SOURCE: `10_DIAGNOSTICS/02_PERFORMANCE_BUDGETS.md`


# Performance Budgets

These are engineering targets, not claims about current hardware.

| Metric | Target |
|---|---:|
| Audio frame scheduling jitter | < 10 ms typical |
| VAD decision | < 50 ms |
| Wake decision | < 200 ms after eligible frame window |
| STT first partial | target < 500 ms after speech begins on capable local hardware |
| TTS first audio | target < 700 ms after first speakable response chunk |
| Barge-in to playback silence | target < 200 ms |
| Main renderer blocking from voice ML | 0 ms intentional |
| Audio queue | bounded, never unbounded |

Benchmarks must record hardware, provider, model, precision, language and power mode. Do not compare results across different configurations as if they were identical.

```text
Measure -> record configuration -> compare to budget -> tune only bottleneck -> remeasure
```


---

# SOURCE: `10_DIAGNOSTICS/03_FAILURE_RECOVERY.md`


# Failure Recovery

| Failure | Recovery |
|---|---|
| Mic unavailable | switch to explicit push-to-talk/manual input or report unavailable |
| Device removed | rebind default/selected endpoint |
| VAD crash | restart provider; use safe fallback |
| Wake model unavailable | disable wake only; keep push-to-talk/manual voice if possible |
| STT provider crash | restart then alternate verified STT |
| TTS provider crash | restart then alternate verified TTS |
| Network loss | remain local if local graph is healthy; otherwise degrade honestly |
| Generation cancellation | flush all generation audio; discard stale callbacks |
| Installer hash mismatch | quarantine artifact; do not activate |
| Model license blocked | do not download/activate; choose compliant provider |
| GPU backend failure | fall back to CPU if resource budget permits |

```text
Failure -> classify -> recover locally -> alternate provider -> degraded mode -> user-visible truthful status
```


---

# SOURCE: `11_SECURITY/01_THREAT_MODEL.md`


# Voice Threat Model

## Threats
- prompt injection through spoken content;
- malicious audio attempting to trigger actions;
- replayed wake phrases;
- accidental activation from media playback;
- cloud leakage of private audio;
- malicious or tampered runtime/model downloads;
- stale async tool execution after user cancellation;
- unauthorized device control;
- hidden camera/screen monitoring.

## Controls
- existing governance gate;
- explicit capability authority;
- generation cancellation;
- artifact hashes/signatures where available;
- license/policy gate;
- least-privilege credentials;
- privacy state machine;
- no raw audio retention by default;
- audit trail for high-risk actions.

```text
Untrusted speech/event -> parse -> capability -> risk gate -> execute only if authorized
```


---

# SOURCE: `11_SECURITY/02_LICENSE_POLICY.md`


# Voice License Policy

## Required distinction
“Open source runtime” does not automatically mean “safe to redistribute every model/voice.” Runtime code, model weights, voice data, phonemizer, training data and bundled examples may have different licenses.

## Important current findings
- whisper.cpp: permissive open-source project; supports Windows and multiple acceleration backends.
- Silero VAD code: MIT.
- openWakeWord code: Apache-2.0, but included pretrained models are CC BY-NC-SA 4.0; therefore FRIDAY must use a rights-cleared FRIDAY-owned wake model for a default commercial/redistributable path unless policy explicitly permits otherwise.
- Kokoro-82M official model card: Apache-2.0; Hindi voices exist, but voice-level provenance/quality and inference dependencies must still be checked.
- Current OHF-Voice piper1-gpl: GPL-3.0. Do not treat it as a permissive drop-in.
- FFmpeg is LGPL by default with optional GPL components; the exact build configuration determines the license obligations.
- WebRTC APM and RNNoise use permissive licenses, but exact third-party build composition still requires notice tracking.

## Gate
Every artifact has a license record. `blocked` is a valid state. A blocked artifact is never silently installed.

```text
Artifact -> runtime license -> model license -> voice-data license -> redistribution policy -> allowed/blocked
```


---

# SOURCE: `12_IMPLEMENTATION/01_FILE_BY_FILE_MAP.md`


# File-by-File Implementation Map

## Existing files to extend
### `src/lib/friday/voice-audio.ts`
Add one authoritative audio transport abstraction. Keep existing public behavior. Introduce bounded frame stream, timestamping, playback handles, flush-by-generation, device lifecycle and health metrics.

### `src/lib/friday/voice-stt.ts`
Refactor only the provider boundary needed for streaming. Preserve existing callers. Add provider registry lookup, partial/final event handling, cancellation and fallback.

### `src/lib/friday/voice-state.ts`
Extend state with generation/session/provider health. Preserve existing state consumers.

### `src/lib/friday/wake-engine.ts` / `wake-word.ts`
Make wake consume the shared frame stream. Add model manifest/health checks and avoid duplicate capture.

### `electron/stt.cjs`
Keep the persistent worker approach. Add provider process lifecycle, streaming message protocol, cancellation and health probe. Do not block Electron main.

### `kernel/stt.py`
Keep current faster-whisper worker as an adapter implementation. Add streaming-compatible message framing only where the selected engine supports it; otherwise return bounded segments rather than pretending true token streaming.

### `electron/neural-voice.cjs`
Keep existing network TTS provider but expose it through the TTS adapter. Add cancellation/health. Add a separate local TTS adapter process only if required by the selected runtime.

### `kernel/wake_word.py` / `electron/wake-engine.cjs`
Move model selection to the authoritative provider/model manifest and keep only rights-cleared default models active.

### `src/lib/friday/catalog.ts`
Add authoritative provider/runtime/model artifacts and dependency closures. Remove nothing existing unless an entry is objectively dead and the current project contract permits cleanup.

### `src/lib/friday/installer-engine.ts`
Add voice artifact graph resolution, hash/license gate, atomic activation, provider self-test, benchmark smoke test, repair and rollback using existing installer primitives.

### `src/components/friday/settings/VoiceSettings.tsx`
Do not redesign. Only surface verified runtime/provider status where existing UI already has a natural place for it.

### `src/components/friday/ChatDock.tsx`
Only integrate richer artifact/voice status if required by the existing parity contract. Do not redesign the dock.

## Existing shared areas to reuse
- capability registry and routing;
- governance gate;
- task/background scheduler;
- notifications/event bus;
- screen awareness;
- camera awareness;
- device registry/fabric;
- brain/orchestrator;
- browser/PC control;
- display/artifact presentation;
- existing tests for cross-mode parity and installer coverage.

## New files are allowed only when they are true single owners
Examples: `voice-provider-registry`, `voice-session-controller`, `voice-installer-manifest`, `voice-health`, `voice-audio-worker`. Before adding each file, search the repository for an existing owner with equivalent responsibility.

```text
Inspect owner -> extend existing owner -> add adapter only if no owner exists -> wire to shared registry -> test -> regression
```


---

# SOURCE: `12_IMPLEMENTATION/02_PHASED_EXECUTION_PLAN.md`


# Phased Execution Plan

## Phase 0 — repository mapping
Inspect actual imports, IPC channels, registries, installer primitives, test contracts and runtime paths. Produce no code changes in this phase.

## Phase 1 — contracts
Implement stable types/events/provider contracts and generation cancellation without changing UI.

## Phase 2 — audio plane
Implement one capture/playback owner, bounded frames, clock, device lifecycle and playback flush.

## Phase 3 — conditioning
Integrate AEC/NS/AGC and VAD with measured health.

## Phase 4 — streaming STT
Add local streaming provider adapter and preserve faster-whisper fallback.

## Phase 5 — streaming TTS
Add local TTS provider adapter and keep current network provider as fallback.

## Phase 6 — full duplex
Wire barge-in, cancellation and stale-generation rejection.

## Phase 7 — installer
Integrate artifact manifests, license/hash gates, health, activation, repair and rollback.

## Phase 8 — parity
Route voice through the same capabilities, governance, tasks, events, artifacts and device fabric as chat.

## Phase 9 — vision/devices
Connect camera/screen/device events and multi-display artifact presentation through existing owners.

## Phase 10 — hardening
Run only targeted tests and real runtime probes required to prove the changed paths.

## Phase 11 — documentation sync
Update authoritative FRIDAY docs with the actual implemented state. Remove temporary migration notes only when no longer true.

```text
0 Map -> 1 Contracts -> 2 Audio -> 3 Conditioning -> 4 STT -> 5 TTS -> 6 Duplex
                                             |
                                             +-> 7 Installer -> 8 Parity -> 9 Vision/Devices -> 10 Hardening -> 11 Docs
```


---

# SOURCE: `12_IMPLEMENTATION/03_IMPLEMENTATION_MASTER_PROMPT.md`


# Master Prompt for the Implementation AI

You are implementing FRIDAY's voice mode inside an existing Windows Electron/React/TypeScript project. Treat the repository as the source of truth. Do not rebuild FRIDAY from scratch.

## Mandatory operating procedure
1. Inspect the repository and identify existing owners before editing anything.
2. Map every required voice function to an existing owner or create one minimal owner only when none exists.
3. Reuse existing capability registry, governance, task runtime, event/notification system, device fabric, screen/camera owners and installer manager.
4. Do not change UI/design unless a functional integration is impossible without it.
5. Do not modify CI/CD/build/release/installer packaging architecture unless a verified blocker requires it.
6. Do not add duplicate schedulers, registries, event buses or governance systems.
7. Implement contracts first, then media plane, providers, installer integration, parity and hardening.
8. All asynchronous voice work carries `sessionId`, `turnId`, `generationId` and cancellation state.
9. On barge-in, cancel the current generation, flush playback immediately and reject stale callbacks.
10. Provider health must be backed by a real probe.
11. Runtime/model downloads must pass the installer artifact/license/hash gate before activation.
12. Do not bundle restricted/non-commercial models or voices as default redistributable artifacts.
13. Preserve existing fallback providers.
14. Run the minimum targeted verification required for each changed path and then the relevant regression checks.
15. Do not claim completion without actual evidence.

## Required target behavior
- natural full-duplex conversation;
- partial STT while user is speaking;
- fast first spoken audio;
- immediate barge-in;
- Hindi, English and Hinglish;
- local-first operation;
- provider fallback;
- same capabilities as chat;
- same governance as chat;
- same tasks/events/notifications as chat;
- same devices/camera/screen/browser capabilities as chat, subject to permission/risk;
- rich visual artifact presentation while voice narrates it;
- installer-managed runtimes/models;
- honest health and recovery.

## Completion gate
Do not stop at type-checking. Prove the actual runtime path with installed provider(s), a microphone capture test, STT test, TTS test, interruption test, capability execution test and fallback/repair test appropriate to the environment. If a full build is blocked by an environment prerequisite, state exactly what is blocked rather than claiming success.

```text
INSPECT -> UNDERSTAND -> MODIFY ONLY REQUIRED -> INTEGRATE -> TEST -> REGRESSION TEST -> CONFIRM
```


---

# SOURCE: `13_ACCEPTANCE/01_ACCEPTANCE_MATRIX.md`


# Acceptance Matrix

| ID | Area | Pass condition |
|---|---|---|
| V01 | mic | correct device captured continuously |
| V02 | device change | session recovers after endpoint change |
| V03 | VAD | speech/no-speech decisions stable |
| V04 | wake | only rights-cleared model active by default |
| V05 | STT partial | partial transcript arrives during speech |
| V06 | STT final | final transcript commits once |
| V07 | Hinglish | mixed speech recognized acceptably |
| V08 | TTS | first audio starts before whole answer is complete |
| V09 | duplex | microphone remains active while speaking |
| V10 | barge-in | old audio stops rapidly |
| V11 | stale generation | canceled response never reappears |
| V12 | chat parity | same capability registry and tool adapter |
| V13 | governance | high-risk voice action requires same approval |
| V14 | task | long task continues after turn when policy allows |
| V15 | notification | event reaches existing notification bus |
| V16 | camera | explicit permission and active state |
| V17 | screen | existing screen capture owner reused |
| V18 | devices | action verified by actual device response |
| V19 | displays | artifact routes to available display |
| V20 | installer | artifact hash/license gate works |
| V21 | repair | broken provider can be repaired |
| V22 | rollback | last-known-good provider can be restored |
| V23 | offline | local graph works without network |
| V24 | fallback | network provider used only when policy allows |
| V25 | privacy | raw mic audio not retained by default |
| V26 | performance | audio path does not block renderer |
| V27 | docs | docs reflect actual implemented state |

```text
Each acceptance item -> real runtime evidence -> pass/fail -> fix -> retest only affected path
```


---

# SOURCE: `13_ACCEPTANCE/02_END_TO_END_SCENARIOS.md`


# End-to-End Scenarios

1. Wake -> “What is the weather?” -> STT -> existing research/tool path -> spoken result.
2. Push-to-talk -> Hindi request -> Hindi/Hinglish response.
3. Speak while FRIDAY is speaking -> barge-in -> old audio stops -> new request executes.
4. Ask for a chart -> chart artifact appears on existing UI/display -> voice summarizes.
5. Ask FRIDAY to open a browser page -> existing browser capability + governance -> verified result spoken.
6. Ask to control a home device -> existing device registry -> authorization -> actual device response -> spoken confirmation.
7. Camera event -> existing event/notification -> voice alert according to policy.
8. Reminder due -> existing scheduler fires -> notification -> voice delivery.
9. Local STT provider fails -> health marks unhealthy -> fallback provider -> conversation continues.
10. TTS provider fails mid-response -> cancel affected audio -> fallback TTS for remaining safe chunks.
11. Network unavailable -> local graph remains functional.
12. Provider artifact hash mismatch -> installer blocks activation.
13. User disables voice -> all active capture/playback stops cleanly.
14. App resumes after sleep -> audio endpoint rebinds and health is rechecked.
15. Extra display disconnects -> artifact falls back to main UI and voice narration continues.

```text
Scenario -> observe real events -> verify expected contract -> verify user-visible result -> verify no regressions
```


---

# SOURCE: `13_ACCEPTANCE/03_REGRESSION_CHECKLIST.md`


# Regression Checklist

Only run checks relevant to changed areas, plus the minimum project-level regression needed to prove shared systems remain intact.

- chat still routes through the same brain;
- manual voice still works;
- auto mode remains intact;
- capability registry uniqueness remains intact;
- governance tests remain intact;
- installer catalog coverage remains intact;
- existing notification/task scheduling remains intact;
- companion/device paths remain intact;
- screen/camera owners remain intact;
- build/install/release behavior remains untouched unless a verified dependency requires a change.

```text
Changed voice area -> targeted verification -> shared-contract regression -> stop when evidence is sufficient
```


---

# SOURCE: `14_REFERENCE/01_OPEN_SOURCE_AND_RUNTIME_RESEARCH.md`


# Open-Source Runtime Research — 2026-09

## whisper.cpp
Windows-supported C/C++ Whisper implementation. Current upstream documents CPU, Vulkan, NVIDIA CUDA, AMD ROCm, OpenVINO and NPU-related acceleration paths and VAD. Strong candidate for a native local STT adapter.
Source: https://github.com/ggml-org/whisper.cpp

## sherpa-onnx
Supports local streaming/non-streaming ASR, TTS, VAD, enhancement and keyword spotting, with Windows and NodeJS support among its platforms. Strong candidate for a unified local speech runtime when model availability/license fit is verified.
Source: https://github.com/k2-fsa/sherpa-onnx

## Silero VAD
MIT-licensed VAD implementation. Suitable for local speech detection.
Source: https://github.com/snakers4/silero-vad

## Kokoro-82M
Official model card is Apache-2.0. Current official voice metadata includes Hindi voices `hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi`. Hindi data is relatively limited, so FRIDAY must acceptance-test actual Hindi quality instead of assuming it is perfect.
Source: https://huggingface.co/hexgrad/Kokoro-82M

## Piper
Current OHF-Voice `piper1-gpl` is GPL-3.0. It remains technically useful but must be treated as a license-gated option, not an unqualified permissive default.
Source: https://github.com/OHF-Voice/piper1-gpl

## openWakeWord
Runtime code is Apache-2.0, but included pretrained models are CC BY-NC-SA 4.0. Default FRIDAY wake path should therefore use a separately rights-cleared FRIDAY-owned wake model. The runtime can still be evaluated as an engine.
Source: https://github.com/dscripka/openWakeWord

## WebRTC Audio Processing
Provides real-time audio processing components such as AEC, gain control and noise suppression under a BSD-style license. Good candidate for echo-aware full-duplex audio.
Source: https://webrtc.googlesource.com/src/

## RNNoise
BSD-licensed neural noise suppression. Useful fallback/augmentation, not a replacement for correct AEC.
Source: https://github.com/xiph/rnnoise

## miniaudio
Single-file audio playback/capture library supporting Windows/WASAPI; public-domain or MIT No Attribution. Useful when a small native audio boundary is preferable.
Source: https://github.com/mackron/miniaudio

## Electron utilityProcess
Electron provides a utility-process API for long-running Node/native helper processes with message ports. This is useful for isolating ML/audio providers from the renderer/main event loop.
Source: https://www.electronjs.org/docs/latest/api/utility-process

## Windows WASAPI loopback
Windows supports loopback capture of rendered audio; this is relevant to echo cancellation and system-audio-aware workflows.
Source: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording

## FFmpeg
FFmpeg is LGPL by default, but optional GPL components change obligations. FRIDAY must pin the exact build configuration if FFmpeg is distributed.
Source: https://ffmpeg.org/legal.html

## Architecture references
OpenVoiceOS formalizes stable voice-OS component boundaries and pipeline contracts; Wyoming demonstrates modular voice satellite/provider transport patterns. FRIDAY should borrow the separation principles without copying another project's architecture wholesale.
Sources: https://github.com/OpenVoiceOS/architecture and https://github.com/rhasspy/wyoming-satellite

```text
Research source -> verify current license/capability -> record in catalog -> implementation decision -> acceptance test
```


---

# SOURCE: `14_REFERENCE/02_LICENSE_ARTIFACT_REGISTER.md`


# License Artifact Register Template

| Artifact ID | Runtime/model | Version | License | Model/voice license | Redistribution | Source | Hash | Gate |
|---|---|---|---|---|---|---|---|---|
| voice.stt.whisper-cpp | whisper.cpp | resolve at install | permissive upstream | model-specific | verify | upstream | required | allow if policy passes |
| voice.vad.silero | Silero VAD | resolve at install | MIT | model-specific | verify | upstream | required | allow if policy passes |
| voice.tts.kokoro | Kokoro | resolve at install | Apache-2.0 model | voice/provenance tracked | verify | Hugging Face | required | allow if policy passes |
| voice.tts.piper | Piper | resolve at install | GPL-3.0 current OHF runtime | voice-specific | policy-dependent | upstream | required | blocked unless policy allows |
| voice.wake.openwakeword-model | openWakeWord model | resolve | CC BY-NC-SA 4.0 for included pretrained models | same | non-commercial restriction | upstream | required | blocked for default redistributable path |

This table is a template; implementation must fill exact versions, hashes and artifact URLs from the final selected releases before activation.

```text
Catalog entry -> exact artifact -> exact license -> policy -> active/blocked
```


---

# SOURCE: `14_REFERENCE/03_TERMINOLOGY.md`


# Terminology

- **Media plane**: capture, conditioning, VAD, wake, STT, TTS, playback.
- **Voice session**: one active conversational audio interaction.
- **Turn**: one user input plus its corresponding assistant processing cycle.
- **Generation**: one cancellable assistant output lineage.
- **Barge-in**: user starts speaking while FRIDAY is speaking and FRIDAY yields immediately.
- **Provider**: implementation of a voice function.
- **Runtime**: executable/library/interpreter needed to run a provider.
- **Model**: learned weights/data used by a provider.
- **Artifact**: anything installable/verifiable by the installer manager.
- **Health**: measured operational status, not a UI guess.
- **Local-first**: local provider is preferred when healthy and policy permits.

```text
User audio -> media plane -> session -> FRIDAY -> provider/artifact -> result
```


---

# SOURCE: `14_REFERENCE/04_SOURCE_INDEX.md`


# Source Index

1. whisper.cpp — https://github.com/ggml-org/whisper.cpp
2. sherpa-onnx — https://github.com/k2-fsa/sherpa-onnx
3. Silero VAD — https://github.com/snakers4/silero-vad
4. Kokoro-82M — https://huggingface.co/hexgrad/Kokoro-82M
5. openWakeWord — https://github.com/dscripka/openWakeWord
6. Piper — https://github.com/OHF-Voice/piper1-gpl
7. WebRTC — https://webrtc.googlesource.com/src/
8. RNNoise — https://github.com/xiph/rnnoise
9. miniaudio — https://github.com/mackron/miniaudio
10. Electron utilityProcess — https://www.electronjs.org/docs/latest/api/utility-process
11. Electron desktopCapturer — https://www.electronjs.org/docs/latest/api/desktop-capturer
12. Windows WASAPI loopback — https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
13. FFmpeg legal — https://ffmpeg.org/legal.html
14. OpenVoiceOS architecture — https://github.com/OpenVoiceOS/architecture
15. Wyoming satellite — https://github.com/rhasspy/wyoming-satellite

```text
External source -> verify current release/license -> record exact selected version/hash before activation
```


---

# SOURCE: `14_REFERENCE/implementation-checklist.md`


# Implementation Checklist

- [ ] Repository owner map completed
- [ ] Existing registries reused
- [ ] Shared audio owner established
- [ ] AEC/NS/AGC health measured
- [ ] VAD integrated
- [ ] Wake integrated with rights-cleared model
- [ ] Streaming STT integrated
- [ ] Streaming TTS integrated
- [ ] Generation cancellation wired end-to-end
- [ ] Chat/voice parity verified
- [ ] Installer artifacts registered
- [ ] Hash/license gates verified
- [ ] Repair/rollback verified
- [ ] Camera/screen/device/event paths reused
- [ ] Rich artifacts spoken + displayed
- [ ] Offline local path verified
- [ ] Network fallback policy verified
- [ ] Targeted regression suite passed
- [ ] Build/install behavior proven unchanged
- [ ] Authoritative docs updated

```text
Checklist item -> evidence -> mark complete only after real verification
```


---

# SOURCE: `diagrams/README.md`


# Diagram Index

Every major voice subsystem has a dedicated SVG diagram and an ASCII flow in its related Markdown specification. SVG is used instead of text-based diagram formats so the package has no diagram-renderer dependency.

| Diagram | Covers |
|---|---|
| 01 | End-to-end voice path |
| 02 | Full duplex and barge-in |
| 03 | Installer lifecycle |
| 04 | Provider graph |
| 05 | Chat/voice parity |
| 06 | Camera/device/event -> voice |
| 07 | Rich/multi-display presentation |
| 08 | Audio clock and DSP |
| 09 | Failure recovery |
| 10 | Session state |
| 11 | Generation cancellation |
| 12 | Security/governance |
| 13 | Model lifecycle |
| 14 | Language/Hinglish |
| 15 | Diagnostics |
| 16 | Privacy lifecycle |

```text
Open SVG -> inspect component order -> map each node to FRIDAY owner -> implement only required edge
```
