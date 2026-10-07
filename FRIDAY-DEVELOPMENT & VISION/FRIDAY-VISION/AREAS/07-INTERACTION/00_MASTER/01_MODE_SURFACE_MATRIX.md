# Mode × Surface Matrix

| Surface | Manual | Auto | Owns Brain? | Owns Task Truth? | Output |
|---|---|---|---|---|---|
| Chat | user-directed typed work; assigned background continues | permitted autonomous work visible in chat | No | No | text, visual state, artifacts |
| Voice | spoken command, clarification, interruption, steering | autonomous work may speak important state | No | No | speech + visual/event state |
| Mobile Companion | remote inspect/control; approvals require user action | remote observation/control of permitted auto work | No | No | compact state, controls, artifacts |

### Manual semantics
Manual means the owner controls progression from the interaction surface. Assigned background work, notifications, learning and self-development remain owned by their existing runtimes. If approval is required, the action waits until the owner explicitly approves; opening the UI is not itself approval.

### Auto semantics
Auto means the owner has explicitly enabled autonomous execution within a policy scope. FRIDAY can advance permitted steps without waiting for UI clicks. Owner-only, destructive, sensitive, irreversible or otherwise policy-gated actions still require the existing approval gate.

### Critical distinction
`Chat/Voice/Mobile` answer **how the owner interacts**. `Manual/Auto` answer **how much autonomous progression is currently permitted**. Neither axis changes the underlying Brain, Task, Memory, Capability or Governance owner.
