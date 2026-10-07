# Current Research Synthesis — 2026-09-15

## Adopt
- **A2A:** stateful task identity, separate artifacts from messages, ordered streaming, task subscriptions, disconnected push/reconnect patterns. This directly supports Mobile + long-running work.
- **LangGraph persistence/HITL:** checkpointed state enables pause/review/resume and fault-tolerant continuation; approvals can be represented as interrupts over persisted state. Adopt the pattern, not the framework.
- **MCP authorization:** remote capability access should use modern OAuth/security patterns, short-lived tokens and HTTPS/PKCE where applicable. Adopt the security principles at the connector boundary.
- **Tailscale-style zero trust:** private overlay plus deny-by-default network/application capabilities is a strong model for Companion. Prefer principles over vendor coupling.
- **OpenTelemetry event semantics:** meaningful point-in-time state transitions should be represented as events while duration-bearing operations remain spans. This matches FRIDAY's event + trace model.

## Adapt
- A2A is an interoperability protocol, not FRIDAY's internal event bus.
- HITL interrupts are adapted to FRIDAY's existing governance/approval and task ledger.
- Private overlay networking is adapted to the existing `remote-access.cjs`/companion architecture.

## Reject
- Separate “voice brain”, “mobile brain” or “chat brain”.
- Publicly exposed privileged desktop control as the default.
- Blanket Auto approval.
- UI-only progress truth.
- Retrying unknown side effects without reconciliation.
- Duplicating capability registries or schedulers.
