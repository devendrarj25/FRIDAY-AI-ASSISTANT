# Event-Sourced Run Journal

Long-running runs are reconstructed from an append-only journal. Persist decisions and effect boundaries before execution where necessary.

For each effect:
- stable effect/idempotency key;
- execution-start event;
- result event or explicit ambiguous outcome;
- verification event;
- retry/recovery policy.

If the process crashes after an external side effect begins but before its result is known, FRIDAY must enter an evidence-required recovery state instead of blindly repeating the effect.
