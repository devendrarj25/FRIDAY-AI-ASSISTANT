# Current Gap Register — Targeted Hardening

The current source has many individual capabilities, but the risk is fragmentation: multiple state representations, overlapping registries, partial flow observability and feature-specific contracts. The target work therefore focuses on **unification**.

## Highest priority gaps
1. A canonical execution envelope connecting turn → task → plan → route → capability → action → result → verification.
2. A canonical event envelope so UI, notifications, Companion, audit and observability consume the same execution facts.
3. A strict policy-root evaluation before every privileged action and every self-change activation.
4. Durable checkpoints that permit restart/resume without replaying non-idempotent side effects.
5. A route decision record explaining selected model/capability/agent/tool/workflow without exposing private chain-of-thought.
6. Explicit artifact contracts for generation, analysis, provenance, validation and storage.
7. A single cross-modal continuity contract for Chat/Voice/Mobile.
8. A self-development promotion pipeline with candidate isolation, evaluation, canary and rollback.
9. A failure taxonomy shared by model, tool, browser, device, network, task and artifact subsystems.
10. A capability lifecycle from discover → validate → register → health → route → retire.

These are integration gaps, not permission to replace existing modules.
