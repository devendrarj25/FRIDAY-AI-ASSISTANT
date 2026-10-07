# Voice Diagnostics and Failure Recovery

A voice diagnostic trace follows: device → clock → capture → conditioning → VAD → ASR → turn gateway → brain/task → response stream → TTS → playback.

Each boundary reports structured failure codes and evidence. Recovery should prefer the smallest local repair: reinitialize device, restart provider session, switch compatible provider, degrade to text, or preserve task for later continuation.

Do not mark voice “connected” merely because a WebSocket or UI state exists; prove media path readiness and runtime reachability.
