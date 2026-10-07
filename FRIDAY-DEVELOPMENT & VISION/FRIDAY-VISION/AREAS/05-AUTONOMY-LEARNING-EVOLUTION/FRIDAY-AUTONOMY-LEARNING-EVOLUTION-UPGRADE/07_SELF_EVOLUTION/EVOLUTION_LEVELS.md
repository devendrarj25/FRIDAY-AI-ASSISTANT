# Evolution Levels

| Level | What changes | Automatic? | Evidence |
|---|---|---:|---|
| E0 | memory organization | yes, bounded | consistency |
| E1 | prompt/response strategy | yes in lab | eval delta |
| E2 | workflow topology | yes in lab | replay benchmark |
| E3 | skills/tools/agents | candidate generation | tests + permissions |
| E4 | routing policy | candidate only | live-like shadow eval |
| E5 | local LoRA/QLoRA | approval | holdout + regression |
| E6 | production code | approval | full CI + canary |
| E7 | meta-improvement mechanism | separate lab | independent evaluator |
| E8 | base-model training | external explicit project | full training pipeline |

E6/E7 are not hot-path actions.
