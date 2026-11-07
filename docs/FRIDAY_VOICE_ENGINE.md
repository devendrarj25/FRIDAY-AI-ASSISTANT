# FRIDAY — Voice Engine

The voice upgrade lives inside the existing voice stack. This is its single owning document: audit, module map, provider matrix, hardware profiles, and test evidence. Rules for the stack (Auto mode owns the microphone, both firewalls, hands-free off) stay in [AGENTS.md](../AGENTS.md) and [FRIDAY_STATE.md](../FRIDAY_STATE.md).

## Status

| Capability                                                        | State                                                                                                | Where                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Mixed Hindi + English speech (the `na` fallback)                  | Fixed, tested with a stand-in synthesiser                                                            | `kernel/language_segmenter.py`, `kernel/voice_runtime.py`                      |
| Long replies cut at 500 characters                                | Fixed on the speak path                                                                              | `splitLongSpeech` in `voice-engine/language-segmenter.ts`, `assistant-mode.ts` |
| Language-aware chunking (TypeScript)                              | Built, tested                                                                                        | `voice-engine/language-segmenter.ts`                                           |
| Transcript stabiliser for chunked STT                             | Built, tested; not yet fed by the live recogniser                                                    | `voice-engine/transcript-stabilizer.ts`                                        |
| Barge-in detector, interrupt order, spoken control words          | Built, tested; not yet replacing the live barge-in in `voice-audio.ts`                               | `voice-engine/interruption-controller.ts`                                      |
| Provider capability table, quota ledger, zero-spend routing       | Built, tested; not yet read by the live router                                                       | `voice-engine/voice-provider-router.ts`                                        |
| Performance profile (Lite / Balanced / Quality)                   | Built, tested; hardware facts are supplied by the caller                                             | `voice-engine/hardware-profile.ts`                                             |
| Background-task spoken updates                                    | Built, tested; not yet connected to `background-tasks.ts`                                            | `voice-engine/task-announcer.ts`                                               |
| Cloud realtime transport                                          | Implemented and checked against a local socket; **not tested against the live provider**             | `electron/realtime-session.cjs` `startCloud`, `realtime:open-cloud`            |
| Native echo cancellation with the playback reference (WebRTC APM) | **Not built.** The stack still uses the browser's echo, noise and gain flags plus the speaking guard | pending                                                                        |
| Full-duplex proof (capture and playback running together)         | **Not tested.** No microphone or speaker on the build machine                                        | pending                                                                        |
| Streaming (word by word) recognition                              | Not built. The engine is chunked: it re-reads a window of audio                                      | pending                                                                        |
| Voice settings and diagnostics panels for the new modules         | Not built                                                                                            | pending                                                                        |

## Audit of what already existed

| Area          | Finding                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State machine | `voice-state.ts` already is the one event-driven machine (14 states). Not duplicated; the new modules feed it through its events.                                                                                                                                                 |
| Microphone    | One shared stream owned by `voice-audio.ts`; no second capture was found. AudioWorklet is in use there.                                                                                                                                                                           |
| VAD           | Silero ONNX when the file is on disk, otherwise the energy VAD (`kernel/voice_runtime.py`, `speech-vad.ts`).                                                                                                                                                                      |
| STT           | faster-whisper via `kernel/stt.py` and `electron/stt.cjs`; Moonshine for English; Windows speech optional.                                                                                                                                                                        |
| TTS           | Supertonic (local), neural online, Windows SAPI, formant last (`tts-ladder.ts`, `speech-tts.ts`).                                                                                                                                                                                 |
| Wake word     | openWakeWord ONNX with a transcript fallback.                                                                                                                                                                                                                                     |
| Bug           | `speech_lang` returned `na` for any sentence with both scripts. Fixed: the script with more letters decides, and the synthesiser reads each script span in its own language with one voice, joined in order. The old test that pinned `na` was replaced with stronger assertions. |
| Bug           | `speak_wav_bytes` cuts text at 500 characters, so the end of a long reply was never spoken. The speak path now splits at sentence or clause breaks before the call.                                                                                                               |
| Gap           | The cloud realtime path returned "not available in this version". Now a real transport exists (below).                                                                                                                                                                            |
| Gap           | No echo canceller that sees the playback signal. Echo is handled by the browser flags, the speaking guard and a louder-than-echo test.                                                                                                                                            |

## Module map (new, `src/lib/friday/voice-engine/`)

Pure modules with injected clocks; none opens a device. They are the decision logic the live files can adopt one at a time.

