# Automatic Curriculum

Inspired by lifelong-learning systems such as Voyager: choose the next learning task based on current capability and reachable progress.

## Difficulty bands
- D0: deterministic unit tasks
- D1: simple real tasks
- D2: multi-step tasks
- D3: ambiguous tasks
- D4: long-horizon tasks
- D5: adversarial/edge-case tasks

## Curriculum loop
`weak capability → choose reachable task → run in sandbox → verify → store trajectory → increase difficulty or change strategy`

## Anti-gaming rules
- held-out tasks are not used for prompt mutation
- benchmark generators are separated from candidate evaluators
- candidate cannot modify the evaluator it is scored against
- repeated synthetic tasks are down-weighted
- user-facing success and benchmark success are tracked separately
