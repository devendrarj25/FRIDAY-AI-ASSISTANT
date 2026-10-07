# Voice — Final Integrated Architecture

Voice adds a realtime media plane to the exact same turn/task/brain runtime used by Chat. It must never fork cognition or task state.

## Media plane
`microphone → device/clock normalization → AEC/noise suppression/AGC → VAD/endpointing → streaming ASR → transcript confidence/provenance → canonical turn`.

## Shared execution plane
`canonical turn → same context/cognition/planner/router/governance/execution/task system as Chat`.

## Speech output plane
`response/event stream → speech segmentation → streaming TTS → playback → interruption detector → barge-in controller`.

## Required voice components
- device lifecycle and one authoritative audio clock
- AEC/NS/AGC where available
- VAD with endpointing and false-trigger handling
- streaming ASR with partial/final transcript distinction
- transcript confidence and language detection
- streaming TTS with chunked playback
- full duplex listening while speaking
- barge-in cancellation/ducking
- wake-word/activation path integrated with voice session state
- audio health/fallback to text/manual

## Same-brain rule
Voice transcript is an input modality, not a separate conversation. The same `conversation_id`, `task_id`, policy and memory state are used. Voice may add audio provenance and modality metadata.

## Hindi/English/Hinglish
Language detection is evidence, not a hard switch. Preserve user language preference in conversation state. ASR and TTS providers are selected by the same model/provider health system, subject to voice-specific media capabilities.

## Failure behavior
Low-confidence speech can request clarification or fall back to Chat text. TTS failure must not mark the task failed if the underlying task completed. Network audio failure must not destroy durable task state.

## Interaction-system hardening integration
Voice is a realtime surface, not a second execution engine. The media path remains latency-sensitive while deeper reasoning, tools and long tasks run through the shared runtime. Spoken output is a projection of canonical state: it should summarize, announce milestones and explain next actions rather than reading large visual artifacts verbatim. Barge-in invalidates the active speech generation and presentation path while preserving durable task truth unless an explicit task mutation is requested. Mobile Voice uses the same contracts, with browser/OS media permission as an additional input boundary.
