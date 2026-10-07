# Update Transaction and Journal

The updater maintains a durable transaction journal under `updater/`.

Minimum phases:
`created, manifest_verified, download_verified, staged, migration_started, migration_committed, activation_started, health_passed, committed`

Failure phases are terminal only after recovery completes.

The journal must make startup recovery deterministic: if FRIDAY is interrupted during update, the next launch can inspect the last phase and either continue safely or roll back.

Never infer transaction state solely from folder names or timestamps.
