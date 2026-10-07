# Research Synthesis → FRIDAY Design Decisions

## 1. One capability fabric
OpenAI and Anthropic expose many execution surfaces; MCP exposes capability negotiation;
UFO3 exposes capability-aware device routing. FRIDAY therefore needs one internal
capability contract instead of provider-specific tool logic.

## 2. Progressive discovery
Large registries should not be dumped into model context. FRIDAY should search compact
capability cards and hydrate schemas only for candidates that survive hard filters.

## 3. Execution is an application responsibility
Tool calls are structured requests whose execution belongs to the controlled runtime.
Therefore FRIDAY owns policy, credentials, sandboxing, retries, state and evidence.

## 4. Durable work is mandatory
Long tasks require checkpoints, resumability, idempotency, pending-write recovery,
human interrupts and live streaming.

## 5. Computer use is a tier
Use API/CLI first; DOM/accessibility/UIA second; CDP/Playwright next; vision last;
human takeover for ambiguous or sensitive cases.

## 6. Device galaxy
UFO3 demonstrates the value of device-level capability matching. FRIDAY should treat
Windows, browser, Linux, mobile and remote workers as capability hosts, not separate brains.

## 7. Evidence is a first-class object
Health, readiness and correctness must remain distinct. A component being "up" does
not prove that a task succeeded.

## 8. Interop is not trust
MCP/A2A/plugins/connectors expand the ecosystem but enter through FRIDAY's same policy,
identity, data boundary, audit and quarantine controls.

## 9. Memory is part of capability quality
Successful verified trajectories should influence capability selection, but only with
scope, freshness, provenance and environment checks.

## 10. Future proofing
New model, tool, device, protocol or feature must require a manifest + adapter +
conformance test, not a core rewrite.
