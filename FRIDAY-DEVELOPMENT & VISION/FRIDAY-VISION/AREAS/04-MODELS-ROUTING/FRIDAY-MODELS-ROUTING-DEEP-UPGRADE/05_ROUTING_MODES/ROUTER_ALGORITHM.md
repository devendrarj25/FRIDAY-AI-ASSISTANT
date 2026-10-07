# Smart Router — final algorithm

The router is a staged constraint solver, not a single score.

## Stage 0 — Compile task contract

From Brain/Planner create:

- task type
- goal
- input modalities
- output modality
- required capabilities
- context estimate
- tool requirements
- latency target
- quality target
- privacy class
- cost budget
- mode
- user-pinned models
- multi-model policy
- research/freshness requirement

## Stage 1 — hard policy filter

Remove candidates that violate:

- mode
- privacy
- unavailable credentials
- unsupported modality
- missing tool support
- insufficient context
- retired/deprecated state when a valid replacement exists
- hardware constraints
- account/region constraints

## Stage 2 — candidate expansion

Expand one model into endpoint candidates:

`direct provider + region/deployment + gateway route + local runtime`

This is where OpenRouter/HF/Bedrock/Foundry-like endpoint diversity becomes useful.

## Stage 3 — capability evidence gate

Reject inferred-only capabilities for high-risk tasks unless the policy explicitly permits them.

## Stage 4 — deterministic utility score

Suggested normalized score:

```text
utility =
  0.27 * expected_quality
+ 0.16 * task_fit
+ 0.13 * reliability
+ 0.10 * latency_fit
+ 0.08 * throughput_fit
+ 0.07 * capability_confidence
+ 0.06 * freshness
+ 0.05 * tool_fit
+ 0.04 * context_fit
+ 0.04 * privacy_fit
- 0.10 * cost_penalty
- 0.08 * risk_penalty
```

These weights are defaults, not permanent truths. Learn them only through offline evaluation and bounded online adaptation.

## Stage 5 — learned/value estimation (optional)

A lightweight model may estimate:

`P(success | task_features, candidate)`

and/or

`expected_quality(candidate)`.

Never allow the learned score to override hard constraints.

## Stage 6 — value-of-information decision

Before calling five models, ask whether evaluating another candidate is worth the time/cost.

Use a cheap estimator when:

- candidate quality is uncertain;
- the task is high value;
- the extra inference cost is acceptable;
- the expected improvement exceeds the evaluation cost.

Otherwise stop searching and execute the current best plan.

## Stage 7 — plan type

Choose one:

- single
- primary/fallback
- parallel ensemble
- staged pipeline
- verifier
- judge
- debate

## Stage 8 — execute with budgets

Budget:

- wall-clock time
- tokens
- number of model calls
- cost
- concurrency
- retries

## Stage 9 — validate output

Check:

- schema
- tool-call validity
- completeness
- contradiction signals
- confidence
- safety/policy requirements

If failed, escalate or repair.

## Stage 10 — learn

Record only non-sensitive operational features:

- candidate
- task class
- latency
- success/failure category
- quality evaluation when available
- cost estimate
- fallback occurrence

Do not train on private content by default.
