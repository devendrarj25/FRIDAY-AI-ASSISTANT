# Contract Rules

1. IDs are stable across modalities and process boundaries.
2. Schemas are versioned; incompatible changes require a migration/compatibility plan.
3. Events are facts, not commands.
4. Commands require authority; events never grant authority.
5. Payload sensitivity is explicit.
6. Artifacts carry provenance and validation state.
7. Checkpoints capture enough information to resume safely.
8. Route decisions record alternatives and rejection reasons without exposing private chain-of-thought.
9. Self-change proposals always include tests and rollback.
10. Policy version/hash is attached to privileged decisions.
