# Real-World Failure Matrix

Test at minimum: model timeout, provider outage, malformed model output, tool timeout, tool duplicate, ambiguous external effect, network drop, kernel restart, Electron restart, renderer restart, device disconnect, Companion reconnect, stale browser page, changed accessibility tree, user takes mouse/keyboard, user interrupts voice, TTS failure, STT partial/final mismatch, memory conflict, stale knowledge, approval expiry, policy deny, prompt injection, sandbox escape attempt, low RAM, high GPU load, disk full, long context, artifact corruption, self-change regression and rollback.

For each failure, the expected outcome is an explicit state transition plus user-visible truthful status—not silent failure and not fabricated completion.
