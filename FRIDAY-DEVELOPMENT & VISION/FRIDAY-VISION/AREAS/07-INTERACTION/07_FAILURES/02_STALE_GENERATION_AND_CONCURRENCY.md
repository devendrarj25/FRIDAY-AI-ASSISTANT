# Stale Generation, Concurrency and Cancellation

## Concurrency classes
- independent read-only subtasks may run in parallel;
- dependent steps wait for prerequisites;
- mutating steps require explicit conflict/ordering policy;
- one task may have multiple observers but one authoritative writer per state domain.

## Stale generation guard
Every streamed token, audio chunk, artifact update and surface result carries generation/version. Boundary code compares it with current authoritative generation before applying. Old data is dropped, not merged opportunistically.

## Cancellation
Cancellation is propagated through stream → planner → execution owner. If an external action cannot be interrupted safely, mark it non-cancelable and stop at the next safe checkpoint.

## Race examples
A voice barge-in must not allow old TTS to speak after the new turn. A mobile reconnect must not replay an old approval. A chat retry must not duplicate a mutation whose submission status is unknown.
