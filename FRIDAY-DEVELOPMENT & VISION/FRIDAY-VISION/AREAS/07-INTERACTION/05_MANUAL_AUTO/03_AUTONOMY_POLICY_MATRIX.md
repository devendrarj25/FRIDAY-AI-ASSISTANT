# Autonomy Policy Matrix

| Action class | Manual | Auto |
|---|---|---|
| Read-only local inspection | user-directed | may auto-run if permitted |
| Reversible low-risk change | user-directed/approved by policy | may auto-run if explicitly permitted |
| Assigned background work | continues after assignment | may progress autonomously |
| External mutation | approval according to existing policy | same policy; no blanket bypass |
| Destructive/irreversible | explicit owner gate | explicit owner gate |
| Credential/secret access | existing authority gate | same |
| Policy/root modification | prohibited to normal autonomous path | prohibited |

Mode only changes execution autonomy within these boundaries.
