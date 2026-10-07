# Coding-agent execution order

1. Read all files in this package.
2. Read `FRIDAY-main` source truth and run the current test suite.
3. Produce a machine-readable migration inventory before editing.
4. Implement contracts and adapters without changing the UI.
5. Wrap existing provider code behind adapters.
6. Add contract tests for every adapter.
7. Add snapshot/evidence store.
8. Add Route Planner behind a feature flag.
9. Run old router and new router in shadow mode on synthetic tasks.
10. Compare route decisions, latency and failures.
11. Enable new router for Auto mode only.
12. Keep Manual mode deterministic.
13. Add Multi mode.
14. Add local lifecycle manager.
15. Upgrade Models UI.
16. Enable self-healing.
17. Remove duplicate provider truth only after parity.
18. Update documentation and tests.

Never “rewrite the entire model system” in one change.
