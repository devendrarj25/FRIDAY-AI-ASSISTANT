# Continual Learning and Local Training

## Preferred order
1. retrieval/context improvement
2. prompt/program optimization
3. workflow optimization
4. memory/procedure learning
5. tool/skill improvement
6. LoRA/QLoRA adapter
7. distillation or preference optimization
8. full base-model training only as an explicit external project

## Adapter training gate
Before training:
- minimum verified examples
- duplicate filtering
- sensitive-data scan
- train/validation/holdout split
- baseline evaluation
- expected improvement hypothesis

After training:
- evaluate candidate vs base on holdout
- evaluate regressions on protected benchmark suite
- check catastrophic behavior / refusal / tool-use regressions
- canary before activation
- preserve previous adapter

## Training data lineage
Every example must point to:
`source experience → task → model → tool trace → verifier → timestamp → sensitivity class`

Never silently mix unverified generated data into training.

## Useful training methods
- SFT for behavior imitation
- DPO/preference optimization when reliable preference pairs exist
- GRPO/RL-style methods when a trustworthy executable reward exists
- LoRA/QLoRA for cheap local specialization

FRIDAY's runtime should orchestrate these; it should not invent a new trainer when existing libraries can be isolated behind an adapter.
