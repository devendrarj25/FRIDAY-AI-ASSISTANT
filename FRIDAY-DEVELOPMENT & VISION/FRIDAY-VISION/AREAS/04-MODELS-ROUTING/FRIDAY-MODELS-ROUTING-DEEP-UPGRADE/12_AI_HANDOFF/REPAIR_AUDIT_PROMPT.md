# Repair / audit prompt

Audit the implemented Models/Providers/Routing upgrade against this package.

For every failure provide:

1. exact file;
2. exact contract violated;
3. reproduction;
4. root cause;
5. minimal repair;
6. regression test;
7. whether the fix changes routing behavior.

Specially search for:

- duplicate provider registries;
- URL guessing;
- capability guessing from names;
- cloud fallback from Local Only;
- manual model substitution;
- credentials in logs;
- stale model aliases;
- model/deployment identity conflation;
- retries on deterministic errors;
- non-atomic catalogue refresh;
- local download corruption;
- multi-model correlation mistaken for diversity.
