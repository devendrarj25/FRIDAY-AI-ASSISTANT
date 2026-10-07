# FRIDAY Evolution Lab

## Purpose
Search for better FRIDAY variants without changing production directly.

## Candidate population
A candidate may differ in:
- system instructions
- prompt modules
- workflow graph
- planner strategy
- tool selection
- memory retrieval policy
- model routing policy
- skill implementation
- agent decomposition
- local adapter
- code patch

## Search methods
Use the cheapest suitable search:
- hill climbing / coordinate search
- Bayesian optimization for prompt/config parameters
- genetic/Pareto evolution for modular prompts/workflows
- Monte Carlo tree search for workflow topology
- population archive for diverse variants

## Archive
Keep parents and winners, not just the current best. Diversity matters because a single local optimum can block later improvements.

## Promotion rule
A candidate must improve the target metric while staying within regression, cost, latency and safety limits.

## Meta-evolution
The mechanism that generates candidates may itself be improved, but only as a separate candidate artifact with its own evaluator. Do not let a candidate rewrite the promotion gate and then self-approve.