| Module                       | Job                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language-segmenter.ts`      | Script spans, Roman-Hindi hint, speech chunks (never one per word), long-reply split                                                                                                                                                                                                                                                          |
| `transcript-stabilizer.ts`   | Overlap merge across windows; words two hypotheses agree on are stable; a partial is never actionable                                                                                                                                                                                                                                         |
| `interruption-controller.ts` | `BargeInDetector` (debounce, start guard, louder-than-echo, one fire per stretch of voice), `InterruptController` (stop playback first, then TTS, stream, queue, provider truncate; one failing step does not stop the rest), `classifyVoiceControl` (a spoken stop ends speech only; a task is cancelled, paused or resumed only when named) |
| `voice-provider-router.ts`   | Capability table, `UsageLedger`, `routeVoice`: local by default; cloud only with cloud on, provider allowed, key saved, privacy off, not sensitive, online, inside daily, monthly and audio quota; paid only with paid allowed + approved + a spend limit above zero + the billing firewall's yes; quota used up gives local, never paid      |
| `hardware-profile.ts`        | Lite / Balanced / Quality from reported facts; one heavy speech model; a GPU under 8 GB serves the language model or recognition, not both; no GPU runs everything on the CPU; missing models are listed, never downloaded                                                                                                                    |
| `task-announcer.ts`          | Says start, real milestones, need for input or approval, failure, finish; holds while the owner talks or FRIDAY speaks; urgent first on release; bounded                                                                                                                                                                                      |

Python: `kernel/language_segmenter.py` (same rules), used by `voice_runtime.speak_wav_bytes`.

## Cloud realtime transport

`createRealtimeSessions().startCloud(id, provider, model, key, handlers)` opens one WebSocket to an address built from a fixed table (`CLOUD_REALTIME`, today `openai` → `wss://api.openai.com/v1/realtime?model=<model>`), with an `Authorization: Bearer` header. The renderer sends only a provider id, a model the owner named (none is defaulted, it costs money) and the consent flag. `main.cjs` re-checks consent, privacy mode and `paidUnlocked`, reads the key from the encrypted store, and the preload exposes no key. An error text is scrubbed of the key. Node's built-in WebSocket sends the header; this was verified on a local socket, which also reproduced the address and header the provider expects.

Unverified: a live session. The official OpenAI Realtime page could not be read from the build machine (the old guide URL redirects and the new one returned 404), so the `OpenAI-Beta: realtime=v1` header and the event names are taken from third-party examples and may differ from the current interface.

## Provider matrix

Only Sarvam and Azure Speech are `verified: true` in code, and only for the facts listed in their rows. Rules: capability decides, never the name; quotas are the owner's numbers; nothing is assumed free.

| Provider                 | Needs it offers here                        | Notes                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ollama (this PC)         | text, stream-text                           | Default and fallback. Hindi quality depends on the model.                                                                                                                                           |
| faster-whisper (this PC) | stt                                         | Chunked, not native streaming.                                                                                                                                                                      |
| Supertonic 3 (this PC)   | tts                                         | Hindi and English; mixed text read span by span. Hindi naturalness not listened to here.                                                                                                            |
| Windows speech (this PC) | tts, stt                                    | Emergency fallback.                                                                                                                                                                                 |
| OpenAI                   | text, stream-text, stt, tts, realtime-audio | Realtime treated as paid; used only with paid allowed and approved.                                                                                                                                 |
| Google Gemini            | text, stream-text, stt, realtime-audio      | Free allowance is the owner's setting; live API not read here.                                                                                                                                      |
| Anthropic Claude         | text, stream-text                           | Text only; the consumer voice mode is not an embeddable API.                                                                                                                                        |
| xAI Grok                 | text, stream-text                           | No voice API is claimed.                                                                                                                                                                            |
| Sarvam AI                | stt, tts, text                              | Its docs list speech-to-text and text-to-speech and say "10 languages" for speech, without naming Hindi on the page read (2026-11-07); WebSocket streaming not mentioned there, so none is claimed. |
| Azure Speech             | stt, tts                                    | Hindi neural voices believed; not read here.                                                                                                                                                        |

Siri is not embedded in Windows; Apple-device integration would be a separate optional integration.

## Hardware profiles

Reference machine from the owner: Intel i7, 16 GB RAM, about 4 GB NVIDIA, Windows 11. `selectProfile` does not assume it; it reads the facts.

| Profile  | Chosen when                                              | Speech recognition                          | Language model                                    |
| -------- | -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Lite     | under 6 GB RAM free, under 4 threads or under 8 GB total | base, CPU, int8                             | qwen3:1.7b, CPU, context 2048                     |
| Balanced | the default                                              | small, CPU, int8, beam 1, at most 4 threads | qwen3:1.7b or 4b by memory, GPU when 3 GB or more |
| Quality  | 8 GB or more video memory, 12 GB RAM free, 8 threads     | small or medium, beam 2                     | as Balanced                                       |

