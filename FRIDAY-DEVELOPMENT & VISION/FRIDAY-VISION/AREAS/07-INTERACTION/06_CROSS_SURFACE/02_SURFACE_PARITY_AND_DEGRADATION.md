# Surface Parity and Graceful Degradation

## Parity
Capability parity means the underlying capability is the same; presentation differs by modality. Voice cannot show a giant table in speech, Mobile may summarize, Chat can render rich artifacts.

## Degradation
- Voice unavailable → Chat/Mobile remain available.
- Mobile disconnected → desktop/voice continue.
- Chat renderer reload → task continues and state rehydrates.
- TTS unavailable → text/visual result remains authoritative.
- Network companion unavailable → local FRIDAY remains authoritative.

## Truth preservation
Degradation never changes a task from verified to completed merely because a surface displayed a success animation. Runtime truth remains authoritative.

## Final parity rule
Surface parity is semantic. Chat, Voice and Mobile should expose the same underlying capability/task truth, while each surface chooses an appropriate presentation. Unsupported browser/device features must degrade explicitly and must never be represented as connected, installed or active without a verified runtime state.
