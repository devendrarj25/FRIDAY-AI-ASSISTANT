# Intelligence Federation Contract

Model selection is policy-driven, not name-driven.

Inputs:
- task type;
- required capabilities;
- quality target;
- latency budget;
- cost budget;
- privacy/data residency;
- provider health;
- context window;
- tool/reasoning support;
- availability;
- user policy.

Selection must never silently relax:
- privacy requirements;
- authority;
- data egress restrictions;
- tool requirements;
- billing limits.

Fallback chain:
`candidate discovery → policy filter → capability match → health filter → scoring → selected provider → verification`

A fallback is a new policy decision, not an automatic retry with weaker guarantees.
