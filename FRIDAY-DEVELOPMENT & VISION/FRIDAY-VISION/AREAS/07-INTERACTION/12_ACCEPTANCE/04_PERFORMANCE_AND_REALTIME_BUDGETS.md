# Performance and Realtime Acceptance

Measure rather than assert:
- Chat input acceptance and first meaningful response;
- Voice first partial transcript;
- Voice interruption-to-playback-stop;
- Voice first audio after response readiness;
- Mobile command round trip;
- event propagation latency;
- task checkpoint latency;
- reconnect reconciliation time;
- foreground latency under background load.

Budgets should be hardware/provider aware. Violations feed routing/resource decisions; they do not justify unsafe behavior.
