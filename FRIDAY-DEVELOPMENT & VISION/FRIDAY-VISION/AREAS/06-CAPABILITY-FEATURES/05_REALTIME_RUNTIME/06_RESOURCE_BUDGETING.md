# Resource Budgeting

Budget dimensions:
time, tokens, money, CPU, RAM, GPU VRAM, network, API calls, tool calls, parallel workers.

Broker chooses plans under a declared budget. Runtime can degrade gracefully:
quality → latency → cost → local fallback → human handoff.
