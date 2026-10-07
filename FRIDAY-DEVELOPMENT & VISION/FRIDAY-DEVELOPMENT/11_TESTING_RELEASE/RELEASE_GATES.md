# Release Gates

A development change is release-ready only when:
- canonical owner is clear;
- no duplicate implementation was introduced;
- tests pass;
- security boundary is preserved;
- durable state/migration is handled;
- verification evidence exists;
- docs/contracts match behavior;
- build/release checks pass when packaging is affected.

Release artifacts should be reproducible and integrity-verifiable.
