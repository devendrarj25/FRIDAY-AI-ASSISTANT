# Voice Media, Providers, Performance and Recovery

## Provider-neutral contract
Each STT/TTS/VAD provider reports capability, health, latency, language support, streaming support, interruption support, local/cloud classification and failure reason. Provider selection is evidence-driven; no provider is hardcoded as the brain.

## Local-first policy
Prefer locally installed/verified voice components when they satisfy quality/latency requirements and policy. Fall back to network providers only through the existing model/provider routing and privacy policy.

## Performance budgets
Measure capture-to-partial-ASR, final-ASR, brain-first-token, first-audio, interruption-to-silence and recovery times. Budgets are targets for routing/resource decisions, not UI claims.

## Audio clock
A single session clock governs capture and playback timestamps. Device changes create a new media epoch; stale frames from the previous epoch are discarded.

## Failure classes
- device unavailable → reinitialize or fallback
- audio format mismatch → renegotiate/normalize
- VAD instability → conservative endpointing
- ASR provider timeout → bounded provider fallback
- TTS failure → text/visual response remains authoritative
- network loss → preserve task, degrade voice, resync later
- stale generation → drop at boundary
- permission denial → fail closed, never silently enable capture
