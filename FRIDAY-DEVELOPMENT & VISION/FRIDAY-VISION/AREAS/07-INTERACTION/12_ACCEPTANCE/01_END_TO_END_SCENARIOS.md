# End-to-End Acceptance Scenarios

1. **Chat → durable task:** typed multi-step task starts, streams progress, checkpoints, survives renderer reload and returns artifact.
2. **Chat → Voice continuation:** user speaks a follow-up; it attaches to the same conversation/task and changes the objective correctly.
3. **Voice barge-in:** TTS is interrupted immediately; stale generation cannot speak again; task state remains intact.
4. **Voice → Mobile approval:** task reaches approval; Mobile receives canonical event; approval resumes exact pending action; no duplicate action occurs.
5. **Mobile reconnect:** disconnect during streaming; reconnect receives snapshot/cursor and catches up without replaying mutation.
6. **Manual mode:** approval-required step waits; user must explicitly approve; background assigned work continues separately.
7. **Auto mode:** permitted low-risk sequence advances without UI clicks; high-risk step still pauses for approval.
8. **Unknown side effect:** tool timeout after possible submission; runtime marks unknown, reconciles, then either confirms success or safely retries.
9. **Provider failure:** current model/STT/TTS provider fails; router selects compatible fallback without losing task identity.
10. **Stale chat retry:** old generation completes late; result is discarded rather than overwriting the newer generation.
11. **Truthful completion:** model says success but verification fails; runtime reports failure/unknown, never “done”.
12. **Remote revocation:** Mobile session revoked; further commands fail closed while an already-running task follows policy and remains observable elsewhere.
