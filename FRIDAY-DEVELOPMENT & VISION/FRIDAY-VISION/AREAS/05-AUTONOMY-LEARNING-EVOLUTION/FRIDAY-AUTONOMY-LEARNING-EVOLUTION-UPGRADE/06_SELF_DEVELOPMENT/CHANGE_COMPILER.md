# Change Compiler / Release Pipeline

A self-generated change is treated like a software release, not a chat answer.

## Pipeline
1. normalize proposal
2. resolve dependencies
3. create isolated worktree/artifact directory
4. apply candidate
5. run deterministic checks
6. run behavioral evals
7. run safety tests
8. compare baseline
9. compute confidence + effect size
10. decide reject / shadow / canary / promote
11. keep rollback snapshot
12. monitor post-promotion

## Golden rule
A candidate cannot modify the mechanism that evaluates it in the same promotion step.
