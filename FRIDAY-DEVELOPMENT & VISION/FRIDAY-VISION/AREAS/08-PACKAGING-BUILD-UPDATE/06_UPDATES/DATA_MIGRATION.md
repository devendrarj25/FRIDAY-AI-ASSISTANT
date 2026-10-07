# Data Migration Contract

User data can evolve, but application updates must never overwrite it blindly.

Every schema migration has:
- source schema
- target schema
- precondition
- backup/checkpoint strategy
- deterministic migration step
- verification
- rollback/recovery strategy

Migration order:
`validate -> checkpoint -> migrate -> verify -> commit`

If migration fails, application activation must not claim success.
