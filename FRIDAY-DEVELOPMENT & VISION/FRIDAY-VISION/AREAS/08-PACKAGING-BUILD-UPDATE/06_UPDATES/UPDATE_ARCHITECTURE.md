# Update Architecture

The official updater updates only official application/release payload.

```text
check
  -> download manifest
  -> verify publisher/signature/hash
  -> compatibility check
  -> snapshot current state
  -> stage new official payload
  -> run migrations (if any)
  -> boot/readiness test
  -> switch active version
  -> commit transaction
```

On failure:

`abort -> rollback application/runtime changes -> restore migration checkpoint -> mark failed -> retain diagnostic evidence`

User components, user runtimes, models, projects, memory, knowledge and downloads are not part of the replaceable official payload.
