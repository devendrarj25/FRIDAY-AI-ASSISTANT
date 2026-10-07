# Voice Realtime, Full Duplex and Barge-In

## Generation model
Each spoken response has a `generation_id`. Playback is a consumer of that generation. When a new user turn is accepted, the current generation becomes interruptible/superseded.

## Barge-in sequence
1. VAD detects possible takeover while TTS is playing.
2. Classifier separates speech from echo/noise/backchannel.
3. Stop or duck playback immediately; do not wait for the full TTS chunk.
4. Cancel/suspend only the stale response generation; preserve shared task execution unless the new turn explicitly changes/cancels it.
5. Preserve exactly what was actually spoken as playback metadata; do not invent completion from buffered audio.
6. Finalize the new transcript and submit it to the same brain/task runtime.
7. Planner decides whether the new turn continues, redirects, pauses or cancels the existing goal.
8. Any late TTS chunks from the old generation are rejected.

## Important distinction
A barge-in interrupts **speech generation/presentation**, not automatically the underlying durable task. “Stop talking” and “stop working” are different commands.

## Streaming TTS
TTS begins once safe response clauses are available. Sentence/semantic segmentation must avoid speaking unsafe or unverified claims as final facts. If verification is still pending, speech should use progress language rather than false completion.

## Recovery
Audio device loss transitions the voice session to degraded mode while the task remains available through Chat/Mobile.
