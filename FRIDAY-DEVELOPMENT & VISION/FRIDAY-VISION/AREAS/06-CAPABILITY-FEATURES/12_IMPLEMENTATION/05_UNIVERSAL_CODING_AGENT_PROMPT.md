# UNIVERSAL CODING-AGENT IMPLEMENTATION PROMPT

You are upgrading an existing FRIDAY repository using this package.

## First
Inspect the repository and produce a real file map. Do not invent files. Compare actual
implementation against this architecture.

## Goal
Implement one canonical Capability + Feature Fabric above existing FRIDAY resources.

## Required outcomes
- canonical capability registry
- capability adapters for every existing resource type
- capability broker with hard filters + configurable scoring
- progressive discovery
- feature registry/resolver
- capability composition engine
- durable execution
- scheduler/triggers
- live event stream
- artifact/provenance system
- health/readiness/evidence separation
- browser + Windows computer-use tiers
- MCP/A2A/plugin/connector gateway
- device/worker registry
- policy/authority boundary
- conformance/evaluation harness
- capability/feature/task UI

## Migration rules
Do not delete existing systems first.
Do not create duplicate brains.
Do not bypass policy for legacy tools.
Do not place secrets in model context.
Do not claim success without evidence.
Do not make provider-specific assumptions in feature definitions.

## Implementation sequence
contracts → adapters → events → broker shadow → feature resolver → durable runtime →
computer-use → interop → artifacts/evidence → UI → tests → canary → cutover.

## Verification
After each phase run type checks, unit tests, adapter conformance, security tests,
golden workflows and restart/recovery tests.

## Final report
Return:
changed files, new files, migration notes, tests, unresolved risks, feature coverage,
capability coverage, rollback method and proof that no legacy path bypasses the policy
boundary.
