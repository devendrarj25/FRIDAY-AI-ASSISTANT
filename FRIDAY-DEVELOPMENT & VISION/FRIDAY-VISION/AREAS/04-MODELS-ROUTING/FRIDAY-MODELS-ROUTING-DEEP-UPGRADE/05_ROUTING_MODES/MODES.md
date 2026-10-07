# FRIDAY execution modes

## 1. AUTO — default intelligent mode

Friday decides:

- local vs cloud;
- provider;
- model;
- one vs multiple models;
- direct vs staged execution;
- fallback chain;
- whether a cheap scout is worthwhile;
- whether a stronger verifier is worthwhile.

The decision is constrained by privacy, task capability, user policy, cost and availability.

## 2. LOCAL ONLY

Hard guarantee: no prompt/content leaves the device.

Allowed:
- local model runtimes;
- local tools;
- local retrieval;
- local ensemble.

Disallowed:
- cloud model fallback;
- cloud provider health probe containing user prompt;
- cloud model benchmark containing user content.

## 3. CLOUD ONLY

Use cloud endpoints only. Local models may still be used for UI-only or non-content diagnostics if explicitly isolated, but never as a silent inference fallback.

## 4. MULTI

User can choose one or more models. Friday can execute:

- parallel independent answers;
- primary + critic;
- primary + verifier;
- specialist panel;
- planner → specialist → synthesizer;
- candidate generation → judge;
- cross-provider consensus.

## 5. MANUAL

The user pins one or more exact model endpoints. The router may still apply safety/capability constraints and can refuse an impossible plan, but it must not silently substitute a different model unless the user enabled fallback.

## 6. Mode modifiers

Optional modifiers:

- `fastest`
- `best-quality`
- `cheapest`
- `private`
- `balanced`
- `deep-reasoning`
- `research-grade`
- `reliable`
- `local-preferred`
- `cloud-preferred`
- `diverse`
