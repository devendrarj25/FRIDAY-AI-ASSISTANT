# FRIDAY Evaluation System

## Why evals are part of self-improvement
An autonomous agent without durable evaluation becomes a reactive loop: it can change itself but cannot reliably tell whether it improved. Evals are the objective function of growth.

## Evaluation layers
1. unit tests
2. deterministic fixtures
3. replay tests
4. model-graded tests
5. executable verifiers
6. capability benchmarks
7. shadow evaluation
8. canary monitoring
9. user feedback

## Metrics
- task success
- verifier pass
- factual accuracy
- user correction rate
- recovery rate
- tool error rate
- latency p50/p95
- cost per successful task
- memory precision/recall
- routing regret
- autonomy intervention rate
- rollback rate
- capability score
- novelty/diversity

## Statistical discipline
Use minimum sample sizes and confidence intervals. A one-off improvement is a candidate signal, not a promotion decision.
