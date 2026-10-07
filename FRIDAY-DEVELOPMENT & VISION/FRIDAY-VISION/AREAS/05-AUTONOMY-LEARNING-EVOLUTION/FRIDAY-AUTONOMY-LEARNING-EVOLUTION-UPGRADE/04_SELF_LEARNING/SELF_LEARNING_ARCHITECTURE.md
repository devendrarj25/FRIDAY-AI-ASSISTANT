# Self-Learning Architecture

## Learning is not one thing
FRIDAY should learn at four levels:

1. **Episode** — what happened.
2. **Semantic knowledge** — what is believed to be true.
3. **Procedure** — how to perform a task.
4. **Policy prior** — which strategy/model/tool tends to work under conditions.

Each level requires stronger evidence.

## Learning pipeline
`Outcome → Evidence normalization → Verification → Reflection → Candidate lesson → Conflict check → Confidence update → Promotion`

## Evidence hierarchy
Highest:
1. explicit user correction
2. deterministic test/evaluator pass
3. external authoritative evidence with provenance
4. repeated independently verified success
5. model self-reflection

Reflection alone is not truth.

## Failure learning
Failures are retained because they are valuable, but failure records are not promoted into positive instructions automatically.

Store:
- failed strategy
- failure signature
- observed cause
- recovery tried
- recovery result
- what must not be repeated

## Policy learning
For each task class, maintain empirical strategy statistics:
`strategy × model × tool × context → success/latency/cost/risk`

Use Bayesian or smoothed estimates so small samples do not dominate.
