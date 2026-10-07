# Absolute Engineering Rules

### Preservation
Existing features are presumed intentional. Do not delete, disable, downgrade, rename or silently replace them.

### Source-of-truth discipline
Before adding a registry, service, event, store, route or UI surface, search the current tree for an owner. Extend the owner if possible. If ownership is ambiguous, document the ambiguity and select one canonical owner before coding.

### Build discipline
`package.json`, `electron-builder.yml`, `.github/workflows`, installer and release scripts are protected areas. Touch only when the requested capability genuinely requires it, and then prove the original path still works.

### Security discipline
All privileged execution passes through the existing authority/governance chain. No new direct `child_process`, PowerShell, browser-debug, filesystem-write or credential path may bypass the broker.

### Self-change discipline
Candidate → isolated workspace → static checks → tests → build → targeted runtime verification → policy/risk review → staged activation → health observation → rollback if unhealthy.

### Data discipline
Separate conversation content, working state, durable memory, secrets, credentials, generated artifacts, audit evidence and telemetry. Never use one store as a catch-all.

### UX discipline
The package can define backend contracts for activity/wiring visualization but must not redesign existing screens. Reuse the current stage/HUD/wiring/activity surfaces where present.
