# INDEX — FRIDAY-DEVELOPMENT & VISION

Repo-root order is [`../AGENTS.md`](../AGENTS.md), then [`../READMEFIRST.md`](../READMEFIRST.md).
This file only indexes what's inside this folder. `AGENTS.md`, `AUDIT.md`,
and `FRIDAY_STATE.md` are **not** here — they live at repo root (the real
test suite reads them from there) — see `../AGENTS.md`, `../AUDIT.md`,
`../FRIDAY_STATE.md`.

## Files here
| File | Purpose |
|---|---|
| [`ADOPTION_LEDGER.json`](ADOPTION_LEDGER.json) | One row per plan heading. No MISSING row remains. |
| [`ledger-validator.cjs`](ledger-validator.cjs) | Checks that every closed row cites a real test. |

## Subfolders
| Folder | Use for |
|---|---|
| [`FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`](FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md) | Classify a task. Stays until this folder is empty. |
| [`FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md`](FRIDAY-DEVELOPMENT/10_DEVELOPMENT_WORKFLOW/FAST_SAFE_CHANGE_WORKFLOW.md) | Fast-safe change steps. Stays until this folder is empty. |
| [`FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md`](FRIDAY-DEVELOPMENT/14_TEMPLATES/TASK_PACKET_TEMPLATE.md) | Task packet. Stays until this folder is empty. |

## Picking the right one
Start with `FRIDAY-DEVELOPMENT/01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`.
The area plans now live in the product. A heading whose ledger row is DONE,
SUPERSEDED, or REJECT is already closed.

## Keeping this layer duplicate-free
- Product, technical, and UI contracts now live in the product documents. The copies in this folder were removed.
- Adopted current-source snapshots and stale byte lists were removed. The repository is the inventory.
- `AGENTS.md` still names the router, the workflow, and the task packet, so those three files stay.
- This layer keeps no per-file SHA-256. See [`../READMEFIRST.md`](../READMEFIRST.md).
