# Chat Pipeline — Deep Routing Contract

### Stage 1 — Turn gateway
Create stable IDs, deduplicate submission, bind surface/mode, establish cancellation scope and publish accepted event.

### Stage 2 — Normalization
Normalize text, attachments, locale, user intent hints and explicit constraints. Do not erase meaningful wording or authority boundaries.

### Stage 3 — Session rehydration
Load current conversation state, active tasks, commitments, approvals, recent verified results and relevant memory. Reconnect to existing task rather than creating a duplicate task when the request is a continuation.

### Stage 4 — Cognitive context
Use existing attention/context/world-model/reasoning systems. Context compiler produces a bounded evidence bundle with provenance.

### Stage 5 — Objective and plan
Translate request into objective, constraints, desired outcome, acceptance conditions and risk class. Plan only as far as necessary; allow incremental planning for uncertain tasks.

### Stage 6 — Capability resolution
Use the existing single-source capability registry. Specialized routers remain candidate producers. A unified resolver scores fit, availability, health, reliability, latency, permissions, cost, streaming support, cancellation support and risk compatibility.

### Stage 7 — Governance
Every mutation passes the existing authority/action-risk/policy chain. Auto changes who may proceed without a click; it does not change what policy allows.

### Stage 8 — Execution and observation
Execute through existing Electron/kernel/sandbox/browser/device owners. Capture evidence and emit structured events.

### Stage 9 — Verification
Check postconditions. For external APIs use returned state where reliable; for filesystem use actual filesystem state; for UI actions use accessibility/state evidence or screenshot only where appropriate; for generated artifacts verify file existence/readability/schema.

### Stage 10 — Completion
Only verified terminal state can be reported as completed. If evidence is insufficient, report unknown/pending and preserve the task for reconciliation.
