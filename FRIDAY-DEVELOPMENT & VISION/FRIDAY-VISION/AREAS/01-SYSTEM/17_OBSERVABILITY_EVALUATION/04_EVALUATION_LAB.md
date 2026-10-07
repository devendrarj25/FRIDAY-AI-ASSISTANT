# Evaluation Lab

FRIDAY needs continuous evaluation at four levels:
- component: model/tool/capability quality;
- task: end-to-end outcome success;
- system: reliability/latency/resource/security;
- evolution: whether a self-change improves the fixed baseline.

Metrics should include success rate, verification rate, recovery rate, false-success rate, approval accuracy, route quality, latency, cost, resource use, user correction rate and regression count.

Keep evaluation datasets/versioning separate from production memory. A self-improvement candidate must never rewrite the test that is supposed to judge it without governance.
