# Mobile Remote Command Semantics

Every remote command has a command ID and idempotency key, targets a known task/session, declares the requested operation and is checked against current authority.

`approve` resolves only the exact pending approval. `cancel` follows cancellation policy. `pause` requests a safe checkpoint. `resume` continues from verified state. `redirect` creates a new user instruction against the current goal and may trigger replanning. `request_artifact` is read-only and returns the latest authoritative artifact state.
