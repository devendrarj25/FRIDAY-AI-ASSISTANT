# Research Decisions — What FRIDAY Should Actually Adopt

| Pattern | Adopt | Why | Constraint |
|---|---:|---|---|
| AIOS resource/kernel separation | Yes | reduces duplicated agent logic | integrate with current task graph |
| hierarchical memory | Yes | supports continuity | provenance required |
| automatic curriculum | Yes | systematic skill growth | sandbox only |
| reflective self-critique | Yes | cheap improvement signal | never proof alone |
| prompt optimization | Yes | low-risk/high ROI | held-out eval |
| workflow evolution | Yes | improves orchestration | candidate graph only |
| population/archive | Yes | avoids local optimum | resource budget |
| recursive self-edit | Lab only | powerful but risky | no direct production mutation |
| local adapter training | Yes | specialization | strict dataset + holdout |
| full base-model training | External project | too expensive/complex for runtime | explicit user project |
| self-modifying evaluator | No in production | evaluator gaming | independent evaluator |
