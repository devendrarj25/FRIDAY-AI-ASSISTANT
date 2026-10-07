# FRIDAY Interaction System — Final Integrated Architecture

**Scope:** the authoritative interaction/experience architecture for **Chat + Voice + Mobile Companion** operating through **Manual + Auto** over the **same FRIDAY Brain and same FRIDAY OS runtime**.

This document is a merged architecture, not a storage container for earlier Chat/Voice packages. The supplied Chat/Manual and Voice packages were treated as source material and their requirements were reconciled into one contract system. Existing FRIDAY System OS and Brain architecture remain the higher-level authority.

## Non-negotiable invariants
1. **One Brain.** Chat, Voice and Mobile never own separate reasoning, memory, planning or task truth.
2. **One Task Truth.** A long-running task has one authoritative state regardless of which surface is viewing or controlling it.
3. **One Governance Root.** Manual and Auto both pass through the same authority/policy/approval chain.
4. **One Event Fabric.** Progress, approvals, artifacts, errors, voice interruption and remote updates are events from one source.
5. **Manual and Auto are operating axes.** They are not alternate brains and are independent from Chat/Voice/Mobile.
6. **Realtime means state and events are authoritative at the runtime, not merely animated in the UI.**
7. **No stale generation may overwrite newer state.** This is mandatory for Chat streaming, Voice barge-in and Mobile reconnect.
8. **No model output is proof.** Success claims require runtime evidence appropriate to the operation.
9. **No duplicate registry, scheduler, memory, router, task manager or execution engine.** Existing owners are extended.
10. **Disconnect is not cancellation.** A surface can disappear while durable work continues, subject to policy.
11. **Remote access is private-overlay-first and deny-by-default.** No public privileged endpoint is required or assumed.
12. **Build/installer/release remain untouched unless a proven runtime dependency forces a change.**

## Relationship to existing FRIDAY architecture
The interaction layer is an integration layer over the existing `brain-engine → core-brain`, cognitive runtime, universal routing, capability fabric, execution fabric, task graph/ledger, memory/knowledge, governance, event fabric, observability and companion foundations. It must not replace them.

## Canonical identity tuple
Every interaction carries: `owner/policy_version + conversation_id + turn_id + generation_id + optional task_id + trace_id`. When planning/execution exists, `plan_id`, `route_id`, `action_id`, `artifact_id` and `capability_version` are added by their owning subsystems.

## Definition of this section being complete
A single user objective can begin in Chat, be spoken in Voice, continue in Auto, be inspected/approved from Mobile, survive renderer/device/network interruption, resume from a verified checkpoint, and return a truthful artifact/result to any surface without duplicating or losing state.
