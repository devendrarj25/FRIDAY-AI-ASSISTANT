# FRIDAY Models + Providers + Routing — Deep Upgrade

This package replaces the previous thin planning package.

It was rebuilt after inspecting the supplied `FRIDAY-main.zip` and the existing System/Brain/Interaction upgrade packages, then researching current official provider APIs, model catalogues, local runtimes, routing systems, AIOS architecture and routing research.

## The core goal

FRIDAY should become a **model federation OS** rather than a collection of provider-specific API wrappers.

It must own:

- provider discovery;
- model discovery;
- model intelligence;
- local installation;
- cloud connection;
- endpoint/deployment identity;
- Auto / Local Only / Cloud Only / Multi / Manual modes;
- intelligent routing;
- multi-model cognition;
- auto refresh;
- auto fix;
- fallback;
- health;
- lifecycle/deprecation;
- explainability;
- performance learning.

## What this package intentionally does NOT do

It does not redesign FRIDAY's Brain, System, Chat, Voice or Mobile Companion. Those are dependencies/consumers.

## Start here

1. `00_MASTER_CONTROL/00_READ_FIRST.md`
2. `01_CURRENT_SOURCE_TRUTH/WHAT_ALREADY_EXISTS.md`
3. `02_TARGET_ARCHITECTURE/MASTER_ARCHITECTURE.md`
4. `02_TARGET_ARCHITECTURE/AI_OS_PATTERNS.md`
5. `03_PROVIDER_FEDERATION/PROVIDER_FEDERATION.md`
6. `04_MODEL_INTELLIGENCE/MODEL_CARD_SYSTEM.md`
7. `05_ROUTING_MODES/ROUTER_ALGORITHM.md`
8. `10_IMPLEMENTATION/FILE_LEVEL_MIGRATION_MAP.md`
9. `12_AI_HANDOFF/AGENT_MASTER_PROMPT.md`
10. `08_DIAGRAMS/*.svg`

## Important distinction

Do not implement “one universal chat API.” Different providers expose different model classes, metadata, lifecycle, endpoints and native capabilities. Normalize the contracts, not the provider reality.
