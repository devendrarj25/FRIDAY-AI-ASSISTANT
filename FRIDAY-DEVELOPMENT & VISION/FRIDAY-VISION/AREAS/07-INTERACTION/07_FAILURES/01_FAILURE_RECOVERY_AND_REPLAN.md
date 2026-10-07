# Failure, Recovery, Replan and Result Reuse

## Failure taxonomy
`validation`, `auth`, `policy`, `availability`, `timeout`, `provider`, `transport`, `execution`, `verification`, `unknown-side-effect`, `resource`, `stale-generation`, `disconnect`.

## Recovery policy
1. classify failure;
2. determine whether side effect may have occurred;
3. checkpoint;
4. reconcile if uncertain;
5. retry only if operation is safe/idempotent and retry policy allows;
6. substitute capability/provider only if the alternative satisfies policy and objective;
7. replan if the original path is no longer valid;
8. surface only what the owner needs to act.

## Result reuse
Reuse verified results when freshness, scope, identity and policy still match. Mutating operations are never considered reusable merely because a previous attempt had the same natural-language description.

## Recovery across restart
Resume from durable checkpoint. Do not replay side effects blindly. Event cursor reconciliation repairs presentation state.
