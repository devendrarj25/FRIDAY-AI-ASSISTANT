# Manual / Auto — Remote Mobile Operation Integration

## Shared policy engine
Manual/Auto is a policy input evaluated by the same governance and task runtime for desktop and mobile. A remote phone is an interaction origin, not a higher-trust execution mode.

## Manual from mobile
The user can start work, inspect progress, answer questions, approve gated actions, steer a plan, pause/resume permitted work and review evidence. The phone may be disconnected while assigned background work continues according to existing policy.

## Auto from mobile
The user can enable/disable the same authorized autonomy controls exposed by FRIDAY. Auto does not mean unlimited authority. Owner-only, destructive, sensitive, credential, financial, security or other gated actions remain governed by the existing policy.

## Mode changes
Mode changes are durable policy events with actor, timestamp, previous policy version, new policy version and affected task scope. A task must re-evaluate policy at the next authorization boundary; it must not silently inherit stronger authority merely because a mode changed.

## Remote safety
Disconnect, browser closure or phone sleep must not be interpreted as approval. Long-running tasks continue or pause according to task policy; sensitive pending approvals remain pending until an authorized decision is received.
