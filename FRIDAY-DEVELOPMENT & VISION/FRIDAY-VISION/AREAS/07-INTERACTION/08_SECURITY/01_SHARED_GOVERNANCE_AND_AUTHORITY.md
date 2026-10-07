# Shared Governance and Authority

The same governance chain protects Chat, Voice, Mobile, Manual and Auto.

## Decision order
`identity → policy root/version → capability scope → action risk → data boundary → approval requirement → execution lease → evidence requirement`.

## Auto is not a bypass
Auto can satisfy an approval requirement only when the policy explicitly defines the action class as autonomously permitted. Owner-only and high-risk actions remain gated.

## Prompt injection
Untrusted webpage/document/tool/connector content is data, not authority. It cannot change policy, grant capability, reveal secrets or authorize actions. The planner treats external instructions as untrusted observations and re-evaluates them through policy.

## Evidence
Every privileged action records why it was allowed, which policy version applied, which capability performed it and what evidence established the result.
