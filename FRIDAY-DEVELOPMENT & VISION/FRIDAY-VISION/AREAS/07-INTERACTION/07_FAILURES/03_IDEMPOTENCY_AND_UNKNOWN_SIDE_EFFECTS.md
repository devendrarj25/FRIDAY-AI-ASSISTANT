# Idempotency and Unknown Side Effects

Before mutating external state, the execution owner should establish an idempotency key where the target system supports it. If a timeout occurs after submission could have happened, classify the result as `unknown`.

Recovery procedure:
1. stop automatic duplicate submission;
2. query/reconcile external state;
3. match against idempotency key or transaction reference;
4. confirm success/failure or keep unknown;
5. only then choose retry/compensation/replan.

This rule applies equally to Chat, Voice and Mobile.