The owner may ask for a lighter profile any time; a heavier one only when the machine fits. Model names are starting candidates, not benchmarked here. One background worker until memory and latency are measured on the real PC.

## Research log

| Date       | Source                                                                  | Decision                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-07 | Node WebSocket `headers` option, run against a local server             | ADOPT: no new dependency for the cloud pipe                                                                                                                                                                                                  |
| 2026-11-07 | OpenAI Realtime WebSocket guide (unreadable; third-party examples only) | ADAPT, unverified                                                                                                                                                                                                                            |
| 2026-11-07 | Sarvam API introduction                                                 | ADAPT: listed, no streaming claimed                                                                                                                                                                                                          |
| 2026-11-07 | WebRTC Audio Processing Module                                          | REJECT for now: the search found no maintained Node or Electron binding (only JVM and Rust ones), so it needs a native Windows build and a licence review; the Windows speaker reference path is the open work. Recorded in Next priorities. |

## Tests

| Suite                                                                | Covers                                              |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `core/__tests__/voice-engine-language.test.ts`                       | spans, mixed text, chunking, long split             |
| `core/__tests__/voice-engine-stabilizer.test.ts`                     | overlap merge, stability, action gate               |
| `core/__tests__/voice-engine-control.test.ts`                        | barge-in, interrupt order, control words, announcer |
| `core/__tests__/voice-engine-routing.test.ts`                        | provider routing, quota, zero spend, profiles       |
| `core/__tests__/realtime-session.test.ts`, `realtime-client.test.ts` | cloud transport and client                          |
| `kernel/tests/test_language_segmenter.py`                            | spans and per-span synthesis                        |

These are unit and local-socket tests. None uses a real microphone, speaker or cloud account.

## Echo cancellation: what is and is not known

FRIDAY's local neural voice (Supertonic) is played as an `Audio` element in the renderer (`voice-library.ts`), and the microphone is opened with the browser's echo, noise and gain flags (`voice-audio.ts`). Chromium's own canceller can use audio that the same renderer plays as its reference, so that path may already cancel most of FRIDAY's own voice; this was **not measured** here. System voices (`speechSynthesis`) and Windows SAPI play outside that path, so a reference signal for them is unknown. On top of the flags, the stack has a speaking guard, a louder-than-echo barge-in test and a self-echo transcript filter. A measured test (play a known sentence, record, count leaked words) needs the owner's PC.

## Task words and the voice state

`classifyVoiceControl` separates what a sentence controls. "Ruk jao", "stop", "chup" end speech only. A sentence that also names a task ("background task cancel karo", "task pause karo", "task resume karo") acts on the newest unfinished voice task and nothing else. The existing stop branch in `assistant-mode.ts` is unchanged and does not touch tasks.

## Hardware guide (for the owner's PC)

1. Open Settings → Voice. The card shows the profile chosen from the live reading of this PC (CPU threads, free RAM, video memory) and the models it would use. Nothing is applied or downloaded from there.
2. For a 4 GB NVIDIA GPU the rule is: speech recognition stays on the CPU (small, int8, beam 1, at most 4 threads); the GPU is kept for the language model; one background worker. If the card says Lite, free memory or CPU threads are low.
3. Larger models are never fetched without your yes. `checkModelFits` explains why a model is too big (RAM, disk, video memory).
4. To measure instead of trust: Settings → Voice → Speech model check (your own recordings), then watch "turn latency" in Voice diagnostics over a day.

## How to run the voice upgrade

1. `npm ci`, then `npm run setup:python` (see [INSTALL.md](../INSTALL.md)); on Windows the CMD build is unchanged.
2. Mixed Hindi and English speech needs the Supertonic files on disk like before; there is no new download.
3. Cloud is off by default. To try a cloud sample: Settings → Voice → turn on cloud AI, tick the provider, set a daily and monthly quota and audio minutes, save the key, set the Azure region and voice if you use Azure, press Speak a sample.
4. To try the realtime session: turn on Auto mode, allow and approve paid use (and the billing firewall), save an OpenAI key, name a realtime model, tick the consent box, Start session. Stop with Stop session or Stop everything.

## Test report (Linux build machine, 2026-11-07)

Unit and local-socket tests only; no microphone, speaker, GPU, Windows or live provider was used. Counts are in the pull request. Hardware acceptance (speak while she speaks, echo not taken for a command, Hindi quality, a 30-minute session, device unplug, offline mode, quota fallback on a real account) is **not run**.
