# Development Test Strategy

Levels:
1. static/schema validation;
2. unit tests;
3. component tests;
4. contract tests;
5. integration tests;
6. end-to-end task tests;
7. recovery/failure injection;
8. clean-machine/build tests.

High-risk runtime changes require failure-path testing.

Minimum durable-task cases:
- restart during run;
- duplicate delivery;
- timeout;
- cancellation;
- approval pause;
- provider failure;
- tool failure;
- verification failure;
- recovery.
